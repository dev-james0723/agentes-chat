import { afterEach, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import { ProviderError } from "@agenteschat/providers";
import {
  type Brain,
  type BrainTurn,
  clearPlanLimits,
  createJobHandlers,
  createQuotaCliQualifier,
  drainOutbox,
  enqueue,
  insertMessage,
  type MachineStatus,
  postPersonMessage,
} from "../src";
import { type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

const realDateNow = Date.now;
let f: Fixture;
afterEach(async () => {
  Date.now = realDateNow;
  clearPlanLimits();
  await f?.close();
});

type Observation = "fresh" | "stale" | "future" | "missing";
type Race =
  | "policy"
  | "settings"
  | "owner"
  | "wait"
  | "lease"
  | "approval"
  | "effect"
  | "open_epoch"
  | "unknown_epoch"
  | "operator_hold"
  | "continuity_hold"
  | "offline";
type Options = {
  policy?: boolean;
  liveUsage?: Observation;
  storedUsage?: Observation;
  nativeAvailable?: boolean;
  targetAllowed?: boolean;
  race?: Race;
  busy?: boolean;
  mission?: boolean;
  expireProofDuringAdmission?: boolean;
};

async function parkedFallback(options: Options = {}) {
  let completedWrites = 0;
  let recoveryStarted = false;
  let policyEnabled = options.policy !== false;
  let usageAt = new Date().toISOString();
  let injected = false;
  let changedWaitId: string | undefined;
  let changedApprovalId: string | undefined;
  let recoveredTurns = 0;
  let qualificationFinished = false;
  let qualificationValidUntil: number | undefined;
  let statusReadsAfterQualification = 0;
  let admissionClockShifted = false;
  const nativeTurns: BrainTurn[] = [];
  f = await setup({
    toolSources: [
      {
        name: "completed-fallback-work",
        tools: async () => [
          {
            name: "complete_one_step",
            description: "Record one completed synthetic work step",
            scope: "",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            execute: async () => {
              completedWrites++;
              return { content: "FALLBACK_STEP_ONE_ALREADY_DONE" };
            },
          },
        ],
      },
    ],
    reply: () =>
      completedWrites === 0
        ? { chunks: [], toolUses: [{ id: "fallback-step-one", name: "complete_one_step", input: {} }] }
        : new ProviderError("provider timed out", true),
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
      brainModel: "auto",
      brainAccountId: null,
      brainAccountLentBy: null,
      brainFallback: true,
      brainExtraUsage: false,
    })
    .where(eq(schema.agents.id, f.agent.id));

  const ownUsage = (observation: Observation = "fresh") => ({
    source: "probe" as const,
    at:
      observation === "stale"
        ? new Date(Date.now() - 360_000).toISOString()
        : observation === "future"
          ? new Date(Date.now() + 60_000).toISOString()
          : usageAt,
    windows:
      observation === "missing"
        ? []
        : [
            {
              kind: "seven_day" as const,
              usedPercent: 20,
              resetsAt: new Date(Date.now() + 3_600_000).toISOString(),
            },
          ],
  });
  const executors = (stored = false): NonNullable<MachineStatus["executors"]> => ({
    ...(!stored && recoveryStarted && options.nativeAvailable === false ? {} : { codex: { version: "0.163.0" } }),
    detectedAt: usageAt,
    ownUsage: {
      codex: ownUsage(recoveryStarted ? (stored ? options.storedUsage : options.liveUsage) : "fresh"),
    },
  });
  const status = (id: string): MachineStatus => ({
    id,
    orgId: f.org.id,
    name: "Mac",
    online: true,
    execAllowed: true,
    os: "darwin",
    protocol: MACHINE_PROTOCOL_VERSION,
    pairedByUserId: f.owner.id,
    executors: executors(),
  });
  const refreshUsage = async () => {
    usageAt = new Date().toISOString();
    await f.db
      .update(schema.machines)
      .set({
        online: true,
        execAllowed: true,
        executors: executors(true),
      })
      .where(eq(schema.machines.id, machineId));
  };
  await refreshUsage();

  let mission: typeof schema.missions.$inferSelect | undefined;
  if (options.mission) {
    const home = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: f.owner.id },
      body: "Fallback recovery mission home",
    });
    [mission] = await f.db
      .insert(schema.missions)
      .values({
        orgId: f.org.id,
        channelId: f.general.id,
        threadRootId: home.id,
        agentId: f.agent.id,
        ownerId: f.owner.id,
        machineId,
        executor: "codex",
        brain: "codex",
        brainModel: "auto",
        title: "Complete the remaining work",
        goal: "Complete two safe steps",
        status: "active",
        mainSessionId: crypto.randomUUID(),
        repoDir: "app",
        worktreePath: ".worktrees/recovery",
        worktreeState: "ready",
      })
      .returning();
  }

  const codex: Brain = {
    kind: "codex",
    async *run(turn) {
      nativeTurns.push(turn);
      if (!recoveryStarted) {
        yield { type: "limit", resetsAt: new Date(Date.now() + 3_600_000).toISOString() };
        yield { type: "error", code: "plan_limit", message: "Plan limit before native work", worked: false };
        return;
      }
      recoveredTurns++;
      if (options.busy && recoveredTurns === 1) {
        yield { type: "error", code: "busy", message: "Target temporarily has no room", retryable: true };
        return;
      }
      yield { type: "done", text: "Completed the remaining work without repeating step one." };
    },
  };
  const machines = {
    status: async (id: string) => {
      if (qualificationFinished && options.expireProofDuringAdmission) {
        statusReadsAfterQualification++;
        // First is the normal target resolver; second is the locked machine reread after early proof checks.
        if (statusReadsAfterQualification === 2) {
          const advanced = realDateNow() + 241_000;
          Date.now = () => advanced;
          admissionClockShifted = true;
        }
      }
      return status(id);
    },
  };
  const qualifier = createQuotaCliQualifier({
    db: f.db,
    machines,
    models: { codex: "gpt-6.2" },
    targets: options.targetAllowed === false ? ["claude_code"] : ["codex"],
  });

  const injectRace = async (runId: string) => {
    if (!options.race || injected) return;
    injected = true;
    const [row] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, runId));
    if (!row) throw new Error("Race fixture lost the existing run");
    const patchTranscript = async (change: Record<string, unknown>) => {
      await f.db
        .update(schema.agentRuns)
        .set({
          transcript: { ...row.transcript, ...change },
        })
        .where(eq(schema.agentRuns.id, runId));
    };
    switch (options.race) {
      case "policy":
        policyEnabled = false;
        break;
      case "settings":
        await f.db.update(schema.agents).set({ brainModel: "gpt-6.2" }).where(eq(schema.agents.id, f.agent.id));
        break;
      case "owner":
        await f.db.update(schema.agents).set({ ownerUserId: null }).where(eq(schema.agents.id, f.agent.id));
        break;
      case "wait":
        changedWaitId = crypto.randomUUID();
        await patchTranscript({ outage: { ...(row.transcript?.outage as object), waitId: changedWaitId } });
        break;
      case "lease": {
        const claimed = (await f.db.select().from(schema.outbox).where(eq(schema.outbox.status, "processing"))).find(
          (job) => job.payload.runId === runId,
        );
        if (!claimed) throw new Error("Expected a genuinely claimed outbox job");
        await f.db
          .update(schema.outbox)
          .set({
            lockedBy: "different-test-worker",
            lockedUntil: new Date(Date.now() + 600_000),
          })
          .where(eq(schema.outbox.id, claimed.id));
        break;
      }
      case "approval": {
        const [approval] = await f.db
          .insert(schema.approvals)
          .values({
            orgId: row.orgId,
            runId,
            agentId: row.agentId,
            channelId: row.channelId,
            threadRootId: row.threadRootId,
            toolUseId: "late-approval",
            tool: "synthetic_action",
            scope: "",
            params: {},
            actionHash: "a".repeat(64),
            title: "Late synthetic approval",
            expiresAt: new Date(Date.now() + 3_600_000),
            ownerUserId: f.owner.id,
          })
          .returning();
        changedApprovalId = approval?.id;
        break;
      }
      case "effect":
        await patchTranscript({ effectUncertain: { runId, turn: row.turns, tools: ["late-effect"] } });
        break;
      case "open_epoch":
      case "unknown_epoch":
        await f.db.insert(schema.runToolTokens).values({
          orgId: row.orgId,
          runId,
          agentId: row.agentId,
          machineId,
          tokenHash: options.race === "open_epoch" ? "b".repeat(64) : "c".repeat(64),
          effectEpochState: options.race === "open_epoch" ? "open" : "closed_unknown",
          expiresAt: new Date(Date.now() + 3_600_000),
        });
        break;
      case "operator_hold":
        await f.db.update(schema.agents).set({ operatorHoldAt: new Date() }).where(eq(schema.agents.id, f.agent.id));
        break;
      case "continuity_hold":
        await patchTranscript({ continuityCheckpoint: { dispatch: "hold", nextSafeAction: "reconcile" } });
        break;
      case "offline":
        await f.db.update(schema.machines).set({ online: false }).where(eq(schema.machines.id, machineId));
        break;
    }
  };

  const handlers = createJobHandlers({
    ...f.jobDeps,
    machines,
    brains: { codex: () => codex },
    modelInspector: {
      enabled: () => policyEnabled,
      thresholdPercent: 95,
      maxAgeMs: 300_000,
      cooldownMs: 900_000,
    },
    quotaCliContinuation: {
      ...qualifier,
      enabled: () => recoveryStarted && policyEnabled,
      qualify: async (input) => {
        const proof = await qualifier.qualify(input);
        if (proof && recoveryStarted) {
          qualificationFinished = true;
          qualificationValidUntil = proof.validUntil;
          await injectRace(input.runId);
        }
        return proof;
      },
    },
  });
  const message = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev FALLBACK_GOAL complete step one, then finish the remaining work",
    ...(mission ? { threadId: mission.threadRootId } : {}),
  });
  const runRow = async () =>
    (await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, message.id)))[0];
  const duePendingRunJobs = async () => {
    const current = await runRow();
    if (!current) throw new Error("Fixture did not create a run");
    const pending = (
      await f.db
        .select()
        .from(schema.outbox)
        .where(and(eq(schema.outbox.kind, "agent_run.execute"), eq(schema.outbox.status, "pending")))
    ).filter((job) => job.payload.runId === current.id);
    for (const job of pending) {
      await f.db
        .update(schema.outbox)
        .set({ nextAttemptAt: new Date(Date.now() - 1_000) })
        .where(eq(schema.outbox.id, job.id));
    }
  };
  await drainOutbox(f.db, handlers);
  for (let n = 0; n < 12; n++) {
    if ((await runRow())?.transcript?.outage) break;
    await duePendingRunJobs();
    await drainOutbox(f.db, handlers);
  }
  const parked = await runRow();
  if (!parked) throw new Error("Fixture did not create the original run");
  const outage = parked.transcript?.outage as { waitId: string; n: number } | undefined;
  if (!outage?.waitId) throw new Error("Fixture did not park on provider outage");
  const wake = (
    await f.db
      .select()
      .from(schema.outbox)
      .where(and(eq(schema.outbox.kind, "agent_run.execute"), eq(schema.outbox.status, "pending")))
  ).find((job) => job.payload.runId === parked.id && job.payload.wait === outage.waitId);
  if (!wake) throw new Error("Missing existing generation-matched outage wake");
  expect(parked.status).toBe("waiting_input");
  expect(parked.brain).toBe("model");
  expect(parked.transcript?.fallback).toBeDefined();
  expect(completedWrites).toBe(1);
  expect(nativeTurns).toHaveLength(1);
  return {
    parked,
    wake,
    nativeTurns,
    handlers,
    runRow,
    machineId,
    mission,
    duePendingRunJobs,
    completedWrites: () => completedWrites,
    injected: () => injected,
    changedWaitId: () => changedWaitId,
    changedApprovalId: () => changedApprovalId,
    qualificationValidUntil: () => qualificationValidUntil,
    statusReadsAfterQualification: () => statusReadsAfterQualification,
    admissionClockShifted: () => admissionClockShifted,
    usageAt: () => usageAt,
    async recover() {
      clearPlanLimits();
      recoveryStarted = true;
      await refreshUsage();
      await f.db
        .update(schema.outbox)
        .set({ nextAttemptAt: new Date(Date.now() - 1_000) })
        .where(eq(schema.outbox.id, wake.id));
      // Keep the lease valid across the deterministic 241 s proof-expiry clock shift.
      await drainOutbox(f.db, handlers, options.expireProofDuringAdmission ? { leaseMs: 600_000 } : {});
    },
  };
}

