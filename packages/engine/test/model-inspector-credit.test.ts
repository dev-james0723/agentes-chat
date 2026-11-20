import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  approveCreditReserve,
  registerCreditPool,
  registerCreditRoute,
  setCreditRouteEnabled,
} from "../src/credit-ledger";
import { creditPricingProfile } from "../src/credit-pricing";
import { createModelInspector, readModelInspectorCredits } from "../src/model-inspector";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
  f = undefined as unknown as Fixture;
});
const USD = 1e9;
const NOW = () => new Date("2026-11-20T12:00:00Z");
async function grant() {
  const poolId = await registerCreditPool(f.db, f.org.id, {
    provider: "anthropic",
    upstreamAccount: "private-billing-account",
    product: "claude_ultra_api",
    cycleKey: "private-cycle-key",
    grantId: "private-grant-id",
    grantStart: new Date("2026-11-13T00:00:00Z"),
    grantEnd: new Date("2026-12-13T00:00:00Z"),
    eligibleSince: new Date("2026-10-01T00:00:00Z"),
    activatedAt: new Date("2026-11-13T00:00:00Z"),
    enforcement: "prepaid_grant_only",
    externalSpendCoverage: "exclusive",
    externalSpendBoundNanoUsd: 0,
    evidenceRef: "private-billing-document",
    verifiedByUserId: f.owner.id,
    verifiedAt: new Date("2026-11-20T11:59:00Z"),
    validUntil: new Date("2026-11-20T13:00:00Z"),
    grantAmountNanoUsd: 200 * USD,
    observedRemainingNanoUsd: 200 * USD,
  });
  const [pool] = await f.db.select().from(schema.creditPools).where(eq(schema.creditPools.id, poolId));
  if (!pool?.currentCycleId) throw new Error("missing fixture pool");
  await f.db.update(schema.creditPools).set({ enabled: true }).where(eq(schema.creditPools.id, poolId));
  await f.db
    .update(schema.creditGrantCycles)
    .set({ spentAutomaticNanoUsd: 12 * USD, heldAutomaticNanoUsd: 3 * USD })
    .where(eq(schema.creditGrantCycles.id, pool.currentCycleId));
  return { poolId, cycleId: pool.currentCycleId };
}
async function attemptRows(poolId: string, cycleId: string) {
  const [route] = await f.db
    .insert(schema.creditRoutes)
    .values({
      orgId: f.org.id,
      poolId,
      credentialId: crypto.randomUUID(),
      credentialVersion: "private-key-version",
      credentialFingerprint: "a".repeat(64),
      pricingEvidenceRef: "private-standard-price-sheet",
      pricingVerifiedAt: new Date(NOW().getTime() - 60_000),
      pricingValidUntil: new Date(NOW().getTime() + 3_600_000),
      pricingProfileHash: creditPricingProfile("claude-sonnet-5-5").profileHash,
      model: "claude-sonnet-5-5",
      routeKind: "anthropic_messages",
      accountEvidenceRef: "private-account-binding",
      maxPromptBytes: 100000,
      supportsTools: true,
    })
    .returning();
  if (!route) throw new Error("missing route");
  for (const [n, state, unit] of [
    [1, "unknown", "uncertain-unit"],
    [2, "settled", "uncertain-unit"],
    [3, "settled", "settled-unit"],
  ] as const) {
    await f.db.insert(schema.creditAttempts).values({
      orgId: f.org.id,
      poolId,
      cycleId,
      routeId: route.id,
      runId: crypto.randomUUID(),
      workUnitKey: unit,
      attemptKey: `attempt-${n}`,
      ownerEpoch: 1,
      ownerJobId: crypto.randomUUID(),
      ownerWorkerId: "private-worker",
      bucket: "automatic",
      amountNanoUsd: 3 * USD,
      reservationNeed: { tools: true, promptBytes: 100 },
      pricingSnapshot: creditPricingProfile("claude-sonnet-5-5"),
      pricingProfileHash: creditPricingProfile("claude-sonnet-5-5").profileHash,
      cacheTtl: "default",
      actualNanoUsd: state === "settled" ? USD : null,
      state,
      providerRequestId: "private-provider-request",
      settledAt: state === "settled" ? NOW() : null,
    });
  }
}

