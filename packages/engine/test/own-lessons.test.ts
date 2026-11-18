import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import { createAgent, drainOutbox, openDm, postPersonMessage, retrieveForRun } from "../src";
import { openRoutineRoom } from "../src/routine-room";
import { addMember, type Fixture, setup } from "./fixtures";

/**
 * What an agent found out on its own about how the tools work, with nothing of the conversation in it, reaches its
 * other conversations when it says so (`applies: "everywhere_for_me"`): its routine's room too, never another agent.
 */

let f: Fixture;
afterEach(async () => {
  await f?.close();
  f = undefined as unknown as Fixture;
});

const LESSON = "The email sign-up task on the board is #160; looking up 159 finds nothing.";

/** The agent saves `content` with the flag when a person asks it in #general, made private here (or in their DM). */
async function savedInPrivateChannel(content: string, member?: string, inDm = false) {
  f = await setup({
    contextTools: true,
    reply: (req: ModelRequest) => {
      const last = JSON.stringify(req.messages.at(-1)?.content);
      if (last.includes("tool_result")) return { chunks: ["Noted."] };
      if (last.includes("which task"))
        return {
          chunks: [],
          toolUses: [
            {
              name: "remember",
              input: { content, kind: "fact", basis: "found", applies: "everywhere_for_me" },
            },
          ],
        };
      return { chunks: ["ok"] };
    },
  });
  if (member) await addMember(f.db, f.org.id, "member", member);
  await f.db.update(schema.channels).set({ visibility: "private" }).where(eq(schema.channels.id, f.general.id));
  const where = inDm ? (await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id })).id : f.general.id;
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, where, {
    body: "@dev which task is the email sign-up?",
  });
  await drainOutbox(f.db, f.handlers);
}

const results = async () =>
  (await f.db.select().from(schema.agentRunSteps))
    .filter((s) => s.kind === "tool_result")
    .map((s) => s.data as { name: string; content: string; isError: boolean });

const memoryIn = async (agentId: string, channelId: string) =>
  (await retrieveForRun(f.context, { orgId: f.org.id, agentId, channelId, text: "email sign-up task board 160" })).text;

test("an own lesson retains its private source and stays out of an unbound routine and other agents", async () => {
  await savedInPrivateChannel(LESSON);
  const [item] = await f.db.select().from(schema.contextItems);
  // Low trust and unverified even with a person behind the run: the agent's own finding, read everywhere.
  expect(item).toMatchObject({
    scopeType: "agent",
    agentId: f.agent.id,
    channelIds: [f.general.id],
    trust: "low",
    verified: false,
  });

  const room = await openRoutineRoom(f.db, f.org.id, f.agent.id, crypto.randomUUID());
  expect(await memoryIn(f.agent.id, f.general.id)).toContain("#160");
  expect(await memoryIn(f.agent.id, room.id)).not.toContain("#160");

  const other = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Ops", handle: "ops", role: "Developer", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  const theirs = await openRoutineRoom(f.db, f.org.id, other.id, crypto.randomUUID());
  expect(await memoryIn(other.id, theirs.id)).not.toContain("#160");
  expect(await memoryIn(other.id, f.general.id)).not.toContain("#160");
});

test("one naming a person here is refused: from a private channel it would carry that conversation elsewhere", async () => {
  // A member of the workspace named in it ("Bob").
  await savedInPrivateChannel("Bob tracks the email sign-up on the board as #160.", "Bob");
  expect(await f.db.select().from(schema.contextItems)).toHaveLength(0);
  const saved = (await results()).find((r) => r.name === "remember");
  expect(saved).toMatchObject({ isError: true, content: expect.stringContaining("names someone") });
});

test("without the flag an own finding stays in the private channel it came from", async () => {
  f = await setup({
    contextTools: true,
    reply: (req: ModelRequest) => {
      const last = JSON.stringify(req.messages.at(-1)?.content);
      if (last.includes("tool_result")) return { chunks: ["Noted."] };
      if (last.includes("which task"))
        return {
          chunks: [],
          toolUses: [{ name: "remember", input: { content: LESSON, kind: "fact", basis: "found" } }],
        };
      return { chunks: ["ok"] };
    },
  });
  await f.db.update(schema.channels).set({ visibility: "private" }).where(eq(schema.channels.id, f.general.id));
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev which task is the email sign-up?",
  });
  await drainOutbox(f.db, f.handlers);
  const [item] = await f.db.select().from(schema.contextItems);
  expect(item?.channelIds).toEqual([f.general.id]);
  const room = await openRoutineRoom(f.db, f.org.id, f.agent.id, crypto.randomUUID());
  expect(await memoryIn(f.agent.id, room.id)).not.toContain("#160");
});

test("a member's Chinese name inside a run of Chinese characters is found, and refused", async () => {
  await savedInPrivateChannel("陳大文嘅報告喺看板上係 #160，查 159 搵唔到。", "陳大文");
  expect(await f.db.select().from(schema.contextItems)).toHaveLength(0);
  const saved = (await results()).find((r) => r.name === "remember");
  expect(saved).toMatchObject({ isError: true, content: expect.stringContaining("names someone") });
});

test("from a person's DM it is refused: what was found there stays there", async () => {
  await savedInPrivateChannel(LESSON, undefined, true);
  expect(await f.db.select().from(schema.contextItems)).toHaveLength(0);
  const saved = (await results()).find((r) => r.name === "remember");
  expect(saved).toMatchObject({ isError: true, content: expect.stringContaining("private conversation") });
});
