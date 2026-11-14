import { afterEach, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION } from "@agenteschat/adapters";
import { asc, eq, schema, tracingLogger } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import type { FakeReply } from "@agenteschat/providers/testing";
import { createJobHandlers, drainOutbox, postPersonMessage, runRoutineNow } from "../src";
import { type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";
import { channelRoutine, routineDeps } from "./routine-fixtures";

let f: Fixture;
const logQuery = tracingLogger.logQuery;
afterEach(async () => {
  tracingLogger.logQuery = logQuery;
  await f?.close();
});

async function backgroundModel(reply: FakeReply | ((request: ModelRequest, call: number) => FakeReply | Error)) {
  f = await setup({ reply: typeof reply === "function" ? reply : () => reply });
  let projectLookups = 0;
  tracingLogger.logQuery = (query?: string) => {
    if (query?.includes('inner join "routine_runs"') && query.includes('left join "paperclip_routine_mappings"'))
      projectLookups++;
    logQuery();
  };
  const routine = await channelRoutine(f);
  await runRoutineNow(routineDeps(f), f.owner.id, f.org.id, routine.id);
  await drainOutbox(f.db, f.handlers);
  const [run] = await f.db.select().from(schema.agentRuns);
  if (!run) throw new Error("Native routine did not create its background run");
  const steps = await f.db
    .select()
    .from(schema.agentRunSteps)
    .where(eq(schema.agentRunSteps.runId, run.id))
    .orderBy(asc(schema.agentRunSteps.seq));
  const usage = await f.db.select().from(schema.usageRecords).where(eq(schema.usageRecords.runId, run.id));
  expect(run.background).toBe(true);
  expect(projectLookups).toBeGreaterThan(0);
  return { run, steps, usage };
}

test("a native nonproject background model refusal fails and links its recorded usage", async () => {
  const { run, steps, usage } = await backgroundModel({
    chunks: [],
    stopReason: "refusal",
    usage: { inputTokens: 11, outputTokens: 0 },
    costNanoUsd: 123,
  });
  expect([run.status, run.error]).toEqual(["failed", "model_refused"]);
  expect(usage).toHaveLength(1);
  expect(steps.find((s) => s.kind === "model_call")?.data).toMatchObject({
    stopReason: "refusal",
    usageRecordId: usage[0]?.id,
    costNanoUsd: 123,
    inputTokens: 11,
    outputTokens: 0,
  });
});

test("an uncertain foreground origin keeps truncation and media metadata without skipping the guard", async () => {
  f = await setup({ reply: () => ({ chunks: ["Limited"], stopReason: "max_tokens", imagesLeftOut: true }) });
  const message = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev fixture request",
  });
  await f.db
    .update(schema.messages)
    .set({ meta: { routine: null } })
    .where(eq(schema.messages.id, message.id));
  await drainOutbox(f.db, f.handlers);
  const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, message.id));
  if (!run) throw new Error("Missing foreground fixture run");
  const steps = await f.db.select().from(schema.agentRunSteps).where(eq(schema.agentRunSteps.runId, run.id));
  expect(run.status).toBe("done");
  expect(steps.find((s) => s.kind === "model_call")?.data.stopReason).toBe("max_tokens");
  expect(steps.find((s) => s.kind === "message")?.data.truncated).toBe(true);
  const [reply] = await f.db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.id, run.replyMessageId ?? ""));
  expect(reply?.meta.filesTextOnly).toBe(true);
});

test("a guarded model fallback retains the API refusal and usage after the native brain declines", async () => {
  f = await setup({ reply: () => ({ chunks: [], stopReason: "refusal", costNanoUsd: 789 }) });
  const { machineId } = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, {
    name: "Fixture Mac",
    hostname: "fixture",
    os: "darwin",
    arch: "arm64",
    version: "fixture",
    protocol: MACHINE_PROTOCOL_VERSION,
    workspace: "/fixture",
    exec: true,
  });
  await f.db
    .update(schema.agents)
    .set({ machineId, brain: "claude_code", brainFallback: true })
    .where(eq(schema.agents.id, f.agent.id));
  let nativeTurns = 0;
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: {
      claude_code: () => ({
        kind: "claude_code",
        async *run() {
          nativeTurns++;
          yield { type: "limit" };
          yield { type: "error", code: "plan_limit", message: "Synthetic limit", worked: false };
        },
      }),
    },
    machines: {
      status: async (id) => ({
        id,
        orgId: f.org.id,
        name: "Fixture Mac",
        online: true,
        execAllowed: true,
        os: "darwin",
        protocol: MACHINE_PROTOCOL_VERSION,
        executors: { claude: { version: "fixture", loggedIn: true }, detectedAt: new Date().toISOString() },
      }),
    },
  });
  const message = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev fixture fallback",
  });
  await f.db
    .update(schema.messages)
    .set({ meta: { routine: null } })
    .where(eq(schema.messages.id, message.id));
  await drainOutbox(f.db, handlers);
  const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, message.id));
  if (!run) throw new Error("Missing fallback fixture run");
  const steps = await f.db.select().from(schema.agentRunSteps).where(eq(schema.agentRunSteps.runId, run.id));
  const [usage] = await f.db.select().from(schema.usageRecords).where(eq(schema.usageRecords.runId, run.id));
  expect(nativeTurns).toBe(1);
  expect(f.provider.calls).toHaveLength(1);
  expect([run.status, run.error, run.brain]).toEqual(["failed", "model_refused", "model"]);
  expect(steps.find((s) => s.kind === "model_call")?.data).toMatchObject({
    stopReason: "refusal",
    usageRecordId: usage?.id,
    costNanoUsd: 789,
  });
});

