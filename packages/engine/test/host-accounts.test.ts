import { afterEach, expect, test } from "bun:test";
import { HOST_ANTIGRAVITY_PROTOCOL, parseAccounts, parseExecutors } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import { setAccountServes } from "../src/brain-settings";
import { planIsOwners } from "../src/brains/select";
import { beginAccountLogin, syncMachineAccounts } from "../src/machine-accounts";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});
const id = "0193dddd-0000-4000-8000-000000000071";
const host = { id, kind: "antigravity" as const, provider: "host-macos", loggedIn: true, shared: true };
async function machine() {
  const p = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, {
    name: "mac",
    hostname: "mac",
    os: "darwin",
    arch: "arm64",
    version: "test",
    workspace: "/tmp",
    protocol: HOST_ANTIGRAVITY_PROTOCOL,
    exec: true,
  });
  await f.db
    .update(schema.machines)
    .set({
      protocol: HOST_ANTIGRAVITY_PROTOCOL,
      os: "darwin",
      executors: { antigravity: { version: "test", hostAuth: true } },
    })
    .where(eq(schema.machines.id, p.machineId));
  return p.machineId;
}
const sync = (machineId: string, accounts = [host]) => syncMachineAccounts({ db: f.db }, f.org.id, machineId, accounts);
async function row() {
  return (await f.db.select().from(schema.machineAccounts).where(eq(schema.machineAccounts.id, id)))[0];
}

test("protocol preserves only explicit host capability and account provider", () => {
  expect(parseExecutors({ antigravity: { version: "1", hostAuth: true } }).antigravity?.hostAuth).toBe(true);
  expect(parseExecutors({ antigravity: { version: "1", hostAuth: "true" } }).antigravity?.hostAuth).toBeUndefined();
  expect(parseAccounts([host])[0]?.provider).toBe("host-macos");
});

test("a remote account.begin cannot opt in host authentication", async () => {
  await expect(
    beginAccountLogin({} as never, "u", "o", "m", "antigravity", undefined, undefined, "host-macos"),
  ).rejects.toMatchObject({ code: "account.invalid_plan" });
});

test("runner reports a host account only on a capable paired single-user Mac", async () => {
  f = await setup();
  const m = await machine();
  for (const patch of [
    { protocol: HOST_ANTIGRAVITY_PROTOCOL - 1 },
    { os: "linux" },
    { pairedByUserId: null },
    { executors: { antigravity: { version: "test" } } },
    { executors: { mode: "system" as const, antigravity: { version: "test", hostAuth: true as const } } },
  ]) {
    await f.db
      .update(schema.machines)
      .set({
        protocol: HOST_ANTIGRAVITY_PROTOCOL,
        os: "darwin",
        pairedByUserId: f.owner.id,
        executors: { antigravity: { version: "test", hostAuth: true } },
        ...patch,
      })
      .where(eq(schema.machines.id, m));
    await sync(m);
    expect(await row()).toBeUndefined();
  }
  await f.db
    .update(schema.machines)
    .set({
      protocol: HOST_ANTIGRAVITY_PROTOCOL,
      os: "darwin",
      pairedByUserId: f.owner.id,
      executors: { antigravity: { version: "test", hostAuth: true } },
    })
    .where(eq(schema.machines.id, m));
  await sync(m);
  expect(await row()).toMatchObject({
    provider: "host-macos",
    createdBy: f.owner.id,
    status: "active",
    shared: true,
    serves: "owner",
  });
  await expect(setAccountServes({ db: f.db }, f.owner.id, f.org.id, id, "everyone")).rejects.toMatchObject({
    code: "account.not_owner",
  });
  // An account created before the new `serves` field must also be restricted on upgrade.
  await f.db.update(schema.machineAccounts).set({ serves: "everyone" }).where(eq(schema.machineAccounts.id, id));
  await sync(m);
  expect(await row()).toMatchObject({ serves: "owner" });
  await sync(m, []);
  expect(await row()).toMatchObject({ createdBy: f.owner.id, status: "signed_out" });
  await f.db
    .update(schema.machines)
    .set({ executors: { antigravity: { version: "test" } } })
    .where(eq(schema.machines.id, m));
  expect(await planIsOwners(f.db, { orgId: f.org.id, ownerUserId: f.owner.id }, m, { id })).toBe(false);
});

test("host accounts cannot be lent, survive owner changes, or run without capability", async () => {
  f = await setup();
  const m = await machine();
  await sync(m);
  const other = await addMember(f.db, f.org.id, "member", "other");
  const agent = { orgId: f.org.id, ownerUserId: f.owner.id, brainAccountId: id, brainAccountLentBy: null };
  expect(await planIsOwners(f.db, agent, m, { id })).toBe(true);
  expect(await planIsOwners(f.db, { ...agent, ownerUserId: other.id, brainAccountLentBy: f.owner.id }, m, { id })).toBe(
    false,
  );
  await f.db.update(schema.machines).set({ pairedByUserId: other.id }).where(eq(schema.machines.id, m));
  expect(await planIsOwners(f.db, agent, m, { id })).toBe(false);
  await sync(m);
  expect(await row()).toMatchObject({ createdBy: f.owner.id, status: "signed_out" });
  await sync(m);
  expect(await row()).toMatchObject({ createdBy: f.owner.id, status: "signed_out" });
});
