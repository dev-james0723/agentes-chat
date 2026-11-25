import { and, type Database, desc, eq, gt, inArray, isNull, or, schema, sql } from "@agenteschat/db";
import { listApprovals } from "./approvals";
import {
  assessCompletion,
  type CompletionContract,
  contractHash,
  contractOf,
  type MissingReason,
  type StoredContract,
  verdictOf,
} from "./completion-contract";
import { type Outcome, recordOutcome } from "./context/outcomes";
import { ConflictError, ValidationError } from "./errors";
import { getIssue, type IssueView } from "./issues";

const { outcomes, approvals, users, agents } = schema;

/**
 * A founder's status of one task (ADR 0204): what changed, whether it is in the app people use now, what is verified
 * and what only built, what blocks it, who acts next, and whether the reader has a decision to make. Every field is a
 * projection of stored evidence (the task's row, `outcomes`, pending `approvals`, the server's own source identity);
 * nothing comes from a model, and what no evidence says stays unknown. The words are Hong Kong Traditional Chinese.
 */

/** The server's own source identity (`apps/server/src/source-identity.ts`): what this process runs. */
export interface RunningSource {
  digest: string;
  files: number;
}

export interface EvidenceOutcome {
  id: string;
  kind: string;
  subject: string;
  details: Record<string, unknown>;
  createdAt: Date;
  /** Who recorded it (`outcomes.source`): a test receipt counts only from the operator API (ADR 0211). */
  source?: string;
}

/** A pending approval the reader may decide, on one of the task's runs. */
export interface PendingDecision {
  approvalId: string;
  title: string;
  channelId: string;
  /** Where its card is: the thread, or null for the main timeline. */
  threadId: string | null;
  messageId: string | null;
  expiresAt: Date;
}

type Actor = { type: "person" | "agent"; id: string };

export interface FounderEvidence {
  issue: Pick<IssueView, "id" | "number" | "title" | "description" | "status" | "blocked"> & {
    criteria: { id: string; text: string; done: boolean; doneBy?: Actor | null }[];
    createdBy: Actor;
    assignee: Actor | null;
    pullRequests: { number: number; url: string }[];
  };
  outcomes: EvidenceOutcome[];
  /** The task's completion contract (ADR 0211); null or absent: the default. */
  contract?: StoredContract | null;
  decisions: PendingDecision[];
  running: RunningSource | null;
  /** Display names by person or agent id, for the next action's owner. */
  names: Record<string, string>;
  now: Date;
}

export type DeliveryState =
  | "not_merged"
  | "reverted"
  | "merge_commit_unknown"
  | "merged_not_deployed"
  | "rolled_back"
  | "deployed_not_running"
  | "runtime_unknown"
  | "available";

/**
 * `verified`: an independent verifier confirmed it and the evidence still meets the contract (ADR 0211). `stale`: it
 * was verified, but the evidence or the contract changed since. `rejected`: the verifier sent it back.
 */
export type VerificationState = "verified" | "stale" | "rejected" | "done_unverified" | "unverified" | "no_criteria";

export type NextAction =
  | "decide"
  | "unblock"
  | "check_effect"
  | "implement"
  | "merge_pr"
  | "record_merge"
  | "deploy"
  | "check_runtime"
  | "verify"
  | "none";

export interface FounderOwner {
  type: "you" | "person" | "agent";
  id: string;
  name: string | null;
}

export interface FounderStatus {
  issueId: string;
  number: number;
  observedAt: string;
  changed: {
    title: string;
    pullRequests: { number: number; url: string }[];
    /** A person's own description, first paragraph; null when no person wrote one. */
    why: string | null;
    text: string;
  };
  delivery: {
    state: DeliveryState;
    available: boolean;
    merge: { subject: string; commit: string | null; at: string } | null;
    deploy: { commit: string; digest: string; at: string } | null;
    running: RunningSource | null;
    text: string;
  };
  verification: {
    state: VerificationState;
    verified: boolean;
    criteria: { total: number; checkedByPerson: number };
    /** The newest CI and test outcomes of the task's pull requests: supporting checks, never verification. */
    checks: { kind: string; positive: boolean; at: string }[];
    /** The completion contract in force (ADR 0211). */
    contract: Pick<CompletionContract, "evidence" | "tests" | "isDefault">;
    /** The independent verifier of the verdict in force, if any. */
    verifier: FounderOwner | null;
    /** What the stored evidence lacks for the contract now. */
    missing: MissingReason[];
    /** A rejection's reasons, in the verifier's words. */
    rejectedReasons: string[];
    text: string;
  };
  blockers: { reason: string; since: string; text: string }[];
  next: { action: NextAction; owner: FounderOwner | null; text: string };
  needsMe: { needed: boolean; decisions: (Omit<PendingDecision, "expiresAt"> & { expiresAt: string })[]; text: string };
  /** The lines above, in order, for a notification or a plain-text reader. */
  summary: string;
}

