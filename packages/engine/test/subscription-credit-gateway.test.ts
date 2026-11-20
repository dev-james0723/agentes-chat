import { afterEach, expect, test } from "bun:test";
import { noPlatformCredentials } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import { customModelId, MODEL_CATALOG, type ModelProvider, ProviderError } from "@agenteschat/providers";
import { createFakeProvider } from "@agenteschat/providers/testing";
import { createAgent } from "../src/agents";
import { createCredential, rotateCredential } from "../src/credentials";
import {
  CREDIT_USD,
  creditLedgerSnapshot,
  qualifyCreditRoute,
  registerCreditPool,
  registerCreditRoute,
  setCreditRouteEnabled,
} from "../src/credit-ledger";
import { creditPricingProfile, creditReceiptCost } from "../src/credit-pricing";
import { creditOutcomeOf } from "../src/credit-route";
import { createModelGateway, type GatewayCall } from "../src/gateway";
import { createOrganization } from "../src/organizations";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
  f = undefined as unknown as Fixture;
});
const MODEL = "claude-sonnet-5-5";
const KEY = "sk-ant-synthetic-credit-gateway";
const NOW = () => new Date("2026-11-20T12:00:00Z");

async function route() {
  const credential = await createCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, {
    provider: "anthropic",
    label: "synthetic grant route",
    apiKey: KEY,
  });
  const poolId = await registerCreditPool(
    f.db,
    f.org.id,
    {
      provider: "anthropic",
      upstreamAccount: "org-gateway-fixture",
      product: "claude_ultra_api",
      cycleKey: "cycle-gateway-20261113",
      grantId: "grant-gateway-fixture",
      grantStart: new Date("2026-11-13T00:00:00Z"),
      grantEnd: new Date("2026-12-13T00:00:00Z"),
      eligibleSince: new Date("2026-10-01T00:00:00Z"),
      activatedAt: new Date("2026-11-13T00:00:00Z"),
      enforcement: "prepaid_grant_only",
      externalSpendCoverage: "exclusive",
      externalSpendBoundNanoUsd: 0,
      evidenceRef: "synthetic-provider-billing",
      verifiedByUserId: f.owner.id,
      verifiedAt: new Date("2026-11-20T11:59:00Z"),
      validUntil: new Date("2026-11-20T13:00:00Z"),
      grantAmountNanoUsd: 200 * CREDIT_USD,
      observedRemainingNanoUsd: 200 * CREDIT_USD,
    },
    NOW,
  );
  const routeId = await registerCreditRoute(
    f.db,
    f.org.id,
    {
      poolId,
      credentialId: credential.id,
      model: MODEL,
      pricingEvidence: {
        evidenceRef: "official-pricing-fixture",
        verifiedAt: new Date("2026-11-20T11:59Z"),
        validUntil: new Date("2026-11-20T13:00Z"),
        profileHash: creditPricingProfile(MODEL).profileHash,
      },
      supportsTools: true,
      maxPromptBytes: 100_000,
      routeKind: "anthropic_messages",
      accountEvidenceRef: "synthetic-organization-binding",
      capabilities: ["text", "client_tools"],
    },
    NOW,
  );
  await setCreditRouteEnabled(f.db, f.org.id, routeId, true, NOW);
  const q = await qualifyCreditRoute(f.db, { orgId: f.org.id, need: { tools: false, promptBytes: 10 }, now: NOW });
  if (!q.ok) throw new Error(`fixture route refused: ${q.reason}`);
  return {
    credential,
    poolId,
    routeId,
    proof: q.proof,
    agent: { ...f.agent, model: MODEL, credentialId: credential.id },
  };
}
async function claim() {
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
  });
  await f.db.insert(schema.outbox).values({
    id: ownerJobId,
    orgId: f.org.id,
    kind: "agent_run.execute",
    payload: { runId },
    status: "processing",
    lockedBy: "gateway-fixture-worker",
    lockedUntil: new Date("2026-11-20T12:05:00Z"),
    attempts: 1,
  });
  return {
    runId,
    ownerJobId,
    ownerWorkerId: "gateway-fixture-worker",
    ownerEpoch: 1,
    workUnitKey: `${runId}:turn:0`,
    attemptKey: `${runId}:turn:0:attempt:1`,
  };
}
type Route = Awaited<ReturnType<typeof route>>;
type Claim = Awaited<ReturnType<typeof claim>>;
function callOf(r: Route, c: Claim, over: Partial<GatewayCall> = {}): GatewayCall {
  return {
    orgId: f.org.id,
    agentId: f.agent.id,
    agent: r.agent,
    runId: c.runId,
    system: "sys",
    messages: [{ role: "user", content: "hello" }],
    maxTokens: 100,
    credit: { ...r.proof, ...c },
    onDelta: () => {},
    ...over,
  };
}
function gatewayOf(provider: ModelProvider, creditRoutes = true, sharedBudgetRequired = false) {
  return createModelGateway({
    db: f.db,
    keyWrappers: [f.keyWrapper],
    platformCredentials: noPlatformCredentials,
    providers: { anthropic: provider },
    creditRoutes,
    sharedBudgetRequired,
    now: NOW,
  });
}
function verified(reply?: Parameters<typeof createFakeProvider>[0]) {
  const fake = createFakeProvider(reply);
  return {
    ...fake,
    async stream(...args: Parameters<ModelProvider["stream"]>) {
      return {
        ...(await fake.stream(...args)),
        usageVerified: true as const,
        providerRequestId: "req_gateway_fixture",
      };
    },
  };
}
async function attempts() {
  return f.db.select().from(schema.creditAttempts);
}
async function pool(id: string) {
  const [p] = await f.db.select().from(schema.creditPools).where(eq(schema.creditPools.id, id));
  if (!p) throw new Error("pool missing");
  return p;
}
async function state() {
  return (await creditLedgerSnapshot(f.db, f.org.id, NOW)).pools[0];
}

