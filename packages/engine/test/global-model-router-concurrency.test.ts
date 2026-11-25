import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { type ModelOffer, parseCloudflareCatalogOffers, parseOpenRouterCatalogOffers } from "@agenteschat/providers";
import {
  configureGlobalRouterPolicy,
  configureOpenRouterFallback,
  createCredential,
  GlobalRouterRefusal,
  readGlobalModelRouterStatus,
  reconcileGlobalRouterAttempt,
  reserveGlobalRouterAttempt,
  settleGlobalRouterAttempt,
  syncGlobalRouterOffers,
  upsertGlobalRouterAccount,
} from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

const synthKey = (parts: string[]) => parts.join("-");
const okFetch = (async () => Response.json({ data: { is_management_key: false } })) as unknown as typeof fetch;

function makeConcurrencyOffers(observedAt: string, ttlMs = 45 * 86_400_000): ModelOffer[] {
  const orOffers = parseOpenRouterCatalogOffers(
    {
      data: [
        {
          id: "deepseek/deepseek-v4.1-flash-1017",
          name: "DeepSeek V4.1 Flash",
          context_length: 163840,
          pricing: { prompt: "0.00000003", completion: "0.0000002", request: "0" },
          supported_parameters: ["tools", "structured_outputs"],
        },
        {
          id: "nvidia/nemotron-3.5-super-vl:free",
          name: "Nemotron 3.5 Super VL Free",
          context_length: 131072,
          pricing: { prompt: "0", completion: "0", request: "0" },
          supported_parameters: ["tools", "structured_outputs"],
        },
      ],
    },
    observedAt,
    ttlMs,
  );
  const cfOffers = parseCloudflareCatalogOffers(
    {
      result: [
        {
          name: "@cf/openai/gpt-oss-120b",
          task: { name: "Text Generation" },
          properties: [{ property_id: "function_calling", value: "true" }],
        },
      ],
    },
    "0123456789abcdef0123456789abcdef",
    "free_only",
    observedAt,
    ttlMs,
  );
  return [...orOffers, ...cfOffers];
}

test("100 concurrent agents racing on shared US$50 OpenRouter cap (with existing fallback spend) never overrun by 1 nanoUSD", async () => {
  f = await setup();
  const legacyKey = await createCredential(
    f.db,
    f.keyWrapper,
    f.owner.id,
    f.org.id,
    { provider: "openrouter", label: "Legacy OR key", apiKey: synthKey(["sk", "or", "v1", "1".repeat(64)]) },
    { fetch: okFetch },
  );
  const routerKey = await createCredential(
    f.db,
    f.keyWrapper,
    f.owner.id,
    f.org.id,
    { provider: "openrouter", label: "Global Router OR key", apiKey: synthKey(["sk", "or", "v1", "2".repeat(64)]) },
    { fetch: okFetch },
  );

  // Record $10.00 already spent in legacy openrouter_fallback_months so remaining shared OpenRouter ceiling is $40.00.
  await configureOpenRouterFallback(f.db, f.org.id, f.owner.id, {
    enabled: true,
    credentialId: legacyKey.id,
    policy: {
      allowedModels: ["openai/gpt-6-luna"],
      costTier: "medium",
      monthlyCapUsd: 50,
      maxPromptUsdPerMillion: 5,
      maxCompletionUsdPerMillion: 25,
    },
  });
  const fixedNow = () => new Date("2026-11-24T12:00:00.000Z");
  await f.db.insert(schema.openRouterFallbackMonths).values({
    orgId: f.org.id,
    period: "2026-11",
    spentNanoUsd: 10_000_000_000,
    heldNanoUsd: 0,
  });

  await configureGlobalRouterPolicy(f.db, f.org.id, f.owner.id, { enabled: true }, fixedNow);
  await syncGlobalRouterOffers(f.db, f.org.id, f.owner.id, makeConcurrencyOffers(fixedNow().toISOString()));

  const orAccount = await upsertGlobalRouterAccount(
    f.db,
    f.org.id,
    f.owner.id,
    {
      provider: "openrouter",
      lane: "paid_low_cost",
      entitlement: "paid_capped",
      credentialId: routerKey.id,
      enabled: true,
      monthlyCapUsd: 50,
      allowedModels: ["deepseek/deepseek-v4.1-flash-1017"],
    },
    fixedNow,
  );

  // Launch 100 concurrent simulated agents each reserving $1.00 (1_000_000_000 nanoUSD).
  // Only 40 can fit under the remaining $40.00 ($50 shared ceiling - $10 legacy spend).
  const outcomes = await Promise.allSettled(
    Array.from({ length: 100 }, (_, idx) =>
      reserveGlobalRouterAttempt(f.db, {
        orgId: f.org.id,
        accountId: orAccount!.id,
        runId: crypto.randomUUID(),
        agentId: crypto.randomUUID(),
        turn: 1,
        idempotencyKey: `race-50cap-${idx}`,
        requestedModel: "deepseek/deepseek-v4.1-flash-1017",
        boundNanoUsd: 1_000_000_000,
        estimatedPromptTokens: 1000,
        maxOutputTokens: 512,
        now: fixedNow,
      }),
    ),
  );

  const admitted = outcomes.filter(
    (o): o is PromiseFulfilledResult<Awaited<ReturnType<typeof reserveGlobalRouterAttempt>>> =>
      o.status === "fulfilled",
  );
  const rejected = outcomes.filter((o): o is PromiseRejectedResult => o.status === "rejected");

  expect(admitted.length).toBe(40);
  expect(rejected.length).toBe(60);
  for (const r of rejected) {
    expect(r.reason).toBeInstanceOf(GlobalRouterRefusal);
    expect((r.reason as GlobalRouterRefusal).reason).toBe("budget_exhausted");
  }

  // Settle all 40 admitted calls at $0.80 each ($32.00 total) and confirm exact ledger balance ($0 held, $32 spent).
  await Promise.all(
    admitted.map((a) =>
      settleGlobalRouterAttempt(
        f.db,
        f.org.id,
        a.value.attemptId,
        {
          kind: "settled",
          actualModel: "deepseek/deepseek-v4.1-flash-1017",
          actualNanoUsd: 800_000_000,
          inputTokens: 800,
          outputTokens: 300,
          latencyMs: 420,
          qualityVerified: true,
        },
        fixedNow(),
      ),
    ),
  );

  const status = await readGlobalModelRouterStatus(f.db, f.org.id, fixedNow());
  const acctStatus = status.accounts.find((a) => a.id === orAccount!.id);
  expect(acctStatus?.heldNanoUsd).toBe(0);
  expect(acctStatus?.spentNanoUsd).toBe(32_000_000_000);
  expect(10_000_000_000 + (acctStatus?.spentNanoUsd ?? 0)).toBeLessThanOrEqual(50_000_000_000);
}, 60_000);

