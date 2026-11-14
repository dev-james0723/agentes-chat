import { afterEach, expect, test } from "bun:test";
import { noPlatformCredentials } from "@agenteschat/adapters";
import { eq, schema, sql } from "@agenteschat/db";
import { createAgent, createCredential, createModelGateway, rotateCredential } from "../src";
import { credentialVersion } from "../src/credentials";
import {
  SHARED_BUDGET_SCOPE,
  SHARED_BUDGET_TOOL,
  sharedBudgetApprovalHash,
  sharedBudgetApprovalParams,
} from "../src/shared-budget";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(() => f?.close());

test("enabled workspace policy denies an unregistered route before provider dispatch", async () => {
  f = await setup();
  await f.db.insert(schema.sharedBudgetPolicies).values({ orgId: f.org.id, enabled: true });
  const gateway = createModelGateway({
    db: f.db,
    keyWrappers: [f.keyWrapper],
    platformCredentials: noPlatformCredentials,
    providers: { anthropic: f.provider },
    sharedBudgetRequired: true,
  });
  await expect(
    gateway.stream({
      orgId: f.org.id,
      agentId: f.agent.id,
      system: "sys",
      messages: [{ role: "user", content: "hello" }],
      maxTokens: 10,
      onDelta: () => {},
    }),
  ).rejects.toThrow("shared budget");
  expect(f.provider.calls).toHaveLength(0);
});

test("organization summary cannot bypass enabled policy", async () => {
  f = await setup();
  await f.db.insert(schema.sharedBudgetPolicies).values({ orgId: f.org.id, enabled: true });
  const gateway = createModelGateway({
    db: f.db,
    keyWrappers: [f.keyWrapper],
    platformCredentials: noPlatformCredentials,
    providers: { anthropic: f.provider },
    sharedBudgetRequired: true,
  });
  await expect(
    gateway.complete({
      orgId: f.org.id,
      kind: "summary",
      model: "claude-sonnet-5-5",
      system: "sys",
      messages: [{ role: "user", content: "hello" }],
      maxTokens: 10,
    }),
  ).rejects.toThrow("shared budget");
  expect(f.provider.calls).toHaveLength(0);
});

async function enablePool(ceilingNanoUsd: number) {
  const at = Date.now();
  await f.db.insert(schema.sharedBudgetPolicies).values({ orgId: f.org.id, enabled: true });
  const [pool] = await f.db
    .insert(schema.sharedBudgetPools)
    .values({
      orgId: f.org.id,
      windowStart: new Date(at - 1000),
      windowEnd: new Date(at + 3600_000),
      approvalUntil: new Date(at + 3600_000),
      approvedBy: "fixture-owner",
      approvalRef: "fixture-only",
      upstreamProvider: "billing:synthetic",
      upstreamAccount: "acct:fixture",
      upstreamPool: "billing:fixture",
      ceilingNanoUsd,
    })
    .returning();
  if (!pool) throw new Error("missing fixture pool");
  const [credential] = await f.db
    .select()
    .from(schema.providerCredentials)
    .where(eq(schema.providerCredentials.id, f.credential.id));
  if (!credential) throw new Error("missing synthetic credential");
  for (const subject of [`agent:${f.agent.id}`, "org:summary"]) {
    await f.db.insert(schema.sharedBudgetRoutes).values({
      orgId: f.org.id,
      poolId: pool.id,
      provider: "anthropic",
      credentialId: f.credential.id,
      credentialVersion: credentialVersion(credential),
      model: "claude-sonnet-5-5",
      subject,
      dataClass: "fixture",
      supportsTools: false,
      maxPromptBytes: 100_000,
      evidenceRef: "synthetic-test-only",
      verifiedAt: new Date(at - 1000),
      validUntil: new Date(at + 3600_000),
      enabled: true,
    });
  }
  const routes = await f.db
    .select()
    .from(schema.sharedBudgetRoutes)
    .where(eq(schema.sharedBudgetRoutes.poolId, pool.id));
  const params = sharedBudgetApprovalParams(pool, routes);
  const [approval] = await f.db
    .insert(schema.approvals)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: crypto.randomUUID(),
      toolUseId: "synthetic-budget-approval",
      tool: SHARED_BUDGET_TOOL,
      scope: SHARED_BUDGET_SCOPE,
      params,
      actionHash: sharedBudgetApprovalHash(params),
      title: "Synthetic budget",
      status: "approved",
      decidedByUserId: f.owner.id,
      decidedAt: new Date(at),
      expiresAt: new Date(at + 7200_000),
    })
    .returning();
  if (!approval) throw new Error("missing synthetic approval");
  await f.db
    .update(schema.sharedBudgetPools)
    .set({ approvalRef: approval.id, approvedBy: f.owner.id })
    .where(eq(schema.sharedBudgetPools.id, pool.id));
  return pool;
}

