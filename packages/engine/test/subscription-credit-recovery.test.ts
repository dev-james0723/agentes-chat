import { afterEach, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import { createCredential } from "../src/credentials";
import {
  assertCreditClaim,
  creditWorkUnitKey,
  holdCreditRun,
  recoverCreditRun,
  resumeReconciledCreditRun,
} from "../src/credit-continuity";
import {
  admitCreditCall,
  markCreditAttemptDispatched,
  reconcileCreditAttempt,
  registerCreditPool,
  registerCreditRoute,
  setCreditRouteEnabled,
  settleCreditAttempt,
} from "../src/credit-ledger";
import { creditPricingProfile } from "../src/credit-pricing";
import { holdsMessages } from "../src/run-hold";
import { transitionRun } from "../src/runs";
import { keepRunMarkers } from "../src/sticky-transcript";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});
const USD = 1_000_000_000;

async function world() {
  f = await setup();
  const now = Date.now();
  const poolId = await registerCreditPool(f.db, f.org.id, {
    provider: "anthropic",
    upstreamAccount: "org-recovery-fixture",
    product: "claude_ultra_api",
    cycleKey: "recovery-cycle",
    grantId: "recovery-grant",
    grantStart: new Date(now - 86_400_000),
    grantEnd: new Date(now + 25 * 86_400_000),
    eligibleSince: new Date(now - 30 * 86_400_000),
    activatedAt: new Date(now - 86_400_000),
    enforcement: "prepaid_grant_only",
    externalSpendCoverage: "exclusive",
    externalSpendBoundNanoUsd: 0,
    evidenceRef: "synthetic-official-billing-evidence",
    verifiedByUserId: f.owner.id,
    verifiedAt: new Date(now - 1_000),
    validUntil: new Date(now + 3_600_000),
    grantAmountNanoUsd: 200 * USD,
    observedRemainingNanoUsd: 200 * USD,
  });
  const key = await createCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, {
    provider: "anthropic",
    label: "synthetic recovery",
    apiKey: "sk-fixture-no-network",
  });
  const routeId = await registerCreditRoute(f.db, f.org.id, {
    poolId,
    credentialId: key.id,
    model: "claude-sonnet-5-5",
    routeKind: "anthropic_messages",
    accountEvidenceRef: "synthetic-account-binding",
    maxPromptBytes: 400_000,
    supportsTools: true,
    pricingEvidence: {
      evidenceRef: "synthetic-official-pricing",
      verifiedAt: new Date(now - 1_000),
      validUntil: new Date(now + 3_600_000),
      profileHash: creditPricingProfile("claude-sonnet-5-5").profileHash,
    },
    capabilities: ["text", "client_tools"],
  });
  await setCreditRouteEnabled(f.db, f.org.id, routeId, true);
  const [pool] = await f.db.select().from(schema.creditPools).where(eq(schema.creditPools.id, poolId));
  const [route] = await f.db.select().from(schema.creditRoutes).where(eq(schema.creditRoutes.id, routeId));
  if (!pool?.currentCycleId || !route) throw new Error("missing fixture route");
  const runId = crypto.randomUUID(),
    ownerJobId = crypto.randomUUID();
  const trigger = crypto.randomUUID();
  const claim = { ownerJobId, ownerWorkerId: "worker-recovery", ownerEpoch: 1 };
  const workUnitKey = creditWorkUnitKey(runId, 1);
  await f.db.insert(schema.agentRuns).values({
    id: runId,
    orgId: f.org.id,
    agentId: f.agent.id,
    channelId: f.general.id,
    threadRootId: trigger,
    triggerMessageId: trigger,
    trigger: "mention",
    hop: 1,
    status: "running",
    transcript: {
      marker: "original-task-context",
      messages: [{ role: "user", content: "Continue the original work" }],
      creditRoute: { routeId, poolId, cycleId: pool.currentCycleId, provider: "anthropic" },
      creditInFlight: {
        schema: "credit-turn/1",
        turn: 1,
        workUnitKey,
        phase: "request",
        startedAt: new Date().toISOString(),
      },
    },
  });
  await f.db.insert(schema.outbox).values({
    id: ownerJobId,
    orgId: f.org.id,
    kind: "agent_run.execute",
    payload: { runId },
    status: "processing",
    lockedBy: claim.ownerWorkerId,
    lockedUntil: new Date(now + 600_000),
    attempts: claim.ownerEpoch,
  });
  const admission = () =>
    admitCreditCall(f.db, {
      orgId: f.org.id,
      cycleId: pool.currentCycleId as string,
      routeId,
      credentialId: key.id,
      credentialVersion: route.credentialVersion,
      model: route.model,
      need: { tools: true, promptBytes: 1000, capabilities: ["text", "client_tools"] },
      pricingProfileHash: creditPricingProfile(route.model).profileHash,
      amountNanoUsd: USD,
      runId,
      agentId: f.agent.id,
      workUnitKey,
      attemptKey: `${runId}:1:1`,
      ...claim,
    });
  const row = async () => (await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, runId)))[0];
  const cycle = async () =>
    (
      await f.db
        .select()
        .from(schema.creditGrantCycles)
        .where(eq(schema.creditGrantCycles.id, pool.currentCycleId as string))
    )[0];
  return { poolId, routeId, runId, trigger, claim, workUnitKey, admission, row, cycle };
}