const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

/**
 * `{ details: { mergeCommit } }` from GitHub's answer to a merge (`{"sha": …, "merged": true}`), else nothing: an
 * answer that isn't JSON or names no commit records the merge without one, which no deploy can then match.
 */
export function mergeDetailsOf(kind: string, answer: string): { details?: { mergeCommit: string } } {
  if (kind !== "pr_merged") return {};
  try {
    const parsed = JSON.parse(answer) as Record<string, unknown>;
    const mergeCommit = parsed.merged === true ? commitOf(parsed.sha) : null;
    return mergeCommit ? { details: { mergeCommit } } : {};
  } catch {
    return {};
  }
}

/** `owner/repo#N` for a GitHub pull request address (as `pr_merged` outcomes name it), lower case; else null. */
export function prSubjectOf(url: string): string | null {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(url);
  return m ? `${m[1]}/${m[2]}#${m[3]}`.toLowerCase() : null;
}

const commitOf = (v: unknown) => (typeof v === "string" && COMMIT.test(v) ? v : null);
const newest = (rows: EvidenceOutcome[]) =>
  rows.reduce<EvidenceOutcome | null>((a, b) => (!a || b.createdAt > a.createdAt ? b : a), null);
const after = (rows: EvidenceOutcome[], than: Date) => rows.some((r) => r.createdAt > than);

const BLOCK_WORDS: Record<string, string> = {
  failed: "上次執行失敗",
  waiting_approval: "等緊批准",
  waiting_input: "等緊有人答問題",
  paused: "已暫停",
  waiting_computer: "等緊電腦",
  effect_unknown: "有一個操作結果未知，要先核對",
};

const CHECK_KINDS = ["ci_passed", "ci_failed", "tests_passed", "tests_failed"] as const;

function delivery(e: FounderEvidence, rows: EvidenceOutcome[]): FounderStatus["delivery"] {
  const merges = rows.filter((r) => r.kind === "pr_merged");
  const merge = newest(merges);
  const running = e.running && e.running.files > 0 && DIGEST.test(e.running.digest) ? e.running : null;
  const base = { merge: null, deploy: null, running: e.running, available: false };
  if (!merge) return { ...base, state: "not_merged", text: "程式碼：未有合併紀錄，未入現用版本。" };
  const mergeCommit = commitOf(merge.details.mergeCommit);
  const mergeView = { subject: merge.subject, commit: mergeCommit, at: merge.createdAt.toISOString() };
  if (
    after(
      rows.filter((r) => r.kind === "pr_reverted"),
      merge.createdAt,
    )
  )
    return { ...base, merge: mergeView, state: "reverted", text: "程式碼：合併後已經還原，未入現用版本。" };
  if (!mergeCommit)
    return {
      ...base,
      merge: mergeView,
      state: "merge_commit_unknown",
      text: "程式碼：已合併，但冇記低合併 commit，無法同部署紀錄對得上，現用版本有冇，未知。",
    };
  const holds = (r: EvidenceOutcome) =>
    r.details.commit === mergeCommit || (Array.isArray(r.details.commits) && r.details.commits.includes(mergeCommit));
  const deploy = newest(rows.filter((r) => r.kind === "deploy_succeeded" && holds(r)));
  if (!deploy)
    return {
      ...base,
      merge: mergeView,
      state: "merged_not_deployed",
      text: `程式碼：已合併（${mergeCommit.slice(0, 9)}），但未有部署紀錄，現用版本未有。`,
    };
  const deployView = {
    commit: String(deploy.details.commit),
    digest: String(deploy.details.sourceDigest),
    at: deploy.createdAt.toISOString(),
  };
  const withDeploy = { ...base, merge: mergeView, deploy: deployView };
  if (
    after(
      rows.filter((r) => r.kind === "deploy_rolled_back" && holds(r)),
      deploy.createdAt,
    )
  )
    return { ...withDeploy, state: "rolled_back", text: "部署：部署後已經回退，現用版本冇呢個改動。" };
  if (!running)
    return {
      ...withDeploy,
      state: "runtime_unknown",
      text: "部署：有部署紀錄，但伺服器講唔到自己運行緊邊份源碼，現用版本有冇，未知。",
    };
  if (deployView.digest !== running.digest)
    return {
      ...withDeploy,
      state: "deployed_not_running",
      text: `部署：曾經部署，但伺服器而家運行嘅源碼（${running.digest.slice(7, 19)}）唔係嗰次部署，唔當係可用。`,
    };
  return {
    ...withDeploy,
    available: true,
    state: "available",
    text: `部署：已喺現用版本（伺服器源碼 ${running.digest.slice(7, 19)} 同包含合併 commit 嘅部署一致）。`,
  };
}

