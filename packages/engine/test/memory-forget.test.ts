import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { deleteContextItem, indexSource, insertContextItem, reapplyMemoryTombstones, retrieveForRun } from "../src";
import { type Fixture, setup } from "./fixtures";

/** Acceptance A17 and A19 of the long-term memory plan (T02): a deletion is final, also across a backup restore. */
let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

async function remember(content: string) {
  const item = await insertContextItem(f.db, {
    orgId: f.org.id,
    kind: "fact",
    scopeType: "agent",
    scopeId: f.agent.id,
    agentId: f.agent.id,
    channelIds: [f.general.id],
    content,
    trust: "high",
    evidence: [{ type: "human", ref: f.owner.id, at: new Date().toISOString() }],
    createdByKind: "person",
    createdById: f.owner.id,
  });
  await indexSource(f.context, { orgId: f.org.id, kind: "context_item", sourceId: item.id });
  return item;
}

const recall = (text: string) =>
  retrieveForRun(f.context, {
    orgId: f.org.id,
    agentId: f.agent.id,
    channelId: f.general.id,
    text,
    personIds: [f.owner.id],
  });

describe("forgetting a memory leaves a tombstone, never its words (A17)", () => {
  test("the deletion returns a receipt and keeps only who deleted what and when", async () => {
    f = await setup();
    const item = await remember("Orion's acquisition price is 4.2 million.");
    const receipt = await deleteContextItem(f.db, f.owner.id, f.org.id, item.id);
    expect(receipt).toMatchObject({ itemId: item.id, canonical: "deleted", index: "queued" });
    const [stone] = await f.db
      .select()
      .from(schema.contextItemTombstones)
      .where(eq(schema.contextItemTombstones.itemId, item.id));
    expect(stone).toMatchObject({ orgId: f.org.id, itemId: item.id, deletedByKind: "person", deletedById: f.owner.id });
    expect(JSON.stringify(stone)).not.toContain("4.2 million");
    expect((await recall("Orion acquisition price")).text).not.toContain("4.2 million");
  });
});

describe("a backup restored from before a deletion does not bring the memory back (A19)", () => {
  test("restoring the row and replaying tombstones removes it again before anything reads it", async () => {
    f = await setup();
    const item = await remember("Orion's acquisition price is 4.2 million.");
    const [backup] = await f.db.select().from(schema.contextItems).where(eq(schema.contextItems.id, item.id));
    await deleteContextItem(f.db, f.owner.id, f.org.id, item.id);
    // The restore: the older backup still holds the row.
    await f.db.insert(schema.contextItems).values(backup as typeof schema.contextItems.$inferInsert);
    const replayed = await reapplyMemoryTombstones(f.db);
    expect(replayed).toEqual({ removed: 1 });
    expect(await f.db.select().from(schema.contextItems).where(eq(schema.contextItems.id, item.id))).toEqual([]);
    expect(await reapplyMemoryTombstones(f.db)).toEqual({ removed: 0 });
  });
});
