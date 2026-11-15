import { afterEach, expect, test } from "bun:test";
import type { MachineRequest } from "@agenteschat/adapters/machine-protocol";
import { and, eq, schema } from "@agenteschat/db";
import { ProviderError } from "@agenteschat/providers";
import { type Brain, type BrainTurn, drainOutbox, runRoutineNow } from "../src";
import type { MachineCaller } from "../src/machine-hub";
import { paperclipProjectBrain } from "../src/paperclip-project-runtime";
import {
  createPaperclipMapping,
  dispatchPaperclipRoutine,
  setPaperclipMappingEnabled,
} from "../src/paperclip-routines";
import { registerPaperclipWorkspace } from "../src/paperclip-workspaces";
import { executeRoutineRun, setRoutineActive } from "../src/routines";
import { type Fixture, setup } from "./fixtures";
import { channelRoutine, routineDeps } from "./routine-fixtures";

let f: Fixture;
let reported: { error: unknown; outcome: "retry" | "failed" }[] = [];
afterEach(async () => {
  await f?.close();
});

async function nativeRun(reply: NonNullable<Parameters<typeof setup>[0]>["reply"]) {
  f = await setup({ reply });
  reported = [];
  const routine = await channelRoutine(f);
  await runRoutineNow(routineDeps(f), f.owner.id, f.org.id, routine.id);
  await drainOutbox(f.db, f.handlers, {
    onError: (job, error, outcome) => {
      if (job.kind === "agent_run.execute") reported.push({ error, outcome });
    },
  });
  const [firing] = await f.db.select().from(schema.routineRuns).where(eq(schema.routineRuns.routineId, routine.id));
  if (!firing) throw new Error("Native Run Now did not create a firing");
  return firing.agentRunId ?? "";
}
async function rows(runId: string) {
  const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, runId));
  const jobs = await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, "agent_run.execute"));
  const job = jobs.find((j) => j.payload.runId === runId);
  if (!run || !job) throw new Error("Missing native fixture run/job");
  return { run, job };
}
async function retryDue() {
  await f.db
    .update(schema.outbox)
    .set({ nextAttemptAt: new Date(0) })
    .where(and(eq(schema.outbox.kind, "agent_run.execute"), eq(schema.outbox.status, "pending")));
  await drainOutbox(f.db, f.handlers);
}

test("a native nonproject background transient provider error retains one bounded retry and usage attribution", async () => {
  const error = new ProviderError("synthetic overload", true, 529);
  const runId = await nativeRun((_request, n) =>
    n === 1 ? error : { chunks: ["Recovered"], usage: { inputTokens: 17, outputTokens: 3 }, costNanoUsd: 123 },
  );
  const first = await rows(runId);
  expect([first.run.background, first.run.status, first.job.status, first.job.attempts]).toEqual([
    true,
    "running",
    "pending",
    1,
  ]);
  expect(f.provider.calls).toHaveLength(1);
  expect(reported).toHaveLength(1);
  expect(reported[0]?.outcome).toBe("retry");
  expect(reported[0]?.error).toBeInstanceOf(ProviderError);
  expect(reported[0]?.error).toMatchObject({ message: error.message, retryable: true, status: 529 });
  await retryDue();
  const final = await rows(runId);
  expect([final.run.status, final.job.status, final.job.attempts, final.job.maxAttempts]).toEqual([
    "done",
    "done",
    2,
    first.job.maxAttempts,
  ]);
  expect(f.provider.calls).toHaveLength(2);
  const usage = await f.db.select().from(schema.usageRecords).where(eq(schema.usageRecords.runId, runId));
  expect(usage).toHaveLength(1);
  expect(usage[0]).toMatchObject({ inputTokens: 17, outputTokens: 3, costNanoUsd: 123 });
});

