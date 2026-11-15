import { and, type Executor, eq, isNull, schema, sql } from "@agenteschat/db";

const { runToolTokens, agentRuns } = schema;

/** Serialize admission against close on the token row, before invoking an effectful bridge call. */
export async function admitBridgeEffect(
  db: Executor,
  runId: string,
  epochId: string,
  callId: string,
): Promise<boolean> {
  if (!callId || callId.length > 256) return false;
  return db.transaction(async (tx) => {
    // Run first, then epoch: cancellation takes the same order. Holding the run lock makes admission observe a
    // committed stop; an effect admitted before the stop remains in flight and must be reconciled.
    const [run] = await tx
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .for("update");
    if (run?.status !== "running") return false;
    const [admitted] = await tx
      .update(runToolTokens)
      .set({
        effectCalls: sql`jsonb_set(${runToolTokens.effectCalls}, ARRAY[${callId}]::text[], '{"state":"in_flight"}'::jsonb, true)`,
      })
      .where(
        and(
          eq(runToolTokens.id, epochId),
          eq(runToolTokens.runId, runId),
          eq(runToolTokens.effectEpochState, "open"),
          isNull(runToolTokens.revokedAt),
          sql`${runToolTokens.expiresAt} > now()`,
          sql`not (${runToolTokens.effectCalls} ? ${callId})`,
        ),
      )
      .returning({ id: runToolTokens.id });
    return !!admitted;
  });
}

/** Called while the run row is locked by cancellation. It never pretends an admitted or native effect was stopped. */
export async function fenceBridgeEpochOnStop(tx: Executor, runId: string): Promise<void> {
  const stopped = await tx
    .update(runToolTokens)
    .set({ effectEpochState: "closed_unknown" })
    .where(and(eq(runToolTokens.runId, runId), eq(runToolTokens.effectEpochState, "open")))
    .returning({ id: runToolTokens.id });
  if (!stopped.length) return;
  const marker = { runId, turn: 0, tools: ["interrupted computer turn"] };
  await tx
    .update(agentRuns)
    .set({
      transcript: sql`jsonb_set(coalesce(${agentRuns.transcript}, '{}'::jsonb), '{effectUncertain}', coalesce(nullif(${agentRuns.transcript}->'effectUncertain', 'null'::jsonb), ${JSON.stringify(marker)}::jsonb), true)`,
      updatedAt: new Date(),
    })
    .where(eq(agentRuns.id, runId));
}

/** Receipt follows the tool's completion; exceptions leave the durable call in flight. */
export async function finishBridgeEffect(
  db: Executor,
  epochId: string,
  callId: string,
  uncertain: boolean,
): Promise<void> {
  await db
    .update(runToolTokens)
    .set({
      effectCalls: sql`jsonb_set(${runToolTokens.effectCalls}, ARRAY[${callId}]::text[], ${JSON.stringify({ state: uncertain ? "unknown" : "completed" })}::jsonb, true)`,
    })
    .where(
      and(
        eq(runToolTokens.id, epochId),
        eq(runToolTokens.effectEpochState, "open"),
        sql`${runToolTokens.effectCalls}->${callId}->>'state' = 'in_flight'`,
      ),
    );
}

/** Close waits behind admissions on the same row. Any admitted but unresolved call makes a sticky hold. */
export async function closeBridgeEffectEpoch(
  db: Executor,
  runId: string,
  epochId: string,
  turn: number,
  nativeUnknown: string[] = [],
  /**
   * The brain ended the turn itself: every call it made returned a result to it (an error it read and went on
   * from, like a browser action that timed out), so a receipted `unknown` call holds nothing; nothing will replay
   * it. A call the server never finished (`in_flight`) still holds.
   */
  turnCompleted = false,
): Promise<{ runId: string; turn: number; tools: string[] } | null> {
  const settled = turnCompleted ? ["completed", "unknown"] : ["completed"];
  // Closing admission and recording uncertainty happen in that order. If the marker write fails, the durable
  // closed_unknown state still blocks resumption; late receipts cannot silently clear it.
  const [closed] = await db
    .update(runToolTokens)
    .set({
      effectEpochState: sql`case when ${nativeUnknown.length > 0} or exists (select 1 from jsonb_each(${runToolTokens.effectCalls}) as effect where effect.value->>'state' is distinct from 'completed' and (not ${turnCompleted} or effect.value->>'state' is distinct from 'unknown')) then 'closed_unknown' else 'closed' end`,
    })
    .where(
      and(eq(runToolTokens.id, epochId), eq(runToolTokens.runId, runId), eq(runToolTokens.effectEpochState, "open")),
    )
    .returning({ calls: runToolTokens.effectCalls, state: runToolTokens.effectEpochState });
  if (!closed) throw new Error("bridge effect epoch not open");
  const calls = closed.calls as Record<string, { state?: unknown }>;
  const bridgeUnknown = Object.values(calls).some((call) => !settled.includes(String(call.state)));
  if (closed.state === "closed_unknown") {
    const marker = {
      runId,
      turn,
      tools: [...new Set([...nativeUnknown, ...(bridgeUnknown ? ["unresolved bridge effect"] : [])])],
    };
    await db
      .update(agentRuns)
      .set({
        transcript: sql`jsonb_set(coalesce(${agentRuns.transcript}, '{}'::jsonb), '{effectUncertain}', coalesce(nullif(${agentRuns.transcript}->'effectUncertain', 'null'::jsonb), ${JSON.stringify(marker)}::jsonb), true)`,
        updatedAt: new Date(),
      })
      .where(eq(agentRuns.id, runId));
  }
  const [run] = await db.select({ transcript: agentRuns.transcript }).from(agentRuns).where(eq(agentRuns.id, runId));
  const hold = (run?.transcript as { effectUncertain?: unknown } | null)?.effectUncertain;
  if (!hold) return null;
  const known = hold as { runId?: unknown; turn?: unknown; tools?: unknown };
  return {
    runId,
    turn,
    tools:
      Array.isArray(known.tools) && known.tools.every((name) => typeof name === "string")
        ? known.tools
        : ["unknown effect"],
  };
}
