import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import { createTestDatabase } from "@agenteschat/db/testing";
import { addContextItemByPerson, editContextItem, insertContextItem, listContextItems } from "../src/context/items";
import { insertMessage } from "../src/messages";
import { createOrganization, joinOrganization } from "../src/organizations";
import { reconcileSharedMemory, sharedMemoryAction, sharedMemorySnapshot } from "../src/shared-memory";
import { sharedMemoryVisibleIds } from "../src/shared-memory-store";
import { addUser } from "./fixtures";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function fixture() {
  const testDb = await createTestDatabase();
  close = testDb.close;
  const db = testDb.db;
  const owner = await addUser(db, "Mira");
  const canonical = (await createOrganization(db, owner.id, { name: "Personal" })).organization;
  const target = (await createOrganization(db, owner.id, { name: "Workshop" })).organization;
  const item = await addContextItemByPerson(db, owner.id, canonical.id, {
    kind: "fact",
    title: "Profile/base",
    content: "Logical key: profile.base\nThe project is named Cedar.",
  });
  const configured = await sharedMemoryAction(db, owner.id, canonical.id, {
    type: "configure",
    destinations: [{ orgId: target.id }],
    adopt: [{ itemId: item.id, key: "profile.base" }],
  });
  const profile = configured.snapshot.profile!;
  return { db, owner, canonical, target, item, profile };
}

