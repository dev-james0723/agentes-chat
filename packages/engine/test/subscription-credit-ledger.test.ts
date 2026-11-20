import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { MODEL_CATALOG } from "@agenteschat/providers";
import { createCredential } from "../src/credentials";
import {
  admitCreditCall,
  approveCreditReserve,
  CREDIT_USD,
  type CreditPoolEvidence,
  creditBudgetForGrant,
  creditLedgerSnapshot,
  forecastCreditWorkUnit,
  markCreditAttemptDispatched,
  qualifyCreditRoute,
  recoverCreditReservations,
  refreshCreditPoolEvidence,
  refreshCreditRoutePricingEvidence,
  registerCreditPool,
  registerCreditRoute,
  setCreditRouteEnabled,
  settleCreditAttempt,
  startCreditGrantCycle,
} from "../src/credit-ledger";
import { creditPricingProfile, creditReceiptCost } from "../src/credit-pricing";
import { purgeWorkspace, scheduleDeletion } from "../src/workspace-deletion";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
  f = undefined as unknown as Fixture;
});
const USD = CREDIT_USD;
const NOW = () => new Date("2026-11-20T12:00:00Z");
const need = {
  tools: true,
  promptBytes: 1000,
  capabilities: ["text", "client_tools"],
  minimumTier: "medium" as const,
  effort: "high" as const,
};
const MODEL = "claude-sonnet-5-5";

function evidence(o: Partial<CreditPoolEvidence> = {}): CreditPoolEvidence {
  return {
    provider: "anthropic",
    upstreamAccount: "org-fixture",
    product: "claude_ultra_api",
    cycleKey: "cycle-20261113",
    grantId: "grant-fixture-1",
    grantStart: new Date("2026-11-13T00:00:00Z"),
    grantEnd: new Date("2026-12-13T00:00:00Z"),
    eligibleSince: new Date("2026-10-01T00:00:00Z"),
    activatedAt: new Date("2026-11-13T00:00:00Z"),
    enforcement: "prepaid_grant_only",
    externalSpendCoverage: "exclusive",
    externalSpendBoundNanoUsd: 0,
    evidenceRef: "provider-billing-fixture",
    verifiedByUserId: f.owner.id,
    verifiedAt: new Date("2026-11-20T11:59:00Z"),
    validUntil: new Date("2026-11-20T13:00:00Z"),
    grantAmountNanoUsd: 200 * USD,
    observedRemainingNanoUsd: 200 * USD,
    ...o,
  };
}
async function route(o: Partial<CreditPoolEvidence> = {}, enabled = true, selectedModel?: string) {
  const e = evidence(o);
  const model = selectedModel ?? (e.provider === "openai" ? "gpt-6.1-sol" : MODEL);
  const pricingEvidence = {
    evidenceRef: "official-pricing-fixture",
    verifiedAt: new Date("2026-11-20T11:59Z"),
    validUntil: new Date("2026-11-20T13:00Z"),
    profileHash: creditPricingProfile(model).profileHash,
  };
  const key = await createCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, {
    provider: e.provider,
    label: "grant route",
    apiKey: "sk-synthetic-only",
    ...(e.provider === "openai" ? { organization: e.upstreamAccount } : {}),
  });
  const poolId = await registerCreditPool(f.db, f.org.id, e, NOW);
  const routeId = await registerCreditRoute(
    f.db,
    f.org.id,
    {
      poolId,
      credentialId: key.id,
      model,
      pricingEvidence,
      supportsTools: true,
      maxPromptBytes: 100_000,
      routeKind: e.provider === "openai" ? "openai_responses" : "anthropic_messages",
      accountEvidenceRef: "key-org-binding-fixture",
      capabilities: ["text", "client_tools"],
    },
    NOW,
  );
  if (enabled) await setCreditRouteEnabled(f.db, f.org.id, routeId, true, NOW);
  const [r] = await f.db.select().from(schema.creditRoutes).where(eq(schema.creditRoutes.id, routeId));
  const [p] = await f.db.select().from(schema.creditPools).where(eq(schema.creditPools.id, poolId));
  if (!r || !p?.currentCycleId) throw new Error("fixture route missing");
  return {
    routeId,
    poolId,
    model,
    pricingEvidence,
    pricingProfileHash: pricingEvidence.profileHash,
    cycleId: p.currentCycleId,
    credentialId: key.id,
    credentialVersion: r.credentialVersion,
    evidence: e,
  };
}
async function claim(routeId?: string) {
  const [route] = await f.db
    .select({ id: schema.creditRoutes.id })
    .from(schema.creditRoutes)
    .where(routeId ? eq(schema.creditRoutes.id, routeId) : eq(schema.creditRoutes.orgId, f.org.id))
    .orderBy(schema.creditRoutes.id)
    .limit(1);
  const runId = crypto.randomUUID();
  const ownerJobId = crypto.randomUUID();
  await f.db.insert(schema.agentRuns).values({
    id: runId,
    orgId: f.org.id,
    agentId: f.agent.id,
    channelId: f.general.id,
    threadRootId: crypto.randomUUID(),
    triggerMessageId: crypto.randomUUID(),
    trigger: "mention",
    hop: 1,
    status: "running",
    transcript: {
      creditRoute: {
        routeId: route?.id,
        minimumTier: need.minimumTier,
        effort: need.effort,
        capabilities: [...need.capabilities],
      },
    },
  });
  await f.db.insert(schema.outbox).values({
    id: ownerJobId,
    orgId: f.org.id,
    kind: "agent_run.execute",
    payload: { runId },
    status: "processing",
    lockedBy: "worker-fixture",
    lockedUntil: new Date("2026-11-20T12:05:00Z"),
    attempts: 1,
  });
  return {
    runId,
    ownerJobId,
    ownerWorkerId: "worker-fixture",
    ownerEpoch: 1,
    workUnitKey: `${runId}:turn:0`,
    attemptKey: `${runId}:turn:0:attempt:1`,
  };
}
type R = Awaited<ReturnType<typeof route>>;
type Claim = Awaited<ReturnType<typeof claim>>;
function admission(r: R, c: Claim, amountNanoUsd = USD) {
  return { orgId: f.org.id, ...r, ...c, model: r.model, need, amountNanoUsd, agentId: f.agent.id, now: NOW };
}
async function cycle(id: string) {
  const [c] = await f.db.select().from(schema.creditGrantCycles).where(eq(schema.creditGrantCycles.id, id));
  if (!c) throw new Error("cycle missing");
  return c;
}

