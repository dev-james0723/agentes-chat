import { afterEach, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  type Brain,
  type BrainTurn,
  clearPlanLimits,
  createAgent,
  createJobHandlers,
  createQuotaCliQualifier,
  drainOutbox,
  executeToolForRun,
  insertMessage,
  postPersonMessage,
} from "../src";
import { resolveBrain } from "../src/brains/select";
import type { JudgeRequest } from "../src/judge";
import { missionTurnFor } from "../src/missions-engine";
import { type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

let f: Fixture;
afterEach(async () => {
  clearPlanLimits();
  await f?.close();
});

async function fixture(
  options: {
    enabled?: boolean;
    mission?: boolean;
    cut?: boolean;
    stale?: boolean;
    grok?: boolean;
    grokFallback?: boolean;
    grokModels?: string[];
    busy?: boolean;
    tier?: "medium" | "large";
    opusUsed?: number;
    recentSwitch?: boolean;
    previousTarget?: "codex" | "claude_code";
    explicitLimit?: boolean;
    changeOwner?: boolean;
    rejectPreferred?: boolean;
    changeAuth?: boolean;
  } = {},
) {
  let writes = 0;
  f = await setup({
    toolSources: [
      {
        name: "inspector-write",
        tools: async () => [
          {
            name: "inspector_write",
            description: "Record known completed work",
            scope: "",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            execute: async () => {
              writes++;
              return { content: "INSPECTOR_STEP_ONE_DONE" };
            },
          },
        ],
      },
    ],
    judge: (kind, _id, state) =>
      kind === "follow_through" ? (String(state.reply).includes("vou") ? "continue" : "done") : undefined,
  });
  const paired = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, {
    name: "Mac",
    os: "darwin",
    arch: "arm64",
    version: "0.8.0",
    protocol: MACHINE_PROTOCOL_VERSION,
    exec: true,
  });
  const machineId = paired.machineId;
  await f.db
    .update(schema.agents)
    .set({
      machineId,
      brain: "codex",
      brainModel: "gpt-6.2",
      brainExtraUsage: false,
      brainFallback: false,
    })
    .where(eq(schema.agents.id, f.agent.id));
  const grokAccountId = options.grok || options.grokFallback ? crypto.randomUUID() : null;
  if (grokAccountId) {
    await f.db.insert(schema.machineAccounts).values({
      id: grokAccountId,
      orgId: f.org.id,
      machineId,
      kind: "grok",
      label: "SuperGrok",
      status: "active",
      authMethod: "cli_login",
      keyHint: null,
      createdBy: f.owner.id,
    });
    const peer = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      {
        name: "Grok peer",
        handle: "grok-peer",
        role: "QA",
        instructions: "",
        credentialId: f.credential.id,
      },
      { model: "claude-sonnet-5-5" },
    );
    await f.db
      .update(schema.agents)
      .set({ machineId, brain: "grok", brainAccountId: grokAccountId })
      .where(eq(schema.agents.id, peer.id));
  }
  if (options.recentSwitch)
    await f.db.insert(schema.auditLog).values({
      orgId: f.org.id,
      actorType: "system",
      actorId: null,
      action: "model_inspector.handoff",
      targetType: "agent",
      targetId: f.agent.id,
      details: { to: { kind: options.previousTarget ?? "codex", accountId: null } },
    });
  const setUsage = async (used: number) => {
    const [machine] = await f.db.select().from(schema.machines).where(eq(schema.machines.id, machineId));
    const at = new Date(Date.now() - (options.stale ? 360_000 : 0)).toISOString();
    const resetsAt = new Date(Date.now() + 3600_000).toISOString();
    await f.db
      .update(schema.machines)
      .set({
        executors: {
          ...machine?.executors,
          ownUsage: {
            codex: {
              source: "probe",
              at,
              ...(options.explicitLimit && used > 20 ? { limited: true } : {}),
              windows: options.explicitLimit && used > 20 ? [] : [{ kind: "seven_day", usedPercent: used, resetsAt }],
            },
            claude_code: {
              source: "probe",
              at: new Date().toISOString(),
              windows: [
                { kind: "seven_day", usedPercent: 20, resetsAt },
                ...(options.opusUsed
                  ? [{ kind: "seven_day_opus" as const, usedPercent: options.opusUsed, resetsAt }]
                  : []),
              ],
            },
          },
        },
      })
      .where(eq(schema.machines.id, machineId));
  };
  await f.db
    .update(schema.machines)
    .set({
      executors: {
        claude: { version: "2.1.300", loggedIn: true, authMethod: "claude.ai", plan: "ultra" },
        codex: { version: "0.163.0" },
        ...(grokAccountId
          ? {
              grok: {
                version: "1.0.70",
                ...(options.grokModels ? { models: options.grokModels.map((id) => ({ id })) } : {}),
              },
            }
          : {}),
      },
    })
    .where(eq(schema.machines.id, machineId));
  await setUsage(20);
  let mission: typeof schema.missions.$inferSelect | undefined;
  if (options.mission) {
    const root = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: f.owner.id },
      body: "Inspector mission home",
    });
    [mission] = await f.db
      .insert(schema.missions)
      .values({
        orgId: f.org.id,
        channelId: f.general.id,
        threadRootId: root.id,
        agentId: f.agent.id,
        ownerId: f.owner.id,
        machineId,
        executor: "codex",
        brain: "codex",
        brainModel: "gpt-6.2",
        title: "Inspector migration",
        goal: "Complete two safe steps",
        status: "active",
        mainSessionId: crypto.randomUUID(),
        repoDir: "app",
        worktreePath: ".worktrees/inspector",
        worktreeState: "ready",
      })
      .returning();
  }
  const sourceTurns: BrainTurn[] = [],
    targetTurns: BrainTurn[] = [];
  const source: Brain = {
    kind: "codex",
    async *run(turn) {
      sourceTurns.push(turn);
      if (sourceTurns.length === 1) {
        const result = await executeToolForRun(
          f.jobDeps,
          { orgId: turn.orgId, agentId: turn.agentId, runId: turn.runId, machineId },
          { id: "inspector-write-1", name: "inspector_write", input: {} },
        );
        yield { type: "tool_call", id: "inspector-write-1", name: "inspector_write", input: {}, executed: result };
        await setUsage(96);
        if (options.cut)
          yield { type: "error", code: "plan_limit", message: "cut after work", worked: true, retryable: true };
        else yield { type: "done", text: "Step one done; vou continuar." };
      } else yield { type: "done", text: "Source completed step two." };
    },
  };
  const target = (kind: "grok" | "claude_code"): Brain => ({
    kind,
    async *run(turn) {
      targetTurns.push(turn);
      if (options.busy && targetTurns.length === 1)
        yield { type: "error", code: "busy", message: "The target is busy", retryable: true };
      else yield { type: "done", text: "Target completed step two." };
    },
  });
  const machines = {
    status: async (id: string) => ({
      id,
      orgId: f.org.id,
      name: "Mac",
      online: true,
      execAllowed: true,
      os: "darwin",
      protocol: MACHINE_PROTOCOL_VERSION,
      pairedByUserId: f.owner.id,
      executors: {
        claude: { version: "2.1.300", loggedIn: true, authMethod: "claude.ai", plan: "ultra" },
        codex: { version: "0.163.0" },
        detectedAt: new Date().toISOString(),
        ...(grokAccountId
          ? {
              grok: {
                version: "1.0.70",
                ...(options.grokModels ? { models: options.grokModels.map((id) => ({ id })) } : {}),
              },
            }
          : {}),
      },
    }),
  };
  const judgments: JudgeRequest[] = [];
  const ordinaryJudge = f.jobDeps.context.judge;
  if (!ordinaryJudge) throw new Error("Inspector fixture requires its ordinary judge");
  const context = {
    ...f.jobDeps.context,
    judge: {
      name: "test-jev",
      async ask(request: JudgeRequest) {
        if (request.kind !== "model_inspector_route") return ordinaryJudge.ask(request);
        judgments.push(request);
        if (options.changeOwner && mission)
          await f.db.update(schema.missions).set({ ownerId: null }).where(eq(schema.missions.id, mission.id));
        if (options.changeAuth) {
          const [machine] = await f.db.select().from(schema.machines).where(eq(schema.machines.id, machineId));
          await f.db
            .update(schema.machines)
            .set({
              executors: {
                ...machine?.executors,
                claude: { version: "2.1.300", loggedIn: true, authMethod: "api_key" },
              },
            })
            .where(eq(schema.machines.id, machineId));
        }
        if (options.rejectPreferred) {
          const [machine] = await f.db.select().from(schema.machines).where(eq(schema.machines.id, machineId));
          await f.db
            .update(schema.machines)
            .set({
              executors: {
                ...machine?.executors,
                ownUsage: {
                  ...machine?.executors?.ownUsage,
                  claude_code: {
                    source: "probe",
                    at: new Date().toISOString(),
                    windows: [{ kind: "seven_day", usedPercent: 99 }],
                  },
                },
              },
            })
            .where(eq(schema.machines.id, machineId));
        }
        const candidates = request.state.candidates as { id: string }[];
        return {
          route: { choice: candidates[0]?.id },
          tier: { choice: options.tier ?? "large" },
          effort: { choice: "high" },
        };
      },
    },
  };
  const handlers = createJobHandlers({
    ...f.jobDeps,
    context,
    machines,
    brains: {
      codex: () => source,
      ...(!options.grok ? { claude_code: () => target("claude_code") } : {}),
      ...(grokAccountId ? { grok: () => target("grok") } : {}),
    },
    modelInspector: {
      enabled: () => options.enabled !== false,
      thresholdPercent: 95,
      maxAgeMs: 300_000,
      cooldownMs: 900_000,
    },
    quotaCliContinuation: createQuotaCliQualifier({
      db: f.db,
      machines,
      models: {
        ...(!options.grok ? { claude_code: "claude-fable-5-2" } : {}),
        ...(grokAccountId ? { grok: "grok-4.7" } : {}),
      },
      targets: options.grokFallback ? ["claude_code", "grok"] : [options.grok ? "grok" : "claude_code"],
    }),
  } as Parameters<typeof createJobHandlers>[0]);
  const message = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev INSPECTOR_GOAL do step one then step two",
    ...(mission ? { threadId: mission.threadRootId } : {}),
  });
  await drainOutbox(f.db, handlers);
  const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, message.id));
  if (!run) throw new Error("Inspector fixture did not create its run");
  return { run, mission, sourceTurns, targetTurns, judgments, writes, machines, handlers, grokAccountId };
}

