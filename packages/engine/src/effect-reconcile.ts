import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, type Executor, eq, inArray, isNotNull, schema, sql } from "@agenteschat/db";
import { postAgentReport } from "./agent-report";
import { decides } from "./approvals";
import { recordAudit } from "./audit";
import { executesHere } from "./cancel";
import { sendNote } from "./consultations";
import { type ReadBack, readBackCall } from "./effect-readback";
import { ConflictError, ForbiddenError, NotFoundError } from "./errors";
import { can, requireChangePermission } from "./organizations";
import { enqueue } from "./outbox";
import { isPrivatePublication } from "./private-skill-publication";
import { addRunStep } from "./runs";
import { standingRefusal } from "./standing";
import type { ToolDefinition, ToolSource } from "./tools/types";

const { agentGroups, agentRuns, agentRunSteps, agents, approvals, issues, runToolTokens } = schema;

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
/** A running run's open epoch is fenced only after this long without a beat (beats come every 20 s). */
export const FENCE_AFTER_MS = 30 * 60_000;
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
function reconciledResult(verdict: EffectVerdict, said: string, by: string, at: Date, note?: string) {
  const noted = note ? ` Note: ${note}` : "";
  return {
    isError: verdict !== "done",
    content:
      verdict === "done"
        ? `Its result was lost, and ${said} confirmed this approved action did happen. It was not run again.${noted}`
        : `Its result was lost, and ${said} confirmed this approved action did not happen. It was not run again by itself: ask again if it is still needed.${noted}`,
    reconciled: { verdict, by, at: at.toISOString() },
  };
}

type HeldRun = typeof agentRuns.$inferSelect;
/** Who settles an effect: a person, or the lead agent it was routed to (ADR 0203 §6). */
type Decider = { type: "person"; id: string } | { type: "agent"; id: string };

/**
 * The run, locked first as a stop locks it (`cancelRun`), so a stop and a release never cross; then what makes a
 * verdict possible at all, read now: the run still held (a stopped or ended run stays so), no turn open, the effect one
 * of its unknown ones, and the workspace and agent at work.
 */
async function lockHeld(tx: Executor, orgId: string, runId: string, effectId: string) {
  const [row] = await tx
    .select({ run: agentRuns, ownerUserId: agents.ownerUserId })
    .from(agentRuns)
    .innerJoin(agents, eq(agents.id, agentRuns.agentId))
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.orgId, orgId)))
    .for("update", { of: agentRuns });
  if (!row) throw new NotFoundError("Run not found");
  if (!(HELD_STATUSES as readonly string[]).includes(row.run.status))
    throw new ConflictError("This run already ended: it is not taken up again", "run.effect_run_ended");
  const held = await heldEffectsOf(tx, orgId, runId);
  if (held.open) throw new ConflictError("A turn of this run is still working", "run.effect_turn_open");
  const effect = held.effects.find((e) => e.id === effectId);
  if (!effect) throw new ConflictError("No such unknown effect on this run", "run.effect_unknown_id");
  const refusal = await standingRefusal(tx, orgId, row.run.agentId);
  if (refusal) throw refusal;
  return { run: row.run, ownerUserId: row.ownerUserId, effect };
}

/** The approval an `approval:` effect ran under, locked; it must still stand (ADR 0203 §4). */
async function standingApproval(tx: Executor, effect: UnknownEffect) {
  const [approval] = await tx
    .select()
    .from(approvals)
    .where(eq(approvals.id, effect.id.slice("approval:".length)))
    .for("update");
  if (!approval) throw new ConflictError("No such unknown effect on this run", "run.effect_unknown_id");
  // Withdrawn or ended since it ran: a restored run never goes on under an authority that no longer stands.
  if (approval.status !== "approved")
    throw new ConflictError("The approval behind this action no longer stands", "run.effect_grant_revoked");
  return approval;
}

/**
 * Only a person may vouch for these (ADR 0203 §6, kept narrow): an action in someone's own mailbox (`approvers.required`,
 * only that person decides it) or a private publication of their own skill. Everything else a lead agent may settle.
 */
const personOnly = (approval: Pick<typeof approvals.$inferSelect, "approvers" | "params">) =>
  Boolean(approval.approvers?.required) || isPrivatePublication(approval);

