import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  addChannelMember,
  ConflictError,
  createChannel,
  editContextItem,
  indexSource,
  insertContextItem,
  insertMessage,
  listContextItems,
  listTeamMemories,
  NotFoundError,
  openDm,
  revertMemoryChange,
  searchForUser,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});
async function claim(channelId: string, content: string) {
  const message = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId,
    author: { type: "person", userId: f.owner.id },
    body: content,
  });
  const item = await insertContextItem(f.db, {
    orgId: f.org.id,
    agentId: null,
    kind: "fact",
    scopeType: "org",
    scopeId: f.org.id,
    title: content,
    content,
    channelIds: [],
    sourceIds: [message.id],
    createdByKind: "person",
    createdById: f.owner.id,
    evidence: [{ type: "human", ref: message.id, at: new Date().toISOString() }],
  });
  await indexSource(f.context, { orgId: f.org.id, kind: "context_item", sourceId: item.id });
  return { item, message };
}
test("human lists and search cannot launder private sources through an empty channel label", async () => {
  f = await setup();
  const reader = await addMember(f.db, f.org.id, "member", "reader");
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: reader.id });
  const room = await createChannel(f.db, f.owner.id, f.org.id, { name: "private-orion", visibility: "private" });
  const hidden = await claim(room.id, "Orion private sentinel 912.");
  const allowed = await claim(f.general.id, "Orion public sentinel 441.");
  const list = await listContextItems(f.db, reader.id, f.org.id);
  expect(list.map((i) => i.id)).toContain(allowed.item.id);
  expect(list.map((i) => i.id)).not.toContain(hidden.item.id);
  const team = await listTeamMemories(f.db, reader.id, f.org.id);
  expect(team.items.map((i) => i.id)).toContain(allowed.item.id);
  expect(team.items.map((i) => i.id)).not.toContain(hidden.item.id);
  const search = await searchForUser(f.context, reader.id, f.org.id, { text: "Orion", kinds: ["context_item"] });
  expect(search.map((i) => i.sourceId)).toEqual([allowed.item.id]);
  expect((await listContextItems(f.db, f.owner.id, f.org.id)).map((i) => i.id)).toContain(hidden.item.id);
});
test("review-memory privilege does not turn another person's DM into a readable source", async () => {
  f = await setup();
  const other = await addMember(f.db, f.org.id, "member", "other");
  const dm = await openDm(f.db, other.id, f.org.id, { agentId: f.agent.id });
  const message = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: dm.id,
    author: { type: "person", userId: other.id },
    body: "Orion secret sentinel 912.",
  });
  const item = await insertContextItem(f.db, {
    orgId: f.org.id,
    kind: "fact",
    scopeType: "org",
    scopeId: f.org.id,
    content: message.body,
    sourceIds: [message.id],
    channelIds: [],
    createdByKind: "person",
    createdById: other.id,
  });
  await indexSource(f.context, { orgId: f.org.id, kind: "context_item", sourceId: item.id });
  expect((await listContextItems(f.db, f.owner.id, f.org.id)).map((i) => i.id)).not.toContain(item.id);
  expect(
    (await searchForUser(f.context, f.owner.id, f.org.id, { text: "Orion", kinds: ["context_item"] })).map(
      (i) => i.sourceId,
    ),
  ).not.toContain(item.id);
});
test("human views suppress a deleted source before an index update runs", async () => {
  f = await setup();
  const { item, message } = await claim(f.general.id, "Orion withdrawn sentinel 563.");
  expect((await listContextItems(f.db, f.owner.id, f.org.id)).map((i) => i.id)).toContain(item.id);
  await f.db.update(schema.messages).set({ deletedAt: new Date() }).where(eq(schema.messages.id, message.id));
  expect((await listContextItems(f.db, f.owner.id, f.org.id)).map((i) => i.id)).not.toContain(item.id);
  expect(await searchForUser(f.context, f.owner.id, f.org.id, { text: "Orion", kinds: ["context_item"] })).toHaveLength(
    0,
  );
});

test("ordinary refusal evidence remains readable but private-publication approval payloads stay out", async () => {
  f = await setup();
  const root = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "person", userId: f.owner.id },
    body: "Orion refusal context",
  });
  const [approval] = await f.db
    .insert(schema.approvals)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: root.id,
      toolUseId: "fixture",
      tool: "fixture",
      scope: "fixture",
      params: {},
      actionHash: "fixture",
      title: "Orion request",
      status: "refused",
      expiresAt: new Date(Date.now() + 1000),
      ownerUserId: f.owner.id,
    })
    .returning();
  if (!approval) throw new Error("missing approval");
  const item = await insertContextItem(f.db, {
    orgId: f.org.id,
    kind: "fact",
    scopeType: "org",
    scopeId: f.org.id,
    content: "Orion prior request was refused.",
    sourceIds: [approval.id],
    channelIds: [],
  });
  expect((await listContextItems(f.db, f.owner.id, f.org.id)).map((i) => i.id)).toContain(item.id);
  await f.db
    .update(schema.approvals)
    .set({ params: { contract: "skill-publication-v1" } })
    .where(eq(schema.approvals.id, approval.id));
  expect((await listContextItems(f.db, f.owner.id, f.org.id)).map((i) => i.id)).not.toContain(item.id);
});

for (const operation of ["pin", "confirm", "revert"] as const) {
  test(`direct ${operation} cannot return another person's private source through an empty label`, async () => {
    f = await setup();
    const other = await addMember(f.db, f.org.id, "member", "private-other");
    const dm = await openDm(f.db, other.id, f.org.id, { agentId: f.agent.id });
    const message = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: dm.id,
      author: { type: "person", userId: other.id },
      body: "Private mutation sentinel 764.",
    });
    const item = await insertContextItem(f.db, {
      orgId: f.org.id,
      kind: "fact",
      scopeType: "org",
      scopeId: f.org.id,
      content: message.body,
      channelIds: [],
      sourceIds: [message.id],
      createdByKind: "person",
      createdById: other.id,
    });
    const change =
      operation === "revert"
        ? revertMemoryChange(f.db, f.owner.id, f.org.id, item.id)
        : editContextItem(
            f.db,
            f.owner.id,
            f.org.id,
            item.id,
            operation === "pin" ? { pinned: true } : { confirmed: true },
          );
    await expect(change).rejects.toBeInstanceOf(NotFoundError);
    const [kept] = await f.db.select().from(schema.contextItems).where(eq(schema.contextItems.id, item.id));
    expect(kept).toMatchObject({ content: message.body, pinned: false, status: "active", version: item.version });
    const allowed = await claim(f.general.id, "Public mutation control.");
    expect((await editContextItem(f.db, f.owner.id, f.org.id, allowed.item.id, { pinned: true })).pinned).toBe(true);
  });
}

test("undo of an already superseded revision cannot resurrect an older accepted claim", async () => {
  f = await setup();
  const first = await claim(f.general.id, "Orion original location.");
  const second = await editContextItem(f.db, f.owner.id, f.org.id, first.item.id, {
    content: "Orion second location.",
  });
  const latest = await editContextItem(f.db, f.owner.id, f.org.id, second.id, { content: "Orion latest location." });
  await expect(revertMemoryChange(f.db, f.owner.id, f.org.id, second.id)).rejects.toBeInstanceOf(ConflictError);
  const rows = await f.db.select().from(schema.contextItems);
  expect(rows.filter((i) => i.status === "active").map((i) => i.id)).toEqual([latest.id]);
  expect((await revertMemoryChange(f.db, f.owner.id, f.org.id, latest.id)).id).toBe(second.id);
});
