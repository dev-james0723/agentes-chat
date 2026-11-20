import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { observeModelInspectorWork } from "../src/model-inspector-observations";
import { type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

let f: Fixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

async function world() {
  const fx = await setup();
  f = fx;
  const now = Date.now();
  const { machineId } = await pairMachine(fx, fx.owner.id, fx.org.id, { name: "Mac", protocol: 62, exec: true });
  const usage = (usedPercent: number, at = now) => ({
    source: "probe" as const,
    at: new Date(at).toISOString(),
    windows: [{ kind: "seven_day" as const, usedPercent, resetsAt: new Date(now + 86_400_000).toISOString() }],
  });
  const executors = {
    detectedAt: new Date(now).toISOString(),
    ownUsage: { claude_code: usage(97), codex: usage(20), grok: usage(99) },
  };
  await fx.db.update(schema.machines).set({ executors }).where(eq(schema.machines.id, machineId));
  await fx.db
    .update(schema.agents)
    .set({ brain: "claude_code", brainModel: "opus", machineId })
    .where(eq(schema.agents.id, fx.agent.id));
  const observe = () =>
    observeModelInspectorWork({ db: fx.db, orgId: fx.org.id, now, thresholdPercent: 95, maxAgeMs: 300_000 });
  const run = async (extra: Partial<typeof schema.agentRuns.$inferInsert> = {}) => {
    const [row] = await fx.db
      .insert(schema.agentRuns)
      .values({
        id: crypto.randomUUID(),
        orgId: fx.org.id,
        agentId: fx.agent.id,
        channelId: fx.general.id,
        threadRootId: crypto.randomUUID(),
        triggerMessageId: crypto.randomUUID(),
        trigger: "mention",
        hop: 1,
        status: "running",
        ...extra,
      })
      .returning();
    if (!row) throw new Error("Missing inserted work");
    return row;
  };
  const mission = async (extra: Partial<typeof schema.missions.$inferInsert> = {}) => {
    const [row] = await fx.db
      .insert(schema.missions)
      .values({
        id: crypto.randomUUID(),
        orgId: fx.org.id,
        agentId: fx.agent.id,
        channelId: fx.general.id,
        threadRootId: crypto.randomUUID(),
        ownerId: fx.owner.id,
        machineId,
        executor: "codex",
        title: "Active engineering",
        goal: "Keep the current work",
        mainSessionId: crypto.randomUUID(),
        status: "active",
        brain: "codex",
        brainModel: "gpt-6.1-sol",
        ...extra,
      })
      .returning();
    if (!row) throw new Error("Missing inserted work");
    return row;
  };
  const account = async (kind: string, usedPercent: number) => {
    const id = crypto.randomUUID();
    await fx.db.insert(schema.machineAccounts).values({
      id,
      orgId: fx.org.id,
      machineId,
      kind,
      label: "Plan",
      createdBy: fx.owner.id,
      usage: usage(usedPercent),
    });
    return id;
  };
  return { fx, now, machineId, usage, executors, observe, run, mission, account };
}

describe("model inspector active-route observations", () => {
  test("a mission and its resolved main run use the mission override, without changing their state", async () => {
    const { fx, machineId, observe, mission, run } = await world();
    const m = await mission();
    const r = await run({ brain: "codex", brainSessionId: m.mainSessionId, threadRootId: m.threadRootId });
    const rows = await observe();
    expect(rows).toHaveLength(2);
    for (const row of rows)
      expect(row).toMatchObject({
        agentId: fx.agent.id,
        kind: "codex",
        model: "gpt-6.1-sol",
        machineId,
        accountId: null,
        state: "healthy",
        usedPercent: 20,
      });
    expect((await fx.db.select().from(schema.missions).where(eq(schema.missions.id, m.id)))[0]).toEqual(m);
    expect((await fx.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, r.id)))[0]).toEqual(r);
  });

  test("a bound mission event keeps the target account across a same-session model edit", async () => {
    const { fx, machineId, observe, mission, account } = await world();
    const accountId = await account("codex", 5);
    const m = await mission({ brainModel: "gpt-6.2-sol" });
    const event = {
      schema: "model-inspector-mission-route/1",
      brain: "codex",
      model: "gpt-6.1-sol",
      accountId,
      sessionId: m.mainSessionId,
      machineId,
      ownerId: fx.owner.id,
      agentId: fx.agent.id,
    };
    const [saved] = await fx.db
      .insert(schema.missionEvents)
      .values({ orgId: fx.org.id, missionId: m.id, kind: "model_inspector_route", data: event })
      .returning();
    expect((await observe())[0]).toMatchObject({
      type: "mission",
      model: "gpt-6.2-sol",
      accountId,
      state: "healthy",
      usedPercent: 5,
    });
    if (!saved) throw new Error("Missing inserted event");
    await fx.db
      .update(schema.missionEvents)
      .set({ data: { ...event, ownerId: "a-different-owner" } })
      .where(eq(schema.missionEvents.id, saved.id));
    expect((await observe())[0]).toMatchObject({ state: "unknown", usedPercent: null });
  });

  test("a run reports its persisted handoff route only while its current session is bound to it", async () => {
    const { fx, now, machineId, observe, run, account } = await world();
    const accountId = await account("grok", 31);
    const r = await run({ brain: "grok", brainSessionId: "grok-target" });
    const handoff = {
      schema: "quota-cli-handoff/1",
      disposition: "CONTINUE",
      runId: r.id,
      agentId: r.agentId,
      channelId: r.channelId,
      goalMessageId: r.triggerMessageId,
      targetKind: "grok",
      targetAccountId: accountId,
      targetSessionId: "grok-target",
      machineId,
      model: "grok-4.7",
      observedAt: now - 400_000,
      validUntil: now - 100_000,
    };
    await fx.db
      .update(schema.agentRuns)
      .set({ transcript: { quotaCliHandoff: handoff } })
      .where(eq(schema.agentRuns.id, r.id));
    expect((await observe())[0]).toMatchObject({
      type: "run",
      kind: "grok",
      model: "grok-4.7",
      accountId,
      state: "healthy",
      usedPercent: 31,
    });
    await fx.db
      .update(schema.agentRuns)
      .set({ brainSessionId: "a-different-session" })
      .where(eq(schema.agentRuns.id, r.id));
    expect((await observe())[0]).toMatchObject({ state: "unknown", usedPercent: null });
  });

  test("ordinary runs use their actual billed route; queued work is unresolved and finished work is absent", async () => {
    const { fx, machineId, observe, run } = await world();
    const r = await run({ brain: "codex", brainSessionId: "codex-session" });
    const queued = await run({ status: "queued" });
    await run({ status: "done", brain: "claude_code" });
    await fx.db.insert(schema.usageRecords).values({
      orgId: fx.org.id,
      agentId: fx.agent.id,
      runId: r.id,
      kind: "agent",
      provider: "codex",
      model: "gpt-6.2-sol",
      requestedModel: "gpt-6.2-sol",
      inputTokens: 1,
      outputTokens: 1,
      costNanoUsd: 0,
      billedTo: "plan",
      machineId,
    });
    const rows = await observe();
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === r.id)).toMatchObject({
      kind: "codex",
      model: "gpt-6.2-sol",
      state: "healthy",
      usedPercent: 20,
    });
    expect(rows.find((row) => row.id === queued.id)).toMatchObject({
      kind: "unknown",
      state: "unknown",
      usedPercent: null,
      machineId: null,
    });
  });

  test("fresh refusals are exhausted without an invented percentage; stale and future readings are unknown", async () => {
    const { fx, now, machineId, observe, mission, executors, usage } = await world();
    await mission();
    await fx.db
      .update(schema.machines)
      .set({
        executors: {
          ...executors,
          ownUsage: { codex: { source: "turn", at: new Date(now).toISOString(), windows: [], limited: true } },
        },
      })
      .where(eq(schema.machines.id, machineId));
    expect((await observe())[0]).toMatchObject({
      state: "exhausted",
      usedPercent: null,
      observedAt: new Date(now).toISOString(),
    });
    for (const at of [now - 300_001, now + 1]) {
      await fx.db
        .update(schema.machines)
        .set({ executors: { ...executors, ownUsage: { codex: usage(99, at) } } })
        .where(eq(schema.machines.id, machineId));
      expect((await observe())[0]).toMatchObject({ state: "unknown", usedPercent: null });
    }
  });

  test("an active Claude model does not inherit another model's exhausted window", async () => {
    const { fx, now, machineId, observe, mission, executors } = await world();
    await mission({ brain: "claude_code", brainModel: "sonnet" });
    await fx.db
      .update(schema.machines)
      .set({
        executors: {
          ...executors,
          ownUsage: {
            claude_code: {
              source: "probe",
              at: new Date(now).toISOString(),
              windows: [
                { kind: "seven_day_opus", usedPercent: 100 },
                { kind: "seven_day_sonnet", usedPercent: 20 },
              ],
            },
          },
        },
      })
      .where(eq(schema.machines.id, machineId));
    expect((await observe())[0]).toMatchObject({
      kind: "claude_code",
      model: "sonnet",
      state: "healthy",
      usedPercent: 20,
    });
  });

  test("a launched native child keeps its actual account after its mission main route changes", async () => {
    const { fx, machineId, observe, mission, account } = await world();
    const m = await mission();
    const accountId = await account("claude_code", 96);
    const taskId = crypto.randomUUID();
    await fx.db.insert(schema.machineTasks).values({
      id: taskId,
      orgId: fx.org.id,
      agentId: fx.agent.id,
      machineId,
      channelId: fx.general.id,
      threadRootId: m.threadRootId,
      missionId: m.id,
      title: "Native child",
      executor: "claude",
      sessionId: "child-session",
      status: "running",
      startedAt: new Date(),
    });
    await fx.db.insert(schema.missionEvents).values({
      orgId: fx.org.id,
      missionId: m.id,
      kind: "model_inspector_child_route",
      data: {
        schema: "model-inspector-child-route/1",
        taskId,
        executor: "claude",
        sessionId: "child-session",
        machineId,
        agentId: fx.agent.id,
        ownerId: fx.owner.id,
        mainSessionId: "previous-main-session",
        brain: "claude_code",
        model: "sonnet",
        accountId,
      },
    });
    const rows = await observe();
    expect(rows.find((row) => row.type === "mission")).toMatchObject({
      kind: "codex",
      state: "healthy",
      usedPercent: 20,
    });
    expect(rows.find((row) => row.type === "task")).toMatchObject({
      id: taskId,
      kind: "claude_code",
      model: "sonnet",
      accountId,
      state: "near_limit",
      usedPercent: 96,
    });
    await fx.db
      .update(schema.machineTasks)
      .set({ sessionId: "another-child-session" })
      .where(eq(schema.machineTasks.id, taskId));
    expect((await observe()).find((row) => row.type === "task")).toMatchObject({
      kind: "claude_code",
      machineId,
      state: "unknown",
      usedPercent: null,
    });
  });

  test("queued child routes are row-bound, while legacy launched children remain unknown", async () => {
    const { fx, machineId, observe, mission, account } = await world();
    const m = await mission();
    const accountId = await account("codex", 8);
    const taskId = crypto.randomUUID();
    const base = {
      orgId: fx.org.id,
      agentId: fx.agent.id,
      machineId,
      channelId: fx.general.id,
      threadRootId: m.threadRootId,
      missionId: m.id,
      title: "Native child",
      executor: "codex",
    };
    const startRequest = {
      orgId: fx.org.id,
      agent: { id: fx.agent.id },
      machineId,
      channelId: fx.general.id,
      threadRootId: m.threadRootId,
      mission: { id: m.id },
      executor: "codex",
      sessionId: "queued-child",
      modelInspectorRoute: {
        schema: "model-inspector-child-route/1",
        machineId,
        agentId: fx.agent.id,
        ownerId: fx.owner.id,
        mainSessionId: m.mainSessionId,
        brain: "codex",
        model: "gpt-6.2-sol",
        accountId,
      },
    };
    await fx.db.insert(schema.machineTasks).values([
      { ...base, id: taskId, status: "queued", sessionId: "queued-child", startRequest },
      { ...base, status: "running", sessionId: "legacy-child", startedAt: new Date() },
      { ...base, status: "interrupted", sessionId: "interrupted-child" },
      { ...base, status: "done", sessionId: "done-child", endedAt: new Date() },
      { ...base, status: "running", sessionId: "shell-child", executor: "shell" },
    ]);
    const before = await fx.db.select().from(schema.machineTasks).where(eq(schema.machineTasks.id, taskId));
    const tasks = (await observe()).filter((row) => row.type === "task");
    expect(tasks).toHaveLength(3);
    expect(tasks.find((row) => row.id === taskId)).toMatchObject({
      kind: "codex",
      model: "gpt-6.2-sol",
      accountId,
      state: "healthy",
      usedPercent: 8,
    });
    for (const row of tasks.filter((row) => row.id !== taskId))
      expect(row).toMatchObject({ kind: "codex", machineId, model: null, state: "unknown", usedPercent: null });
    expect(await fx.db.select().from(schema.machineTasks).where(eq(schema.machineTasks.id, taskId))).toEqual(before);
    await fx.db
      .update(schema.machineTasks)
      .set({ startRequest: { ...startRequest, agent: { id: "different-agent" } } })
      .where(eq(schema.machineTasks.id, taskId));
    expect((await observe()).find((row) => row.id === taskId)).toMatchObject({ state: "unknown", usedPercent: null });
  });
});