const agentCall = (gateway: ReturnType<typeof createModelGateway>) =>
  gateway.stream({
    orgId: f.org.id,
    agentId: f.agent.id,
    dataClass: "fixture",
    system: "sys",
    messages: [{ role: "user", content: "hello" }],
    maxTokens: 10,
    onDelta: () => {},
  });
const summaryCall = (gateway: ReturnType<typeof createModelGateway>) =>
  gateway.complete({
    orgId: f.org.id,
    kind: "summary",
    model: "claude-sonnet-5-5",
    dataClass: "fixture",
    system: "sys",
    messages: [{ role: "user", content: "hello" }],
    maxTokens: 10,
  });

for (const kind of ["stream", "complete"] as const) {
  test(`required ${kind} never makes an unbudgeted countTokens call after partial failure`, async () => {
    f = await setup({ reply: () => ({ chunks: ["abc"], failMidStream: { inputTokens: null } }) });
    await enablePool(10);
    const gateway = createModelGateway({
      db: f.db,
      keyWrappers: [f.keyWrapper],
      platformCredentials: noPlatformCredentials,
      providers: { anthropic: f.provider },
      sharedBudgetRequired: true,
      sharedBudgetTransports: {
        anthropic: {
          identify: async () => ({ namespace: "billing:synthetic", account: "acct:fixture", pool: "billing:fixture" }),
          qualifies: () => true,
          bound: () => 10,
          stream: (provider, request, opts) => provider.stream(request, opts),
        },
      },
    });
    await expect(kind === "stream" ? agentCall(gateway) : summaryCall(gateway)).rejects.toThrow();
    expect(f.provider.calls).toHaveLength(1);
    expect(f.provider.countCalls).toHaveLength(0);
    const records = await f.db.select().from(schema.usageRecords);
    expect(records).toHaveLength(1);
    expect(records[0]?.partial).toBe(true);
    expect(records[0]?.inputTokens).toBeGreaterThan(0);
    expect(await f.db.select().from(schema.sharedBudgetReservations)).toMatchObject([{ state: "held" }]);
  });
}

test("agent and summary calls atomically share one pool and settle observed cost", async () => {
  f = await setup();
  const pool = await enablePool(10);
  const ready = Promise.withResolvers<void>();
  let started = 0;
  const gateway = createModelGateway({
    db: f.db,
    keyWrappers: [f.keyWrapper],
    platformCredentials: noPlatformCredentials,
    providers: { anthropic: f.provider },
    sharedBudgetRequired: true,
    sharedBudgetTransports: {
      anthropic: {
        identify: async () => ({ namespace: "billing:synthetic", account: "acct:fixture", pool: "billing:fixture" }),
        qualifies: () => true,
        bound: () => 10,
        stream: async (provider, req, opts) => {
          started++;
          await ready.promise;
          return { ...(await provider.stream(req, opts)), costNanoUsd: 4 };
        },
      },
    },
  });
  const pending = Promise.allSettled([agentCall(gateway), summaryCall(gateway)]);
  await Bun.sleep(120);
  ready.resolve();
  const outcomes = await pending;
  expect(outcomes.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.filter((x) => x.status === "rejected")).toHaveLength(1);
  expect(started).toBe(1);
  const [row] = await f.db.select().from(schema.sharedBudgetPools).where(eq(schema.sharedBudgetPools.id, pool.id));
  expect(row).toMatchObject({ spentNanoUsd: 4, heldNanoUsd: 0, paused: false });
  expect(await f.db.select().from(schema.sharedBudgetReservations)).toMatchObject([
    { state: "settled", actualNanoUsd: 4 },
  ]);
});

test("unknown or failed cost remains durably reserved after gateway recreation", async () => {
  f = await setup();
  const pool = await enablePool(10);
  const deps = {
    db: f.db,
    keyWrappers: [f.keyWrapper],
    platformCredentials: noPlatformCredentials,
    providers: { anthropic: f.provider },
    sharedBudgetRequired: true,
    sharedBudgetTransports: {
      anthropic: {
        identify: async () => ({ namespace: "billing:synthetic", account: "acct:fixture", pool: "billing:fixture" }),
        qualifies: () => true,
        bound: () => 10,
        stream: async () => {
          throw new Error("network cutoff");
        },
      },
    },
  };
  await expect(agentCall(createModelGateway(deps))).rejects.toThrow();
  const [row] = await f.db.select().from(schema.sharedBudgetPools).where(eq(schema.sharedBudgetPools.id, pool.id));
  expect(row).toMatchObject({ spentNanoUsd: 0, heldNanoUsd: 10 });
  await expect(summaryCall(createModelGateway(deps))).rejects.toThrow("shared budget");
  expect(await f.db.select().from(schema.sharedBudgetReservations)).toMatchObject([
    { state: "held", amountNanoUsd: 10 },
  ]);
});

