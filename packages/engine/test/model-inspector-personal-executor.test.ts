import { afterEach, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import {
  type Brain,
  type BrainTurn,
  clearPlanLimits,
  createJobHandlers,
  createQuotaCliQualifier,
  drainOutbox,
  openPersonAgentDm,
  postPersonMessage,
  setAgentBrain,
} from "../src";
import type { JudgeRequest } from "../src/judge";
import { personalBrain, RIGHT_HAND, rightHandPerson } from "../src/right-hand";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

let f: Fixture | undefined;
afterEach(async () => {
  clearPlanLimits();
  await f?.close();
  f = undefined;
});

async function world(
  options: { knownLimit?: boolean; enabled?: boolean; changePersonal?: boolean; worked?: boolean; busy?: boolean } = {},
) {
  const fx = await setup({ rightHand: true });
  f = fx;
  // This person's subscription is independent of the global right-hand owner.
  const person = await addMember(fx.db, fx.org.id, "member", "personal-owner");
  const { machineId } = await pairMachine(fx, person.id, fx.org.id, {
    name: "Personal Mac",
    os: "darwin",
    arch: "arm64",
    protocol: MACHINE_PROTOCOL_VERSION,
    exec: true,
  });
  const usage = {
    source: "probe" as const,
    at: new Date().toISOString(),
    windows: [{ kind: "seven_day" as const, usedPercent: 20 }],
  };
  await fx.db
    .update(schema.machines)
    .set({
      online: true,
      lastSeenAt: new Date(),
      executors: {
        codex: { version: "0.170.0" },
        grok: { version: "1.0.70", models: [{ id: "grok-4.7" }] },
        detectedAt: new Date().toISOString(),
        ownUsage: { codex: usage },
      },
    })
    .where(eq(schema.machines.id, machineId));
  const accountId = crypto.randomUUID(),
    otherAccountId = crypto.randomUUID();
  await fx.db.insert(schema.machineAccounts).values(
    [person.id, fx.owner.id].map((createdBy, i) => ({
      id: i ? otherAccountId : accountId,
      orgId: fx.org.id,
      machineId,
      kind: "grok",
      label: "Grok",
      status: "active",
      createdBy,
      shared: true,
      authMethod: "cli_login",
      usage,
    })),
  );
  const [agent] = await fx.db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, fx.org.id), eq(schema.agents.builtin, RIGHT_HAND)));
  if (!agent) throw new Error("Missing right hand");
  await setAgentBrain(fx, person.id, fx.org.id, agent.id, {
    scope: "mine",
    brain: "grok",
    account: accountId,
    model: "grok-4.7",
    effort: "high",
  });
  await setAgentBrain(fx, fx.owner.id, fx.org.id, agent.id, {
    scope: "mine",
    brain: "grok",
    account: otherAccountId,
    model: "grok-4.7",
  });
  const binding = await personalBrain(fx.db, fx.org.id, person.id);
  const otherBinding = await personalBrain(fx.db, fx.org.id, fx.owner.id);
  const refuse = () =>
    fx.db
      .update(schema.machineAccounts)
      .set({
        usage: { source: "turn", at: new Date().toISOString(), limited: true, windows: [] },
      })
      .where(eq(schema.machineAccounts.id, accountId));
  if (options.knownLimit) await refuse();
  const sourceTurns: BrainTurn[] = [],
    targetTurns: BrainTurn[] = [],
    judgments: JudgeRequest[] = [];
  const source: Brain = {
    kind: "grok",
    async *run(turn) {
      sourceTurns.push(turn);
      await refuse();
      yield {
        type: "error",
        code: "plan_limit",
        message: "Actual subscription quota refusal",
        retryable: true,
        worked: options.worked === true,
      };
    },
  };
  const target: Brain = {
    kind: "codex",
    async *run(turn) {
      targetTurns.push(turn);
      if (options.busy && targetTurns.length === 1)
        yield { type: "error", code: "busy", message: "Target is busy", retryable: true };
      else yield { type: "done", text: "PERSONAL_INSPECTOR_DONE" };
    },
  };
  const machines = {
    status: async (id: string) => {
      const [row] = await fx.db.select().from(schema.machines).where(eq(schema.machines.id, id));
      return row
        ? {
            id: row.id,
            orgId: row.orgId,
            name: row.name,
            online: row.online,
            execAllowed: row.execAllowed,
            os: row.os,
            protocol: row.protocol,
            executors: row.executors,
            pairedByUserId: row.pairedByUserId,
            lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
          }
        : null;
    },
  };
  const ordinary = fx.jobDeps.context.judge;
  if (!ordinary) throw new Error("Missing judge");
  let targetBuiltin: string | null | undefined;
  const handlers = createJobHandlers({
    ...fx.jobDeps,
    machines,
    brains: {
      grok: () => source,
      codex: (a) => {
        targetBuiltin = a.builtin;
        return target;
      },
    },
    context: {
      ...fx.jobDeps.context,
      judge: {
        name: "personal-inspector-test",
        async ask(request: JudgeRequest) {
          if (request.kind !== "model_inspector_route") return ordinary.ask(request);
          judgments.push(request);
          if (options.changePersonal)
            await setAgentBrain(fx, person.id, fx.org.id, agent.id, { scope: "mine", effort: "low" });
          const candidates = request.state.candidates as { id: string }[];
          return { route: { choice: candidates[0]?.id }, tier: { choice: "large" }, effort: { choice: "high" } };
        },
      },
    },
    modelInspector: {
      enabled: () => options.enabled !== false,
      thresholdPercent: 95,
      maxAgeMs: 300_000,
      cooldownMs: 900_000,
    },
    quotaCliContinuation: createQuotaCliQualifier({
      db: fx.db,
      machines,
      models: { codex: "gpt-6.2" },
      targets: ["codex"],
    }),
  } as Parameters<typeof createJobHandlers>[0]);
  const dm = await openPersonAgentDm(fx.db, fx.org.id, person.id, agent.id);
  const message = await postPersonMessage(fx, person.id, fx.org.id, dm.id, {
    body: "PERSONAL_INSPECTOR_GOAL reply with the result only",
  });
  await drainOutbox(fx.db, handlers);
  const [run] = await fx.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, message.id));
  if (!run) throw new Error("Missing personal run");
  return {
    fx,
    person,
    machineId,
    agent,
    binding,
    otherBinding,
    accountId,
    run,
    sourceTurns,
    targetTurns,
    judgments,
    handlers,
    targetBuiltin,
  };
}

