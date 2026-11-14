import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq, schema, tracingLogger } from "@agenteschat/db";
import { postPersonMessage, setAgentAccess } from "../src";
import { type NativeSkillPreviewContext, previewNativeSkills } from "../src/contextual-skill-native-evidence";
import type { ToolContext } from "../src/tools/types";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
let ctx: NativeSkillPreviewContext;
let skillId: string;
let toolReads = 0;
const readCurrentTools = (native: ToolContext) => {
  toolReads++;
  if (!f.tools) throw Error("native fixture gateway missing");
  return f.tools.list(native);
};
const preview = () => previewNativeSkills(ctx, { skills: [{ id: skillId, version: 1 }] }, { readCurrentTools });
beforeEach(async () => {
  f = await setup({ skillTools: true });
  toolReads = 0;
  const message = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev fixture",
  });
  const [run] = await f.db
    .update(schema.agentRuns)
    .set({ status: "running" })
    .where(eq(schema.agentRuns.triggerMessageId, message.id))
    .returning();
  if (!run) throw Error("native fixture run missing");
  ctx = {
    db: f.db,
    orgId: f.org.id,
    agentId: f.agent.id,
    runId: run.id,
    channelId: run.channelId,
    threadRootId: run.threadRootId,
    triggerMessageId: run.triggerMessageId,
    originalActor: { kind: "person", personId: f.owner.id },
  };
  const [skill] = await f.db
    .insert(schema.skills)
    .values({
      orgId: f.org.id,
      slug: "preview-fixture",
      name: "PRIVATE_ACCOUNT_LABEL https://secret.invalid /Users/private sk-secret",
      description: "PRIVATE_DESCRIPTION",
      body: "PRIVATE_BODY",
      source: "manual",
    })
    .returning();
  if (!skill) throw Error("native fixture skill missing");
  skillId = skill.id;
  await f.db.insert(schema.agentSkills).values({ orgId: f.org.id, agentId: f.agent.id, skillId, enabled: true });
});
afterEach(async () => {
  await f?.close();
});

test("real native readers produce only ID/version preview, never activation or a write", async () => {
  const before = await f.db.select().from(schema.skills);
  const runs = await f.db.select().from(schema.agentRuns);
  const jobs = await f.db.select().from(schema.outbox);
  const result = await preview();
  expect(result).toMatchObject({
    status: "preview_only",
    reason: "activation_unverified",
    authority: false,
    canExecute: false,
    activation: "unverified",
    skills: [{ id: skillId, version: 1 }],
    modelCalls: 0,
  });
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|https:|\/Users\/|sk-secret/);
  expect(await f.db.select().from(schema.skills)).toEqual(before);
  expect(await f.db.select().from(schema.agentRuns)).toEqual(runs);
  expect(await f.db.select().from(schema.outbox)).toEqual(jobs);
  expect(f.provider.calls).toHaveLength(0);
  expect(toolReads).toBe(1);
});

for (const key of ["orgId", "agentId", "runId", "channelId", "threadRootId", "triggerMessageId"] as const) {
  test(`foreign native ${key} cannot preview this skill`, async () => {
    ctx = { ...ctx, [key]: crypto.randomUUID() };
    expect((await preview()).skills).toEqual([]);
    expect(toolReads).toBe(0);
  });
}

test("the current original actor is verified from native authorship, not supplied claims", async () => {
  ctx.originalActor = { kind: "person", personId: "another-person" };
  expect((await preview()).skills).toEqual([]);
  expect(toolReads).toBe(0);
});

test("a routine cannot use its creator as the acting person", async () => {
  await f.db.update(schema.agentRuns).set({ background: true }).where(eq(schema.agentRuns.id, ctx.runId));
  expect((await preview()).skills).toEqual([]);
  ctx.originalActor = { kind: "routine", personId: null };
  expect((await preview()).skills).toEqual([]); // no native routine creator visibility binding
  expect(toolReads).toBe(0);
});

