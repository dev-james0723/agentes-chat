import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, desc, type Executor, eq, inArray, schema, sql } from "@agenteschat/db";
import { CreditRouteRefusal } from "./credit-route";
import { notify } from "./notifications";
import { assertActiveMembership, getMembership } from "./organizations";
import { enqueue } from "./outbox";
import { addRunStep } from "./runs";
import { keepRunMarkers } from "./sticky-transcript";

/** The existing outbox lease is the only execution owner; this is not a second lease system. */
export interface CreditNativeClaim {
  ownerJobId: string;
  ownerWorkerId: string;
  ownerEpoch: number;
}
export interface CreditInFlight {
  schema: "credit-turn/1";
  turn: number;
  workUnitKey: string;
  phase: "request" | "response";
  startedAt: string;
}
export interface CreditRunHold {
  schema: "credit-reconciliation/1";
  reason: string;
  attemptId?: string;
  heldAt: string;
  nextSafeAction: "reconcile_usage_and_action_receipts";
}
export const creditWorkUnitKey = (runId: string, turn: number) => `${runId}:credit-turn:${turn}`;

export async function lockCreditClaim(
  tx: Executor,
  orgId: string,
  runId: string,
  claim: CreditNativeClaim | undefined,
  at = new Date(),
): Promise<void> {
  if (!claim) throw new CreditRouteRefusal("stale_owner");
  const [job] = await tx
    .select()
    .from(schema.outbox)
    .where(and(eq(schema.outbox.orgId, orgId), eq(schema.outbox.id, claim.ownerJobId)))
    .for("update");
  if (
    job?.kind !== "agent_run.execute" ||
    job.payload.runId !== runId ||
    job.status !== "processing" ||
    job.lockedBy !== claim.ownerWorkerId ||
    job.attempts !== claim.ownerEpoch ||
    !job.lockedUntil ||
    job.lockedUntil <= at
  )
    throw new CreditRouteRefusal("stale_owner");
}

/** A late API receipt may settle cost, but a worker that lost its lease must not start any tools. */
export async function assertCreditClaim(
  db: Database,
  orgId: string,
  runId: string,
  claim: CreditNativeClaim,
  at = new Date(),
): Promise<void> {
  await db.transaction(async (tx) => {
    await lockCreditClaim(tx, orgId, runId, claim, at);
    const [run] = await tx
      .select({ status: schema.agentRuns.status })
      .from(schema.agentRuns)
      .where(and(eq(schema.agentRuns.orgId, orgId), eq(schema.agentRuns.id, runId)))
      .for("update");
    if (run?.status !== "running") throw new CreditRouteRefusal("stale_owner");
  });
}

export async function creditIncident(
  deps: { db: Database; pubsub: PubSub },
  input: {
    orgId: string;
    poolId: string;
    cycleId: string;
    runId: string;
    agentId: string;
    channelId: string;
    provider: "openai" | "anthropic";
    reason: string;
    text: string;
  },
): Promise<void> {
  const owners = await deps.db
    .select({ id: schema.organizationMembers.userId })
    .from(schema.organizationMembers)
    .where(and(eq(schema.organizationMembers.orgId, input.orgId), eq(schema.organizationMembers.role, "owner")));
  await notify(deps, {
    orgId: input.orgId,
    userIds: owners.map((o) => o.id),
    kind: "credit_continuity",
    // One durable incident per shared pool and billing cycle, across agents and restarts.
    groupKey: `credit-continuity:${input.poolId}:${input.cycleId}`,
    waiting: false,
    source: {
      runId: input.runId,
      agentId: input.agentId,
      channelId: input.channelId,
      creditPoolId: input.poolId,
      creditCycleId: input.cycleId,
      creditProvider: input.provider,
    },
    latest: {
      title: `${input.provider === "openai" ? "OpenAI" : "Claude"} API grant continuity`,
      reason: input.reason,
      text: input.text,
    },
  });
}

