import { and, type Database, eq, inArray, schema, sql } from "@agenteschat/db";
import { recordAudit } from "./audit";
import {
  assessCompletion,
  type CompletionAssessment,
  contractHash,
  contractOf,
  EVIDENCE_KINDS,
  type EvidenceKind,
  type StoredContract,
  TESTS_DIGEST,
} from "./completion-contract";
import { type Outcome, recordOutcome } from "./context/outcomes";
import { ConflictError, ForbiddenError, ValidationError } from "./errors";
import { deliveryOf, prSubjectOf, type RunningSource, taskContract, taskEvidenceRows } from "./founder-status";
import { getIssue, type IssueActor, type IssueView } from "./issues";

/**
 * Independent verification of a task against its completion contract (ADR 0211). The writers here: a person sets a
 * task's contract, CI posts a test receipt through the operator API, and a verifier who is neither the task's
 * implementer nor able to write its implementation records "verified" or "rejected" with reasons, audited.
 */

const { outcomes, agentRuns, agentScopes, issues } = schema;

type Actor = { type: "person" | "agent"; id: string };

const actorOf = (a: IssueActor): Actor =>
  a.type === "person" ? { type: "person", id: a.userId } : { type: "agent", id: a.agentId };
const same = (a: Actor, b: Actor) => a.type === b.type && a.id === b.id;

/**
 * Who implemented a task: its assignee, an agent that created it, every agent that ran on it, and whoever claimed it
 * done. None of them may verify it or set its contract.
 */
export async function implementersOf(
  db: Database,
  orgId: string,
  issue: Pick<IssueView, "id" | "assignee" | "createdBy">,
): Promise<Actor[]> {
  const out: Actor[] = [];
  const add = (a: Actor | null | undefined) => {
    if (a && (a.type === "person" || a.type === "agent") && !out.some((o) => same(o, a))) out.push(a);
  };
  add(issue.assignee);
  if (issue.createdBy.type === "agent") add(issue.createdBy);
  const ran = await db
    .selectDistinct({ agentId: agentRuns.agentId })
    .from(agentRuns)
    .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.issueId, issue.id)));
  for (const r of ran) add({ type: "agent", id: r.agentId });
  const claims = await db
    .select({ details: outcomes.details })
    .from(outcomes)
    .where(
      and(
        eq(outcomes.orgId, orgId),
        eq(outcomes.kind, "issue_closed"),
        sql`${outcomes.details}->>'issueId' = ${issue.id}`,
      ),
    );
  for (const c of claims) add(c.details.by as Actor | undefined);
  return out;
}

/**
 * Scopes that let an agent change code or what runs (ADR 0211): running code on a computer or in CI, any connector
 * tool, and GitHub beyond reading. An agent holding one could fix the evidence it checks, so it can't be a verifier.
 */
export function writesImplementation(scope: string): boolean {
  return (
    scope === "sandbox:run" ||
    scope === "ci:run" ||
    scope === "connector:*" ||
    (scope.startsWith("github:") && scope !== "github:read")
  );
}

/** Refuses a verifier or contract setter who is one of the task's implementers, or an agent that can write code. */
async function requireIndependent(
  db: Database,
  orgId: string,
  issue: Pick<IssueView, "id" | "assignee" | "createdBy">,
  who: Actor,
): Promise<Actor[]> {
  const implementers = await implementersOf(db, orgId, issue);
  if (implementers.some((i) => same(i, who)))
    throw new ForbiddenError("The task's implementer can't verify it or set its contract", "self_verification");
  if (who.type === "agent") {
    const scopes = await db
      .select({ scope: agentScopes.scope })
      .from(agentScopes)
      .where(and(eq(agentScopes.orgId, orgId), eq(agentScopes.agentId, who.id)));
    if (scopes.some((s) => writesImplementation(s.scope)))
      throw new ForbiddenError("An agent that can change code can't be an independent verifier", "verifier_can_write");
  }
  return implementers;
}

export interface ContractInput {
  evidence: string[];
  tests?: { suite: string; digest: string } | null;
}

/** Sets a task's completion contract (ADR 0211). People only, never one of its implementers; audited. */
export async function setCompletionContract(
  db: Database,
  userId: string,
  orgId: string,
  issueId: string,
  input: ContractInput,
): Promise<StoredContract> {
  const issue = await getIssue(db, { type: "person", userId }, orgId, { id: issueId });
  const evidence = [...new Set(input.evidence)];
  if (evidence.length === 0 || evidence.some((k) => !(EVIDENCE_KINDS as readonly string[]).includes(k)))
    throw new ValidationError(`evidence must name at least one of ${EVIDENCE_KINDS.join(", ")}`);
  const tests = input.tests ?? null;
  if (tests && (!tests.suite.trim() || tests.suite.length > 200 || !TESTS_DIGEST.test(tests.digest)))
    throw new ValidationError("tests needs a suite name and a sha256:<64 hex> digest of the test files");
  if (evidence.includes("tests_passed") && !tests)
    throw new ValidationError("A contract that requires tests_passed pins the suite and its test files' digest");
  const who: Actor = { type: "person", id: userId };
  await requireIndependent(db, orgId, issue, who);
  const contract: StoredContract = {
    evidence: (evidence as EvidenceKind[]).sort(),
    tests: tests ? { suite: tests.suite.trim(), digest: tests.digest } : null,
    setBy: who,
    setAt: new Date().toISOString(),
  };
  await db.transaction(async (tx) => {
    await tx
      .update(issues)
      .set({ completionContract: contract })
      .where(and(eq(issues.orgId, orgId), eq(issues.id, issue.id)));
    await recordAudit(tx, {
      orgId,
      actor: who,
      action: "task.contract_set",
      target: { type: "issue", id: issue.id },
      details: { evidence: contract.evidence, tests: contract.tests },
    });
  });
  return contract;
}