test("protection-first budgets shrink for actual grants and never rise above provider caps", () => {
  expect(creditBudgetForGrant(200 * USD)).toEqual({
    automaticLimitNanoUsd: 120 * USD,
    emergencyLimitNanoUsd: 60 * USD,
    safetyBufferNanoUsd: 20 * USD,
  });
  expect(creditBudgetForGrant(100 * USD)).toEqual({
    automaticLimitNanoUsd: 20 * USD,
    emergencyLimitNanoUsd: 60 * USD,
    safetyBufferNanoUsd: 20 * USD,
  });
  expect(creditBudgetForGrant(50 * USD)).toEqual({
    automaticLimitNanoUsd: 0,
    emergencyLimitNanoUsd: 30 * USD,
    safetyBufferNanoUsd: 20 * USD,
  });
  expect(creditBudgetForGrant(10 * USD)).toEqual({
    automaticLimitNanoUsd: 0,
    emergencyLimitNanoUsd: 0,
    safetyBufferNanoUsd: 10 * USD,
  });
  expect(creditBudgetForGrant(500 * USD).automaticLimitNanoUsd).toBe(120 * USD);
  expect(() => creditBudgetForGrant(Number.MAX_SAFE_INTEGER + 1)).toThrow();
});

test("missing evidence remains disabled and registering does not activate a route", async () => {
  f = await setup();
  expect(await qualifyCreditRoute(f.db, { orgId: f.org.id, need, now: NOW })).toEqual({
    ok: false,
    reason: "disabled",
  });
  await route({}, false);
  expect(await qualifyCreditRoute(f.db, { orgId: f.org.id, need, now: NOW })).toEqual({
    ok: false,
    reason: "disabled",
  });
  expect((await creditLedgerSnapshot(f.db, f.org.id, NOW)).pools[0]?.automaticAvailableNanoUsd).toBe(0);
});

test("eligibility, activation, lifetime, provider and purchased funding are explicit requirements", async () => {
  f = await setup();
  for (const e of [
    evidence({ eligibleSince: NOW() }),
    evidence({ activatedAt: new Date("2026-11-21") }),
    evidence({ enforcement: "auto_reload" as never }),
    evidence({ validUntil: new Date("2027-01-01") }),
    evidence({ observedRemainingNanoUsd: 201 * USD }),
    evidence({ provider: "openai", product: "claude_ultra_api" }),
    evidence({ verifiedAt: new Date("2026-11-21T12:00Z"), validUntil: new Date("2026-11-21T13:00Z") }),
  ]) {
    await expect(registerCreditPool(f.db, f.org.id, e, NOW)).rejects.toMatchObject({ reason: "grant_unverified" });
  }
  const member = await addMember(f.db, f.org.id, "admin");
  await expect(
    registerCreditPool(f.db, f.org.id, evidence({ verifiedByUserId: member.id }), NOW),
  ).rejects.toMatchObject({
    reason: "spend_approval_required",
  });
  expect((await f.db.select().from(schema.creditPools)).length).toBe(0);
});

test("available allocation accounts for previous external spending and a bounded external reserve", async () => {
  f = await setup();
  const r = await route({
    observedRemainingNanoUsd: 150 * USD,
    externalSpendCoverage: "bounded",
    externalSpendBoundNanoUsd: 10 * USD,
  });
  expect((await creditLedgerSnapshot(f.db, f.org.id, NOW)).pools[0]?.automaticAvailableNanoUsd).toBe(60 * USD);
  expect(await forecastCreditWorkUnit(f.db, f.org.id, r.poolId, 20 * USD, NOW)).toMatchObject({
    kind: "conservative_estimate",
    canReserve: true,
    workUnitsRemaining: 3,
  });
});

test("many concurrent agents share one $120 automatic ceiling", async () => {
  f = await setup();
  const r = await route();
  const claims = await Promise.all(Array.from({ length: 8 }, () => claim()));
  const outcomes = await Promise.allSettled(claims.map((c) => admitCreditCall(f.db, admission(r, c, 30 * USD))));
  expect(outcomes.filter((x) => x.status === "fulfilled").length).toBe(4);
  expect(outcomes.filter((x) => x.status === "rejected").length).toBe(4);
  expect((await cycle(r.cycleId)).heldAutomaticNanoUsd).toBe(120 * USD);
  expect((await cycle(r.cycleId)).heldEmergencyNanoUsd).toBe(0);
});

test("retrying a pre-dispatch reservation is idempotent; only one caller can authorize transmission", async () => {
  f = await setup();
  const r = await route();
  const c = await claim();
  const a = await admitCreditCall(f.db, admission(r, c));
  const replay = await admitCreditCall(f.db, admission(r, c));
  expect(replay.attemptId).toBe(a.attemptId);
  expect(replay.replayed).toBe(true);
  const sends = await Promise.allSettled([
    markCreditAttemptDispatched(f.db, f.org.id, a.attemptId, { ...c, now: NOW }),
    markCreditAttemptDispatched(f.db, f.org.id, a.attemptId, { ...c, now: NOW }),
  ]);
  expect(sends.filter((x) => x.status === "fulfilled").length).toBe(1);
  await expect(admitCreditCall(f.db, admission(r, c))).rejects.toMatchObject({ reason: "reconciliation_required" });
  expect((await cycle(r.cycleId)).heldAutomaticNanoUsd).toBe(USD);
});

test("native lease changes fence predecessor and cannot free its reservation", async () => {
  f = await setup();
  const r = await route();
  const c = await claim();
  const a = await admitCreditCall(f.db, admission(r, c));
  await f.db
    .update(schema.outbox)
    .set({ attempts: 2, lockedBy: "successor" })
    .where(eq(schema.outbox.id, c.ownerJobId));
  await expect(markCreditAttemptDispatched(f.db, f.org.id, a.attemptId, { ...c, now: NOW })).rejects.toMatchObject({
    reason: "stale_owner",
  });
  await expect(
    admitCreditCall(f.db, {
      ...admission(r, c),
      ownerEpoch: 2,
      ownerWorkerId: "successor",
      attemptKey: `${c.attemptKey}:successor`,
    }),
  ).rejects.toMatchObject({ reason: "reconciliation_required" });
  expect((await recoverCreditReservations(f.db, f.org.id))[0]?.state).toBe("held");
});

test("a native expired lease or wrong run payload cannot admit any spending", async () => {
  f = await setup();
  const r = await route();
  const c = await claim();
  await f.db.update(schema.outbox).set({ lockedUntil: NOW() }).where(eq(schema.outbox.id, c.ownerJobId));
  await expect(admitCreditCall(f.db, admission(r, c))).rejects.toMatchObject({ reason: "stale_owner" });
  await f.db
    .update(schema.outbox)
    .set({ lockedUntil: new Date("2026-11-20T13:00Z"), payload: { runId: crypto.randomUUID() } })
    .where(eq(schema.outbox.id, c.ownerJobId));
  await expect(admitCreditCall(f.db, admission(r, c))).rejects.toMatchObject({ reason: "stale_owner" });
  expect((await cycle(r.cycleId)).heldAutomaticNanoUsd).toBe(0);
});

