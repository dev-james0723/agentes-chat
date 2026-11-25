import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { callTool, connectApp } from "./ai-apps";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer();
});
afterEach(() => t.close());

const manage = { name: "Skill evidence", access: "manage" as const, scope: "read write manage" };
async function fixture(privateRoom = false) {
  const b = browser(t);
  await signUp(b, "owner@example.com");
  const seeded = await seedOrg(b);
  const { orgId, agentId } = seeded;
  let channelId = seeded.channelId;
  const ownerId = ((await (await b("/api/app/me")).json()) as { user: { id: string } }).user.id;
  if (privateRoom) {
    const [hidden] = await t.db
      .insert(schema.channels)
      .values({
        orgId,
        name: "hidden fixture",
        kind: "dm",
        visibility: "private",
        dmKey: Bun.randomUUIDv7(),
        createdByUserId: ownerId,
      })
      .returning();
    if (!hidden) throw Error("No private room");
    channelId = hidden.id;
  }
  const app = await connectApp(t, b, orgId, manage);
  const [grant] = await t.db.select().from(schema.appGrants).where(eq(schema.appGrants.orgId, orgId));
  if (!grant) throw Error("No grant");
  const skill = (
    await callTool(t, app.access, "create_skill", {
      name: "reconcile",
      description: "Calculate the difference",
      markdown: "Subtract both totals.",
      agent: agentId,
    })
  ).structuredContent!;
  const [trigger] = await t.db
    .insert(schema.messages)
    .values({
      orgId,
      channelId,
      authorType: "person",
      authorUserId: ownerId,
      body: "action-123: 12 minus 5",
    })
    .returning();
  if (!trigger) throw Error("No trigger");
  await t.db
    .insert(schema.appSends)
    .values({ orgId, grantId: grant.id, userId: ownerId, agentId, channelId, messageId: trigger.id });
  const [run] = await t.db
    .insert(schema.agentRuns)
    .values({
      orgId,
      agentId,
      channelId,
      triggerMessageId: trigger.id,
      threadRootId: trigger.id,
      trigger: "mention",
      hop: 1,
      status: "done",
      finishedAt: new Date(),
    })
    .returning();
  if (!run) throw Error("No run");
  const [reply] = await t.db
    .insert(schema.messages)
    .values({
      orgId,
      channelId,
      authorType: "agent",
      authorAgentId: agentId,
      agentRunId: run.id,
      body: "difference 7",
    })
    .returning();
  if (!reply) throw Error("No reply");
  await t.db.update(schema.agentRuns).set({ replyMessageId: reply.id }).where(eq(schema.agentRuns.id, run.id));
  await t.db.insert(schema.agentRunSteps).values({
    orgId,
    runId: run.id,
    seq: 1,
    kind: "tool_result",
    data: {
      name: "load_skill",
      isError: false,
      data: { skill: { id: skill.id, version: 1 } },
      privateNoise: "DO_NOT_EXPORT",
    },
  });
  const args = { skill_id: skill.id, agent_ids: [agentId], run_ids: [run.id] };
  const call = (params: Record<string, unknown>, bearer = app.access) =>
    callTool(t, bearer, "read_skill_evidence", params);
  return { args, call, b, app, orgId, agentId, trigger, run, reply, skill };
}

test("manage evidence is native, caller-bound, and projects only approved fields", async () => {
  const f = await fixture();
  const actual = await f.call(f.args);
  expect(actual.isError).not.toBe(true);
  expect(actual.structuredContent).toMatchObject({
    skill: {
      id: f.skill.id,
      version: 1,
      name: "reconcile",
      files: [],
      body: { untrusted_text: "Subtract both totals." },
    },
    assignments: { [f.agentId]: { skills: [{ id: f.skill.id, version: 1, enabled: true }] } },
    runs: {
      [f.run.id]: {
        run: { agentId: f.agentId, status: "done", triggerMessageId: f.trigger.id },
        trigger: { id: f.trigger.id, untrusted_text: f.trigger.body },
        reply: { id: f.reply.id, untrusted_text: "difference 7" },
        steps: [
          {
            seq: 1,
            kind: "tool_result",
            data: { name: "load_skill", isError: false, data: { skill: { id: f.skill.id, version: 1 } } },
          },
        ],
      },
    },
  });
  expect(JSON.stringify(actual)).not.toContain("DO_NOT_EXPORT");
  const byTask = await f.call({ skill_id: f.skill.id, agent_ids: [f.agentId], task_ids: [f.trigger.id] });
  expect(byTask.structuredContent).toEqual(actual.structuredContent);
  const other = await connectApp(t, f.b, f.orgId, { ...manage, name: "Different application" });
  expect((await f.call(f.args, other.access)).isError).toBe(true);
  const writer = await connectApp(t, f.b, f.orgId, { name: "Writer", access: "write", scope: "read write" });
  await expect(f.call(f.args, writer.access)).rejects.toThrow("not found");
});

test("rejects foreign records, mismatched agent, ambiguous IDs, oversized requests and edited replies", async () => {
  const f = await fixture();
  const second = await seedOrg(f.b);
  const other = await connectApp(t, f.b, second.orgId, manage);
  expect((await f.call(f.args, other.access)).isError).toBe(true);
  const otherAgent = (await callTool(t, f.app.access, "create_agent", { name: "Alternate" })).structuredContent?.id;
  expect(typeof otherAgent).toBe("string");
  expect((await f.call({ ...f.args, agent_ids: [otherAgent] })).isError).toBe(true);
  for (const args of [
    { ...f.args, run_ids: Array.from({ length: 9 }, () => Bun.randomUUIDv7()) },
    { ...f.args, task_ids: [f.trigger.id] },
    { ...f.args, run_ids: [f.run.id, f.run.id] },
  ]) {
    const rejected = await f.call(args).then(
      (v) => v.isError === true,
      () => true,
    );
    expect(rejected).toBe(true);
  }
  await t.db.update(schema.messages).set({ editedAt: new Date() }).where(eq(schema.messages.id, f.reply.id));
  expect((await f.call(f.args)).isError).toBe(true);
});

test("private run contents stay private even for a workspace administrator", async () => {
  const f = await fixture(true);
  const result = await f.call(f.args);
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).not.toContain(f.trigger.body);
});
