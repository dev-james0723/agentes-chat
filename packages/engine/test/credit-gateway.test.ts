import { afterEach, expect, test } from "bun:test";
import { noPlatformCredentials } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import { ProviderError } from "@agenteschat/providers";
import { createFakeProvider } from "@agenteschat/providers/testing";
import { createAgent, createCredential, createModelGateway } from "../src";
import {
  qualifyCreditRoute,
  registerCreditPool,
  registerCreditRoute,
  setCreditRouteEnabled,
} from "../src/credit-ledger";
import { creditOutcomeOf } from "../src/credit-route";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
  f = undefined as unknown as Fixture;
});

const MODEL = "claude-sonnet-5-5";
const KEY = "sk-ant-synthetic-credit-gateway";

/** The credit route on a key of its own, and an agent on that key's model, as the executor's thinker override has it. */
async function route(o: { allocation?: number } = {}) {
  const credential = await createCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, {
    provider: "anthropic",
    label: "credits",
    apiKey: KEY,
  });
  const poolId = await registerCreditPool(f.db, f.org.id, {
    upstreamAccount: "console-org-fixture",
    enforcement: "prepaid_grant_only",
    evidenceRef: "fixture-evidence",
    verifiedAt: new Date(Date.now() - 3_600_000),
    validUntil: new Date(Date.now() + 24 * 3_600_000),
    allocationNanoUsd: o.allocation ?? 50_000_000_000,
  });
  const routeId = await registerCreditRoute(f.db, f.org.id, {
    poolId,
    credentialId: credential.id,
    model: MODEL,
    supportsTools: true,
    maxPromptBytes: 100_000,
  });
  await setCreditRouteEnabled(f.db, f.org.id, routeId, true);
  const q = await qualifyCreditRoute(f.db, { orgId: f.org.id, need: { tools: false, promptBytes: 10 } });
  if (!q.ok) throw new Error(`fixture route did not qualify: ${q.reason}`);
  const agent = { ...f.agent, model: MODEL, credentialId: credential.id };
  return { credential, poolId, routeId, proof: q.proof, agent };
}

const gatewayOf = (provider: ReturnType<typeof createFakeProvider>, creditRoutes = true) =>
  createModelGateway({
    db: f.db,
    keyWrappers: [f.keyWrapper],
    platformCredentials: noPlatformCredentials,
    providers: { anthropic: provider },
    creditRoutes,
  });

const callOf = (r: Awaited<ReturnType<typeof route>>, over: Record<string, unknown> = {}) => ({
  orgId: f.org.id,
  agentId: f.agent.id,
  agent: r.agent,
  system: "sys",
  messages: [{ role: "user" as const, content: "hello" }],
  maxTokens: 100,
  credit: { routeId: r.routeId, credentialId: r.proof.credentialId, credentialVersion: r.proof.credentialVersion },
  onDelta: () => {},
  ...over,
});

const pool = async (id: string) => {
  const [row] = await f.db.select().from(schema.creditPools).where(eq(schema.creditPools.id, id));
  if (!row) throw new Error("pool");
  return row;
};

test("a credit call runs on exactly the route's key and settles what it cost against the pool", async () => {
  f = await setup();
  const r = await route();
  const provider = createFakeProvider();
  const result = await gatewayOf(provider).stream(callOf(r));
  expect(provider.calls).toHaveLength(1);
  expect(provider.calls[0]?.apiKey).toBe(KEY);
  const p = await pool(r.poolId);
  expect(p.heldNanoUsd).toBe(0);
  expect(p.spentNanoUsd).toBe(result.costNanoUsd);
  const [attempt] = await f.db.select().from(schema.creditAttempts);
  expect(attempt?.state).toBe("settled");
  expect(attempt?.runId).toBeNull();
});

test("a key reserved for a credit route is refused for every call that is not on it", async () => {
  f = await setup();
  const r = await route();
  const provider = createFakeProvider();
  await expect(gatewayOf(provider).stream(callOf(r, { credit: undefined }))).rejects.toMatchObject({
    reason: "reserved_credential",
  });
  await expect(
    gatewayOf(provider).complete({
      orgId: f.org.id,
      kind: "summary",
      model: MODEL,
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 10,
    }),
  ).rejects.toThrow();
  expect(provider.calls).toHaveLength(0);
});

test("a gateway that never switched credit routes on refuses a call that asks for one", async () => {
  f = await setup();
  const r = await route();
  const provider = createFakeProvider();
  await expect(gatewayOf(provider, false).stream(callOf(r))).rejects.toMatchObject({ reason: "disabled" });
  expect(provider.calls).toHaveLength(0);
});

test("a call on any other credential than the route's is refused before it is sent", async () => {
  f = await setup();
  const r = await route();
  const provider = createFakeProvider();
  // The thinker points at the workspace's own key, not the route's.
  await expect(
    gatewayOf(provider).stream(callOf(r, { agent: { ...f.agent, model: MODEL, credentialId: f.credential.id } })),
  ).rejects.toMatchObject({ reason: "credential_changed" });
  expect(provider.calls).toHaveLength(0);
});

