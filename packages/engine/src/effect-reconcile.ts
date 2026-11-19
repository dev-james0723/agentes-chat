import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, type Executor, eq, inArray, isNotNull, schema, sql } from "@agenteschat/db";
import { decides } from "./approvals";
import { recordAudit } from "./audit";
import { executesHere } from "./cancel";
import { type ReadBack, readBackCall } from "./effect-readback";
import { ConflictError, ForbiddenError, NotFoundError } from "./errors";
import { can, requireChangePermission } from "./organizations";
import { enqueue } from "./outbox";
import { addRunStep } from "./runs";
import { standingRefusal } from "./standing";

const { agentRuns, agentRunSteps, agents, approvals, runToolTokens } = schema;

/**
 * Reconciling effects whose outcome is unknown (ADR 0203). A run is held while one of its tool calls may have acted
 * and nothing proves whether it did: a bridge epoch left `closed_unknown` (or `open` by a worker that died), an approved
 * action that ran without a result it can vouch for, or the run's `effectUncertain` marker. Each such effect is
 * settled once, by a read-back where one exists or by an authorized person saying done or not done; only when every
 * one is settled is the hold lifted. Nothing here ever runs a call again.
 */

export type EffectVerdict = "done" | "not_done";

export interface UnknownEffect {
  /** `call:<epoch>:<callId>`, `approval:<id>` or `marker`. */
  id: string;
  kind: "bridge_call" | "approval" | "marker";
  tools: string[];
  /** For a bridge call: `unknown` (answered without proof) or `in_flight` (never answered). */
  state?: string;
}

/** The marker's tool name for a bridge call it holds for (`closeBridgeEffectEpoch`): the calls themselves say more. */
const BRIDGE_SENTINEL = "unresolved bridge effect";
/** The marker's name for a turn cut with its worker: what its computer did on its own is unknown (`fenceBridgeEpochOnStop`). */
const INTERRUPTED_TURN = "interrupted computer turn";
/** Statuses a held run can be in. Any other is over: a stopped or ended run is never revived (ADR 0203 §4). */
const HELD_STATUSES = ["queued", "running", "waiting_input", "waiting_approval"] as const;

type Marker = { tools?: unknown } | null | undefined;
type Reconciled = Record<string, { verdict: EffectVerdict; by: string; at: string }>;

/** An approved action that ran without a result proving it did, and no reconciliation yet. */
const unsettledApproval = and(
  isNotNull(approvals.executedAt),
  sql`coalesce(${approvals.result}->>'isError', 'true') <> 'false'`,
  sql`${approvals.result}->'reconciled' is null`,
);

/** What holds the run now, and whether a turn still has its bridge epoch open (then nothing can be reconciled yet). */
export async function heldEffectsOf(
  db: Executor,
  orgId: string,
  runId: string,
): Promise<{ open: boolean; effects: UnknownEffect[] }> {
  const [run] = await db
    .select({ transcript: agentRuns.transcript })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.orgId, orgId)));
  if (!run) throw new NotFoundError("Run not found");
  const epochs = await db
    .select({ id: runToolTokens.id, state: runToolTokens.effectEpochState, calls: runToolTokens.effectCalls })
    .from(runToolTokens)
    .where(and(eq(runToolTokens.runId, runId), inArray(runToolTokens.effectEpochState, ["open", "closed_unknown"])));
  const open = epochs.some((e) => e.state === "open");
  const effects: UnknownEffect[] = [];
  /** Tool names the marker may name that an item of their own already covers. */
  const covered = new Set<string>([BRIDGE_SENTINEL]);
  for (const epoch of epochs) {
    if (epoch.state !== "closed_unknown") continue;
    for (const [callId, call] of Object.entries(epoch.calls as Record<string, { state?: unknown }>)) {
      const name = await callName(db, runId, callId);
      if (name) covered.add(name);
      if (call.state === "completed") continue;
      effects.push({
        id: `call:${epoch.id}:${callId}`,
        kind: "bridge_call",
        tools: [name ?? "unknown tool"],
        state: String(call.state),
      });
    }
  }
  const ran = await db
    .select({ id: approvals.id, tool: approvals.tool, unsettled: sql<boolean>`${unsettledApproval}` })
    .from(approvals)
    .where(and(eq(approvals.runId, runId), isNotNull(approvals.executedAt)));
  for (const a of ran) {
    covered.add(a.tool);
    if (a.unsettled) effects.push({ id: `approval:${a.id}`, kind: "approval", tools: [a.tool] });
  }
  const t = run.transcript as { effectUncertain?: Marker; effectReconciled?: Reconciled } | null;
  const left = markerTools(t?.effectUncertain).filter((name) => !covered.has(name));
  // Something the marker names that no call or approval of the run accounts for (a computer's own tool, evidence that
  // could not be read): a person says what happened, once.
  if (t?.effectUncertain && left.length > 0 && !t.effectReconciled?.marker)
    effects.push({ id: "marker", kind: "marker", tools: left });
  return { open, effects };
}