test("exact-model final usage settles once on the route key; transport retries and extra probes are disabled", async () => {
  f = await setup();
  const r = await route();
  const c = await claim();
  const provider = verified(() => ({ chunks: ["done"], usage: { inputTokens: 100, outputTokens: 12 } }));
  const result = await gatewayOf(provider).stream(callOf(r, c));
  expect(provider.calls).toHaveLength(1);
  expect(provider.calls[0]?.apiKey).toBe(KEY);
  expect(provider.calls[0]?.request.noTransportRetries).toBe(true);
  expect(provider.countCalls).toHaveLength(0);
  expect(await state()).toMatchObject({ heldNanoUsd: 0, spentNanoUsd: result.costNanoUsd });
  expect((await attempts())[0]).toMatchObject({
    state: "settled",
    actualNanoUsd: result.costNanoUsd,
    runId: c.runId,
    providerRequestId: "req_gateway_fixture",
  });
  expect(result.costNanoUsd).toBeGreaterThan(0);
});

test("disabling fallback cannot spend a reserved key through explicit, ordinary, router, default or probe paths", async () => {
  f = await setup();
  const r = await route();
  const c = await claim();
  const provider = verified();
  const gateway = gatewayOf(provider, false);
  await expect(gateway.stream(callOf(r, c))).rejects.toMatchObject({ reason: "disabled" });
  await expect(gateway.stream(callOf(r, c, { credit: undefined }))).rejects.toMatchObject({
    reason: "reserved_credential",
  });
  expect(await gateway.hasModelCredential(r.agent)).toBe(false);
  expect(await gateway.verifyStoredKey(f.org.id, r.credential.id)).toMatchObject({ result: { state: "unchecked" } });
  await f.db
    .update(schema.organizationSettings)
    .set({ defaultCredentialId: r.credential.id, defaultCredentialIds: { anthropic: r.credential.id } })
    .where(eq(schema.organizationSettings.orgId, f.org.id));
  for (const kind of ["router", "summary"] as const) {
    await expect(
      gateway.complete({
        orgId: f.org.id,
        kind,
        model: MODEL,
        system: "sys",
        messages: [{ role: "user", content: "hello" }],
        maxTokens: 10,
      }),
    ).rejects.toThrow();
  }
  expect(provider.calls).toHaveLength(0);
  expect(await attempts()).toHaveLength(0);
});

