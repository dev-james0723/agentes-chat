import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { createTestDatabase } from "@agenteschat/db/testing";
import { createAgent } from "../src/agents";
import { addContextItemByPerson, deleteContextItem, insertContextItem, listContextItems } from "../src/context/items";
import { insertMessage } from "../src/messages";
import { createOrganization, joinOrganization } from "../src/organizations";
import { reconcileSharedMemory, sharedMemoryAction, sharedMemorySnapshot } from "../src/shared-memory";
import { sharedMemoryVisibleIds } from "../src/shared-memory-store";
import type { SharedMemorySensitivity } from "../src/shared-memory-types";
import { addUser } from "./fixtures";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function fixture(sensitivity: SharedMemorySensitivity = "personal") {
  const testDb = await createTestDatabase();
  close = testDb.close;
  const db = testDb.db;
  const owner = await addUser(db, "QualityOwner");
  const canonical = await createOrganization(db, owner.id, { name: "Synthetic personal" });
  const target = await createOrganization(db, owner.id, { name: "Synthetic workshop" });
  const content = "The project is named Cedar.";
  const originalSource = await insertMessage(db, {
    orgId: canonical.organization.id,
    channelId: canonical.general.id,
    author: { type: "person", userId: owner.id },
    body: `Remember: ${content}`,
  });
  const item = await addContextItemByPerson(db, owner.id, canonical.organization.id, {
    kind: "fact",
    title: "Synthetic project name",
    content: `Logical key: project.name\n${content}`,
  });
  const enrolled = await sharedMemoryAction(db, owner.id, canonical.organization.id, {
    type: "configure",
    destinations: [{ orgId: target.organization.id }],
    adopt: [{ itemId: item.id, key: "project.name", sensitivity }],
  });
  const profile = enrolled.snapshot.profile;
  if (!profile) throw new Error("Missing synthetic profile fixture");
  await reconcileSharedMemory(db, profile.id);
  const snapshot = () => sharedMemorySnapshot(db, owner.id, canonical.organization.id);
  const entry = (await snapshot()).entries[0];
  if (!entry) throw new Error("Missing synthetic entry fixture");
  const correct = () =>
    sharedMemoryAction(db, owner.id, canonical.organization.id, {
      type: "correct",
      entryId: entry.id,
      expectedVersion: entry.version,
      content: "The project is now named Willow.",
    });
  return { db, owner, canonical, target, item, originalSource, profile, entry, snapshot, correct };
}