test("timeout after dispatch retains unknown debit across recovery, evidence refresh and replay", async () => {
  f = await setup();
  const r = await route();
  const c = await claim();
  const a = await admitCreditCall(f.db, admission(r, c, 10 * USD));
  await markCreditAttemptDispatched(f.db, f.org.id, a.attemptId, { ...c, now: NOW });
  await settleCreditAttempt(
    f.db,
    f.org.id,
    a.attemptId,
    { kind: "unknown", reason: "injected connection loss after send" },
    NOW,
  );
  const recovered = await recoverCreditReservations(f.db, f.org.id);
  expect(recovered[0]).toMatchObject({ state: "unknown", amountNanoUsd: 10 * USD });
  await refreshCreditPoolEvidence(f.db, f.org.id, r.poolId, r.evidence, NOW);
  await expect(admitCreditCall(f.db, admission(r, await claim()))).rejects.toMatchObject({
    reason: "reconciliation_required",
  });
  await expect(
    settleCreditAttempt(
      f.db,
      f.org.id,
      a.attemptId,
      { kind: "released", reason: "TTL elapsed", providerRefusal: true },
      NOW,
    ),
  ).rejects.toMatchObject({ reason: "reconciliation_required" });
  expect((await cycle(r.cycleId)).heldAutomaticNanoUsd).toBe(10 * USD);
});

test("settlement records exact cost once, returns unused hold, and rejects contradictory receipts", async () => {
  f = await setup();
  const r = await route();
  const c = await claim();
  const a = await admitCreditCall(f.db, admission(r, c, 10 * USD));
  await markCreditAttemptDispatched(f.db, f.org.id, a.attemptId, { ...c, now: NOW });
  await settleCreditAttempt(f.db, f.org.id, a.attemptId, { kind: "settled", actualNanoUsd: 3 * USD }, NOW);
  expect(
    await settleCreditAttempt(f.db, f.org.id, a.attemptId, { kind: "settled", actualNanoUsd: 3 * USD }, NOW),
  ).toEqual({ changed: false, state: "settled" });
  await expect(
    settleCreditAttempt(f.db, f.org.id, a.attemptId, { kind: "settled", actualNanoUsd: 4 * USD }, NOW),
  ).rejects.toThrow("conflicting");
  expect(await cycle(r.cycleId)).toMatchObject({ spentAutomaticNanoUsd: 3 * USD, heldAutomaticNanoUsd: 0 });
  await expect(
    admitCreditCall(f.db, { ...admission(r, c), attemptKey: `${c.attemptKey}:again` }),
  ).rejects.toMatchObject({ reason: "paused" });
  expect((await creditLedgerSnapshot(f.db, f.org.id, NOW)).pools[0]?.paused).toBe(true);
});

test("cost above its hold is retained as debt and opens the budget circuit breaker", async () => {
  f = await setup();
  const r = await route();
  const c = await claim();
  const a = await admitCreditCall(f.db, admission(r, c));
  await markCreditAttemptDispatched(f.db, f.org.id, a.attemptId, { ...c, now: NOW });
  await settleCreditAttempt(f.db, f.org.id, a.attemptId, { kind: "settled", actualNanoUsd: 2 * USD }, NOW);
  expect((await cycle(r.cycleId)).spentAutomaticNanoUsd).toBe(2 * USD);
  await refreshCreditPoolEvidence(f.db, f.org.id, r.poolId, r.evidence, NOW);
  expect((await creditLedgerSnapshot(f.db, f.org.id, NOW)).pools[0]).toMatchObject({
    paused: true,
    status: "reconciliation_required",
    automaticAvailableNanoUsd: 0,
  });
});

test("fresh but lagging provider evidence never restores locally spent allowance", async () => {
  f = await setup();
  const r = await route();
  const c = await claim();
  const a = await admitCreditCall(f.db, admission(r, c, 40 * USD));
  await markCreditAttemptDispatched(f.db, f.org.id, a.attemptId, { ...c, now: NOW });
  await settleCreditAttempt(f.db, f.org.id, a.attemptId, { kind: "settled", actualNanoUsd: 30 * USD }, NOW);
  await refreshCreditPoolEvidence(
    f.db,
    f.org.id,
    r.poolId,
    {
      ...r.evidence,
      evidenceRef: "lagging-provider-dashboard",
      observedRemainingNanoUsd: 200 * USD,
    },
    NOW,
  );
  expect(await cycle(r.cycleId)).toMatchObject({
    observedRemainingNanoUsd: 170 * USD,
    localSpentAtObservationNanoUsd: 30 * USD,
    spentAutomaticNanoUsd: 30 * USD,
  });
  expect((await creditLedgerSnapshot(f.db, f.org.id, NOW)).pools[0]?.automaticAvailableNanoUsd).toBe(90 * USD);
  await expect(
    refreshCreditPoolEvidence(f.db, f.org.id, r.poolId, { ...r.evidence, grantAmountNanoUsd: 400 * USD }, NOW),
  ).rejects.toMatchObject({ reason: "cycle_mismatch" });
});

test("emergency reserve requires current native owner approval scoped to this cycle", async () => {
  f = await setup();
  const r = await route();
  const c = await claim();
  await expect(admitCreditCall(f.db, { ...admission(r, c, 20 * USD), bucket: "emergency" })).rejects.toMatchObject({
    reason: "spend_approval_required",
  });
  const member = await addMember(f.db, f.org.id, "admin");
  const decision = {
    cycleId: r.cycleId,
    amountNanoUsd: 20 * USD,
    validUntil: new Date("2026-11-20T12:30Z"),
    decisionKey: "owner-emergency-1",
    evidenceRef: "owner-decision-fixture",
  };
  await expect(approveCreditReserve(f.db, f.org.id, r.poolId, member.id, decision, NOW)).rejects.toMatchObject({
    reason: "spend_approval_required",
  });
  const approvalId = await approveCreditReserve(f.db, f.org.id, r.poolId, f.owner.id, decision, NOW);
  expect(await approveCreditReserve(f.db, f.org.id, r.poolId, f.owner.id, decision, NOW)).toBe(approvalId);
  const a = await admitCreditCall(f.db, { ...admission(r, c, 20 * USD), bucket: "emergency", approvalId });
  await markCreditAttemptDispatched(f.db, f.org.id, a.attemptId, { ...c, now: NOW });
  await settleCreditAttempt(f.db, f.org.id, a.attemptId, { kind: "settled", actualNanoUsd: 20 * USD }, NOW);
  expect(await cycle(r.cycleId)).toMatchObject({
    spentEmergencyNanoUsd: 20 * USD,
    heldEmergencyNanoUsd: 0,
    spentAutomaticNanoUsd: 0,
  });
  await expect(
    admitCreditCall(f.db, { ...admission(r, await claim()), bucket: "emergency", approvalId }),
  ).rejects.toMatchObject({ reason: "spend_approval_required" });
});

test("approval revocation between reservation and dispatch prevents transmission", async () => {
  f = await setup();
  const r = await route();
  const c = await claim();
  const approvalId = await approveCreditReserve(
    f.db,
    f.org.id,
    r.poolId,
    f.owner.id,
    {
      cycleId: r.cycleId,
      amountNanoUsd: 60 * USD,
      validUntil: new Date("2026-11-20T12:30Z"),
      decisionKey: "emergency-revoked",
      evidenceRef: "owner-decision",
    },
    NOW,
  );
  const a = await admitCreditCall(f.db, { ...admission(r, c), bucket: "emergency", approvalId });
  await f.db
    .update(schema.creditReserveApprovals)
    .set({ revokedAt: NOW() })
    .where(eq(schema.creditReserveApprovals.id, approvalId));
  await expect(markCreditAttemptDispatched(f.db, f.org.id, a.attemptId, { ...c, now: NOW })).rejects.toMatchObject({
    reason: "spend_approval_required",
  });
  expect((await recoverCreditReservations(f.db, f.org.id))[0]?.state).toBe("held");
});