test("registered key cannot enter ordinary dispatch even while the route is enabled", async () => {
  f = await setup();
  const r = await route();
  const provider = verified();
  await expect(gatewayOf(provider).stream(callOf(r, await claim(), { credit: undefined }))).rejects.toMatchObject({
    reason: "reserved_credential",
  });
  expect(provider.calls).toHaveLength(0);
});

test("a changed route credential or invalid native lease sends nothing", async () => {
  f = await setup();
  const r = await route();
  const c = await claim();
  const provider = verified();
  const gateway = gatewayOf(provider);
  await expect(
    gateway.stream(callOf(r, c, { agent: { ...r.agent, credentialId: f.credential.id } })),
  ).rejects.toMatchObject({ reason: "credential_changed" });
  await f.db
    .update(schema.outbox)
    .set({ lockedUntil: new Date("2026-11-20T11:59:00Z") })
    .where(eq(schema.outbox.id, c.ownerJobId));
  await expect(gateway.stream(callOf(r, c))).rejects.toMatchObject({ reason: "stale_owner" });
  expect(provider.calls).toHaveLength(0);
  expect(await attempts()).toHaveLength(0);
});

test("an independent policy refusal before transport releases the credit hold without a paid probe", async () => {
  f = await setup();
  const r = await route();
  const provider = verified();
  await expect(gatewayOf(provider, true, true).stream(callOf(r, await claim()))).rejects.toThrow();
  expect(provider.calls).toHaveLength(0);
  expect(provider.countCalls).toHaveLength(0);
  expect((await attempts())[0]?.state).toBe("released");
  expect(await state()).toMatchObject({ heldNanoUsd: 0, spentNanoUsd: 0 });
});

test("concurrent duplicate work sends exactly once and the losing caller cannot alter the winner's receipt", async () => {
  f = await setup();
  const r = await route();
  const c = await claim();
  const gate = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const provider = verified(() => ({ chunks: ["only response"], hold: gate.promise }));
  const gateway = gatewayOf(provider);
  const request = callOf(r, c, { onDelta: () => started.resolve() });
  const running = Promise.allSettled([gateway.stream(request), gateway.stream(request)]);
  await started.promise;
  gate.resolve();
  const outcomes = await running;
  expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.filter((r) => r.status === "rejected")).toHaveLength(1);
  expect(provider.calls).toHaveLength(1);
  expect(await attempts()).toHaveLength(1);
  expect((await attempts())[0]?.state).toBe("settled");
  expect(await state()).toMatchObject({ heldNanoUsd: 0, paused: false, status: "available" });
});

test("replaying a settled work unit cannot resend the request or mark the task complete", async () => {
  f = await setup();
  const r = await route();
  const c = await claim();
  const provider = verified();
  const gateway = gatewayOf(provider);
  await gateway.stream(callOf(r, c));
  await expect(gateway.stream(callOf(r, c))).rejects.toMatchObject({ reason: "duplicate_attempt" });
  expect(provider.calls).toHaveLength(1);
  const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, c.runId));
  expect(run?.status).toBe("running");
});