test("a refused admission sends nothing and releases the agent's budget", async () => {
  f = await setup();
  const r = await route({ allocation: 1 });
  const provider = createFakeProvider();
  await expect(gatewayOf(provider).stream(callOf(r))).rejects.toMatchObject({ reason: "no_allocation" });
  expect(provider.calls).toHaveLength(0);
  expect((await pool(r.poolId)).heldNanoUsd).toBe(0);
});

const failing = (error: ProviderError) => createFakeProvider(() => error);

test("an empty grant is a known refusal: the hold goes back and the pool is exhausted", async () => {
  f = await setup();
  const r = await route();
  const provider = failing(new ProviderError("Your credit balance is too low to access the API", false, 400));
  const error = await gatewayOf(provider)
    .stream(callOf(r))
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ProviderError);
  expect(creditOutcomeOf(error)).toMatchObject({ class: "exhausted", hold: "released" });
  const p = await pool(r.poolId);
  expect([p.status, p.heldNanoUsd]).toEqual(["exhausted", 0]);
  // And the route says so from then on, without a call.
  provider.calls.length = 0;
  await expect(gatewayOf(provider).stream(callOf(r))).rejects.toMatchObject({ reason: "exhausted" });
  expect(provider.calls).toHaveLength(0);
});

test("a 429 releases the hold and leaves the pool available: it is throughput, not money", async () => {
  f = await setup();
  const r = await route();
  const error = await gatewayOf(failing(new ProviderError("rate limit", true, 429)))
    .stream(callOf(r))
    .catch((e: unknown) => e);
  expect(creditOutcomeOf(error)).toMatchObject({ class: "rate_limit", hold: "released" });
  const p = await pool(r.poolId);
  expect([p.status, p.heldNanoUsd]).toEqual(["available", 0]);
});

test("a 402 blocks the pool for a person; a credential refusal switches the route off", async () => {
  f = await setup();
  const r = await route();
  await gatewayOf(failing(new ProviderError("billing_error", false, 402)))
    .stream(callOf(r))
    .catch(() => {});
  expect((await pool(r.poolId)).status).toBe("billing_blocked");
  await f.db.update(schema.creditPools).set({ status: "available" });
  await gatewayOf(failing(new ProviderError("authentication_error", false, 401)))
    .stream(callOf(r))
    .catch(() => {});
  const [row] = await f.db.select().from(schema.creditRoutes);
  expect(row?.enabled).toBe(false);
});

test("a timeout or a 5xx may have charged: the hold stays and nothing frees it", async () => {
  f = await setup();
  const r = await route();
  const error = await gatewayOf(failing(new ProviderError("boom", true, 500)))
    .stream(callOf(r))
    .catch((e: unknown) => e);
  expect(creditOutcomeOf(error)).toMatchObject({ class: "unknown", hold: "unknown" });
  const p = await pool(r.poolId);
  expect(p.heldNanoUsd).toBeGreaterThan(0);
  const [attempt] = await f.db.select().from(schema.creditAttempts);
  expect(attempt?.state).toBe("unknown");
});

test("a stream that began and broke keeps its hold even though the usage so far is recorded", async () => {
  f = await setup();
  const r = await route();
  const provider = createFakeProvider(() => ({
    chunks: ["part"],
    failMidStream: { inputTokens: 10, retryable: true },
  }));
  const error = await gatewayOf(provider)
    .stream(callOf(r))
    .catch((e: unknown) => e);
  expect(creditOutcomeOf(error)).toMatchObject({ hold: "unknown" });
  expect((await pool(r.poolId)).heldNanoUsd).toBeGreaterThan(0);
});

test("the agent's own budget still applies to a credit call", async () => {
  f = await setup();
  const r = await route();
  await f.db.update(schema.agents).set({ monthlyBudgetNanoUsd: 1 }).where(eq(schema.agents.id, f.agent.id));
  const provider = createFakeProvider();
  await expect(
    gatewayOf(provider).stream(callOf(r, { agent: { ...r.agent, monthlyBudgetNanoUsd: 1 } })),
  ).rejects.toThrow();
  expect(provider.calls).toHaveLength(0);
  expect((await pool(r.poolId)).heldNanoUsd).toBe(0);
});

test("with credit routes off in the server, the reserved-key check costs nothing and nothing changes", async () => {
  f = await setup();
  const provider = createFakeProvider();
  const result = await gatewayOf(provider, false).stream({
    orgId: f.org.id,
    agentId: f.agent.id,
    system: "sys",
    messages: [{ role: "user", content: "hi" }],
    maxTokens: 10,
    onDelta: () => {},
  });
  expect(result.text).toContain("Echo");
  void createAgent;
});
