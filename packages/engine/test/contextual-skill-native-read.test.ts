import { afterEach, beforeEach, expect, test } from "bun:test";
import { and, countQueries, type Database, eq, schema } from "@agenteschat/db";
import { createSkillToolSource, decideApproval, postPersonMessage, saveSkill } from "../src";
import { runAuthorityById } from "../src/authority";
import { addRunStep } from "../src/runs";
import { createToolGateway } from "../src/tools/gateway";
import type { ToolContext } from "../src/tools/types";
import { installNativeSkillReadTestSchema, nativePublishedReadFixture } from "./contextual-skill-native-read.fixture";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
let ctx: ToolContext;
let skillId: string;
const PRIVATE_BODY = "PRIVATE_B2_BODY_MUST_NOT_ESCAPE_UNKNOWN_PROVENANCE";
beforeEach(async () => {
  f = await setup();
  await installNativeSkillReadTestSchema(f.db);
  const message = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev native read fixture",
  });
  const [run] = await f.db
    .update(schema.agentRuns)
    .set({ status: "running" })
    .where(eq(schema.agentRuns.triggerMessageId, message.id))
    .returning();
  if (!run) throw Error("Missing native fixture run");
  ctx = {
    db: f.db,
    orgId: f.org.id,
    agentId: f.agent.id,
    runId: run.id,
    channelId: run.channelId,
    threadRootId: run.threadRootId,
    triggerMessageId: run.triggerMessageId,
  };
  const [skill] = await f.db
    .insert(schema.skills)
    .values({
      orgId: f.org.id,
      slug: "b2-native-fixture",
      name: "B2 native fixture",
      description: "Synthetic",
      body: PRIVATE_BODY,
      source: "manual",
    })
    .returning();
  if (!skill) throw Error("Missing fixture skill");
  skillId = skill.id;
  await f.db.insert(schema.agentSkills).values({ orgId: f.org.id, agentId: f.agent.id, skillId, enabled: true });
});
afterEach(async () => {
  await f?.close();
});
const sources = () => [createSkillToolSource({ db: f.db, blobs: f.artifactDeps.blobs })];

test("native call identity is the actual persisted tool_call UUID, not model toolUseId", async () => {
  const toolUseId = "model-call-not-a-uuid";
  const id = await addRunStep(f.db, { id: ctx.runId, orgId: ctx.orgId }, "tool_call", {
    toolUseId,
    name: "load_skill",
    input: { name: "b2-native-fixture" },
  });
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  const [step] = await f.db.select().from(schema.agentRunSteps).where(eq(schema.agentRunSteps.id, id));
  expect(step).toMatchObject({ orgId: f.org.id, runId: ctx.runId, kind: "tool_call", data: { toolUseId } });
});

test("default OFF retains the native working library output and existing use telemetry", async () => {
  const gateway = createToolGateway({ sources: sources() });
  const out = await gateway.invoke(ctx, {
    name: "load_skill",
    input: { name: "b2-native-fixture" },
    toolUseId: crypto.randomUUID(),
  });
  expect(out.type).toBe("result");
  if (out.type !== "result") throw Error("Unexpected approval");
  expect(out.output.content).toBe(
    `Skill "B2 native fixture" (v1) loaded.\n\n${PRIVATE_BODY}\n\nFiles (read with read_skill_file):\n(no files)`,
  );
  const [skill] = await f.db.select().from(schema.skills).where(eq(schema.skills.id, skillId));
  expect(skill?.useCount).toBe(1);
  expect(f.provider.calls).toHaveLength(0);
});