test("aborting an accepted stream retains the full unknown debit and does not count tokens upstream", async () => {
  f = await setup();
  const r = await route();
  const gate = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const controller = new AbortController();
  const provider = verified(() => ({ chunks: ["partial"], hold: gate.promise }));
  const running = gatewayOf(provider)
    .stream(
      callOf(r, await claim(), {
        signal: controller.signal,
        onDelta: () => started.resolve(),
      }),
    )
    .then(
      () => null,
      (error: unknown) => error,
    );
  await started.promise;
  controller.abort();
  gate.resolve();
  const error = await running;
  expect(creditOutcomeOf(error)).toMatchObject({ class: "unknown", hold: "unknown" });
  expect((await attempts())[0]?.state).toBe("unknown");
  expect((await state())?.heldNanoUsd).toBeGreaterThan(0);
  expect(provider.calls).toHaveLength(1);
  expect(provider.countCalls).toHaveLength(0);
  expect((await pool(r.poolId)).status).toBe("reconciliation_required");
});

test.each([
  ["missing final usage", () => createFakeProvider()],
  ["wrong answering model", () => verified(() => ({ chunks: ["wrong"], model: "claude-haiku-4-5" }))],
  ["partial stream", () => verified(() => ({ chunks: ["partial"], failMidStream: { inputTokens: null } }))],
  ["ambiguous 5xx", () => verified(() => new ProviderError("upstream unavailable", true, 503))],
  ["timeout before final receipt", () => verified(() => new ProviderError("request timed out", true, 408))],
] as const)("%s retains an unknown debit and cannot yield verified completion", async (_label, makeProvider) => {
  f = await setup();
  const r = await route();
  const provider = makeProvider();
  const error = await gatewayOf(provider)
    .stream(callOf(r, await claim()))
    .then(
      () => null,
      (error: unknown) => error,
    );
  expect(error).not.toBeNull();
  expect(creditOutcomeOf(error)).toMatchObject({ class: "unknown", hold: "unknown" });
  expect((await attempts())[0]?.state).toBe("unknown");
  expect((await state())?.heldNanoUsd).toBeGreaterThan(0);
  expect(provider.calls).toHaveLength(1);
  expect(provider.countCalls).toHaveLength(0);
});

test("a genuine HTTP rate-limit refusal releases only that call and does not exhaust the grant", async () => {
  f = await setup();
  const r = await route();
  const provider = verified(() => new ProviderError("rate limit reached", true, 429));
  const error = await gatewayOf(provider)
    .stream(callOf(r, await claim()))
    .then(
      () => null,
      (error: unknown) => error,
    );
  expect(creditOutcomeOf(error)).toMatchObject({ class: "rate_limit", hold: "released" });
  expect((await attempts())[0]?.state).toBe("released");
  expect(await state()).toMatchObject({ status: "available", heldNanoUsd: 0, spentNanoUsd: 0 });
  expect(provider.calls).toHaveLength(1);
});

test("HTTP billing refusal opens the budget circuit breaker and cannot retry automatically", async () => {
  f = await setup();
  const r = await route();
  const c = await claim();
  const provider = verified(() => new ProviderError("payment required", false, 402));
  const gateway = gatewayOf(provider);
  const error = await gateway.stream(callOf(r, c)).then(
    () => null,
    (error: unknown) => error,
  );
  expect(creditOutcomeOf(error)).toMatchObject({ class: "billing_blocked", hold: "released" });
  expect((await pool(r.poolId)).status).toBe("billing_blocked");
  await expect(gateway.stream(callOf(r, c))).rejects.toMatchObject({ reason: "billing_blocked" });
  expect(provider.calls).toHaveLength(1);
});

test("provider tools cannot escape a worker that lost the native claim after dispatch", async () => {
  f = await setup();
  const r = await route();
  const c = await claim();
  const fake = verified(() => ({ chunks: ["ready"], toolUses: [{ name: "irreversible_write", input: {} }] }));
  const provider: ModelProvider = {
    ...fake,
    async stream(...args) {
      const result = await fake.stream(...args);
      await f.db
        .update(schema.outbox)
        .set({ lockedBy: "successor-worker", attempts: 2 })
        .where(eq(schema.outbox.id, c.ownerJobId));
      return result;
    },
  };
  let sideEffects = 0;
  const failure = await gatewayOf(provider)
    .stream(callOf(r, c))
    .then(
      (result) => {
        sideEffects += result.content.filter((b) => b.type === "tool_use").length;
        return null;
      },
      (error: unknown) => error,
    );
  expect(failure).toMatchObject({ reason: "reconciliation_required" });
  expect(sideEffects).toBe(0);
  expect(fake.calls).toHaveLength(1);
  expect((await attempts())[0]?.state).toBe("settled");
  expect((await state())?.spentNanoUsd).toBeGreaterThan(0);
  expect((await pool(r.poolId)).paused).toBe(true);
});