test("reported cost beyond the promised bound pauses the pool", async () => {
  f = await setup();
  const pool = await enablePool(10);
  const gateway = createModelGateway({
    db: f.db,
    keyWrappers: [f.keyWrapper],
    platformCredentials: noPlatformCredentials,
    providers: { anthropic: f.provider },
    sharedBudgetRequired: true,
    sharedBudgetTransports: {
      anthropic: {
        identify: async () => ({ namespace: "billing:synthetic", account: "acct:fixture", pool: "billing:fixture" }),
        qualifies: () => true,
        bound: () => 10,
        stream: async (provider, req, opts) => ({ ...(await provider.stream(req, opts)), costNanoUsd: 11 }),
      },
    },
  });
  await expect(agentCall(gateway)).rejects.toThrow("shared budget");
  const [row] = await f.db.select().from(schema.sharedBudgetPools).where(eq(schema.sharedBudgetPools.id, pool.id));
  expect(row).toMatchObject({ spentNanoUsd: 11, heldNanoUsd: 0, paused: true });
  await expect(summaryCall(gateway)).rejects.toThrow("shared budget");
});

test("missing upstream hard cap or classification cannot be mistaken for free usage", async () => {
  f = await setup();
  await enablePool(10);
  const withoutTransport = createModelGateway({
    db: f.db,
    keyWrappers: [f.keyWrapper],
    platformCredentials: noPlatformCredentials,
    providers: { anthropic: f.provider },
    sharedBudgetRequired: true,
  });
  await expect(agentCall(withoutTransport)).rejects.toThrow("shared budget");
  const capped = createModelGateway({
    db: f.db,
    keyWrappers: [f.keyWrapper],
    platformCredentials: noPlatformCredentials,
    providers: { anthropic: f.provider },
    sharedBudgetRequired: true,
    sharedBudgetTransports: {
      anthropic: {
        identify: async () => ({ namespace: "billing:synthetic", account: "acct:fixture", pool: "billing:fixture" }),
        qualifies: () => true,
        bound: () => 10,
        stream: async (p, r, o) => p.stream(r, o),
      },
    },
  });
  await expect(
    capped.stream({
      orgId: f.org.id,
      agentId: f.agent.id,
      system: "sys",
      messages: [],
      maxTokens: 10,
      onDelta: () => {},
    }),
  ).rejects.toThrow("shared budget");
  expect(f.provider.calls).toHaveLength(0);
});

test("unverified approval reference cannot authorize spending", async () => {
  f = await setup();
  const pool = await enablePool(10);
  await f.db
    .update(schema.sharedBudgetPools)
    .set({ approvalRef: "fixture-only" })
    .where(eq(schema.sharedBudgetPools.id, pool.id));
  const gateway = createModelGateway({
    db: f.db,
    keyWrappers: [f.keyWrapper],
    platformCredentials: noPlatformCredentials,
    providers: { anthropic: f.provider },
    sharedBudgetRequired: true,
    sharedBudgetTransports: {
      anthropic: {
        identify: async () => ({ namespace: "billing:synthetic", account: "acct:fixture", pool: "billing:fixture" }),
        qualifies: () => true,
        bound: () => 10,
        stream: async (p, r, o) => p.stream(r, o),
      },
    },
  });
  await expect(agentCall(gateway)).rejects.toThrow("shared budget");
  expect(f.provider.calls).toHaveLength(0);
});

test("changed route scope, pending decision or expired decision deny before dispatch", async () => {
  f = await setup();
  const pool = await enablePool(10);
  const gateway = createModelGateway({
    db: f.db,
    keyWrappers: [f.keyWrapper],
    platformCredentials: noPlatformCredentials,
    providers: { anthropic: f.provider },
    sharedBudgetRequired: true,
    sharedBudgetTransports: {
      anthropic: {
        identify: async () => ({ namespace: "billing:synthetic", account: "acct:fixture", pool: "billing:fixture" }),
        qualifies: () => true,
        bound: () => 10,
        stream: async (p, r, o) => p.stream(r, o),
      },
    },
  });
  const [approval] = await f.db.select().from(schema.approvals).where(eq(schema.approvals.orgId, f.org.id));
  if (!approval) throw new Error("missing fixture approval");
  await f.db.update(schema.approvals).set({ status: "pending" }).where(eq(schema.approvals.id, approval.id));
  await expect(agentCall(gateway)).rejects.toThrow("shared budget");
  await f.db
    .update(schema.approvals)
    .set({ status: "approved", expiresAt: new Date(Date.now() - 1000) })
    .where(eq(schema.approvals.id, approval.id));
  await expect(agentCall(gateway)).rejects.toThrow("shared budget");
  await f.db
    .update(schema.approvals)
    .set({ expiresAt: approval.expiresAt })
    .where(eq(schema.approvals.id, approval.id));
  await f.db
    .update(schema.sharedBudgetRoutes)
    .set({ evidenceRef: "different-evidence" })
    .where(eq(schema.sharedBudgetRoutes.poolId, pool.id));
  await expect(agentCall(gateway)).rejects.toThrow("shared budget");
  expect(f.provider.calls).toHaveLength(0);
});

