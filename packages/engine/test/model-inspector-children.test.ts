import { afterEach, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION, type MachineRequest } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import { type ModelInspectorChildRoute, queueMachineTask, type StartTaskInput, taskSignIn } from "../src/machine-tasks";
import { insertMessage } from "../src/messages";
import { startMissionItem } from "../src/mission-worktree";
import type { MissionDeps, MissionRow } from "../src/missions";
import { persistMissionInspectorRoute } from "../src/missions-engine";
import { type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

async function fixture() {
  f = await setup();
  const { machineId } = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, {
    name: "Inspector Mac",
    os: "darwin",
    arch: "arm64",
    protocol: MACHINE_PROTOCOL_VERSION,
    exec: true,
  });
  await f.db
    .update(schema.agents)
    .set({ machineId, brain: "claude_code", brainModel: "claude-fable-5-2", brainExtraUsage: false })
    .where(eq(schema.agents.id, f.agent.id));
  await f.db
    .update(schema.machines)
    .set({ executors: { taskModels: true } })
    .where(eq(schema.machines.id, machineId));
  const accountId = crypto.randomUUID();
  await f.db
    .insert(schema.machineAccounts)
    .values({
      id: accountId,
      orgId: f.org.id,
      machineId,
      kind: "codex",
      label: "Owner Codex",
      createdBy: f.owner.id,
      status: "active",
      authMethod: "cli_login",
      usage: {
        source: "probe",
        at: new Date().toISOString(),
        windows: [{ kind: "seven_day", usedPercent: 20, resetsAt: new Date(Date.now() + 3600000).toISOString() }],
      },
    });
  const root = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "person", userId: f.owner.id },
    body: "Inspector child routing",
  });
  const [mission] = await f.db
    .insert(schema.missions)
    .values({
      orgId: f.org.id,
      channelId: f.general.id,
      threadRootId: root.id,
      agentId: f.agent.id,
      ownerId: f.owner.id,
      machineId,
      executor: "claude",
      brain: "claude_code",
      brainModel: "claude-fable-5-2",
      title: "Child continuity",
      goal: "Complete the items",
      status: "active",
      mainSessionId: crypto.randomUUID(),
      repoDir: "app",
      worktreePath: ".worktrees/inspector",
      worktreeState: "ready",
    })
    .returning();
  if (!mission) throw new Error("Missing mission fixture");
  const starts: MachineRequest[] = [];
  const deps = {
    db: f.db,
    pubsub: f.pubsub,
    hub: {
      status: async () => ({
        orgId: f.org.id,
        protocol: MACHINE_PROTOCOL_VERSION,
        name: "Inspector Mac",
        online: true,
      }),
      call: async (_id: string, request: MachineRequest) => {
        starts.push(request);
        return { startedAt: new Date().toISOString(), cwd: ".worktrees/inspector", command: "native" };
      },
    },
  } as unknown as MissionDeps;
  const input = (sessionId: string = crypto.randomUUID()): StartTaskInput => ({
    orgId: f.org.id,
    agent: { id: f.agent.id, handle: f.agent.handle },
    machineId,
    protocol: MACHINE_PROTOCOL_VERSION,
    machineName: "Inspector Mac",
    channelId: f.general.id,
    threadRootId: root.id,
    runId: null,
    requestedByUserId: f.owner.id,
    title: "Queued item",
    executor: "claude",
    prompt: "Keep this exact work",
    sessionId,
    resume: false,
    cwd: ".worktrees/inspector",
    mode: "write",
    mission: { id: mission.id, rules: "Preserve rules" },
  });
  return { mission, machineId, accountId, deps, starts, input };
}

async function move(mission: MissionRow, brain: "codex" | "grok", accountId: string | null) {
  return f.db.transaction((tx) =>
    persistMissionInspectorRoute(
      tx,
      mission,
      { brain, model: brain === "codex" ? "gpt-6.2" : "grok-4.7", accountId, sessionId: crypto.randomUUID() },
      crypto.randomUUID(),
    ),
  );
}

