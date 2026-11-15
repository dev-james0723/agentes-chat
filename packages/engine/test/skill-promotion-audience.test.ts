import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { systemText } from "@agenteschat/providers";
import {
  addChannelMember,
  createChannel,
  getSkill,
  insertMessage,
  openDm,
  promoteHowTos,
  recordContextUse,
  type ToolContext,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

setDefaultTimeout(30_000);
let f: Fixture;
afterEach(async () => {
  await f?.close();
});
const marker = "amber-octopus-campaign";
const publicMethod = "Check the release readiness twice.";
const skillName = "release-checklist";

async function fixture(hold?: Promise<void>, onSummary?: () => void) {
  f = await setup({
    contextTools: true,
    skillTools: true,
    reply: (req) => {
      if (!systemText(req.system).includes("saved how-to notes into one reusable skill"))
        throw new Error("unexpected inference");
      onSummary?.();
      const privateInNotes = JSON.stringify(req.messages).includes(marker);
      return {
        chunks: [
          JSON.stringify({
            name: skillName,
            description: "Release checklist",
            body: privateInNotes ? marker : publicMethod,
          }),
        ],
        hold,
      };
    },
  });
}

async function runAt(channelId: string) {
  const msg = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId,
    author: { type: "person", userId: f.owner.id },
    body: "@dev prepare a checklist",
  });
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId,
      threadRootId: msg.id,
      triggerMessageId: msg.id,
      trigger: "mention",
      hop: 1,
      status: "done",
    })
    .returning();
  if (!run) throw new Error("no fixture run");
  return run;
}
async function invoke(run: Awaited<ReturnType<typeof runAt>>, name: string, input: Record<string, unknown>) {
  const ctx: ToolContext = {
    db: f.db,
    orgId: f.org.id,
    agentId: run.agentId,
    runId: run.id,
    channelId: run.channelId,
    threadRootId: run.threadRootId,
    triggerMessageId: run.triggerMessageId,
  };
  const r = await f.tools?.invoke(ctx, { toolUseId: `tu_${crypto.randomUUID()}`, name, input });
  if (r?.type !== "result") throw new Error("not a gateway result");
  return r.output;
}
const skills = () => f.db.select().from(schema.skills).where(eq(schema.skills.orgId, f.org.id));

async function seed(channelId: string, content = publicMethod, subject = "howto release checklist") {
  const run = await runAt(channelId);
  const [note] = await f.db
    .insert(schema.contextItems)
    .values({
      orgId: f.org.id,
      kind: "note",
      scopeType: "agent",
      scopeId: f.agent.id,
      agentId: f.agent.id,
      subjectKey: subject,
      content,
      channelIds: [channelId],
      sourceIds: [run.triggerMessageId],
      trust: "high",
      recurrence: 3,
      relevance: 0.8,
    })
    .returning();
  if (!note) throw new Error("no fixture note");
  await recordContextUse(f.db, f.org.id, run.id, [note.id]);
  const second = await runAt(channelId);
  await recordContextUse(f.db, f.org.id, second.id, [note.id]);
  return note;
}

test("private native how-to remains scoped memory, not an autoenabled org-readable skill", async () => {
  await fixture();
  const channel = await createChannel(f.db, f.owner.id, f.org.id, { name: "private-a", visibility: "private" });
  await addChannelMember(f.db, f.owner.id, f.org.id, channel.id, { agentId: f.agent.id });
  let noteId = "";
  for (let i = 0; i < 3; i++) {
    const run = await runAt(channel.id);
    expect(
      (
        await invoke(run, "save_how_to", {
          title: "Release checklist",
          key: "Release checklist",
          how: `Privately use campaign ${marker}.`,
        })
      ).isError,
    ).not.toBe(true);
    const [note] = await f.db.select().from(schema.contextItems);
    if (!note) throw new Error("no saved note");
    noteId = note.id;
    expect(note.channelIds).toEqual([channel.id]);
    await recordContextUse(f.db, f.org.id, run.id, [note.id]);
  }
  expect((await invoke(await runAt(channel.id), "expand", { item_id: noteId })).content).toContain(marker);
  expect((await invoke(await runAt(f.general.id), "expand", { item_id: noteId })).isError).toBe(true);
  expect(await promoteHowTos(f.context, f.org.id, 3)).toBe(0);
  expect(f.provider.calls).toHaveLength(0);
  expect(await skills()).toHaveLength(0);
  expect(await f.db.select().from(schema.contextProposals)).toHaveLength(0);
  expect((await invoke(await runAt(f.general.id), "load_skill", { name: skillName })).content).not.toContain(marker);
  const outsider = await addMember(f.db, f.org.id, "member", "Outsider");
  await expect(getSkill(f.db, outsider.id, f.org.id, crypto.randomUUID())).rejects.toThrow("Skill not found");
  expect((await f.db.select().from(schema.contextItems).where(eq(schema.contextItems.id, noteId)))[0]?.status).toBe(
    "active",
  );
});

test("known public sources still promote and load normally", async () => {
  await fixture();
  await seed(f.general.id);
  expect(await promoteHowTos(f.context, f.org.id, 3)).toBe(1);
  expect(f.provider.calls).toHaveLength(1);
  const [skill] = await skills();
  expect(skill?.body).toBe(publicMethod);
  expect((await invoke(await runAt(f.general.id), "load_skill", { name: skillName })).content).toContain(publicMethod);
});