/**
 * A held run's unknown effects, for who may settle them: someone who approves actions, or the agent's owner (an
 * approval's own deciders are checked again when they decide it).
 */
export async function listHeldEffects(db: Database, actorId: string, orgId: string, runId: string) {
  const membership = await requireChangePermission(db, actorId, orgId, "read");
  const [run] = await db
    .select({ status: agentRuns.status, ownerUserId: agents.ownerUserId })
    .from(agentRuns)
    .innerJoin(agents, eq(agents.id, agentRuns.agentId))
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.orgId, orgId)));
  if (!run) throw new NotFoundError("Run not found");
  if (!can(membership, "approve_actions") && run.ownerUserId !== actorId) throw new NotFoundError("Run not found");
  const held = (HELD_STATUSES as readonly string[]).includes(run.status)
    ? await heldEffectsOf(db, orgId, runId)
    : { open: false, effects: [] };
  return { status: run.status, ...held };
}

const markerTools = (marker: Marker) =>
  Array.isArray(marker?.tools) ? marker.tools.filter((n): n is string => typeof n === "string") : [];

async function callName(db: Executor, runId: string, callId: string): Promise<string | null> {
  const [step] = await db
    .select({ name: sql<string | null>`${agentRunSteps.data}->>'name'` })
    .from(agentRunSteps)
    .where(
      and(
        eq(agentRunSteps.runId, runId),
        eq(agentRunSteps.kind, "tool_call"),
        sql`${agentRunSteps.data}->>'toolUseId' = ${callId}`,
      ),
    )
    .limit(1);
  return step?.name ?? null;
}

/** The answer an approved action's call gets once reconciled: never its own lost result, never a second run. */
function reconciledResult(verdict: EffectVerdict, by: string, at: Date, note?: string) {
  const said = note ? ` Note: ${note}` : "";
  return {
    isError: verdict !== "done",
    content:
      verdict === "done"
        ? `Its result was lost, and a person confirmed this approved action did happen. It was not run again.${said}`
        : `Its result was lost, and a person confirmed this approved action did not happen. It was not run again by itself: ask again if it is still needed.${said}`,
    reconciled: { verdict, by, at: at.toISOString() },
  };
}

/**
 * An authorized person says what happened to one unknown effect of a held run (ADR 0203 §2). The person's right is
 * checked now, never taken from when the run was held; the run must still be held (a stopped run stays stopped), the
 * workspace and agent may work, and an approval the effect ran under must still stand. The verdict and an audit row are
 * written together; when it was the run's last unknown effect, the run is released as well.
 */
