import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import { createTestDatabase } from "@agenteschat/db/testing";
import { createAgent } from "../src/agents";
import { addContextItemByPerson, editContextItem, insertContextItem } from "../src/context/items";
import { personsOwnWords } from "../src/context/memory-visibility";
import { listProposals } from "../src/context/proposals";
import { rulesForPerson } from "../src/context/rules";
import { exportBundle } from "../src/exports";
import { insertMessage } from "../src/messages";
import { createOrganization, joinOrganization, removeMember } from "../src/organizations";
import { reconcileSharedMemory, sharedMemoryAction, sharedMemorySnapshot } from "../src/shared-memory";
import { sharedMemoryVisibleIds } from "../src/shared-memory-store";
import { addUser } from "./fixtures";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Missing synthetic fixture value");
  return value;
}

async function fixture() {
  const testDb = await createTestDatabase();
  close = testDb.close;
  const db = testDb.db;
  const owner = await addUser(db, "BoundaryOwner");
  const canonical = await createOrganization(db, owner.id, { name: "Boundary personal" });
  const target = await createOrganization(db, owner.id, { name: "Boundary workshop" });
  const result = await sharedMemoryAction(db, owner.id, canonical.organization.id, {
    type: "configure",
    destinations: [{ orgId: target.organization.id }],
  });
  const profile = required(result.snapshot.profile);
  const snapshot = (options: { cursor?: string; limit?: number } = {}) =>
    sharedMemorySnapshot(db, owner.id, canonical.organization.id, options);
  const source = async (body: string, place = canonical) =>
    insertMessage(db, {
      orgId: place.organization.id,
      channelId: place.general.id,
      author: { type: "person", userId: owner.id },
      body,
    });
  const claim = async (content: string, sourceId: string, place = canonical) =>
    insertContextItem(db, {
      orgId: place.organization.id,
      kind: "fact",
      scopeType: "org",
      scopeId: place.organization.id,
      content,
      createdByKind: "agent",
      trust: "high",
      sourceIds: [sourceId],
      channelIds: [place.general.id],
    });
  return { db, owner, canonical, target, profile, snapshot, source, claim };
}