test("new native children use the committed mission brain, model and account despite its old executor", async () => {
  const r = await fixture();
  expect(await move(r.mission, "codex", r.accountId)).toBe(true);
  const [mission] = await f.db.select().from(schema.missions).where(eq(schema.missions.id, r.mission.id));
  if (!mission) throw new Error("Missing moved mission");
  expect(mission.executor).toBe("claude");
  const { row } = await startMissionItem(r.deps, mission, {
    title: "Use the new route",
    prompt: "Perform item",
    sessionId: crypto.randomUUID(),
    resume: false,
    mode: "read",
  });
  expect(row.executor).toBe("codex");
  expect(r.starts).toHaveLength(1);
  expect(r.starts[0]).toMatchObject({ executor: "codex", account: r.accountId, model: "gpt-6.2" });
  const receipts = await f.db
    .select()
    .from(schema.missionEvents)
    .where(eq(schema.missionEvents.kind, "model_inspector_child_route"));
  expect(receipts.at(-1)?.data).toMatchObject({
    schema: "model-inspector-child-route/1",
    taskId: row.id,
    executor: "codex",
    sessionId: row.sessionId,
    accountId: r.accountId,
  });
  await f.db
    .update(schema.machineAccounts)
    .set({
      usage: {
        source: "probe",
        at: new Date().toISOString(),
        windows: [{ kind: "seven_day", usedPercent: 96, resetsAt: new Date(Date.now() + 3600000).toISOString() }],
      },
    })
    .where(eq(schema.machineAccounts.id, r.accountId));
  const pinned = {
    ...r.input(row.sessionId ?? undefined),
    executor: "codex" as const,
    modelInspectorRoute: receipts.at(-1)?.data as unknown as ModelInspectorChildRoute,
  };
  expect(await taskSignIn(f.db, { ...pinned, resume: true })).toEqual({ account: r.accountId, model: "gpt-6.2" });
  await expect(taskSignIn(f.db, { ...pinned, resume: false })).rejects.toThrow("reserve or limit");
  await f.db
    .update(schema.machineAccounts)
    .set({ authMethod: "api_key" })
    .where(eq(schema.machineAccounts.id, r.accountId));
  await expect(taskSignIn(f.db, { ...pinned, resume: true })).rejects.toThrow("qualified subscription account");
}, 30000);

test("mission handoff retargets only provably unstarted queue entries and preserves task content", async () => {
  const r = await fixture();
  const queued = await queueMachineTask({ db: f.db }, r.input());
  const running = await queueMachineTask({ db: f.db }, r.input());
  const claimed = await queueMachineTask({ db: f.db }, r.input());
  const resume = await queueMachineTask({ db: f.db }, { ...r.input(), resume: true });
  const previous = await queueMachineTask({ db: f.db }, { ...r.input(), resumedFromId: running.id });
  if (!queued.sessionId || !running.sessionId) throw new Error("Native task fixture requires sessions");
  const inbox = [
    {
      sessionId: queued.sessionId,
      cwd: ".worktrees/inspector",
      at: new Date().toISOString(),
      text: "Keep the child's pending instruction",
    },
    {
      sessionId: running.sessionId,
      cwd: ".worktrees/inspector",
      at: new Date().toISOString(),
      text: "Leave running child alone",
    },
  ];
  await f.db.update(schema.missions).set({ inbox }).where(eq(schema.missions.id, r.mission.id));
  await f.db
    .update(schema.machineTasks)
    .set({ status: "running", startedAt: new Date(), startRequest: null })
    .where(eq(schema.machineTasks.id, running.id));
  await f.db.update(schema.machineTasks).set({ startRequest: null }).where(eq(schema.machineTasks.id, claimed.id));
  expect(await move(r.mission, "codex", r.accountId)).toBe(true);
  const all = await f.db.select().from(schema.machineTasks).where(eq(schema.machineTasks.missionId, r.mission.id));
  const changed = all.find((row) => row.id === queued.id);
  expect(changed?.executor).toBe("codex");
  expect(changed?.sessionId).not.toBe(queued.sessionId);
  const [mission] = await f.db.select().from(schema.missions).where(eq(schema.missions.id, r.mission.id));
  const newSessionId = changed?.sessionId;
  if (!newSessionId) throw new Error("Retargeted native child requires its new session");
  expect(mission?.inbox).toEqual(
    inbox.map((entry) => ({
      ...entry,
      sessionId: entry.sessionId === queued.sessionId ? newSessionId : entry.sessionId,
    })),
  );
  expect(changed?.startRequest).toMatchObject({
    prompt: "Keep this exact work",
    cwd: ".worktrees/inspector",
    resume: false,
    executor: "codex",
    sessionId: changed?.sessionId,
    modelInspectorRoute: { schema: "model-inspector-child-route/1", accountId: r.accountId, model: "gpt-6.2" },
  });
  for (const old of [running, claimed, resume, previous]) {
    const unchanged = all.find((row) => row.id === old.id);
    expect(unchanged?.executor).toBe("claude");
    expect(unchanged?.sessionId).toBe(old.sessionId);
  }
}, 30000);