test("expired or stale evidence, changed credentials and missing capabilities fail closed", async () => {
  f = await setup();
  const r = await route();
  expect(
    await qualifyCreditRoute(f.db, { orgId: f.org.id, need, now: () => new Date("2026-11-20T14:00Z") }),
  ).toMatchObject({ ok: false, reason: "stale_evidence" });
  expect(
    await qualifyCreditRoute(f.db, { orgId: f.org.id, need, now: () => new Date("2026-12-13T00:00Z") }),
  ).toMatchObject({ ok: false, reason: "grant_expired" });
  expect(
    await qualifyCreditRoute(f.db, {
      orgId: f.org.id,
      need: { ...need, capabilities: ["native_computer_session"] },
      now: NOW,
    }),
  ).toMatchObject({ ok: false, reason: "unsupported_capability" });
  await f.db
    .update(schema.providerCredentials)
    .set({ revokedAt: NOW() })
    .where(eq(schema.providerCredentials.id, r.credentialId));
  expect(await qualifyCreditRoute(f.db, { orgId: f.org.id, need, now: NOW })).toMatchObject({
    ok: false,
    reason: "credential_changed",
  });
});

test("a second upstream account cannot multiply the provider allowance", async () => {
  f = await setup();
  await route();
  await expect(
    registerCreditPool(
      f.db,
      f.org.id,
      evidence({ upstreamAccount: "different-provider-account", grantId: "second-grant" }),
      NOW,
    ),
  ).rejects.toThrow();
  expect((await f.db.select().from(schema.creditPools)).length).toBe(1);
});

test("rollover retains the old cycle and cannot forgive an unknown debit", async () => {
  f = await setup();
  const r = await route();
  const c = await claim();
  const a = await admitCreditCall(f.db, admission(r, c));
  await markCreditAttemptDispatched(f.db, f.org.id, a.attemptId, { ...c, now: NOW });
  await settleCreditAttempt(f.db, f.org.id, a.attemptId, { kind: "unknown", reason: "restart injected" }, NOW);
  const next = {
    ...r.evidence,
    cycleKey: "cycle-20261213",
    grantId: "grant-fixture-2",
    grantStart: new Date("2026-12-13T00:00Z"),
    grantEnd: new Date("2027-01-13T00:00Z"),
    verifiedAt: new Date("2026-12-13T00:01Z"),
    validUntil: new Date("2026-12-13T01:00Z"),
  };
  await expect(startCreditGrantCycle(f.db, f.org.id, r.poolId, next, () => next.verifiedAt)).rejects.toMatchObject({
    reason: "reconciliation_required",
  });
  await settleCreditAttempt(
    f.db,
    f.org.id,
    a.attemptId,
    {
      kind: "settled",
      actualNanoUsd: USD,
      reconciliation: { actorUserId: f.owner.id, evidenceRef: "provider-final-usage" },
    },
    NOW,
  );
  const nextId = await startCreditGrantCycle(f.db, f.org.id, r.poolId, next, () => next.verifiedAt);
  expect(nextId).not.toBe(r.cycleId);
  expect((await cycle(r.cycleId)).spentAutomaticNanoUsd).toBe(USD);
  expect((await cycle(nextId)).spentAutomaticNanoUsd).toBe(0);
  expect((await creditLedgerSnapshot(f.db, f.org.id, () => new Date("2026-12-13T00:02Z"))).pools[0]?.enabled).toBe(
    false,
  );
});

test("unknown release needs an actual owner and a bounded reconciliation reference", async () => {
  f = await setup();
  const r = await route();
  const c = await claim();
  const a = await admitCreditCall(f.db, admission(r, c));
  await markCreditAttemptDispatched(f.db, f.org.id, a.attemptId, { ...c, now: NOW });
  await settleCreditAttempt(f.db, f.org.id, a.attemptId, { kind: "unknown", reason: "connection lost" }, NOW);
  const member = await addMember(f.db, f.org.id, "member");
  await expect(
    settleCreditAttempt(
      f.db,
      f.org.id,
      a.attemptId,
      {
        kind: "released",
        reason: "verified no charge",
        reconciliation: { actorUserId: member.id, evidenceRef: "provider-receipt" },
      },
      NOW,
    ),
  ).rejects.toMatchObject({ reason: "spend_approval_required" });
  await settleCreditAttempt(
    f.db,
    f.org.id,
    a.attemptId,
    {
      kind: "released",
      reason: "verified no charge",
      reconciliation: { actorUserId: f.owner.id, evidenceRef: "provider-receipt" },
    },
    NOW,
  );
  expect((await cycle(r.cycleId)).heldAutomaticNanoUsd).toBe(0);
  const audit = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "credit.reconciled"));
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({
    actorId: f.owner.id,
    targetId: a.attemptId,
    details: { evidenceRef: "provider-receipt", outcome: "released", actualNanoUsd: 0 },
  });
});

test("reduced billing balance between reservation and dispatch prevents spending protected funds", async () => {
  f = await setup();
  const r = await route();
  const c = await claim();
  const a = await admitCreditCall(f.db, admission(r, c, 20 * USD));
  await refreshCreditPoolEvidence(f.db, f.org.id, r.poolId, { ...r.evidence, observedRemainingNanoUsd: 90 * USD }, NOW);
  await expect(markCreditAttemptDispatched(f.db, f.org.id, a.attemptId, { ...c, now: NOW })).rejects.toMatchObject({
    reason: "budget_exhausted",
  });
  expect((await recoverCreditReservations(f.db, f.org.id))[0]?.state).toBe("held");
});

test("requests need a full two-minute evidence/grant deadline and cannot dispatch at expiry", async () => {
  f = await setup();
  const r = await route();
  const c = await claim();
  const nearlyExpired = () => new Date("2026-11-20T12:59:00Z");
  expect(await qualifyCreditRoute(f.db, { orgId: f.org.id, need, now: nearlyExpired })).toMatchObject({
    ok: false,
    reason: "stale_evidence",
  });
  await expect(admitCreditCall(f.db, { ...admission(r, c), now: nearlyExpired })).rejects.toMatchObject({
    reason: "stale_evidence",
  });
});