test("empty declared channels still require complete public actual sources", async () => {
  await fixture();
  const note = await seed(f.general.id);
  await f.db.update(schema.contextItems).set({ channelIds: [] }).where(eq(schema.contextItems.id, note.id));
  expect(await promoteHowTos(f.context, f.org.id, 3)).toBe(1);
  expect((await skills())[0]?.body).toBe(publicMethod);
});

test("a real person DM source is not automatically shared", async () => {
  await fixture();
  const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
  const note = await seed(dm.id);
  expect(await promoteHowTos(f.context, f.org.id, 3)).toBe(0);
  expect(f.provider.calls).toHaveLength(0);
  expect((await f.db.select().from(schema.contextItems).where(eq(schema.contextItems.id, note.id)))[0]?.status).toBe(
    "active",
  );
});

test("private sibling never enters a public subject cluster or its summary request", async () => {
  await fixture();
  const privateA = await createChannel(f.db, f.owner.id, f.org.id, { name: "private-sibling", visibility: "private" });
  const publicNote = await seed(f.general.id, publicMethod, "howto release checklist public");
  const privateNote = await seed(privateA.id, marker, "howto release checklist private");
  expect(await promoteHowTos(f.context, f.org.id, 3)).toBe(1);
  expect(JSON.stringify(f.provider.calls[0]?.request.messages)).not.toContain(marker);
  expect((await skills())[0]?.body).toBe(publicMethod);
  const read = async (id: string) =>
    (await f.db.select().from(schema.contextItems).where(eq(schema.contextItems.id, id)))[0];
  expect((await read(publicNote.id))?.status).toBe("archived");
  expect((await read(privateNote.id))?.status).toBe("active");
});

for (const bad of [
  "missing-source",
  "deleted-source",
  "empty-sources",
  "missing-channel",
  "archived-channel",
  "private-source-public-claim",
  "task-source",
  "person-scope",
  "unknown-agent-scope",
] as const) {
  test(`promotion fails closed for ${bad}`, async () => {
    await fixture();
    const note = await seed(f.general.id);
    if (bad === "missing-source")
      await f.db
        .update(schema.contextItems)
        .set({ sourceIds: [crypto.randomUUID()] })
        .where(eq(schema.contextItems.id, note.id));
    if (bad === "empty-sources")
      await f.db.update(schema.contextItems).set({ sourceIds: [] }).where(eq(schema.contextItems.id, note.id));
    if (bad === "deleted-source")
      await f.db
        .update(schema.messages)
        .set({ deletedAt: new Date() })
        .where(eq(schema.messages.id, note.sourceIds[0] ?? ""));
    if (bad === "missing-channel")
      await f.db
        .update(schema.contextItems)
        .set({ channelIds: [crypto.randomUUID()] })
        .where(eq(schema.contextItems.id, note.id));
    if (bad === "archived-channel")
      await f.db.update(schema.channels).set({ archivedAt: new Date() }).where(eq(schema.channels.id, f.general.id));
    if (bad === "task-source")
      await f.db.update(schema.channels).set({ kind: "task" }).where(eq(schema.channels.id, f.general.id));
    if (bad === "person-scope")
      await f.db
        .update(schema.contextItems)
        .set({ scopeType: "person", scopeId: f.owner.id })
        .where(eq(schema.contextItems.id, note.id));
    if (bad === "unknown-agent-scope")
      await f.db.update(schema.contextItems).set({ scopeId: null }).where(eq(schema.contextItems.id, note.id));
    if (bad === "private-source-public-claim") {
      const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "hidden-source", visibility: "private" });
      const actual = await runAt(secret.id);
      await f.db
        .update(schema.contextItems)
        .set({ sourceIds: [actual.triggerMessageId] })
        .where(eq(schema.contextItems.id, note.id));
    }
    expect(await promoteHowTos(f.context, f.org.id, 3)).toBe(0);
    expect(f.provider.calls).toHaveLength(0);
    expect(await skills()).toHaveLength(0);
    expect((await f.db.select().from(schema.contextItems).where(eq(schema.contextItems.id, note.id)))[0]?.status).toBe(
      "active",
    );
  });
}

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
for (const drift of ["private", "deleted-source", "changed-note"] as const) {
  test(`promotion revalidates ${drift} after summary before publishing`, async () => {
    const entered = signal();
    const release = signal();
    await fixture(release.promise, entered.resolve);
    const note = await seed(f.general.id);
    const pending = promoteHowTos(f.context, f.org.id, 3);
    try {
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error("summary was not called");
        }),
      ]);
      if (drift === "private")
        await f.db.update(schema.channels).set({ visibility: "private" }).where(eq(schema.channels.id, f.general.id));
      if (drift === "deleted-source")
        await f.db
          .update(schema.messages)
          .set({ deletedAt: new Date() })
          .where(eq(schema.messages.id, note.sourceIds[0] ?? ""));
      if (drift === "changed-note")
        await f.db.update(schema.contextItems).set({ content: marker }).where(eq(schema.contextItems.id, note.id));
      release.resolve();
      expect(await pending).toBe(0);
      expect(await skills()).toHaveLength(0);
      expect(
        (await f.db.select().from(schema.contextItems).where(eq(schema.contextItems.id, note.id)))[0]?.status,
      ).toBe("active");
    } finally {
      release.resolve();
      await pending.catch(() => {});
    }
  });
}