test("enabled inspector reads fresh quota at a completed turn boundary and judges a fixed-model task", async () => {
  const r = await fixture();
  expect(r.sourceTurns).toHaveLength(1);
  expect(r.targetTurns).toHaveLength(1);
  expect(r.judgments).toHaveLength(1);
  expect(r.writes).toBe(1);
  expect(r.run?.status).toBe("done");
  expect(r.run?.transcript).toMatchObject({
    quotaCliHandoff: { model: "claude-fable-5-2", effort: "high", selection: { source: "judge", tier: "large" } },
  });
  expect(r.targetTurns[0]?.session?.resume).toBe(false);
  expect(r.targetTurns[0]?.session?.id).not.toBe(r.sourceTurns[0]?.session?.id);
  expect(JSON.stringify(r.targetTurns[0])).toContain("INSPECTOR_STEP_ONE_DONE");
  expect(JSON.stringify(r.targetTurns[0])).toContain("INSPECTOR_GOAL");
}, 30_000);

test("an active mission commits the target route and new session for the next run", async () => {
  const r = await fixture({ mission: true });
  if (!r.mission) throw new Error("Inspector fixture did not create its mission");
  expect(r.targetTurns).toHaveLength(1);
  const [mission] = await f.db.select().from(schema.missions).where(eq(schema.missions.id, r.mission.id));
  expect(mission).toMatchObject({
    brain: "claude_code",
    brainModel: "claude-fable-5-2",
    ownerId: f.owner.id,
    worktreePath: ".worktrees/inspector",
  });
  expect(mission?.mainSessionId ?? null).toBe(r.run?.brainSessionId ?? null);
  expect(mission?.mainSessionId).not.toBe(r.mission?.mainSessionId);
  const next = { ...r.run, id: crypto.randomUUID(), brainSessionId: null, triggerMessageId: crypto.randomUUID() };
  const turn = await missionTurnFor(f.db, next);
  expect(turn).toMatchObject({
    brain: "claude_code",
    model: "claude-fable-5-2",
    accountId: null,
    session: { id: mission?.mainSessionId, resume: true },
  });
  const [agent] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, f.agent.id));
  if (!agent) throw new Error("Inspector fixture lost its agent");
  const plan = await resolveBrain({ db: f.db, machines: r.machines }, agent, next, next.threadRootId);
  expect(plan.kind).toBe("claude_code");
  expect(plan.session?.id).toBe(mission?.mainSessionId);
  expect(plan.effort).toBe("high");
  expect(r.targetTurns[0]?.session?.cwd).toBe(".worktrees/inspector");
}, 30_000);