describe("native shared-memory lifecycle", () => {
  test("adopts IDs without changing bodies, replicates once, and fences a stale correction", async () => {
    const f = await fixture();
    expect(
      (await f.db.select().from(schema.contextItems).where(eq(schema.contextItems.id, f.item.id)))[0]?.content,
    ).toBe(f.item.content);
    await reconcileSharedMemory(f.db, f.profile.id);
    const first = await sharedMemorySnapshot(f.db, f.owner.id, f.canonical.id);
    const entry = first.entries[0]!;
    expect(entry.itemId).toBe(f.item.id);
    expect(entry.replicas[0]?.state).toBe("current");
    const replica = entry.replicas[0]!.itemId;
    await reconcileSharedMemory(f.db, f.profile.id);
    expect((await sharedMemorySnapshot(f.db, f.owner.id, f.canonical.id)).entries[0]?.replicas[0]?.itemId).toBe(
      replica,
    );
    await sharedMemoryAction(f.db, f.owner.id, f.canonical.id, {
      type: "correct",
      entryId: entry.id,
      expectedVersion: entry.version,
      content: "The project is named Willow.",
    });
    await expect(
      sharedMemoryAction(f.db, f.owner.id, f.canonical.id, {
        type: "correct",
        entryId: entry.id,
        expectedVersion: entry.version,
        content: "A stale draft.",
      }),
    ).rejects.toMatchObject({ code: "shared_memory.version_conflict" });
    await reconcileSharedMemory(f.db, f.profile.id);
    const current = (await sharedMemorySnapshot(f.db, f.owner.id, f.canonical.id)).entries[0]!;
    expect(current.content).toContain("Willow");
    expect(current.history.some((h) => h.content.includes("Cedar"))).toBe(true);
  });

  test("ordinary agent claims are candidates and exact echoes never become another fact", async () => {
    const f = await fixture();
    await insertContextItem(f.db, {
      orgId: f.target.id,
      kind: "note",
      scopeType: "person",
      scopeId: f.owner.id,
      content: "Maybe the owner prefers morning sessions.",
      createdByKind: "agent",
      trust: "low",
    });
    let snapshot = await sharedMemorySnapshot(f.db, f.owner.id, f.canonical.id);
    expect(snapshot.candidates).toHaveLength(1);
    expect(snapshot.candidates[0]?.assertion).toBe("inference");
    await insertContextItem(f.db, {
      orgId: f.target.id,
      kind: "note",
      scopeType: "org",
      scopeId: f.target.id,
      content: f.item.content,
      createdByKind: "agent",
      trust: "low",
    });
    snapshot = await sharedMemorySnapshot(f.db, f.owner.id, f.canonical.id);
    expect(snapshot.candidates).toHaveLength(1);
    await reconcileSharedMemory(f.db, f.profile.id);
    expect(snapshot.candidates[0]?.replicas).toHaveLength(0);
  });

  test("a direct owner correction queues synchronization, and replica divergence is held", async () => {
    const f = await fixture();
    await reconcileSharedMemory(f.db, f.profile.id);
    const entry = (await sharedMemorySnapshot(f.db, f.owner.id, f.canonical.id)).entries[0]!;
    await editContextItem(f.db, f.owner.id, f.canonical.id, f.item.id, {
      expectedVersion: f.item.version,
      content: "Owner's corrected canonical fact.",
      title: f.item.title,
    });
    const jobs = await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, "memory.shared.reconcile"));
    expect(jobs.length).toBeGreaterThan(0);
    const replicaId = entry.replicas[0]!.itemId!;
    await f.db
      .update(schema.contextItems)
      .set({ content: "A concurrent different edit." })
      .where(eq(schema.contextItems.id, replicaId));
    await reconcileSharedMemory(f.db, f.profile.id);
    const current = (await sharedMemorySnapshot(f.db, f.owner.id, f.canonical.id)).entries[0]!;
    expect(current.replicas[0]?.state).toBe("conflict");
    expect(
      (await f.db.select().from(schema.contextItems).where(eq(schema.contextItems.id, replicaId)))[0]?.content,
    ).toBe("A concurrent different edit.");
  });

  test("ordinary operational learning remains local while an explicitly personal inference waits for review", async () => {
    const f = await fixture();
    const operational = await insertContextItem(f.db, {
      orgId: f.target.id,
      kind: "note",
      scopeType: "org",
      scopeId: f.target.id,
      content: "The parser retries a failed read once.",
      createdByKind: "job",
      trust: "low",
    });
    const personal = await insertContextItem(f.db, {
      orgId: f.target.id,
      kind: "fact",
      scopeType: "person",
      scopeId: f.owner.id,
      content: "The owner may prefer an afternoon review.",
      createdByKind: "agent",
      trust: "low",
    });
    const snapshot = await sharedMemorySnapshot(f.db, f.owner.id, f.canonical.id);
    expect([...snapshot.entries, ...snapshot.candidates].some((e) => e.itemId === operational.id)).toBe(false);
    expect(snapshot.candidates.some((e) => e.itemId === personal.id)).toBe(true);
    const readable = await sharedMemoryVisibleIds(f.db, f.target.id, [operational.id, personal.id], undefined, {
      agent: true,
    });
    expect(readable.has(operational.id)).toBe(true);
    expect(readable.has(personal.id)).toBe(false);
    const local = await listContextItems(f.db, f.owner.id, f.target.id);
    expect(local.some((item) => item.id === operational.id && item.status === "active")).toBe(true);
    await reconcileSharedMemory(f.db, f.profile.id);
    const canonical = await f.db
      .select()
      .from(schema.contextItems)
      .where(eq(schema.contextItems.orgId, f.canonical.id));
    expect(canonical.some((item) => item.content === operational.content || item.content === personal.content)).toBe(
      false,
    );
  });

  test("a join protects already-present replicas before another human can read their history", async () => {
    const f = await fixture();
    await reconcileSharedMemory(f.db, f.profile.id);
    const newcomer = await addUser(f.db, "Newcomer");
    await f.db.transaction((tx) => joinOrganization(tx, f.target.id, newcomer.id, "owner"));
    const rows = await listContextItems(f.db, newcomer.id, f.target.id, { includeArchived: true });
    expect(rows.some((r) => r.content.includes("Cedar"))).toBe(false);
    const snapshot = await sharedMemorySnapshot(f.db, f.owner.id, f.canonical.id);
    expect(snapshot.destinations.find((d) => d.orgId === f.target.id)?.state).toBe("blocked");
    expect((await sharedMemorySnapshot(f.db, newcomer.id, f.target.id)).profile).toBeNull();
    const active = await f.db
      .select()
      .from(schema.contextItems)
      .where(and(eq(schema.contextItems.orgId, f.target.id), eq(schema.contextItems.status, "active")));
    expect(active.some((r) => r.content.includes("Cedar"))).toBe(false);
  });

  test("forget redacts managed native bodies, leaves a durable fence and reports external copies honestly", async () => {
    const f = await fixture();
    await reconcileSharedMemory(f.db, f.profile.id);
    const entry = (await sharedMemorySnapshot(f.db, f.owner.id, f.canonical.id)).entries[0]!;
    await sharedMemoryAction(f.db, f.owner.id, f.canonical.id, {
      type: "forget",
      entryId: entry.id,
      expectedVersion: entry.version,
      scope: "profile",
    });
    await reconcileSharedMemory(f.db, f.profile.id);
    const forgotten = (await sharedMemorySnapshot(f.db, f.owner.id, f.canonical.id)).entries[0]!;
    expect(forgotten.status).toBe("forgotten");
    expect(forgotten.content).toBe("");
    expect(forgotten.externalOutstanding).toContain("source_archives");
    const bodies = (await f.db.select().from(schema.contextItems)).map((i) => i.content);
    expect(bodies.some((s) => s.includes("Cedar"))).toBe(false);
    await expect(
      addContextItemByPerson(f.db, f.owner.id, f.target.id, {
        kind: "fact",
        title: f.item.title,
        content: f.item.content,
      }),
    ).rejects.toMatchObject({ code: "shared_memory.forgotten" });
  });

  test("a current owner replica correction updates the stable canonical key and permits a deliberate reversal", async () => {
    const f = await fixture();
    await reconcileSharedMemory(f.db, f.profile.id);
    const entry = (await sharedMemorySnapshot(f.db, f.owner.id, f.canonical.id)).entries[0]!;
    const copyId = entry.replicas[0]!.itemId!;
    const [copy] = await f.db.select().from(schema.contextItems).where(eq(schema.contextItems.id, copyId));
    await editContextItem(f.db, f.owner.id, f.target.id, copyId, {
      expectedVersion: copy!.version,
      content: "The project is named Willow.",
      title: copy!.title,
    });
    const corrected = (await sharedMemorySnapshot(f.db, f.owner.id, f.canonical.id)).entries.find(
      (e) => e.id === entry.id,
    )!;
    expect(corrected.content).toBe("Logical key: profile.base\nThe project is named Willow.");
    expect(corrected.assertion).toBe("owner_correction");
    const reversed = await sharedMemoryAction(f.db, f.owner.id, f.canonical.id, {
      type: "correct",
      entryId: entry.id,
      expectedVersion: corrected.version,
      content: "The project is named Cedar.",
      validTo: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(reversed.snapshot.entries.find((e) => e.id === entry.id)?.content).toContain("Cedar");
    expect(reversed.snapshot.destinations.find((d) => d.orgId === f.target.id)?.pending).toBe(1);
  });

  test("workspace forget does not erase the canonical fact, but blocks old imports and replicas", async () => {
    const f = await fixture();
    await reconcileSharedMemory(f.db, f.profile.id);
    const entry = (await sharedMemorySnapshot(f.db, f.owner.id, f.canonical.id)).entries[0]!;
    await sharedMemoryAction(f.db, f.owner.id, f.canonical.id, {
      type: "forget",
      entryId: entry.id,
      expectedVersion: entry.version,
      scope: "workspace",
      destinationOrgId: f.target.id,
    });
    await reconcileSharedMemory(f.db, f.profile.id);
    const current = (await sharedMemorySnapshot(f.db, f.owner.id, f.canonical.id)).entries[0]!;
    expect(current.content).toBe(f.item.content);
    expect(current.replicas[0]?.state).toBe("forgotten");
    await expect(
      addContextItemByPerson(f.db, f.owner.id, f.target.id, {
        kind: "fact",
        content: f.item.content,
      }),
    ).rejects.toMatchObject({ code: "shared_memory.forgotten" });
  });

  test("capture rejects unknown and foreign source IDs before accepting provenance", async () => {
    const f = await fixture();
    await expect(
      sharedMemoryAction(f.db, f.owner.id, f.canonical.id, {
        type: "capture",
        sourceOrgId: f.canonical.id,
        itemId: f.item.id,
        sourceId: "00000000-0000-4000-8000-000000000001",
      }),
    ).rejects.toBeInstanceOf(Error);
    const other = await addUser(f.db, "Different owner");
    const org = (await createOrganization(f.db, other.id, { name: "Separate profile" })).organization;
    await sharedMemoryAction(f.db, other.id, org.id, { type: "configure" });
    const created = await sharedMemoryAction(f.db, other.id, org.id, {
      type: "source",
      source: {
        name: "Synthetic source",
        provider: "file",
        reference: null,
        originId: "synthetic:source",
        revision: "one",
        capturedAt: new Date().toISOString(),
        observedAt: null,
        refreshAfter: null,
        coverage: "Synthetic record only",
        recordCount: 1,
      },
    });
    await expect(
      sharedMemoryAction(f.db, f.owner.id, f.canonical.id, {
        type: "capture",
        sourceOrgId: f.canonical.id,
        itemId: f.item.id,
        sourceId: created.snapshot.sources[0]!.id,
      }),
    ).rejects.toBeInstanceOf(Error);
  });

  test("an unrelated invented claim does not inherit an owner's remember instruction", async () => {
    const f = await fixture();
    const [channel] = await f.db.select().from(schema.channels).where(eq(schema.channels.orgId, f.canonical.id));
    const source = await insertMessage(f.db, {
      orgId: f.canonical.id,
      channelId: channel!.id,
      author: { type: "person", userId: f.owner.id },
      body: "Remember I prefer concise summaries.",
    });
    await insertContextItem(f.db, {
      orgId: f.canonical.id,
      kind: "fact",
      scopeType: "org",
      scopeId: f.canonical.id,
      content: "The owner has approved all purchases.",
      sourceIds: [source.id],
      channelIds: [channel!.id],
      createdByKind: "agent",
      trust: "high",
    });
    const snapshot = await sharedMemorySnapshot(f.db, f.owner.id, f.canonical.id);
    expect(snapshot.candidates.some((e) => e.content.includes("all purchases"))).toBe(true);
    expect(snapshot.entries.some((e) => e.status === "active" && e.content.includes("all purchases"))).toBe(false);
  });

  test("withdrawing a source blocks already-present copies at agent read time", async () => {
    const f = await fixture();
    const [channel] = await f.db.select().from(schema.channels).where(eq(schema.channels.orgId, f.canonical.id));
    const source = await insertMessage(f.db, {
      orgId: f.canonical.id,
      channelId: channel!.id,
      author: { type: "person", userId: f.owner.id },
      body: "Remember: Reviews use the short template.",
    });
    await insertContextItem(f.db, {
      orgId: f.canonical.id,
      kind: "fact",
      scopeType: "org",
      scopeId: f.canonical.id,
      content: "Reviews use the short template.",
      sourceIds: [source.id],
      channelIds: [channel!.id],
      createdByKind: "agent",
      trust: "high",
    });
    await reconcileSharedMemory(f.db, f.profile.id);
    const accepted = (await sharedMemorySnapshot(f.db, f.owner.id, f.canonical.id)).entries.find((e) =>
      e.content.includes("short template"),
    )!;
    const id = accepted.replicas[0]!.itemId!;
    expect((await sharedMemoryVisibleIds(f.db, f.target.id, [id], undefined, { agent: true })).has(id)).toBe(true);
    await f.db.update(schema.messages).set({ deletedAt: new Date() }).where(eq(schema.messages.id, source.id));
    expect((await sharedMemoryVisibleIds(f.db, f.target.id, [id], undefined, { agent: true })).has(id)).toBe(false);
  });
});
