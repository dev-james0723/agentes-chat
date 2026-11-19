import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import {
  addChannelMember,
  createChannel,
  createThreadFromRange,
  deleteContextItem,
  deleteThread,
  indexSource,
  insertContextItem,
  postPersonMessage,
  reapplyMemoryDeletions,
  retrieveForRun,
} from "../src";
import { caches, enableCaches } from "../src/cache";
import { removeMember } from "../src/organizations";
import { addMember, type Fixture, setup } from "./fixtures";

/** Acceptance A18 of the long-term memory plan (T02): a revocation reaches a run with the caches warm, as on a server. */
let f: Fixture;
afterEach(async () => {
  enableCaches(false);
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

async function remember(content: string, channelId: string) {
  const item = await insertContextItem(f.db, {
    orgId: f.org.id,
    kind: "fact",
    scopeType: "agent",
    scopeId: f.agent.id,
    agentId: f.agent.id,
    channelIds: [channelId],
    content,
    trust: "high",
    evidence: [{ type: "human", ref: f.owner.id, at: new Date().toISOString() }],
    createdByKind: "person",
    createdById: f.owner.id,
  });
  await indexSource(f.context, { orgId: f.org.id, kind: "context_item", sourceId: item.id });
  return item;
}

const run = (channelId: string, text: string) =>
  retrieveForRun(f.context, { orgId: f.org.id, agentId: f.agent.id, channelId, text, personIds: [f.owner.id] });

describe("A18: a revoked channel stops reaching runs at once, with every cache warm", () => {
  test("the agent removed from a private channel behind the caches' back: its memory stays out of the next run", async () => {
    f = await setup();
    enableCaches();
    const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "revoked-kestrel", visibility: "private" });
    await addChannelMember(f.db, f.owner.id, f.org.id, secret.id, { agentId: f.agent.id });
    const hidden = await remember("Kestrel's acquisition price is 4.2 million.", secret.id);
    const control = await remember("Kestrel ships from the Osaka region.", f.general.id);

    // Warm: the scope, presence and member caches now hold the agent's access to the channel.
    expect((await run(secret.id, "Kestrel acquisition price and region")).itemIds).toContain(hidden.id);
    expect((caches.scopes as unknown as { entries: Map<string, unknown> }).entries.size).toBeGreaterThan(0);

    // Revoked in the database with no invalidation at all: only a fresh check can catch it.
    await f.db
      .delete(schema.channelMembers)
      .where(
        and(
          eq(schema.channelMembers.orgId, f.org.id),
          eq(schema.channelMembers.agentId, f.agent.id),
          eq(schema.channelMembers.channelId, secret.id),
        ),
      );
    const fromGeneral = await run(f.general.id, "Kestrel acquisition price and region");
    expect(fromGeneral.itemIds).not.toContain(hidden.id);
    expect(fromGeneral.text).not.toContain("4.2 million");
    expect(fromGeneral.itemIds).toContain(control.id);
    const fromSecret = await run(secret.id, "Kestrel acquisition price and region");
    expect(fromSecret.itemIds).not.toContain(hidden.id);
    expect(fromSecret.text).not.toContain("4.2 million");
  });

  test("a person removed from the organization: every cached member list of their channels is dropped at once", async () => {
    f = await setup();
    enableCaches();
    const bob = await addMember(f.db, f.org.id, "member", "bob");
    const room = await createChannel(f.db, f.owner.id, f.org.id, { name: "bob-room", visibility: "private" });
    await addChannelMember(f.db, f.owner.id, f.org.id, room.id, { userId: bob.id });
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bob.id }).catch(() => undefined);
    caches.channelMembers.set(`${f.org.id}:${room.id}`, ["cached with bob"]);
    caches.channelMembers.set(`${f.org.id}:${f.general.id}`, ["cached with bob"]);

    await removeMember(f.db, f.owner.id, f.org.id, bob.id);

    expect(caches.channelMembers.get(`${f.org.id}:${room.id}`)).toBeUndefined();
    expect(caches.channelMembers.get(`${f.org.id}:${f.general.id}`)).toBeUndefined();
  });
});