test("opaque billable input is rejected before reservation and provider transmission", async () => {
  f = await setup();
  const r = await route();
  const provider = verified();
  await expect(
    gatewayOf(provider).stream(
      callOf(r, await claim(), {
        messages: [
          { role: "user", content: [{ type: "image", data: "data:synthetic", mediaType: "image/png" } as never] },
        ],
      }),
    ),
  ).rejects.toMatchObject({ reason: "unsupported_capability" });
  expect(provider.calls).toHaveLength(0);
  expect(await attempts()).toHaveLength(0);
});

test("raw key verification never probes a protected provider or the registered grant secret", async () => {
  f = await setup();
  await route();
  const provider = verified();
  const gateway = gatewayOf(provider, false);
  for (const apiKey of [KEY, "sk-ant-unproven-independent-billing-account"]) {
    expect(await gateway.verifyKey({ orgId: f.org.id, provider: "anthropic", key: { apiKey } })).toEqual({
      state: "unchecked",
    });
  }
  expect(provider.calls).toHaveLength(0);
  expect(await attempts()).toHaveLength(0);
});

test("duplicate credential rows and distinct unproven accounts cannot bypass the shared provider ledger", async () => {
  f = await setup();
  const r = await route();
  const c = await claim();
  const provider = verified();
  const gateway = gatewayOf(provider, false);
  for (const [i, apiKey] of [KEY, "sk-ant-distinct-account-unproven"].entries()) {
    const alias = await createCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, {
      provider: "anthropic",
      label: `alias-${i}`,
      apiKey,
    });
    await expect(
      gateway.stream(callOf(r, c, { credit: undefined, agent: { ...r.agent, credentialId: alias.id } })),
    ).rejects.toThrow();
    expect(await gateway.hasModelCredential({ ...r.agent, credentialId: alias.id })).toBe(false);
    expect(await gateway.verifyStoredKey(f.org.id, alias.id)).toMatchObject({ result: { state: "unchecked" } });
    await f.db
      .update(schema.organizationSettings)
      .set({ defaultCredentialId: alias.id, defaultCredentialIds: { anthropic: alias.id } })
      .where(eq(schema.organizationSettings.orgId, f.org.id));
    await expect(
      gateway.complete({
        orgId: f.org.id,
        kind: "router",
        model: MODEL,
        system: "sys",
        messages: [{ role: "user", content: "hello" }],
        maxTokens: 10,
      }),
    ).rejects.toThrow();
  }
  expect(provider.calls).toHaveLength(0);
  expect(await attempts()).toHaveLength(0);
});

test("platform fallback cannot spend an unproven grant billing account", async () => {
  f = await setup();
  const r = await route();
  const c = await claim();
  const provider = verified();
  await f.db
    .update(schema.providerCredentials)
    .set({ revokedAt: NOW() })
    .where(eq(schema.providerCredentials.id, f.credential.id));
  const gateway = createModelGateway({
    db: f.db,
    keyWrappers: [f.keyWrapper],
    providers: { anthropic: provider },
    now: NOW,
    creditRoutes: false,
    platformCredentials: {
      resolve: async () => ({ apiKey: KEY }),
      available: async () => true,
    },
  });
  await expect(
    gateway.stream(callOf(r, c, { credit: undefined, agent: { ...r.agent, credentialId: null } })),
  ).rejects.toThrow();
  expect(await gateway.hasModelCredential({ ...r.agent, credentialId: null })).toBe(false);
  await expect(
    gateway.complete({
      orgId: f.org.id,
      kind: "summary",
      model: MODEL,
      system: "sys",
      messages: [{ role: "user", content: "hello" }],
      maxTokens: 10,
    }),
  ).rejects.toThrow();
  expect(provider.calls).toHaveLength(0);
});