test("unqualified returned model is rejected and its cost remains held", async () => {
  f = await setup();
  const pool = await enablePool(10);
  const gateway = createModelGateway({
    db: f.db,
    keyWrappers: [f.keyWrapper],
    platformCredentials: noPlatformCredentials,
    providers: { anthropic: f.provider },
    sharedBudgetRequired: true,
    sharedBudgetTransports: {
      anthropic: {
        identify: async () => ({ namespace: "billing:synthetic", account: "acct:fixture", pool: "billing:fixture" }),
        qualifies: () => true,
        bound: () => 10,
        stream: async (p, r, o) => ({ ...(await p.stream(r, o)), model: "different-model", costNanoUsd: 1 }),
      },
    },
  });
  await expect(agentCall(gateway)).rejects.toThrow("shared budget");
  const [row] = await f.db.select().from(schema.sharedBudgetPools).where(eq(schema.sharedBudgetPools.id, pool.id));
  expect(row).toMatchObject({ heldNanoUsd: 10, spentNanoUsd: 0 });
});

test("required gateway rejects missing and disabled policy before provider dispatch", async () => {
  f = await setup();
  const gateway = createModelGateway({
    db: f.db,
    keyWrappers: [f.keyWrapper],
    platformCredentials: noPlatformCredentials,
    providers: { anthropic: f.provider },
    ...{ sharedBudgetRequired: true },
  });
  await expect(agentCall(gateway)).rejects.toThrow("shared budget");
  await f.db.insert(schema.sharedBudgetPolicies).values({ orgId: f.org.id, enabled: false });
  await expect(summaryCall(gateway)).rejects.toThrow("shared budget");
  expect(f.provider.calls).toHaveLength(0);
});

test("reservation cannot join a route from a different pool in the same org", async () => {
  f = await setup();
  const pool = await enablePool(10);
  const [route] = await f.db
    .select()
    .from(schema.sharedBudgetRoutes)
    .where(eq(schema.sharedBudgetRoutes.poolId, pool.id));
  if (!route) throw new Error("missing fixture route");
  const [other] = await f.db
    .insert(schema.sharedBudgetPools)
    .values({
      orgId: f.org.id,
      windowStart: pool.windowStart,
      windowEnd: pool.windowEnd,
      approvalUntil: pool.approvalUntil,
      approvedBy: "fixture",
      approvalRef: "fixture",
      ceilingNanoUsd: 10,
    })
    .returning();
  if (!other) throw new Error("missing fixture pool");
  await expect(
    f.db
      .insert(schema.sharedBudgetReservations)
      .values({
        orgId: f.org.id,
        poolId: other.id,
        routeId: route.id,
        amountNanoUsd: 1,
      })
      .execute(),
  ).rejects.toThrow();
});

test("approval identity, action hash and pool ceiling cannot be changed or reused", async () => {
  f = await setup();
  const pool = await enablePool(10);
  const gateway = createModelGateway({
    db: f.db,
    keyWrappers: [f.keyWrapper],
    platformCredentials: noPlatformCredentials,
    providers: { anthropic: f.provider },
    sharedBudgetRequired: true,
    sharedBudgetTransports: {
      anthropic: {
        identify: async () => ({ namespace: "billing:synthetic", account: "acct:fixture", pool: "billing:fixture" }),
        qualifies: () => true,
        bound: () => 10,
        stream: async (p, r, o) => p.stream(r, o),
      },
    },
  });
  const [approval] = await f.db.select().from(schema.approvals).where(eq(schema.approvals.orgId, f.org.id));
  if (!approval) throw new Error("missing fixture approval");
  await f.db
    .update(schema.approvals)
    .set({ decidedByUserId: "different-owner" })
    .where(eq(schema.approvals.id, approval.id));
  await expect(agentCall(gateway)).rejects.toThrow("shared budget");
  await f.db
    .update(schema.approvals)
    .set({ decidedByUserId: approval.decidedByUserId, actionHash: "forged" })
    .where(eq(schema.approvals.id, approval.id));
  await expect(agentCall(gateway)).rejects.toThrow("shared budget");
  await f.db
    .update(schema.approvals)
    .set({ actionHash: approval.actionHash })
    .where(eq(schema.approvals.id, approval.id));
  await f.db
    .update(schema.sharedBudgetPools)
    .set({ ceilingNanoUsd: 11 })
    .where(eq(schema.sharedBudgetPools.id, pool.id));
  await expect(agentCall(gateway)).rejects.toThrow("shared budget");
  expect(f.provider.calls).toHaveLength(0);
});