const derivedFrom = async (sourceId: string, content: string) => {
  const item = await insertContextItem(f.db, {
    orgId: f.org.id,
    kind: "fact",
    scopeType: "agent",
    scopeId: f.agent.id,
    agentId: f.agent.id,
    channelIds: [f.general.id],
    content,
    sourceIds: [sourceId],
    trust: "high",
    createdByKind: "agent",
    createdById: f.agent.id,
  });
  await indexSource(f.context, { orgId: f.org.id, kind: "context_item", sourceId: item.id });
  return item;
};
const row = async (id: string) =>
  (await f.db.select().from(schema.contextItems).where(eq(schema.contextItems.id, id)))[0];
const indexed = async (id: string) =>
  (await f.db.select().from(schema.searchDocuments).where(eq(schema.searchDocuments.sourceId, id))).length;

describe("A17: a deletion takes what was derived from it out of use", () => {
  test("deleting a memory removes its use records, its search entry and the memory built on it", async () => {
    f = await setup();
    const base = await remember("Kestrel ships from the Osaka region.", f.general.id);
    const derived = await derivedFrom(base.id, "Kestrel's release train leaves from Osaka every Friday.");
    await f.db.insert(schema.contextUsage).values({ orgId: f.org.id, runId: crypto.randomUUID(), itemId: base.id });
    expect(await indexed(base.id)).toBe(1);

    await deleteContextItem(f.db, f.owner.id, f.org.id, base.id);
    await indexSource(f.context, { orgId: f.org.id, kind: "context_item", sourceId: base.id });
    await indexSource(f.context, { orgId: f.org.id, kind: "context_item", sourceId: derived.id });

    expect(await row(base.id)).toBeUndefined();
    expect(await f.db.select().from(schema.contextUsage).where(eq(schema.contextUsage.itemId, base.id))).toEqual([]);
    expect(await indexed(base.id)).toBe(0);
    expect((await row(derived.id))?.status).toBe("archived");
    expect(await indexed(derived.id)).toBe(0);
    const pack = await run(f.general.id, "Kestrel Osaka release");
    expect(pack.itemIds).not.toContain(base.id);
    expect(pack.itemIds).not.toContain(derived.id);
  });

  test("deleting a thread takes the memory drawn from its message out of use", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const a = await postPersonMessage(deps, f.owner.id, f.org.id, f.general.id, { body: "Kestrel moves to Osaka" });
    const b = await postPersonMessage(deps, f.owner.id, f.org.id, f.general.id, { body: "Confirmed for Friday" });
    const thread = await createThreadFromRange(deps, f.owner.id, {
      orgId: f.org.id,
      channelId: f.general.id,
      firstMessageId: a.id,
      lastMessageId: b.id,
    });
    const drawn = await derivedFrom(thread.id, "Kestrel moves to Osaka on Friday.");
    await deleteThread(deps, f.owner.id, f.org.id, thread.id);
    expect((await row(drawn.id))?.status).toBe("archived");
  });
});

describe("A19: a restore from an older backup deletes again what people deleted since", () => {
  test("a whole-database restore brings back the item and drops the in-database record; the kept copy deletes it again", async () => {
    f = await setup();
    const item = await remember("Kestrel's acquisition price is 4.2 million.", f.general.id);
    const backup = await row(item.id);
    if (!backup) throw new Error("no row");
    await deleteContextItem(f.db, f.owner.id, f.org.id, item.id);

    // The restore: the database as it was before the deletion, its own deletion record gone with it.
    await f.db.delete(schema.contextItemDeletions);
    await f.db.insert(schema.contextItems).values(backup);
    expect(await reapplyMemoryDeletions(f.db)).toBe(0);
    expect(await row(item.id)).toBeDefined();

    // The copy kept outside the database (the files folder) still has it.
    expect(await reapplyMemoryDeletions(f.db, [{ itemId: item.id, orgId: f.org.id }])).toBe(1);
    expect(await row(item.id)).toBeUndefined();
    expect(await f.db.select().from(schema.contextItemDeletions)).toHaveLength(1);
    expect(await reapplyMemoryDeletions(f.db, [{ itemId: item.id, orgId: f.org.id }])).toBe(0);
  });

  test("a kept record from another organization never deletes an item of this one", async () => {
    f = await setup();
    const item = await remember("Kestrel ships from Osaka.", f.general.id);
    expect(await reapplyMemoryDeletions(f.db, [{ itemId: item.id, orgId: crypto.randomUUID() }])).toBe(0);
    expect(await row(item.id)).toBeDefined();
  });
});