/**
 * The delivery state of one change from its stored rows alone (its `pr_merged`/`pr_reverted` rows and its repo's
 * deploy rows), the same rule the founder status uses; requirement traceability (ADR 0206) reads it per pull request.
 */
export function deliveryOf(rows: EvidenceOutcome[], running: RunningSource | null): FounderStatus["delivery"] {
  return delivery({ running } as FounderEvidence, rows);
}

const MISSING_WORDS: Record<MissingReason, string> = {
  not_claimed: "未標完成",
  no_criteria: "未定驗收條件",
  criteria_unchecked: "有驗收條件未剔",
  not_person_vouched: "未有人逐項剔過",
  not_merged: "未合併",
  merge_reverted: "合併已還原",
  merge_commit_unknown: "冇合併 commit 紀錄",
  not_deployed: "未部署",
  deploy_stale: "伺服器運行緊嘅唔係嗰次部署",
  deploy_rolled_back: "部署已回退",
  runtime_unknown: "伺服器講唔到運行緊乜",
  tests_not_pinned: "合約未釘測試",
  tests_receipt_missing: "冇測試收據",
  tests_receipt_untrusted: "測試收據唔係可信來源",
  tests_wrong_commit: "測試收據唔係呢個 commit",
  tests_changed: "測試檔案改過",
  tests_failed: "測試失敗",
};

const EVIDENCE_WORDS: Record<string, string> = {
  criteria: "驗收條件全剔",
  person_vouched: "人逐項剔過",
  pr_merged: "已合併",
  deploy_running: "現用版本運行緊",
  tests_passed: "可信測試收據",
};

/**
 * Verified only when an independent verifier confirmed it against its completion contract (ADR 0211) and the stored
 * evidence still meets that contract now; a claim of done, an agent's own ticks or CI alone never are.
 */