describe("shared memory live source and native read boundaries", () => {
  test("only a complete top-level owner directive autoaccepts model-assisted capture", async () => {
    const f = await fixture();
    const clean = "My synthetic color is blue.";
    await f.claim(clean, (await f.source(`Remember: ${clean}`)).id);
    const quoted = "My synthetic color is orange.";
    await f.claim(
      quoted,
      (await f.source(`Here is an example prompt, not a statement about me:\n\`\`\`\nRemember: ${quoted}\n\`\`\``)).id,
    );
    const fragment = "my address would be 7 Example Road.";
    await f.claim(fragment, (await f.source(`Remember: If I ever relocate, ${fragment}`)).id);
    const snapshot = await f.snapshot();
    expect(snapshot.entries.filter((e) => e.status === "active").map((e) => e.content)).toEqual([clean]);
    expect(snapshot.candidates.map((e) => e.content).sort()).toEqual([quoted, fragment].sort());
  });

  test("a person-scoped original promotes to an organization-wide head and owner corrections keep its key", async () => {
    const f = await fixture();
    const text = "My synthetic work window starts at nine.";
    const source = await f.source(`Remember: ${text}`);
    const original = await insertContextItem(f.db, {
      orgId: f.canonical.organization.id,
      kind: "preference",
      scopeType: "person",
      scopeId: f.owner.id,
      content: text,
      createdByKind: "agent",
      trust: "high",
      sourceIds: [source.id],
    });
    const entry = required((await f.snapshot()).entries[0]);
    expect(entry.itemId).not.toBe(original.id);
    const [head] = await f.db
      .select()
      .from(schema.contextItems)
      .where(eq(schema.contextItems.id, required(entry.itemId)));
    expect(head?.scopeType).toBe("org");
    expect(head?.agentId).toBeNull();
    await editContextItem(f.db, f.owner.id, f.canonical.organization.id, original.id, {
      expectedVersion: original.version,
      content: "My synthetic work window starts at ten.",
      title: original.title,
    });
    const corrected = required((await f.snapshot()).entries.find((e) => e.id === entry.id));
    expect(corrected.key).toBe(entry.key);
    expect(corrected.content).toContain("ten");
    expect(corrected.readable).toBe(true);
    await reconcileSharedMemory(f.db, f.profile.id);
    expect((await f.snapshot()).entries.find((e) => e.id === entry.id)?.replicas[0]?.state).toBe("current");
  });

  test("native own-words and proposal paths cannot expose a withheld personal candidate", async () => {
    const f = await fixture();
    const source = await f.source("This is a possible preference, not an instruction to remember it.");
    const item = await insertContextItem(f.db, {
      orgId: f.canonical.organization.id,
      kind: "preference",
      scopeType: "person",
      scopeId: f.owner.id,
      content: "The owner may prefer quiet rooms.",
      createdByKind: "agent",
      trust: "high",
      sourceIds: [source.id],
    });
    expect((await personsOwnWords(f.db, f.canonical.organization.id, [f.owner.id], [item])).has(item.id)).toBe(false);
    const [proposal] = await f.db
      .insert(schema.contextProposals)
      .values({
        orgId: f.canonical.organization.id,
        target: "org_context",
        baseHash: "synthetic",
        proposedText: item.content,
        diff: item.content,
        rationale: "Synthetic linked source",
        itemIds: [item.id],
        status: "accepted",
      })
      .returning();
    expect(
      (await listProposals(f.db, f.owner.id, f.canonical.organization.id)).some((p) => p.id === proposal?.id),
    ).toBe(true);
    const newcomer = await addUser(f.db, "BoundaryReviewer");
    await f.db.transaction((tx) => joinOrganization(tx, f.canonical.organization.id, newcomer.id, "owner"));
    expect(await listProposals(f.db, newcomer.id, f.canonical.organization.id)).toHaveLength(0);
  });

  test("membership suspension protects retained rules and exports and explicit re-enrollment restores eligible heads", async () => {
    const f = await fixture();
    const agent = await createAgent(
      f.db,
      f.owner.id,
      f.canonical.organization.id,
      { name: "Boundary reader", handle: "boundary-reader" },
      { model: "claude-sonnet-5-5" },
      { remember: false },
    );
    const originals = [];
    for (const kind of ["rule", "fact"] as const) {
      const text = kind === "rule" ? "Use a calm synthetic tone." : "My synthetic desk is green.";
      const source = await f.source(`Remember: ${text}`);
      originals.push(
        await insertContextItem(f.db, {
          orgId: f.canonical.organization.id,
          kind,
          scopeType: "agent",
          scopeId: agent.id,
          agentId: agent.id,
          content: text,
          createdByKind: "person",
          createdById: f.owner.id,
          trust: "high",
          sourceIds: [source.id],
          channelIds: [f.canonical.general.id],
        }),
      );
    }
    await reconcileSharedMemory(f.db, f.profile.id);
    expect(
      (await exportBundle(f.db, f.owner.id, f.canonical.organization.id)).notes.some((note) =>
        note.content.includes("desk is green"),
      ),
    ).toBe(true);
    const forgotten = await addContextItemByPerson(f.db, f.owner.id, f.canonical.organization.id, {
      kind: "fact",
      content: "An obsolete synthetic detail.",
    });
    const forgottenEntry = required((await f.snapshot()).entries.find((e) => e.itemId === forgotten.id));
    await sharedMemoryAction(f.db, f.owner.id, f.canonical.organization.id, {
      type: "forget",
      entryId: forgottenEntry.id,
      expectedVersion: forgottenEntry.version,
      scope: "profile",
    });
    const newcomer = await addUser(f.db, "BoundaryCoOwner");
    await f.db.transaction((tx) => joinOrganization(tx, f.canonical.organization.id, newcomer.id, "owner"));
    const suspended = await f.snapshot();
    expect(suspended.entries.filter((e) => e.status === "active").every((e) => !e.readable)).toBe(true);
    for (const item of originals) {
      const [stored] = await f.db.select().from(schema.contextItems).where(eq(schema.contextItems.id, item.id));
      expect(stored?.status).toBe("archived");
    }
    expect(
      await rulesForPerson(f.db, {
        orgId: f.canonical.organization.id,
        agentId: agent.id,
        ownerUserId: f.owner.id,
        personId: newcomer.id,
      }),
    ).toHaveLength(0);
    expect((await exportBundle(f.db, newcomer.id, f.canonical.organization.id)).notes).toHaveLength(0);
    await removeMember(f.db, f.owner.id, f.canonical.organization.id, newcomer.id);
    for (const orgId of [f.canonical.organization.id, f.target.organization.id])
      await sharedMemoryAction(f.db, f.owner.id, f.canonical.organization.id, {
        type: "destination",
        orgId,
        enabled: true,
      });
    await reconcileSharedMemory(f.db, f.profile.id);
    const restored = await f.snapshot();
    expect(restored.entries.filter((e) => e.status === "active").every((e) => e.readable)).toBe(true);
    expect(restored.entries.find((e) => e.id === forgottenEntry.id)?.status).toBe("forgotten");
    const [erased] = await f.db.select().from(schema.contextItems).where(eq(schema.contextItems.id, forgotten.id));
    expect(erased?.content).toBe("");
  });

  test("scoped origin forget preserves accepted canonical provenance but a withdrawn source still blocks it", async () => {
    const f = await fixture();
    const text = "My synthetic meeting length is twenty minutes.";
    const source = await f.source(`Remember: ${text}`, f.target);
    await insertContextItem(f.db, {
      orgId: f.target.organization.id,
      kind: "preference",
      scopeType: "person",
      scopeId: f.owner.id,
      content: text,
      createdByKind: "agent",
      trust: "high",
      sourceIds: [source.id],
    });
    await reconcileSharedMemory(f.db, f.profile.id);
    const entry = required((await f.snapshot()).entries[0]);
    expect(entry.readable).toBe(true);
    const echo = await insertContextItem(f.db, {
      orgId: f.target.organization.id,
      kind: "note",
      scopeType: "org",
      scopeId: f.target.organization.id,
      content: text,
      createdByKind: "agent",
      trust: "low",
    });
    await sharedMemoryAction(f.db, f.owner.id, f.canonical.organization.id, {
      type: "forget",
      entryId: entry.id,
      expectedVersion: entry.version,
      scope: "workspace",
      destinationOrgId: f.target.organization.id,
    });
    let current = required((await f.snapshot()).entries[0]);
    expect(current.readable).toBe(true);
    expect(current.content).toBe(text);
    expect(current.replicas[0]?.state).toBe("forgotten");
    const [erasedEcho] = await f.db.select().from(schema.contextItems).where(eq(schema.contextItems.id, echo.id));
    expect(erasedEcho?.content).toBe("");
    expect((await f.snapshot()).entries.find((e) => e.key === `echo.${echo.id}`)?.readable).toBe(false);
    await f.db.update(schema.messages).set({ deletedAt: new Date() }).where(eq(schema.messages.id, source.id));
    current = required((await f.snapshot()).entries[0]);
    expect(current.readable).toBe(false);
    expect(current.content).toBe("");
    expect(current.history).toHaveLength(0);
  });

  test("source withdrawal fences every page, receipt and retrieval proof while repair continues for readable entries", async () => {
    const f = await fixture();
    const firstSource = await f.source("Remember: My synthetic color is violet.");
    const first = await f.claim("My synthetic color is violet.", firstSource.id);
    const second = await f.claim(
      "My synthetic shape is round.",
      (await f.source("Remember: My synthetic shape is round.")).id,
    );
    await reconcileSharedMemory(f.db, f.profile.id);
    let snapshot = await f.snapshot();
    const firstEntry = required(snapshot.entries.find((e) => e.itemId === first.id));
    const secondEntry = required(snapshot.entries.find((e) => e.itemId === second.id));
    await sharedMemoryAction(f.db, f.owner.id, f.canonical.organization.id, {
      type: "correct",
      entryId: secondEntry.id,
      expectedVersion: secondEntry.version,
      content: "My synthetic shape is square.",
    });
    const agent = await createAgent(
      f.db,
      f.owner.id,
      f.canonical.organization.id,
      { name: "Source reader", handle: "source-reader" },
      { model: "claude-sonnet-5-5" },
      { remember: false },
    );
    const trigger = await f.source("Read the current synthetic color.");
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
    await f.db
      .insert(schema.contextUsage)
      .values({ orgId: f.canonical.organization.id, runId: required(run).id, itemId: first.id });
    await sharedMemoryAction(f.db, f.owner.id, f.canonical.organization.id, {
      type: "verify",
      runId: required(run).id,
      entryIds: [firstEntry.id],
    });
    snapshot = await f.snapshot();
    expect(snapshot.verification.status).toBe("passed");
    const revision = required(snapshot.profile);
    await sharedMemoryAction(f.db, f.owner.id, f.canonical.organization.id, {
      type: "consumer",
      consumer: {
        id: "boundary_file",
        name: "Synthetic receipt",
        kind: "file",
        status: "current",
        revision: revision.version,
        availabilityRevision: revision.availabilityRevision,
        checkedAt: new Date().toISOString(),
        reason: "Synthetic file acknowledgement",
        writable: false,
      },
    });
    const page = await f.snapshot({ limit: 1 });
    expect(page.pagination.nextCursor).not.toBeNull();
    await f.db.update(schema.messages).set({ deletedAt: new Date() }).where(eq(schema.messages.id, firstSource.id));
    const laterPage = await f.snapshot({ limit: 1, cursor: required(page.pagination.nextCursor) });
    expect(laterPage.profile?.version).toBe(revision.version);
    expect(laterPage.profile?.availabilityRevision).not.toBe(revision.availabilityRevision);
    snapshot = await f.snapshot();
    const hidden = required(snapshot.entries.find((e) => e.id === firstEntry.id));
    expect(hidden.readable).toBe(false);
    expect(hidden.content).toBe("");
    expect(hidden.itemId).toBeNull();
    expect(hidden.history).toHaveLength(0);
    expect(snapshot.consumers.find((c) => c.id === "boundary_file")?.status).toBe("pending");
    expect(snapshot.verification.status).not.toBe("passed");
    expect(
      (
        await sharedMemoryAction(f.db, f.owner.id, f.canonical.organization.id, {
          type: "verify",
          runId: required(run).id,
          entryIds: [firstEntry.id],
        })
      ).snapshot.verification.status,
    ).toBe("failed");
    expect(
      (await sharedMemoryVisibleIds(f.db, f.canonical.organization.id, [first.id], f.owner.id)).has(first.id),
    ).toBe(false);
    const repaired = await reconcileSharedMemory(f.db, f.profile.id);
    expect(repaired.blocked).toBe(1);
    expect(repaired.updated).toBe(1);
    const healthy = required((await f.snapshot()).entries.find((e) => e.id === secondEntry.id));
    expect(healthy.replicas[0]?.state).toBe("current");
  });

  test("one profile cannot disable or attach an unenrolled foreign workspace", async () => {
    const f = await fixture();
    const foreign = await addUser(f.db, "ForeignOwner");
    const other = await createOrganization(f.db, foreign.id, { name: "Foreign personal" });
    const item = await addContextItemByPerson(f.db, foreign.id, other.organization.id, {
      kind: "fact",
      content: "Foreign synthetic detail.",
    });
    const foreignConfigured = await sharedMemoryAction(f.db, foreign.id, other.organization.id, {
      type: "configure",
      adopt: [{ itemId: item.id, key: "foreign.detail" }],
    });
    await expect(
      sharedMemoryAction(f.db, f.owner.id, f.canonical.organization.id, {
        type: "destination",
        orgId: other.organization.id,
        enabled: false,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    const [unchanged] = await f.db
      .select()
      .from(schema.sharedMemoryDestinations)
      .where(
        and(
          eq(schema.sharedMemoryDestinations.profileId, required(foreignConfigured.snapshot.profile).id),
          eq(schema.sharedMemoryDestinations.orgId, other.organization.id),
        ),
      );
    expect(unchanged?.state).toBe("active");
    expect((await f.snapshot()).destinations.some((d) => d.orgId === other.organization.id)).toBe(false);
    expect((await sharedMemorySnapshot(f.db, foreign.id, other.organization.id)).entries[0]?.readable).toBe(true);
  });

  test("forget tombstones also fence pre-existing native rows at capture, adoption and acceptance", async () => {
    const testDb = await createTestDatabase();
    close = testDb.close;
    const db = testDb.db;
    const owner = await addUser(db, "TombstoneOwner");
    const canonical = await createOrganization(db, owner.id, { name: "Tombstone personal" });
    const originals = [];
    for (let i = 0; i < 3; i++)
      originals.push(
        await addContextItemByPerson(db, owner.id, canonical.organization.id, {
          kind: "fact",
          title: `Native source ${i}`,
          content: "The synthetic project is Cedar.",
        }),
      );
    const enrolled = await sharedMemoryAction(db, owner.id, canonical.organization.id, {
      type: "configure",
      adopt: [{ itemId: required(originals[0]).id, key: "synthetic.project" }],
    });
    const entry = required(enrolled.snapshot.entries[0]);
    const corrected = await sharedMemoryAction(db, owner.id, canonical.organization.id, {
      type: "correct",
      entryId: entry.id,
      expectedVersion: entry.version,
      content: "The synthetic project is Willow.",
    });
    const captured = await sharedMemoryAction(db, owner.id, canonical.organization.id, {
      type: "capture",
      sourceOrgId: canonical.organization.id,
      itemId: required(originals[1]).id,
      key: "old.candidate",
    });
    const candidate = required(captured.snapshot.candidates[0]);
    await sharedMemoryAction(db, owner.id, canonical.organization.id, {
      type: "forget",
      entryId: entry.id,
      expectedVersion: required(corrected.snapshot.entries[0]).version,
      scope: "profile",
    });
    const forgottenCandidate = (await sharedMemorySnapshot(db, owner.id, canonical.organization.id)).entries.find(
      (e) => e.id === candidate.id,
    );
    expect(forgottenCandidate?.status).toBe("forgotten");
    expect(forgottenCandidate?.content).toBe("");
    const [erasedCandidate] = await db
      .select()
      .from(schema.contextItems)
      .where(eq(schema.contextItems.id, required(originals[1]).id));
    expect(erasedCandidate?.content).toBe("");
    await expect(
      sharedMemoryAction(db, owner.id, canonical.organization.id, {
        type: "capture",
        sourceOrgId: canonical.organization.id,
        itemId: required(originals[2]).id,
        key: "old.capture",
      }),
    ).rejects.toMatchObject({ code: "shared_memory.forgotten" });
    await expect(
      sharedMemoryAction(db, owner.id, canonical.organization.id, {
        type: "configure",
        adopt: [{ itemId: required(originals[2]).id, key: "old.adoption" }],
      }),
    ).rejects.toMatchObject({ code: "shared_memory.forgotten" });
    await expect(
      sharedMemoryAction(db, owner.id, canonical.organization.id, {
        type: "decide",
        entryId: candidate.id,
        expectedVersion: required(forgottenCandidate).version,
        decision: "accept",
      }),
    ).rejects.toMatchObject({ code: "shared_memory.forgotten" });
  });
});
