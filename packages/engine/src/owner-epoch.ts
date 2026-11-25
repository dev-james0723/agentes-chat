import { and, type Database, eq, inArray, isNull, or, schema, sql } from "@agenteschat/db";
import { ConflictError } from "./errors";
import { issueKey } from "./issue-key";
import type { CallCheck, ToolContext } from "./tools/types";

/**
 * Issue owner epochs (ADR 0202). Every issue has an epoch that moves on with each claim, change of assignee (a
 * handoff) and cancellation. A run tied to an issue keeps the epoch it was tied under; once the issue's has moved on,
 * the run's writes to that issue are refused, at the Tool Gateway (`ownerEpochCheck`) and again at the write, under
 * the issue's row lock (`assertOwnerEpoch`). Only the issue the run is tied to is fenced: other issues, child tasks
 * included (each has its own epoch), and people's own writes never wait on it.
 *
 * A handoff mid-run leaves the old run a short grace (ADR 0202 §6): for `OWNER_HANDOFF_GRACE_MS` after the epoch moved
 * one step past it, while the run has not ended, it may still post its closing comment and status, never change who owns
 * the task. A cancellation (`owner_handoff_at` cleared) and a second handoff give no grace.
 */

/** The refusal's code (`data.code` on the tool result, `code` on the error). */
export const OWNER_EPOCH_STALE = "issue.owner_epoch_stale";
/** A claim or handoff that lost the race: the epoch it expected was already passed. */
export const OWNER_EPOCH_CONFLICT = "issue.owner_epoch_conflict";

/** How long the old run may still close its turn after a handoff (ADR 0202 §6). */
export const OWNER_HANDOFF_GRACE_MS = 2 * 60 * 1000;

const { agentRuns, issues } = schema;

/** What the fence reads of an issue. */
export type FencedIssue = { id: string; number: number; ownerEpoch: number; ownerHandoffAt: Date | null };

type Executor = Pick<Database, "select" | "update">;

const staleText = (number: number, now: number, run: number) =>
  `Task #${number} changed hands since this run started on it (its owner epoch is ${now}, this run's ${run}): this run may no longer change it. Don't retry or work around it; say so, and leave the task to its current owner.`;

/** The issue a run is tied to and the epoch it was tied under; null when untied or tied before epochs. */
async function runTie(db: Executor, runId: string) {
  const [run] = await db
    .select({ issueId: agentRuns.issueId, epoch: agentRuns.issueEpoch, finishedAt: agentRuns.finishedAt })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId));
  return run?.issueId && run.epoch !== null
    ? { issueId: run.issueId, epoch: run.epoch, live: run.finishedAt === null }
    : null;
}

type Tie = NonNullable<Awaited<ReturnType<typeof runTie>>>;

/** The run's standing on `issue`: current, in the grace after a handoff, or stale. */
function standing(tie: Tie | null, issue: FencedIssue, now: Date): "current" | "grace" | "stale" {
  if (!tie || tie.issueId !== issue.id || tie.epoch >= issue.ownerEpoch) return "current";
  const inGrace =
    tie.live &&
    issue.ownerEpoch === tie.epoch + 1 &&
    issue.ownerHandoffAt !== null &&
    now.getTime() - issue.ownerHandoffAt.getTime() < OWNER_HANDOFF_GRACE_MS;
  return inGrace ? "grace" : "stale";
}

/**
 * Why this run may no longer write `issue`, or null when it may (not tied to it, still current, or in its grace).
 * `owning`: the write changes who owns the task (a claim, a handoff, a cancellation), which the grace never allows.
 */
export async function staleOwnerText(
  db: Executor,
  runId: string | null | undefined,
  issue: FencedIssue,
  owning = false,
): Promise<string | null> {
  if (!runId) return null;
  const tie = await runTie(db, runId);
  const now = standing(tie, issue, new Date());
  if (now === "current" || (now === "grace" && !owning) || !tie) return null;
  return staleText(issue.number, issue.ownerEpoch, tie.epoch);
}

/** Throws the typed refusal when an agent's run is stale for `issue` (read under the caller's lock, where it has one). */
export async function assertOwnerEpoch(
  db: Executor,
  actor: { type: string; runId?: string | null },
  issue: FencedIssue,
  owning = false,
) {
  if (actor.type !== "agent") return;
  const text = await staleOwnerText(db, actor.runId, issue, owning);
  if (text) throw new ConflictError(text, OWNER_EPOCH_STALE, { issueId: issue.id, ownerEpoch: issue.ownerEpoch });
}

/**
 * The gateway's check for every `issues:write` call (`tools/checks.ts`): the issue it names, when it is the one this
 * run is tied to, must still be at the run's epoch (or in its grace). A reference that names nothing is left to the tool to report.
 */
export async function ownerEpochCheck(input: Record<string, unknown>, ctx: ToolContext): Promise<CallCheck> {
  if (!ctx.runId || typeof input.issue !== "string") return { ok: true };
  const tie = await runTie(ctx.db, ctx.runId);
  if (!tie) return { ok: true };
  let ref: { id?: string; number?: number };
  try {
    ref = issueKey(input.issue);
  } catch {
    return { ok: true };
  }
  const [issue] = await ctx.db
    .select({
      id: issues.id,
      number: issues.number,
      ownerEpoch: issues.ownerEpoch,
      ownerHandoffAt: issues.ownerHandoffAt,
    })
    .from(issues)
    .where(and(eq(issues.orgId, ctx.orgId), ref.id ? eq(issues.id, ref.id) : eq(issues.number, ref.number ?? -1)));
  // In its grace the call goes on; whether it changes the owner is decided at the write (`updateIssue`).
  if (!issue || standing(tie, issue, new Date()) !== "stale") return { ok: true };
  return {
    ok: false,
    message: staleText(issue.number, issue.ownerEpoch, tie.epoch),
    data: { code: OWNER_EPOCH_STALE, issueId: issue.id, ownerEpoch: issue.ownerEpoch, runEpoch: tie.epoch },
  };
}

/**
 * Ties runs to an issue at `epoch`. `force`: a claim, which moves the claiming run onto the new epoch even when it was
 * tied to this issue already; otherwise only an untied run is tied (a run keeps its first issue).
 */
export async function tieRuns(
  db: Executor,
  orgId: string,
  runIds: string[],
  issueId: string,
  epoch: number,
  force = false,
) {
  if (runIds.length === 0) return;
  await db
    .update(agentRuns)
    .set({ issueId, issueEpoch: epoch })
    .where(
      and(
        inArray(agentRuns.id, runIds),
        eq(agentRuns.orgId, orgId),
        force ? or(isNull(agentRuns.issueId), eq(agentRuns.issueId, issueId)) : isNull(agentRuns.issueId),
      ),
    );
}

/** The epoch as SQL for runs tied by a query (`linkIssueToWork`): the issue's current one. */
export const currentEpochSql = (issueId: string) =>
  sql<number>`(select ${issues.ownerEpoch} from ${issues} where ${issues.id} = ${issueId}::uuid)`;