export async function reconcileRunEffect(
  deps: { db: Database; pubsub?: PubSub; now?: () => Date },
  actorId: string,
  orgId: string,
  runId: string,
  input: { effectId: string; verdict: EffectVerdict; note?: string },
): Promise<{ released: boolean; remaining: UnknownEffect[] }> {
  const { db } = deps;
  const at = deps.now?.() ?? new Date();
  if (input.verdict !== "done" && input.verdict !== "not_done") throw new ConflictError("Unknown verdict");
  const note = input.note?.trim().slice(0, 1000) || undefined;
  const membership = await requireChangePermission(db, actorId, orgId, "read");
  return db.transaction(async (tx) => {
    // Locked first, as a stop locks it (`cancelRun`): a stop and a release never cross.
    const [run] = await tx
      .select({ run: agentRuns, ownerUserId: agents.ownerUserId })
      .from(agentRuns)
      .innerJoin(agents, eq(agents.id, agentRuns.agentId))
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.orgId, orgId)))
      .for("update", { of: agentRuns });
    if (!run) throw new NotFoundError("Run not found");
    if (!(HELD_STATUSES as readonly string[]).includes(run.run.status))
      throw new ConflictError("This run already ended: it is not taken up again", "run.effect_run_ended");
    const held = await heldEffectsOf(tx, orgId, runId);
    if (held.open) throw new ConflictError("A turn of this run is still working", "run.effect_turn_open");
    const effect = held.effects.find((e) => e.id === input.effectId);
    if (!effect) throw new ConflictError("No such unknown effect on this run", "run.effect_unknown_id");
    const refusal = await standingRefusal(tx, orgId, run.run.agentId);
    if (refusal) throw refusal;

    const mayDecide = can(membership, "approve_actions") || run.ownerUserId === actorId;
    if (effect.kind === "approval") {
      const approvalId = effect.id.slice("approval:".length);
      const [approval] = await tx.select().from(approvals).where(eq(approvals.id, approvalId)).for("update");
      if (!approval || !decides(approval, actorId, membership))
        throw new ForbiddenError("Only who may decide this approval can say whether it happened");
      // Withdrawn or ended since it ran: a restored run never goes on under an authority that no longer stands.
      if (approval.status !== "approved")
        throw new ConflictError("The approval behind this action no longer stands", "run.effect_grant_revoked");
      await tx
        .update(approvals)
        .set({ result: reconciledResult(input.verdict, actorId, at, note) })
        .where(and(eq(approvals.id, approvalId), unsettledApproval));
    } else if (!mayDecide) {
      throw new ForbiddenError("Only the agent's owner or someone who approves actions can say whether it happened");
    } else if (effect.kind === "bridge_call") {
      const [, epochId = "", callId = ""] = effect.id.split(":");
      await settleCall(tx, epochId, callId, { reconciled: input.verdict, by: actorId });
    } else {
      const entry = { verdict: input.verdict, by: actorId, at: at.toISOString() };
      await tx
        .update(agentRuns)
        .set({
          transcript: sql`jsonb_set(coalesce(${agentRuns.transcript}, '{}'::jsonb), '{effectReconciled}', coalesce(${agentRuns.transcript}->'effectReconciled', '{}'::jsonb) || ${JSON.stringify({ marker: entry })}::jsonb, true)`,
        })
        .where(eq(agentRuns.id, runId));
    }
    await addRunStep(tx, run.run, "error", {
      reason: "effect_reconciled",
      effectId: effect.id,
      tools: effect.tools,
      verdict: input.verdict,
      by: actorId,
    });
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "run.effect_reconciled",
      target: { type: "run", id: runId },
      details: { effectId: effect.id, kind: effect.kind, tools: effect.tools, verdict: input.verdict, note },
      runId,
      channelId: run.run.channelId,
      outcome: "done",
    });
    return settleIfClear(tx, run.run, at);
  });
}

/** Marks one bridge call settled, only while its epoch is still held and the call unsettled. */
async function settleCall(
  tx: Executor,
  epochId: string,
  callId: string,
  how: { reconciled: ReadBack; by: string },
): Promise<boolean> {
  const value = { state: "completed", reconciled: how.reconciled, by: how.by };
  const rows = await tx
    .update(runToolTokens)
    .set({
      effectCalls: sql`jsonb_set(${runToolTokens.effectCalls}, ARRAY[${callId}]::text[], ${JSON.stringify(value)}::jsonb, true)`,
    })
    .where(
      and(
        eq(runToolTokens.id, epochId),
        eq(runToolTokens.effectEpochState, "closed_unknown"),
        sql`${runToolTokens.effectCalls}->${callId}->>'state' is distinct from 'completed'`,
      ),
    )
    .returning({ id: runToolTokens.id });
  return rows.length > 0;
}