test("required mode cannot be disabled by mutating the gateway dependency object", async () => {
  f = await setup();
  const deps = {
    db: f.db,
    keyWrappers: [f.keyWrapper],
    platformCredentials: noPlatformCredentials,
    providers: { anthropic: f.provider },
    sharedBudgetRequired: true,
  };
  const gateway = createModelGateway(deps);
  deps.sharedBudgetRequired = false;
  await expect(agentCall(gateway)).rejects.toThrow("shared budget");
  expect(f.provider.calls).toHaveLength(0);
});

test("legacy gateway works before the shared budget migration exists", async () => {
  f = await setup();
  await f.db.execute(sql`drop table shared_budget_policies`);
  await agentCall(f.gateway);
  expect(f.provider.calls).toHaveLength(1);
});

test("required mode never calls a provider to verify unsaved or stored keys", async () => {
  f = await setup();
  const gateway = createModelGateway({
    db: f.db,
    keyWrappers: [f.keyWrapper],
    platformCredentials: noPlatformCredentials,
    providers: { anthropic: f.provider },
    sharedBudgetRequired: true,
  });
  expect(
    await gateway.verifyKey({ orgId: f.org.id, provider: "anthropic", key: { apiKey: "synthetic-only" } }),
  ).toEqual({ state: "unchecked" });
  expect((await gateway.verifyStoredKey(f.org.id, f.credential.id))?.result).toEqual({ state: "unchecked" });
  expect(f.provider.calls).toHaveLength(0);
});

test("required mode declines unbudgeted embedding without contacting provider", async () => {
  f = await setup();
  let calls = 0;
  const gateway = createModelGateway({
    db: f.db,
    keyWrappers: [f.keyWrapper],
    platformCredentials: noPlatformCredentials,
    providers: { anthropic: f.provider },
    sharedBudgetRequired: true,
    embeddings: {
      apiKey: "synthetic",
      provider: {
        id: "fake",
        model: "fake",
        embed: async () => {
          calls++;
          return { model: "fake", tokens: 1, vectors: [[0]] };
        },
      },
    },
  });
  expect(await gateway.embed({ orgId: f.org.id, texts: ["test"], inputType: "query" })).toBeNull();
  expect(calls).toBe(0);
});

test("rotating a credential in place invalidates its previously approved route", async () => {
  f = await setup();
  await enablePool(10);
  const gateway = createModelGateway({
    db: f.db,
    keyWrappers: [f.keyWrapper],
    platformCredentials: noPlatformCredentials,
    providers: { anthropic: f.provider },
    sharedBudgetRequired: true,
    sharedBudgetTransports: {
      anthropic: {
        identify: async () => ({ namespace: "billing:synthetic", account: "acct:fixture", pool: "billing:fixture" }),
        qualifies: () => true,
        bound: () => 10,
        stream: async (p, r, o) => ({ ...(await p.stream(r, o)), costNanoUsd: 1 }),
      },
    },
  });
  await rotateCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, f.credential.id, { apiKey: "sk-ant-synthetic-new" });
  await expect(agentCall(gateway)).rejects.toThrow("shared budget");
  expect(f.provider.calls).toHaveLength(0);
});

test("a duplicate canonical upstream pool cannot acquire a second budget ceiling", async () => {
  f = await setup();
  const pool = await enablePool(10);
  const same = {
    orgId: f.org.id,
    windowStart: pool.windowStart,
    windowEnd: pool.windowEnd,
    approvalUntil: pool.approvalUntil,
    approvedBy: pool.approvedBy,
    approvalRef: pool.approvalRef,
    ceilingNanoUsd: 10,
    upstreamProvider: "billing:synthetic",
    upstreamAccount: "acct:fixture",
    upstreamPool: "billing:fixture",
  };
  await f.db
    .update(schema.sharedBudgetPools)
    .set({ upstreamProvider: "billing:synthetic", upstreamAccount: "acct:fixture", upstreamPool: "billing:fixture" } as never)
    .where(eq(schema.sharedBudgetPools.id, pool.id));
  await expect(
    f.db
      .insert(schema.sharedBudgetPools)
      .values(same as never)
      .execute(),
  ).rejects.toThrow();
});

test("credential rotated after resolution is rejected under its database row lock", async () => {
  f = await setup();
  await enablePool(10);
  let rotated = false;
  const gateway = createModelGateway({
    db: f.db,
    keyWrappers: [f.keyWrapper],
    platformCredentials: noPlatformCredentials,
    providers: { anthropic: f.provider },
    sharedBudgetRequired: true,
    sharedBudgetTransports: {
      anthropic: {
        identify: async () => {
          if (!rotated) {
            rotated = true;
            await rotateCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, f.credential.id, {
              apiKey: "sk-ant-replacement-key",
            });
          }
          return { namespace: "billing:synthetic", account: "acct:fixture", pool: "billing:fixture" };
        },
        qualifies: () => true,
        bound: () => 10,
        stream: async (p, r, o) => ({ ...(await p.stream(r, o)), costNanoUsd: 1 }),
      },
    },
  });
  await expect(agentCall(gateway)).rejects.toThrow("shared budget");
  expect(rotated).toBe(true);
  expect(f.provider.calls).toHaveLength(0);
});