/** Preserve the original run and its durable receipts. Neither completion nor a replacement task is created. */
export async function holdCreditRun(
  deps: { db: Database; pubsub: PubSub },
  input: {
    orgId: string;
    runId: string;
    claim?: CreditNativeClaim;
    reason: string;
    attemptId?: string;
    transcript?: Record<string, unknown>;
  },
): Promise<boolean> {
  const held = await deps.db.transaction(async (tx) => {
    await lockCreditClaim(tx, input.orgId, input.runId, input.claim);
    const [run] = await tx
      .select()
      .from(schema.agentRuns)
      .where(and(eq(schema.agentRuns.orgId, input.orgId), eq(schema.agentRuns.id, input.runId)))
      .for("update");
    if (!run || !["queued", "running", "waiting_input"].includes(run.status)) return null;
    const t = { ...(run.transcript ?? {}), ...(input.transcript ?? {}) } as Record<string, unknown>;
    const hold: CreditRunHold = {
      schema: "credit-reconciliation/1",
      reason: input.reason,
      ...(input.attemptId ? { attemptId: input.attemptId } : {}),
      heldAt: new Date().toISOString(),
      nextSafeAction: "reconcile_usage_and_action_receipts",
    };
    const already = !!t.creditHold;
    t.creditHold = hold;
    const [row] = await tx
      .update(schema.agentRuns)
      .set({ status: "waiting_input", waitingMachineId: null, transcript: keepRunMarkers(t), updatedAt: new Date() })
      .where(eq(schema.agentRuns.id, run.id))
      .returning();
    if (!already)
      await addRunStep(tx, run, "error", {
        reason: "credit_reconciliation_required",
        credit: { reason: input.reason, attemptId: input.attemptId ?? null },
      });
    return row ?? null;
  });
  const route = held?.transcript?.creditRoute as
    | { poolId?: string; cycleId?: string; provider?: "openai" | "anthropic" }
    | undefined;
  if (held && route?.poolId && route.cycleId && route.provider)
    await creditIncident(deps, {
      orgId: held.orgId,
      runId: held.id,
      agentId: held.agentId,
      channelId: held.channelId,
      poolId: route.poolId,
      cycleId: route.cycleId,
      provider: route.provider,
      reason: input.reason,
      text: "A request or checkpoint needs reconciliation. Its budget remains held; this run will not be replayed.",
    });
  return !!held;
}

/** Called by the existing executor on restart, including when new admissions have been disabled. */
export async function recoverCreditRun(
  deps: { db: Database; pubsub: PubSub },
  runId: string,
  claim?: CreditNativeClaim,
): Promise<boolean> {
  const [run] = await deps.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, runId));
  if (!run) return false;
  const t = run.transcript as Record<string, unknown> | null;
  if (!t?.creditRoute && !t?.creditInFlight && !t?.creditHold) return false;
  if (t.creditHold) return true;
  if (!["queued", "running", "waiting_input"].includes(run.status)) return true;
  const open = await deps.db
    .select()
    .from(schema.creditAttempts)
    .where(
      and(
        eq(schema.creditAttempts.orgId, run.orgId),
        eq(schema.creditAttempts.runId, runId),
        inArray(schema.creditAttempts.state, ["held", "dispatching", "unknown"]),
      ),
    )
    .limit(1);
  const marker = t.creditInFlight as CreditInFlight | undefined;
  if (open[0] || marker?.phase === "response") {
    await holdCreditRun(deps, {
      orgId: run.orgId,
      runId,
      claim,
      reason: open[0] ? "unresolved_api_attempt" : "response_checkpoint_incomplete",
      ...(open[0] ? { attemptId: open[0].id } : {}),
    });
    return true;
  }
  if (!marker) return false;
  const [attempt] = await deps.db
    .select()
    .from(schema.creditAttempts)
    .where(and(eq(schema.creditAttempts.orgId, run.orgId), eq(schema.creditAttempts.workUnitKey, marker.workUnitKey)))
    .orderBy(desc(schema.creditAttempts.createdAt))
    .limit(1);
  if (attempt && attempt.state !== "released") {
    await holdCreditRun(deps, {
      orgId: run.orgId,
      runId,
      claim,
      reason: "receipt_checkpoint_incomplete",
      attemptId: attempt.id,
    });
    return true;
  }
  // No admitted request, or a verified pre-execution refusal: retry may continue using a new native job claim.
  await deps.db.transaction(async (tx) => {
    await lockCreditClaim(tx, run.orgId, runId, claim);
    await tx
      .update(schema.agentRuns)
      .set({ transcript: sql`${schema.agentRuns.transcript} - 'creditInFlight'` })
      .where(and(eq(schema.agentRuns.orgId, run.orgId), eq(schema.agentRuns.id, runId)));
  });
  return false;
}