async function sameRunWithoutReplay(r: Awaited<ReturnType<typeof parkedFallback>>) {
  const current = await r.runRow();
  for (const key of ["id", "agentId", "channelId", "threadRootId", "triggerMessageId", "issueId", "workId"] as const) {
    expect(current?.[key]).toBe(r.parked[key]);
  }
  expect(r.completedWrites()).toBe(1);
  const allRuns = await f.db.select().from(schema.agentRuns);
  expect(allRuns.map((run) => run.id)).toEqual([r.parked.id]);
  return current;
}

async function recoveryReceipt(r: Awaited<ReturnType<typeof parkedFallback>>) {
  const done = await r.runRow();
  const receipt = done?.transcript?.quotaCliHandoff as
    | {
        reason?: string;
        targetSessionId?: string;
        outageReturn?: { waitId?: string; throughSeq?: number; contextSha256?: string; contextBytes?: number };
      }
    | undefined;
  expect(receipt?.reason).toBe("provider_outage");
  expect(receipt?.targetSessionId).toBe(done?.brainSessionId ?? undefined);
  const expectedWaitId = r.wake.payload.wait;
  if (typeof expectedWaitId !== "string") throw new Error("Outage wake has no string wait generation");
  expect(receipt?.outageReturn?.waitId).toBe(expectedWaitId);
  expect(receipt?.outageReturn?.throughSeq).toBeGreaterThan(0);
  expect(receipt?.outageReturn?.contextSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(receipt?.outageReturn?.contextBytes).toBeGreaterThan(0);
  const audits = await f.db
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.action, "run.fallback_return"), eq(schema.auditLog.runId, r.parked.id)));
  expect(audits).toHaveLength(1);
  if (!done?.replyMessageId) throw new Error("Recovered run has no actual reply");
  const [reply] = await f.db.select().from(schema.messages).where(eq(schema.messages.id, done.replyMessageId));
  expect(reply?.body).toContain("Completed the remaining work without repeating step one.");
  expect(reply?.meta.brainFallback).toBeUndefined();
}

