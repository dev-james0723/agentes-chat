import { createHash } from "node:crypto";
import type { EvidenceOutcome } from "./founder-status";

/**
 * A task's completion contract and the rules that read it (ADR 0211). Pure: no database, so every rule is a unit
 * test. The contract says which evidence kinds an independent verifier's "verified" needs; the evidence is stored
 * `outcomes` rows (ADR 0017, 0204), never an agent's or a screen's word that something is done.
 */

/** The evidence a contract can require. */
export const EVIDENCE_KINDS = ["criteria", "person_vouched", "pr_merged", "deploy_running", "tests_passed"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** A task with no contract of its own: every acceptance criterion checked, confirmed by an independent verifier. */
export const DEFAULT_EVIDENCE: readonly EvidenceKind[] = ["criteria"];

type Actor = { type: "person" | "agent"; id: string };

export interface CompletionContract {
  evidence: EvidenceKind[];
  /** The test suite a receipt must name, and the digest of its test files when the contract was set. */
  tests: { suite: string; digest: string } | null;
  setBy: Actor | null;
  setAt: string | null;
  /** True: no contract was set, the default applies. */
  isDefault: boolean;
}

export interface StoredContract {
  evidence: string[];
  tests?: { suite: string; digest: string } | null;
  setBy: Actor;
  setAt: string;
}

export const TESTS_DIGEST = /^sha256:[0-9a-f]{64}$/;

/** The contract in force: the stored one (unknown kinds dropped), else the default. */
export function contractOf(stored: StoredContract | null | undefined): CompletionContract {
  const evidence = (stored?.evidence ?? []).filter((k): k is EvidenceKind =>
    (EVIDENCE_KINDS as readonly string[]).includes(k),
  );
  if (!stored || evidence.length === 0)
    return { evidence: [...DEFAULT_EVIDENCE], tests: null, setBy: null, setAt: null, isDefault: true };
  return {
    evidence: [...new Set(evidence)].sort(),
    tests: stored.tests ?? null,
    setBy: stored.setBy,
    setAt: stored.setAt,
    isDefault: false,
  };
}

/**
 * What a verdict was given against: the contract's evidence and pinned tests, and the criteria's words. Changing any of
 * them after a verdict makes it stale, so a contract or criteria loosened after "verified" never keeps it.
 */
export function contractHash(contract: CompletionContract, criteria: { text: string }[]): string {
  const canonical = JSON.stringify({
    evidence: [...contract.evidence].sort(),
    tests: contract.tests ? { suite: contract.tests.suite, digest: contract.tests.digest } : null,
    criteria: criteria.map((c) => c.text),
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/** Why the evidence does not meet the contract. Codes; the founder status words them. */
export const MISSING_REASONS = [
  "not_claimed",
  "no_criteria",
  "criteria_unchecked",
  "not_person_vouched",
  "not_merged",
  "merge_reverted",
  "merge_commit_unknown",
  "not_deployed",
  "deploy_stale",
  "deploy_rolled_back",
  "runtime_unknown",
  "tests_not_pinned",
  "tests_receipt_missing",
  "tests_receipt_untrusted",
  "tests_wrong_commit",
  "tests_changed",
  "tests_failed",
] as const;
export type MissingReason = (typeof MISSING_REASONS)[number];

export interface CompletionInput {
  status: string;
  criteria: { done: boolean; doneBy?: Actor | null }[];
  contract: CompletionContract;
  /** The rows about this task, its pull requests, its repository's deploys and test receipts. */
  rows: EvidenceOutcome[];
  /** The founder status's delivery of the task (ADR 0204): its merge commit and whether this server runs it. */
  delivery: { state: string; merge: { commit: string | null } | null };
}

export interface CompletionAssessment {
  ok: boolean;
  /** Each required kind that is met, and the outcome row that meets it (`criteria`: the task row itself). */
  met: Partial<Record<EvidenceKind, string>>;
  missing: MissingReason[];
}

const newest = (rows: EvidenceOutcome[]) =>
  rows.reduce<EvidenceOutcome | null>((a, b) => (!a || b.createdAt > a.createdAt ? b : a), null);
const isPerson = (a: unknown) => (a as { type?: unknown } | null)?.type === "person";

/**
 * A test receipt counts only when the operator API recorded it (CI holding the operator token, ADR 0056): an agent's
 * own tool, a run or the app can't. It must name the contract's suite, the task's merge commit and the test files'
 * digest pinned in the contract, so a changed test file (E04-02) or a receipt about other code never passes.
 */
function testsEvidence(input: CompletionInput): { id: string } | MissingReason {
  const pinned = input.contract.tests;
  if (!pinned) return "tests_not_pinned";
  const receipts = input.rows.filter(
    (r) =>
      (r.kind === "tests_passed" || r.kind === "tests_failed") &&
      r.subject.startsWith("tests:") &&
      r.details.suite === pinned.suite,
  );
  const trusted = receipts.filter((r) => r.source === "operator");
  const commit = input.delivery.merge?.commit ?? null;
  const forCommit = commit ? trusted.filter((r) => r.details.commit === commit) : [];
  const last = newest(forCommit);
  if (!last) {
    if (receipts.some((r) => r.source !== "operator" && r.kind === "tests_passed")) return "tests_receipt_untrusted";
    return trusted.length > 0 ? "tests_wrong_commit" : "tests_receipt_missing";
  }
  if (last.kind === "tests_failed") return "tests_failed";
  if (last.details.testsDigest !== pinned.digest) return "tests_changed";
  return { id: last.id };
}

const DELIVERY_MISSING: Record<string, MissingReason> = {
  not_merged: "not_merged",
  reverted: "merge_reverted",
  merge_commit_unknown: "merge_commit_unknown",
  merged_not_deployed: "not_deployed",
  deployed_not_running: "deploy_stale",
  rolled_back: "deploy_rolled_back",
  runtime_unknown: "runtime_unknown",
};

/** Whether the stored evidence meets the contract now. A claim of done is required; it is never itself evidence. */
export function assessCompletion(input: CompletionInput): CompletionAssessment {
  const met: CompletionAssessment["met"] = {};
  const missing: MissingReason[] = [];
  if (input.status !== "done") missing.push("not_claimed");
  const { criteria } = input;
  for (const kind of input.contract.evidence) {
    switch (kind) {
      case "criteria":
        if (criteria.length === 0) missing.push("no_criteria");
        else if (!criteria.every((c) => c.done)) missing.push("criteria_unchecked");
        else met.criteria = "task";
        break;
      case "person_vouched": {
        const vouched = newest(input.rows.filter((r) => r.kind === "criteria_met"));
        const reopened =
          vouched && input.rows.some((r) => r.kind === "issue_reopened" && r.createdAt > vouched.createdAt);
        const checked = vouched?.details.checkedBy;
        const ok =
          vouched &&
          !reopened &&
          criteria.length > 0 &&
          criteria.every((c) => c.done && isPerson(c.doneBy)) &&
          Array.isArray(checked) &&
          checked.length > 0 &&
          checked.every(isPerson);
        if (ok) met.person_vouched = vouched.id;
        else missing.push("not_person_vouched");
        break;
      }
      case "pr_merged": {
        const reason = DELIVERY_MISSING[input.delivery.state];
        if (reason === "not_merged" || reason === "merge_reverted" || reason === "merge_commit_unknown")
          missing.push(reason);
        else {
          const merge = newest(input.rows.filter((r) => r.kind === "pr_merged"));
          met.pr_merged = merge?.id ?? "merge";
        }
        break;
      }
      case "deploy_running":
        if (input.delivery.state === "available") {
          const deploy = newest(
            input.rows.filter(
              (r) =>
                r.kind === "deploy_succeeded" &&
                (r.details.commit === input.delivery.merge?.commit ||
                  (Array.isArray(r.details.commits) && r.details.commits.includes(input.delivery.merge?.commit))),
            ),
          );
          met.deploy_running = deploy?.id ?? "deploy";
        } else missing.push(DELIVERY_MISSING[input.delivery.state] ?? "not_deployed");
        break;
      case "tests_passed": {
        const t = testsEvidence(input);
        if (typeof t === "string") missing.push(t);
        else met.tests_passed = t.id;
        break;
      }
    }
  }
  return { ok: missing.length === 0, met, missing: [...new Set(missing)] };
}

export type VerdictState = "verified" | "rejected" | "stale" | "none";

export interface Verdict {
  state: VerdictState;
  by: Actor | null;
  at: Date | null;
  reasons: string[];
}

/** A newer claim of done (`issue_closed`) or a reopen clears a verdict: the work changed since it was given. */
const VERDICT_KINDS = new Set(["task_verified", "task_rejected", "issue_reopened", "issue_closed"]);

/**
 * The verdict in force on a task: its newest `task_verified`, `task_rejected`, `issue_reopened` or `issue_closed` row.
 * Reopened or claimed done again since: none (a reopened task loses verified). Verified against another contract or other criteria: stale. A verdict by one
 * of the task's implementers is never one (defense in depth; `verifyTask` refuses it at the write).
 */
export function verdictOf(rows: EvidenceOutcome[], hash: string, implementers: Actor[] = []): Verdict {
  const own = (a: unknown) => implementers.some((i) => i.type === (a as Actor)?.type && i.id === (a as Actor)?.id);
  const isVerdict = (k: string) => k === "task_verified" || k === "task_rejected";
  const last = newest(rows.filter((r) => VERDICT_KINDS.has(r.kind) && !(isVerdict(r.kind) && own(r.details.by))));
  if (!last || !isVerdict(last.kind)) return { state: "none", by: null, at: null, reasons: [] };
  const by = (last.details.by as Actor | undefined) ?? null;
  const reasons = Array.isArray(last.details.reasons) ? last.details.reasons.filter((x) => typeof x === "string") : [];
  if (last.kind === "task_rejected") return { state: "rejected", by, at: last.createdAt, reasons };
  if (last.details.contractHash !== hash) return { state: "stale", by, at: last.createdAt, reasons: [] };
  return { state: "verified", by, at: last.createdAt, reasons: [] };
}