/** Owner reconciliation wakes the existing outbox only after both cost and native action receipts are proven. */
export async function resumeReconciledCreditRun(
  db: Database,
  input: { orgId: string; runId: string; actorUserId: string; evidenceRef: string },
): Promise<boolean> {
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(input.evidenceRef)) throw new CreditRouteRefusal("unverified");
  const member = await getMembership(db, input.actorUserId, input.orgId);
  if (member?.role !== "owner") throw new CreditRouteRefusal("spend_approval_required");
  assertActiveMembership(member);
  return db.transaction(async (tx) => {
    const [run] = await tx
      .select()
      .from(schema.agentRuns)
      .where(and(eq(schema.agentRuns.orgId, input.orgId), eq(schema.agentRuns.id, input.runId)))
      .for("update");
    if (run?.status !== "waiting_input") return false;
    const t = run.transcript as Record<string, unknown> | null;
    if (
      !t?.creditHold ||
      t.effectUncertain ||
      t.hostAcpUncertain ||
      (t.continuityCheckpoint as { dispatch?: string } | undefined)?.dispatch === "hold" ||
      t.pending
    )
      throw new CreditRouteRefusal("reconciliation_required");
    const [open] = await tx
      .select({ id: schema.creditAttempts.id })
      .from(schema.creditAttempts)
      .where(
        and(
          eq(schema.creditAttempts.orgId, input.orgId),
          eq(schema.creditAttempts.runId, run.id),
          inArray(schema.creditAttempts.state, ["held", "dispatching", "unknown"]),
        ),
      )
      .limit(1);
    const [effects] = await tx
      .select({ id: schema.agentRunSteps.id })
      .from(schema.agentRunSteps)
      .where(
        and(
          eq(schema.agentRunSteps.runId, run.id),
          eq(schema.agentRunSteps.kind, "tool_call"),
          sql`not exists (select 1 from agent_run_steps receipt where receipt.run_id = ${run.id}
        and receipt.kind = 'tool_result' and receipt.seq > ${schema.agentRunSteps.seq}
        and coalesce(receipt.data->>'toolUseId', receipt.data->>'id') = coalesce(${schema.agentRunSteps.data}->>'toolUseId', ${schema.agentRunSteps.data}->>'id'))`,
        ),
      )
      .limit(1);
    if (open || effects) throw new CreditRouteRefusal("reconciliation_required");
    const marker = t.creditInFlight as CreditInFlight | undefined;
    if (marker) {
      const attempts = await tx
        .select({ state: schema.creditAttempts.state })
        .from(schema.creditAttempts)
        .where(
          and(eq(schema.creditAttempts.orgId, input.orgId), eq(schema.creditAttempts.workUnitKey, marker.workUnitKey)),
        );
      // A billed response whose checkpoint was lost is not re-created from a cost receipt.
      if (attempts.some((a) => a.state !== "released")) throw new CreditRouteRefusal("reconciliation_required");
    }
    const next = { ...t };
    delete next.creditHold;
    delete next.creditInFlight;
    await tx
      .update(schema.agentRuns)
      .set({ status: "queued", transcript: next, updatedAt: new Date() })
      .where(eq(schema.agentRuns.id, run.id));
    await addRunStep(tx, run, "context", {
      creditReconciliation: { actorUserId: input.actorUserId, evidenceRef: input.evidenceRef },
    });
    await enqueue(tx, {
      orgId: run.orgId,
      kind: "agent_run.execute",
      payload: { runId: run.id },
      dedupeKey: `credit-resume:${run.id}:${(t.creditHold as CreditRunHold).heldAt}`,
    });
    return true;
  });
}