test("a parked model fallback returns to its qualified configured Codex on the same run", async () => {
  const r = await parkedFallback();
  const modelCallsBefore = f.provider.calls.length;
  const oldNativeSession = r.nativeTurns[0]?.session?.id;
  await r.recover();
  const done = await sameRunWithoutReplay(r);
  expect(done?.status).toBe("done");
  expect(done?.brain).toBe("codex");
  expect(r.nativeTurns).toHaveLength(2);
  const returned = r.nativeTurns[1];
  expect(returned?.runId).toBe(r.parked.id);
  expect(returned?.session?.resume).toBe(false);
  expect(returned?.session?.id).not.toBe(oldNativeSession);
  expect(returned?.session?.id).toBe(done?.brainSessionId ?? undefined);
  expect(returned?.model).not.toBe("auto");
  expect(JSON.stringify(returned)).toContain("FALLBACK_GOAL");
  expect(JSON.stringify(returned)).toContain("FALLBACK_STEP_ONE_ALREADY_DONE");
  expect(f.provider.calls).toHaveLength(modelCallsBefore);
  await recoveryReceipt(r);
}, 30_000);

test.each([
  ["disabled policy", { policy: false }],
  ["target excluded from qualifier policy", { targetAllowed: false }],
  ["stale live usage", { liveUsage: "stale" }],
  ["future live usage", { liveUsage: "future" }],
  ["missing live usage", { liveUsage: "missing" }],
  ["stale stored usage", { storedUsage: "stale" }],
  ["future stored usage", { storedUsage: "future" }],
  ["missing stored usage", { storedUsage: "missing" }],
  ["missing native capability", { nativeAvailable: false }],
] satisfies [string, Options][])(
  "%s preserves the existing fallback without native replay",
  async (_name, options) => {
    const r = await parkedFallback(options);
    await r.recover();
    const current = await sameRunWithoutReplay(r);
    expect(r.nativeTurns).toHaveLength(1);
    expect(current?.brain).toBe("model");
    expect(current?.brainSessionId).toBe(r.parked.brainSessionId);
  },
  30_000,
);

