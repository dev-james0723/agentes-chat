import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { createAgentRuns, insertMessage, wakeConversationForTask } from "../src";
import { type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

let f: Fixture;
afterEach(async () => f?.close());
async function task(threadRootId: string | null = null) {
  const { machineId } = await pairMachine({ db: f.db }, f.owner.id, f.org.id, { name: "fixture" });
  const [row] = await f.db
    .insert(schema.machineTasks)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      machineId,
      channelId: f.general.id,
      threadRootId,
      title: "fixture",
      executor: "shell",
      command: "",
      status: "done",
      exitCode: 0,
      endedAt: new Date(),
    })
    .returning();
  if (!row) throw new Error("missing fixture task");
  return row;
}

test("a created successor is recorded once without restarting the completed task", async () => {
  f = await setup();
  const row = await task();
  const woke = await wakeConversationForTask({ db: f.db }, row.id, { maxHops: 100 });
  expect(woke?.runs).toHaveLength(1);
  expect(woke?.message?.meta.machineTask).toMatchObject({
    continuation: { state: "created", runId: woke?.runs[0]?.id },
  });
  const [savedNotice] = await f.db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.id, woke?.message?.id ?? ""));
  expect(savedNotice?.meta.machineTask).toMatchObject({ continuation: { state: "created", runId: woke?.runs[0]?.id } });
  expect(await wakeConversationForTask({ db: f.db }, row.id, { maxHops: 100 })).toBeNull();
  expect((await f.db.select().from(schema.machineTasks).where(eq(schema.machineTasks.id, row.id)))[0]?.status).toBe(
    "done",
  );
});

test("concurrent callbacks preserve one notice and one successor", async () => {
  f = await setup();
  const row = await task();
  const attempts = await Promise.all([
    wakeConversationForTask({ db: f.db }, row.id, { maxHops: 100 }),
    wakeConversationForTask({ db: f.db }, row.id, { maxHops: 100 }),
  ]);
  expect(attempts.filter(Boolean)).toHaveLength(1);
  expect(await f.db.select().from(schema.agentRuns)).toHaveLength(1);
  const notices = (await f.db.select().from(schema.messages)).filter(
    (m) => (m.meta.machineTask as { id?: string } | undefined)?.id === row.id,
  );
  expect(notices).toHaveLength(1);
  expect(notices[0]?.meta.machineTask).toMatchObject({ continuation: { state: "created" } });
});

test("a joined active run is recorded as joined, not treated as missing", async () => {
  f = await setup();
  const trigger = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "person", userId: f.owner.id },
    body: "fixture",
  });
  const runs = await f.db.transaction((tx) => createAgentRuns(tx, trigger, [f.agent.id], "mention"));
  const active = runs[0];
  if (!active) throw new Error("missing active fixture run");
  const row = await task(trigger.id);
  const woke = await wakeConversationForTask({ db: f.db }, row.id, { maxHops: 100 });
  expect(woke?.runs).toEqual([]);
  expect(woke?.message?.meta.machineTask).toMatchObject({ continuation: { state: "joined", runId: active.id } });
  const [stored] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, active.id));
  expect(stored?.pendingMessageIds).toContain(woke?.message?.id);
});

test("a hop-limited callback is recorded as blocked without launching or retrying", async () => {
  f = await setup();
  const row = await task();
  const woke = await wakeConversationForTask({ db: f.db }, row.id, { maxHops: 1 });
  expect(woke?.runs).toEqual([]);
  expect(woke?.message?.meta.machineTask).toMatchObject({ continuation: { state: "blocked", reason: "hop_limit" } });
  expect(await f.db.select().from(schema.agentRuns)).toHaveLength(0);
  expect(await wakeConversationForTask({ db: f.db }, row.id, { maxHops: 100 })).toBeNull();
});

test("an ineligible agent leaves a blocked receipt and no successor", async () => {
  f = await setup();
  const row = await task();
  await f.db.update(schema.agents).set({ archivedAt: new Date() }).where(eq(schema.agents.id, f.agent.id));
  const woke = await wakeConversationForTask({ db: f.db }, row.id, { maxHops: 100 });
  expect(woke?.runs).toEqual([]);
  expect(woke?.message?.meta.machineTask).toMatchObject({
    continuation: { state: "blocked", reason: "agent_ineligible" },
  });
  expect(await f.db.select().from(schema.agentRuns)).toHaveLength(0);
});

test("an agent-canceled task is not restarted or turned into a successor", async () => {
  f = await setup();
  const row = await task();
  await f.db
    .update(schema.machineTasks)
    .set({ status: "canceled", canceledBy: `agent:${crypto.randomUUID()}` })
    .where(eq(schema.machineTasks.id, row.id));
  expect(await wakeConversationForTask({ db: f.db }, row.id, { maxHops: 100 })).toBeNull();
  expect(await f.db.select().from(schema.agentRuns)).toHaveLength(0);
  const [stored] = await f.db.select().from(schema.machineTasks).where(eq(schema.machineTasks.id, row.id));
  expect(stored?.status).toBe("canceled");
  expect(stored?.wokeAt).not.toBeNull();
});
