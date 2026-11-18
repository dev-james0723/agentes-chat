import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import {
  addChannelMember,
  createChannel,
  createOrganization,
  drainOutbox,
  indexSource,
  insertMessage,
  postPersonMessage,
  retrieveForRun,
  searchForUser,
  type ToolContext,
} from "../src";
import { buildMemoryPack } from "../src/context/context-pack";
import {
  deleteContextItem,
  editContextItem,
  insertContextItem,
  makeTeamMemory,
  type NewContextItem,
} from "../src/context/items";
import { teamMemoryForPrompt } from "../src/context/tools";
import { ForbiddenError } from "../src/errors";
import { openRoutineRoom } from "../src/routine-room";
import { addUser, type Fixture, setup } from "./fixtures";

let f: Fixture;
/** A number marker can turn up inside a random id by chance: drop ids before checking that one stays out. */
const withoutIds = (text: string) =>
  text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>");
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

async function add(values: Partial<NewContextItem> & Pick<NewContextItem, "content">) {
  const item = await insertContextItem(f.db, {
    orgId: f.org.id,
    kind: "fact",
    scopeType: "agent",
    scopeId: f.agent.id,
    agentId: f.agent.id,
    channelIds: [f.general.id],
    createdByKind: "agent",
    createdById: f.agent.id,
    ...values,
  });
  await indexSource(f.context, { orgId: f.org.id, kind: "context_item", sourceId: item.id });
  return item;
}

async function run(channelId = f.general.id): Promise<ToolContext> {
  const trigger = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId,
    author: { type: "person", userId: f.owner.id },
    body: "What is the current Orion decision?",
  });
  const [row] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId,
      threadRootId: trigger.id,
      triggerMessageId: trigger.id,
      trigger: "mention",
      hop: 1,
    })
    .returning();
  if (!row) throw new Error("no test run");
  return {
    db: f.db,
    orgId: f.org.id,
    agentId: f.agent.id,
    runId: row.id,
    channelId,
    threadRootId: trigger.id,
    triggerMessageId: trigger.id,
  };
}

async function call(ctx: ToolContext, name: string, input: Record<string, unknown>) {
  if (!f.tools) throw new Error("no test tools");
  const result = await f.tools.invoke(ctx, { toolUseId: crypto.randomUUID(), name, input });
  if (result.type !== "result") throw new Error(result.type);
  return result.output as { content: string; isError?: boolean; data?: { hits?: number } };
}

const memory = () =>
  retrieveForRun(f.context, {
    orgId: f.org.id,
    agentId: f.agent.id,
    channelId: f.general.id,
    personIds: [f.owner.id],
    text: "Orion",
  });