test("opted-in native Gateway read with unknown source proof cannot disclose or increment useCount", async () => {
  const gateway = createToolGateway({
    sources: sources(),
    nativeSkillReads: { canary: [{ agentId: ctx.agentId, runId: ctx.runId, skillId, operation: "load_skill" }] },
  });
  const out = await gateway.invoke(ctx, {
    name: "load_skill",
    input: { name: "b2-native-fixture" },
    toolUseId: crypto.randomUUID(),
  });
  expect(out.type).toBe("result");
  if (out.type !== "result") throw Error("Unexpected approval");
  expect(out.output.isError).toBe(true);
  expect(JSON.stringify(out)).not.toContain(PRIVATE_BODY);
  const [skill] = await f.db.select().from(schema.skills).where(eq(schema.skills.id, skillId));
  expect(skill?.useCount).toBe(0);
  const steps = await f.db.select().from(schema.agentRunSteps).where(eq(schema.agentRunSteps.runId, ctx.runId));
  expect(JSON.stringify(steps)).not.toContain(PRIVATE_BODY);
  expect(f.provider.calls).toHaveLength(0);
});

test("early outcome consumers cannot observe an unclaimed opted-in native read", async () => {
  const [source] = sources();
  if (!source) throw Error("Missing source");
  const tools = await source.tools(ctx);
  const load = tools.find((t) => t.name === "load_skill");
  if (!load) throw Error("Missing native load tool");
  const execute = load.execute;
  load.execute = async (input, native) => ({
    ...(await execute(input, native)),
    outcome: { kind: "tests_passed", summary: PRIVATE_BODY },
  });
  const gateway = createToolGateway({
    sources: [{ name: "actual-native-wrapper", tools: async () => tools }],
    nativeSkillReads: { canary: [{ agentId: ctx.agentId, runId: ctx.runId, skillId, operation: "load_skill" }] },
  });
  const out = await gateway.invoke(ctx, {
    name: "load_skill",
    input: { name: "b2-native-fixture" },
    toolUseId: crypto.randomUUID(),
  });
  expect(JSON.stringify(out)).not.toContain(PRIVATE_BODY);
  expect(await f.db.select().from(schema.outcomes)).toHaveLength(0);
  const steps = await f.db.select().from(schema.agentRunSteps).where(eq(schema.agentRunSteps.runId, ctx.runId));
  expect(JSON.stringify(steps)).not.toContain(PRIVATE_BODY);
  const [skill] = await f.db.select().from(schema.skills).where(eq(schema.skills.id, skillId));
  expect(skill?.useCount).toBe(0);
});

test("an opted-in canary does not capture a different working-library skill", async () => {
  const gateway = createToolGateway({
    sources: sources(),
    nativeSkillReads: {
      canary: [{ agentId: ctx.agentId, runId: ctx.runId, skillId: crypto.randomUUID(), operation: "load_skill" }],
    },
  });
  const out = await gateway.invoke(ctx, {
    name: "load_skill",
    input: { name: "b2-native-fixture" },
    toolUseId: crypto.randomUUID(),
  });
  if (out.type !== "result") throw Error("Unexpected approval");
  expect(out.output.content).toContain(PRIVATE_BODY);
  expect(out.output.data?.skillReadActivation).toBeUndefined();
  const [skill] = await f.db.select().from(schema.skills).where(eq(schema.skills.id, skillId));
  expect(skill?.useCount).toBe(1);
});

test("genuine native executed owner publication flows through Gateway and consumes once", async () => {
  await f.close();
  const published = await nativePublishedReadFixture();
  f = published.f;
  ctx = published.ctx;
  skillId = published.selected.skillId;
  await installNativeSkillReadTestSchema(f.db);
  const gateway = createToolGateway({
    sources: sources(),
    nativeSkillReads: { canary: [{ agentId: ctx.agentId, runId: ctx.runId, skillId, operation: "load_skill" }] },
  });
  const [before] = await f.db.select().from(schema.skills).where(eq(schema.skills.id, skillId));
  const call = { name: "load_skill", input: { name: published.name }, toolUseId: "same-native-b2-logical-read" };
  const out = await gateway.invoke(ctx, call);
  if (out.type !== "result") throw Error("Unexpected approval");
  expect(out.output.isError).not.toBe(true);
  expect(out.output.content).toContain(published.body);
  expect(out.output.data?.skillReadActivation).toMatchObject({
    runId: ctx.runId,
    toolUseId: call.toolUseId,
    skillId,
    state: "completed",
  });
  const [after] = await f.db.select().from(schema.skills).where(eq(schema.skills.id, skillId));
  expect(after?.useCount).toBe((before?.useCount ?? 0) + 1);
  const replay = await gateway.invoke(ctx, call);
  expect(JSON.stringify(replay)).not.toContain(published.body);
  const [replayed] = await f.db.select().from(schema.skills).where(eq(schema.skills.id, skillId));
  expect(replayed?.useCount).toBe(after?.useCount);
});

