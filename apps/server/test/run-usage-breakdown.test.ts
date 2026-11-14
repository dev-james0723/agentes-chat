import { afterEach, expect, test } from "bun:test";
import { and, countQueries, eq, schema } from "@agenteschat/db";
import { getRun, listRuns } from "@agenteschat/engine";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

type RunResponse = { run: NonNullable<Awaited<ReturnType<typeof getRun>>["run"]>; steps: unknown[] };
let t: TestServer;
afterEach(() => t?.close());

async function fixture(privateDm = false) {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const seeded = await seedOrg(owner);
  const [general] = await t.db.select().from(schema.channels).where(eq(schema.channels.id, seeded.channelId));
  if (!general?.createdByUserId) throw new Error("no owner");
  const ownerId = general.createdByUserId;
  let channelId = seeded.channelId;
  if (privateDm) {
    const [secret] = await t.db
      .insert(schema.channels)
      .values({
        orgId: seeded.orgId,
        name: "private-fixture",
        kind: "dm",
        dmKey: `fixture:${crypto.randomUUID()}`,
        visibility: "private",
        createdByUserId: ownerId,
      })
      .returning();
    if (!secret) throw new Error("no private channel");
    channelId = secret.id;
    await t.db.insert(schema.channelMembers).values({ orgId: seeded.orgId, channelId, userId: ownerId });
  }
  const [message] = await t.db
    .insert(schema.messages)
    .values({
      orgId: seeded.orgId,
      channelId,
      authorType: "person",
      authorUserId: ownerId,
      body: "synthetic bounded request",
    })
    .returning();
  if (!message) throw new Error("no message");
  const [run] = await t.db
    .insert(schema.agentRuns)
    .values({
      orgId: seeded.orgId,
      agentId: seeded.agentId,
      channelId,
      threadRootId: message.id,
      triggerMessageId: message.id,
      trigger: "mention",
      hop: 1,
      status: "done",
      turns: 1,
      finishedAt: new Date(),
    })
    .returning();
  if (!run) throw new Error("no run");
  const api = (path: string) => owner(`/api/app/organizations/${seeded.orgId}${path}`);
  return { ...seeded, channelId, ownerId, run, api };
}