describe("current canonical memory wins over delayed index jobs", () => {
  for (const change of ["deleted", "archived", "superseded", "restricted"] as const) {
    test(`search excludes a ${change} indexed memory and its result count`, async () => {
      f = await setup({ contextTools: true });
      const stale = await add({ title: "Orion obsolete marker", content: "Orion retired instruction 641." });
      const allowed = await add({ title: "Orion allowed control", content: "Orion current instruction 972." });
      if (change === "deleted") await deleteContextItem(f.db, f.owner.id, f.org.id, stale.id);
      else if (change === "archived") await editContextItem(f.db, f.owner.id, f.org.id, stale.id, { archived: true });
      else if (change === "superseded") {
        await f.db
          .update(schema.contextItems)
          .set({ supersededBy: allowed.id })
          .where(eq(schema.contextItems.id, stale.id));
      } else {
        const privateChannel = await createChannel(f.db, f.owner.id, f.org.id, {
          name: "private-orion",
          visibility: "private",
        });
        await addChannelMember(f.db, f.owner.id, f.org.id, privateChannel.id, { agentId: f.agent.id });
        await f.db
          .update(schema.contextItems)
          .set({ channelIds: [privateChannel.id] })
          .where(eq(schema.contextItems.id, stale.id));
      }
      expect(
        await f.db.select().from(schema.searchDocuments).where(eq(schema.searchDocuments.sourceId, stale.id)),
      ).toHaveLength(1);
      // Do not run the queued index job: canonical visibility must take effect immediately.
      const result = await call(await run(), "search_context", { query: "Orion", kinds: ["context_item"], limit: 20 });
      expect(result.content).toContain(allowed.id);
      expect(result.content).not.toContain(stale.id);
      expect(result.content).not.toContain("retired instruction 641");
      expect(result.content).not.toContain("obsolete marker");
      expect(result.data?.hits).toBe(1);
    });
  }

  test("a new run excludes an indexed memory moved into another private channel", async () => {
    f = await setup({ contextTools: true });
    const privateChannel = await createChannel(f.db, f.owner.id, f.org.id, {
      name: "private-orion",
      visibility: "private",
    });
    await addChannelMember(f.db, f.owner.id, f.org.id, privateChannel.id, { agentId: f.agent.id });
    const stale = await add({ title: "Orion retired", content: "Orion retired instruction 641." });
    const allowed = await add({ title: "Orion current", content: "Orion current instruction 972." });
    await f.db
      .update(schema.contextItems)
      .set({ channelIds: [privateChannel.id] })
      .where(eq(schema.contextItems.id, stale.id));
    const result = await memory();
    expect(result.itemIds).toContain(allowed.id);
    expect(result.itemIds).not.toContain(stale.id);
    expect(result.text).not.toContain("retired instruction 641");
    expect(result.text).not.toContain("Orion retired");
  });

  test("search renders the current canonical content instead of a copied index snippet", async () => {
    f = await setup({ contextTools: true });
    const item = await add({ title: "Orion old title", content: "Orion retired instruction 641." });
    await f.db
      .update(schema.contextItems)
      .set({
        title: "Orion current title",
        content: "Orion current instruction 972.",
      })
      .where(eq(schema.contextItems.id, item.id));
    const result = await call(await run(), "search_context", { query: "Orion", kinds: ["context_item"] });
    expect(result.content).toContain("current instruction 972");
    expect(result.content).toContain("Orion current title");
    expect(result.content).not.toContain("Orion old title");
    expect(result.content).not.toContain("retired instruction 641");
  });
});

