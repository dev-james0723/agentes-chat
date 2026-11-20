import { afterEach, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import { MACHINE_CONTROL_TOPIC } from "../src/machines";
import { createModelInspector, type ModelInspectorDeps } from "../src/model-inspector";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

let f: Fixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

async function world(codexPercent = 4) {
  const fx = await setup();
  f = fx;
  const { machineId } = await pairMachine(fx, fx.owner.id, fx.org.id, {
    name: "Owner Mac",
    os: "darwin",
    protocol: MACHINE_PROTOCOL_VERSION,
    exec: true,
  });
  const accountId = crypto.randomUUID();
  const at = new Date().toISOString();
  const executors = {
    codex: { version: "0.170.0" },
    grok: { version: "1.0.70", models: [{ id: "grok-4.7" }] },
    ownUsage: {
      codex: { source: "probe" as const, at, windows: [{ kind: "seven_day" as const, usedPercent: codexPercent }] },
    },
  };
  await fx.db
    .update(schema.machines)
    .set({ executors, lastSeenAt: new Date() })
    .where(eq(schema.machines.id, machineId));
  await fx.db.insert(schema.machineAccounts).values({
    id: accountId,
    orgId: fx.org.id,
    machineId,
    kind: "grok",
    label: "Owner plan",
    createdBy: fx.owner.id,
    authMethod: "cli_login",
    shared: true,
    serves: "everyone",
    usage: { source: "turn", at, limited: true, windows: [] },
  });
  await fx.db
    .update(schema.agents)
    .set({
      builtin: "right_hand",
      machineId: null,
      brain: "grok",
      brainModel: "grok-4.7",
      brainAccountId: accountId,
      brainFallback: false,
      brainExtraUsage: false,
    })
    .where(eq(schema.agents.id, fx.agent.id));
  const other = await addMember(fx.db, fx.org.id, "member", "other-person");
  await fx.db.insert(schema.rightHandBrains).values([
    {
      orgId: fx.org.id,
      userId: fx.owner.id,
      brain: "grok",
      brainModel: "grok-4.7",
      brainAccountId: accountId,
      brainEffort: "high",
    },
    {
      orgId: fx.org.id,
      userId: other.id,
      brain: "grok",
      brainModel: "auto",
      brainAccountId: accountId,
      brainEffort: "low",
    },
  ]);
  const global = async () => (await fx.db.select().from(schema.agents).where(eq(schema.agents.id, fx.agent.id)))[0];
  const binding = async (userId = fx.owner.id) =>
    (
      await fx.db
        .select()
        .from(schema.rightHandBrains)
        .where(and(eq(schema.rightHandBrains.orgId, fx.org.id), eq(schema.rightHandBrains.userId, userId)))
    )[0];
  const deps: ModelInspectorDeps = {
    db: fx.db,
    pubsub: fx.pubsub,
    orgIds: [fx.org.id],
    targets: ["codex"],
    models: { claude_code: "opus", codex: "gpt-6.1-sol", grok: "grok-4.7" },
    machines: {
      status: async () => ({
        id: machineId,
        name: "Owner Mac",
        online: true,
        paused: null,
        protocol: MACHINE_PROTOCOL_VERSION,
        os: "darwin",
        pairedByUserId: fx.owner.id,
        execAllowed: true,
        executors,
      }),
      call: async () => ({ accounts: [] }),
    } as unknown as ModelInspectorDeps["machines"],
    judge: {
      name: "jev",
      ask: async () => ({ route: { choice: "codex:own" }, tier: { choice: "medium" }, effort: { choice: "low" } }),
    },
  };
  return { fx, machineId, accountId, other, global, binding, deps };
}

test("the owner's right-hand route moves through JEV without changing global or other personal defaults", async () => {
  const w = await world();
  const before = await w.global();
  const other = await w.binding(w.other.id);
  const ownerRoutine = crypto.randomUUID();
  const otherRoutine = crypto.randomUUID();
  await w.fx.db.insert(schema.routines).values([
    {
      id: ownerRoutine,
      orgId: w.fx.org.id,
      agentId: w.fx.agent.id,
      name: "Owner work",
      prompt: "Review the owner's code changes",
      target: { type: "dm" },
      triggerType: "schedule",
      active: true,
      createdByUserId: w.fx.owner.id,
    },
    {
      id: otherRoutine,
      orgId: w.fx.org.id,
      agentId: w.fx.agent.id,
      name: "Other work",
      prompt: "Other person's private task",
      target: { type: "dm" },
      triggerType: "schedule",
      active: true,
      createdByUserId: w.other.id,
    },
  ]);
  let judgedTask = "";
  const judge = w.deps.judge;
  if (!judge) throw new Error("Missing fixture judge");
  w.deps.judge = {
    name: "jev",
    ask: async (request) => {
      judgedTask = JSON.stringify(request.state);
      return judge.ask(request);
    },
  };
  const signals: unknown[] = [];
  await w.fx.pubsub.subscribe(MACHINE_CONTROL_TOPIC, (event) => {
    signals.push(event);
  });
  const inspector = createModelInspector(w.deps);
  const [report] = await inspector.sweep();
  expect(report?.agents[0]).toMatchObject({
    state: "exhausted",
    usedPercent: null,
    decision: "switched",
    target: { kind: "codex", usedPercent: 4 },
    scope: "owner_personal",
  });
  expect(await w.binding()).toMatchObject({
    brain: "codex",
    brainAccountId: null,
    machineId: w.machineId,
    brainEffort: "high",
  });
  expect(await w.global()).toEqual(before);
  expect(signals).toContainEqual({ type: "machine.agents", orgId: w.fx.org.id });
  expect(await w.binding(w.other.id)).toEqual(other);
  expect(report?.agents[0]?.routineIds).toEqual([ownerRoutine]);
  expect(judgedTask).toContain("Review the owner's code changes");
  expect(judgedTask).not.toContain("Other person's private task");
  const snapshot = await createModelInspector(w.deps).report(w.fx.org.id);
  expect(snapshot?.agents[0]).toMatchObject({
    brain: "codex",
    state: "healthy",
    usedPercent: 4,
    scope: "owner_personal",
    pool: `codex:${w.machineId}:own`,
  });
  const audits = await w.fx.db
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.action, "model_inspector.switch"));
  expect(audits).toHaveLength(1);
  expect(audits[0]?.details).toMatchObject({
    scope: "owner_personal",
    selection: "judge",
    personalUserId: w.fx.owner.id,
    to: { kind: "codex", accountId: null },
  });
}, 30_000);