for (const change of ["membership", "assignment", "version", "source", "cancel"] as const) {
  test(`genuine permitted capture revalidates ${change} before any Gateway consumer`, async () => {
    await f.close();
    const p = await nativePublishedReadFixture();
    f = p.f;
    const controller = new AbortController();
    ctx = { ...p.ctx, signal: controller.signal };
    skillId = p.selected.skillId;
    await installNativeSkillReadTestSchema(f.db);
    const [before] = await f.db.select().from(schema.skills).where(eq(schema.skills.id, skillId));
    const [source] = sources();
    if (!source) throw Error("Missing source");
    const tools = await source.tools(ctx);
    const load = tools.find((t) => t.name === "load_skill");
    if (!load) throw Error("Missing native tool");
    const execute = load.execute;
    load.execute = async (input, native) => {
      const output = await execute(input, native);
      if (change === "membership")
        await f.db.delete(schema.organizationMembers).where(eq(schema.organizationMembers.userId, f.owner.id));
      if (change === "assignment")
        await f.db
          .update(schema.agentSkills)
          .set({ enabled: false })
          .where(and(eq(schema.agentSkills.agentId, ctx.agentId), eq(schema.agentSkills.skillId, skillId)));
      if (change === "version")
        await f.db
          .update(schema.skills)
          .set({ version: p.published.version + 1 })
          .where(eq(schema.skills.id, skillId));
      if (change === "source")
        await f.db
          .update(schema.messages)
          .set({ body: "Changed original native private source" })
          .where(eq(schema.messages.channelId, p.dm.id));
      if (change === "cancel") controller.abort();
      return output;
    };
    const gateway = createToolGateway({
      sources: [{ name: "native-capture-control", tools: async () => tools }],
      nativeSkillReads: { canary: [{ agentId: ctx.agentId, runId: ctx.runId, skillId, operation: "load_skill" }] },
    });
    const out = await gateway.invoke(ctx, {
      name: "load_skill",
      input: { name: p.name },
      toolUseId: crypto.randomUUID(),
    });
    expect(JSON.stringify(out)).not.toContain(p.body);
    expect(JSON.stringify(out)).not.toContain("Changed original native private source");
    const [after] = await f.db.select().from(schema.skills).where(eq(schema.skills.id, skillId));
    expect(after?.useCount).toBe(before?.useCount);
    const steps = await f.db.select().from(schema.agentRunSteps).where(eq(schema.agentRunSteps.runId, ctx.runId));
    expect(JSON.stringify(steps)).not.toContain(p.body);
    expect(await f.db.select().from(schema.outcomes)).toHaveLength(0);
  });
}

test("harness-prefixed native alias retains the same unknown-source gate", async () => {
  const gateway = createToolGateway({
    sources: sources(),
    nativeSkillReads: { canary: [{ agentId: ctx.agentId, runId: ctx.runId, skillId, operation: "load_skill" }] },
  });
  const out = await gateway.invoke(ctx, {
    name: "mcp__agentes__load_skill",
    input: { name: "b2-native-fixture" },
    toolUseId: crypto.randomUUID(),
  });
  expect(JSON.stringify(out)).not.toContain(PRIVATE_BODY);
  if (out.type !== "result") throw Error("Unexpected approval");
  expect(out.output.isError).toBe(true);
  const [skill] = await f.db.select().from(schema.skills).where(eq(schema.skills.id, skillId));
  expect(skill?.useCount).toBe(0);
});