test("mismatched upstream identity rejects before provider dispatch", async () => {
  f = await setup();
  await enablePool(10);
  const gateway = createModelGateway({
    db: f.db,
    keyWrappers: [f.keyWrapper],
    platformCredentials: noPlatformCredentials,
    providers: { anthropic: f.provider },
    sharedBudgetRequired: true,
    sharedBudgetTransports: {
      anthropic: {
        identify: async () => ({ namespace: "billing:synthetic", account: "different-account", pool: "billing:fixture" }),
        qualifies: () => true,
        bound: () => 10,
        stream: async (p, r, o) => ({ ...(await p.stream(r, o)), costNanoUsd: 1 }),
      },
    },
  });
  await expect(agentCall(gateway)).rejects.toThrow("shared budget");
  expect(f.provider.calls).toHaveLength(0);
});

test("unqualified model output is not streamed to the consumer", async () => {
  f = await setup();
  await enablePool(10);
  const received: string[] = [];
  const gateway = createModelGateway({
    db: f.db,
    keyWrappers: [f.keyWrapper],
    platformCredentials: noPlatformCredentials,
    providers: { anthropic: f.provider },
    sharedBudgetRequired: true,
    sharedBudgetTransports: {
      anthropic: {
        identify: async () => ({ namespace: "billing:synthetic", account: "acct:fixture", pool: "billing:fixture" }),
        qualifies: () => true,
        bound: () => 10,
        stream: async (p, r, o) => {
          o.onDelta("unqualified");
          return { ...(await p.stream(r, { ...o, onDelta: () => {} })), model: "other-model", costNanoUsd: 1 };
        },
      },
    },
  });
  await expect(
    gateway.stream({
      orgId: f.org.id,
      agentId: f.agent.id,
      dataClass: "fixture",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 10,
      onDelta: (s) => received.push(s),
    }),
  ).rejects.toThrow("shared budget");
  expect(received).toEqual([]);
});

test("images, opaque history and structured output remain unqualified", async () => {
  f = await setup();
  await enablePool(10);
  const gateway = createModelGateway({
    db: f.db,
    keyWrappers: [f.keyWrapper],
    platformCredentials: noPlatformCredentials,
    providers: { anthropic: f.provider },
    sharedBudgetRequired: true,
    sharedBudgetTransports: {
      anthropic: {
        identify: async () => ({ namespace: "billing:synthetic", account: "acct:fixture", pool: "billing:fixture" }),
        qualifies: () => true,
        bound: () => 10,
        stream: async (p, r, o) => ({ ...(await p.stream(r, o)), costNanoUsd: 1 }),
      },
    },
  });
  for (const content of [
    [
      {
        type: "tool_result",
        toolUseId: "x",
        content: "",
        images: [{ mediaType: "application/pdf", data: "dGVzdA==", pages: 1 }],
      },
    ],
    [{ type: "opaque", provider: "anthropic", data: {} }],
    [{ type: "unrecognized_media", data: "opaque" }],
  ] as const) {
    await expect(
      gateway.stream({
        orgId: f.org.id,
        agentId: f.agent.id,
        dataClass: "fixture",
        system: "sys",
        messages: [{ role: "user", content: content as never }],
        maxTokens: 10,
        onDelta: () => {},
      }),
    ).rejects.toThrow("shared budget");
  }
  await expect(
    gateway.complete({
      orgId: f.org.id,
      kind: "summary",
      model: "claude-sonnet-5-5",
      dataClass: "fixture",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 10,
      outputSchema: { type: "object" },
    }),
  ).rejects.toThrow("shared budget");
  expect(f.provider.calls).toHaveLength(0);
});