describe("A17: a cascade never retires what a person wrote, pinned or set as a rule", () => {
  test("only the agent's own derived memory goes; the person's, the pinned one and the rule stay", async () => {
    f = await setup();
    const base = await remember("Kestrel ships from Osaka.", f.general.id);
    const agentOwn = await derivedFrom(base.id, "Kestrel's release train leaves from Osaka.");
    const pinned = await derivedFrom(base.id, "Kestrel's ops team sits in Osaka.");
    await f.db.update(schema.contextItems).set({ pinned: true }).where(eq(schema.contextItems.id, pinned.id));
    const personal = await insertContextItem(f.db, {
      orgId: f.org.id,
      kind: "fact",
      scopeType: "agent",
      scopeId: f.agent.id,
      agentId: f.agent.id,
      channelIds: [f.general.id],
      content: "I want Kestrel news in Osaka time.",
      sourceIds: [base.id],
      trust: "high",
      createdByKind: "person",
      createdById: f.owner.id,
    });
    const before = (await row(agentOwn.id))?.version ?? 0;
    await deleteContextItem(f.db, f.owner.id, f.org.id, base.id);
    expect((await row(agentOwn.id))?.status).toBe("archived");
    expect((await row(agentOwn.id))?.version).toBe(before + 1);
    expect((await row(pinned.id))?.status).toBe("active");
    expect((await row(personal.id))?.status).toBe("active");
  });
});

describe("A03: a fresh run picks the work up from memory, not from the old conversation", () => {
  test("a new run in the task's channel receives the accepted decision with its source, and not the replaced one", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const said = await postPersonMessage(deps, f.owner.id, f.org.id, f.general.id, {
      body: "Decision: Kestrel ships from Osaka, release code KT-7731.",
    });
    const old = await insertContextItem(f.db, {
      orgId: f.org.id,
      kind: "decision",
      scopeType: "agent",
      scopeId: f.agent.id,
      agentId: f.agent.id,
      subject: "Kestrel release",
      content: "Kestrel ships from Frankfurt.",
      sourceIds: [said.id],
      channelIds: [f.general.id],
      trust: "high",
      evidence: [{ type: "human", ref: said.id, at: new Date().toISOString() }],
      createdByKind: "person",
      createdById: f.owner.id,
    });
    const { supersede } = await import("../src/context/items");
    const current = await f.db.transaction((tx) =>
      supersede(tx, old, {
        orgId: f.org.id,
        kind: "decision",
        scopeType: "agent",
        scopeId: f.agent.id,
        agentId: f.agent.id,
        subject: "Kestrel release",
        content: "Kestrel ships from Osaka, release code KT-7731.",
        sourceIds: [said.id],
        channelIds: [f.general.id],
        trust: "high",
        evidence: [{ type: "human", ref: said.id, at: new Date().toISOString() }],
        createdByKind: "person",
        createdById: f.owner.id,
      }),
    );
    await indexSource(f.context, { orgId: f.org.id, kind: "context_item", sourceId: current.id });
    await indexSource(f.context, { orgId: f.org.id, kind: "context_item", sourceId: old.id });

    // A fresh run: no transcript carried over, only what memory gives it.
    const fresh = await run(
      f.general.id,
      "Continue the Kestrel release: where does it ship from and what is the code?",
    );
    const text = fresh.text + (fresh.requiredText ?? "");
    expect(fresh.itemIds).toContain(current.id);
    expect(fresh.itemIds).not.toContain(old.id);
    expect(text).toContain("KT-7731");
    expect(text).not.toContain("Frankfurt");
  });
});