export interface VerifyInput {
  verdict: "verified" | "rejected";
  /** Required for a rejection: what is wrong, in the verifier's words. */
  reasons?: string[];
}

export interface VerifyResult {
  outcome: Outcome;
  assessment: CompletionAssessment;
}

/**
 * Records an independent verifier's verdict on a task (ADR 0211). Refused for any of the task's implementers and for
 * an agent that can change code. "Verified" is recorded only when the stored evidence meets the contract now
 * (`evidence_missing` otherwise, nothing written): a verifier can't vouch past missing evidence. A rejection needs
 * reasons. Both are an outcome (`task_verified` / `task_rejected`) and an audit row.
 */
export async function verifyTask(
  db: Database,
  actor: IssueActor,
  orgId: string,
  issueId: string,
  input: VerifyInput,
  running: RunningSource | null,
): Promise<VerifyResult> {
  const issue = await getIssue(db, actor, orgId, { id: issueId });
  const who = actorOf(actor);
  const implementers = await requireIndependent(db, orgId, issue, who);
  const reasons = (input.reasons ?? [])
    .map((r) => r.trim().slice(0, 500))
    .filter(Boolean)
    .slice(0, 10);
  if (input.verdict === "rejected" && reasons.length === 0)
    throw new ValidationError("A rejection says why", "reasons_required");
  const rows = await taskEvidenceRows(db, orgId, issue);
  const contract = contractOf(await taskContract(db, orgId, issue.id));
  const prSubjects = new Set(issue.pullRequests.flatMap((p) => prSubjectOf(p.url) ?? []));
  const delivery = deliveryOf(
    rows.filter(
      (r) =>
        prSubjects.has(r.subject.toLowerCase()) || r.kind === "deploy_succeeded" || r.kind === "deploy_rolled_back",
    ),
    running,
  );
  const assessment = assessCompletion({
    status: issue.status,
    criteria: issue.criteria,
    contract,
    rows,
    delivery: { state: delivery.state, merge: delivery.merge },
  });
  if (input.verdict === "verified" && !assessment.ok)
    throw new ConflictError("The stored evidence does not meet the task's completion contract", "evidence_missing", {
      missing: assessment.missing.join(", "),
    });
  const verified = input.verdict === "verified";
  const details = {
    issueId: issue.id,
    by: who,
    contractHash: contractHash(contract, issue.criteria),
    evidence: assessment.met,
    missing: assessment.missing,
    reasons,
    implementers,
    runningDigest: running?.digest ?? null,
  };
  const outcome = await db.transaction(async (tx) => {
    const row = await recordOutcome(tx, {
      orgId,
      kind: verified ? "task_verified" : "task_rejected",
      agentId: who.type === "agent" ? who.id : null,
      runId: actor.type === "agent" ? (actor.runId ?? null) : null,
      subject: `issue#${issue.number}`,
      summary: verified ? "" : reasons.join("; "),
      details,
      source: "issue",
      channelId: issue.channelId,
    });
    await recordAudit(tx, {
      orgId,
      actor: who,
      action: verified ? "task.verified" : "task.rejected",
      target: { type: "issue", id: issue.id },
      details: { outcomeId: row.id, evidence: assessment.met, missing: assessment.missing, reasons },
      runId: actor.type === "agent" ? (actor.runId ?? null) : null,
      channelId: actor.type === "agent" ? actor.channelId : null,
    });
    return row;
  });
  return { outcome, assessment };
}

export interface TestReceiptInput {
  orgId: string;
  /** `owner/repo`. */
  repo: string;
  /** The commit the suite ran on: a task's merge commit for its receipt to count. */
  commit: string;
  suite: string;
  /** `sha256:<64 hex>` of the suite's test files as run: must equal the digest the task's contract pinned. */
  testsDigest: string;
  passed: boolean;
}

const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * A test receipt from CI through the operator API (ADR 0211): `tests_passed` / `tests_failed`, source `operator`, the
 * only source a contract's `tests_passed` accepts. The same receipt again returns the row already there.
 */
export async function recordTestReceipt(db: Database, input: TestReceiptInput): Promise<Outcome> {
  const repo = input.repo.toLowerCase();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repo)) throw new ValidationError("repo must be owner/name");
  if (!COMMIT.test(input.commit)) throw new ValidationError("commit must be a full commit id");
  const suite = input.suite.trim();
  if (!suite || suite.length > 200) throw new ValidationError("suite must be 1 to 200 characters");
  if (!TESTS_DIGEST.test(input.testsDigest)) throw new ValidationError("testsDigest must be sha256:<64 hex>");
  const kind = input.passed ? "tests_passed" : "tests_failed";
  const subject = `tests:${repo}`;
  const [seen] = await db
    .select()
    .from(outcomes)
    .where(
      and(
        eq(outcomes.orgId, input.orgId),
        inArray(outcomes.kind, [kind]),
        eq(outcomes.subject, subject),
        eq(outcomes.source, "operator"),
        sql`${outcomes.details}->>'commit' = ${input.commit}`,
        sql`${outcomes.details}->>'suite' = ${suite}`,
        sql`${outcomes.details}->>'testsDigest' = ${input.testsDigest}`,
      ),
    )
    .limit(1);
  if (seen) return seen;
  return recordOutcome(db, {
    orgId: input.orgId,
    kind,
    subject,
    summary: `${suite} ${input.passed ? "passed" : "failed"} on ${input.commit.slice(0, 9)}`,
    details: { repo, commit: input.commit, suite, testsDigest: input.testsDigest },
    source: "operator",
  });
}
