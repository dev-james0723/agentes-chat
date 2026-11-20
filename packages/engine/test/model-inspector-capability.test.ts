import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { storeMachineExecutors } from "../src/machine-access";
import type { MachineHub } from "../src/machine-hub";
import { type Fixture, setup } from "./fixtures";
import { fakeRunner, pairMachine } from "./machine-fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

test("an older executors.changed payload removes prior concrete native model capability", async () => {
  f = await setup();
  const { machineId } = await pairMachine({ db: f.db }, f.owner.id, f.org.id);
  await storeMachineExecutors({ db: f.db }, machineId, { taskModels: true, codex: { version: "0.163.0" } });
  const [before] = await f.db.select().from(schema.machines).where(eq(schema.machines.id, machineId));
  expect(before?.executors?.taskModels).toBe(true);
  await storeMachineExecutors({ db: f.db }, machineId, { codex: { version: "0.163.0" } });
  const [after] = await f.db.select().from(schema.machines).where(eq(schema.machines.id, machineId));
  expect(after?.executors?.taskModels).toBeUndefined();
  expect(after?.executors?.codex?.version).toBe("0.163.0");
}, 30000);

test("a reconnect without executor or platform metadata clears prior concrete native model capability", async () => {
  f = await setup({ machines: true });
  const paired = await pairMachine({ db: f.db }, f.owner.id, f.org.id);
  await f.db
    .update(schema.machines)
    .set({ executors: { taskModels: true, codex: { version: "0.163.0" } } })
    .where(eq(schema.machines.id, paired.machineId));
  await fakeRunner(f.machineHub as MachineHub).hello(paired.token);
  const [row] = await f.db.select().from(schema.machines).where(eq(schema.machines.id, paired.machineId));
  expect(row?.online).toBe(true);
  expect(row?.executors?.taskModels).toBeUndefined();
  expect(row?.executors?.codex?.version).toBe("0.163.0");
}, 30000);