test.each([
  "policy",
  "settings",
  "owner",
  "wait",
  "lease",
  "approval",
  "effect",
  "open_epoch",
  "unknown_epoch",
  "operator_hold",
  "continuity_hold",
  "offline",
] satisfies Race[])(
  "a late %s change prevents both target dispatch and source replay",
  async (race) => {
    const r = await parkedFallback({ race });
    const modelCallsBefore = f.provider.calls.length;
    await r.recover();
    const current = await sameRunWithoutReplay(r);
    expect(r.injected()).toBe(true);
    expect(r.nativeTurns).toHaveLength(1);
    expect(f.provider.calls).toHaveLength(modelCallsBefore);
    expect(current?.brain).toBe("model");
    expect(current?.brainSessionId).toBe(r.parked.brainSessionId);
    const [agent] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, f.agent.id));
    if (race === "settings") expect(agent?.brainModel).toBe("gpt-6.2");
    if (race === "owner") expect(agent?.ownerUserId).toBeNull();
    if (race === "operator_hold") expect(agent?.operatorHoldAt).not.toBeNull();
    if (race === "wait") expect((current?.transcript?.outage as { waitId?: string })?.waitId).toBe(r.changedWaitId());
    if (race === "effect") expect(current?.transcript?.effectUncertain).toMatchObject({ tools: ["late-effect"] });
    if (race === "continuity_hold")
      expect(current?.transcript?.continuityCheckpoint).toMatchObject({ dispatch: "hold" });
    if (race === "approval") {
      const [approval] = await f.db
        .select()
        .from(schema.approvals)
        .where(eq(schema.approvals.id, r.changedApprovalId() ?? ""));
      expect(approval?.status).toBe("pending");
    }
    if (race === "open_epoch" || race === "unknown_epoch") {
      const tokens = await f.db.select().from(schema.runToolTokens).where(eq(schema.runToolTokens.runId, r.parked.id));
      expect(
        tokens.some((token) => token.effectEpochState === (race === "open_epoch" ? "open" : "closed_unknown")),
      ).toBe(true);
    }
    if (race === "lease") {
      const [wake] = await f.db.select().from(schema.outbox).where(eq(schema.outbox.id, r.wake.id));
      expect(wake?.lockedBy).toBe("different-test-worker");
      expect(wake?.status).toBe("processing");
    }
    if (race === "offline") {
      const [machine] = await f.db.select().from(schema.machines).where(eq(schema.machines.id, r.machineId));
      expect(machine?.online).toBe(false);
    }
  },
  30_000,
);

