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
  ).structuredContent;
  if (!skill) throw Error("No registered skill");
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

/** The onboarding API returns the owner's existing unfinished workspace until it is completed. */
async function foreignWorkspace(f: Awaited<ReturnType<typeof fixture>>) {
  const finished = await f.b(`/api/app/organizations/${f.orgId}/onboarding`, {
    method: "PATCH",
    json: { finished: true },
  });
  expect(finished.status).toBe(200);
  const other = await seedOrg(f.b);
  expect(other.orgId).not.toBe(f.orgId);
  const app = await connectApp(t, f.b, other.orgId, manage);
  return { ...other, app };
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
  const other = await foreignWorkspace(f);
  expect((await f.call(f.args, other.app.access)).isError).toBe(true);
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

test("excludes external and malformed skill loads while retaining the actual native version", async () => {
  const f = await fixture();
  const samples: { version: unknown; external?: boolean }[] = [
    { version: 1, external: true },
    { version: "1" },
    { version: { note: "UNTRUSTED_VERSION_DATA" } },
    { version: 0 },
    { version: -1 },
    { version: 1.5 },
    { version: Number.MAX_SAFE_INTEGER + 1 },
    { version: 2 },
  ];
  await t.db.insert(schema.agentRunSteps).values(
    samples.map(({ version, external }, index) => ({
      orgId: f.orgId,
      runId: f.run.id,
      seq: index + 2,
      kind: "tool_result" as const,
      data: {
        name: "load_skill",
        isError: false,
        ...(external === undefined ? {} : { external }),
        data: { skill: { id: f.skill.id, version } },
      },
    })),
  );
  const result = await f.call(f.args);
  const runs = result.structuredContent?.runs as Record<
    string,
    {
      steps: { seq: number; data: { data: { skill: { version: unknown } } } }[];
    }
  >;
  expect(runs[f.run.id]?.steps.map((step) => [step.seq, step.data.data.skill.version])).toEqual([
    [1, 1],
    [9, 2],
  ]);
  expect(JSON.stringify(result)).not.toContain("UNTRUSTED_VERSION_DATA");
});

test("only current-version package metadata is exposed, without blob locators or contents", async () => {
  const f = await fixture();
  const file = {
    orgId: f.orgId,
    skillId: String(f.skill.id),
    path: "references/example.md",
    size: 24,
    mime: "text/markdown",
    status: "stored",
    blobKey: "PRIVATE_STORAGE_KEY",
  };
  await t.db.insert(schema.skillFiles).values([
    { ...file, version: 1 },
    { ...file, version: 2, path: "future.md" },
  ]);
  const result = await f.call(f.args);
  expect(result.structuredContent?.skill).toMatchObject({
    files: [{ path: { untrusted_text: "references/example.md" }, size: 24, mime: "text/markdown", status: "stored" }],
  });
  expect(JSON.stringify(result)).not.toContain("PRIVATE_STORAGE_KEY");
  expect(JSON.stringify(result)).not.toContain("future.md");
});

test("assignment-only reads stay scoped and never read adoption reply text", async () => {
  const f = await fixture();
  await t.db
    .update(schema.messages)
    .set({ body: "x".repeat(10000) })
    .where(eq(schema.messages.id, f.reply.id));
  const args = { skill_id: f.skill.id, agent_ids: [f.agentId] };
  const result = await f.call(args);
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({
    skill: { id: f.skill.id },
    assignments: { [f.agentId]: { skills: [{ id: f.skill.id, enabled: true }] } },
    runs: {},
  });
  expect(Object.keys(result.structuredContent?.runs ?? {})).toHaveLength(0);
  const other = await foreignWorkspace(f);
  const ownSkill = await callTool(t, other.app.access, "create_skill", {
    name: "control-skill",
    description: "Exercise the workspace-scoped read",
    markdown: "Read the selected record.",
    agent: other.agentId,
  });
  const ownId = ownSkill.structuredContent?.id;
  expect(typeof ownId).toBe("string");
  const local = { skill_id: ownId, agent_ids: [other.agentId] };
  expect((await f.call(local, other.app.access)).structuredContent?.skill).toMatchObject({ id: ownId });
  // Only the skill UUID changes. The other workspace's authenticated grant and agent remain valid.
  const denied = await f.call({ ...local, skill_id: f.skill.id }, other.app.access);
  expect(denied.isError).toBe(true);
  expect(denied.structuredContent).toBeUndefined();
  expect((await f.call({ ...f.args })).isError).toBe(true);
});
