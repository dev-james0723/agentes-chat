import { and, type Executor, eq, gte, isNotNull, isNull, ne, or, schema, sql } from "@agenteschat/db";
import { issueKey } from "./issue-key";

const { agentRuns, agentRunSteps, issues, messages, runToolTokens } = schema;

/**
 * What a read-back found for one call whose effect was unknown: it happened (`done`), it surely did not
 * (`not_done`, safe to retry), or the evidence can't tell (`unknown`, the hold stays).
 */
export type ReadBack = "done" | "not_done" | "unknown";

interface UnknownCall {
  orgId: string;
  agentId: string;
  runId: string;
  input: Record<string, unknown>;
  /** When the turn's bridge epoch opened: no effect of its calls can be older. */
  since: Date;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

/**
 * Read-backs for tools whose effect the platform can check deterministically. Each one says `done` only on an exact
 * match and `not_done` only when the agent wrote nothing of that kind since the turn began; anything else stays
 * unknown (a wrong `not_done` would let a retry write twice).
 */
const READ_BACKS: Record<string, (db: Executor, call: UnknownCall) => Promise<ReadBack>> = {
  async create_issue(db, call) {
    const title = str(call.input.title).trim().slice(0, 300);
    const made = await db
      .select({ id: issues.id, title: issues.title })
      .from(issues)
      .where(
        and(
          eq(issues.orgId, call.orgId),
          sql`${issues.source}->>'agentId' = ${call.agentId}`,
          gte(issues.createdAt, call.since),
        ),
      );
    if (made.length === 0) return "not_done";
    const [task] = made;
    if (!title || made.length > 1 || task?.title !== title) return "unknown";
    // Tied to this run (`linkRun`), it is this call's. Otherwise only when no other run of the agent worked meanwhile:
    // that run could have made it.
    const [linked] = await db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(and(eq(agentRuns.id, call.runId), eq(agentRuns.issueId, task.id)));
    if (linked) return "done";
    const [other] = await db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.orgId, call.orgId),
          eq(agentRuns.agentId, call.agentId),
          ne(agentRuns.id, call.runId),
          isNotNull(agentRuns.startedAt),
          or(isNull(agentRuns.finishedAt), gte(agentRuns.finishedAt, call.since)),
        ),
      )
      .limit(1);
    return other ? "unknown" : "done";
  },
  async comment_issue(db, call) {
    // Read as the tool reads it (`issueKey`); a reference it can't read could have named any task.
    let key: ReturnType<typeof issueKey>;
    try {
      key = issueKey(str(call.input.issue));
    } catch {
      return "unknown";
    }
    const [issue] = await db
      .select({ channelId: issues.conversationChannelId })
      .from(issues)
      .where(
        and(
          eq(issues.orgId, call.orgId),
          key.number !== undefined ? eq(issues.number, key.number) : eq(issues.id, key.id ?? ""),
        ),
      );
    // No such task, or it never got its conversation: the comment had nowhere to go.
    if (!issue?.channelId) return "not_done";
    const body = str(call.input.text).trim().slice(0, 20_000);
    const said = await db
      .select({ body: messages.body })
      .from(messages)
      .where(
        and(
          eq(messages.orgId, call.orgId),
          eq(messages.channelId, issue.channelId),
          eq(messages.authorAgentId, call.agentId),
          eq(messages.agentRunId, call.runId),
          gte(messages.createdAt, call.since),
        ),
      );
    if (said.length === 0) return "not_done";
    return body && said.length === 1 && said[0]?.body === body ? "done" : "unknown";
  },
};

/**
 * Before a cut turn's bridge epoch closes: each call the server answered but could not vouch for (`unknown`) whose
 * tool has a read-back is checked, and settled (`completed`, with what was found) when the read-back is sure. A call
 * still `in_flight` is never read: its effect could land after the read.
 */
export async function reconcileBridgeCalls(
  db: Executor,
  run: { id: string; orgId: string; agentId: string },
  epochId: string,
): Promise<Record<string, ReadBack>> {
  const [epoch] = await db
    .select({ calls: runToolTokens.effectCalls, since: runToolTokens.createdAt })
    .from(runToolTokens)
    .where(and(eq(runToolTokens.id, epochId), eq(runToolTokens.runId, run.id)));
  if (!epoch) return {};
  const unknown = Object.entries(epoch.calls as Record<string, { state?: unknown }>)
    .filter(([, c]) => c.state === "unknown")
    .map(([id]) => id);
  const found: Record<string, ReadBack> = {};
  for (const callId of unknown) {
    const verdict = await readBackCall(db, run, callId, epoch.since);
    if (verdict === null) continue;
    found[callId] = verdict;
    if (verdict === "unknown") continue;
    await db
      .update(runToolTokens)
      .set({
        effectCalls: sql`jsonb_set(${runToolTokens.effectCalls}, ARRAY[${callId}]::text[], ${JSON.stringify({ state: "completed", reconciled: verdict })}::jsonb, true)`,
      })
      .where(
        and(
          eq(runToolTokens.id, epochId),
          eq(runToolTokens.effectEpochState, "open"),
          sql`${runToolTokens.effectCalls}->${callId}->>'state' = 'unknown'`,
        ),
      );
  }
  return found;
}

/**
 * One call's read-back (also used once its epoch is held, ADR 0203): null when its tool has none. `since` is when its
 * turn's epoch opened.
 */
export async function readBackCall(
  db: Executor,
  run: { id: string; orgId: string; agentId: string },
  callId: string,
  since: Date,
): Promise<ReadBack | null> {
  const [step] = await db
    .select({ data: agentRunSteps.data })
    .from(agentRunSteps)
    .where(
      and(
        eq(agentRunSteps.runId, run.id),
        eq(agentRunSteps.kind, "tool_call"),
        sql`${agentRunSteps.data}->>'toolUseId' = ${callId}`,
      ),
    )
    .limit(1);
  const data = step?.data as { name?: unknown; input?: unknown } | undefined;
  const readBack = READ_BACKS[str(data?.name)];
  if (!readBack || !data?.input || typeof data.input !== "object") return null;
  return readBack(db, {
    orgId: run.orgId,
    agentId: run.agentId,
    runId: run.id,
    input: data.input as Record<string, unknown>,
    since,
  }).catch((): ReadBack => "unknown");
}