test("an organization outside the allowlist gets no new boundary inspection", async () => {
  const r = await fixture({ enabled: false });
  expect(r.judgments).toHaveLength(0);
  expect(r.sourceTurns).toHaveLength(2);
  expect(r.targetTurns).toHaveLength(0);
}, 30_000);

test("stale telemetry does not trigger proactive handoff", async () => {
  const r = await fixture({ stale: true });
  expect(r.judgments).toHaveLength(0);
  expect(r.targetTurns).toHaveLength(0);
}, 30_000);

test("a quota cut after an executed effect never changes provider", async () => {
  const r = await fixture({ cut: true, mission: true });
  expect(r.targetTurns).toHaveLength(0);
  expect(r.judgments).toHaveLength(0);
  expect(r.run?.brain).toBe("codex");
}, 30_000);

test("a blocked mapped Claude model falls back to the revalidated qualified top model", async () => {
  const r = await fixture({ tier: "medium", opusUsed: 99 });
  expect(r.judgments).toHaveLength(1);
  expect(r.targetTurns).toHaveLength(1);
  expect(r.targetTurns[0]?.model).toBe("claude-fable-5-2");
  expect(r.run?.transcript).toMatchObject({ quotaCliHandoff: { selection: { source: "fallback", tier: "medium" } } });
}, 30_000);

