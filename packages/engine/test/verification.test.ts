import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import {
  assessCompletion,
  type CompletionInput,
  ConflictError,
  contractHash,
  contractOf,
  costPerSuccess,
  createAgent,
  createIssue,
  deriveFounderStatus,
  type EvidenceOutcome,
  ForbiddenError,
  type FounderEvidence,
  founderStatus,
  recordDeploy,
  recordMergeEvidence,
  recordOutcome,
  recordTestReceipt,
  setCompletionContract,
  setCriterion,
  updateIssue,
  ValidationError,
  verdictOf,
  verifyTask,
  writesImplementation,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

// ADR 0211: a task is verified complete only when an independent verifier confirms it against its completion contract
// and the stored evidence. These are the negative controls that keep "done" from counting as "verified".

const MERGE = "a".repeat(40);
const OTHER = "b".repeat(40);
const DIGEST = `sha256:${"1".repeat(64)}`;
const ELSEWHERE = `sha256:${"2".repeat(64)}`;
const TESTS = `sha256:${"3".repeat(64)}`;
const EDITED_TESTS = `sha256:${"4".repeat(64)}`;
const PR_URL = "https://github.com/acme/app/pull/42";
const SUBJECT = "acme/app#42";
const NOW = new Date("2026-11-25T10:00:00Z");
const at = (minute: number) => new Date(NOW.getTime() - (60 - minute) * 60_000);
const PERSON = { type: "person" as const, id: "reviewer" };

const row = (id: string, kind: string, minute: number, details: Record<string, unknown>, extra = {}) =>
  ({ id, kind, subject: "", details, createdAt: at(minute), ...extra }) as EvidenceOutcome;
const merged = row("m", "pr_merged", 10, { mergeCommit: MERGE }, { subject: SUBJECT });
const deployed = (digest: string) =>
  row(
    "d",
    "deploy_succeeded",
    20,
    { repo: "acme/app", commit: MERGE, sourceDigest: digest },
    { subject: "deploy:acme/app" },
  );
const receipt = (over: Record<string, unknown> = {}, source = "operator", kind = "tests_passed", minute = 25) =>
  row(
    `t-${source}-${minute}`,
    kind,
    minute,
    { suite: "unit", commit: MERGE, testsDigest: TESTS, ...over },
    {
      subject: "tests:acme/app",
      source,
    },
  );

const criteria = [
  { id: "c1", text: "Save keeps the new score", done: true, doneBy: { type: "agent" as const, id: "agent-1" } },
];
const fullContract = {
  evidence: ["criteria", "pr_merged", "deploy_running", "tests_passed"],
  tests: { suite: "unit", digest: TESTS },
  setBy: { type: "person" as const, id: "james" },
  setAt: NOW.toISOString(),
};
const verdict = (minute = 40, by: { type: "person" | "agent"; id: string } = PERSON, contract = fullContract) =>
  row(`v-${minute}`, "task_verified", minute, {
    issueId: "issue-1",
    by,
    contractHash: contractHash(contractOf(contract), criteria),
  });

function evidence(outcomes: EvidenceOutcome[], over: Partial<FounderEvidence> = {}, status = "done"): FounderEvidence {
  return {
    issue: {
      id: "issue-1",
      number: 7,
      title: "Score save",
      description: "",
      status: status as FounderEvidence["issue"]["status"],
      criteria,
      createdBy: { type: "person", id: "james" },
      assignee: { type: "agent", id: "agent-1" },
      pullRequests: [{ number: 42, url: PR_URL }],
      blocked: null,
    },
    outcomes,
    contract: fullContract,
    decisions: [],
    running: { digest: DIGEST, files: 3000 },
    names: { reviewer: "Rita" },
    now: NOW,
    ...over,
  };
}

const ALL = () => [merged, deployed(DIGEST), receipt()];

describe("founder status: verified only with an independent verdict over evidence that still holds", () => {
  test("the whole contract met and an independent verifier confirmed it: verified", () => {
    const s = deriveFounderStatus(evidence([...ALL(), verdict()]));
    expect(s.verification).toMatchObject({ state: "verified", verified: true, missing: [] });
    expect(s.verification.verifier).toMatchObject({ type: "person", id: "reviewer", name: "Rita" });
    expect(s.verification.text).toContain("獨立核實者");
  });

  test("negative control: done without evidence is not verified", () => {
    const s = deriveFounderStatus(evidence([]));
    expect(s.verification.verified).toBe(false);
    expect(s.verification.state).toBe("done_unverified");
    expect(s.verification.missing).toEqual(expect.arrayContaining(["not_merged", "tests_receipt_missing"]));
  });

  test("negative control: the full evidence, but only the agent's (or the UI's) claim of done, is not verified", () => {
    const claim = row("c", "issue_closed", 30, {
      issueId: "issue-1",
      by: { type: "agent", id: "agent-1" },
      claim: true,
    });
    const s = deriveFounderStatus(evidence([...ALL(), claim]));
    expect(s.verification.verified).toBe(false);
    expect(s.verification.state).toBe("done_unverified");
  });

  test("negative control: the implementing agent's own verdict is never one", () => {
    const s = deriveFounderStatus(evidence([...ALL(), verdict(40, { type: "agent", id: "agent-1" })]));
    expect(s.verification.verified).toBe(false);
  });

  test("negative control: a stale deploy (digest mismatch) is not verified, even after a verdict", () => {
    const s = deriveFounderStatus(evidence([merged, deployed(ELSEWHERE), receipt(), verdict()]));
    expect(s.verification.verified).toBe(false);
    expect(s.verification.state).toBe("stale");
    expect(s.verification.missing).toContain("deploy_stale");
  });

  test("negative control: a reopened task loses verified; a fresh claim needs a fresh verdict", () => {
    const reopened = row("ro", "issue_reopened", 50, { issueId: "issue-1" });
    expect(
      deriveFounderStatus(evidence([...ALL(), verdict(), reopened], {}, "in_progress")).verification.verified,
    ).toBe(false);
    const claimedAgain = row("c2", "issue_closed", 55, { issueId: "issue-1", by: { type: "agent", id: "agent-1" } });
    expect(deriveFounderStatus(evidence([...ALL(), verdict(), reopened, claimedAgain])).verification.verified).toBe(
      false,
    );
  });

  test("negative control: a contract loosened after the verdict makes it stale", () => {
    const looser = { ...fullContract, evidence: ["criteria"], tests: null };
    const s = deriveFounderStatus(evidence([...ALL(), verdict()], { contract: looser }));
    expect(s.verification.state).toBe("stale");
    expect(s.verification.verified).toBe(false);
  });

  test("a rejection shows its reasons and sends the work back to the assignee", () => {
    const rejected = row("r", "task_rejected", 45, { issueId: "issue-1", by: PERSON, reasons: ["Save does nothing"] });
    const s = deriveFounderStatus(evidence([...ALL(), verdict(), rejected]));
    expect(s.verification).toMatchObject({ state: "rejected", rejectedReasons: ["Save does nothing"] });
    expect(s.next).toMatchObject({ action: "implement", owner: { type: "agent", id: "agent-1" } });
  });
});

describe("test receipts: only CI's receipt for this commit and these test files counts", () => {
  const base = (rows: EvidenceOutcome[]): CompletionInput => ({
    status: "done",
    criteria,
    contract: contractOf(fullContract),
    rows,
    delivery: { state: "available", merge: { commit: MERGE } },
  });

  test("a receipt from the operator API for the merge commit and the pinned digest is accepted", () => {
    expect(assessCompletion(base([receipt()]))).toMatchObject({ ok: true, met: { tests_passed: "t-operator-25" } });
  });

  test("negative control: a forged receipt (an agent's tool or run wrote it) is not evidence", () => {
    for (const source of ["tool", "run", "issue", "webhook"])
      expect(assessCompletion(base([receipt({}, source)])).missing).toEqual(["tests_receipt_untrusted"]);
  });

  test("negative control: a changed test file (another digest) is not accepted", () => {
    expect(assessCompletion(base([receipt({ testsDigest: EDITED_TESTS })])).missing).toEqual(["tests_changed"]);
  });

  test("negative control: a receipt about another commit, another suite, or a newer failure", () => {
    expect(assessCompletion(base([receipt({ commit: OTHER })])).missing).toEqual(["tests_wrong_commit"]);
    expect(assessCompletion(base([receipt({ suite: "smoke" })])).missing).toEqual(["tests_receipt_missing"]);
    const failed = receipt({}, "operator", "tests_failed", 30);
    expect(assessCompletion(base([receipt(), failed])).missing).toEqual(["tests_failed"]);
  });

  test("negative control: a contract that requires tests but pinned none never passes", () => {
    const input = base([receipt()]);
    expect(assessCompletion({ ...input, contract: { ...input.contract, tests: null } }).missing).toEqual([
      "tests_not_pinned",
    ]);
  });
});

describe("verdicts", () => {
  test("verdictOf reads the newest verdict, reopen or claim", () => {
    const hash = contractHash(contractOf(fullContract), criteria);
    expect(verdictOf([verdict()], hash).state).toBe("verified");
    expect(verdictOf([verdict()], "sha256:other").state).toBe("stale");
    expect(verdictOf([], hash).state).toBe("none");
  });

  test("scopes that write the implementation", () => {
    for (const s of ["sandbox:run", "ci:run", "connector:*", "github:merge", "github:write"])
      expect(writesImplementation(s)).toBe(true);
    for (const s of ["github:read", "issues:read", "context:read", "browser:use", "issues:write"])
      expect(writesImplementation(s)).toBe(false);
  });
});

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

describe("verifyTask: recorded in the database", () => {
  const deps = () => ({ db: f.db, pubsub: f.pubsub });
  const owner = () => ({ type: "person" as const, userId: f.owner.id });
  const running = { digest: DIGEST, files: 10 };

  /** A task the fixture's agent worked on and closed, with a merged, deployed and tested pull request. */
  async function deliveredTask(contract = true) {
    const issue = await createIssue(deps(), owner(), f.org.id, {
      title: "Score save",
      criteria: ["Save keeps the new score"],
      assignee: { type: "agent", id: f.agent.id },
    });
    await updateIssue(deps(), owner(), f.org.id, issue.id, { addPullRequest: { number: 42, url: PR_URL } });
    if (contract)
      await setCompletionContract(f.db, f.owner.id, f.org.id, issue.id, {
        evidence: ["criteria", "pr_merged", "deploy_running", "tests_passed"],
        tests: { suite: "unit", digest: TESTS },
      });
    const agent = { type: "agent" as const, agentId: f.agent.id, channelId: f.general.id };
    const [c] = issue.criteria;
    if (!c) throw new Error("no criterion");
    await setCriterion(deps(), agent, f.org.id, issue.id, c.id, true);
    await updateIssue(deps(), agent, f.org.id, issue.id, { status: "done" });
    return { issue, agent };
  }

  async function evidenceRecorded() {
    await recordMergeEvidence(f.db, f.org.id, { subject: SUBJECT, mergeCommit: MERGE });
    await recordDeploy(f.db, { orgId: f.org.id, repo: "acme/app", commit: MERGE, sourceDigest: DIGEST }, running);
    await recordTestReceipt(f.db, {
      orgId: f.org.id,
      repo: "acme/app",
      commit: MERGE,
      suite: "unit",
      testsDigest: TESTS,
      passed: true,
    });
  }

  const verdicts = () =>
    f.db
      .select()
      .from(schema.outcomes)
      .where(and(eq(schema.outcomes.orgId, f.org.id), eq(schema.outcomes.kind, "task_verified")));

  test("negative control: self-verification refused (the implementing agent, and whoever claimed it done)", async () => {
    f = await setup();
    const { issue, agent } = await deliveredTask();
    await evidenceRecorded();
    const self = verifyTask(f.db, agent, f.org.id, issue.id, { verdict: "verified" }, running);
    await expect(self).rejects.toBeInstanceOf(ForbiddenError);
    await expect(self).rejects.toMatchObject({ code: "self_verification" });
    // A person who marked it done is its claimant: not independent either.
    const claimant = await addMember(f.db, f.org.id, "member", "Cai");
    await updateIssue(deps(), owner(), f.org.id, issue.id, { status: "in_progress" });
    await updateIssue(deps(), { type: "person", userId: claimant.id }, f.org.id, issue.id, { status: "done" });
    await expect(
      verifyTask(f.db, { type: "person", userId: claimant.id }, f.org.id, issue.id, { verdict: "verified" }, running),
    ).rejects.toMatchObject({ code: "self_verification" });
    expect(await verdicts()).toHaveLength(0);
  });

  test("negative control: an agent that can change code can't verify; without those scopes it can", async () => {
    f = await setup();
    const { issue } = await deliveredTask();
    await evidenceRecorded();
    const reviewer = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Reviewer", handle: "reviewer", role: "QA", instructions: "Check.", credentialId: f.agent.credentialId },
      { model: "claude-sonnet-5-5" },
    );
    // A new agent gets its computer (`sandbox:run`) by default: it can change code.
    await f.db
      .insert(schema.agentScopes)
      .values({ orgId: f.org.id, agentId: reviewer.id, scope: "sandbox:run" })
      .onConflictDoNothing();
    const as = { type: "agent" as const, agentId: reviewer.id, channelId: f.general.id };
    await expect(verifyTask(f.db, as, f.org.id, issue.id, { verdict: "verified" }, running)).rejects.toMatchObject({
      code: "verifier_can_write",
    });
    await f.db.delete(schema.agentScopes).where(eq(schema.agentScopes.agentId, reviewer.id));
    const { outcome } = await verifyTask(f.db, as, f.org.id, issue.id, { verdict: "verified" }, running);
    expect(outcome).toMatchObject({ kind: "task_verified", details: { by: { type: "agent", id: reviewer.id } } });
  });

  test("negative control: done without evidence can't be verified, and nothing is written", async () => {
    f = await setup();
    const { issue } = await deliveredTask();
    const reviewer = await addMember(f.db, f.org.id, "member", "Rita");
    const attempt = verifyTask(
      f.db,
      { type: "person", userId: reviewer.id },
      f.org.id,
      issue.id,
      { verdict: "verified" },
      running,
    );
    await expect(attempt).rejects.toBeInstanceOf(ConflictError);
    await expect(attempt).rejects.toMatchObject({ code: "evidence_missing" });
    expect(await verdicts()).toHaveLength(0);
    const s = await founderStatus(f.db, f.owner.id, f.org.id, issue.id, running);
    expect(s.verification.verified).toBe(false);
  });

  test("negative control: a stale deploy can't be verified", async () => {
    f = await setup();
    const { issue } = await deliveredTask();
    await evidenceRecorded();
    const reviewer = await addMember(f.db, f.org.id, "member", "Rita");
    const later = { digest: ELSEWHERE, files: 10 };
    await expect(
      verifyTask(f.db, { type: "person", userId: reviewer.id }, f.org.id, issue.id, { verdict: "verified" }, later),
    ).rejects.toMatchObject({ code: "evidence_missing", params: { missing: "deploy_stale" } });
  });

  test("negative control: a changed test file or a forged receipt is not evidence", async () => {
    f = await setup();
    const { issue } = await deliveredTask();
    await recordMergeEvidence(f.db, f.org.id, { subject: SUBJECT, mergeCommit: MERGE });
    await recordDeploy(f.db, { orgId: f.org.id, repo: "acme/app", commit: MERGE, sourceDigest: DIGEST }, running);
    // An agent's tool reporting tests passed, exactly as CI would word it.
    await recordOutcome(f.db, {
      orgId: f.org.id,
      kind: "tests_passed",
      agentId: f.agent.id,
      subject: "tests:acme/app",
      details: { repo: "acme/app", commit: MERGE, suite: "unit", testsDigest: TESTS },
      source: "tool",
    });
    const reviewer = { type: "person" as const, userId: (await addMember(f.db, f.org.id, "member", "Rita")).id };
    await expect(
      verifyTask(f.db, reviewer, f.org.id, issue.id, { verdict: "verified" }, running),
    ).rejects.toMatchObject({
      params: { missing: "tests_receipt_untrusted" },
    });
    // CI ran the suite, but on edited test files.
    await recordTestReceipt(f.db, {
      orgId: f.org.id,
      repo: "acme/app",
      commit: MERGE,
      suite: "unit",
      testsDigest: EDITED_TESTS,
      passed: true,
    });
    await expect(
      verifyTask(f.db, reviewer, f.org.id, issue.id, { verdict: "verified" }, running),
    ).rejects.toMatchObject({
      params: { missing: "tests_changed" },
    });
    expect(await verdicts()).toHaveLength(0);
  });

  test("an independent verifier confirms it: verified, audited, counted; reopened, it loses verified", async () => {
    f = await setup();
    const { issue, agent } = await deliveredTask();
    await evidenceRecorded();
    const reviewer = await addMember(f.db, f.org.id, "member", "Rita");
    const as = { type: "person" as const, userId: reviewer.id };
    const { outcome } = await verifyTask(f.db, as, f.org.id, issue.id, { verdict: "verified" }, running);
    expect(outcome.details).toMatchObject({
      by: { type: "person", id: reviewer.id },
      implementers: [{ type: "agent", id: f.agent.id }],
    });
    const audit = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "task.verified"));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorType: "person", actorId: reviewer.id, targetId: issue.id });

    const s = await founderStatus(f.db, f.owner.id, f.org.id, issue.id, running);
    expect(s.verification).toMatchObject({ state: "verified", verified: true, verifier: { name: "Rita" } });
    // The server now runs another build: the deploy is stale, so it no longer reads as verified.
    const later = await founderStatus(f.db, f.owner.id, f.org.id, issue.id, { digest: ELSEWHERE, files: 10 });
    expect(later.verification.verified).toBe(false);

    // The run on it counts one verified success.
    const msg = await f.db
      .insert(schema.messages)
      .values({ orgId: f.org.id, channelId: f.general.id, authorType: "person", authorUserId: f.owner.id, body: "go" })
      .returning();
    await f.db.insert(schema.agentRuns).values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: msg[0]!.id,
      triggerMessageId: msg[0]!.id,
      trigger: "mention",
      hop: 1,
      status: "done",
      issueId: issue.id,
    });
    const window = { from: new Date(Date.now() - 3_600_000), to: new Date(Date.now() + 60_000) };
    const report = await costPerSuccess(f.db, f.owner.id, f.org.id, window);
    expect(report.total.verifiedSuccesses).toBe(1);
    expect(report.claims).toMatchObject({ claimedDone: 1, verified: 1, rejectedAfterClaim: 0 });

    await updateIssue(deps(), owner(), f.org.id, issue.id, { status: "in_progress" });
    expect((await founderStatus(f.db, f.owner.id, f.org.id, issue.id, running)).verification.verified).toBe(false);
    expect((await costPerSuccess(f.db, f.owner.id, f.org.id, window)).total.verifiedSuccesses).toBe(0);
    // The agent closing it again is a new claim, still not verified.
    await updateIssue(deps(), agent, f.org.id, issue.id, { status: "done" });
    expect((await founderStatus(f.db, f.owner.id, f.org.id, issue.id, running)).verification.state).toBe(
      "done_unverified",
    );
  });

  test("a rejection needs reasons, is audited and counts as rejected after the claim", async () => {
    f = await setup();
    const { issue } = await deliveredTask(false);
    const reviewer = { type: "person" as const, userId: (await addMember(f.db, f.org.id, "member", "Rita")).id };
    await expect(
      verifyTask(f.db, reviewer, f.org.id, issue.id, { verdict: "rejected", reasons: [" "] }, running),
    ).rejects.toBeInstanceOf(ValidationError);
    await verifyTask(
      f.db,
      reviewer,
      f.org.id,
      issue.id,
      { verdict: "rejected", reasons: ["Save does nothing"] },
      running,
    );
    const s = await founderStatus(f.db, f.owner.id, f.org.id, issue.id, running);
    expect(s.verification).toMatchObject({ state: "rejected", rejectedReasons: ["Save does nothing"] });
    const audit = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "task.rejected"));
    expect(audit).toHaveLength(1);
    const window = { from: new Date(Date.now() - 3_600_000), to: new Date(Date.now() + 60_000) };
    expect((await costPerSuccess(f.db, f.owner.id, f.org.id, window)).claims).toMatchObject({
      claimedDone: 1,
      rejectedAfterClaim: 1,
      verified: 0,
    });
  });

  test("the default contract: every criterion checked, still confirmed by an independent verifier", async () => {
    f = await setup();
    const { issue } = await deliveredTask(false);
    let s = await founderStatus(f.db, f.owner.id, f.org.id, issue.id, null);
    expect(s.verification).toMatchObject({ state: "done_unverified", contract: { isDefault: true } });
    // The task's creator didn't implement it: they may verify.
    await verifyTask(f.db, owner(), f.org.id, issue.id, { verdict: "verified" }, null);
    s = await founderStatus(f.db, f.owner.id, f.org.id, issue.id, null);
    expect(s.verification.verified).toBe(true);
  });

  test("contracts: people only, never the implementer; tests_passed pins a digest", async () => {
    f = await setup();
    const assigneePerson = await addMember(f.db, f.org.id, "member", "Ivy");
    const issue = await createIssue(deps(), owner(), f.org.id, {
      title: "Mine",
      assignee: { type: "person", id: assigneePerson.id },
    });
    await expect(
      setCompletionContract(f.db, assigneePerson.id, f.org.id, issue.id, { evidence: ["criteria"] }),
    ).rejects.toMatchObject({ code: "self_verification" });
    await expect(
      setCompletionContract(f.db, f.owner.id, f.org.id, issue.id, { evidence: ["tests_passed"] }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      setCompletionContract(f.db, f.owner.id, f.org.id, issue.id, { evidence: ["made_up"] }),
    ).rejects.toBeInstanceOf(ValidationError);
    const set = await setCompletionContract(f.db, f.owner.id, f.org.id, issue.id, {
      evidence: ["tests_passed", "criteria"],
      tests: { suite: "unit", digest: TESTS },
    });
    expect(set.evidence).toEqual(["criteria", "tests_passed"]);
    const audit = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "task.contract_set"));
    expect(audit).toHaveLength(1);
  });

  test("test receipts: validated, recorded once, source operator", async () => {
    f = await setup();
    const input = { orgId: f.org.id, repo: "Acme/App", commit: MERGE, suite: "unit", testsDigest: TESTS, passed: true };
    await expect(recordTestReceipt(f.db, { ...input, commit: "abc" })).rejects.toBeInstanceOf(ValidationError);
    await expect(recordTestReceipt(f.db, { ...input, testsDigest: "x" })).rejects.toBeInstanceOf(ValidationError);
    const one = await recordTestReceipt(f.db, input);
    const two = await recordTestReceipt(f.db, input);
    expect(two.id).toBe(one.id);
    expect(one).toMatchObject({ kind: "tests_passed", source: "operator", subject: "tests:acme/app" });
  });
});
