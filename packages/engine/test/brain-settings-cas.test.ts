import { afterEach, expect, spyOn, test } from "bun:test";
import { ACCOUNTS_PROTOCOL } from "@agenteschat/adapters";
import { eq, schema, sql } from "@agenteschat/db";
import { ConflictError, ForbiddenError, getAgentBrain, setAgentBrain } from "../src";
import { caches } from "../src/cache";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});
const extra = (value: unknown) => value as Parameters<typeof setAgentBrain>[4];
async function world() {
  f = await setup();
  const paired = await pairMachine({ db: f.db }, f.owner.id, f.org.id, {
    name: "CAS mac",
    protocol: ACCOUNTS_PROTOCOL,
    exec: true,
  });
  await f.db
    .update(schema.machines)
    .set({ executors: { claude: { version: "2.1.304", loggedIn: true }, detectedAt: new Date().toISOString() } })
    .where(eq(schema.machines.id, paired.machineId));
  await f.db
    .update(schema.agents)
    .set({ machineId: paired.machineId, brainFallback: true, brainExtraUsage: true })
    .where(eq(schema.agents.id, f.agent.id));
  await f.db
    .insert(schema.organizationSettings)
    .values({ orgId: f.org.id, agentSetup: { brain: "model", model: "claude-sonnet-5-5" } })
    .onConflictDoUpdate({
      target: schema.organizationSettings.orgId,
      set: { agentSetup: { brain: "model", model: "claude-sonnet-5-5" } },
    });
  return { machineId: paired.machineId };
}
const view = () => getAgentBrain({ db: f.db }, f.owner.id, f.org.id, f.agent.id);
const token = async () =>
  ((await view()) as Awaited<ReturnType<typeof getAgentBrain>> & { configHash?: string | null }).configHash ??
  "0".repeat(64);
const change = (input: unknown, db = f.db, actor = f.owner.id, options = { remember: false }) =>
  setAgentBrain({ db }, actor, f.org.id, f.agent.id, extra(input), options);
async function state() {
  return {
    agent: await f.db.select().from(schema.agents).where(eq(schema.agents.id, f.agent.id)),
    accounts: await f.db.select().from(schema.machineAccounts),
    defaults: await f.db.select().from(schema.organizationSettings),
    audits: await f.db.select().from(schema.auditLog),
    outbox: await f.db.select().from(schema.outbox),
    notifications: await f.db.select().from(schema.notifications),
  };
}

test("GET hash is opaque/stable under volatile usage and changes with raw stable config", async () => {
  const { machineId } = await world();
  const first = await token();
  expect(first).toMatch(/^[a-f0-9]{64}$/);
  expect(first).not.toBe("0".repeat(64));
  await f.db
    .update(schema.machines)
    .set({
      lastSeenAt: new Date(0),
      executors: { ownUsage: { codex: { at: new Date().toISOString(), source: "turn", windows: [] } } },
    })
    .where(eq(schema.machines.id, machineId));
  expect(await token()).toBe(first);
  await f.db.update(schema.agents).set({ brainEffort: "high" }).where(eq(schema.agents.id, f.agent.id));
  expect(await token()).not.toBe(first);
});

test("stale and no-op stale guard reject before audit/default/account mutations", async () => {
  await world();
  const original = await token();
  await f.db.update(schema.agents).set({ brainEffort: "high" }).where(eq(schema.agents.id, f.agent.id));
  const before = await state();
  const invalidations = spyOn(caches.agents, "delete");
  try {
    for (const input of [{ fallback: false }, { effort: "high" }]) {
      await expect(change({ ...input, expectedConfigHash: original })).rejects.toBeInstanceOf(ConflictError);
      expect(await state()).toEqual(before);
    }
    expect(invalidations).not.toHaveBeenCalled();
  } finally {
    invalidations.mockRestore();
  }
});

test("fresh narrowing and exact restoration preserve seeded org defaults and unrelated fields", async () => {
  await world();
  const before = await state();
  await change({ fallback: false, extraUsage: false, expectedConfigHash: await token() });
  expect(await view()).toMatchObject({ fallback: false, extraUsage: false });
  await change({ fallback: true, extraUsage: true, expectedConfigHash: await token() });
  expect(await view()).toMatchObject({ fallback: true, extraUsage: true });
  expect((await state()).defaults).toEqual(before.defaults);
});

test("two guarded writers of the same version cannot both commit (local PGlite serialization only)", async () => {
  await world();
  const same = await token();
  const results = await Promise.allSettled([
    change({ effort: "low", expectedConfigHash: same }),
    change({ effort: "high", expectedConfigHash: same }),
  ]);
  expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  const rejected = results.find((x) => x.status === "rejected") as PromiseRejectedResult;
  expect(rejected.reason).toBeInstanceOf(ConflictError);
});