/**
 * With nothing unknown left, the hold goes (ADR 0203 §3): settled epochs close, the marker is removed (straight, the
 * sticky write would keep it), and a run waiting on a decision gets the job that goes on with it. A running run whose
 * worker died is left to the stale-run sweep and its own rules (it resumes only when no call was cut, else it ends with
 * the notice), and a queued one to the requeue: release is never a replay.
 */
async function settleIfClear(
  tx: Executor,
  run: Pick<typeof agentRuns.$inferSelect, "id" | "orgId" | "status">,
  at: Date,
): Promise<{ released: boolean; remaining: UnknownEffect[] }> {
  const held = await heldEffectsOf(tx, run.orgId, run.id);
  if (held.open || held.effects.length > 0) return { released: false, remaining: held.effects };
  await tx
    .update(runToolTokens)
    .set({ effectEpochState: "closed" })
    .where(
      and(
        eq(runToolTokens.runId, run.id),
        eq(runToolTokens.effectEpochState, "closed_unknown"),
        sql`not exists (select 1 from jsonb_each(${runToolTokens.effectCalls}) as effect where effect.value->>'state' is distinct from 'completed')`,
      ),
    );
  await tx
    .update(agentRuns)
    .set({
      transcript: sql`coalesce(${agentRuns.transcript}, '{}'::jsonb) - 'effectUncertain' - 'effectReconciled'`,
      updatedAt: at,
    })
    .where(eq(agentRuns.id, run.id));
  if (run.status === "waiting_input" || run.status === "waiting_approval") {
    // Like a decision's job (`enqueueResume`): a run still waiting on a person finds its pause open and waits on.
    await enqueue(tx, {
      orgId: run.orgId,
      kind: "agent_run.execute",
      payload: { runId: run.id },
      dedupeKey: `agent_run.execute:${run.id}:reconciled:${at.getTime()}`,
      maxAttempts: 4,
    });
  }
  return { released: true, remaining: [] };
}

/**
 * The sweep's part (ADR 0203 §1): a running run whose worker stopped beating with its bridge epoch open has that epoch
 * fenced (closed as unknown, its token revoked, so the computer can't call on it), then every held run's calls answered
 * without proof are read back where a read-back exists. A run left with nothing unknown is released. Never a call still
 * in flight (its effect could land after the read), never an ended run.
 */