test("successive guarded model turns use their own metadata without reusing a previous result", async () => {
  let agentCalls = 0;
  f = await setup({
    toolSources: [
      {
        name: "fixture",
        tools: async () => [
          {
            name: "fixture_read",
            description: "Read synthetic fixture data",
            scope: "context:read",
            inputSchema: { type: "object", properties: {} },
            execute: async () => ({ content: "Synthetic data" }),
          },
        ],
      },
    ],
    reply: (request) => {
      if (request.outputSchema) return { chunks: ["{}"] };
      agentCalls++;
      return agentCalls === 1
        ? {
            chunks: [],
            toolUses: [{ name: "fixture_read", input: {} }],
            model: "synthetic-first",
            costNanoUsd: 111,
            thinking: { dropped: { budget: 1 } },
          }
        : { chunks: [], stopReason: "refusal", model: "synthetic-second", costNanoUsd: 222 };
    },
  });
  const routine = await channelRoutine(f);
  await runRoutineNow(routineDeps(f), f.owner.id, f.org.id, routine.id);
  await drainOutbox(f.db, f.handlers);
  const [run] = await f.db.select().from(schema.agentRuns);
  if (!run) throw new Error("Missing multi-turn fixture run");
  const steps = await f.db
    .select()
    .from(schema.agentRunSteps)
    .where(eq(schema.agentRunSteps.runId, run.id))
    .orderBy(asc(schema.agentRunSteps.seq));
  const calls = steps.filter((s) => s.kind === "model_call").map((s) => s.data);
  expect(agentCalls).toBe(2);
  expect([run.status, run.error]).toEqual(["failed", "model_refused"]);
  expect(calls.map((c) => [c.stopReason, c.model, c.costNanoUsd])).toEqual([
    ["tool_use", "synthetic-first", 111],
    ["refusal", "synthetic-second", 222],
  ]);
  expect(calls[0]?.usageRecordId).toBeString();
  expect(calls[1]?.usageRecordId).toBeString();
  expect(calls[0]?.usageRecordId).not.toBe(calls[1]?.usageRecordId);
  expect(calls[0]?.thinking).toEqual({ dropped: { budget: 1 } });
  expect(calls[1]?.thinking).toBeUndefined();
});

test("a guarded native model retains max_tokens, complete usage, actual model, thinking and media metadata", async () => {
  const opaque = { type: "thinking", thinking: "", signature: "synthetic-signature" };
  const thinking = { dropped: { budget: 1 } };
  const { run, steps, usage } = await backgroundModel({
    chunks: ["Limited fixture answer"],
    stopReason: "max_tokens",
    model: "synthetic-answer-model",
    usage: { inputTokens: 111, outputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 5 },
    costNanoUsd: 456,
    thinking,
    opaque: [opaque],
    imagesLeftOut: true,
  });
  expect(run.status).toBe("done");
  expect(usage).toHaveLength(1);
  expect(steps.find((s) => s.kind === "model_call")?.data).toMatchObject({
    stopReason: "max_tokens",
    usageRecordId: usage[0]?.id,
    costNanoUsd: 456,
    model: "synthetic-answer-model",
    inputTokens: 111,
    outputTokens: 7,
    cacheReadTokens: 3,
    cacheWriteTokens: 5,
    thinking,
  });
  expect(run.transcript).toMatchObject({ filesTextOnly: true });
  const messages = run.transcript?.messages as { role: string; content: unknown }[] | undefined;
  expect(messages?.find((m) => m.role === "assistant")?.content).toContainEqual({
    type: "opaque",
    provider: "anthropic",
    data: opaque,
  });
});