test("getRun HTTP exposes conserved kind/web counters, not money; legacy lists and message scope stay unchanged", async () => {
  const f = await fixture();
  const common = { orgId: f.orgId, agentId: f.agentId, runId: f.run.id, model: "fixture", requestedModel: "fixture" };
  await t.db.insert(schema.usageRecords).values([
    {
      ...common,
      kind: "agent",
      provider: "codex",
      billedTo: "plan",
      inputTokens: 100,
      cacheReadTokens: 50,
      cacheWriteTokens: 10,
      outputTokens: 20,
      costNanoUsd: 0,
    },
    {
      ...common,
      kind: "agent",
      provider: "anthropic",
      inputTokens: 17,
      cacheReadTokens: 3,
      outputTokens: 4,
      costNanoUsd: 5,
    },
    { ...common, kind: "agent", provider: "web", inputTokens: 7, outputTokens: 3, costNanoUsd: 99 },
    {
      ...common,
      kind: "router",
      provider: "typesafe",
      billedTo: "platform",
      inputTokens: 11,
      outputTokens: 5,
      costNanoUsd: 4,
    },
    {
      ...common,
      kind: "summary",
      provider: "anthropic",
      inputTokens: 13,
      outputTokens: 2,
      costNanoUsd: 8,
      partial: true,
    },
  ]);
  const [reply] = await t.db
    .insert(schema.messages)
    .values({
      orgId: f.orgId,
      channelId: f.channelId,
      authorType: "agent",
      authorAgentId: f.agentId,
      agentRunId: f.run.id,
      body: "synthetic answer",
      hop: 1,
    })
    .returning();
  const result = await f.api(`/runs/${f.run.id}`);
  expect(result.status).toBe(200);
  const body = (await result.json()) as RunResponse;
  expect(body.run).toMatchObject({ inputTokens: 211, cachedTokens: 53, outputTokens: 34, turns: 1, private: false });
  expect(body.run).not.toHaveProperty("costNanoUsd");
  expect(body.run.usageBreakdown).toMatchObject({
    scope: "all_run_usage_records",
    inputScope: "cache_inclusive",
    cachedScope: "cache_read_subset",
    messageScope: "agent_non_web",
    counterSource: "recorded_may_include_estimates",
    costScope: "not_exposed_not_actual_cash",
  });
  const groups = body.run.usageBreakdown?.byKind ?? [];
  expect(groups).toEqual([
    {
      kind: "agent",
      providerScope: "non_web",
      records: 2,
      partialRecords: 0,
      inputTokens: 180,
      cachedTokens: 53,
      outputTokens: 24,
      costNanoUsd: null,
    },
    {
      kind: "agent",
      providerScope: "web",
      records: 1,
      partialRecords: 0,
      inputTokens: 7,
      cachedTokens: 0,
      outputTokens: 3,
      costNanoUsd: null,
    },
    {
      kind: "router",
      providerScope: "non_web",
      records: 1,
      partialRecords: 0,
      inputTokens: 11,
      cachedTokens: 0,
      outputTokens: 5,
      costNanoUsd: null,
    },
    {
      kind: "summary",
      providerScope: "non_web",
      records: 1,
      partialRecords: 1,
      inputTokens: 13,
      cachedTokens: 0,
      outputTokens: 2,
      costNanoUsd: null,
    },
  ]);
  expect(groups.reduce((sum: number, row: { inputTokens: number }) => sum + row.inputTokens, 0)).toBe(
    body.run.inputTokens,
  );
  const { result: direct, queries } = await countQueries(() => getRun(t.db, f.ownerId, f.orgId, f.run.id));
  expect(queries).toBe(8);
  expect(direct.run).toMatchObject({ costNanoUsd: 116, inputTokens: 211, cachedTokens: 53, outputTokens: 34 });
  const [legacy] = await listRuns(t.db, f.ownerId, f.orgId, { agentId: f.agentId });
  expect(legacy).not.toHaveProperty("usageBreakdown");
  const listed = (await (await f.api(`/runs?agentId=${f.agentId}`)).json()) as { runs: RunResponse["run"][] };
  expect(listed.runs[0]).not.toHaveProperty("usageBreakdown");
  expect(listed.runs[0]).not.toHaveProperty("costNanoUsd");
  const messages = (await (await f.api(`/channels/${f.channelId}/messages`)).json()) as {
    messages: { id: string; usage?: { inputTokens: number; outputTokens: number } }[];
  };
  expect(messages.messages.find((m: { id: string }) => m.id === reply?.id)?.usage).toMatchObject({
    inputTokens: 180,
    outputTokens: 24,
  });
});

test("getRun adds no kind labels or scope to an unreadable private run; native allowed control has it", async () => {
  const f = await fixture(true);
  await t.db.insert(schema.usageRecords).values({
    orgId: f.orgId,
    agentId: f.agentId,
    runId: f.run.id,
    kind: "summary",
    provider: "fixture",
    model: "fixture",
    requestedModel: "fixture",
    inputTokens: 10,
    outputTokens: 2,
    costNanoUsd: 0,
  });
  const allowed = (await (await f.api(`/runs/${f.run.id}`)).json()) as RunResponse;
  expect(allowed.run).toHaveProperty("usageBreakdown");
  await t.db
    .delete(schema.channelMembers)
    .where(and(eq(schema.channelMembers.channelId, f.channelId), eq(schema.channelMembers.userId, f.ownerId)));
  const hidden = (await (await f.api(`/runs/${f.run.id}`)).json()) as RunResponse;
  expect(hidden.run).toMatchObject({ private: true, what: "", inputTokens: 10, outputTokens: 2 });
  expect(hidden.run).not.toHaveProperty("usageBreakdown");
  expect(hidden.steps).toEqual([]);
  expect(JSON.stringify(hidden)).not.toContain("summary");
  expect(JSON.stringify(hidden)).not.toContain("all_run_usage_records");
});

test("getRun with no records preserves legacy zero totals and makes no zero-cash claim", async () => {
  const f = await fixture();
  const body = (await (await f.api(`/runs/${f.run.id}`)).json()) as RunResponse;
  expect(body.run).toMatchObject({ inputTokens: 0, cachedTokens: 0, outputTokens: 0 });
  expect(body.run.usageBreakdown).toMatchObject({ costScope: "not_exposed_not_actual_cash", byKind: [] });
  expect(body.run).not.toHaveProperty("costNanoUsd");
});