test("restart keeps unknown cost, native task identity and one durable incident", async () => {
  const w = await world();
  const a = await w.admission();
  await markCreditAttemptDispatched(f.db, f.org.id, a.attemptId, { ...w.claim, runId: w.runId });
  await settleCreditAttempt(f.db, f.org.id, a.attemptId, { kind: "unknown", reason: "socket disappeared" });
  expect(await recoverCreditRun(f, w.runId, w.claim)).toBe(true);
  expect(await recoverCreditRun(f, w.runId, w.claim)).toBe(true);
  const run = await w.row();
  expect(run).toMatchObject({
    id: w.runId,
    status: "waiting_input",
    agentId: f.agent.id,
    threadRootId: w.trigger,
    triggerMessageId: w.trigger,
    transcript: { marker: "original-task-context" },
  });
  expect(run?.finishedAt).toBeNull();
  expect((await w.cycle())?.heldAutomaticNanoUsd).toBe(USD);
  const notices = await f.db
    .select()
    .from(schema.notifications)
    .where(eq(schema.notifications.kind, "credit_continuity"));
  expect(notices).toHaveLength(1);
  if (!run) throw new Error("held run missing");
  expect(await holdsMessages(f.db, run)).toBe(true);
});

test("a pre-transport crash with no admitted attempt clears only its marker", async () => {
  const w = await world();
  expect(await recoverCreditRun(f, w.runId, w.claim)).toBe(false);
  expect((await w.row())?.transcript).toMatchObject({ marker: "original-task-context" });
  expect((await w.row())?.transcript?.creditInFlight).toBeUndefined();
  expect((await w.row())?.status).toBe("running");
});

test("proven no-charge refusal can recover but never invents task completion", async () => {
  const w = await world();
  const a = await w.admission();
  await markCreditAttemptDispatched(f.db, f.org.id, a.attemptId, { ...w.claim, runId: w.runId });
  await settleCreditAttempt(f.db, f.org.id, a.attemptId, {
    kind: "released",
    reason: "HTTP refusal",
    providerRefusal: true,
  });
  expect(await recoverCreditRun(f, w.runId, w.claim)).toBe(false);
  expect((await w.row())?.status).toBe("running");
  expect((await w.cycle())?.heldAutomaticNanoUsd).toBe(0);
});

test("a billed request without a persisted response checkpoint stays held for review", async () => {
  const w = await world();
  const a = await w.admission();
  await markCreditAttemptDispatched(f.db, f.org.id, a.attemptId, { ...w.claim, runId: w.runId });
  await settleCreditAttempt(f.db, f.org.id, a.attemptId, {
    kind: "settled",
    actualNanoUsd: 1000,
    providerRequestId: "req-receipt",
  });
  expect(await recoverCreditRun(f, w.runId, w.claim)).toBe(true);
  await expect(
    resumeReconciledCreditRun(f.db, {
      orgId: f.org.id,
      runId: w.runId,
      actorUserId: f.owner.id,
      evidenceRef: "cost-is-not-completion",
    }),
  ).rejects.toThrow("reconciliation_required");
  expect((await w.row())?.status).toBe("waiting_input");
});