describe("shared-memory quality boundaries with synthetic database evidence", () => {
  test("restricting a destination stops sensitive agent reads before the repair job runs", async () => {
    const f = await fixture("sensitive");
    const replicaId = f.entry.replicas[0]?.itemId;
    if (!replicaId) throw new Error("Missing synthetic replica fixture");
    expect(
      (await sharedMemoryVisibleIds(f.db, f.target.organization.id, [replicaId], undefined, { agent: true })).has(
        replicaId,
      ),
    ).toBe(true);
    await sharedMemoryAction(f.db, f.owner.id, f.canonical.organization.id, {
      type: "destination",
      orgId: f.target.organization.id,
      enabled: true,
      allowedSensitivity: ["workspace"],
    });
    expect(
      (await sharedMemoryVisibleIds(f.db, f.target.organization.id, [replicaId], undefined, { agent: true })).has(
        replicaId,
      ),
    ).toBe(false);
  });

  test("a newly admitted co-owner cannot delete another person's managed canonical item", async () => {
    const f = await fixture();
    const newcomer = await addUser(f.db, "QualityNewcomer");
    await f.db.transaction((tx) => joinOrganization(tx, f.canonical.organization.id, newcomer.id, "owner"));
    expect(
      (await listContextItems(f.db, newcomer.id, f.canonical.organization.id, { includeArchived: true })).some(
        (row) => row.id === f.item.id,
      ),
    ).toBe(false);
    await expect(deleteContextItem(f.db, newcomer.id, f.canonical.organization.id, f.item.id)).rejects.toBeInstanceOf(
      Error,
    );
    const [stored] = await f.db.select().from(schema.contextItems).where(eq(schema.contextItems.id, f.item.id));
    expect(stored?.content).toBe(f.item.content);
    expect((await f.snapshot()).entries.find((entry) => entry.id === f.entry.id)?.status).not.toBe("forgotten");
  });

  test("retrieval evidence does not remain passed for a later corrected revision", async () => {
    const f = await fixture();
    const agent = await createAgent(
      f.db,
      f.owner.id,
      f.canonical.organization.id,
      { name: "Synthetic reader", handle: "synthetic-reader" },
      { model: "claude-sonnet-5-5" },
      { remember: false },
    );
    const trigger = await insertMessage(f.db, {
      orgId: f.canonical.organization.id,
      channelId: f.canonical.general.id,
      author: { type: "person", userId: f.owner.id },
      body: "Which synthetic project name is stored?",
    });
    // A database fixture for a completed retrieval trace; no model answer is generated or graded.
    const [run] = await f.db
      .insert(schema.agentRuns)
      .values({
        orgId: f.canonical.organization.id,
        agentId: agent.id,
        channelId: f.canonical.general.id,
        threadRootId: trigger.id,
        triggerMessageId: trigger.id,
        trigger: "mention",
        hop: 1,
        status: "done",
      })
      .returning();
    if (!run) throw new Error("Missing synthetic run fixture");
    await f.db.insert(schema.contextUsage).values({
      orgId: f.canonical.organization.id,
      runId: run.id,
      itemId: f.item.id,
    });
    const verified = await sharedMemoryAction(f.db, f.owner.id, f.canonical.organization.id, {
      type: "verify",
      runId: run.id,
      entryIds: [f.entry.id],
    });
    expect(verified.snapshot.verification.status).toBe("passed");
    expect(verified.snapshot.verification.detail).toContain("does not grade the final answer");
    await f.correct();
    expect((await f.snapshot()).verification.status).not.toBe("passed");
  });

  test("a manual file receipt for an older profile revision is no longer current", async () => {
    const f = await fixture();
    const profile = (await f.snapshot()).profile;
    if (!profile) throw new Error("Missing synthetic profile fixture");
    await sharedMemoryAction(f.db, f.owner.id, f.canonical.organization.id, {
      type: "consumer",
      consumer: {
        id: "synthetic_file",
        name: "Synthetic export receipt",
        kind: "file",
        status: "current",
        revision: profile.version,
        availabilityRevision: profile.availabilityRevision,
        checkedAt: new Date().toISOString(),
        reason: "Owner-reported synthetic file receipt; no model read is claimed.",
        writable: false,
      },
    });
    expect((await f.snapshot()).consumers.find((consumer) => consumer.id === "synthetic_file")?.status).toBe("current");
    await f.correct();
    expect((await f.snapshot()).consumers.find((consumer) => consumer.id === "synthetic_file")?.status).not.toBe(
      "current",
    );
  });

  test("replaying a superseded owner source cannot create another current fact", async () => {
    const f = await fixture();
    await f.correct();
    await insertContextItem(f.db, {
      orgId: f.canonical.organization.id,
      kind: "fact",
      scopeType: "org",
      scopeId: f.canonical.organization.id,
      title: "Old source replay",
      content: "The project is named Cedar.",
      createdByKind: "agent",
      trust: "high",
      sourceIds: [f.originalSource.id],
      channelIds: [f.canonical.general.id],
    });
    const snapshot = await f.snapshot();
    expect(snapshot.entries.some((entry) => entry.status === "active" && entry.content.includes("Cedar"))).toBe(false);
    expect(snapshot.entries.some((entry) => entry.status === "active" && entry.content.includes("Willow"))).toBe(true);
  });

  test("historical replica bodies remain hidden after a second human joins", async () => {
    const f = await fixture();
    await f.correct();
    await reconcileSharedMemory(f.db, f.profile.id);
    const newcomer = await addUser(f.db, "HistoryNewcomer");
    await f.db.transaction((tx) => joinOrganization(tx, f.target.organization.id, newcomer.id, "owner"));
    const visible = await listContextItems(f.db, newcomer.id, f.target.organization.id, { includeArchived: true });
    expect(visible.some((row) => row.content.includes("Cedar") || row.content.includes("Willow"))).toBe(false);
  });
});
