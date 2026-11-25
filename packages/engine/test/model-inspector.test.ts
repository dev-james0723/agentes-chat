import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import { createAgent } from "../src/agents";
import { createModelInspector, type ModelInspectorDeps } from "../src/model-inspector";
import { type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

let f: Fixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

async function world(claude = 97, codex = 20, at = new Date().toISOString()) {
  const fx = await setup();
  f = fx;
  const { machineId } = await pairMachine(fx, fx.owner.id, fx.org.id, { name: "Mac", protocol: 62, exec: true });
  const usage = (usedPercent: number) => ({
    source: "probe" as const,
    at,
    windows: [{ kind: "seven_day" as const, usedPercent, resetsAt: new Date(Date.now() + 86_400_000).toISOString() }],
  });
  const executors = {
    claude: { version: "2.1.304", loggedIn: true, authMethod: "claude.ai" },
    codex: { version: "0.170.0" },
    detectedAt: new Date().toISOString(),
    ownUsage: { claude_code: usage(claude), codex: usage(codex) },
  };
  await fx.db
    .update(schema.machines)
    .set({ executors, lastSeenAt: new Date() })
    .where(eq(schema.machines.id, machineId));
  await fx.db
    .update(schema.agents)
    .set({ brain: "claude_code", brainModel: "sonnet", machineId, brainExtraUsage: false, brainFallback: false })
    .where(eq(schema.agents.id, fx.agent.id));
  const calls: unknown[] = [];
  const machines = {
    status: async () => ({
      id: machineId,
      name: "Mac",
      online: true,
      paused: null,
      protocol: 62,
      os: "darwin",
      pairedByUserId: fx.owner.id,
      execAllowed: true,
      executors,
    }),
    call: async (_id: string, request: unknown) => {
      calls.push(request);
      return { accounts: [] };
    },
  } as unknown as ModelInspectorDeps["machines"];
  const deps: ModelInspectorDeps = {
    db: fx.db,
    pubsub: fx.pubsub,
    machines,
    orgIds: [fx.org.id],
    models: { claude_code: "opus", codex: "gpt-6.1-sol", grok: "grok-4.7" },
  };
  const row = async () => {
    const [agent] = await fx.db.select().from(schema.agents).where(eq(schema.agents.id, fx.agent.id));
    if (!agent) throw new Error("The fixture agent is missing");
    return agent;
  };
  return { fx, machineId, deps, calls, row, usage, executors };
}

describe("model inspector fleet", () => {
  test("a configured organization is inspected and an idle 95%+ agent moves to a proven healthy subscription", async () => {
    const { fx, deps, row } = await world();
    await fx.db
      .update(schema.agents)
      .set({ brainFallback: true, brainEffort: "high" })
      .where(eq(schema.agents.id, fx.agent.id));
    const before = await row();
    const inspector = createModelInspector(deps);
    const reports = await inspector.sweep();
    expect(reports).toHaveLength(1);
    expect(reports[0]?.agents).toHaveLength(1);
    expect(reports[0]?.agents[0]).toMatchObject({
      id: fx.agent.id,
      state: "near_limit",
      usedPercent: 97,
      decision: "switched",
      target: { kind: "codex" },
    });
    const after = await row();
    expect(after.brain).toBe("codex");
    expect(after.instructions).toBe(before.instructions);
    expect(after.audienceMode).toBe(before.audienceMode);
    expect(after.ownerUserId).toBe(before.ownerUserId);
    expect(after.brainExtraUsage).toBe(false);
    expect(after.brainFallback).toBe(before.brainFallback);
    expect(after.brainEffort).toBe("high");
    const audits = await fx.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.orgId, fx.org.id), eq(schema.auditLog.action, "model_inspector.switch")));
    expect(audits).toHaveLength(1);
  });

  test("80% and stale readings never become exhausted and do not change an idle agent", async () => {
    const { fx, deps, row } = await world(80);
    const [report] = await createModelInspector(deps).sweep();
    expect(report?.agents[0]).toMatchObject({ state: "healthy", usedPercent: 80, decision: "kept" });
    expect((await row()).brain).toBe("claude_code");
    const old = new Date(Date.now() - 600_000).toISOString();
    await fx.db.update(schema.machines).set({
      executors: {
        claude: { version: "2.1.304", loggedIn: true, authMethod: "claude.ai" },
        codex: { version: "0.170.0" },
        ownUsage: { claude_code: { source: "probe", at: old, windows: [{ kind: "seven_day", usedPercent: 100 }] } },
      },
    });
    const [stale] = await createModelInspector(deps).sweep();
    expect(stale?.agents[0]).toMatchObject({ state: "unknown", decision: "kept" });
    expect((await row()).brain).toBe("claude_code");
  });

  test("active work waits for the executor boundary instead of overwriting its brain or transcript", async () => {
    const { fx, deps, row } = await world();
    const id = crypto.randomUUID();
    await fx.db.insert(schema.agentRuns).values({
      id,
      orgId: fx.org.id,
      agentId: fx.agent.id,
      channelId: fx.general.id,
      threadRootId: crypto.randomUUID(),
      triggerMessageId: crypto.randomUUID(),
      trigger: "mention",
      hop: 1,
      status: "running",
      transcript: { keep: "tool receipt" },
    });
    const [report] = await createModelInspector(deps).sweep();
    expect(report?.agents[0]).toMatchObject({ decision: "boundary", activeRunIds: [id] });
    expect((await row()).brain).toBe("claude_code");
    const [run] = await fx.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, id));
    expect(run?.transcript).toEqual({ keep: "tool receipt" });
  });

  test("no qualified alternative leaves the still functioning 95% source in place", async () => {
    const { deps, row } = await world(95, 100);
    const [report] = await createModelInspector(deps).sweep();
    expect(report?.agents[0]).toMatchObject({ state: "near_limit", decision: "blocked" });
    expect((await row()).brain).toBe("claude_code");
  });

  test("all idle agents and their enabled routines are covered, while migrations are staggered", async () => {
    const { fx, deps, machineId } = await world();
    for (let n = 0; n < 5; n++) {
      const agent = await createAgent(
        fx.db,
        fx.owner.id,
        fx.org.id,
        {
          name: `Dev ${n}`,
          handle: `dev-${n}`,
          role: "Developer",
          instructions: "Keep shipping",
          credentialId: fx.credential.id,
        },
        { model: "claude-sonnet-5-5" },
      );
      await fx.db
        .update(schema.agents)
        .set({ brain: "claude_code", brainModel: "sonnet", machineId, brainExtraUsage: false })
        .where(eq(schema.agents.id, agent.id));
    }
    const rid = crypto.randomUUID();
    await fx.db.insert(schema.routines).values({
      id: rid,
      orgId: fx.org.id,
      agentId: fx.agent.id,
      name: "Review",
      prompt: "Review the current code changes",
      target: { type: "dm" },
      triggerType: "schedule",
      active: true,
      createdByUserId: fx.owner.id,
    });
    const [report] = await createModelInspector(deps).sweep();
    expect(report?.agents).toHaveLength(6);
    expect(report?.agents.filter((a) => a.decision === "switched")).toHaveLength(4);
    expect(report?.agents.find((a) => a.id === fx.agent.id)?.routineIds).toEqual([rid]);
    const disabled = createModelInspector({ ...deps, orgIds: [] });
    expect(await disabled.sweep()).toEqual([]);
  });

  test("a manual change made while JEV is deciding wins over the inspected snapshot", async () => {
    const { fx, deps, row } = await world();
    deps.judge = {
      name: "jev",
      ask: async () => {
        await fx.db.update(schema.agents).set({ brainModel: "opus" }).where(eq(schema.agents.id, fx.agent.id));
        return { route: { choice: "codex:own" }, tier: { choice: "large" }, effort: { choice: "high" } };
      },
    };
    const [report] = await createModelInspector(deps).sweep();
    expect(report?.agents[0]?.decision).toBe("deferred");
    expect(await row()).toMatchObject({ brain: "claude_code", brainModel: "opus" });
    expect(
      await fx.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "model_inspector.switch")),
    ).toHaveLength(0);
  });

  test("a target drained during the JEV judgment is rejected before any setting changes", async () => {
    const { fx, deps, row, executors, machineId, usage } = await world();
    deps.judge = {
      name: "jev",
      ask: async () => {
        await fx.db
          .update(schema.machines)
          .set({ executors: { ...executors, ownUsage: { ...executors.ownUsage, codex: usage(100) } } })
          .where(eq(schema.machines.id, machineId));
        return { route: { choice: "codex:own" }, tier: { choice: "large" }, effort: { choice: "high" } };
      },
    };
    const [report] = await createModelInspector(deps).sweep();
    expect(report?.agents[0]?.decision).toBe("blocked");
    expect((await row()).brain).toBe("claude_code");
  });

  test("a fresh explicit refusal is exhausted even when it supplies no percentage", async () => {
    const { fx, deps, machineId, executors, row } = await world();
    await fx.db
      .update(schema.machines)
      .set({
        executors: {
          ...executors,
          ownUsage: {
            ...executors.ownUsage,
            claude_code: { source: "turn", at: new Date().toISOString(), windows: [], limited: true },
          },
        },
      })
      .where(eq(schema.machines.id, machineId));
    const [report] = await createModelInspector(deps).sweep();
    expect(report?.agents[0]).toMatchObject({ state: "exhausted", usedPercent: null, decision: "switched" });
    expect((await row()).brain).toBe("codex");
  });

  test("Grok is an eligible signed-in fallback with explicitly unknown quota and a listed model", async () => {
    const { fx, deps, machineId, executors, row } = await world(97, 100);
    const accountId = crypto.randomUUID();
    Object.assign(executors, { grok: { version: "0.4.3", models: [{ id: "grok-4.7" }] } });
    await fx.db.update(schema.machines).set({ executors }).where(eq(schema.machines.id, machineId));
    await fx.db.insert(schema.machineAccounts).values({
      id: accountId,
      orgId: fx.org.id,
      machineId,
      kind: "grok",
      label: "Plan",
      createdBy: fx.owner.id,
      authMethod: "cli_login",
      shared: true,
      serves: "everyone",
    });
    const other = await createAgent(
      fx.db,
      fx.owner.id,
      fx.org.id,
      {
        name: "Grok Dev",
        handle: "grok-dev",
        role: "Developer",
        instructions: "Keep shipping",
        credentialId: fx.credential.id,
      },
      { model: "claude-sonnet-5-5" },
    );
    await fx.db
      .update(schema.agents)
      .set({ brain: "grok", brainModel: "grok-4.7", machineId, brainAccountId: accountId })
      .where(eq(schema.agents.id, other.id));
    const [report] = await createModelInspector(deps).sweep();
    expect(report?.agents.find((a) => a.id === fx.agent.id)).toMatchObject({
      decision: "switched",
      target: { kind: "grok", quotaState: "unknown", usedPercent: null },
    });
    expect(await row()).toMatchObject({ brain: "grok", brainAccountId: accountId, brainExtraUsage: false });
    expect(report?.agents.find((a) => a.id === other.id)).toMatchObject({ state: "unknown", usedPercent: null });
  });

  test("a Grok model absent from the runner's supplied list cannot receive a migration", async () => {
    const { fx, deps, machineId, executors, row } = await world(97, 100);
    const accountId = crypto.randomUUID();
    Object.assign(executors, { grok: { version: "0.4.3", models: [{ id: "grok-other" }] } });
    await fx.db.update(schema.machines).set({ executors }).where(eq(schema.machines.id, machineId));
    await fx.db.insert(schema.machineAccounts).values({
      id: accountId,
      orgId: fx.org.id,
      machineId,
      kind: "grok",
      label: "Plan",
      createdBy: fx.owner.id,
      authMethod: "cli_login",
      shared: true,
    });
    const other = await createAgent(
      fx.db,
      fx.owner.id,
      fx.org.id,
      {
        name: "Grok Dev",
        handle: "grok-dev",
        role: "Developer",
        instructions: "Keep shipping",
        credentialId: fx.credential.id,
      },
      { model: "claude-sonnet-5-5" },
    );
    await fx.db
      .update(schema.agents)
      .set({ brain: "grok", brainModel: "grok-other", machineId, brainAccountId: accountId })
      .where(eq(schema.agents.id, other.id));
    const [report] = await createModelInspector(deps).sweep();
    expect(report?.agents.find((a) => a.id === fx.agent.id)?.decision).toBe("blocked");
    expect((await row()).brain).toBe("claude_code");
  });

  test("overlapping sweeps coalesce and read-only snapshots never claim a completed sweep", async () => {
    const { fx, deps, calls } = await world(80);
    const inspector = createModelInspector(deps);
    expect(await inspector.report(fx.org.id)).toMatchObject({ mode: "snapshot", lastSweepAt: null, stale: true });
    expect(calls).toHaveLength(0);
    const first = inspector.sweep();
    expect(inspector.sweep()).toBe(first);
    await first;
    expect(calls).toHaveLength(1);
    expect(await inspector.report(fx.org.id)).toMatchObject({ mode: "sweep", stale: false });
    await inspector.sweep();
    expect(calls).toHaveLength(1);
    expect(await inspector.report(crypto.randomUUID())).toBeNull();
  });

  test("cooldown protects the recently selected route but never traps verified exhaustion", async () => {
    const { fx, deps, row, machineId, executors, usage } = await world();
    await fx.db.insert(schema.auditLog).values({
      orgId: fx.org.id,
      actorType: "system",
      action: "model_inspector.switch",
      targetType: "agent",
      targetId: fx.agent.id,
      details: { to: { kind: "claude_code", accountId: null } },
    });
    const inspector = createModelInspector(deps);
    expect((await inspector.sweep())[0]?.agents[0]?.decision).toBe("cooldown");
    expect((await row()).brain).toBe("claude_code");
    await fx.db
      .update(schema.machines)
      .set({ executors: { ...executors, ownUsage: { ...executors.ownUsage, claude_code: usage(100) } } })
      .where(eq(schema.machines.id, machineId));
    expect((await inspector.sweep())[0]?.agents[0]?.decision).toBe("switched");
    expect((await row()).brain).toBe("codex");
  });

  test("a run's handoff does not postpone updating its still-depleted idle default", async () => {
    const { fx, deps, row } = await world();
    await fx.db.insert(schema.auditLog).values({
      orgId: fx.org.id,
      actorType: "system",
      action: "model_inspector.handoff",
      targetType: "agent",
      targetId: fx.agent.id,
      details: { to: { kind: "codex", accountId: null } },
    });
    expect((await createModelInspector(deps).sweep())[0]?.agents[0]?.decision).toBe("switched");
    expect((await row()).brain).toBe("codex");
  });

  test("a live native child keeps an otherwise idle-looking agent from changing defaults", async () => {
    const { fx, deps, row, machineId } = await world();
    const id = crypto.randomUUID();
    await fx.db.insert(schema.machineTasks).values({
      id,
      orgId: fx.org.id,
      agentId: fx.agent.id,
      machineId,
      channelId: fx.general.id,
      title: "Already writing",
      executor: "claude",
      status: "running",
      startedAt: new Date(),
    });
    const [report] = await createModelInspector(deps).sweep();
    expect(report?.agents[0]).toMatchObject({ decision: "deferred", activeTaskIds: [id] });
    expect((await row()).brain).toBe("claude_code");
    const [task] = await fx.db.select().from(schema.machineTasks).where(eq(schema.machineTasks.id, id));
    expect(task?.executor).toBe("claude");
  });

  test("an authentication change during judgment cannot turn a subscription switch into API usage", async () => {
    const { fx, deps, row, machineId, executors } = await world(20, 97);
    await fx.db
      .update(schema.agents)
      .set({ brain: "codex", brainModel: "gpt-6.1-sol" })
      .where(eq(schema.agents.id, fx.agent.id));
    deps.judge = {
      name: "jev",
      ask: async () => {
        await fx.db
          .update(schema.machines)
          .set({ executors: { ...executors, claude: { version: "2.1.304", loggedIn: true, authMethod: "api_key" } } })
          .where(eq(schema.machines.id, machineId));
        return { route: { choice: "claude_code:own" }, tier: { choice: "large" }, effort: { choice: "high" } };
      },
    };
    expect((await createModelInspector(deps).sweep())[0]?.agents[0]?.decision).toBe("blocked");
    expect((await row()).brain).toBe("codex");
  });
});