test("a duplicate old outage wake cannot create another native return", async () => {
  const r = await parkedFallback();
  await r.recover();
  const done = await sameRunWithoutReplay(r);
  expect(done?.status).toBe("done");
  const targetSession = done?.brainSessionId;
  const modelCallsBefore = f.provider.calls.length;
  await enqueue(f.db, {
    orgId: f.org.id,
    kind: "agent_run.execute",
    payload: r.wake.payload,
    dedupeKey: `test-old-outage-wake:${r.parked.id}`,
    maxAttempts: 4,
  });
  await drainOutbox(f.db, r.handlers);
  const unchanged = await sameRunWithoutReplay(r);
  expect(unchanged?.brainSessionId).toBe(targetSession);
  expect(r.nativeTurns).toHaveLength(2);
  expect(f.provider.calls).toHaveLength(modelCallsBefore);
  await recoveryReceipt(r);
}, 30_000);

test("a returned Codex waiting for room resumes only its committed target session", async () => {
  const r = await parkedFallback({ busy: true });
  await r.recover();
  expect(r.nativeTurns).toHaveLength(2);
  const targetSession = r.nativeTurns[1]?.session?.id;
  const modelCallsBefore = f.provider.calls.length;
  for (let n = 0; n < 3 && (await r.runRow())?.status !== "done"; n++) {
    await r.duePendingRunJobs();
    await drainOutbox(f.db, r.handlers);
  }
  const done = await sameRunWithoutReplay(r);
  expect(done?.status).toBe("done");
  expect(r.nativeTurns).toHaveLength(3);
  expect(r.nativeTurns[2]?.session?.id).toBe(targetSession);
  expect(done?.brainSessionId).toBe(targetSession);
  expect(f.provider.calls).toHaveLength(modelCallsBefore);
}, 30_000);