test("Grok missions reject new detached children with an actionable main-tools instruction", async () => {
  const r = await fixture();
  expect(await move(r.mission, "grok", null)).toBe(true);
  const [mission] = await f.db.select().from(schema.missions).where(eq(schema.missions.id, r.mission.id));
  if (!mission) throw new Error("Missing moved mission");
  await expect(
    startMissionItem(r.deps, mission, {
      title: "Unsupported child",
      prompt: "Work",
      sessionId: crypto.randomUUID(),
      resume: false,
      mode: "read",
    }),
  ).rejects.toThrow("main agent tools");
  await expect(
    startMissionItem(r.deps, mission, {
      title: "Unknown resume",
      prompt: "Work",
      sessionId: crypto.randomUUID(),
      resume: true,
      mode: "read",
    }),
  ).rejects.toThrow("main agent tools");
  expect(r.starts).toHaveLength(0);
}, 30000);

test("a live native child prevents committing a Grok mission route", async () => {
  const r = await fixture();
  await queueMachineTask({ db: f.db }, r.input());
  expect(await move(r.mission, "grok", null)).toBe(false);
  const [mission] = await f.db.select().from(schema.missions).where(eq(schema.missions.id, r.mission.id));
  expect(mission?.mainSessionId).toBe(r.mission.mainSessionId);
}, 30000);

test("a changed own Claude API-key login cannot dispatch an inspector child", async () => {
  const r = await fixture();
  await f.db
    .update(schema.machines)
    .set({ executors: { taskModels: true, claude: { version: "2.1.0", loggedIn: true, authMethod: "api_key" } } })
    .where(eq(schema.machines.id, r.machineId));
  expect(
    await f.db.transaction((tx) =>
      persistMissionInspectorRoute(
        tx,
        r.mission,
        { brain: "claude_code", model: "claude-fable-5-2", accountId: null, sessionId: crypto.randomUUID() },
        crypto.randomUUID(),
      ),
    ),
  ).toBe(true);
  const [mission] = await f.db.select().from(schema.missions).where(eq(schema.missions.id, r.mission.id));
  if (!mission) throw new Error("Missing moved mission");
  const { row } = await startMissionItem(r.deps, mission, {
    title: "Refuse paid credentials",
    prompt: "Work",
    sessionId: crypto.randomUUID(),
    resume: false,
    mode: "read",
  });
  expect(row.status).toBe("failed");
  expect(row.lastLine).toContain("qualified subscription account");
  expect(r.starts).toHaveLength(0);
}, 30000);

test("missing native task model capability refuses child dispatch and queued-child migration", async () => {
  const r = await fixture();
  expect(await move(r.mission, "codex", r.accountId)).toBe(true);
  await f.db.update(schema.machines).set({ executors: {} }).where(eq(schema.machines.id, r.machineId));
  const [mission] = await f.db.select().from(schema.missions).where(eq(schema.missions.id, r.mission.id));
  if (!mission) throw new Error("Missing moved mission");
  const { row } = await startMissionItem(r.deps, mission, {
    title: "Await runner model support",
    prompt: "Work",
    sessionId: crypto.randomUUID(),
    resume: false,
    mode: "read",
  });
  expect(row.status).toBe("failed");
  expect(row.lastLine).toContain("native task models");
  expect(r.starts).toHaveLength(0);
  await queueMachineTask({ db: f.db }, r.input());
  expect(await move(mission, "codex", r.accountId)).toBe(false);
}, 30000);