/** Writes one verdict, its run step and its audit row (in the caller's transaction, the run locked). */
async function applyVerdict(
  tx: Executor,
  input: {
    run: HeldRun;
    effect: UnknownEffect;
    verdict: EffectVerdict;
    decider: Decider;
    /** How the run's model reads who confirmed it. */
    said: string;
    note?: string;
    at: Date;
  },
) {
  const { run, effect, verdict, decider, at, note } = input;
  const by = decider.type === "person" ? decider.id : `agent:${decider.id}`;
  if (effect.kind === "approval") {
    await tx
      .update(approvals)
      .set({ result: reconciledResult(verdict, input.said, by, at, note) })
      .where(and(eq(approvals.id, effect.id.slice("approval:".length)), unsettledApproval));
  } else if (effect.kind === "bridge_call") {
    const [, epochId = "", callId = ""] = effect.id.split(":");
    await settleCall(tx, epochId, callId, { reconciled: verdict, by });
  } else {
    const entry = { verdict, by, at: at.toISOString() };
    await tx
      .update(agentRuns)
      .set({
        transcript: sql`jsonb_set(coalesce(${agentRuns.transcript}, '{}'::jsonb), '{effectReconciled}', coalesce(${agentRuns.transcript}->'effectReconciled', '{}'::jsonb) || ${JSON.stringify({ marker: entry })}::jsonb, true)`,
      })
      .where(eq(agentRuns.id, run.id));
  }
  await addRunStep(tx, run, "error", {
    reason: "effect_reconciled",
    effectId: effect.id,
    tools: effect.tools,
    verdict,
    by,
  });
  await recordAudit(tx, {
    orgId: run.orgId,
    actor: decider,
    action: "run.effect_reconciled",
    target: { type: "run", id: run.id },
    details: { effectId: effect.id, kind: effect.kind, tools: effect.tools, verdict, note },
    runId: run.id,
    channelId: run.channelId,
    outcome: "done",
  });
}

/**
 * An authorized person says what happened to one unknown effect of a held run (ADR 0203 §2). The person's right is
 * checked now, never taken from when the run was held; the run must still be held (a stopped run stays stopped), the
 * workspace and agent may work, and an approval the effect ran under must still stand. The verdict and an audit row are
 * written together; when it was the run's last unknown effect, the run is released as well. A person may always do
 * this; nobody is asked to before an escalation (§6).
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
    const { run, ownerUserId, effect } = await lockHeld(tx, orgId, runId, input.effectId);
    if (effect.kind === "approval") {
      const approval = await standingApproval(tx, effect);
      if (!decides(approval, actorId, membership))
        throw new ForbiddenError("Only who may decide this approval can say whether it happened");
    } else if (!can(membership, "approve_actions") && ownerUserId !== actorId) {
      throw new ForbiddenError("Only the agent's owner or someone who approves actions can say whether it happened");
    }
    const decider = { type: "person" as const, id: actorId };
    await applyVerdict(tx, { run, effect, verdict: input.verdict, decider, said: "a person", note, at });
    return settleIfClear(tx, run, at);
  });
}

/**
 * The lead agent a held run's unknown effects go to first (ADR 0203 §6): the agent the task's assignee reports to
 * ("Responde a", ADR 0148), else the one the run's own agent reports to. Never the run's own agent, an archived one, nor
 * one held from working. Null: there is none, and a person is asked instead.
 */
export async function leadAgentFor(
  db: Executor,
  run: Pick<HeldRun, "orgId" | "agentId" | "issueId">,
): Promise<string | null> {
  let from = run.agentId;
  if (run.issueId) {
    const [issue] = await db
      .select({ type: issues.assigneeType, id: issues.assigneeId })
      .from(issues)
      .where(and(eq(issues.id, run.issueId), eq(issues.orgId, run.orgId)));
    if (issue?.type === "agent" && issue.id) from = issue.id;
  }
  const lead = async (agentId: string) => {
    const [row] = await db
      .select({ lead: agents.reportsToAgentId })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.orgId, run.orgId)));
    return row?.lead ?? null;
  };
  let leadId = await lead(from);
  if (!leadId && from !== run.agentId) leadId = await lead(run.agentId);
  if (!leadId || leadId === run.agentId) return null;
  const [agent] = await db
    .select({ archivedAt: agents.archivedAt })
    .from(agents)
    .where(and(eq(agents.id, leadId), eq(agents.orgId, run.orgId)));
  if (!agent || agent.archivedAt) return null;
  if (await standingRefusal(db, run.orgId, leadId)) return null;
  return leadId;
}