test("a personal model edit made during JEV wins over the inspected binding", async () => {
  const w = await world();
  const before = await w.global();
  w.deps.judge = {
    name: "jev",
    ask: async () => {
      await w.fx.db
        .update(schema.rightHandBrains)
        .set({ brainModel: "auto", updatedAt: new Date() })
        .where(and(eq(schema.rightHandBrains.orgId, w.fx.org.id), eq(schema.rightHandBrains.userId, w.fx.owner.id)));
      return { route: { choice: "codex:own" }, tier: { choice: "medium" }, effort: { choice: "low" } };
    },
  };
  const [report] = await createModelInspector(w.deps).sweep();
  expect(report?.agents[0]?.decision).toBe("deferred");
  expect(await w.binding()).toMatchObject({ brain: "grok", brainModel: "auto", brainAccountId: w.accountId });
  expect(await w.global()).toEqual(before);
  expect(
    await w.fx.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "model_inspector.switch")),
  ).toHaveLength(0);
}, 30_000);

test("right-hand work started during JEV keeps its personal route until a safe boundary", async () => {
  const w = await world();
  const before = await w.binding();
  w.deps.judge = {
    name: "jev",
    ask: async () => {
      await w.fx.db.insert(schema.agentRuns).values({
        id: crypto.randomUUID(),
        orgId: w.fx.org.id,
        agentId: w.fx.agent.id,
        channelId: w.fx.general.id,
        threadRootId: crypto.randomUUID(),
        triggerMessageId: crypto.randomUUID(),
        trigger: "mention",
        hop: 1,
        status: "running",
        transcript: { keep: "receipt" },
      });
      return { route: { choice: "codex:own" }, tier: { choice: "medium" }, effort: { choice: "low" } };
    },
  };
  const [report] = await createModelInspector(w.deps).sweep();
  expect(report?.agents[0]?.decision).toBe("boundary");
  expect(await w.binding()).toEqual(before);
}, 30_000);

test("a right hand without an owner or healthy eligible route is explicitly blocked", async () => {
  const w = await world(100);
  const before = await w.binding();
  const [noRoom] = await createModelInspector(w.deps).sweep();
  expect(noRoom?.agents[0]).toMatchObject({ state: "exhausted", decision: "blocked" });
  expect(await w.binding()).toEqual(before);
  await w.fx.db.update(schema.agents).set({ ownerUserId: null }).where(eq(schema.agents.id, w.fx.agent.id));
  const missingOwner = await createModelInspector(w.deps).report(w.fx.org.id);
  expect(missingOwner?.agents[0]?.decision).toBe("blocked");
  expect(await w.binding()).toEqual(before);
}, 30_000);