test("qualifier uses only explicitly approved reserve after automatic budget is insufficient", async () => {
  f = await setup();
  const r = await route({ grantAmountNanoUsd: 100 * USD, observedRemainingNanoUsd: 100 * USD });
  const costlyNeed = { ...need, amountNanoUsd: 30 * USD };
  expect(await qualifyCreditRoute(f.db, { orgId: f.org.id, need: costlyNeed, now: NOW })).toMatchObject({
    ok: false,
    reason: "spend_approval_required",
  });
  const approvalId = await approveCreditReserve(
    f.db,
    f.org.id,
    r.poolId,
    f.owner.id,
    {
      cycleId: r.cycleId,
      amountNanoUsd: 40 * USD,
      validUntil: new Date("2026-11-20T12:30Z"),
      decisionKey: "reserve-routing",
      evidenceRef: "owner-approved-reserve",
    },
    NOW,
  );
  expect(await qualifyCreditRoute(f.db, { orgId: f.org.id, need: costlyNeed, now: NOW })).toMatchObject({
    ok: true,
    proof: { bucket: "emergency", approvalId },
  });
  expect(await qualifyCreditRoute(f.db, { orgId: f.org.id, need, now: NOW })).toMatchObject({
    ok: true,
    proof: { bucket: "automatic" },
  });
  await f.db
    .update(schema.creditReserveApprovals)
    .set({ revokedAt: NOW() })
    .where(eq(schema.creditReserveApprovals.id, approvalId));
  expect(await qualifyCreditRoute(f.db, { orgId: f.org.id, need: costlyNeed, now: NOW })).toMatchObject({
    ok: false,
    reason: "spend_approval_required",
  });
});

test("OpenAI proof is bound to the linked API organization and Responses route", async () => {
  f = await setup();
  const r = await route({ provider: "openai", product: "openai_pro_api" });
  expect(await qualifyCreditRoute(f.db, { orgId: f.org.id, need, now: NOW })).toMatchObject({
    ok: true,
    proof: { provider: "openai", product: "openai_pro_api", routeKind: "openai_responses" },
  });
  await expect(
    registerCreditRoute(
      f.db,
      f.org.id,
      {
        poolId: r.poolId,
        credentialId: r.credentialId,
        model: r.model,
        pricingEvidence: r.pricingEvidence,
        supportsTools: true,
        maxPromptBytes: 10000,
        routeKind: "claude_agent_sdk",
        accountEvidenceRef: "wrong-product",
      },
      NOW,
    ),
  ).rejects.toMatchObject({ reason: "account_mismatch" });
  await f.db
    .update(schema.providerCredentials)
    .set({ options: { organization: "different-org" } })
    .where(eq(schema.providerCredentials.id, r.credentialId));
  expect(await qualifyCreditRoute(f.db, { orgId: f.org.id, need, now: NOW })).toMatchObject({
    ok: false,
    reason: "credential_changed",
  });
});

