import { afterEach, expect, test } from "bun:test";
import { noPlatformCredentials } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import { createModelGateway } from "../src";
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
  await expect(
    f.gateway.stream({
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
      ceilingNanoUsd,
    })
    .returning();
  if (!pool) throw new Error("missing fixture pool");
  for (const subject of [`agent:${f.agent.id}`, "org:summary"]) {
    await f.db.insert(schema.sharedBudgetRoutes).values({
      orgId: f.org.id,
      poolId: pool.id,
      provider: "anthropic",
      credentialId: f.credential.id,
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
    sharedBudgetTransports: {
      anthropic: {
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
    sharedBudgetTransports: {
      anthropic: {
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
  });
  await expect(agentCall(withoutTransport)).rejects.toThrow("shared budget");
  const capped = createModelGateway({
    db: f.db,
    keyWrappers: [f.keyWrapper],
    platformCredentials: noPlatformCredentials,
    providers: { anthropic: f.provider },
    sharedBudgetTransports: { anthropic: { bound: () => 10, stream: async (p, r, o) => p.stream(r, o) } },
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
    sharedBudgetTransports: { anthropic: { bound: () => 10, stream: async (p, r, o) => p.stream(r, o) } },
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
    sharedBudgetTransports: { anthropic: { bound: () => 10, stream: async (p, r, o) => p.stream(r, o) } },
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
    sharedBudgetTransports: {
      anthropic: {
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
    sharedBudgetTransports: { anthropic: { bound: () => 10, stream: async (p, r, o) => p.stream(r, o) } },
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
