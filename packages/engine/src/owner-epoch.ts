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
 */

/** The refusal's code (`data.code` on the tool result, `code` on the error). */
export const OWNER_EPOCH_STALE = "issue.owner_epoch_stale";
/** A claim or handoff that lost the race: the epoch it expected was already passed. */
export const OWNER_EPOCH_CONFLICT = "issue.owner_epoch_conflict";

const { agentRuns, issues } = schema;

type Executor = Pick<Database, "select" | "update">;

const staleText = (number: number, now: number, run: number) =>
  `Task #${number} changed hands since this run started on it (its owner epoch is ${now}, this run's ${run}): this run may no longer change it. Don't retry or work around it; say so, and leave the task to its current owner.`;

/** The issue a run is tied to and the epoch it was tied under; null when untied or tied before epochs. */
async function runTie(db: Executor, runId: string) {
  const [run] = await db
    .select({ issueId: agentRuns.issueId, epoch: agentRuns.issueEpoch })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId));
  return run?.issueId && run.epoch !== null ? { issueId: run.issueId, epoch: run.epoch } : null;
}

/** Why this run may no longer write `issue`, or null when it may (not tied to it, or still current). */
export async function staleOwnerText(
  db: Executor,
  runId: string | null | undefined,
  issue: { id: string; number: number; ownerEpoch: number },
): Promise<string | null> {
  if (!runId) return null;
  const tie = await runTie(db, runId);
  if (!tie || tie.issueId !== issue.id || tie.epoch >= issue.ownerEpoch) return null;
  return staleText(issue.number, issue.ownerEpoch, tie.epoch);
}

/** Throws the typed refusal when an agent's run is stale for `issue` (read under the caller's lock, where it has one). */
export async function assertOwnerEpoch(
  db: Executor,
  actor: { type: string; runId?: string | null },
  issue: { id: string; number: number; ownerEpoch: number },
) {
  if (actor.type !== "agent") return;
  const text = await staleOwnerText(db, actor.runId, issue);
  if (text) throw new ConflictError(text, OWNER_EPOCH_STALE, { issueId: issue.id, ownerEpoch: issue.ownerEpoch });
}

/**
 * The gateway's check for every `issues:write` call (`tools/checks.ts`): the issue it names, when it is the one this
 * run is tied to, must still be at the run's epoch. A reference that names nothing is left to the tool to report.
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
    .select({ id: issues.id, number: issues.number, ownerEpoch: issues.ownerEpoch })
    .from(issues)
    .where(and(eq(issues.orgId, ctx.orgId), ref.id ? eq(issues.id, ref.id) : eq(issues.number, ref.number ?? -1)));
  if (!issue || issue.id !== tie.issueId || tie.epoch >= issue.ownerEpoch) return { ok: true };
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