type Routing =
  | { to: "lead"; leadAgentId: string; at: string }
  | { to: "person"; userId: string | null; reason: EscalationReason; at: string };
/** Why a person is asked (§6): no lead, the lead couldn't tell, the lead said nothing in a day, or a person-only effect. */
export type EscalationReason = "no_lead" | "lead_unsure" | "lead_silent" | "person_only";

/** How long the lead has before a person is asked instead. */
export const LEAD_SILENT_MS = 24 * 3600_000;

const routingOf = (run: Pick<HeldRun, "transcript">) =>
  ((run.transcript ?? {}) as { effectRouting?: Routing }).effectRouting ?? null;

async function setRouting(tx: Executor, runId: string, routing: Routing) {
  await tx
    .update(agentRuns)
    .set({
      transcript: sql`jsonb_set(coalesce(${agentRuns.transcript}, '{}'::jsonb), '{effectRouting}', ${JSON.stringify(routing)}::jsonb, true)`,
    })
    .where(eq(agentRuns.id, runId));
}

/**
 * Asks a person (ADR 0203 §6), through the agent's own DM with them (`postAgentReport`, the notification any agent DM
 * gets): the agent's owner, else its setor's lead. With neither, the run waits for whoever opens it (the API lists it).
 */
async function escalate(tx: Executor, run: HeldRun, effects: UnknownEffect[], reason: EscalationReason, at: Date) {
  const [owner] = await tx
    .select({ owner: agents.ownerUserId, setorLead: agentGroups.leadUserId, name: agents.name })
    .from(agents)
    .leftJoin(agentGroups, eq(agentGroups.id, agents.groupId))
    .where(eq(agents.id, run.agentId));
  const userId = owner?.owner ?? owner?.setorLead ?? null;
  await setRouting(tx, run.id, { to: "person", userId, reason, at: at.toISOString() });
  await addRunStep(tx, run, "error", { reason: "effect_escalated", why: reason, userId });
  if (!userId) return null;
  const why = {
    no_lead: "No lead agent could check it",
    lead_unsure: "Its lead agent could not tell",
    lead_silent: "Its lead agent did not answer within a day",
    person_only: "Only a person can vouch for it",
  }[reason];
  const list = effects.map((e) => `- ${e.tools.join(", ")} (${e.id})`).join("\n");
  return postAgentReport(tx, {
    orgId: run.orgId,
    agentId: run.agentId,
    userId,
    body: `A task of mine is held: these actions may have happened, and nothing proves whether they did. ${why}. Tell me whether each one happened (nothing is done again by itself):\n${list}`,
    meta: { effectEscalation: { runId: run.id, reason, effects: effects.map((e) => e.id) } },
  });
}

/**
 * The lead agent's verdict on one unknown effect it was asked about (`settle_unknown_effect`, ADR 0203 §6): done or not
 * done with what it found, or `escalate` when it can't tell. Checked now: it is still the run's routed lead and still
 * the lead the org chart names, both agents may work, the run is still held, and the effect is not person-only.
 */
