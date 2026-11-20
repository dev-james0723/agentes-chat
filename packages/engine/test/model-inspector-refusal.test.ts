import { afterEach, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION, type PlanUsage } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  type Brain,
  clearPlanLimits,
  createAgent,
  createJobHandlers,
  createQuotaCliQualifier,
  drainOutbox,
  postPersonMessage,
} from "../src";
import {
  notePlanLimit,
  planLimitOf,
  recordGrokPlanRefusal,
  storedPlanUsage,
  UNKNOWN_LIMIT_MS,
} from "../src/brains/select";
import { createModelInspector, type ModelInspectorDeps } from "../src/model-inspector";
import { type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

let f: Fixture;
afterEach(async () => {
  clearPlanLimits();
  await f?.close();
});

async function fixture(
  options: { success?: boolean; own?: boolean; limitEvent?: boolean; newerRefusal?: boolean } = {},
) {
  f = await setup();
  const { machineId } = await pairMachine(f, f.owner.id, f.org.id, {
    name: "Grok Mac",
    os: "darwin",
    protocol: MACHINE_PROTOCOL_VERSION,
    exec: true,
  });
  const accountId = options.own ? undefined : crypto.randomUUID();
  const old: PlanUsage = {
    source: "turn",
    limited: true,
    windows: [],
    at: new Date(Date.now() - UNKNOWN_LIMIT_MS - 1000).toISOString(),
  };
  const usage = (at = new Date().toISOString()): PlanUsage => ({
    source: "probe",
    at,
    windows: [{ kind: "seven_day", usedPercent: 20 }],
  });
  await f.db
    .update(schema.machines)
    .set({
      executors: {
        codex: { version: "0.170.0" },
        grok: { version: "1.0.70", models: [{ id: "grok-4.7" }] },
        ownUsage: { codex: usage(), ...(options.own && options.success ? { grok: old } : {}) },
      },
    })
    .where(eq(schema.machines.id, machineId));
  if (accountId)
    await f.db.insert(schema.machineAccounts).values({
      id: accountId,
      orgId: f.org.id,
      machineId,
      kind: "grok",
      label: "Grok plan",
      createdBy: f.owner.id,
      authMethod: "cli_login",
      keyHint: null,
      shared: true,
      serves: "everyone",
      ...(options.success ? { usage: old } : {}),
    });
  const peer = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    {
      name: "Grok peer",
      handle: "grok-peer",
      role: "Engineer",
      instructions: "Finish the task",
      credentialId: f.credential.id,
    },
    { model: "claude-sonnet-5-5" },
  );
  for (const id of [f.agent.id, peer.id])
    await f.db
      .update(schema.agents)
      .set({
        machineId,
        brain: "grok",
        brainModel: "grok-4.7",
        brainAccountId: accountId ?? null,
        brainExtraUsage: false,
        brainFallback: false,
      })
      .where(eq(schema.agents.id, id));
  const machines: ModelInspectorDeps["machines"] = {
    status: async (id: string) => {
      const [row] = await f.db.select().from(schema.machines).where(eq(schema.machines.id, id));
      return {
        id,
        name: "Grok Mac",
        online: true,
        pairedByUserId: f.owner.id,
        os: "darwin",
        protocol: MACHINE_PROTOCOL_VERSION,
        paused: null,
        execAllowed: true,
        executors: row?.executors,
      };
    },
    call: async () => ({ accounts: [] }),
  } as unknown as ModelInspectorDeps["machines"];
  let grokTurns = 0;
  const grok: Brain = {
    kind: "grok",
    async *run() {
      grokTurns++;
      if (options.success) {
        if (options.newerRefusal) {
          const at = Date.now();
          notePlanLimit(machineId, "grok", undefined, at, accountId);
          await recordGrokPlanRefusal(f.db, f.org.id, machineId, accountId, at);
        }
        yield { type: "done", text: "Completed with Grok." };
      } else {
        if (options.limitEvent) yield { type: "limit" };
        yield { type: "error", code: "plan_limit", message: "Grok Build usage balance exhausted", retryable: false };
      }
    },
  };
  const codex: Brain = {
    kind: "codex",
    async *run() {
      yield { type: "done", text: "Completed with Codex." };
    },
  };
  const handlers = createJobHandlers({
    ...f.jobDeps,
    machines,
    brains: { grok: () => grok, codex: () => codex },
    modelInspector: { enabled: () => true, thresholdPercent: 95, maxAgeMs: 300_000, cooldownMs: 900_000 },
    quotaCliContinuation: createQuotaCliQualifier({
      db: f.db,
      machines,
      models: { codex: "gpt-6.1-sol" },
      targets: ["codex"],
    }),
  } as Parameters<typeof createJobHandlers>[0]);
  const began = Date.now();
  const message = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev Finish this availability check.",
  });
  await drainOutbox(f.db, handlers);
  const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, message.id));
  const deps: ModelInspectorDeps = {
    db: f.db,
    pubsub: f.pubsub,
    machines,
    orgIds: [f.org.id],
    models: { claude_code: "opus", codex: "gpt-6.1-sol", grok: "grok-4.7" },
    targets: ["codex"],
  };
  return { machineId, accountId, peer, began, grokTurns, run, deps, usage };
}