test("copying a grant secret into a custom endpoint does not bypass reservation", async () => {
  f = await setup();
  const r = await route();
  const c = await claim();
  const alias = await createCredential(
    f.db,
    f.keyWrapper,
    f.owner.id,
    f.org.id,
    {
      provider: "custom",
      label: "alias endpoint",
      apiKey: KEY,
      endpoint: { style: "anthropic", baseURL: "https://fixture.example/api", models: [{ id: "alias-model" }] },
    },
    { net: { allowPrivate: false, resolveHost: async () => ["93.184.216.34"] } },
  );
  const provider = verified();
  const gateway = createModelGateway({
    db: f.db,
    keyWrappers: [f.keyWrapper],
    platformCredentials: noPlatformCredentials,
    providers: { custom: provider },
    now: NOW,
    creditRoutes: false,
  });
  await expect(
    gateway.stream(
      callOf(r, c, {
        credit: undefined,
        agent: { ...r.agent, credentialId: alias.id, model: customModelId(alias.id, "alias-model") },
      }),
    ),
  ).rejects.toMatchObject({ reason: "reserved_credential" });
  expect(provider.calls).toHaveLength(0);
  expect(await attempts()).toHaveLength(0);
});

test("an independent organization without grant pools retains its ordinary API and key-check behavior", async () => {
  f = await setup();
  await route();
  const { organization: other } = await createOrganization(f.db, f.owner.id, { name: "Independent organization" });
  const credential = await createCredential(f.db, f.keyWrapper, f.owner.id, other.id, {
    provider: "anthropic",
    label: "independent ordinary",
    apiKey: "sk-ant-independent-ordinary",
  });
  const agent = await createAgent(
    f.db,
    f.owner.id,
    other.id,
    {
      name: "Independent",
      handle: "independent",
      role: "Developer",
      instructions: "Answer briefly.",
      credentialId: credential.id,
    },
    { model: MODEL },
  );
  const provider = verified();
  const gateway = gatewayOf(provider, false);
  expect(await gateway.hasModelCredential(agent)).toBe(true);
  const result = await gateway.stream({
    orgId: other.id,
    agentId: agent.id,
    agent,
    system: "sys",
    messages: [{ role: "user", content: "hello" }],
    maxTokens: 100,
    onDelta: () => {},
  });
  expect(result.text).toContain("hello");
  expect(
    await gateway.verifyKey({ orgId: other.id, provider: "anthropic", key: { apiKey: "sk-ant-independent-ordinary" } }),
  ).toMatchObject({ state: "ok" });
  expect(provider.calls).toHaveLength(2);
  expect(provider.calls.every((call) => call.apiKey !== KEY)).toBe(true);
  expect(await attempts()).toHaveLength(0);
});

test("copying the same grant secret into another organization cannot bypass the upstream pool", async () => {
  f = await setup();
  await route();
  const { organization: other } = await createOrganization(f.db, f.owner.id, { name: "Copied-key organization" });
  const credential = await createCredential(f.db, f.keyWrapper, f.owner.id, other.id, {
    provider: "anthropic",
    label: "copied grant secret",
    apiKey: KEY,
  });
  const agent = await createAgent(
    f.db,
    f.owner.id,
    other.id,
    {
      name: "Copied",
      handle: "copied",
      role: "Developer",
      instructions: "Answer briefly.",
      credentialId: credential.id,
    },
    { model: MODEL },
  );
  const provider = verified();
  const gateway = gatewayOf(provider, false);
  await expect(
    gateway.stream({
      orgId: other.id,
      agentId: agent.id,
      agent,
      system: "sys",
      messages: [{ role: "user", content: "hello" }],
      maxTokens: 100,
      onDelta: () => {},
    }),
  ).rejects.toMatchObject({ reason: "reserved_credential" });
  expect(await gateway.verifyKey({ orgId: other.id, provider: "anthropic", key: { apiKey: KEY } })).toEqual({
    state: "unchecked",
  });
  await expect(
    gateway.complete({
      orgId: other.id,
      kind: "router",
      model: MODEL,
      system: "sys",
      messages: [{ role: "user", content: "hello" }],
      maxTokens: 10,
    }),
  ).rejects.toMatchObject({ reason: "reserved_credential" });
  expect(provider.calls).toHaveLength(0);
  expect(await attempts()).toHaveLength(0);
});