export async function settleByLead(
  deps: { db: Database; now?: () => Date },
  lead: { orgId: string; agentId: string },
  input: { runId: string; effectId: string; verdict: EffectVerdict | "escalate"; evidence: string },
): Promise<{ released: boolean; escalated: boolean; remaining: UnknownEffect[] }> {
  const at = deps.now?.() ?? new Date();
  const evidence = input.evidence.trim().slice(0, 1000);
  if (!["done", "not_done", "escalate"].includes(input.verdict)) throw new ConflictError("Unknown verdict");
  if (!evidence) throw new ConflictError("Say what you checked", "run.effect_evidence_missing");
  return deps.db.transaction(async (tx) => {
    const { run, effect } = await lockHeld(tx, lead.orgId, input.runId, input.effectId);
    const routing = routingOf(run);
    if (routing?.to !== "lead" || routing.leadAgentId !== lead.agentId)
      throw new ForbiddenError("This held task was not given to you to check", "run.effect_not_routed");
    // The org chart changed since it was routed: the old lead's say lapsed with it.
    if ((await leadAgentFor(tx, run)) !== lead.agentId)
      throw new ConflictError("You no longer lead this task's agent", "run.effect_lead_changed");
    const approval = effect.kind === "approval" ? await standingApproval(tx, effect) : null;
    if (approval && personOnly(approval))
      throw new ForbiddenError("Only a person can vouch for this one", "run.effect_person_only");
    if (input.verdict === "escalate") {
      const { effects } = await heldEffectsOf(tx, run.orgId, run.id);
      await escalate(tx, run, effects, "lead_unsure", at);
      return { released: false, escalated: true, remaining: effects };
    }
    const decider = { type: "agent" as const, id: lead.agentId };
    await applyVerdict(tx, {
      run,
      effect,
      verdict: input.verdict,
      decider,
      said: "the lead agent",
      note: evidence,
      at,
    });
    return { ...(await settleIfClear(tx, run, at)), escalated: false };
  });
}

/**
 * Hands each newly held run to its lead agent, or to a person when §6 says so; a lead silent for a day gives way to a
 * person. The note to the lead goes as `tell_agent` notes do (`sendNote`), after the routing is recorded.
 */
async function routeHeldRuns(db: Database, now: Date) {
  const heldSql = sql`(nullif(${agentRuns.transcript}->'effectUncertain', 'null'::jsonb) is not null
    or exists (select 1 from ${runToolTokens} where ${runToolTokens.runId} = ${agentRuns.id} and ${runToolTokens.effectEpochState} = 'closed_unknown')
    or exists (select 1 from ${approvals} where ${approvals.runId} = ${agentRuns.id} and ${unsettledApproval}))`;
  const due = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        inArray(agentRuns.status, [...HELD_STATUSES]),
        heldSql,
        sql`(${agentRuns.transcript}->'effectRouting' is null
          or (${agentRuns.transcript}->'effectRouting'->>'to' = 'lead'
            and (${agentRuns.transcript}->'effectRouting'->>'at')::timestamptz < ${new Date(now.getTime() - LEAD_SILENT_MS).toISOString()}::timestamptz))`,
      ),
    )
    .limit(100);
  for (const { id } of due) {
    if (executesHere(id)) continue;
    const note = await db.transaction(async (tx) => {
      const [run] = await tx.select().from(agentRuns).where(eq(agentRuns.id, id)).for("update");
      if (!run || !(HELD_STATUSES as readonly string[]).includes(run.status)) return null;
      const held = await heldEffectsOf(tx, run.orgId, run.id);
      if (held.open || held.effects.length === 0) return null;
      if (routingOf(run)?.to === "lead") {
        await escalate(tx, run, held.effects, "lead_silent", now);
        return null;
      }
      const ran = held.effects.filter((e) => e.kind === "approval");
      const only =
        ran.length > 0 &&
        (await tx
          .select({ approvers: approvals.approvers, params: approvals.params })
          .from(approvals)
          .where(
            inArray(
              approvals.id,
              ran.map((e) => e.id.slice("approval:".length)),
            ),
          )
          .then((rows) => rows.some(personOnly)));
      const leadId = only ? null : await leadAgentFor(tx, run);
      if (!leadId) {
        await escalate(tx, run, held.effects, only ? "person_only" : "no_lead", now);
        return null;
      }
      await setRouting(tx, run.id, { to: "lead", leadAgentId: leadId, at: now.toISOString() });
      await addRunStep(tx, run, "error", { reason: "effect_routed", leadAgentId: leadId });
      return { run, leadId, effects: held.effects };
    });
    if (!note) continue;
    const list = note.effects.map((e) => `- ${e.tools.join(", ")}: effect_id "${e.id}"`).join("\n");
    await sendNote(db, {
      orgId: note.run.orgId,
      agentId: note.run.agentId,
      runId: note.run.id,
      hop: note.run.hop,
      targetAgentId: note.leadId,
      body: `One of my tasks is held (run_id "${note.run.id}"): these calls may have acted, and nothing proves whether they did. As my lead, check what happened where you can, without doing any of them again, then call settle_unknown_effect for each: done or not_done with what you found, or escalate if you can't tell.\n${list}`,
      chain: [note.run.agentId],
    }).catch(() => null);
  }
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
      transcript: sql`coalesce(${agentRuns.transcript}, '{}'::jsonb) - 'effectUncertain' - 'effectReconciled' - 'effectRouting'`,
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
  // Fenced only long after the stale cutoff: a turn that missed its beats may still close its own epoch cleanly, and
  // until then the run is held anyway.
  const fenceBefore = new Date(Math.min(at.cutoff.getTime(), at.now.getTime() - FENCE_AFTER_MS)).toISOString();
  const dead = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .innerJoin(runToolTokens, eq(runToolTokens.runId, agentRuns.id))
    .where(
      and(
        eq(agentRuns.status, "running"),
        eq(runToolTokens.effectEpochState, "open"),
        sql`${lastBeat} < ${fenceBefore}::timestamptz`,
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
          and(eq(agentRuns.id, id), eq(agentRuns.status, "running"), sql`${lastBeat} < ${fenceBefore}::timestamptz`),
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
  // What is still unknown goes to the lead agent first, a person only when §6 says so.
  await routeHeldRuns(db, at.now);
  return out;
}

async function orgOf(db: Executor, runId: string) {
  const [run] = await db.select({ orgId: agentRuns.orgId }).from(agentRuns).where(eq(agentRuns.id, runId));
  return run?.orgId;
}

const SETTLE_TOOL = "settle_unknown_effect";

/**
 * `settle_unknown_effect` (ADR 0203 §6): listed only to an agent some held run was routed to, so no other agent's tools
 * change. Built in (no scope): what it may settle is checked on every call by `settleByLead`.
 */
export function createEffectReconcileToolSource(): ToolSource {
  return {
    name: "effect-reconcile",
    async tools(ctx) {
      const [routed] = await ctx.db
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.orgId, ctx.orgId),
            inArray(agentRuns.status, [...HELD_STATUSES]),
            sql`${agentRuns.transcript}->'effectRouting'->>'to' = 'lead'`,
            sql`${agentRuns.transcript}->'effectRouting'->>'leadAgentId' = ${ctx.agentId}`,
          ),
        )
        .limit(1);
      return routed ? [settleTool()] : [];
    },
  };
}