test("100 concurrent agents racing on Cloudflare Workers AI 10,000 Neurons/day free cap never exceed 10,000 neurons", async () => {
  f = await setup();
  const cfKey = await createCredential(
    f.db,
    f.keyWrapper,
    f.owner.id,
    f.org.id,
    {
      provider: "cloudflare",
      label: "Workers AI Free",
      apiKey: `cfut_${"f".repeat(36)}`,
      workspaceId: "0123456789abcdef0123456789abcdef",
    },
    { fetch: okFetch },
  );

  const fixedNow = () => new Date("2026-11-24T14:00:00.000Z");
  await configureGlobalRouterPolicy(f.db, f.org.id, f.owner.id, { enabled: true }, fixedNow);
  await syncGlobalRouterOffers(f.db, f.org.id, f.owner.id, makeConcurrencyOffers(fixedNow().toISOString()));

  const cfAccount = await upsertGlobalRouterAccount(
    f.db,
    f.org.id,
    f.owner.id,
    {
      provider: "cloudflare",
      lane: "free_api",
      entitlement: "free_only",
      credentialId: cfKey.id,
      workspaceAccountRef: "0123456789abcdef0123456789abcdef",
      enabled: true,
      monthlyCapUsd: 0,
      dailyNeuronsLimit: 10_000,
      allowedModels: ["@cf/openai/gpt-oss-120b"],
    },
    fixedNow,
  );

  // 100 concurrent agents each reserving 250 neurons -> max 40 admitted (40 * 250 = 10,000), 60 refused.
  const outcomes = await Promise.allSettled(
    Array.from({ length: 100 }, (_, idx) =>
      reserveGlobalRouterAttempt(f.db, {
        orgId: f.org.id,
        accountId: cfAccount!.id,
        runId: crypto.randomUUID(),
        agentId: crypto.randomUUID(),
        turn: 1,
        idempotencyKey: `cf-race-${idx}`,
        requestedModel: "@cf/openai/gpt-oss-120b",
        boundNanoUsd: 0,
        reservedNeurons: 250,
        estimatedPromptTokens: 800,
        maxOutputTokens: 512,
        now: fixedNow,
      }),
    ),
  );

  const admitted = outcomes.filter((o) => o.status === "fulfilled");
  const rejected = outcomes.filter((o): o is PromiseRejectedResult => o.status === "rejected");

  expect(admitted.length).toBe(40);
  expect(rejected.length).toBe(60);
  for (const r of rejected) {
    expect((r.reason as GlobalRouterRefusal).reason).toBe("cloudflare_neurons_exhausted");
  }

  const [win] = await f.db
    .select()
    .from(schema.globalRouterWindows)
    .where(eq(schema.globalRouterWindows.accountId, cfAccount!.id));
  expect((win?.dayNeuronsUsed ?? 0) + (win?.dayNeuronsHeld ?? 0)).toBe(10_000);
  expect(win?.spentNanoUsd).toBe(0);
}, 60_000);