function verification(
  e: FounderEvidence,
  rows: EvidenceOutcome[],
  d: FounderStatus["delivery"],
): FounderStatus["verification"] {
  const total = e.issue.criteria.length;
  const checkedByPerson = e.issue.criteria.filter((c) => c.done && c.doneBy?.type === "person").length;
  const checks = CHECK_KINDS.flatMap((kind) => {
    const row = newest(rows.filter((r) => r.kind === kind));
    return row ? [{ kind, positive: kind.endsWith("_passed"), at: row.createdAt.toISOString() }] : [];
  });
  const contract = contractOf(e.contract);
  const assessment = assessCompletion({
    status: e.issue.status,
    criteria: e.issue.criteria,
    contract,
    rows,
    delivery: { state: d.state, merge: d.merge },
  });
  const implementers = [e.issue.assignee, e.issue.createdBy.type === "agent" ? e.issue.createdBy : null].filter(
    (a): a is Actor => !!a,
  );
  const verdict = verdictOf(rows, contractHash(contract, e.issue.criteria), implementers);
  const verifier = verdict.by ? ownerOf(e, verdict.by) : null;
  const base = {
    criteria: { total, checkedByPerson },
    checks,
    contract: { evidence: contract.evidence, tests: contract.tests, isDefault: contract.isDefault },
    verifier,
    missing: assessment.missing,
    rejectedReasons: verdict.state === "rejected" ? verdict.reasons : [],
    verified: false,
  };
  const lacking = assessment.missing.map((m) => MISSING_WORDS[m]).join("、");
  const who = verifier?.name ?? (verifier?.type === "agent" ? "一個 agent" : "一位同事");
  if (verdict.state === "verified" && assessment.ok)
    return {
      ...base,
      verified: true,
      state: "verified",
      text: `驗收：已由獨立核實者（${who}）按完成合約核實（${contract.evidence.map((k) => EVIDENCE_WORDS[k]).join("、")}）。`,
    };
  if (verdict.state === "verified" || verdict.state === "stale")
    return {
      ...base,
      state: "stale",
      text: `驗收：之前核實過，但${verdict.state === "stale" ? "完成合約或驗收條件之後改過" : `而家證據唔再成立（${lacking}）`}，唔算核實。`,
    };
  if (verdict.state === "rejected")
    return {
      ...base,
      state: "rejected",
      text: `驗收：獨立核實者（${who}）退回：${verdict.reasons.join("；") || "冇寫原因"}。`,
    };
  if (total === 0 && contract.evidence.includes("criteria"))
    return { ...base, state: "no_criteria", text: "驗收：未定驗收條件，冇嘢可以核實，只可以當「已實作」。" };
  if (e.issue.status === "done")
    return {
      ...base,
      state: "done_unverified",
      text: `驗收：標咗完成，但未有獨立核實者確認${lacking ? `（仲欠：${lacking}）` : ""}，只算「已實作」。`,
    };
  return {
    ...base,
    state: "unverified",
    text: `驗收：未核實（${checkedByPerson}／${total} 項由人剔過）。`,
  };
}

function blockers(e: FounderEvidence, rows: EvidenceOutcome[]): FounderStatus["blockers"] {
  const out: FounderStatus["blockers"] = [];
  if (e.issue.blocked) {
    const { reason, since } = e.issue.blocked;
    out.push({ reason, since, text: BLOCK_WORDS[reason] ?? `受阻（${reason}）` });
  }
  const unknown = newest(rows.filter((r) => r.kind === "run_effect_unknown"));
  const ended = newest(rows.filter((r) => r.kind === "run_done"));
  if (unknown && !(ended && ended.createdAt > unknown.createdAt))
    out.push({
      reason: "effect_unknown",
      since: unknown.createdAt.toISOString(),
      text: BLOCK_WORDS.effect_unknown ?? "",
    });
  return out;
}

function ownerOf(e: FounderEvidence, actor: Actor | null): FounderOwner | null {
  return actor ? { type: actor.type, id: actor.id, name: e.names[actor.id] ?? null } : null;
}

function nextAction(
  e: FounderEvidence,
  d: FounderStatus["delivery"],
  v: FounderStatus["verification"],
  b: FounderStatus["blockers"],
  decisions: PendingDecision[],
): FounderStatus["next"] {
  const assignee = ownerOf(e, e.issue.assignee);
  const who = (o: FounderOwner | null) =>
    o ? (o.name ?? (o.type === "agent" ? "負責嘅 agent" : "負責嘅同事")) : "未有人負責";
  const first = decisions[0];
  if (first)
    return {
      action: "decide",
      owner: { type: "you", id: "", name: null },
      text: `下一步：你要決定「${first.title}」。`,
    };
  if (b.some((x) => x.reason === "effect_unknown"))
    return { action: "check_effect", owner: assignee, text: `下一步：${who(assignee)}核對未知結果，唔好盲目重做。` };
  if (b.length > 0) return { action: "unblock", owner: assignee, text: `下一步：${who(assignee)}解除阻礙。` };
  if (e.issue.status === "canceled") return { action: "none", owner: null, text: "下一步：已取消，冇嘢要做。" };
  if (d.state === "not_merged" || d.state === "reverted") {
    if (e.issue.pullRequests.length === 0)
      return { action: "implement", owner: assignee, text: `下一步：${who(assignee)}完成實作。` };
    return { action: "merge_pr", owner: assignee, text: `下一步：${who(assignee)}審核同合併 PR。` };
  }
  if (d.state === "merge_commit_unknown")
    return {
      action: "record_merge",
      owner: null,
      text: "下一步：記低合併 commit 先可以核對部署（負責人：未有紀錄）。",
    };
  if (d.state === "merged_not_deployed" || d.state === "rolled_back")
    return { action: "deploy", owner: null, text: "下一步：部署到現用版本（負責人：未有紀錄）。" };
  if (d.state !== "available")
    return { action: "check_runtime", owner: null, text: "下一步：核對現用版本運行緊邊份源碼（負責人：未有紀錄）。" };
  if (v.state === "rejected")
    return { action: "implement", owner: assignee, text: `下一步：${who(assignee)}按核實者退回嘅原因修正。` };
  if (!v.verified) {
    const creator = e.issue.createdBy.type === "person" ? ownerOf(e, e.issue.createdBy) : null;
    return {
      action: "verify",
      owner: creator,
      text: `下一步：${who(creator)}或者另一位唔係實作者嘅核實者，按完成合約核實。`,
    };
  }
  return { action: "none", owner: null, text: "下一步：已交付同核實，冇嘢要做。" };
}