function settleTool(): ToolDefinition {
  return {
    name: SETTLE_TOOL,
    description:
      "Settle one unknown outcome of a held task you were asked to check as the agent's lead: whether a call that may have acted did. Check first (read the place it would have changed); never do the action again. `escalate` when you can't tell: a person is asked.",
    scope: "",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string", description: "The held task's run_id, from the note." },
        effect_id: { type: "string", description: "The effect_id, from the note." },
        verdict: { type: "string", enum: ["done", "not_done", "escalate"] },
        evidence: { type: "string", description: "What you checked and found." },
      },
      required: ["run_id", "effect_id", "verdict", "evidence"],
      additionalProperties: false,
    },
    describe: (input) => ({ title: `Settle an unknown outcome (${String(input.verdict)})` }),
    async execute(input, ctx) {
      try {
        const out = await settleByLead(
          { db: ctx.db },
          { orgId: ctx.orgId, agentId: ctx.agentId },
          {
            runId: String(input.run_id ?? ""),
            effectId: String(input.effect_id ?? ""),
            verdict: input.verdict as EffectVerdict | "escalate",
            evidence: String(input.evidence ?? ""),
          },
        );
        if (out.escalated) return { content: "Escalated: a person is asked now." };
        if (out.released) return { content: "Settled. Nothing is unknown any more: the task goes on." };
        return { content: `Settled. Still unknown: ${out.remaining.map((e) => e.id).join(", ")}.` };
      } catch (error) {
        return { content: error instanceof Error ? error.message : "Not settled", isError: true };
      }
    },
  };
}