test("credit settlement prices the admitted tariff even when the catalog changes or the provider reports zero cost", async () => {
  f = await setup();
  const r = await route();
  const c = await claim();
  const original = MODEL_CATALOG[MODEL];
  if (!original) throw new Error("fixture model missing");
  const profile = creditPricingProfile(MODEL);
  const usage = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 30 };
  const provider = verified(() => {
    MODEL_CATALOG[MODEL] = {
      ...original,
      prices: { input: 20_000, output: 100_000, cacheRead: 1000, cacheWrite: 25_000 },
    };
    return { chunks: ["done"], usage, costNanoUsd: 0 };
  });
  try {
    const result = await gatewayOf(provider).stream(callOf(r, c));
    const expected = creditReceiptCost(profile, usage);
    expect(result.costNanoUsd).toBe(expected);
    expect((await attempts())[0]?.actualNanoUsd).toBe(expected);
    const [record] = await f.db
      .select()
      .from(schema.usageRecords)
      .where(eq(schema.usageRecords.id, result.usageRecordId));
    expect(record?.costNanoUsd).toBe(expected);
    expect(provider.calls).toHaveLength(1);
  } finally {
    MODEL_CATALOG[MODEL] = original;
  }
});

test("registered grant identity remains protected after local key rotation and revocation", async () => {
  f = await setup();
  const r = await route();
  const provider = verified();
  const gateway = gatewayOf(provider, false);
  const [before] = await f.db.select().from(schema.creditRoutes).where(eq(schema.creditRoutes.id, r.routeId));
  await rotateCredential(
    f.db,
    f.keyWrapper,
    f.owner.id,
    f.org.id,
    r.credential.id,
    { apiKey: "sk-ant-synthetic-rotated-key" },
    { verify: gateway.verifyKey.bind(gateway) },
  );
  await f.db
    .update(schema.providerCredentials)
    .set({ revokedAt: NOW() })
    .where(eq(schema.providerCredentials.id, r.credential.id));
  const [after] = await f.db.select().from(schema.creditRoutes).where(eq(schema.creditRoutes.id, r.routeId));
  expect(after?.credentialFingerprint).toBe(before?.credentialFingerprint);
  const { organization: other } = await createOrganization(f.db, f.owner.id, { name: "Old key clone" });
  const credential = await createCredential(f.db, f.keyWrapper, f.owner.id, other.id, {
    provider: "anthropic",
    label: "old key clone",
    apiKey: KEY,
  });
  const agent = await createAgent(
    f.db,
    f.owner.id,
    other.id,
    { name: "Clone", handle: "clone", role: "Developer", instructions: "Answer briefly.", credentialId: credential.id },
    { model: MODEL },
  );
  expect(await gateway.verifyKey({ orgId: other.id, provider: "anthropic", key: { apiKey: KEY } })).toEqual({
    state: "unchecked",
  });
  await expect(
    gateway.stream({
      orgId: other.id,
      agentId: agent.id,
      agent,
      system: "sys",
      messages: [{ role: "user", content: "hello" }],
      maxTokens: 100,
      onDelta: () => {},
    }),
  ).rejects.toMatchObject({ reason: "reserved_credential" });
  expect(provider.calls).toHaveLength(0);
  expect(await attempts()).toHaveLength(0);
});