const postgresTest = process.env.TEST_DATABASE_URL ? test : test.skip;
postgresTest(
  "separate PostgreSQL clients serialize spending and an independent restarted process retains unknown debits",
  async () => {
    f = await setup();
    const r = await route();
    const c = await claim();
    const c2 = await claim();
    const { createDatabase, sql } = await import("@agenteschat/db");
    const result = await f.db.execute(sql`select current_database() as name`);
    const name = (result as unknown as { name: string }[])[0]?.name;
    if (!name) throw new Error("missing isolated test database identity");
    const url = new URL(process.env.TEST_DATABASE_URL ?? "");
    url.pathname = `/${name}`;
    const left = createDatabase({ url: url.toString(), poolMax: 1 });
    const right = createDatabase({ url: url.toString(), poolMax: 1 });
    try {
      const outcomes = await Promise.allSettled([
        admitCreditCall(left.db, admission(r, c, 70 * USD)),
        admitCreditCall(right.db, admission(r, c2, 70 * USD)),
      ]);
      expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
      const fulfilled = outcomes.find(
        (o): o is PromiseFulfilledResult<Awaited<ReturnType<typeof admitCreditCall>>> => o.status === "fulfilled",
      );
      if (!fulfilled) throw new Error("no reserved test call");
      const winner = outcomes[0]?.status === "fulfilled" ? c : c2;
      const a = fulfilled.value;
      const copies = await Promise.all([
        admitCreditCall(left.db, admission(r, winner, 70 * USD)),
        admitCreditCall(right.db, admission(r, winner, 70 * USD)),
      ]);
      expect(copies.map((v) => v.attemptId)).toEqual([a.attemptId, a.attemptId]);
      const dispatch = await Promise.allSettled([
        markCreditAttemptDispatched(left.db, f.org.id, a.attemptId, { ...winner, now: NOW }),
        markCreditAttemptDispatched(right.db, f.org.id, a.attemptId, { ...winner, now: NOW }),
      ]);
      expect(dispatch.filter((o) => o.status === "fulfilled")).toHaveLength(1);
      await settleCreditAttempt(
        left.db,
        f.org.id,
        a.attemptId,
        { kind: "unknown", reason: "process ended after provider dispatch" },
        NOW,
      );
      await left.close();
      await right.close();
      const code = `import { createDatabase } from './packages/db/src/index.ts';
import { recoverCreditReservations, admitCreditCall } from './packages/engine/src/credit-ledger.ts';
const input=JSON.parse(process.env.CREDIT_RESTART_INPUT); const h=createDatabase({url:process.env.CREDIT_RESTART_URL,poolMax:1});
try { const holds=await recoverCreditReservations(h.db,input.orgId); let refusal='none'; try { await admitCreditCall(h.db,{...input,now:()=>new Date('2026-11-20T12:00Z')}); } catch(e) { refusal=e.reason??'error'; } console.log(JSON.stringify({holds:holds.map(x=>({state:x.state,amountNanoUsd:x.amountNanoUsd})),refusal})); } finally { await h.close(); }`;
      const subprocess = Bun.spawn([process.execPath, "-e", code], {
        cwd: new URL("../../../", import.meta.url).pathname,
        env: {
          ...process.env,
          CREDIT_RESTART_URL: url.toString(),
          CREDIT_RESTART_INPUT: JSON.stringify(admission(r, winner, 70 * USD)),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = await new Response(subprocess.stdout).text();
      const errors = await new Response(subprocess.stderr).text();
      expect(await subprocess.exited).toBe(0);
      expect(errors).toBe("");
      expect(JSON.parse(output)).toEqual({
        holds: [{ state: "unknown", amountNanoUsd: 70 * USD }],
        refusal: "reconciliation_required",
      });
      expect((await cycle(r.cycleId)).heldAutomaticNanoUsd).toBe(70 * USD);
    } finally {
      await left.close();
      await right.close();
    }
  },
  30_000,
);

test("capabilities and exact request shape are rechecked between reservation and dispatch", async () => {
  f = await setup();
  const r = await route();
  const c = await claim();
  const a = await admitCreditCall(f.db, admission(r, c));
  await expect(
    admitCreditCall(f.db, { ...admission(r, c), need: { ...need, promptBytes: 2000 } }),
  ).rejects.toMatchObject({ reason: "duplicate_attempt" });
  await f.db.update(schema.creditRoutes).set({ supportsTools: false }).where(eq(schema.creditRoutes.id, r.routeId));
  await expect(markCreditAttemptDispatched(f.db, f.org.id, a.attemptId, { ...c, now: NOW })).rejects.toMatchObject({
    reason: "unsupported_capability",
  });
  expect((await recoverCreditReservations(f.db, f.org.id))[0]?.state).toBe("held");
});

test("expired pricing refuses qualification and removes dashboard spendability without erasing the grant", async () => {
  f = await setup();
  const r = await route();
  await f.db
    .update(schema.creditRoutes)
    .set({ pricingValidUntil: new Date("2026-11-20T12:01Z") })
    .where(eq(schema.creditRoutes.id, r.routeId));
  expect(await qualifyCreditRoute(f.db, { orgId: f.org.id, need, now: NOW })).toMatchObject({
    ok: false,
    reason: "pricing_expired",
  });
  expect((await creditLedgerSnapshot(f.db, f.org.id, NOW)).pools[0]).toMatchObject({
    automaticLimitNanoUsd: 120 * USD,
    automaticAvailableNanoUsd: 0,
    eligibleRouteCount: 0,
    pricingStatus: "expired",
  });
  await expect(admitCreditCall(f.db, admission(r, await claim()))).rejects.toMatchObject({ reason: "pricing_expired" });
});

test("tariff evidence cannot change between reservation and dispatch, and the original snapshot remains durable", async () => {
  f = await setup();
  const r = await route();
  const c = await claim();
  const a = await admitCreditCall(f.db, admission(r, c));
  expect(a.pricingSnapshot.profileHash).toBe(r.pricingProfileHash);
  expect(a.cacheTtl).toBe("default");
  await f.db
    .update(schema.creditRoutes)
    .set({ pricingProfileHash: `sha256:${"0".repeat(64)}` })
    .where(eq(schema.creditRoutes.id, r.routeId));
  await expect(markCreditAttemptDispatched(f.db, f.org.id, a.attemptId, { ...c, now: NOW })).rejects.toMatchObject({
    reason: "pricing_changed",
  });
  const [saved] = await f.db.select().from(schema.creditAttempts).where(eq(schema.creditAttempts.id, a.attemptId));
  expect(saved).toMatchObject({ state: "held", pricingProfileHash: r.pricingProfileHash, cacheTtl: "default" });
  expect(saved?.pricingSnapshot).toEqual(a.pricingSnapshot);
  if (!saved) throw new Error("saved tariff snapshot missing");
  expect(
    creditReceiptCost(
      saved.pricingSnapshot,
      { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      saved.cacheTtl,
    ),
  ).toBe(a.pricingSnapshot.prices.input);
});

test("renewing pricing requires exact fresh evidence and leaves the same route disabled until explicit enable", async () => {
  f = await setup();
  const r = await route();
  await expect(
    refreshCreditRoutePricingEvidence(
      f.db,
      f.org.id,
      r.routeId,
      { ...r.pricingEvidence, profileHash: `sha256:${"0".repeat(64)}` },
      NOW,
      f.owner.id,
    ),
  ).rejects.toMatchObject({ reason: "pricing_changed" });
  await refreshCreditRoutePricingEvidence(
    f.db,
    f.org.id,
    r.routeId,
    { ...r.pricingEvidence, evidenceRef: "renewed-pricing-proof", verifiedAt: NOW() },
    NOW,
    f.owner.id,
  );
  expect(await qualifyCreditRoute(f.db, { orgId: f.org.id, need, now: NOW })).toMatchObject({
    ok: false,
    reason: "disabled",
  });
  await setCreditRouteEnabled(f.db, f.org.id, r.routeId, true, NOW, f.owner.id);
  expect(await qualifyCreditRoute(f.db, { orgId: f.org.id, need, now: NOW })).toMatchObject({ ok: true });
  const audits = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.orgId, f.org.id));
  expect(
    audits.filter((a) => a.action === "credit.pricing_verified" || a.action === "credit.route_enabled"),
  ).toHaveLength(2);
  expect(audits.find((a) => a.action === "credit.pricing_verified")).toMatchObject({
    actorId: f.owner.id,
    details: { pricingEvidenceRef: "renewed-pricing-proof", enabled: false },
  });
  const member = await addMember(f.db, f.org.id, "member");
  await expect(setCreditRouteEnabled(f.db, f.org.id, r.routeId, true, NOW, member.id)).rejects.toMatchObject({
    reason: "spend_approval_required",
  });
});

test("dashboard reserve availability counts only usable owner approvals and retains protected limits", async () => {
  f = await setup();
  const r = await route({ grantAmountNanoUsd: 80 * USD, observedRemainingNanoUsd: 80 * USD });
  expect((await creditLedgerSnapshot(f.db, f.org.id, NOW)).pools[0]).toMatchObject({
    automaticAvailableNanoUsd: 0,
    approvedEmergencyAvailableNanoUsd: 0,
    activeReserveApprovalCount: 0,
  });
  await approveCreditReserve(
    f.db,
    f.org.id,
    r.poolId,
    f.owner.id,
    {
      cycleId: r.cycleId,
      amountNanoUsd: 30 * USD,
      validUntil: new Date("2026-11-20T12:30Z"),
      decisionKey: "dashboard-reserve",
      evidenceRef: "owner-reserve-proof",
    },
    NOW,
  );
  expect((await creditLedgerSnapshot(f.db, f.org.id, NOW)).pools[0]).toMatchObject({
    approvedEmergencyAvailableNanoUsd: 30 * USD,
    activeReserveApprovalCount: 1,
    safetyBufferNanoUsd: 20 * USD,
    eligibleRouteCount: 1,
    pricingStatus: "verified",
  });
  await f.db
    .update(schema.creditRoutes)
    .set({ pricingValidUntil: new Date("2026-11-20T12:01Z") })
    .where(eq(schema.creditRoutes.id, r.routeId));
  expect((await creditLedgerSnapshot(f.db, f.org.id, NOW)).pools[0]).toMatchObject({
    approvedEmergencyAvailableNanoUsd: 0,
    activeReserveApprovalCount: 1,
  });
});

test.each(["held", "unknown", "settled"] as const)(
  "an overdue workspace purge preserves %s credit evidence and retired secret protection",
  async (state) => {
    f = await setup();
    const r = await route();
    const c = await claim();
    const approvalId = await approveCreditReserve(
      f.db,
      f.org.id,
      r.poolId,
      f.owner.id,
      {
        cycleId: r.cycleId,
        amountNanoUsd: 10 * USD,
        validUntil: new Date("2026-11-20T12:30Z"),
        decisionKey: "purge-retention-fixture",
        evidenceRef: "synthetic-owner-decision",
      },
      NOW,
    );
    const a = await admitCreditCall(f.db, { ...admission(r, c, 10 * USD), bucket: "emergency", approvalId });
    if (state !== "held") {
      await markCreditAttemptDispatched(f.db, f.org.id, a.attemptId, { ...c, now: NOW });
      await settleCreditAttempt(
        f.db,
        f.org.id,
        a.attemptId,
        state === "unknown"
          ? { kind: "unknown", reason: "lost provider response before workspace deletion" }
          : { kind: "settled", actualNanoUsd: USD, providerRequestId: "synthetic-final-receipt" },
        NOW,
      );
    }
    // An actual account is a sentinel for releaseOrgAccounts: the financial hold must run before its mutation.
    const { machineId } = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, {
      name: "purge sentinel",
    });
    const accountId = crypto.randomUUID();
    await f.db.insert(schema.machineAccounts).values({
      id: accountId,
      orgId: f.org.id,
      machineId,
      kind: "claude_code",
      label: "synthetic retained account",
      status: "active",
      createdBy: f.owner.id,
    });
    // Local revocation is not evidence that an upstream key can no longer spend through another workspace.
    await f.db
      .update(schema.providerCredentials)
      .set({ revokedAt: NOW() })
      .where(eq(schema.providerCredentials.id, r.credentialId));
    await scheduleDeletion({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, "owner");
    await f.db
      .update(schema.organizations)
      .set({ deletionDueAt: new Date(0) })
      .where(eq(schema.organizations.id, f.org.id));
    const retained = async () =>
      Promise.all([
        f.db.select().from(schema.creditPools),
        f.db.select().from(schema.creditGrantCycles),
        f.db.select().from(schema.creditRoutes),
        f.db.select().from(schema.creditReserveApprovals),
        f.db.select().from(schema.creditWorkUnits),
        f.db.select().from(schema.creditAttempts),
      ]);
    const before = await retained();
    const warnings: string[] = [];
    const deps = {
      db: f.db,
      log: { info: () => {}, warn: (message: string) => warnings.push(message) },
      get connectors(): never {
        throw new Error("external connector cleanup must not start");
      },
      get mail(): never {
        throw new Error("external mail cleanup must not start");
      },
      get githubApp(): never {
        throw new Error("external GitHub cleanup must not start");
      },
    };
    expect(await purgeWorkspace(deps, f.org.id)).toBe(false);
    expect(await purgeWorkspace(deps, f.org.id, { finalAttempt: true })).toBe(false);
    expect(await retained()).toEqual(before);
    expect(
      await f.db
        .select({ id: schema.machineAccounts.id, status: schema.machineAccounts.status })
        .from(schema.machineAccounts)
        .where(eq(schema.machineAccounts.id, accountId)),
    ).toEqual([{ id: accountId, status: "active" }]);
    expect(before[5]?.[0]).toMatchObject({ id: a.attemptId, state });
    expect(before[2]?.[0]?.credentialFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(
      await f.db
        .select({ id: schema.organizations.id })
        .from(schema.organizations)
        .where(eq(schema.organizations.id, f.org.id)),
    ).toHaveLength(1);
    expect(warnings).toEqual([
      "workspace deletion waits for API credit reconciliation and upstream credential revocation",
      "workspace deletion waits for API credit reconciliation and upstream credential revocation",
    ]);
  },
);

test("workspace closing wins before pool registration, so purge cannot acquire a new credit liability", async () => {
  f = await setup();
  await scheduleDeletion({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, "owner");
  await expect(registerCreditPool(f.db, f.org.id, evidence(), NOW)).rejects.toMatchObject({ code: "org.deleting" });
  expect(await f.db.select().from(schema.creditPools)).toHaveLength(0);
  expect(await f.db.select().from(schema.creditGrantCycles)).toHaveLength(0);
  await f.db
    .update(schema.organizations)
    .set({ deletionDueAt: new Date(0) })
    .where(eq(schema.organizations.id, f.org.id));
  expect(await purgeWorkspace({ db: f.db }, f.org.id)).toBe(true);
  expect(
    await f.db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, f.org.id)),
  ).toHaveLength(0);
});

postgresTest(
  "real PostgreSQL serializes workspace close against a simultaneous grant pool registration",
  async () => {
    f = await setup();
    const { createDatabase, rowsOf, sql } = await import("@agenteschat/db");
    const { lockOrgMembers } = await import("../src/organizations");
    const [identity] = rowsOf<{ name: string }>(await f.db.execute(sql`select current_database() as name`));
    if (!identity?.name) throw new Error("isolated database identity missing");
    const url = new URL(process.env.TEST_DATABASE_URL ?? "");
    url.pathname = "/" + identity.name;
    const closer = createDatabase({ url: url.toString(), poolMax: 1 });
    const registrar = createDatabase({ url: url.toString(), poolMax: 1 });
    let locked!: () => void;
    let release!: () => void;
    const acquired = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let close: Promise<unknown> | undefined;
    let registration: Promise<{ ok: boolean; code?: string }> | undefined;
    try {
      close = closer.db.transaction(async (tx) => {
        await lockOrgMembers(tx, f.org.id);
        await tx
          .update(schema.organizations)
          .set({ deletionDueAt: new Date(0) })
          .where(eq(schema.organizations.id, f.org.id));
        locked();
        await released;
      });
      await acquired;
      let finished = false;
      registration = registerCreditPool(registrar.db, f.org.id, evidence(), NOW)
        .then(
          () => ({ ok: true }),
          (error: unknown) => ({ ok: false, code: (error as { code?: string }).code }),
        )
        .finally(() => {
          finished = true;
        });
      const deadline = Date.now() + 5000;
      let waiting = false;
      while (!waiting && Date.now() < deadline) {
        const [row] = rowsOf<{ waiting: boolean }>(
          await f.db.execute(sql`
          select exists (select 1 from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock'
              and query like '%pg_advisory_xact_lock%') as waiting`),
        );
        waiting = row?.waiting ?? false;
        if (!waiting) await Bun.sleep(10);
      }
      expect(waiting).toBe(true);
      expect(finished).toBe(false);
      expect(await f.db.select().from(schema.creditPools)).toHaveLength(0);
      release();
      await close;
      expect(await registration).toEqual({ ok: false, code: "org.deleting" });
      expect(await f.db.select().from(schema.creditPools)).toHaveLength(0);
      expect(await f.db.select().from(schema.creditGrantCycles)).toHaveLength(0);
      expect(await purgeWorkspace({ db: f.db }, f.org.id)).toBe(true);
    } finally {
      release();
      await Promise.allSettled([close, registration].filter(Boolean));
      await closer.close();
      await registrar.close();
    }
  },
  30_000,
);

for (const provider of ["anthropic", "openai"] as const) {
  test(`${provider}: a weaker first route cannot take work requiring the stronger qualified model`, async () => {
    f = await setup();
    const weakModel = provider === "anthropic" ? "claude-haiku-5-5" : "gpt-6-luna";
    const strongModel = provider === "anthropic" ? "claude-opus-5-5" : "gpt-6.1-sol";
    const minimumTier = provider === "anthropic" ? ("large" as const) : ("medium" as const);
    const r = await route(
      {
        provider,
        product: provider === "anthropic" ? "claude_ultra_api" : "openai_pro_api",
      },
      true,
      weakModel,
    );
    const weakId = "00000000-0000-4000-8000-000000000001";
    await f.db.update(schema.creditRoutes).set({ id: weakId }).where(eq(schema.creditRoutes.id, r.routeId));
    const created = await registerCreditRoute(
      f.db,
      f.org.id,
      {
        poolId: r.poolId,
        credentialId: r.credentialId,
        model: strongModel,
        pricingEvidence: { ...r.pricingEvidence, profileHash: creditPricingProfile(strongModel).profileHash },
        supportsTools: true,
        maxPromptBytes: 100_000,
        routeKind: provider === "anthropic" ? "anthropic_messages" : "openai_responses",
        accountEvidenceRef: "stronger-model-fixture",
        capabilities: ["text", "client_tools"],
      },
      NOW,
    );
    const strongId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    await f.db.update(schema.creditRoutes).set({ id: strongId }).where(eq(schema.creditRoutes.id, created));
    await setCreditRouteEnabled(f.db, f.org.id, strongId, true, NOW);
    const selected = await qualifyCreditRoute(f.db, { orgId: f.org.id, need: { ...need, minimumTier }, now: NOW });
    expect(selected).toMatchObject({ ok: true, proof: { routeId: strongId, model: strongModel } });
    expect(await f.db.select().from(schema.creditAttempts)).toHaveLength(0);
    await setCreditRouteEnabled(f.db, f.org.id, strongId, false, NOW);
    expect(await qualifyCreditRoute(f.db, { orgId: f.org.id, need: { ...need, minimumTier }, now: NOW })).toEqual({
      ok: false,
      reason: "unsupported_capability",
    });
    expect((await cycle(r.cycleId)).heldAutomaticNanoUsd).toBe(0);
  });

  test(`${provider}: missing or newly insufficient quality cannot create a reservation`, async () => {
    f = await setup();
    const r = await route({ provider, product: provider === "anthropic" ? "claude_ultra_api" : "openai_pro_api" });
    const c = await claim(r.routeId);
    for (const incomplete of [
      { ...need, minimumTier: undefined },
      { ...need, effort: undefined },
      { ...need, capabilities: undefined },
    ]) {
      expect(await qualifyCreditRoute(f.db, { orgId: f.org.id, need: incomplete, now: NOW })).toEqual({
        ok: false,
        reason: "unsupported_capability",
      });
      await expect(admitCreditCall(f.db, { ...admission(r, c), need: incomplete })).rejects.toMatchObject({
        reason: "unsupported_capability",
      });
    }
    const info = MODEL_CATALOG[r.model]!;
    const before = info.tier;
    try {
      info.tier = "small";
      expect(await qualifyCreditRoute(f.db, { orgId: f.org.id, need, now: NOW })).toEqual({
        ok: false,
        reason: "unsupported_capability",
      });
      await expect(admitCreditCall(f.db, admission(r, c))).rejects.toMatchObject({ reason: "unsupported_capability" });
    } finally {
      info.tier = before;
    }
    expect(await f.db.select().from(schema.creditAttempts)).toHaveLength(0);
    expect((await cycle(r.cycleId)).heldAutomaticNanoUsd).toBe(0);
  });

  test(`${provider}: catalog quality is checked again after reservation and before dispatch`, async () => {
    f = await setup();
    const r = await route({ provider, product: provider === "anthropic" ? "claude_ultra_api" : "openai_pro_api" });
    const c = await claim(r.routeId);
    const a = await admitCreditCall(f.db, admission(r, c));
    const info = MODEL_CATALOG[r.model]!;
    const before = info.tier;
    try {
      info.tier = undefined;
      await expect(markCreditAttemptDispatched(f.db, f.org.id, a.attemptId, { ...c, now: NOW })).rejects.toMatchObject({
        reason: "unsupported_capability",
      });
    } finally {
      info.tier = before;
    }
    const [attempt] = await f.db.select().from(schema.creditAttempts).where(eq(schema.creditAttempts.id, a.attemptId));
    expect(attempt).toMatchObject({
      state: "held",
      reservationNeed: { ...need, capabilities: [...need.capabilities].sort() },
    });
    expect(attempt?.dispatchedAt).toBeNull();
    expect((await cycle(r.cycleId)).heldAutomaticNanoUsd).toBe(USD);
  });
}

test("the native task requirement cannot be weakened by a caller or changed on an existing attempt", async () => {
  f = await setup();
  const r = await route();
  const c = await claim(r.routeId);
  await expect(
    admitCreditCall(f.db, { ...admission(r, c), need: { ...need, minimumTier: "small" } }),
  ).rejects.toMatchObject({ reason: "unsupported_capability" });
  const a = await admitCreditCall(f.db, admission(r, c));
  await f.db
    .update(schema.agentRuns)
    .set({
      transcript: { creditRoute: { routeId: r.routeId, ...need, minimumTier: "small" } },
    })
    .where(eq(schema.agentRuns.id, c.runId));
  await expect(
    admitCreditCall(f.db, { ...admission(r, c), need: { ...need, minimumTier: "small" } }),
  ).rejects.toMatchObject({ reason: "duplicate_attempt" });
  await expect(markCreditAttemptDispatched(f.db, f.org.id, a.attemptId, { ...c, now: NOW })).rejects.toMatchObject({
    reason: "unsupported_capability",
  });
  expect((await cycle(r.cycleId)).heldAutomaticNanoUsd).toBe(USD);
  expect((await f.db.select().from(schema.creditAttempts))[0]?.state).toBe("held");
});

test("a changed durable effort or capability requirement holds the reservation before dispatch", async () => {
  for (const patch of [{ effort: "low" }, { capabilities: ["text"] }]) {
    f = await setup();
    const r = await route();
    const c = await claim(r.routeId);
    const a = await admitCreditCall(f.db, admission(r, c));
    await f.db
      .update(schema.agentRuns)
      .set({
        transcript: { creditRoute: { routeId: r.routeId, ...need, ...patch } },
      })
      .where(eq(schema.agentRuns.id, c.runId));
    await expect(markCreditAttemptDispatched(f.db, f.org.id, a.attemptId, { ...c, now: NOW })).rejects.toMatchObject({
      reason: "unsupported_capability",
    });
    expect((await f.db.select().from(schema.creditAttempts))[0]?.state).toBe("held");
    expect((await cycle(r.cycleId)).heldAutomaticNanoUsd).toBe(USD);
    await f.close();
    f = undefined as unknown as Fixture;
  }
});

test("legacy reservations without a quality requirement retain their liability and cannot dispatch", async () => {
  f = await setup();
  const r = await route();
  const c = await claim(r.routeId);
  const a = await admitCreditCall(f.db, admission(r, c));
  await f.db
    .update(schema.creditAttempts)
    .set({
      reservationNeed: { tools: need.tools, promptBytes: need.promptBytes, capabilities: [...need.capabilities] },
    })
    .where(eq(schema.creditAttempts.id, a.attemptId));
  await expect(markCreditAttemptDispatched(f.db, f.org.id, a.attemptId, { ...c, now: NOW })).rejects.toMatchObject({
    reason: "unsupported_capability",
  });
  expect((await f.db.select().from(schema.creditAttempts))[0]?.state).toBe("held");
  expect((await cycle(r.cycleId)).heldAutomaticNanoUsd).toBe(USD);
});