describe("reopening and sharing preserve each source boundary", () => {
  test("expand denies a memory whose required source message was deleted", async () => {
    f = await setup({ contextTools: true });
    const source = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: f.owner.id },
      body: "Withdrawn source detail 563.",
    });
    const item = await add({ content: "Orion current decision.", sourceIds: [source.id] });
    await f.db.update(schema.messages).set({ deletedAt: new Date() }).where(eq(schema.messages.id, source.id));
    const result = await call(await run(), "expand", { item_id: item.id });
    expect(result.isError).toBe(true);
    expect(result.content).not.toContain("Orion current decision");
    expect(result.content).not.toContain("Withdrawn source detail 563");
    expect(result.content).not.toContain(`source message ${source.id}`);
  });

  test("even an owner cannot implicitly publish a private-channel memory to the whole team", async () => {
    f = await setup();
    const privateChannel = await createChannel(f.db, f.owner.id, f.org.id, {
      name: "private-orion",
      visibility: "private",
    });
    const item = await add({ content: "Orion private detail 852.", channelIds: [privateChannel.id] });
    await expect(makeTeamMemory(f.db, f.owner.id, f.org.id, item.id)).rejects.toBeInstanceOf(ForbiddenError);
    const rows = await f.db.select().from(schema.contextItems);
    expect(rows.filter((row) => row.agentId === null)).toHaveLength(0);
    expect(rows.find((row) => row.id === item.id)?.status).toBe("active");
  });

  test("a broad item label does not grant publication of its private source", async () => {
    f = await setup();
    const privateChannel = await createChannel(f.db, f.owner.id, f.org.id, {
      name: "private-orion",
      visibility: "private",
    });
    const source = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: privateChannel.id,
      author: { type: "person", userId: f.owner.id },
      body: "Orion private detail 852.",
    });
    const item = await add({ content: "Orion private detail 852.", channelIds: [], sourceIds: [source.id] });
    await expect(makeTeamMemory(f.db, f.owner.id, f.org.id, item.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await f.db.select().from(schema.contextItems)).filter((row) => row.agentId === null)).toHaveLength(0);
  });
  test("a public-source item can still become team memory", async () => {
    f = await setup();
    const source = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: f.owner.id },
      body: "Orion public decision 441.",
    });
    const item = await add({ content: source.body, sourceIds: [source.id] });
    const team = await makeTeamMemory(f.db, f.owner.id, f.org.id, item.id);
    expect(team.agentId).toBeNull();
    expect(team.content).toBe(source.body);
  });

  test("legacy empty channelIds cannot declassify a private source into a public search or pack", async () => {
    f = await setup({ contextTools: true });
    const channel = await createChannel(f.db, f.owner.id, f.org.id, { name: "private-orion", visibility: "private" });
    await addChannelMember(f.db, f.owner.id, f.org.id, channel.id, { agentId: f.agent.id });
    const source = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: channel.id,
      author: { type: "person", userId: f.owner.id },
      body: "Orion private decision 852.",
    });
    const item = await add({
      title: "Orion confidential marker",
      content: source.body,
      channelIds: [],
      sourceIds: [source.id],
    });
    const control = await add({ content: "Orion public decision 441." });
    const result = await call(await run(), "search_context", { query: "Orion", kinds: ["context_item"], limit: 20 });
    expect(result.content).toContain(control.id);
    expect(result.content).not.toContain(item.id);
    expect(result.content).not.toContain("confidential marker");
    expect(result.data?.hits).toBe(1);
    const pack = await memory();
    expect(pack.itemIds).toContain(control.id);
    expect(withoutIds(pack.text)).not.toContain("852");
    expect(pack.text).not.toContain("confidential marker");
    const privatePack = await retrieveForRun(f.context, {
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: channel.id,
      personIds: [f.owner.id],
      text: "Orion",
    });
    expect(privatePack.itemIds).toContain(item.id);
    expect(privatePack.text).toContain("852");
  });

  test("deleting the sole source excludes its derived claim from current search and injection", async () => {
    f = await setup({ contextTools: true });
    const source = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: f.owner.id },
      body: "Orion unsupported after withdrawal 563.",
    });
    const item = await add({ content: source.body, sourceIds: [source.id] });
    const control = await add({ content: "Orion public decision 441." });
    await f.db.update(schema.messages).set({ deletedAt: new Date() }).where(eq(schema.messages.id, source.id));
    const result = await call(await run(), "search_context", { query: "Orion", kinds: ["context_item"], limit: 20 });
    expect(result.content).toContain(control.id);
    expect(result.content).not.toContain(item.id);
    expect(withoutIds((await memory()).text)).not.toContain("563");
  });

  test("an unresolved source does not become current evidence through a local item", async () => {
    f = await setup({ contextTools: true });
    const item = await add({ content: "Orion unresolvable source 214.", sourceIds: [crypto.randomUUID()] });
    const control = await add({ content: "Orion public decision 441." });
    const result = await call(await run(), "search_context", { query: "Orion", kinds: ["context_item"] });
    expect(result.content).toContain(control.id);
    expect(result.content).not.toContain(item.id);
    expect(withoutIds((await memory()).text)).not.toContain("214");
  });

  test("a private conversation cannot save or propose an organization-wide team memory", async () => {
    f = await setup({ contextTools: true });
    const channel = await createChannel(f.db, f.owner.id, f.org.id, { name: "private-orion", visibility: "private" });
    await addChannelMember(f.db, f.owner.id, f.org.id, channel.id, { agentId: f.agent.id });
    const result = await call(await run(channel.id), "remember", {
      content: "Orion private decision 852.",
      kind: "fact",
      basis: "person_said",
      for: "team",
      everywhere: true,
    });
    expect(result.isError).toBe(true);
    expect((await f.db.select().from(schema.contextItems)).filter((i) => i.agentId === null)).toHaveLength(0);
  });

  test("unknown empty provenance cannot be promoted to the whole team", async () => {
    f = await setup();
    const item = await add({ content: "Orion unknown origin 780.", channelIds: [], sourceIds: [] });
    await expect(makeTeamMemory(f.db, f.owner.id, f.org.id, item.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await f.db.select().from(schema.contextItems)).filter((i) => i.agentId === null)).toHaveLength(0);
  });

  test("shared public source descendants are valid but a source cycle fails closed", async () => {
    f = await setup({ contextTools: true });
    const source = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: f.owner.id },
      body: "Orion public leaf 108.",
    });
    const shared = await add({ content: "Orion shared evidence 108.", sourceIds: [source.id] });
    const left = await add({ content: "Orion left evidence 208.", sourceIds: [shared.id] });
    const right = await add({ content: "Orion right evidence 308.", sourceIds: [shared.id] });
    const root = await add({ content: "Orion conclusion 408.", sourceIds: [left.id, right.id] });
    expect((await memory()).itemIds).toContain(root.id);
    expect((await makeTeamMemory(f.db, f.owner.id, f.org.id, root.id)).agentId).toBeNull();
    const a = await add({ content: "Orion cyclic evidence 508." });
    const b = await add({ content: "Orion cyclic evidence 608.", sourceIds: [a.id] });
    await f.db
      .update(schema.contextItems)
      .set({ sourceIds: [b.id] })
      .where(eq(schema.contextItems.id, a.id));
    expect((await memory()).itemIds).not.toContain(a.id);
    await expect(makeTeamMemory(f.db, f.owner.id, f.org.id, a.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("deleting a source invalidates a dependent chain without waiting for index jobs", async () => {
    f = await setup({ contextTools: true });
    const source = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: f.owner.id },
      body: "Orion initial source 108.",
    });
    const first = await add({ content: "Orion first derivation 208.", sourceIds: [source.id] });
    const second = await add({ content: "Orion second derivation 308.", sourceIds: [first.id] });
    expect((await call(await run(), "expand", { item_id: second.id })).content).toContain("308");
    await f.db.update(schema.messages).set({ deletedAt: new Date() }).where(eq(schema.messages.id, source.id));
    expect((await call(await run(), "expand", { item_id: second.id })).isError).toBe(true);
    expect((await memory()).itemIds).not.toContain(second.id);
  });

  test("an oversized pinned fact remains optional evidence with a reopen reference", async () => {
    f = await setup();
    const item = await add({ pinned: true, content: "Orion factual background. ".repeat(200) });
    const packed = await memory();
    expect(packed.itemIds).not.toContain(item.id);
    expect(packed.text).toContain(item.id);
    expect(packed.text).toContain("expand");
    expect(packed.text).not.toContain("Orion factual background.");
  });

  test("optional memory is whole or omitted, never a clipped negation or numeric constraint", async () => {
    f = await setup();
    const content = "Orion background. ".repeat(60) + "Do not deploy before 2026-12-01; the limit is 17.";
    const item = await add({ title: "Orion deployment rule reference", content });
    const pack = await memory();
    if (pack.itemIds.includes(item.id)) expect(pack.text).toContain(content);
    else expect(pack.text).not.toContain("Orion background.");
    expect(pack).toMatchObject({ pack: { countKind: "estimated", counter: "utf8-byte-estimate-v1" } });
    expect(new TextEncoder().encode(pack.text).length).toBeLessThanOrEqual(3000);
  });

  test("search returns bounded canonical evidence with a reopen reference for an oversized result", async () => {
    f = await setup({ contextTools: true });
    const item = await add({
      title: "Orion long source",
      content: "Orion background. ".repeat(400) + "Do not approve before 2026-12-01.",
    });
    const result = await call(await run(), "search_context", { query: "Orion", kinds: ["context_item"] });
    expect(new TextEncoder().encode(result.content).length).toBeLessThanOrEqual(3000);
    expect(result.content).toContain(item.id);
    expect(result.content).toContain("expand");
    expect(result.content).not.toContain("Orion background.");
  });

  test("an explicitly required pack entry cannot be silently clipped on overflow", () => {
    expect(() =>
      buildMemoryPack([{ id: "mandatory", text: "Do not deploy. ".repeat(100), required: true }], { limit: 100 }),
    ).toThrow();
  });

  test("native user search checks canonical archive state before index catches up", async () => {
    f = await setup();
    const item = await add({ content: "Orion obsolete user search 813." });
    const control = await add({ content: "Orion allowed user search 914." });
    await editContextItem(f.db, f.owner.id, f.org.id, item.id, { archived: true });
    const hits = await searchForUser(f.context, f.owner.id, f.org.id, { text: "Orion", kinds: ["context_item"] });
    expect(hits.map((h) => h.sourceId)).toContain(control.id);
    expect(hits.map((h) => h.sourceId)).not.toContain(item.id);
  });

  test("a nested unknown source cannot be laundered through a public wrapper", async () => {
    f = await setup();
    const leaf = await add({ content: "Orion unknown leaf 515.", channelIds: [], sourceIds: [] });
    const middle = await add({ content: "Orion public-labelled middle 616.", sourceIds: [leaf.id] });
    const wrapper = await add({ content: "Orion public-labelled wrapper 717.", sourceIds: [middle.id] });
    await expect(makeTeamMemory(f.db, f.owner.id, f.org.id, wrapper.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("duplicate pack ids cannot replace a required entry with different optional text", () => {
    expect(() =>
      buildMemoryPack(
        [
          { id: "same", text: "Do not deploy before 2026-12-01.", required: true },
          { id: "same", text: "Deploy now.", required: false },
        ],
        { limit: 100 },
      ),
    ).toThrow();
    expect(() =>
      buildMemoryPack(
        [
          { id: "same", text: "Do not deploy before 2026-12-01.", required: true },
          { id: "same", text: "Do not deploy before 2026-12-01.", required: false },
        ],
        { limit: 5 },
      ),
    ).toThrow();
  });

  test("mandatory native rules and long raw user instructions stay outside the additive evidence cap", async () => {
    const captured: string[] = [];
    f = await setup({
      contextTools: true,
      reply: (request) => {
        captured.push(JSON.stringify(request));
        return { chunks: ["done"] };
      },
    });
    const rule = "Always preserve the user's exact dates and constraints. ".repeat(55) + "RULE_SENTINEL_731";
    await add({
      kind: "rule",
      content: rule,
      channelIds: [],
      createdByKind: "person",
      createdById: f.owner.id,
      evidence: [{ type: "human", ref: f.owner.id, at: new Date().toISOString() }],
    });
    await add({ pinned: true, content: "Orion has a short factual memory." });
    const body =
      "@dev ORIGINAL_START\n" +
      "原文指示不可截短。".repeat(160) +
      "\nDo not deploy before 2026-12-01; limit 17. ORIGINAL_END";
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body });
    await drainOutbox(f.db, f.handlers);
    expect(captured.length).toBeGreaterThan(0);
    expect(
      captured.some(
        (request) =>
          request.includes(JSON.stringify(body).slice(1, -1)) && request.includes(JSON.stringify(rule).slice(1, -1)),
      ),
    ).toBe(true);
    expect((await f.db.select().from(schema.messages)).some((message) => message.body === body)).toBe(true);
  });

  test("real organizations in one database cannot share memory or launder a foreign source", async () => {
    f = await setup({ contextTools: true });
    const ownerB = await addUser(f.db, "other");
    const { organization: orgB, general: channelB } = await createOrganization(f.db, ownerB.id, {
      name: "Other",
      context: "Synthetic isolation.",
    });
    const sourceB = await insertMessage(f.db, {
      orgId: orgB.id,
      channelId: channelB.id,
      author: { type: "person", userId: ownerB.id },
      body: "Orion foreign source 982.",
    });
    const itemB = await insertContextItem(f.db, {
      orgId: orgB.id,
      kind: "fact",
      scopeType: "org",
      scopeId: orgB.id,
      content: "Orion foreign memory 983.",
      title: "Foreign confidential marker",
      sourceIds: [sourceB.id],
      channelIds: [channelB.id],
    });
    await indexSource(f.context, { orgId: orgB.id, kind: "context_item", sourceId: itemB.id });
    const wrapper = await add({ content: "Orion foreign-derived wrapper 984.", sourceIds: [itemB.id] });
    const control = await add({ content: "Orion allowed company A 985." });
    const result = await call(await run(), "search_context", { query: "Orion", kinds: ["context_item"] });
    expect(result.content).toContain(control.id);
    for (const denied of [itemB.id, wrapper.id, "Foreign confidential marker"])
      expect(result.content).not.toContain(denied);
    for (const denied of ["983", "984"]) expect(withoutIds(result.content)).not.toContain(denied);
    expect(result.data?.hits).toBe(1);
    expect((await call(await run(), "expand", { item_id: itemB.id })).isError).toBe(true);
    expect(withoutIds((await memory()).text)).not.toContain("983");
  });

  test("membership revocation is applied without waiting for the scope cache", async () => {
    f = await setup({ contextTools: true });
    const privateChannel = await createChannel(f.db, f.owner.id, f.org.id, {
      name: "revoked-orion",
      visibility: "private",
    });
    await addChannelMember(f.db, f.owner.id, f.org.id, privateChannel.id, { agentId: f.agent.id });
    const privateItem = await add({ content: "Orion revocable source 183.", channelIds: [privateChannel.id] });
    const control = await add({ content: "Orion public control 284." });
    const ctx = await run(privateChannel.id);
    expect((await call(ctx, "search_context", { query: "Orion", kinds: ["context_item"] })).content).toContain(
      privateItem.id,
    );
    await f.db
      .delete(schema.channelMembers)
      .where(
        and(
          eq(schema.channelMembers.orgId, f.org.id),
          eq(schema.channelMembers.agentId, f.agent.id),
          eq(schema.channelMembers.channelId, privateChannel.id),
        ),
      );
    const result = await call(ctx, "search_context", { query: "Orion", kinds: ["context_item"] });
    expect(result.content).not.toContain(privateItem.id);
    expect(result.content).toContain(control.id);
  });

  test("a routine resolves its real public or private report audience", async () => {
    f = await setup({ contextTools: true });
    const report = await createChannel(f.db, f.owner.id, f.org.id, { name: "private-report", visibility: "private" });
    await addChannelMember(f.db, f.owner.id, f.org.id, report.id, { agentId: f.agent.id });
    const [routine] = await f.db
      .insert(schema.routines)
      .values({
        orgId: f.org.id,
        agentId: f.agent.id,
        name: "Orion report",
        prompt: "Report Orion",
        target: { type: "channel", channelId: f.general.id },
        triggerType: "schedule",
        cron: "0 9 * * *",
        timezone: "UTC",
        createdByUserId: f.owner.id,
      })
      .returning();
    if (!routine) throw new Error("missing fixture routine");
    const room = await openRoutineRoom(f.db, f.org.id, f.agent.id, routine.id);
    const internal = await add({ content: "Orion internal room 385.", channelIds: [room.id] });
    const privateReport = await add({ content: "Orion private report 486.", channelIds: [report.id] });
    const control = await add({ content: "Orion public control 587." });
    const retrieve = () =>
      retrieveForRun(f.context, { orgId: f.org.id, agentId: f.agent.id, channelId: room.id, text: "Orion" });
    const publicRun = await retrieve();
    expect(publicRun.itemIds).toContain(control.id);
    expect(publicRun.itemIds).not.toContain(internal.id);
    expect(publicRun.itemIds).not.toContain(privateReport.id);
    await f.db
      .update(schema.routines)
      .set({ target: { type: "channel", channelId: report.id } })
      .where(eq(schema.routines.id, routine.id));
    const privateRun = await retrieve();
    expect(privateRun.itemIds).toContain(privateReport.id);
    expect(privateRun.itemIds).toContain(control.id);
  });
  test("only accepted human team requirements enter the protected prompt", async () => {
    f = await setup();
    const source = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: f.owner.id },
      body: "Human team instructions.",
    });
    const base = {
      kind: "preference" as const,
      scopeType: "org" as const,
      scopeId: f.org.id,
      agentId: null,
      channelIds: [],
      sourceIds: [source.id],
      trust: "high" as const,
      createdByKind: "person" as const,
      createdById: f.owner.id,
      evidence: [{ type: "human" as const, ref: source.id, at: new Date().toISOString() }],
    };
    const control = await add({ ...base, content: "Preserve accepted team instruction 711." });
    await f.db.update(schema.contextItems).set({ verified: true }).where(eq(schema.contextItems.id, control.id));
    const variants = [
      { content: "Low trust instruction 712.", patch: { trust: "low" as const } },
      { content: "Unverified instruction 713.", patch: { verified: false } },
      { content: "Disputed instruction 714.", patch: { disputed: true } },
      { content: "No human evidence instruction 715.", patch: { evidence: [] } },
    ];
    for (const variant of variants) {
      const item = await add({ ...base, content: variant.content });
      await f.db
        .update(schema.contextItems)
        .set({ verified: true, ...variant.patch })
        .where(eq(schema.contextItems.id, item.id));
    }
    const prompt = await teamMemoryForPrompt(f.db, f.org.id);
    expect(prompt).toContain(control.content);
    for (const variant of variants) expect(prompt).not.toContain(variant.content);
  });
});