test("a real Grok refusal survives process reset and evacuates every shared-account default after numeric readings expire", async () => {
  const w = await fixture();
  expect(w.grokTurns).toBe(1);
  expect(w.run).toMatchObject({ status: "done", brain: "codex" });
  const refusal = await storedPlanUsage(f.db, f.org.id, w.machineId, "grok", w.accountId);
  expect(refusal).toMatchObject({ source: "turn", limited: true, windows: [] });
  expect(Date.parse(refusal?.at ?? "")).toBeGreaterThanOrEqual(w.began);
  expect(JSON.stringify(refusal)).not.toContain("usedPercent");
  expect(JSON.stringify(refusal)).not.toContain("resetsAt");
  clearPlanLimits();
  const tenMinutes = new Date(Date.now() + 600_000);
  expect(planLimitOf(w.machineId, "grok", w.accountId, refusal, tenMinutes.getTime())).toEqual({ until: null });
  const [machine] = await f.db.select().from(schema.machines).where(eq(schema.machines.id, w.machineId));
  await f.db
    .update(schema.machines)
    .set({
      executors: {
        ...machine?.executors,
        ownUsage: { ...machine?.executors?.ownUsage, codex: w.usage(tenMinutes.toISOString()) },
      },
    })
    .where(eq(schema.machines.id, w.machineId));
  const inspector = createModelInspector({ ...w.deps, now: () => tenMinutes });
  const snapshot = await inspector.report(f.org.id);
  expect(snapshot?.agents.every((a) => a.state === "exhausted" && a.usedPercent === null)).toBe(true);
  const [report] = await inspector.sweep();
  expect(report?.agents.filter((a) => a.decision === "switched")).toHaveLength(2);
  expect(await storedPlanUsage(f.db, f.org.id, w.machineId, "grok", w.accountId)).toEqual(refusal);
  expect(
    planLimitOf(w.machineId, "grok", w.accountId, refusal, Date.parse(refusal!.at) + UNKNOWN_LIMIT_MS + 1),
  ).toBeNull();
}, 30_000);

test("a successful Grok turn clears its earlier durable refusal without inventing a percentage", async () => {
  const w = await fixture({ success: true });
  expect(w.run).toMatchObject({ status: "done", brain: "grok" });
  expect(w.grokTurns).toBe(1);
  const usage = await storedPlanUsage(f.db, f.org.id, w.machineId, "grok", w.accountId);
  expect(usage).toMatchObject({ source: "turn", limited: false, windows: [] });
  expect(Date.parse(usage?.at ?? "")).toBeGreaterThanOrEqual(w.began);
  clearPlanLimits();
  expect(planLimitOf(w.machineId, "grok", w.accountId, usage)).toBeNull();
}, 30_000);

test("own Grok sign-in stores an actual limit event in its own durable pool", async () => {
  const w = await fixture({ own: true, limitEvent: true });
  expect(w.grokTurns).toBe(1);
  expect(await storedPlanUsage(f.db, f.org.id, w.machineId, "grok")).toMatchObject({
    source: "turn",
    limited: true,
    windows: [],
  });
  expect((await storedPlanUsage(f.db, f.org.id, w.machineId, "codex"))?.windows[0]?.usedPercent).toBe(20);
}, 30_000);

test("a successful older Grok turn cannot clear a concurrent newer account refusal", async () => {
  const w = await fixture({ success: true, newerRefusal: true });
  expect(w.run).toMatchObject({ status: "done", brain: "grok" });
  const usage = await storedPlanUsage(f.db, f.org.id, w.machineId, "grok", w.accountId);
  expect(usage).toMatchObject({ source: "turn", limited: true, windows: [] });
  clearPlanLimits();
  expect(planLimitOf(w.machineId, "grok", w.accountId, usage)).toEqual({ until: null });
}, 30_000);