test("unsupported account transfer and right-hand scopes cannot mutate; old permissions remain", async () => {
  await world();
  const before = await state();
  await expect(change({ moveAccount: true, expectedConfigHash: await token() })).rejects.toBeInstanceOf(ConflictError);
  expect(await state()).toEqual(before);
  const member = await addMember(f.db, f.org.id, "member", "not-owner");
  await expect(change({ fallback: false, expectedConfigHash: await token() }, f.db, member.id)).rejects.toBeInstanceOf(
    ForbiddenError,
  );
  const admin = await addMember(f.db, f.org.id, "admin", "admin-not-plan-owner");
  await expect(change({ extraUsage: false }, f.db, admin.id)).rejects.toBeInstanceOf(ForbiddenError);
  await f.db.update(schema.agents).set({ builtin: "right_hand" }).where(eq(schema.agents.id, f.agent.id));
  const rightBefore = await state();
  for (const scope of ["workspace", "mine"]) {
    await expect(change({ scope, fallback: false, expectedConfigHash: "0".repeat(64) })).rejects.toBeInstanceOf(
      ConflictError,
    );
  }
  expect(await state()).toEqual(rightBefore);
});

test("omitting CAS keeps legacy remembering behavior", async () => {
  await world();
  const before = (await state()).defaults;
  await change({ fallback: false }, f.db, f.owner.id, { remember: true });
  expect((await state()).defaults).not.toEqual(before);
});

test("bound raw API route and audience fields invalidate a stale configuration token", async () => {
  await world();
  const first = await token();
  await f.db.update(schema.agents).set({ model: "gpt-6.1-sol" }).where(eq(schema.agents.id, f.agent.id));
  expect(await token()).not.toBe(first);
  const second = await token();
  await f.db
    .update(schema.agents)
    .set({ audienceUserIds: [f.owner.id] })
    .where(eq(schema.agents.id, f.agent.id));
  expect(await token()).not.toBe(second);
  const before = await state();
  await expect(change({ fallback: false, expectedConfigHash: first })).rejects.toBeInstanceOf(ConflictError);
  expect(await state()).toEqual(before);
});