test("unregistered grants are disabled or unverified with zero automatic allowance", async () => {
  f = await setup();
  const disabled = await readModelInspectorCredits(f.db, f.org.id, false, NOW);
  expect(disabled.state).toBe("disabled");
  expect(disabled.pools.map((p) => [p.provider, p.evidenceStatus, p.automaticAvailableNanoUsd])).toEqual([
    ["openai", "unverified", 0],
    ["anthropic", "unverified", 0],
  ]);
  expect((await readModelInspectorCredits(f.db, f.org.id, true, NOW)).state).toBe("unverified");
});

test("disabling fallback preserves actual spend, reserved liabilities and sanitized history", async () => {
  f = await setup();
  const r = await grant();
  await attemptRows(r.poolId, r.cycleId);
  const status = await readModelInspectorCredits(f.db, f.org.id, false, NOW);
  const claude = status.pools.find((p) => p.provider === "anthropic");
  if (!claude) throw new Error("missing fixture provider");
  expect(status.state).toBe("disabled");
  expect(claude).toMatchObject({
    spentNanoUsd: 12 * USD,
    heldNanoUsd: 3 * USD,
    automaticAvailableNanoUsd: 0,
    emergencyLimitNanoUsd: 60 * USD,
    safetyBufferNanoUsd: 20 * USD,
  });
  expect(status.unresolvedCount).toBe(1);
  expect(claude.forecast).toMatchObject({ sampleCount: 1, p95NanoUsd: USD, meanNanoUsd: USD, uncertainty: "high" });
  const serialized = JSON.stringify(status);
  for (const secret of [
    "private-billing-account",
    "private-grant-id",
    "private-cycle-key",
    "private-billing-document",
    "private-key-version",
    "private-standard-price-sheet",
    "private-account-binding",
    "private-worker",
    "private-provider-request",
    "uncertain-unit",
  ])
    expect(serialized).not.toContain(secret);
});

test("a cached fleet report and a recreated inspector both read changed durable obligations", async () => {
  f = await setup();
  const r = await grant();
  let providerCalls = 0;
  const deps = {
    db: f.db,
    pubsub: f.pubsub,
    orgIds: [f.org.id],
    creditFallbackEnabled: true,
    now: NOW,
    models: { claude_code: "sonnet", codex: "gpt-6.1-sol", grok: "grok-4.7" },
    machines: {
      status: async () => null,
      call: async () => {
        providerCalls++;
        throw new Error("no provider calls");
      },
    },
  };
  const inspector = createModelInspector(deps as Parameters<typeof createModelInspector>[0]);
  await inspector.sweep();
  const first = await inspector.report(f.org.id);
  expect(first?.mode).toBe("sweep");
  await f.db
    .update(schema.creditGrantCycles)
    .set({ heldAutomaticNanoUsd: 7 * USD })
    .where(eq(schema.creditGrantCycles.id, r.cycleId));
  const cached = await inspector.report(f.org.id);
  const restarted = await createModelInspector(deps as Parameters<typeof createModelInspector>[0]).report(f.org.id);
  expect(cached?.credits?.pools.find((p) => p.provider === "anthropic")?.heldNanoUsd).toBe(7 * USD);
  expect(restarted?.credits?.pools.find((p) => p.provider === "anthropic")?.heldNanoUsd).toBe(7 * USD);
  expect(restarted?.mode).toBe("snapshot");
  expect(providerCalls).toBe(0);
  expect(cached?.agents.map((a) => a.id)).toEqual(first?.agents.map((a) => a.id));
});

test("expired evidence prevents displayed available allowance without erasing costs", async () => {
  f = await setup();
  await grant();
  const status = await readModelInspectorCredits(f.db, f.org.id, true, () => new Date("2026-11-20T14:00:00Z"));
  const claude = status.pools.find((p) => p.provider === "anthropic");
  if (!claude) throw new Error("missing fixture provider");
  expect(claude.evidenceStatus).toBe("stale");
  expect(claude.automaticAvailableNanoUsd).toBe(0);
  expect(claude.spentNanoUsd).toBe(12 * USD);
});