/** The status from its evidence: pure, so every rule is tested without a database. */
export function deriveFounderStatus(e: FounderEvidence): FounderStatus {
  const prSubjects = new Set(e.issue.pullRequests.flatMap((p) => prSubjectOf(p.url) ?? []));
  // Defense in depth: only rows about this task (its id, or one of its PRs) and deploys, whatever the loader passed.
  const rows = e.outcomes.filter(
    (r) =>
      r.details.issueId === e.issue.id ||
      prSubjects.has(r.subject.toLowerCase()) ||
      r.kind === "deploy_succeeded" ||
      r.kind === "deploy_rolled_back" ||
      ((r.kind === "tests_passed" || r.kind === "tests_failed") && r.subject.startsWith("tests:")),
  );
  const description = e.issue.description.trim();
  const why =
    e.issue.createdBy.type === "person" && description ? (description.split(/\n\s*\n/)[0] ?? "").trim() : null;
  const changed = {
    title: e.issue.title,
    pullRequests: e.issue.pullRequests.map((p) => ({ number: p.number, url: p.url })),
    why,
    text: [
      `改動：#${e.issue.number}「${e.issue.title}」${e.issue.pullRequests.length ? `（PR ${e.issue.pullRequests.map((p) => `#${p.number}`).join("、")}）` : "（未有 PR）"}。`,
      why ? `點解重要：${why}` : "點解重要：未有人寫低（agent 寫嘅描述唔作準）。",
    ].join("\n"),
  };
  const d = delivery(e, rows);
  const v = verification(e, rows, d);
  const b = blockers(e, rows);
  const decisions = e.decisions.filter((x) => x.expiresAt > e.now);
  const next = nextAction(e, d, v, b, decisions);
  const needsMe = {
    needed: decisions.length > 0,
    decisions: decisions.map((x) => ({ ...x, expiresAt: x.expiresAt.toISOString() })),
    text: decisions.length > 0 ? `要你決定：${decisions.length} 項等緊你批准。` : "唔使你決定任何嘢。",
  };
  const blockerText = b.length ? `阻礙：${b.map((x) => x.text).join("，")}。` : "阻礙：冇記錄在案嘅阻礙。";
  return {
    issueId: e.issue.id,
    number: e.issue.number,
    observedAt: e.now.toISOString(),
    changed,
    delivery: d,
    verification: v,
    blockers: b,
    next,
    needsMe,
    summary: [changed.text, d.text, v.text, blockerText, next.text, needsMe.text].join("\n"),
  };
}

/**
 * The stored evidence about a task (ADR 0204, 0211): outcomes about it or its pull requests, its repositories' deploy
 * records and test receipts. The caller has already checked the task is visible.
 */
