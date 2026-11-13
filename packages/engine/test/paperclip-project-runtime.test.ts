import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import type { Brain, BrainTurn } from "../src/brains/types";
import type { MachineCaller } from "../src/machine-hub";
import { paperclipProjectBrain, paperclipProjectHub, paperclipProjectRun } from "../src/paperclip-project-runtime";
import {
  createPaperclipMapping,
  dispatchPaperclipRoutine,
  setPaperclipMappingEnabled,
} from "../src/paperclip-routines";
import { disablePaperclipWorkspace, registerPaperclipWorkspace } from "../src/paperclip-workspaces";
import { executeRoutineRun, setRoutineActive } from "../src/routines";
import { type Fixture, setup } from "./fixtures";
import { routineDeps } from "./routine-fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});
const uid = () => crypto.randomUUID();
async function fixture() {
  f = await setup();
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
    targetCwd: "/separate/target",
    agentIds: [f.agent.id],
  };
  let attestationPatch: Record<string, unknown> = {},
    statusPatch: Record<string, unknown> = {};
  const calls: string[] = [];
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
      ...statusPatch,
    }),
    call: async (_mid: string, req: any) => {
      calls.push(req.op);
      if (req.op === "paperclip.workspace.probe") return { version: 1, connectionId: uid() };
      if (req.op === "paperclip.workspace.attest")
        return { ...registration, ...req.proof, bindingId: registration.id, ...attestationPatch };
      if (req.op === "paperclip.brain.turn") return { runId: req.runId, final: { type: "done", text: req.cwd } };
      throw Error(`unexpected ${req.op}`);
    },
  } as unknown as Pick<MachineCaller, "call" | "status">;
  const deps = { db: f.db, hub, enabled: true };
  return {
    registration,
    deps,
    calls,
    patchAttestation: (p: Record<string, unknown>) => {
      attestationPatch = p;
    },
    patchStatus: (p: Record<string, unknown>) => {
      statusPatch = p;
    },
  };
}
test("server registration proves exact source IDs/digests and every native target grant; no routine starts", async () => {
  const x = await fixture();
  x.patchAttestation({ sourceWorkspaceId: uid() });
  await expect(registerPaperclipWorkspace(x.deps, f.owner.id, f.org.id, x.registration)).rejects.toThrow();
  expect(await f.db.select().from(schema.paperclipWorkspaceBindings)).toHaveLength(0);
  x.patchAttestation({});
  const b = await registerPaperclipWorkspace(x.deps, f.owner.id, f.org.id, x.registration);
  expect(b.agents[0]).toMatchObject({ id: f.agent.id, model: "model-a", brain: "codex" });
  expect(await f.db.select().from(schema.routineRuns)).toHaveLength(0);
  await expect(registerPaperclipWorkspace(x.deps, f.owner.id, f.org.id, x.registration)).rejects.toThrow();
  x.patchStatus({ protocol: 65 });
  await expect(
    registerPaperclipWorkspace(x.deps, f.owner.id, f.org.id, { ...x.registration, id: uid() }),
  ).rejects.toThrow();
});
async function running(x: Awaited<ReturnType<typeof fixture>>, index = 0) {
  const r = x.registration;
  const deps = { ...routineDeps(f), enabled: true };
  const m = await createPaperclipMapping(deps, f.owner.id, f.org.id, {
    sourceCompanyId: r.sourceCompanyId,
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
    title: `Project routine ${index + 1}`,
    description: "Report only the assigned target.",
    projectId: r.sourceProjectId,
    projectWorkspaceId: r.sourceWorkspaceId,
    workspaceBindingId: r.id,
  });
  await setRoutineActive(routineDeps(f), f.owner.id, f.org.id, m.routineId, true);
  const enabled = await setPaperclipMappingEnabled(deps, f.owner.id, f.org.id, m.id, m.configHash, true);
  const receipt = await dispatchPaperclipRoutine(deps, f.owner.id, f.org.id, m.id, {
    expectedConfigHash: enabled.configHash,
    idempotencyKey: `fixture-${index}`,
  });
  await executeRoutineRun({ ...routineDeps(f), paperclipCompatibilityEnabled: true }, receipt.routineRunId!);
  const [firing] = await f.db.select().from(schema.routineRuns).where(eq(schema.routineRuns.id, receipt.routineRunId!));
  expect(firing!.agentRunId).toBeTruthy();
  await f.db.update(schema.agentRuns).set({ status: "running" }).where(eq(schema.agentRuns.id, firing!.agentRunId!));
  return { runId: firing!.agentRunId!, mapping: enabled, receipt };
}
test("seven synthetic routine firings resolve receipt-bound cwd and fresh native sessions; normal model fallback is refused", async () => {
  const x = await fixture();
  await registerPaperclipWorkspace(x.deps, f.owner.id, f.org.id, x.registration);
  const seen: BrainTurn[] = [];
  const native: Brain = {
    kind: "codex",
    async *run(turn) {
      seen.push(turn);
      yield { type: "done", text: (await turn.code)!.cwd };
    },
  };
  const guarded = paperclipProjectBrain(x.deps, native);
  const proxy = paperclipProjectHub(x.deps);
  for (let i = 0; i < 7; i++) {
    const r = await running(x, i);
    const ctx = await paperclipProjectRun(x.deps, f.org.id, r.runId);
    expect(ctx?.binding.id).toBe(x.registration.id);
    const turn: BrainTurn = {
      runId: r.runId,
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: uid(),
      threadRootId: null,
      system: "",
      messages: [],
      tools: [],
      model: "model-a",
      trigger: "fixture",
      session: { id: uid(), resume: true, machineId: x.registration.machineId, cwd: "/wrong" },
    };
    const events = await Array.fromAsync(
      guarded.run(turn, { signal: new AbortController().signal, executeTool: async () => ({ content: "unused" }) }),
    );
    expect(events[0]).toMatchObject({ type: "done", text: x.registration.targetCwd });
    const actual = seen.at(-1)!;
    expect(actual.session).toMatchObject({ resume: false, cwd: x.registration.targetCwd });
    expect(actual.session!.id).not.toBe(turn.session!.id);
    const result = await proxy.call(x.registration.machineId, {
      op: "brain.turn",
      runId: r.runId,
      agent: { id: f.agent.id, handle: f.agent.handle },
      kind: "codex",
      model: "model-a",
      system: "",
      prompt: "fixture",
      mcp: { token: "synthetic" },
      session: { id: actual.session!.id, resume: false },
      cwd: x.registration.targetCwd,
      keepAlive: false,
    });
    expect(result.final).toMatchObject({ type: "done", text: x.registration.targetCwd });
    const fallback: Brain = {
      kind: "model",
      async *run() {
        yield { type: "error", code: "must_not_execute", message: "must not execute", retryable: true };
      },
    };
    const denied = await Array.fromAsync(
      paperclipProjectBrain(x.deps, fallback).run(turn, {
        signal: new AbortController().signal,
        executeTool: async () => ({ content: "unused" }),
      }),
    );
    expect(denied[0]).toMatchObject({ type: "error", retryable: false });
    if (i === 0) {
      const lost: Brain = {
        kind: "codex",
        async *run() {
          yield {
            type: "error",
            code: "machine_offline",
            message: "unknown delivery",
            retryable: true,
            serverStop: true,
          };
        },
      };
      const failed = await Array.fromAsync(
        paperclipProjectBrain(x.deps, lost).run(turn, {
          signal: new AbortController().signal,
          executeTool: async () => ({ content: "unused" }),
        }),
      );
      expect(failed[0]).toMatchObject({
        type: "error",
        code: "paperclip_workspace_turn_failed",
        retryable: false,
        serverStop: false,
      });
    }
    await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, r.runId));
  }
  expect(seen).toHaveLength(7);
  expect(x.calls.filter((c) => c === "paperclip.brain.turn")).toHaveLength(7);
});
test("revoked binding, changed source mapping, issue reassignment and model drift stop before any native turn", async () => {
  const x = await fixture();
  await registerPaperclipWorkspace(x.deps, f.owner.id, f.org.id, x.registration);
  const r = await running(x);
  const proxy = paperclipProjectHub(x.deps);
  const request = {
    op: "brain.turn" as const,
    runId: r.runId,
    kind: "codex" as const,
    model: "model-a",
    system: "",
    prompt: "",
    mcp: { token: "synthetic" },
    session: { id: uid(), resume: false },
    cwd: x.registration.targetCwd,
    keepAlive: false,
  };
  await expect(proxy.call(x.registration.machineId, request)).rejects.toThrow();
  await expect(
    proxy.call(x.registration.machineId, { ...request, agent: { id: uid(), handle: "wrong" } }),
  ).rejects.toThrow();
  await f.db
    .update(schema.paperclipRoutineMappings)
    .set({ definition: { ...r.mapping.definition, projectWorkspaceId: uid() } })
    .where(eq(schema.paperclipRoutineMappings.id, r.mapping.id));
  await expect(paperclipProjectRun(x.deps, f.org.id, r.runId)).rejects.toThrow();
  await f.db
    .update(schema.paperclipRoutineMappings)
    .set({ definition: r.mapping.definition })
    .where(eq(schema.paperclipRoutineMappings.id, r.mapping.id));
  await f.db.update(schema.agents).set({ brainModel: "different" }).where(eq(schema.agents.id, f.agent.id));
  await expect(paperclipProjectRun(x.deps, f.org.id, r.runId)).rejects.toThrow();
  await f.db.update(schema.agents).set({ brainModel: "model-a" }).where(eq(schema.agents.id, f.agent.id));
  await f.db.update(schema.issues).set({ status: "canceled" }).where(eq(schema.issues.id, r.receipt.issueId!));
  await expect(paperclipProjectRun(x.deps, f.org.id, r.runId)).rejects.toThrow();
  await f.db.update(schema.issues).set({ status: "todo" }).where(eq(schema.issues.id, r.receipt.issueId!));
  await disablePaperclipWorkspace(x.deps, f.owner.id, f.org.id, x.registration.id);
  await expect(paperclipProjectRun(x.deps, f.org.id, r.runId)).rejects.toThrow();
  expect(x.calls.filter((c) => c === "paperclip.brain.turn")).toHaveLength(0);
});