test("two distinct credentials for the same verified upstream pool share one atomic ceiling", async () => {
  f = await setup();
  const pool = await enablePool(10);
  const credential2 = await createCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, {
    provider: "anthropic",
    label: "second",
    apiKey: "sk-ant-synthetic-second",
  });
  const agent2 = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Second", handle: "second", role: "Developer", instructions: "Test", credentialId: credential2.id },
    { model: "claude-sonnet-5-5" },
  );
  const [row2] = await f.db
    .select()
    .from(schema.providerCredentials)
    .where(eq(schema.providerCredentials.id, credential2.id));
  if (!row2) throw new Error("missing credential");
  const at = Date.now();
  await f.db.insert(schema.sharedBudgetRoutes).values({
    orgId: f.org.id,
    poolId: pool.id,
    provider: "anthropic",
    credentialId: credential2.id,
    credentialVersion: credentialVersion(row2),
    model: "claude-sonnet-5-5",
    subject: `agent:${agent2.id}`,
    dataClass: "fixture",
    supportsTools: false,
    maxPromptBytes: 100000,
    evidenceRef: "synthetic-test-only",
    verifiedAt: new Date(at - 1000),
    validUntil: new Date(at + 3600000),
    enabled: true,
  });
  const routes = await f.db
    .select()
    .from(schema.sharedBudgetRoutes)
    .where(eq(schema.sharedBudgetRoutes.poolId, pool.id));
  const params = sharedBudgetApprovalParams(pool, routes);
  const [approval] = await f.db.select().from(schema.approvals).where(eq(schema.approvals.orgId, f.org.id));
  if (!approval) throw new Error("missing fixture approval");
  await f.db
    .update(schema.approvals)
    .set({ params, actionHash: sharedBudgetApprovalHash(params) })
    .where(eq(schema.approvals.id, approval.id));
  const gate = Promise.withResolvers<void>();
  let started = 0;
  const gateway = createModelGateway({
    db: f.db,
    keyWrappers: [f.keyWrapper],
    platformCredentials: noPlatformCredentials,
    providers: { anthropic: f.provider },
    sharedBudgetRequired: true,
    sharedBudgetTransports: {
      anthropic: {
        identify: async () => ({ namespace: "billing:synthetic", account: "acct:fixture", pool: "billing:fixture" }),
        qualifies: () => true,
        bound: () => 10,
        stream: async (p, r, o) => {
          started++;
          await gate.promise;
          return { ...(await p.stream(r, o)), costNanoUsd: 4 };
        },
      },
    },
  });
  const other = gateway.stream({
    orgId: f.org.id,
    agentId: agent2.id,
    dataClass: "fixture",
    system: "sys",
    messages: [{ role: "user", content: "hello" }],
    maxTokens: 10,
    onDelta: () => {},
  });
  const pending = Promise.allSettled([agentCall(gateway), other]);
  await Bun.sleep(120);
  gate.resolve();
  const results = await pending;
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  expect(started).toBe(1);
  const [after] = await f.db.select().from(schema.sharedBudgetPools).where(eq(schema.sharedBudgetPools.id, pool.id));
  expect(after).toMatchObject({ spentNanoUsd: 4, heldNanoUsd: 0 });
});

test("two execution providers mapped to one verified billing namespace share one atomic ceiling", async () => {
  f = await setup();
  const pool = await enablePool(10);
  const credential2 = await createCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, {
    provider: "gemini",
    label: "second",
    apiKey: "AQ.synthetic-second-key",
  });
  const agent2 = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Second", handle: "second", role: "Developer", instructions: "Test", credentialId: credential2.id },
    { model: "gemini-4-argon" },
  );
  const [row2] = await f.db
    .select()
    .from(schema.providerCredentials)
    .where(eq(schema.providerCredentials.id, credential2.id));
  if (!row2) throw new Error("missing credential");
  const at = Date.now();
  await f.db.insert(schema.sharedBudgetRoutes).values({
    orgId: f.org.id,
    poolId: pool.id,
    provider: "gemini",
    credentialId: credential2.id,
    credentialVersion: credentialVersion(row2),
    model: "gemini-4-argon",
    subject: `agent:${agent2.id}`,
    dataClass: "fixture",
    supportsTools: false,
    maxPromptBytes: 100000,
    evidenceRef: "synthetic-test-only",
    verifiedAt: new Date(at - 1000),
    validUntil: new Date(at + 3600000),
    enabled: true,
  });
  const routes = await f.db
    .select()
    .from(schema.sharedBudgetRoutes)
    .where(eq(schema.sharedBudgetRoutes.poolId, pool.id));
  const params = sharedBudgetApprovalParams(pool, routes);
  const [approval] = await f.db.select().from(schema.approvals).where(eq(schema.approvals.orgId, f.org.id));
  if (!approval) throw new Error("missing fixture approval");
  await f.db
    .update(schema.approvals)
    .set({ params, actionHash: sharedBudgetApprovalHash(params) })
    .where(eq(schema.approvals.id, approval.id));
  const gate = Promise.withResolvers<void>();
  let started = 0;
  const gateway = createModelGateway({
    db: f.db,
    keyWrappers: [f.keyWrapper],
    platformCredentials: noPlatformCredentials,
    providers: { anthropic: f.provider, gemini: f.provider },
    sharedBudgetRequired: true,
    sharedBudgetTransports: {
      anthropic: {
        identify: async () => ({ namespace: "billing:synthetic", account: "acct:fixture", pool: "billing:fixture" }),
        qualifies: () => true,
        bound: () => 10,
        stream: async (p, r, o) => {
          started++;
          await gate.promise;
          return { ...(await p.stream(r, o)), costNanoUsd: 0 };
        },
      },
      gemini: {
        identify: async () => ({ namespace: "billing:synthetic", account: "acct:fixture", pool: "billing:fixture" }),
        qualifies: () => true,
        bound: () => 10,
        stream: async (p, r, o) => {
          started++;
          await gate.promise;
          return { ...(await p.stream(r, o)), costNanoUsd: 0 };
        },
      },
    },
  });
  const other = gateway.stream({
    orgId: f.org.id,
    agentId: agent2.id,
    dataClass: "fixture",
    system: "sys",
    messages: [{ role: "user", content: "hello" }],
    maxTokens: 10,
    onDelta: () => {},
  });
  const pending = Promise.allSettled([agentCall(gateway), other]);
  await Bun.sleep(120);
  gate.resolve();
  const results = await pending;
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  const rejected = results.find((r) => r.status === "rejected");
  expect(rejected && rejected.status === "rejected" ? String(rejected.reason) : "").toContain("shared budget");
  expect(started).toBe(1);
  // The loser must be independently admissible when capacity is free, proving that rejection was not a bad route.
  await (results[0]?.status === "rejected" ? agentCall(gateway) : gateway.stream({
    orgId: f.org.id, agentId: agent2.id, dataClass: "fixture", system: "sys",
    messages: [{ role: "user", content: "hello" }], maxTokens: 10, onDelta: () => {},
  }));
  expect(started).toBe(2);
  const [after] = await f.db.select().from(schema.sharedBudgetPools).where(eq(schema.sharedBudgetPools.id, pool.id));
  expect(after).toMatchObject({ spentNanoUsd: 0, heldNanoUsd: 0 });
});