for (const status of ["queued", "waiting_approval", "done", "failed", "canceled"] as const) {
  test(`a ${status} run is not the current running native caller`, async () => {
    await f.db.update(schema.agentRuns).set({ status }).where(eq(schema.agentRuns.id, ctx.runId));
    expect((await preview()).skills).toEqual([]);
    expect(toolReads).toBe(0);
  });
}

test("removed membership does not fall back to the agent owner", async () => {
  await f.db.delete(schema.organizationMembers).where(eq(schema.organizationMembers.userId, f.owner.id));
  expect((await preview()).skills).toEqual([]);
  expect(toolReads).toBe(0);
});

test("disabled assignment, deletion and version drift invalidate a previous preview", async () => {
  const first = await preview();
  expect(first.status).toBe("preview_only");
  await f.db.update(schema.agentSkills).set({ enabled: false }).where(eq(schema.agentSkills.skillId, skillId));
  expect((await preview()).skills).toEqual([]);
  await f.db.update(schema.agentSkills).set({ enabled: true }).where(eq(schema.agentSkills.skillId, skillId));
  await f.db.update(schema.skills).set({ version: 2 }).where(eq(schema.skills.id, skillId));
  expect((await preview()).skills).toEqual([]);
  await f.db.update(schema.skills).set({ version: 1, deletedAt: new Date() }).where(eq(schema.skills.id, skillId));
  expect((await preview()).skills).toEqual([]);
  expect(first.authority).toBe(false);
});

test("fresh native grants defeat even a stale trusted tool listing", async () => {
  if (!f.tools) throw Error("fixture gateway missing");
  const old = await f.tools.list(ctx);
  await setAgentAccess(f.db, f.owner.id, f.org.id, f.agent.id, {
    all: true,
    connectors: {},
    scopes: [],
    tools: { allow: [], deny: [{ connectionId: null, name: "load_skill" }] },
  });
  const result = await previewNativeSkills(
    ctx,
    { skills: [{ id: skillId, version: 1 }] },
    { readCurrentTools: async () => old },
  );
  expect(result).toMatchObject({ skills: [], reason: "capability_denied" });
  const actual = await f.tools.invoke(ctx, {
    toolUseId: "denied-control",
    name: "load_skill",
    input: { name: "preview-fixture" },
  });
  expect(actual).toMatchObject({ type: "result", output: { isError: true } });
});

test("an existing allowed skill still loads only through its original gateway", async () => {
  expect((await preview()).authority).toBe(false);
  if (!f.tools) throw Error("fixture gateway missing");
  const result = await f.tools.invoke(ctx, {
    toolUseId: "allowed-control",
    name: "load_skill",
    input: { name: "preview-fixture" },
  });
  expect(result).toMatchObject({ type: "result", output: { data: { skill: { id: skillId, version: 1 } } } });
});

test("tool availability is unknown without a native callback; no profile or model fallback", async () => {
  const result = await previewNativeSkills(ctx, { skills: [{ id: skillId, version: 1 }] }, {});
  expect(result.skills).toEqual([]);
  expect(result.modelCalls).toBe(0);
});

test("oversized, duplicate, stale or model-authority input is refused before native reads", async () => {
  for (const input of [
    { skills: Array.from({ length: 4 }, () => ({ id: skillId, version: 1 })) },
    {
      skills: [
        { id: skillId, version: 1 },
        { id: skillId, version: 1 },
      ],
    },
    { skills: [{ id: skillId, version: 0 }] },
    { skills: [{ id: skillId, version: 1 }], authority: true },
    { skills: [{ id: "https://private.invalid", version: 1 }] },
  ]) {
    expect((await previewNativeSkills(ctx, input, { readCurrentTools })).skills).toEqual([]);
  }
  expect(toolReads).toBe(0);
});

test("old observations cannot be promoted after a slow native capability read", async () => {
  let time = Date.now();
  const result = await previewNativeSkills(
    ctx,
    { skills: [{ id: skillId, version: 1 }] },
    {
      now: () => time,
      readCurrentTools: async (native) => {
        const tools = await readCurrentTools(native);
        time += 6000;
        return tools;
      },
    },
  );
  expect(result.skills).toEqual([]);
  expect(result.reason).toBe("observation_expired");
});