export async function taskEvidenceRows(
  db: Database,
  orgId: string,
  issue: Pick<IssueView, "id" | "pullRequests">,
): Promise<EvidenceOutcome[]> {
  const subjects = issue.pullRequests.flatMap((p) => prSubjectOf(p.url) ?? []);
  const repos = [...new Set(subjects.map((s) => s.split("#")[0]))].flatMap((r) => [`deploy:${r}`, `tests:${r}`]);
  return db
    .select({
      id: outcomes.id,
      kind: outcomes.kind,
      subject: outcomes.subject,
      details: outcomes.details,
      createdAt: outcomes.createdAt,
      source: outcomes.source,
    })
    .from(outcomes)
    .where(
      and(
        eq(outcomes.orgId, orgId),
        or(
          sql`${outcomes.details}->>'issueId' = ${issue.id}`,
          subjects.length ? inArray(sql`lower(${outcomes.subject})`, subjects) : undefined,
          repos.length ? inArray(sql`lower(${outcomes.subject})`, repos) : undefined,
        ),
      ),
    )
    .orderBy(desc(outcomes.createdAt))
    .limit(500);
}

/** A task's stored completion contract (ADR 0211), null when it has none. */
export async function taskContract(db: Database, orgId: string, issueId: string): Promise<StoredContract | null> {
  const [row] = await db
    .select({ contract: schema.issues.completionContract })
    .from(schema.issues)
    .where(and(eq(schema.issues.orgId, orgId), eq(schema.issues.id, issueId)));
  return (row?.contract as StoredContract | null | undefined) ?? null;
}

/**
 * The status of a task the reader can see (else a 404, as `getIssue`): its row, the outcomes about it or its pull
 * requests, deploy records, and the pending approvals on its runs that the reader may decide.
 */
export async function founderStatus(
  db: Database,
  viewerId: string,
  orgId: string,
  issueId: string,
  running: RunningSource | null,
  now = new Date(),
): Promise<FounderStatus> {
  const issue = await getIssue(db, { type: "person", userId: viewerId }, orgId, { id: issueId });
  const rows = await taskEvidenceRows(db, orgId, issue);
  const contract = await taskContract(db, orgId, issue.id);
  const pending = (await listApprovals(db, viewerId, orgId, { status: "pending", limit: 500 })).filter(
    (a) => a.canDecide && a.issue?.id === issue.id && new Date(a.expiresAt) > now,
  );
  // Never ask again for what is already authorized: the same action approved, not yet run and not expired.
  const hashes = pending.length
    ? await db
        .select({ id: approvals.id, actionHash: approvals.actionHash })
        .from(approvals)
        .where(
          inArray(
            approvals.id,
            pending.map((a) => a.id),
          ),
        )
    : [];
  const hashOf = new Map(hashes.map((h) => [h.id, h.actionHash]));
  const authorized = hashes.length
    ? await db
        .select({ actionHash: approvals.actionHash })
        .from(approvals)
        .where(
          and(
            eq(approvals.orgId, orgId),
            eq(approvals.status, "approved"),
            isNull(approvals.executedAt),
            gt(approvals.expiresAt, now),
            inArray(approvals.actionHash, [...new Set(hashes.map((h) => h.actionHash))]),
          ),
        )
    : [];
  const covered = new Set(authorized.map((a) => a.actionHash));
  const decisions: PendingDecision[] = pending
    .filter((a) => !covered.has(hashOf.get(a.id) ?? ""))
    .map((a) => ({
      approvalId: a.id,
      title: a.title,
      channelId: a.channelId,
      threadId: a.threadId,
      messageId: a.messageId,
      expiresAt: new Date(a.expiresAt),
    }));
  const verifiers = rows.flatMap((r) =>
    (r.kind === "task_verified" || r.kind === "task_rejected") && r.details.by ? [r.details.by as Actor] : [],
  );
  const people = [issue.createdBy, issue.assignee, ...verifiers].filter((a): a is Actor => !!a);
  const personIds = people.filter((a) => a.type === "person").map((a) => a.id);
  const agentIds = people.filter((a) => a.type === "agent").map((a) => a.id);
  const names: Record<string, string> = {};
  if (personIds.length)
    for (const u of await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, personIds)))
      names[u.id] = u.name;
  if (agentIds.length)
    for (const a of await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(and(eq(agents.orgId, orgId), inArray(agents.id, agentIds))))
      names[a.id] = a.name;
  return deriveFounderStatus({
    issue: {
      ...issue,
      criteria: issue.criteria.map((c) => ({ ...c, doneBy: c.doneBy ?? null })),
    },
    outcomes: rows,
    contract,
    decisions,
    running,
    names,
    now,
  });
}

