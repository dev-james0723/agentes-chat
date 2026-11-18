import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  addChannelMember,
  createChannel,
  indexSource,
  insertContextItem,
  insertMessage,
  makeTeamMemory,
  retrieveForRun,
} from "../src";
import { ForbiddenError } from "../src/errors";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

async function source(channelId = f.general.id) {
  const trigger = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId,
    author: { type: "person", userId: f.owner.id },
    body: "Check the Orion service.",
  });
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId,
      threadRootId: trigger.id,
      triggerMessageId: trigger.id,
      trigger: "mention",
      hop: 1,
      status: "done",
    })
    .returning();
  if (!run) throw new Error("missing run");
  const item = await insertContextItem(f.db, {
    orgId: f.org.id,
    agentId: f.agent.id,
    scopeType: "agent",
    scopeId: f.agent.id,
    kind: "fact",
    content: "Orion observed sentinel 493.",
    sourceIds: [run.id],
    channelIds: [],
    trust: "low",
    createdByKind: "agent",
    createdById: f.agent.id,
    evidence: [{ type: "self", ref: run.id, agentId: f.agent.id, at: new Date().toISOString() }],
  });
  await indexSource(f.context, { orgId: f.org.id, kind: "context_item", sourceId: item.id });
  return { run, trigger, item };
}
const recall = (channelId = f.general.id) =>
  retrieveForRun(f.context, {
    orgId: f.org.id,
    agentId: f.agent.id,
    channelId,
    text: "Orion",
    personIds: [f.owner.id],
  });

test("native run evidence is usable within its live source audience, without claiming verification", async () => {
  f = await setup();
  const { item } = await source();
  const result = await recall();
  expect(result.itemIds).toContain(item.id);
  expect(item.verified).toBe(false);
  expect(result.text).toContain("493");
});
test("private tool observations do not leave their source conversation through an empty item label", async () => {
  f = await setup();
  const room = await createChannel(f.db, f.owner.id, f.org.id, { name: "private-orion", visibility: "private" });
  await addChannelMember(f.db, f.owner.id, f.org.id, room.id, { agentId: f.agent.id });
  const { item } = await source(room.id);
  expect((await recall()).text).not.toContain("493");
  expect((await recall(room.id)).itemIds).toContain(item.id);
});
test("withdrawing a source run or its trigger prevents derived recall without waiting for indexing", async () => {
  f = await setup();
  const { run, trigger, item } = await source();
  expect((await recall()).itemIds).toContain(item.id);
  await f.db.update(schema.messages).set({ deletedAt: new Date() }).where(eq(schema.messages.id, trigger.id));
  expect((await recall()).text).not.toContain("493");
  await f.db.update(schema.messages).set({ deletedAt: null }).where(eq(schema.messages.id, trigger.id));
  await f.db.delete(schema.agentRuns).where(eq(schema.agentRuns.id, run.id));
  expect((await recall()).text).not.toContain("493");
});
test("a readable run is not a reviewed permission to publish its derived memory to the team", async () => {
  f = await setup();
  const { item } = await source();
  await expect(makeTeamMemory(f.db, f.owner.id, f.org.id, item.id)).rejects.toBeInstanceOf(ForbiddenError);
});