test("a fallback return keeps the mission and commits a fresh native session for that same work", async () => {
  const r = await parkedFallback({ mission: true });
  if (!r.mission) throw new Error("Mission fixture is missing");
  expect(r.parked.brainSessionId).toBeNull();
  await r.recover();
  const done = await sameRunWithoutReplay(r);
  const [mission] = await f.db.select().from(schema.missions).where(eq(schema.missions.id, r.mission.id));
  expect(done?.status).toBe("done");
  expect(r.nativeTurns).toHaveLength(2);
  expect(mission?.id).toBe(r.mission.id);
  expect(mission?.threadRootId).toBe(r.mission.threadRootId);
  expect(mission?.ownerId).toBe(r.mission.ownerId);
  expect(mission?.mainSessionId).toBe(done?.brainSessionId ?? undefined);
  expect(mission?.mainSessionId).not.toBe(r.mission.mainSessionId);
  expect(done?.transcript?.quotaCliHandoff).toMatchObject({
    sourceSessionId: r.mission.mainSessionId,
    missionId: r.mission.id,
  });
  expect(r.nativeTurns[1]?.session?.resume).toBe(false);
  expect(JSON.stringify(r.nativeTurns[1])).toContain("FALLBACK_STEP_ONE_ALREADY_DONE");
}, 30_000);

test("a proof expiring during locked admission keeps same-run outage recovery live", async () => {
  const r = await parkedFallback({ expireProofDuringAdmission: true });
  const modelCallsBefore = f.provider.calls.length;
  const previousWait = r.wake.payload.wait;
  if (typeof previousWait !== "string") throw new Error("Existing outage wake has no wait generation");
  await r.recover();
  expect(r.admissionClockShifted()).toBe(true);
  expect(r.statusReadsAfterQualification()).toBeGreaterThanOrEqual(2);
  expect(Date.now()).toBeGreaterThan(r.qualificationValidUntil() ?? Number.POSITIVE_INFINITY);
  expect(Date.now() - Date.parse(r.usageAt())).toBeLessThan(300_000);

  const pendingRunJobs = async () =>
    (
      await f.db
        .select()
        .from(schema.outbox)
        .where(and(eq(schema.outbox.kind, "agent_run.execute"), eq(schema.outbox.status, "pending")))
    ).filter((job) => job.payload.runId === r.parked.id);
  let current = await sameRunWithoutReplay(r);
  for (let n = 0; n < 12; n++) {
    const wait = (current?.transcript?.outage as { waitId?: string } | undefined)?.waitId;
    const pending = await pendingRunJobs();
    if (
      current?.status === "waiting_input" &&
      wait &&
      wait !== previousWait &&
      pending.some((job) => job.payload.wait === wait)
    )
      break;
    // Advance only the existing retry of this run. A running row with no queued continuation is a failure.
    expect(pending.length).toBeGreaterThan(0);
    await r.duePendingRunJobs();
    await drainOutbox(f.db, r.handlers);
    current = await sameRunWithoutReplay(r);
  }

  expect(r.nativeTurns).toHaveLength(1);
  expect(f.provider.calls.length).toBeGreaterThan(modelCallsBefore);
  expect(current?.brain).toBe("model");
  expect(current?.brainSessionId).toBe(r.parked.brainSessionId);
  expect(current?.transcript?.quotaCliHandoff).toBeUndefined();
  expect(current?.status).toBe("waiting_input");
  const outage = current?.transcript?.outage as { waitId?: string } | undefined;
  expect(outage?.waitId).toBeDefined();
  expect(outage?.waitId).not.toBe(previousWait);
  const matchingWakes = (await pendingRunJobs()).filter((job) => job.payload.wait === outage?.waitId);
  expect(matchingWakes).toHaveLength(1);
  expect(matchingWakes[0]?.id).not.toBe(r.wake.id);
  const audits = await f.db
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.action, "run.fallback_return"), eq(schema.auditLog.runId, r.parked.id)));
  expect(audits).toHaveLength(0);
}, 30_000);
