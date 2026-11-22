import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  addChannelMember,
  type Brain,
  createAgentRuns,
  createChannel,
  createJobHandlers,
  createQuotaCliQualifier,
  drainOutbox,
  insertMessage,
  type RoutineBrief,
} from "../src";
import { type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

setDefaultTimeout(90_000);
let f: Fixture | null = null;
afterEach(async () => {
  await f?.close();
  f = null;
});

async function fireRoutine(fx: Fixture) {
  const room = await createChannel(fx.db, fx.owner.id, fx.org.id, {
    name: `routine-test-${crypto.randomUUID().slice(0, 8)}`,
  });
  await addChannelMember(fx.db, fx.owner.id, fx.org.id, room.id, { agentId: fx.agent.id });
  const [routine] = await fx.db
    .insert(schema.routines)
    .values({
      orgId: fx.org.id,
      agentId: fx.agent.id,
      name: "Plan fallback smoke",
      prompt: "Check backup health safely",
      target: { type: "channel", channelId: fx.general.id },
      triggerType: "schedule",
      createdByUserId: fx.owner.id,
    })
    .returning();
  if (!routine) throw new Error("routine missing");
  const [rr] = await fx.db
    .insert(schema.routineRuns)
    .values({ orgId: fx.org.id, routineId: routine.id, at: new Date(), trigger: "schedule", status: "started" })
    .returning();
  if (!rr) throw new Error("run missing");
  const brief: RoutineBrief = {
    routineId: routine.id,
    routineRunId: rr.id,
    name: routine.name,
    creatorUserId: fx.owner.id,
    deliverTo: { channelId: fx.general.id, threadId: null },
    access: "act",
    report: "when_new",
    trigger: "schedule",
    dueAt: new Date().toISOString(),
  };
  const message = await insertMessage(fx.db, {
    orgId: fx.org.id,
    channelId: room.id,
    author: { type: "person", userId: fx.owner.id },
    body: routine.prompt,
    meta: { routineBrief: brief, routine: { id: routine.id, name: routine.name, runId: rr.id }, background: true },
  });
  const [run] = await fx.db.transaction((tx) =>
    createAgentRuns(tx, message, [fx.agent.id], "mention", { background: true }),
  );
  if (!run) throw new Error("agent run missing");
  await fx.db.update(schema.routineRuns).set({ agentRunId: run.id }).where(eq(schema.routineRuns.id, rr.id));
  return { run, rr };
}

test("Routines: hard plan exhaustion transitions from Codex to owner's shared Claude subscription despite extra usage allowed", async () => {
  f = await setup();
  const orgId = f.org.id;
  const ownerId = f.owner.id;
  const { machineId } = await pairMachine({ db: f.db, pubsub: f.pubsub }, ownerId, orgId, {
    name: "Mac",
    os: "darwin",
    arch: "arm64",
    protocol: MACHINE_PROTOCOL_VERSION,
    exec: true,
  });
  // The production default is true: this must not block a real hard plan refusal.
  await f.db
    .update(schema.agents)
    .set({ machineId, brain: "codex", brainExtraUsage: true })
    .where(eq(schema.agents.id, f.agent.id));
  const accountId = crypto.randomUUID();
  await f.db.insert(schema.machineAccounts).values({
    id: accountId,
    orgId,
    machineId,
    kind: "claude_code",
    label: "Owner-shared Claude subscription",
    status: "active",
    createdBy: ownerId,
    shared: true,
    authMethod: "cli_login",
  });
  let codexTurns = 0;
  let claudeTurns = 0;
  const codex: Brain = {
    kind: "codex",
    async *run() {
      codexTurns++;
      yield { type: "error", code: "plan_limit", message: "Codex limit exhausted", retryable: true, worked: false };
    },
  };
  const claude: Brain = {
    kind: "claude_code",
    async *run(turn) {
      claudeTurns++;
      expect(turn.account?.id).toBe(accountId);
      yield { type: "done", text: "Routine completed on authorized Claude subscription." };
    },
  };
  const status = (id: string) => ({
    id,
    orgId,
    name: "Mac",
    online: true,
    pairedByUserId: ownerId,
    execAllowed: true,
    os: "darwin",
    protocol: MACHINE_PROTOCOL_VERSION,
    executors: {
      detectedAt: new Date().toISOString(),
      codex: { version: "0.163.0" },
      claude: { version: "2.1.300", loggedIn: false, authMethod: "api_key" },
    },
  });
  const machines = { status: async (id: string) => status(id) };
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { codex: () => codex, claude_code: () => claude },
    machines,
    quotaCliContinuation: createQuotaCliQualifier({
      db: f.db,
      machines,
      models: { claude_code: "claude-fable-5-2" },
      targets: ["claude_code"],
    }),
  });
  const { run, rr } = await fireRoutine(f);
  await drainOutbox(f.db, handlers);
  const [after] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run.id));
  const [ledger] = await f.db.select().from(schema.routineRuns).where(eq(schema.routineRuns.id, rr.id));
  expect({ codexTurns, claudeTurns }).toEqual({ codexTurns: 1, claudeTurns: 1 });
  expect(after?.status).toBe("done");
  expect(after?.brain).toBe("claude_code");
  expect(after?.transcript).toMatchObject({ quotaCliHandoff: { targetAccountId: accountId } });
  expect(ledger?.brain).toBe("claude_code");
});