test("a recent handoff in another run cools proactive switching down", async () => {
  const r = await fixture({ recentSwitch: true });
  expect(r.judgments).toHaveLength(0);
  expect(r.targetTurns).toHaveLength(0);
}, 30_000);

test("a fresh explicit plan refusal without percentages bypasses cooldown", async () => {
  const r = await fixture({ recentSwitch: true, explicitLimit: true });
  expect(r.targetTurns).toHaveLength(1);
  expect(r.run?.brain).toBe("claude_code");
}, 30_000);

test("a prior run handoff does not cool down an unchanged exhausted agent default", async () => {
  const r = await fixture({ recentSwitch: true, previousTarget: "claude_code" });
  expect(r.judgments).toHaveLength(1);
  expect(r.targetTurns).toHaveLength(1);
}, 30_000);

test("an invalidated preferred route falls back to another qualified route without another JEV call", async () => {
  const r = await fixture({ grokFallback: true, rejectPreferred: true });
  expect(r.judgments).toHaveLength(1);
  expect(r.targetTurns).toHaveLength(1);
  expect(r.targetTurns[0]?.model).toBe("grok-4.7");
  expect(r.targetTurns[0]?.account?.id ?? null).toBe(r.grokAccountId);
  expect(r.run?.transcript).toMatchObject({
    quotaCliHandoff: { targetKind: "grok", selection: { source: "fallback" } },
  });
}, 30_000);

test("a mission handoff persists the actual Grok account despite unknown quota", async () => {
  const r = await fixture({ mission: true, grok: true, grokModels: ["grok-4.7"] });
  expect(r.targetTurns).toHaveLength(1);
  expect(r.targetTurns[0]?.account?.id ?? null).toBe(r.grokAccountId);
  const next = { ...r.run, id: crypto.randomUUID(), brainSessionId: null, triggerMessageId: crypto.randomUUID() };
  const [agent] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, f.agent.id));
  if (!agent) throw new Error("Inspector fixture lost its agent");
  const plan = await resolveBrain({ db: f.db, machines: r.machines }, agent, next, next.threadRootId);
  expect(plan.account?.id ?? null).toBe(r.grokAccountId);
  expect(plan.quotaReserve?.state).toBe("unknown");
  expect(plan.quotaReserve?.usedPercent).toBeUndefined();
}, 30_000);

test("Grok does not receive a model absent from its supplied installed list", async () => {
  const r = await fixture({ grok: true, grokModels: ["different-model"] });
  expect(r.targetTurns).toHaveLength(0);
  expect(r.judgments).toHaveLength(0);
}, 30_000);

test("a mission route that waits for room resumes its committed target session", async () => {
  const r = await fixture({ mission: true, busy: true });
  expect(r.targetTurns).toHaveLength(1);
  expect(r.run?.brain).toBe("claude_code");
  for (let i = 1; i <= 2; i++) await drainOutbox(f.db, r.handlers, { now: new Date(Date.now() + i * 600_000) });
  const [done] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, r.run.id));
  expect(done?.status).toBe("done");
  expect(r.targetTurns).toHaveLength(2);
  expect(r.targetTurns[1]?.session?.id).toBe(r.targetTurns[0]?.session?.id);
  expect(r.sourceTurns).toHaveLength(1);
}, 30_000);

test("a mission owner change during judgment prevents the route commit", async () => {
  const r = await fixture({ mission: true, changeOwner: true });
  if (!r.mission) throw new Error("Inspector fixture did not create its mission");
  expect(r.judgments).toHaveLength(1);
  expect(r.targetTurns).toHaveLength(0);
  const [mission] = await f.db.select().from(schema.missions).where(eq(schema.missions.id, r.mission.id));
  expect(mission?.ownerId).toBeNull();
  expect(mission?.brain).toBe("codex");
  expect(mission?.mainSessionId).toBe(r.mission?.mainSessionId);
  expect(r.run?.transcript?.quotaCliHandoff).toBeUndefined();
}, 30_000);

test("a subscription login changed to an API key during JEV cannot receive an active handoff", async () => {
  const r = await fixture({ mission: true, changeAuth: true });
  expect(r.judgments).toHaveLength(1);
  expect(r.targetTurns).toHaveLength(0);
  expect(r.run?.transcript?.quotaCliHandoff).toBeUndefined();
}, 30000);