test("native callback failure is unknown without retry, leaked exception or fallback", async () => {
  let attempts = 0;
  const result = await previewNativeSkills(
    ctx,
    { skills: [{ id: skillId, version: 1 }] },
    {
      readCurrentTools: async () => {
        attempts++;
        throw Error("https://private.invalid sk-private /Users/private");
      },
    },
  );
  expect(result.skills).toEqual([]);
  expect(JSON.stringify(result)).not.toMatch(/private/);
  expect(attempts).toBe(1);
});

for (const change of ["membership", "run", "actor"] as const) {
  test(`a ${change} change during native tool listing is rechecked before preview`, async () => {
    const result = await previewNativeSkills(
      ctx,
      { skills: [{ id: skillId, version: 1 }] },
      {
        readCurrentTools: async (native) => {
          const listed = await readCurrentTools(native);
          if (change === "membership")
            await f.db.delete(schema.organizationMembers).where(eq(schema.organizationMembers.userId, f.owner.id));
          if (change === "run")
            await f.db.update(schema.agentRuns).set({ status: "canceled" }).where(eq(schema.agentRuns.id, ctx.runId));
          if (change === "actor")
            await f.db
              .update(schema.messages)
              .set({ authorUserId: null, authorType: "agent", authorAgentId: f.agent.id })
              .where(eq(schema.messages.id, ctx.triggerMessageId));
          return listed;
        },
      },
    );
    expect(result.skills).toEqual([]);
    expect(result.authority).toBe(false);
  });
}

test("three current assigned versions remain a bounded metadata preview", async () => {
  const refs = [{ id: skillId, version: 1 }];
  for (const n of [2, 3]) {
    const [skill] = await f.db
      .insert(schema.skills)
      .values({
        orgId: f.org.id,
        slug: `preview-${n}`,
        name: "Private name",
        description: "Private description",
        body: "Private body",
        source: "manual",
        version: n,
      })
      .returning();
    if (!skill) throw Error("fixture skill missing");
    await f.db
      .insert(schema.agentSkills)
      .values({ orgId: f.org.id, agentId: f.agent.id, skillId: skill.id, enabled: true });
    refs.push({ id: skill.id, version: n });
  }
  const result = await previewNativeSkills(ctx, { skills: refs }, { readCurrentTools });
  expect(result.skills).toEqual(refs.sort((a, b) => a.id.localeCompare(b.id)));
  expect(result.authority).toBe(false);
  expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  if (result.expiresAt === null || result.capturedAt === null) throw Error("preview timestamps missing");
  expect(result.expiresAt - result.capturedAt).toBe(5000);
});

test("an orphan native task binding is unknown, not another task's permission", async () => {
  await f.db.update(schema.agentRuns).set({ issueId: crypto.randomUUID() }).where(eq(schema.agentRuns.id, ctx.runId));
  expect((await preview()).skills).toEqual([]);
  expect(toolReads).toBe(0);
});

test("cancellation during listing cannot return a preview", async () => {
  const controller = new AbortController();
  ctx.signal = controller.signal;
  const result = await previewNativeSkills(
    ctx,
    { skills: [{ id: skillId, version: 1 }] },
    {
      readCurrentTools: async (native) => {
        const tools = await readCurrentTools(native);
        controller.abort();
        return tools;
      },
    },
  );
  expect(result).toMatchObject({ skills: [], reason: "canceled" });
});

test("explicit preview issues only reads and records its own query overhead separately", async () => {
  const original = tracingLogger.logQuery;
  const queries: string[] = [];
  tracingLogger.logQuery = (query?: string) => {
    if (query) queries.push(query);
  };
  try {
    expect((await preview()).status).toBe("preview_only");
  } finally {
    tracingLogger.logQuery = original;
  }
  expect(queries.length).toBeGreaterThan(0);
  expect(queries.every((query) => /^\s*select\b/i.test(query))).toBe(true);
  console.log(
    `WP3_B1_EXPLICIT_PREVIEW_NATIVE_READ_STATEMENTS=${queries.length}; listing=existing fixture gateway; not foreground per-turn cost`,
  );
});
