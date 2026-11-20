import { afterEach, expect, test } from "bun:test";
import type { PlanUsage, RunnerAccountInfo } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import { storeOwnUsage, syncMachineAccounts } from "../src/machine-accounts";
import { type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

let f: Fixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

test.each(["account", "own"] as const)(
  "a Grok turn refusal survives inconclusive %s snapshots until a newer measured reading",
  async (signIn) => {
    const fx = await setup();
    f = fx;
    const { machineId } = await pairMachine(fx, fx.owner.id, fx.org.id, { protocol: 62, exec: true });
    const accountId = crypto.randomUUID();
    const now = Date.now();
    const refused: PlanUsage = {
      source: "turn",
      limited: true,
      windows: [],
      at: new Date(now - 10 * 60_000).toISOString(),
    };
    const report = async (usage?: PlanUsage) => {
      if (signIn === "own") {
        await storeOwnUsage(fx, fx.org.id, machineId, usage ? { grok: usage } : {});
      } else {
        const account: RunnerAccountInfo = {
          id: accountId,
          kind: "grok",
          loggedIn: true,
          ...(usage ? { usage } : {}),
        };
        await syncMachineAccounts(fx, fx.org.id, machineId, [account]);
      }
    };
    const stored = async () => {
      if (signIn === "own") {
        const [row] = await fx.db.select().from(schema.machines).where(eq(schema.machines.id, machineId));
        return row?.executors?.ownUsage?.grok;
      }
      const [row] = await fx.db.select().from(schema.machineAccounts).where(eq(schema.machineAccounts.id, accountId));
      return row?.usage;
    };
    await report(refused);
    await report();
    expect(await stored()).toEqual(refused);
    const measured: PlanUsage = {
      source: "probe",
      at: new Date(now - 60_000).toISOString(),
      windows: [{ kind: "other", usedPercent: 20 }],
    };
    for (const inconclusive of [
      { source: "probe" as const, at: measured.at, windows: [] },
      { source: "turn" as const, at: measured.at, windows: [] },
      { ...measured, at: refused.at },
      { ...measured, at: "invalid" },
      { ...measured, at: new Date(now + 60_000).toISOString() },
    ]) {
      await report(inconclusive);
      expect(await stored()).toEqual(refused);
    }
    const laterRefusal = { ...refused, at: new Date(now - 2 * 60_000).toISOString() };
    await report(laterRefusal);
    expect(await stored()).toEqual(laterRefusal);
    await report(measured);
    expect(await stored()).toEqual(measured);
  },
  30_000,
);

test("a re-paired Grok account retains its actual refusal when the new runner has no measurement", async () => {
  const fx = await setup();
  f = fx;
  const previous = await pairMachine(fx, fx.owner.id, fx.org.id);
  const replacement = await pairMachine(fx, fx.owner.id, fx.org.id);
  const accountId = crypto.randomUUID();
  const now = Date.now();
  const refused: PlanUsage = {
    source: "turn",
    limited: true,
    windows: [],
    at: new Date(now - 10 * 60_000).toISOString(),
  };
  await syncMachineAccounts(fx, fx.org.id, previous.machineId, [
    { id: accountId, kind: "grok", loggedIn: true, usage: refused },
  ]);
  await fx.db
    .update(schema.machines)
    .set({ deletedAt: new Date(now) })
    .where(eq(schema.machines.id, previous.machineId));
  await syncMachineAccounts(fx, fx.org.id, replacement.machineId, [
    {
      id: accountId,
      kind: "grok",
      loggedIn: true,
      usage: { source: "probe", at: new Date(now).toISOString(), windows: [] },
    },
  ]);
  const [row] = await fx.db.select().from(schema.machineAccounts).where(eq(schema.machineAccounts.id, accountId));
  expect(row).toMatchObject({ machineId: replacement.machineId, usage: refused });
}, 30_000);