test("failure in audit rolls back every guarded write and does not invalidate caches before commit", async () => {
  await world();
  const expectedConfigHash = await token();
  const before = await state();
  const intercept = (db: import("@agenteschat/db").Database): import("@agenteschat/db").Database =>
    new Proxy(db, {
      get(target, key) {
        if (key === "transaction")
          return (body: (tx: import("@agenteschat/db").Database) => unknown) =>
            target.transaction(async (tx) => body(intercept(tx as unknown as import("@agenteschat/db").Database)));
        if (key === "insert")
          return (table: unknown) => {
            if (table === schema.auditLog) throw new Error("synthetic-audit-stop");
            return target.insert(table as typeof schema.auditLog);
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const invalidations = spyOn(caches.agents, "delete");
  try {
    await expect(change({ fallback: false, expectedConfigHash }, intercept(f.db))).rejects.toThrow(
      "synthetic-audit-stop",
    );
    expect(await state()).toEqual(before);
    expect(invalidations).not.toHaveBeenCalled();
  } finally {
    invalidations.mockRestore();
  }
});

test("permissions revoked after preflight are rechecked inside the passed transaction", async () => {
  await world();
  const expectedConfigHash = await token();
  const before = await state();
  let first = true;
  const db = new Proxy(f.db, {
    get(target, key) {
      if (key === "transaction")
        return async (body: Parameters<typeof target.transaction>[0]) => {
          if (first) {
            first = false;
            await target.delete(schema.organizationMembers).where(eq(schema.organizationMembers.userId, f.owner.id));
          }
          return target.transaction(body);
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await expect(change({ fallback: false, expectedConfigHash }, db)).rejects.toBeInstanceOf(ForbiddenError);
  expect(await state()).toEqual(before);
});

test("guarded named-account requests cannot clear model usage, release another agent, audit or remember", async () => {
  const { machineId } = await world();
  const expectedConfigHash = await token();
  const id = crypto.randomUUID();
  await f.db.insert(schema.machineAccounts).values({
    id,
    orgId: f.org.id,
    machineId,
    kind: "claude_code",
    label: "Synthetic account",
    status: "active",
    createdBy: f.owner.id,
    usage: {
      at: new Date().toISOString(),
      source: "turn",
      windows: [],
      models: { "synthetic-model": { at: new Date().toISOString(), off: true } },
    },
  });
  const before = await state();
  await expect(change({ account: id, moveAccount: true, expectedConfigHash })).rejects.toBeInstanceOf(ConflictError);
  expect(await state()).toEqual(before);
  await f.db.update(schema.agents).set({ brainAccountId: id }).where(eq(schema.agents.id, f.agent.id));
  const assigned = await state();
  expect((await view()).configHash).toBeNull();
  await expect(change({ fallback: false, expectedConfigHash })).rejects.toBeInstanceOf(ConflictError);
  expect(await state()).toEqual(assigned);
});

test("guarded Codex to API to controlled Codex to exact original settings keeps the native API model/defaults", async () => {
  const { machineId } = await world();
  await f.db
    .update(schema.machines)
    .set({
      executors: {
        claude: { version: "2.1.304", loggedIn: true },
        codex: { version: "0.170.0" },
        detectedAt: new Date().toISOString(),
      },
    })
    .where(eq(schema.machines.id, machineId));
  await change({ brain: "codex", model: "gpt-6.1-sol", onlyOwner: false });
  const before = await state();
  const original = {
    brain: "codex",
    model: "gpt-6.1-sol",
    fallback: true,
    extraUsage: true,
    account: null,
    onlyOwner: false,
    effort: null,
    speed: "standard",
    contextTokens: null,
  };
  const controlled = { ...original, fallback: false, extraUsage: false };
  await change({ ...controlled, expectedConfigHash: await token() });
  await change({ ...controlled, brain: "model", model: null, expectedConfigHash: await token() });
  expect(await view()).toMatchObject({ brain: "model", fallback: false, extraUsage: false });
  await change({ ...controlled, expectedConfigHash: await token() });
  expect(await view()).toMatchObject({ brain: "codex", model: "gpt-6.1-sol", fallback: false, extraUsage: false });
  await change({ ...original, expectedConfigHash: await token() });
  expect(await view()).toMatchObject(original);
  const after = await state();
  const { updatedAt: _beforeTime, ...beforeConfig } = before.agent[0] as NonNullable<(typeof before.agent)[0]>;
  const { updatedAt: _afterTime, ...afterConfig } = after.agent[0] as NonNullable<(typeof after.agent)[0]>;
  expect(afterConfig).toEqual(beforeConfig);
  expect(after.defaults).toEqual(before.defaults);
  expect(f.provider.calls).toHaveLength(0);
});

test("a real SQL failure in guarded wake cannot return a success view for rolled-back settings", async () => {
  await world();
  const expectedConfigHash = await token();
  const before = await state();
  let injected = 0;
  const wrap = (db: import("@agenteschat/db").Database): import("@agenteschat/db").Database =>
    new Proxy(db, {
      get(target, key) {
        if (key === "transaction")
          return (body: (tx: import("@agenteschat/db").Database) => Promise<unknown>) =>
            target.transaction((tx) => body(wrap(tx as unknown as import("@agenteschat/db").Database)));
        if (key === "select")
          return (fields: unknown) => {
            if (fields && typeof fields === "object" && "waitId" in fields && "since" in fields) {
              return {
                from(table: unknown) {
                  expect(table).toBe(schema.agentRuns);
                  return {
                    where() {
                      return {
                        async limit() {
                          injected++;
                          return target.execute(sql`select 1 / 0 as synthetic_guarded_wake_failure`);
                        },
                      };
                    },
                  };
                },
              };
            }
            return target.select(fields as never);
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const invalidations = spyOn(caches.agents, "delete");
  try {
    await expect(
      change({ expectedConfigHash, fallback: false }, wrap(f.db), f.owner.id, { remember: true }),
    ).rejects.toThrow();
    expect(injected).toBe(1);
    expect(await state()).toEqual(before);
    expect(invalidations).not.toHaveBeenCalled();
  } finally {
    invalidations.mockRestore();
  }
});

test("omitted legacy update retains its late wake best-effort catch", async () => {
  await world();
  let injected = 0;
  const db = new Proxy(f.db, {
    get(target, key) {
      if (key === "select")
        return (fields: unknown) => {
          if (fields && typeof fields === "object" && "waitId" in fields && "since" in fields) {
            return {
              from() {
                return {
                  where() {
                    return {
                      async limit() {
                        injected++;
                        return target.execute(sql`select 1 / 0 as synthetic_legacy_wake_failure`);
                      },
                    };
                  },
                };
              },
            };
          }
          return target.select(fields as never);
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const result = await change({ fallback: false }, db);
  expect(injected).toBe(1);
  expect(result.fallback).toBe(false);
  expect((await state()).agent[0]?.brainFallback).toBe(false);
});