test("admission snapshots the exact request and identity lookup receives no key or callback", async () => {
  f = await setup();
  await enablePool(10);
  const messages: { role: "user"; content: string }[] = [{ role: "user", content: "qualified original" }];
  const received: string[] = [];
  let dispatched = "";
  const gateway = createModelGateway({
    db: f.db,
    keyWrappers: [f.keyWrapper],
    platformCredentials: noPlatformCredentials,
    providers: { anthropic: f.provider },
    sharedBudgetRequired: true,
    sharedBudgetTransports: {
      anthropic: {
        identify: async (o) => {
          messages[0]!.content = "mutated after resolution";
          expect(Object.keys(o).sort()).toEqual(["credentialId", "credentialVersion", "provider"]);
          return { namespace: "billing:synthetic", account: "acct:fixture", pool: "billing:fixture" };
        },
        qualifies: (r) => r.messages[0]?.content === "qualified original",
        bound: () => 10,
        stream: async (p, r, o) => {
          dispatched = String(r.messages[0]?.content);
          return { ...(await p.stream(r, o)), costNanoUsd: 1 };
        },
      },
    },
  });
  await gateway.stream({
    orgId: f.org.id,
    agentId: f.agent.id,
    dataClass: "fixture",
    system: "sys",
    messages,
    maxTokens: 10,
    onDelta: (s) => received.push(s),
  });
  expect(dispatched).toBe("qualified original");
  expect(received.join("")).not.toContain("identity leak");
});

test("qualification cannot mutate the request model after snapshot", async () => {
  f = await setup();
  await enablePool(10);
  const gateway = createModelGateway({
    db: f.db,
    keyWrappers: [f.keyWrapper],
    platformCredentials: noPlatformCredentials,
    providers: { anthropic: f.provider },
    sharedBudgetRequired: true,
    sharedBudgetTransports: {
      anthropic: {
        identify: async () => ({ namespace: "billing:synthetic", account: "acct:fixture", pool: "billing:fixture" }),
        qualifies: (r) => {
          (r as { model: string }).model = "other-model";
          return true;
        },
        bound: () => 10,
        stream: async (p, r, o) => ({ ...(await p.stream(r, o)), costNanoUsd: 1 }),
      },
    },
  });
  await expect(agentCall(gateway)).rejects.toThrow();
  expect(f.provider.calls).toHaveLength(0);
});

test("endpoint changed after resolution invalidates the credential before dispatch", async () => {
  f = await setup();
  await enablePool(10);
  let changed = false;
  const gateway = createModelGateway({
    db: f.db,
    keyWrappers: [f.keyWrapper],
    platformCredentials: noPlatformCredentials,
    providers: { anthropic: f.provider },
    sharedBudgetRequired: true,
    sharedBudgetTransports: {
      anthropic: {
        identify: async () => {
          if (!changed) {
            changed = true;
            await f.db
              .update(schema.providerCredentials)
              .set({
                options: { endpoint: { style: "openai", baseURL: "https://changed.invalid/v1", models: [] } } as never,
              })
              .where(eq(schema.providerCredentials.id, f.credential.id));
          }
          return { namespace: "billing:synthetic", account: "acct:fixture", pool: "billing:fixture" };
        },
        qualifies: () => true,
        bound: () => 10,
        stream: async (p, r, o) => ({ ...(await p.stream(r, o)), costNanoUsd: 1 }),
      },
    },
  });
  await expect(agentCall(gateway)).rejects.toThrow("shared budget");
  expect(changed).toBe(true);
  expect(f.provider.calls).toHaveLength(0);
});