test("a native nonproject background permanent provider rejection fails once with the provider classification", async () => {
  const error = new ProviderError("provider rejected the synthetic request (400)", false, 400);
  const runId = await nativeRun(() => error);
  const { run, job } = await rows(runId);
  expect([run.status, run.error]).toEqual([
    "failed",
    "provider_error: said@Claude: provider rejected the synthetic request (400)",
  ]);
  expect([job.status, job.attempts]).toEqual(["done", 1]);
  expect(reported).toHaveLength(1);
  expect(reported[0]?.outcome).toBe("failed");
  expect(reported[0]?.error).toBeInstanceOf(ProviderError);
  expect(reported[0]?.error).toMatchObject({ message: error.message, retryable: false, status: 400 });
  expect(f.provider.calls).toHaveLength(1);
  await retryDue();
  expect(f.provider.calls).toHaveLength(1);
});

test("repeated native background provider outages retain the existing attempt cap and park without extra calls", async () => {
  const runId = await nativeRun(() => new ProviderError("synthetic overload", true, 529));
  const first = await rows(runId);
  for (let n = 1; n < first.job.maxAttempts; n++) await retryDue();
  const final = await rows(runId);
  expect([final.run.status, final.run.error]).toEqual(["waiting_input", null]);
  expect(final.job.maxAttempts).toBe(first.job.maxAttempts);
  expect(f.provider.calls).toHaveLength(first.job.maxAttempts);
  expect(final.job.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  const calls = f.provider.calls.length;
  // Do not advance the separate future outage wake: ordinary drains do not replay the parked run.
  await drainOutbox(f.db, f.handlers);
  expect(f.provider.calls).toHaveLength(calls);
});

test("a native background run with no remaining budget never calls its API provider", async () => {
  f = await setup({ budgetNanoUsd: 0 });
  const routine = await channelRoutine(f);
  await runRoutineNow(routineDeps(f), f.owner.id, f.org.id, routine.id);
  await drainOutbox(f.db, f.handlers);
  const [run] = await f.db.select().from(schema.agentRuns);
  expect([run?.background, run?.status]).toEqual([true, "waiting_input"]);
  expect(f.provider.calls).toHaveLength(0);
  expect(await f.db.select().from(schema.usageRecords)).toHaveLength(0);
});

test("a resolved nonproject brain exception crosses the wrapper with its exact identity", async () => {
  f = await setup();
  const error = new ProviderError("synthetic brain exception", true, 529);
  let calls = 0;
  const brain: Brain = {
    kind: "model",
    async *run() {
      calls++;
      yield { type: "text_delta", text: "Synthetic partial response" };
      throw error;
    },
  };
  const turn: BrainTurn = {
    runId: crypto.randomUUID(),
    orgId: f.org.id,
    agentId: f.agent.id,
    channelId: f.general.id,
    threadRootId: null,
    system: "",
    messages: [],
    tools: [],
    trigger: "synthetic exception identity",
  };
  await expect(
    Array.fromAsync(
      paperclipProjectBrain({ db: f.db, enabled: false }, brain).run(turn, {
        signal: new AbortController().signal,
        executeTool: async () => ({ content: "unused" }),
      }),
    ),
  ).rejects.toBe(error);
  expect(calls).toBe(1);
  expect(f.provider.calls).toHaveLength(0);
});

async function projectRun() {
  f = await setup();
  const uid = () => crypto.randomUUID();
  const machineId = uid();
  await f.db.insert(schema.machines).values({
    id: machineId,
    orgId: f.org.id,
    name: "Fixture Mac",
    os: "darwin",
    pairedByUserId: f.owner.id,
    protocol: 66,
  });
  await f.db
    .update(schema.agents)
    .set({ ownerUserId: f.owner.id, machineId, brain: "codex", brainModel: "model-a", brainFallback: false })
    .where(eq(schema.agents.id, f.agent.id));
  const registration = {
    id: uid(),
    machineId,
    generation: uid(),
    sourceCompanyId: uid(),
    sourceProjectId: uid(),
    sourceWorkspaceId: uid(),
    projectDigest: "a".repeat(64),
    snapshotDigest: "b".repeat(64),
    bindingDigest: "c".repeat(64),
    targetCwd: "/synthetic/target",
    agentIds: [f.agent.id],
  };
  const hub = {
    status: async () => ({
      orgId: f.org.id,
      machineId,
      name: "Fixture Mac",
      pairedByUserId: f.owner.id,
      os: "darwin",
      protocol: 66,
      online: true,
      execAllowed: true,
      paused: null,
    }),
    call: async (_mid: string, req: MachineRequest) => {
      if (req.op === "paperclip.workspace.probe") return { version: 1, connectionId: uid() };
      if (req.op === "paperclip.workspace.attest") return { ...registration, ...req.proof, bindingId: registration.id };
      throw new Error("Unexpected synthetic machine operation");
    },
  } as unknown as Pick<MachineCaller, "call" | "status">;
  const deps = { db: f.db, enabled: true };
  await registerPaperclipWorkspace({ ...deps, hub }, f.owner.id, f.org.id, registration);
  const routine = { ...routineDeps(f), enabled: true };
  const mapping = await createPaperclipMapping(routine, f.owner.id, f.org.id, {
    sourceCompanyId: registration.sourceCompanyId,
    sourceRoutineId: uid(),
    sourceRevisionId: null,
    sourceActive: true,
    activityGatePolicy: "always",
    activityGateScope: "project",
    catchUpPolicy: "skip_missed",
    triggers: [],
    policy: "always_enqueue",
    agentId: f.agent.id,
    sourceAgentId: uid(),
    title: "Synthetic project routine",
    description: "Read only the assigned synthetic target",
    projectId: registration.sourceProjectId,
    projectWorkspaceId: registration.sourceWorkspaceId,
    workspaceBindingId: registration.id,
  });
  await setRoutineActive(routineDeps(f), f.owner.id, f.org.id, mapping.routineId, true);
  const enabled = await setPaperclipMappingEnabled(routine, f.owner.id, f.org.id, mapping.id, mapping.configHash, true);
  const receipt = await dispatchPaperclipRoutine(routine, f.owner.id, f.org.id, mapping.id, {
    expectedConfigHash: enabled.configHash,
    idempotencyKey: "synthetic-project-errors",
  });
  await executeRoutineRun({ ...routineDeps(f), paperclipCompatibilityEnabled: true }, receipt.routineRunId ?? "");
  const [firing] = await f.db
    .select()
    .from(schema.routineRuns)
    .where(eq(schema.routineRuns.id, receipt.routineRunId ?? ""));
  if (!firing?.agentRunId) throw new Error("Missing project fixture run");
  await f.db.update(schema.agentRuns).set({ status: "running" }).where(eq(schema.agentRuns.id, firing.agentRunId));
  const turn: BrainTurn = {
    runId: firing.agentRunId,
    orgId: f.org.id,
    agentId: f.agent.id,
    channelId: uid(),
    threadRootId: null,
    system: "",
    messages: [],
    tools: [],
    model: "model-a",
    trigger: "synthetic project errors",
    session: { id: uid(), resume: false, machineId, cwd: registration.targetCwd },
  };
  return { deps, turn };
}

for (const kind of ["throw", "event"] as const) {
  for (const afterEffect of [false, true]) {
    test(`a mapped project ${kind} failure ${afterEffect ? "after" : "before"} a synthetic effect never authorizes replay`, async () => {
      const { deps, turn } = await projectRun();
      let calls = 0;
      let effects = 0;
      const brain: Brain = {
        kind: "codex",
        async *run() {
          calls++;
          if (afterEffect) {
            effects++;
            yield { type: "text_delta", text: "Synthetic effect receipt" };
          }
          if (kind === "throw") throw new ProviderError("synthetic unknown delivery", true, 529);
          yield {
            type: "error",
            code: "machine_offline",
            message: "synthetic unknown delivery",
            retryable: true,
            serverStop: true,
          };
        },
      };
      const events = await Array.fromAsync(
        paperclipProjectBrain(deps, brain).run(turn, {
          signal: new AbortController().signal,
          executeTool: async () => ({ content: "unused" }),
        }),
      );
      expect(calls).toBe(1);
      expect(effects).toBe(afterEffect ? 1 : 0);
      expect(events.at(-1)).toMatchObject({
        type: "error",
        code: kind === "throw" ? "paperclip_workspace_changed" : "paperclip_workspace_turn_failed",
        retryable: false,
      });
      if (kind === "event") expect(events.at(-1)).toMatchObject({ serverStop: false });
      expect(f.provider.calls).toHaveLength(0);
    });
  }
}