test("a binary in the opted-in stored-text scope cannot fall through to the native image/save branch", async () => {
  const skill = await saveSkill({ db: f.db, blobs: f.artifactDeps.blobs }, f.owner.id, f.org.id, {
    name: "b2-native-fixture",
    description: "Synthetic",
    body: PRIVATE_BODY,
    metadata: {},
    source: "manual",
    files: [{ path: "assets/pixel.png", data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) }],
  });
  const gateway = createToolGateway({
    sources: sources(),
    nativeSkillReads: {
      canary: [{ agentId: ctx.agentId, runId: ctx.runId, skillId: skill.id, operation: "stored_text" }],
    },
  });
  const out = await gateway.invoke(ctx, {
    name: "read_skill_file",
    input: { name: "b2-native-fixture", path: "assets/pixel.png" },
    toolUseId: crypto.randomUUID(),
  });
  if (out.type !== "result") throw Error("Unexpected approval");
  expect(out.output.isError).toBe(true);
  expect(out.output.images).toBeUndefined();
  expect(out.output.content).not.toContain("image is attached");
  expect(out.output.content).not.toContain("Saved");
});

test("genuine native approved resume claims before consumers and never replays cached body", async () => {
  await f.close();
  const p = await nativePublishedReadFixture();
  f = p.f;
  ctx = p.ctx;
  skillId = p.selected.skillId;
  await installNativeSkillReadTestSchema(f.db);
  const [source] = sources();
  if (!source) throw Error("Missing source");
  const tools = await source.tools(ctx);
  const load = tools.find((t) => t.name === "load_skill");
  if (!load) throw Error("Missing native load");
  load.sensitive = true;
  const gateway = createToolGateway({
    sources: [{ name: "native-approval-fixture", tools: async () => tools }],
    nativeSkillReads: { canary: [{ agentId: ctx.agentId, runId: ctx.runId, skillId, operation: "load_skill" }] },
  });
  const asked = await gateway.invoke(ctx, {
    name: "load_skill",
    input: {
      name: p.name,
      why: "Read the exact owner-shared method after verifying its current native source and version",
    },
    toolUseId: "actual-native-approved-read",
  });
  if (asked.type !== "approval") throw Error(`Expected genuine approval, got ${asked.type}`);
  await decideApproval({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, asked.approval.id, {
    decision: "approve",
  });
  const [approved] = await f.db.select().from(schema.approvals).where(eq(schema.approvals.id, asked.approval.id));
  if (!approved) throw Error("Missing approval");
  const output = await gateway.executeApproved(ctx, approved);
  expect(output.isError).not.toBe(true);
  expect(output.content).toContain(p.body);
  expect(output.data?.skillReadActivation).toMatchObject({ state: "completed", skillId });
  const [done] = await f.db.select().from(schema.approvals).where(eq(schema.approvals.id, asked.approval.id));
  if (!done) throw Error("Missing consumed approval");
  const replay = await gateway.executeApproved(ctx, done);
  expect(JSON.stringify(replay)).not.toContain(p.body);
});

for (const change of ["assignment", "archive", "membership", "source"] as const) {
  test(`actual Gateway final CAS rejects late ${change} changes after asynchronous native proof`, async () => {
    await f.close();
    const p = await nativePublishedReadFixture();
    f = p.f;
    skillId = p.selected.skillId;
    await installNativeSkillReadTestSchema(f.db);
    const [before] = await f.db.select().from(schema.skills).where(eq(schema.skills.id, skillId));
    let injected = 0;
    const wrap = (db: Database): Database =>
      new Proxy(db, {
        get(target, key) {
          if (key === "transaction")
            return async (body: (tx: Database) => Promise<unknown>) =>
              target.transaction((tx) => body(wrap(tx as unknown as Database)));
          if (key === "execute")
            return async (query: Parameters<Database["execute"]>[0]) => {
              const text =
                (query as unknown as { queryChunks?: { value?: string[] }[] }).queryChunks
                  ?.map((c) => c.value?.join("") ?? "")
                  .join("") ?? "";
              if (text.includes("floor(extract(epoch from clock_timestamp())")) {
                injected++;
                if (change === "assignment")
                  await target
                    .update(schema.agentSkills)
                    .set({ enabled: false })
                    .where(and(eq(schema.agentSkills.agentId, p.ctx.agentId), eq(schema.agentSkills.skillId, skillId)));
                else if (change === "archive")
                  await target
                    .update(schema.agents)
                    .set({ archivedAt: new Date() })
                    .where(eq(schema.agents.id, p.ctx.agentId));
                else if (change === "membership")
                  await target
                    .delete(schema.organizationMembers)
                    .where(eq(schema.organizationMembers.userId, f.owner.id));
                else
                  await target
                    .update(schema.messages)
                    .set({ body: "Changed original source at final clock" })
                    .where(eq(schema.messages.channelId, p.dm.id));
              }
              return target.execute(query);
            };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    ctx = { ...p.ctx, db: wrap(f.db) };
    const gateway = createToolGateway({
      sources: sources(),
      nativeSkillReads: { canary: [{ agentId: ctx.agentId, runId: ctx.runId, skillId, operation: "load_skill" }] },
    });
    const out = await gateway.invoke(ctx, {
      name: "load_skill",
      input: { name: p.name },
      toolUseId: crypto.randomUUID(),
    });
    expect(injected).toBe(1);
    expect(JSON.stringify(out)).not.toContain(p.body);
    const [after] = await f.db.select().from(schema.skills).where(eq(schema.skills.id, skillId));
    expect(after?.useCount).toBe(before?.useCount);
    const steps = await f.db.select().from(schema.agentRunSteps).where(eq(schema.agentRunSteps.runId, ctx.runId));
    expect(JSON.stringify(steps)).not.toContain(p.body);
  });
}

test("explicit native read overhead is measured separately from ordinary-turn budgets", async () => {
  await f.close();
  const p = await nativePublishedReadFixture();
  f = p.f;
  ctx = p.ctx;
  skillId = p.selected.skillId;
  await installNativeSkillReadTestSchema(f.db);
  const legacy = createToolGateway({ sources: sources() });
  const canary = createToolGateway({
    sources: sources(),
    nativeSkillReads: { canary: [{ agentId: ctx.agentId, runId: ctx.runId, skillId, operation: "load_skill" }] },
  });
  const baseline = await countQueries(() =>
    legacy.invoke(ctx, { name: "load_skill", input: { name: p.name }, toolUseId: "measured-legacy-read" }),
  );
  const guarded = await countQueries(() =>
    canary.invoke(ctx, { name: "load_skill", input: { name: p.name }, toolUseId: "measured-one-shot-read" }),
  );
  if (baseline.result.type !== "result" || guarded.result.type !== "result") throw Error("Unexpected approval");
  expect(guarded.result.output.content).toBe(baseline.result.output.content);
  expect(guarded.result.output.data?.skillReadActivation).toMatchObject({ state: "completed" });
  console.log(
    `B2_EXPLICIT_NATIVE_STATEMENTS legacy=${baseline.queries} scoped=${guarded.queries}; fixture gateway audit included, not ordinary turn cost or savings`,
  );
});

test("person-root steering epoch drift invalidates the admitted call without changing native authority precedence", async () => {
  await f.close();
  const p = await nativePublishedReadFixture();
  f = p.f;
  ctx = p.ctx;
  skillId = p.selected.skillId;
  await installNativeSkillReadTestSchema(f.db);
  const nextActor = await addMember(f.db, f.org.id, "owner", "next-authorized-reader");
  const originalAuthority = await runAuthorityById(f.db, ctx.orgId, ctx.runId);
  const [source] = sources();
  if (!source) throw Error("Missing native source");
  const tools = await source.tools(ctx);
  const load = tools.find((t) => t.name === "load_skill");
  if (!load) throw Error("Missing native load");
  const execute = load.execute;
  load.execute = async (input, native) => {
    const captured = await execute(input, native);
    await f.db
      .update(schema.agentRuns)
      .set({ transcript: { ...(p.reader.transcript ?? {}), steeredBy: nextActor.id } })
      .where(eq(schema.agentRuns.id, ctx.runId));
    expect(await runAuthorityById(f.db, ctx.orgId, ctx.runId)).toEqual(originalAuthority);
    return captured;
  };
  const gateway = createToolGateway({
    sources: [{ name: "native-actor-drift", tools: async () => tools }],
    nativeSkillReads: { canary: [{ agentId: ctx.agentId, runId: ctx.runId, skillId, operation: "load_skill" }] },
  });
  const out = await gateway.invoke(ctx, {
    name: "load_skill",
    input: { name: p.name },
    toolUseId: crypto.randomUUID(),
  });
  expect(JSON.stringify(out)).not.toContain(p.body);
});

for (const changed of [false, true]) {
  test(`native opaque vendor context is bound without a lifecycle claim; changed=${changed}`, async () => {
    await f.close();
    const p = await nativePublishedReadFixture();
    f = p.f;
    ctx = p.ctx;
    skillId = p.selected.skillId;
    await installNativeSkillReadTestSchema(f.db);
    await f.db
      .update(schema.agentRuns)
      .set({ brainSessionId: "synthetic-vendor-context-A" })
      .where(eq(schema.agentRuns.id, ctx.runId));
    const [source] = sources();
    if (!source) throw Error("Missing native source");
    const tools = await source.tools(ctx);
    const load = tools.find((t) => t.name === "load_skill");
    if (!load) throw Error("Missing native load");
    const execute = load.execute;
    load.execute = async (input, native) => {
      const output = await execute(input, native);
      if (changed)
        await f.db
          .update(schema.agentRuns)
          .set({ brainSessionId: "synthetic-vendor-context-B" })
          .where(eq(schema.agentRuns.id, ctx.runId));
      return output;
    };
    const gateway = createToolGateway({
      sources: [{ name: "native-vendor-context-control", tools: async () => tools }],
      nativeSkillReads: { canary: [{ agentId: ctx.agentId, runId: ctx.runId, skillId, operation: "load_skill" }] },
    });
    const out = await gateway.invoke(ctx, {
      name: "load_skill",
      input: { name: p.name },
      toolUseId: crypto.randomUUID(),
    });
    if (out.type !== "result") throw Error("Unexpected approval");
    if (changed) {
      expect(out.output.isError).toBe(true);
      expect(JSON.stringify(out)).not.toContain(p.body);
    } else {
      expect(out.output.isError).not.toBe(true);
      expect(out.output.content).toContain(p.body);
      expect(out.output.data?.skillReadActivation).toMatchObject({ state: "completed" });
    }
  });
}

for (const variant of ["threadRoot", "trigger"] as const) {
  test(`mint-time binding failure in canary scope stays closed: ${variant}`, async () => {
    const drift = {
      ...ctx,
      ...(variant === "threadRoot" ? { threadRootId: crypto.randomUUID() } : { triggerMessageId: crypto.randomUUID() }),
    };
    const gateway = createToolGateway({
      sources: sources(),
      nativeSkillReads: { canary: [{ agentId: ctx.agentId, runId: ctx.runId, skillId, operation: "load_skill" }] },
    });
    const out = await gateway.invoke(drift, {
      name: "load_skill",
      input: { name: "b2-native-fixture" },
      toolUseId: crypto.randomUUID(),
    });
    const [skill] = await f.db.select().from(schema.skills).where(eq(schema.skills.id, skillId));
    expect(JSON.stringify(out)).not.toContain(PRIVATE_BODY);
    expect(skill?.useCount).toBe(0);
  });
}