test("a real personal Grok refusal continues the same task on its person's own Codex subscription", async () => {
  const r = await world();
  expect(r.sourceTurns).toHaveLength(1);
  expect(r.targetTurns).toHaveLength(1);
  expect(r.run).toMatchObject({ status: "done", brain: "codex" });
  expect(r.targetTurns[0]).toMatchObject({
    runId: r.run.id,
    agentId: r.agent.id,
    session: { machineId: r.machineId, resume: false },
    effort: "high",
  });
  expect(r.targetTurns[0]?.account).toBeUndefined();
  expect(r.targetBuiltin).toBe(RIGHT_HAND);
  expect(await rightHandPerson(r.fx.db, r.agent, r.run)).toBe(r.person.id);
  expect(r.targetTurns[0]?.session?.id).not.toBe(r.sourceTurns[0]?.session?.id);
  expect(JSON.stringify(r.targetTurns[0])).toContain("PERSONAL_INSPECTOR_GOAL");
  expect(r.run.transcript).toMatchObject({
    quotaCliHandoff: {
      sourceKind: "grok",
      targetKind: "codex",
      targetAccountId: null,
      personalUserId: r.person.id,
      selection: { source: "judge" },
    },
  });
  expect(await personalBrain(r.fx.db, r.fx.org.id, r.person.id)).toEqual(r.binding);
  expect(await personalBrain(r.fx.db, r.fx.org.id, r.fx.owner.id)).toEqual(r.otherBinding);
  const [global] = await r.fx.db.select().from(schema.agents).where(eq(schema.agents.id, r.agent.id));
  expect(global).toMatchObject({
    builtin: r.agent.builtin,
    ownerUserId: r.agent.ownerUserId,
    machineId: r.agent.machineId,
    brain: r.agent.brain,
    brainModel: r.agent.brainModel,
    brainEffort: r.agent.brainEffort,
    brainAccountId: r.agent.brainAccountId,
    brainAccountLentBy: r.agent.brainAccountLentBy,
    brainFallback: r.agent.brainFallback,
    brainExtraUsage: r.agent.brainExtraUsage,
    model: r.agent.model,
    credentialId: r.agent.credentialId,
  });
}, 30_000);