/** What a merged pull request's webhook proves: its subject and merge commit. Null for anything else. */
export function mergeEvidenceOf(
  event: string | null,
  payload: Record<string, unknown>,
): { subject: string; mergeCommit: string } | null {
  if (event !== "pull_request" || payload.action !== "closed") return null;
  const pr = (payload.pull_request ?? {}) as Record<string, unknown>;
  const repo = (payload.repository ?? {}) as Record<string, unknown>;
  const mergeCommit = commitOf(pr.merge_commit_sha);
  const number = Number(pr.number);
  if (pr.merged !== true || !mergeCommit || !Number.isInteger(number) || number <= 0) return null;
  if (typeof repo.full_name !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo.full_name)) return null;
  return { subject: `${repo.full_name}#${number}`.toLowerCase(), mergeCommit };
}

/** A `pr_merged` outcome with its merge commit, once per subject and commit (a redelivered webhook adds nothing). */
export async function recordMergeEvidence(
  db: Database,
  orgId: string,
  input: { subject: string; mergeCommit: string },
): Promise<void> {
  const [seen] = await db
    .select({ id: outcomes.id })
    .from(outcomes)
    .where(
      and(
        eq(outcomes.orgId, orgId),
        eq(outcomes.kind, "pr_merged"),
        eq(outcomes.subject, input.subject),
        sql`${outcomes.details}->>'mergeCommit' = ${input.mergeCommit}`,
      ),
    )
    .limit(1);
  if (seen) return;
  await recordOutcome(db, {
    orgId,
    kind: "pr_merged",
    subject: input.subject,
    summary: `merged ${input.mergeCommit.slice(0, 9)}`,
    details: { mergeCommit: input.mergeCommit },
    source: "webhook",
  });
}

export interface DeployInput {
  orgId: string;
  /** `owner/repo`. */
  repo: string;
  /** The deployed commit. */
  commit: string;
  /** Commits the caller vouches this deploy holds besides `commit` (e.g. first-parent history since the last). */
  commits?: string[];
  /** The source identity the caller worked out from `commit`'s tree (`scripts/runtime-identity.ts rev`). */
  sourceDigest: string;
}

/**
 * Records a deploy (`deploy_succeeded`, source `operator`) only when this server runs that very source now: the
 * caller vouches commit → digest, the server vouches digest = itself. A digest it doesn't run, or no identity of its
 * own, is a conflict and nothing is written. The same commit and digest again returns the row already there.
 */
export async function recordDeploy(db: Database, input: DeployInput, running: RunningSource | null): Promise<Outcome> {
  const repo = input.repo.toLowerCase();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repo)) throw new ValidationError("repo must be owner/name");
  const commit = commitOf(input.commit);
  const commits = (input.commits ?? []).map(commitOf);
  if (!commit || commits.some((c) => !c) || commits.length > 500)
    throw new ValidationError("commit and commits must be full commit ids (at most 500)");
  if (!DIGEST.test(input.sourceDigest)) throw new ValidationError("sourceDigest must be sha256:<64 hex>");
  if (!running || running.files <= 0 || running.digest !== input.sourceDigest)
    throw new ConflictError("This server does not run that source", "deploy_not_running");
  const subject = `deploy:${repo}`;
  const [seen] = await db
    .select()
    .from(outcomes)
    .where(
      and(
        eq(outcomes.orgId, input.orgId),
        eq(outcomes.kind, "deploy_succeeded"),
        eq(outcomes.subject, subject),
        sql`${outcomes.details}->>'commit' = ${commit}`,
        sql`${outcomes.details}->>'sourceDigest' = ${input.sourceDigest}`,
      ),
    )
    .limit(1);
  if (seen) return seen;
  return recordOutcome(db, {
    orgId: input.orgId,
    kind: "deploy_succeeded",
    subject,
    summary: `deployed ${commit.slice(0, 9)}`,
    details: { repo, commit, commits, sourceDigest: input.sourceDigest, files: running.files },
    source: "operator",
  });
}
