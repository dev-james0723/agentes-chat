import { and, type Database, desc, eq, inArray, schema } from "@agenteschat/db";
import {
  type DeliveryState,
  deliveryOf,
  type EvidenceOutcome,
  prSubjectOf,
  type RunningSource,
} from "./founder-status";
import { listIssues } from "./issues";

const { outcomes, issues } = schema;

/**
 * Requirement traceability (ADR 0206): which requirement is delivered, and which change belongs to which requirement.
 * A requirement is a task labelled `requirement`; its tasks are its sub-tasks (or itself, when it has none); their
 * pull requests carry the merge commits the GitHub webhook recorded, and a change is delivered only by the same rule
 * as a task's founder status (ADR 0204): a deploy record holding its merge commit that this server runs now. Nothing
 * here is written or judged by a model; it is a projection of stored rows.
 */

export const REQUIREMENT_LABEL = "requirement";

export interface TraceEvidence {
  issues: {
    id: string;
    number: number;
    title: string;
    status: string;
    labels: string[];
    parentIssueId: string | null;
    pullRequests: { number: number; url: string }[];
  }[];
  outcomes: EvidenceOutcome[];
  running: RunningSource | null;
  /** Pull request subjects (`owner/repo#N`) linked by any task in the workspace, seen by the reader or not. */
  linkedSubjects?: Set<string>;
}

export type RequirementState = "no_tasks" | "in_progress" | "done_undelivered" | "delivered" | "canceled";

export interface TraceChange {
  subject: string;
  url: string;
  mergeCommit: string | null;
  delivery: DeliveryState;
}

export interface TraceRequirement {
  id: string;
  number: number;
  title: string;
  status: string;
  state: RequirementState;
  delivered: boolean;
  tasks: { id: string; number: number; title: string; status: string; changes: TraceChange[] }[];
}

export type TraceFlag =
  | { kind: "unlinked_merge"; subject: string; mergeCommit: string | null }
  | { kind: "done_without_delivery"; requirementId: string; number: number }
  | { kind: "duplicate_requirement"; numbers: number[] };

export interface Traceability {
  requirements: TraceRequirement[];
  flags: TraceFlag[];
}

const CLOSED = new Set(["done", "canceled"]);
/** Merged changes in these states are in the code but not in the running app. */
const UNDELIVERED: ReadonlySet<DeliveryState> = new Set([
  "merge_commit_unknown",
  "merged_not_deployed",
  "rolled_back",
  "runtime_unknown",
  "deployed_not_running",
]);

const isRequirement = (i: { labels: string[] }) => i.labels.some((l) => l.toLowerCase() === REQUIREMENT_LABEL);
const titleKey = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

export function deriveTraceability(e: TraceEvidence): Traceability {
  const repoOf = (subject: string) => subject.split("#")[0];
  const change = (pr: { url: string }): TraceChange | null => {
    const subject = prSubjectOf(pr.url);
    if (!subject) return null;
    const rows = e.outcomes.filter(
      (r) => r.subject.toLowerCase() === subject || r.subject.toLowerCase() === `deploy:${repoOf(subject)}`,
    );
    const d = deliveryOf(rows, e.running);
    return { subject, url: pr.url, mergeCommit: d.merge?.commit ?? null, delivery: d.state };
  };

  const flags: TraceFlag[] = [];
  const requirements = e.issues.filter(isRequirement).map((req): TraceRequirement => {
    const children = e.issues.filter((i) => i.parentIssueId === req.id);
    const tasks = (children.length ? children : req.pullRequests.length ? [req] : []).map((t) => ({
      id: t.id,
      number: t.number,
      title: t.title,
      status: t.status,
      changes: t.pullRequests.flatMap((p) => change(p) ?? []),
    }));
    const changes = tasks.flatMap((t) => t.changes);
    const allClosed =
      tasks.length > 0 && tasks.every((t) => CLOSED.has(t.status)) && tasks.some((t) => t.status === "done");
    const delivered =
      allClosed && changes.some((c) => c.delivery === "available") && !changes.some((c) => UNDELIVERED.has(c.delivery));
    const state: RequirementState =
      req.status === "canceled"
        ? "canceled"
        : tasks.length === 0
          ? "no_tasks"
          : !allClosed
            ? "in_progress"
            : delivered
              ? "delivered"
              : "done_undelivered";
    if (state === "done_undelivered")
      flags.push({ kind: "done_without_delivery", requirementId: req.id, number: req.number });
    return { id: req.id, number: req.number, title: req.title, status: req.status, state, delivered, tasks };
  });

  const linked =
    e.linkedSubjects ?? new Set(e.issues.flatMap((i) => i.pullRequests.flatMap((p) => prSubjectOf(p.url) ?? [])));
  const seen = new Set<string>();
  for (const r of e.outcomes) {
    const subject = r.subject.toLowerCase();
    if (r.kind !== "pr_merged" || linked.has(subject) || seen.has(subject)) continue;
    seen.add(subject);
    const commit = typeof r.details.mergeCommit === "string" ? r.details.mergeCommit : null;
    flags.push({ kind: "unlinked_merge", subject, mergeCommit: commit });
  }

  const byTitle = new Map<string, number[]>();
  for (const r of requirements) {
    if (r.state === "canceled") continue;
    const key = titleKey(r.title);
    byTitle.set(key, [...(byTitle.get(key) ?? []), r.number]);
  }
  for (const numbers of byTitle.values())
    if (numbers.length > 1) flags.push({ kind: "duplicate_requirement", numbers: numbers.sort((a, b) => a - b) });

  return { requirements, flags };
}

/** The workspace's traceability as `viewerId` sees it: requirements and tasks they can see, flags over the workspace. */
export async function traceability(
  db: Database,
  viewerId: string,
  orgId: string,
  running: RunningSource | null,
): Promise<Traceability> {
  const seen = await listIssues(db, { type: "person", userId: viewerId }, orgId, { limit: 500 });
  // Linked anywhere in the workspace, so a PR on a task the reader can't see is not called unlinked.
  const all = await db.select({ pullRequests: issues.pullRequests }).from(issues).where(eq(issues.orgId, orgId));
  const linkedSubjects = new Set(
    all.flatMap((i) =>
      (i.pullRequests as { url?: unknown }[]).flatMap((p) =>
        typeof p.url === "string" ? (prSubjectOf(p.url) ?? []) : [],
      ),
    ),
  );
  const rows = await db
    .select({
      id: outcomes.id,
      kind: outcomes.kind,
      subject: outcomes.subject,
      details: outcomes.details,
      createdAt: outcomes.createdAt,
    })
    .from(outcomes)
    .where(
      and(
        eq(outcomes.orgId, orgId),
        inArray(outcomes.kind, ["pr_merged", "pr_reverted", "deploy_succeeded", "deploy_rolled_back"]),
      ),
    )
    .orderBy(desc(outcomes.createdAt))
    .limit(2000);
  return deriveTraceability({
    issues: seen.map((i) => ({
      id: i.id,
      number: i.number,
      title: i.title,
      status: i.status,
      labels: i.labels,
      parentIssueId: i.parentIssueId,
      pullRequests: i.pullRequests.map((p) => ({ number: p.number, url: p.url })),
    })),
    outcomes: rows,
    running,
    linkedSubjects,
  });
}