test("100 concurrent agents racing on OpenRouter :free respect 20 RPM and 50 RPD without overrun, and unresolved holds block monthly rollover", async () => {
  f = await setup();
  const freeOrKey = await createCredential(
    f.db,
    f.keyWrapper,
    f.owner.id,
    f.org.id,
    { provider: "openrouter", label: "OR Free Only", apiKey: synthKey(["sk", "or", "v1", "9".repeat(64)]) },
    { fetch: okFetch },
  );

  const minute1 = () => new Date("2026-11-24T15:01:00.000Z");
  await configureGlobalRouterPolicy(f.db, f.org.id, f.owner.id, { enabled: true }, minute1);
  await syncGlobalRouterOffers(f.db, f.org.id, f.owner.id, makeConcurrencyOffers(minute1().toISOString()));

  const freeAccount = await upsertGlobalRouterAccount(
    f.db,
    f.org.id,
    f.owner.id,
    {
      provider: "openrouter",
      lane: "free_api",
      entitlement: "free_only",
      credentialId: freeOrKey.id,
      enabled: true,
      monthlyCapUsd: 0,
      allowedModels: ["nvidia/nemotron-3.5-super-vl:free"],
    },
    minute1,
  );

  // Minute 1: 100 concurrent calls -> 20 RPM cap admits exactly 20!
  const wave1 = await Promise.allSettled(
    Array.from({ length: 100 }, (_, idx) =>
      reserveGlobalRouterAttempt(f.db, {
        orgId: f.org.id,
        accountId: freeAccount!.id,
        runId: crypto.randomUUID(),
        agentId: crypto.randomUUID(),
        turn: 1,
        idempotencyKey: `free-w1-${idx}`,
        requestedModel: "nvidia/nemotron-3.5-super-vl:free",
        boundNanoUsd: 0,
        estimatedPromptTokens: 400,
        maxOutputTokens: 256,
        now: minute1,
      }),
    ),
  );
  const w1Admitted = wave1.filter(
    (o): o is PromiseFulfilledResult<Awaited<ReturnType<typeof reserveGlobalRouterAttempt>>> =>
      o.status === "fulfilled",
  );
  expect(w1Admitted.length).toBe(20);

  // Settle 19 of them, leave 1 ambiguous (`unknown`) and verify monthly rollover into 2026-12 is blocked!
  await Promise.all(
    w1Admitted.slice(0, 19).map((a) =>
      settleGlobalRouterAttempt(
        f.db,
        f.org.id,
        a.value.attemptId,
        {
          kind: "settled",
          actualModel: "nvidia/nemotron-3.5-super-vl:free",
          actualNanoUsd: 0,
          inputTokens: 400,
          outputTokens: 120,
          latencyMs: 310,
          qualityVerified: true,
        },
        minute1(),
      ),
    ),
  );
  await expect(
    settleGlobalRouterAttempt(
      f.db,
      f.org.id,
      w1Admitted[19]!.value.attemptId,
      { kind: "unknown", reason: "dropped_connection" },
      minute1(),
    ),
  ).rejects.toMatchObject({ reason: "reconciliation_required" });

  const nextMonth = () => new Date("2026-12-01T00:05:00.000Z");
  await expect(
    reserveGlobalRouterAttempt(f.db, {
      orgId: f.org.id,
      accountId: freeAccount!.id,
      runId: crypto.randomUUID(),
      agentId: crypto.randomUUID(),
      turn: 1,
      idempotencyKey: "december-1",
      requestedModel: "nvidia/nemotron-3.5-super-vl:free",
      boundNanoUsd: 0,
      estimatedPromptTokens: 400,
      maxOutputTokens: 256,
      now: nextMonth,
    }),
  ).rejects.toMatchObject({ reason: "reconciliation_required" });

  // Reconcile the unknown attempt as proven_no_send -> December admission immediately succeeds!
  await reconcileGlobalRouterAttempt(
    f.db,
    f.org.id,
    f.owner.id,
    w1Admitted[19]!.value.attemptId,
    { kind: "proven_no_send", note: "No upstream execution recorded" },
    nextMonth(),
  );
  const decAdmitted = await reserveGlobalRouterAttempt(f.db, {
    orgId: f.org.id,
    accountId: freeAccount!.id,
    runId: crypto.randomUUID(),
    agentId: crypto.randomUUID(),
    turn: 1,
    idempotencyKey: "december-2",
    requestedModel: "nvidia/nemotron-3.5-super-vl:free",
    boundNanoUsd: 0,
    estimatedPromptTokens: 400,
    maxOutputTokens: 256,
    now: nextMonth,
  });
  expect(decAdmitted.reservedNanoUsd).toBe(0);
}, 60_000);