test("owner reconciliation requeues exactly the original run once", async () => {
  const w = await world();
  const a = await w.admission();
  await markCreditAttemptDispatched(f.db, f.org.id, a.attemptId, { ...w.claim, runId: w.runId });
  await settleCreditAttempt(f.db, f.org.id, a.attemptId, { kind: "unknown", reason: "unknown transport" });
  await recoverCreditRun(f, w.runId, w.claim);
  await reconcileCreditAttempt(f.db, f.org.id, a.attemptId, f.owner.id, {
    evidenceRef: "provider-confirms-not-accepted",
    reason: "No accepted request or native side effects",
  });
  const input = { orgId: f.org.id, runId: w.runId, actorUserId: f.owner.id, evidenceRef: "native-receipts-reviewed" };
  expect(await resumeReconciledCreditRun(f.db, input)).toBe(true);
  expect(await resumeReconciledCreditRun(f.db, input)).toBe(false);
  expect((await w.row())?.status).toBe("queued");
  const queued = await f.db
    .select()
    .from(schema.outbox)
    .where(and(eq(schema.outbox.kind, "agent_run.execute"), eq(schema.outbox.status, "pending")));
  expect(queued).toHaveLength(1);
  expect(queued[0]?.payload.runId).toBe(w.runId);
  expect(await f.db.select().from(schema.agentRuns)).toHaveLength(1);
});

test("a member cannot unlock a run and an owner cannot bypass an unknown action receipt", async () => {
  const w = await world();
  await holdCreditRun(f, { orgId: f.org.id, runId: w.runId, claim: w.claim, reason: "action_receipt" });
  const member = await addMember(f.db, f.org.id, "member", "Observer");
  await expect(
    resumeReconciledCreditRun(f.db, {
      orgId: f.org.id,
      runId: w.runId,
      actorUserId: member.id,
      evidenceRef: "not-authority",
    }),
  ).rejects.toThrow("spend_approval_required");
  await f.db.insert(schema.agentRunSteps).values({
    orgId: f.org.id,
    runId: w.runId,
    kind: "tool_call",
    seq: 50,
    data: { toolUseId: "unknown-effect", name: "external_action" },
  });
  await expect(
    resumeReconciledCreditRun(f.db, {
      orgId: f.org.id,
      runId: w.runId,
      actorUserId: f.owner.id,
      evidenceRef: "billing-alone-insufficient",
    }),
  ).rejects.toThrow("reconciliation_required");
});

test("a stale native worker cannot dispatch, park or overwrite another owner's checkpoint", async () => {
  const w = await world();
  await f.db
    .update(schema.outbox)
    .set({ lockedBy: "new-worker", attempts: 2 })
    .where(eq(schema.outbox.id, w.claim.ownerJobId));
  await expect(assertCreditClaim(f.db, f.org.id, w.runId, w.claim)).rejects.toThrow("stale_owner");
  await expect(holdCreditRun(f, { orgId: f.org.id, runId: w.runId, claim: w.claim, reason: "stale" })).rejects.toThrow(
    "stale_owner",
  );
  expect((await w.row())?.status).toBe("running");
  expect((await w.row())?.transcript?.creditHold).toBeUndefined();
});

test("stale transcript writers and native completion cannot erase a credit hold", async () => {
  const w = await world();
  const before = (await w.row())?.transcript ?? {};
  await holdCreditRun(f, { orgId: f.org.id, runId: w.runId, claim: w.claim, reason: "receipt-check" });
  await f.db
    .update(schema.agentRuns)
    .set({ transcript: keepRunMarkers(before) })
    .where(eq(schema.agentRuns.id, w.runId));
  expect((await w.row())?.transcript?.creditHold).toBeTruthy();
  expect(await transitionRun(f.db, w.runId, "waiting_input", "running")).toBeNull();
  await f.db.update(schema.agentRuns).set({ status: "running" }).where(eq(schema.agentRuns.id, w.runId));
  expect(await transitionRun(f.db, w.runId, "running", "done")).toBeNull();
});