export async function reconcileHeldRuns(
  deps: { db: Database },
  at: { now: Date; cutoff: Date },
): Promise<{ fenced: string[]; released: string[] }> {
  const { db } = deps;
  const out = { fenced: [] as string[], released: [] as string[] };
  const lastBeat = sql`coalesce(${agentRuns.heartbeatAt}, ${agentRuns.startedAt}, ${agentRuns.updatedAt})`;
  const dead = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .innerJoin(runToolTokens, eq(runToolTokens.runId, agentRuns.id))
    .where(
      and(
        eq(agentRuns.status, "running"),
        eq(runToolTokens.effectEpochState, "open"),
        sql`${lastBeat} < ${at.cutoff.toISOString()}::timestamptz`,
      ),
    )
    .limit(100);
  for (const { id } of dead) {
    if (executesHere(id)) continue;
    const fenced = await db.transaction(async (tx) => {
      const [run] = await tx
        .update(agentRuns)
        .set({ updatedAt: at.now })
        .where(
          and(
            eq(agentRuns.id, id),
            eq(agentRuns.status, "running"),
            sql`${lastBeat} < ${at.cutoff.toISOString()}::timestamptz`,
          ),
        )
        .returning({ id: agentRuns.id });
      if (!run) return false;
      const closed = await tx
        .update(runToolTokens)
        .set({ effectEpochState: "closed_unknown", revokedAt: sql`coalesce(${runToolTokens.revokedAt}, now())` })
        .where(and(eq(runToolTokens.runId, id), eq(runToolTokens.effectEpochState, "open")))
        .returning({ id: runToolTokens.id });
      if (closed.length === 0) return false;
      // The turn may also have run the computer's own tools, which the server never saw: a person says what happened.
      const marker = { runId: id, turn: 0, tools: [INTERRUPTED_TURN] };
      await tx
        .update(agentRuns)
        .set({
          transcript: sql`jsonb_set(coalesce(${agentRuns.transcript}, '{}'::jsonb), '{effectUncertain}', coalesce(nullif(${agentRuns.transcript}->'effectUncertain', 'null'::jsonb), ${JSON.stringify(marker)}::jsonb), true)`,
        })
        .where(eq(agentRuns.id, id));
      await addRunStep(tx, { id, orgId: (await orgOf(tx, id)) ?? "" }, "error", { reason: "effect_epoch_fenced" });
      return true;
    });
    if (fenced) out.fenced.push(id);
  }

  // Held runs with a call answered without proof that no read-back has tried yet.
  const held = await db
    .select({
      id: agentRuns.id,
      orgId: agentRuns.orgId,
      agentId: agentRuns.agentId,
      status: agentRuns.status,
      epochId: runToolTokens.id,
      calls: runToolTokens.effectCalls,
      since: runToolTokens.createdAt,
    })
    .from(agentRuns)
    .innerJoin(runToolTokens, eq(runToolTokens.runId, agentRuns.id))
    .where(
      and(
        inArray(agentRuns.status, [...HELD_STATUSES]),
        eq(runToolTokens.effectEpochState, "closed_unknown"),
        sql`exists (select 1 from jsonb_each(${runToolTokens.effectCalls}) as effect where effect.value->>'state' = 'unknown' and effect.value->'readBack' is null)`,
      ),
    )
    .limit(100);
  for (const row of held) {
    if (executesHere(row.id)) continue;
    const calls = Object.entries(row.calls as Record<string, { state?: unknown; readBack?: unknown }>).filter(
      ([, c]) => c.state === "unknown" && c.readBack === undefined,
    );
    const released = await db.transaction(async (tx) => {
      const [run] = await tx
        .select({ status: agentRuns.status })
        .from(agentRuns)
        .where(eq(agentRuns.id, row.id))
        .for("update");
      if (!run || !(HELD_STATUSES as readonly string[]).includes(run.status)) return false;
      for (const [callId] of calls) {
        const verdict = await readBackCall(tx, row, callId, row.since);
        if (verdict === null || verdict === "unknown") {
          // Tried once: an ambiguous read stays for a person, and the sweep doesn't read it every minute.
          await tx
            .update(runToolTokens)
            .set({
              effectCalls: sql`jsonb_set(${runToolTokens.effectCalls}, ARRAY[${callId}, 'readBack']::text[], ${JSON.stringify(verdict ?? "none")}::jsonb, true)`,
            })
            .where(and(eq(runToolTokens.id, row.epochId), eq(runToolTokens.effectEpochState, "closed_unknown")));
          continue;
        }
        if (await settleCall(tx, row.epochId, callId, { reconciled: verdict, by: "read_back" }))
          await addRunStep(tx, row, "error", {
            reason: "effect_reconciled",
            effectId: `call:${row.epochId}:${callId}`,
            verdict,
            by: "read_back",
          });
      }
      if (await standingRefusal(tx, row.orgId, row.agentId)) return false;
      return (await settleIfClear(tx, { ...row, status: run.status }, at.now)).released;
    });
    if (released) out.released.push(row.id);
  }
  return out;
}

async function orgOf(db: Executor, runId: string) {
  const [run] = await db.select({ orgId: agentRuns.orgId }).from(agentRuns).where(eq(agentRuns.id, runId));
  return run?.orgId;
}