test("missing migrations remain unknown while real database failures propagate", async () => {
  const brokenDb = (error: unknown) =>
    ({
      select: () => ({
        from: () => {
          throw error;
        },
      }),
    }) as unknown as Parameters<typeof readModelInspectorCredits>[0];
  const absent = await readModelInspectorCredits(
    brokenDb({ cause: { code: "42P01" } }),
    crypto.randomUUID(),
    true,
    NOW,
  );
  expect(absent.state).toBe("unavailable");
  expect(
    absent.pools.every(
      (p) =>
        p.evidenceStatus === "unavailable" &&
        p.spentNanoUsd === null &&
        p.heldNanoUsd === null &&
        p.automaticAvailableNanoUsd === 0,
    ),
  ).toBe(true);
  const error = Object.assign(new Error("database unavailable"), { code: "08006" });
  await expect(readModelInspectorCredits(brokenDb(error), crypto.randomUUID(), false, NOW)).rejects.toThrow(error);
});

test("current owner-approved reserve is available after automatic exhaustion but stops when pricing expires", async () => {
  f = await setup();
  const r = await grant();
  await f.db
    .update(schema.creditGrantCycles)
    .set({ spentAutomaticNanoUsd: 120 * USD, heldAutomaticNanoUsd: 0 })
    .where(eq(schema.creditGrantCycles.id, r.cycleId));
  const routeId = await registerCreditRoute(
    f.db,
    f.org.id,
    {
      poolId: r.poolId,
      credentialId: f.credential.id,
      model: "claude-sonnet-5-5",
      routeKind: "anthropic_messages",
      supportsTools: true,
      maxPromptBytes: 100_000,
      accountEvidenceRef: "private-approved-account-proof",
      capabilities: ["text", "client_tools"],
      pricingEvidence: {
        evidenceRef: "private-approved-price-proof",
        verifiedAt: new Date(NOW().getTime() - 60_000),
        validUntil: new Date(NOW().getTime() + 3_600_000),
        profileHash: creditPricingProfile("claude-sonnet-5-5").profileHash,
      },
    },
    NOW,
  );
  await setCreditRouteEnabled(f.db, f.org.id, routeId, true, NOW);
  await approveCreditReserve(
    f.db,
    f.org.id,
    r.poolId,
    f.owner.id,
    {
      cycleId: r.cycleId,
      amountNanoUsd: 25 * USD,
      validUntil: new Date(NOW().getTime() + 3_000_000),
      decisionKey: "private-reserve-decision",
      evidenceRef: "private-owner-approval",
    },
    NOW,
  );
  const current = await readModelInspectorCredits(f.db, f.org.id, true, NOW);
  const pool = current.pools.find((p) => p.provider === "anthropic");
  expect(current.state).toBe("available");
  expect(pool).toMatchObject({
    automaticAvailableNanoUsd: 0,
    approvedEmergencyAvailableNanoUsd: 25 * USD,
    activeReserveApprovalCount: 1,
    eligibleRouteCount: 1,
    pricingStatus: "verified",
  });
  await f.db
    .update(schema.creditRoutes)
    .set({ pricingValidUntil: new Date(NOW().getTime() - 15_000) })
    .where(eq(schema.creditRoutes.id, routeId));
  const expired = await readModelInspectorCredits(f.db, f.org.id, true, NOW);
  expect(expired.state).toBe("blocked");
  expect(expired.pools.find((p) => p.provider === "anthropic")).toMatchObject({
    automaticAvailableNanoUsd: 0,
    approvedEmergencyAvailableNanoUsd: 0,
    activeReserveApprovalCount: 1,
    pricingStatus: "expired",
    spentNanoUsd: 120 * USD,
  });
  for (const secret of ["private-approved-account-proof", "private-approved-price-proof", "private-owner-approval"])
    expect(JSON.stringify(expired)).not.toContain(secret);
});