test("a known real personal refusal at startup chooses Codex before dispatching Grok", async () => {
  const r = await world({ knownLimit: true });
  expect(r.sourceTurns).toHaveLength(0);
  expect(r.targetTurns).toHaveLength(1);
  expect(r.run).toMatchObject({ status: "done", brain: "codex" });
  expect(r.judgments).toHaveLength(1);
}, 30_000);

test("a personal edit during JEV prevents a stale active handoff", async () => {
  const r = await world({ changePersonal: true });
  expect(r.judgments).toHaveLength(1);
  expect(r.targetTurns).toHaveLength(0);
  expect(r.run.transcript?.quotaCliHandoff).toBeUndefined();
  expect(await personalBrain(r.fx.db, r.fx.org.id, r.person.id)).toMatchObject({ brain: "grok", brainEffort: "low" });
}, 30_000);

test("a personal target waiting for room resumes its committed Codex session", async () => {
  const r = await world({ busy: true });
  expect(r.targetTurns).toHaveLength(1);
  for (let i = 1; i <= 2; i++) await drainOutbox(r.fx.db, r.handlers, { now: new Date(Date.now() + i * 600_000) });
  const [done] = await r.fx.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, r.run.id));
  expect(done?.status).toBe("done");
  expect(r.targetTurns).toHaveLength(2);
  expect(r.targetTurns[1]?.session?.id).toBe(r.targetTurns[0]?.session?.id);
  expect(r.sourceTurns).toHaveLength(1);
}, 30_000);

test("a personal refusal with unknown executed effects never changes provider", async () => {
  const r = await world({ worked: true });
  expect(r.sourceTurns).toHaveLength(1);
  expect(r.targetTurns).toHaveLength(0);
  expect(r.judgments).toHaveLength(0);
  expect(r.run.transcript?.quotaCliHandoff).toBeUndefined();
}, 30_000);

test("a disabled inspector preserves the right hand's existing no-AI refusal", async () => {
  const r = await world({ enabled: false });
  expect(r.sourceTurns).toHaveLength(1);
  expect(r.targetTurns).toHaveLength(0);
  expect(r.run).toMatchObject({ status: "failed", error: "no_ai" });
}, 30_000);

test("a committed personal handoff holds after its owner changes the private binding", async () => {
  const r = await world({ busy: true });
  expect(r.targetTurns).toHaveLength(1);
  await setAgentBrain(r.fx, r.person.id, r.fx.org.id, r.agent.id, { scope: "mine", effort: "low" });
  for (let i = 1; i <= 2; i++) await drainOutbox(r.fx.db, r.handlers, { now: new Date(Date.now() + i * 600_000) });
  const [held] = await r.fx.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, r.run.id));
  expect(held).toMatchObject({
    status: "waiting_input",
    brain: "codex",
    transcript: { continuityCheckpoint: { dispatch: "hold" } },
  });
  expect(r.targetTurns).toHaveLength(1);
  expect(r.sourceTurns).toHaveLength(1);
}, 30_000);
