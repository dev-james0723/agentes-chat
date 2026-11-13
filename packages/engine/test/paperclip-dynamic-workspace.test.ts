import { afterEach, expect, test } from "bun:test";
import type { MachineRequest } from "@agenteschat/adapters/machine-protocol";
import { eq, schema } from "@agenteschat/db";
import type { Brain, BrainTurn } from "../src/brains/types";
import { openDm } from "../src/dms";
import type { MachineCaller } from "../src/machine-hub";
import { paperclipProjectBrain, paperclipProjectHub, paperclipProjectRun } from "../src/paperclip-project-runtime";
import { nativeHash, paperclipRunRefusal } from "../src/paperclip-routine-state";
import {
  createPaperclipMapping,
  dispatchPaperclipRoutine,
  findPaperclipInvocation,
  paperclipInvocationSchema,
  preparePaperclipMapping,
  setPaperclipDynamicWorkspaceScope,
  setPaperclipMappingEnabled,
} from "../src/paperclip-routines";
import { disablePaperclipWorkspace } from "../src/paperclip-workspaces";
import { createRoutine, executeRoutineRun, setRoutineActive } from "../src/routines";
import { addMember, type Fixture, setup } from "./fixtures";
import { routineDeps } from "./routine-fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});
function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected fixture value");
  return value;
}
const uid = () => crypto.randomUUID();
async function fixture(policy: "always_enqueue" | "coalesce_if_active" | "skip_if_active" = "always_enqueue") {
  f = await setup();
  const machineId = uid(),
    companyId = uid(),
    triggerId = uid();
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
    .set({ ownerUserId: f.owner.id, machineId, brain: "codex", brainModel: "fixture-model", brainFallback: false })
    .where(eq(schema.agents.id, f.agent.id));
  const bindings = [0, 1].map((index) => ({
    id: uid(),
    orgId: f.org.id,
    ownerId: f.owner.id,
    machineId,
    generation: uid(),
    sourceCompanyId: companyId,
    sourceProjectId: uid(),
    sourceWorkspaceId: uid(),
    projectDigest: "a".repeat(64),
    snapshotDigest: "b".repeat(64),
    bindingDigest: String(index + 1).repeat(64),
    targetCwd: `/fixture/target-${index}`,
    agents: [{ id: f.agent.id, ownerId: f.owner.id, brain: "codex" as const, model: "fixture-model", accountId: null }],
  }));
  await f.db.insert(schema.paperclipWorkspaceBindings).values(bindings);
  const deps = { ...routineDeps(f), enabled: true };
  const mapping = await createPaperclipMapping(deps, f.owner.id, f.org.id, {
    sourceCompanyId: companyId,
    sourceRoutineId: uid(),
    sourceRevisionId: "fixture-revision",
    sourceActive: true,
    activityGatePolicy: "always",
    activityGateScope: "company",
    catchUpPolicy: "skip_missed",
    triggers: [{ id: triggerId, kind: "api", enabled: true }],
    policy,
    agentId: f.agent.id,
    sourceAgentId: uid(),
    title: "Review selected project",
    description: "Read only the selected target's evidence.",
  });
  const configure = (
    bindingIds = bindings.map((b) => b.id),
    expectedConfigHash = mapping.configHash,
    actor = f.owner.id,
  ) => setPaperclipDynamicWorkspaceScope(deps, actor, f.org.id, mapping.id, { expectedConfigHash, bindingIds });
  const scope = (index: number) => ({
    bindingId: present(bindings[index]).id,
    projectId: present(bindings[index]).sourceProjectId,
    projectWorkspaceId: present(bindings[index]).sourceWorkspaceId,
  });
  const activate = async () => {
    const configured = await configure();
    await setRoutineActive(routineDeps(f), f.owner.id, f.org.id, mapping.routineId, true);
    return setPaperclipMappingEnabled(deps, f.owner.id, f.org.id, mapping.id, configured.configHash, true);
  };
  const invoke = (m: typeof mapping, index: number, key?: string, extra: Record<string, unknown> = {}) =>
    dispatchPaperclipRoutine(deps, f.owner.id, f.org.id, m.id, {
      expectedConfigHash: m.configHash,
      source: "api",
      triggerId,
      workspace: scope(index),
      idempotencyKey: key,
      ...extra,
    });
  return { deps, machineId, companyId, triggerId, bindings, mapping, configure, scope, activate, invoke };
}

test("a dynamic invocation carries explicit opaque workspace identity, with no path or route override", () => {
  const input = {
    expectedConfigHash: "a".repeat(64),
    idempotencyKey: "fixture-delivery",
    workspace: {
      bindingId: crypto.randomUUID(),
      projectId: crypto.randomUUID(),
      projectWorkspaceId: crypto.randomUUID(),
    },
  };
  expect(paperclipInvocationSchema.safeParse(input).success).toBe(true);
  expect(
    paperclipInvocationSchema.safeParse({ ...input, workspace: { ...input.workspace, cwd: "/unreviewed" } }).success,
  ).toBe(false);
  expect(paperclipInvocationSchema.safeParse({ ...input, assigneeAgentId: crypto.randomUUID() }).success).toBe(false);
});

test("only an explicit owner CAS pins reviewed bindings, keeping mapping and routine inactive", async () => {
  const x = await fixture();
  expect(x.mapping.definition.workspaceScope).toBeUndefined();
  const admin = await addMember(f.db, f.org.id, "admin", "Scope manager");
  await expect(x.configure(undefined, undefined, admin.id)).rejects.toThrow();
  await expect(x.configure([uid()])).rejects.toThrow();
  await expect(x.configure([present(x.bindings[0]).id, present(x.bindings[0]).id])).rejects.toThrow();
  const configured = await x.configure();
  expect(configured.enabled).toBe(false);
  expect(configured.configHash).not.toBe(x.mapping.configHash);
  expect(configured.definition.workspaceScope?.bindings).toHaveLength(2);
  expect(JSON.stringify(configured.definition.workspaceScope)).not.toContain("/fixture/");
  await expect(x.configure()).rejects.toThrow("changed");
  expect(
    (await f.db.select().from(schema.routines).where(eq(schema.routines.id, x.mapping.routineId)))[0],
  ).toMatchObject({ active: false, nextRunAt: null });
  expect(await f.db.select().from(schema.paperclipRoutineReceipts)).toHaveLength(0);
  expect(await f.db.select().from(schema.routineRuns)).toHaveLength(0);
});

test("allowlist configuration and activation reject foreign company, revoked binding and route drift", async () => {
  const x = await fixture();
  const b = present(x.bindings[0]);
  const otherOrgId = uid(),
    otherMachineId = uid(),
    foreignId = uid();
  await f.db.insert(schema.organizations).values({ id: otherOrgId, name: "Foreign fixture" });
  await f.db.insert(schema.machines).values({
    id: otherMachineId,
    orgId: otherOrgId,
    name: "Foreign Mac",
    os: "darwin",
    pairedByUserId: f.owner.id,
    protocol: 66,
  });
  await f.db
    .insert(schema.paperclipWorkspaceBindings)
    .values({ ...b, id: foreignId, orgId: otherOrgId, machineId: otherMachineId });
  await expect(x.configure([foreignId])).rejects.toThrow();
  for (const patch of [
    { sourceCompanyId: uid() },
    { ownerId: (await addMember(f.db, f.org.id, "member")).id },
    { enabled: false },
    { agents: [] },
  ]) {
    await f.db
      .update(schema.paperclipWorkspaceBindings)
      .set(patch)
      .where(eq(schema.paperclipWorkspaceBindings.id, b.id));
    await expect(x.configure()).rejects.toThrow();
    await f.db
      .update(schema.paperclipWorkspaceBindings)
      .set({ ...b, enabled: true })
      .where(eq(schema.paperclipWorkspaceBindings.id, b.id));
  }
  const configured = await x.configure();
  await setRoutineActive(routineDeps(f), f.owner.id, f.org.id, x.mapping.routineId, true);
  await f.db.update(schema.agents).set({ brainModel: "different-model" }).where(eq(schema.agents.id, f.agent.id));
  await expect(
    setPaperclipMappingEnabled(x.deps, f.owner.id, f.org.id, x.mapping.id, configured.configHash, true),
  ).rejects.toThrow();
  expect(await f.db.select().from(schema.paperclipRoutineReceipts)).toHaveLength(0);
});

test("dynamic invocation cannot infer authority from payload, omit selection or select an unreviewed identity", async () => {
  const x = await fixture();
  const m = await x.activate();
  for (const workspace of [
    undefined,
    { ...x.scope(0), bindingId: uid() },
    { ...x.scope(0), projectId: uid() },
    { ...x.scope(0), projectWorkspaceId: uid() },
    { ...x.scope(0), targetCwd: "/other" },
  ])
    await expect(
      x.invoke(m, 0, undefined, {
        workspace,
        payload: { workspace: x.scope(0), cwd: present(x.bindings[0]).targetCwd },
      }),
    ).rejects.toThrow();
  expect(await f.db.select().from(schema.paperclipRoutineReceipts)).toHaveLength(0);
  expect(await f.db.select().from(schema.issues)).toHaveLength(0);
  const accepted = await x.invoke(m, 0, "accepted", { payload: { workspace: x.scope(1), cwd: "/untrusted" } });
  expect(accepted.workspaceSelection).toMatchObject({
    bindingId: present(x.bindings[0]).id,
    generation: present(x.bindings[0]).generation,
  });
});

for (const policy of ["coalesce_if_active", "skip_if_active"] as const) {
  test(`${policy} compares the immutable workspace selection and never reuses another project's task`, async () => {
    const x = await fixture(policy),
      m = await x.activate();
    const first = await x.invoke(m, 0, "a");
    const other = await x.invoke(m, 1, "b");
    const same = await x.invoke(m, 0, "c");
    expect(first.status).toBe("queued");
    expect(other.status).toBe("queued");
    expect(other.issueId).not.toBe(first.issueId);
    expect(other.dispatchFingerprint).not.toBe(first.dispatchFingerprint);
    expect(same.issueId).toBe(first.issueId);
    expect(same.status).toBe(policy === "coalesce_if_active" ? "coalesced" : "skipped");
    expect(same.workspaceSelection).toEqual(first.workspaceSelection);
    expect(await f.db.select().from(schema.routineRuns)).toHaveLength(2);
  });
}

test("keyed replay preserves its choice while admitted; revoked/paused dispatch refuses and read-only lookup reconciles", async () => {
  const x = await fixture(),
    m = await x.activate();
  const first = await x.invoke(m, 0, "durable");
  const replay = await x.invoke(m, 1, "durable");
  expect(replay).toEqual(first);
  await expect(x.invoke(m, 0, "durable", { expectedConfigHash: "f".repeat(64) })).rejects.toThrow("changed");
  await f.db
    .update(schema.paperclipRoutineMappings)
    .set({ sourceActive: false })
    .where(eq(schema.paperclipRoutineMappings.id, m.id));
  await expect(x.invoke(m, 0, "durable")).rejects.toThrow("not active");
  await f.db
    .update(schema.paperclipRoutineMappings)
    .set({ sourceActive: true })
    .where(eq(schema.paperclipRoutineMappings.id, m.id));
  await setRoutineActive(routineDeps(f), f.owner.id, f.org.id, m.routineId, false);
  await expect(x.invoke(m, 0, "durable")).rejects.toThrow("paused");
  await setRoutineActive(routineDeps(f), f.owner.id, f.org.id, m.routineId, true);
  await disablePaperclipWorkspace(x.deps, f.owner.id, f.org.id, present(x.bindings[0]).id);
  await expect(x.invoke(m, 1, "durable")).rejects.toThrow();
  await setPaperclipMappingEnabled(x.deps, f.owner.id, f.org.id, m.id, m.configHash, false);
  await expect(x.invoke(m, 1, "durable", { expectedConfigHash: "f".repeat(64) })).rejects.toThrow("disabled");
  const found = await findPaperclipInvocation({ ...x.deps, enabled: false }, f.owner.id, f.org.id, m.id, {
    source: "api",
    triggerId: x.triggerId,
    idempotencyKey: "durable",
  });
  expect(found).toEqual(first);
  await expect(x.invoke(m, 1, "new")).rejects.toThrow("disabled");
  expect(await f.db.select().from(schema.routineRuns)).toHaveLength(1);
  expect(await f.db.select().from(schema.issues)).toHaveLength(1);
});

test("fixed mappings preserve nullable legacy receipts and reject per-invocation override", async () => {
  const x = await fixture(),
    b = present(x.bindings[0]);
  const fixed = await createPaperclipMapping(x.deps, f.owner.id, f.org.id, {
    sourceCompanyId: x.companyId,
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
    title: "Legacy fixed fixture",
    description: "Read only the assigned workspace.",
    projectId: b.sourceProjectId,
    projectWorkspaceId: b.sourceWorkspaceId,
    workspaceBindingId: b.id,
  });
  await expect(
    setPaperclipDynamicWorkspaceScope(x.deps, f.owner.id, f.org.id, fixed.id, {
      expectedConfigHash: fixed.configHash,
      bindingIds: [b.id],
    }),
  ).rejects.toThrow("fixed");
  await setRoutineActive(routineDeps(f), f.owner.id, f.org.id, fixed.routineId, true);
  await setPaperclipMappingEnabled(x.deps, f.owner.id, f.org.id, fixed.id, fixed.configHash, true);
  await expect(
    dispatchPaperclipRoutine(x.deps, f.owner.id, f.org.id, fixed.id, {
      expectedConfigHash: fixed.configHash,
      workspace: x.scope(0),
    }),
  ).rejects.toThrow();
  const receipt = await dispatchPaperclipRoutine(x.deps, f.owner.id, f.org.id, fixed.id, {
    expectedConfigHash: fixed.configHash,
  });
  expect(receipt.workspaceSelection?.bindingId).toBe(b.id);
  await f.db
    .update(schema.paperclipRoutineReceipts)
    .set({ workspaceSelection: null })
    .where(eq(schema.paperclipRoutineReceipts.id, receipt.id));
  await executeRoutineRun({ ...routineDeps(f), paperclipCompatibilityEnabled: true }, present(receipt.routineRunId));
  const [firing] = await f.db
    .select()
    .from(schema.routineRuns)
    .where(eq(schema.routineRuns.id, present(receipt.routineRunId)));
  expect(present(firing).agentRunId).toBeTruthy();
});

async function running(x: Awaited<ReturnType<typeof fixture>>) {
  const m = await x.activate(),
    receipt = await x.invoke(m, 0, "runtime");
  await executeRoutineRun({ ...routineDeps(f), paperclipCompatibilityEnabled: true }, present(receipt.routineRunId));
  const [firing] = await f.db
    .select()
    .from(schema.routineRuns)
    .where(eq(schema.routineRuns.id, present(receipt.routineRunId)));
  expect(present(firing).agentRunId).toBeTruthy();
  await f.db
    .update(schema.agentRuns)
    .set({ status: "running" })
    .where(eq(schema.agentRuns.id, present(present(firing).agentRunId)));
  return { m, receipt, firing: present(firing), runId: present(present(firing).agentRunId) };
}

test("native execution reads its receipt choice, starts a fresh cwd session and ignores event data overrides", async () => {
  const x = await fixture(),
    r = await running(x);
  await f.db
    .update(schema.routineRuns)
    .set({ event: { ...present(r.firing.event), data: { workspace: x.scope(1), cwd: "/untrusted" } } })
    .where(eq(schema.routineRuns.id, r.firing.id));
  const ctx = await paperclipProjectRun(x.deps, f.org.id, r.runId);
  expect(ctx?.binding.id).toBe(present(x.bindings[0]).id);
  const seen: BrainTurn[] = [];
  const brain: Brain = {
    kind: "codex",
    async *run(turn) {
      seen.push(turn);
      yield { type: "done", text: "fixture" };
    },
  };
  const turn: BrainTurn = {
    runId: r.runId,
    orgId: f.org.id,
    agentId: f.agent.id,
    channelId: uid(),
    threadRootId: null,
    system: "",
    messages: [],
    tools: [],
    model: "fixture-model",
    trigger: "fixture",
    session: { id: uid(), resume: true, machineId: x.machineId, cwd: "/untrusted" },
  };
  await Array.fromAsync(
    paperclipProjectBrain(x.deps, brain).run(turn, {
      signal: new AbortController().signal,
      executeTool: async () => ({ content: "unused" }),
    }),
  );
  expect(present(seen[0]).session).toMatchObject({ resume: false, cwd: present(x.bindings[0]).targetCwd });
  expect(present(present(seen[0]).session).id).not.toBe(present(turn.session).id);
  expect(present(await present(seen[0]).code).cwd).toBe(present(x.bindings[0]).targetCwd);
});

test("start and subsequent turns refuse lost receipt pins, changed generation/digests, route or native authority", async () => {
  const x = await fixture(),
    r = await running(x),
    b = present(x.bindings[0]);
  const [routine] = await f.db.select().from(schema.routines).where(eq(schema.routines.id, r.m.routineId));
  await f.db
    .update(schema.paperclipRoutineReceipts)
    .set({ workspaceSelection: null })
    .where(eq(schema.paperclipRoutineReceipts.id, r.receipt.id));
  expect(await paperclipRunRefusal(f.db, r.firing, present(routine), true)).toBe("paperclip_workspace_changed");
  await expect(paperclipProjectRun(x.deps, f.org.id, r.runId)).rejects.toThrow();
  await f.db
    .update(schema.paperclipRoutineReceipts)
    .set({ workspaceSelection: r.receipt.workspaceSelection })
    .where(eq(schema.paperclipRoutineReceipts.id, r.receipt.id));
  for (const patch of [
    { generation: uid() },
    { projectDigest: "f".repeat(64) },
    { snapshotDigest: "f".repeat(64) },
    { bindingDigest: "f".repeat(64) },
    { enabled: false },
  ]) {
    await f.db
      .update(schema.paperclipWorkspaceBindings)
      .set(patch)
      .where(eq(schema.paperclipWorkspaceBindings.id, b.id));
    expect(await paperclipRunRefusal(f.db, r.firing, present(routine), true)).toBe("paperclip_workspace_changed");
    await expect(paperclipProjectRun(x.deps, f.org.id, r.runId)).rejects.toThrow();
    await f.db
      .update(schema.paperclipWorkspaceBindings)
      .set({ ...b, enabled: true })
      .where(eq(schema.paperclipWorkspaceBindings.id, b.id));
  }
  const accountId = uid();
  await f.db
    .insert(schema.machineAccounts)
    .values({ id: accountId, orgId: f.org.id, machineId: x.machineId, kind: "codex", label: "Fixture route account" });
  await f.db.update(schema.agents).set({ brainAccountId: accountId }).where(eq(schema.agents.id, f.agent.id));
  await expect(paperclipProjectRun(x.deps, f.org.id, r.runId)).rejects.toThrow();
  const [currentReceipt] = await f.db.select().from(schema.paperclipRoutineReceipts);
  expect(present(currentReceipt).workspaceSelection).toEqual(r.receipt.workspaceSelection);
});

test("dynamic native transport attests the receipt-selected binding and rechecks revocation before dispatch", async () => {
  const x = await fixture(),
    r = await running(x),
    b = present(x.bindings[0]);
  let revokeAtAttestation = false;
  const calls: string[] = [];
  const hub = {
    status: async () => ({
      orgId: f.org.id,
      machineId: x.machineId,
      name: "Fixture Mac",
      pairedByUserId: f.owner.id,
      os: "darwin",
      protocol: 66,
      online: true,
      execAllowed: true,
      paused: null,
    }),
    call: async (_id: string, req: MachineRequest) => {
      calls.push(req.op);
      if (req.op === "paperclip.workspace.probe") return { version: 1, connectionId: uid() };
      if (req.op === "paperclip.workspace.attest") {
        expect(req.proof.bindingId).toBe(b.id);
        expect(req.proof.generation).toBe(b.generation);
        if (revokeAtAttestation) await disablePaperclipWorkspace(x.deps, f.owner.id, f.org.id, b.id);
        return { ...req.proof, targetCwd: b.targetCwd, bindingDigest: b.bindingDigest };
      }
      if (req.op === "paperclip.brain.turn") return { runId: req.runId, final: { type: "done", text: "fixture" } };
      throw new Error(`Unexpected fixture operation ${req.op}`);
    },
  } as unknown as Pick<MachineCaller, "call" | "status">;
  const proxy = paperclipProjectHub({ ...x.deps, hub });
  const request = {
    op: "brain.turn" as const,
    runId: r.runId,
    agent: { id: f.agent.id, handle: f.agent.handle },
    kind: "codex" as const,
    model: "fixture-model",
    system: "",
    prompt: "fixture",
    mcp: { token: "synthetic" },
    session: { id: uid(), resume: false },
    cwd: b.targetCwd,
    keepAlive: false,
  };
  await expect(proxy.call(x.machineId, { ...request, cwd: present(x.bindings[1]).targetCwd })).rejects.toThrow();
  const response = await proxy.call(x.machineId, request);
  expect(response.final).toMatchObject({ type: "done", text: "fixture" });
  revokeAtAttestation = true;
  await expect(proxy.call(x.machineId, request)).rejects.toThrow();
  expect(calls.filter((c) => c === "paperclip.brain.turn")).toHaveLength(1);
});

test("a queued/running receipt prevents scope reconfiguration; a later reviewed allowlist never retargets history", async () => {
  const x = await fixture(),
    r = await running(x);
  await setPaperclipMappingEnabled(x.deps, f.owner.id, f.org.id, r.m.id, r.m.configHash, false);
  // Model a paused definition while an earlier agent run is still draining.
  await f.db
    .update(schema.routines)
    .set({ active: false, nextRunAt: null })
    .where(eq(schema.routines.id, r.m.routineId));
  const change = { expectedConfigHash: r.m.configHash, bindingIds: [present(x.bindings[1]).id] };
  await expect(setPaperclipDynamicWorkspaceScope(x.deps, f.owner.id, f.org.id, r.m.id, change)).rejects.toThrow(
    "Reconcile",
  );
  await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, r.runId));
  await f.db.update(schema.routineRuns).set({ status: "reported" }).where(eq(schema.routineRuns.id, r.firing.id));
  const changed = await setPaperclipDynamicWorkspaceScope(x.deps, f.owner.id, f.org.id, r.m.id, change);
  expect(changed.definition.workspaceScope?.bindings.map((b) => b.bindingId)).toEqual([present(x.bindings[1]).id]);
  const old = await findPaperclipInvocation(x.deps, f.owner.id, f.org.id, r.m.id, {
    source: "api",
    triggerId: x.triggerId,
    idempotencyKey: "runtime",
  });
  expect(old?.workspaceSelection?.bindingId).toBe(present(x.bindings[0]).id);
  await setRoutineActive(routineDeps(f), f.owner.id, f.org.id, r.m.routineId, true);
  await setPaperclipMappingEnabled(x.deps, f.owner.id, f.org.id, r.m.id, changed.configHash, true);
  await expect(x.invoke(changed, 1, "runtime")).rejects.toThrow();
  expect(await f.db.select().from(schema.paperclipRoutineReceipts)).toHaveLength(1);
});

test("dynamic scope survives imported-template preparation and remains inactive until separate activation", async () => {
  const x = await fixture(),
    sourceId = uid(),
    description = "Exact original source requirement.";
  const native = await createRoutine(routineDeps(f), f.owner.id, f.org.id, {
    agentId: f.agent.id,
    name: "Imported dynamic",
    prompt: `[PC1:${sourceId}:${x.triggerId}]\n${description}`,
    target: { type: "dm" },
    trigger: { type: "event", event: "issue.created" },
    paused: true,
  });
  const [before] = await f.db.select().from(schema.routines).where(eq(schema.routines.id, native.id));
  const m = await createPaperclipMapping(x.deps, f.owner.id, f.org.id, {
    sourceCompanyId: x.companyId,
    sourceRoutineId: sourceId,
    sourceRevisionId: null,
    sourceActive: true,
    activityGatePolicy: "always",
    activityGateScope: "company",
    catchUpPolicy: "skip_missed",
    triggers: [{ id: x.triggerId, kind: "api", enabled: true }],
    policy: "always_enqueue",
    agentId: f.agent.id,
    sourceAgentId: uid(),
    title: "Imported dynamic",
    description,
    adopt: { routineId: native.id, expectedConfigHash: nativeHash(present(before)) },
  });
  const configured = await setPaperclipDynamicWorkspaceScope(x.deps, f.owner.id, f.org.id, m.id, {
    expectedConfigHash: m.configHash,
    bindingIds: [present(x.bindings[0]).id],
  });
  const prepared = await preparePaperclipMapping(x.deps, f.owner.id, f.org.id, m.id, {
    expectedConfigHash: configured.configHash,
    expectedNativeConfigHash: configured.nativeConfigHash,
  });
  expect(prepared.definition.executionContract).toBe("issue_reference_v1");
  expect(prepared.definition.workspaceScope).toEqual(configured.definition.workspaceScope);
  expect(prepared.enabled).toBe(false);
  expect(prepared.definition.preparedNative?.originalPrompt).toBe(present(before).prompt);
  expect((await f.db.select().from(schema.routines).where(eq(schema.routines.id, native.id)))[0]).toMatchObject({
    active: false,
    nextRunAt: null,
  });
  expect(await f.db.select().from(schema.paperclipRoutineReceipts)).toHaveLength(0);
});

test("revocation between early validation and the final native start transaction creates no agent run", async () => {
  const x = await fixture(),
    m = await x.activate(),
    receipt = await x.invoke(m, 0, "start-fence");
  await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
  let barrierPassed = false;
  const db = new Proxy(f.db, {
    get(target, property, receiver) {
      if (property === "transaction")
        return async (...args: Parameters<typeof f.db.transaction>) => {
          if (!barrierPassed) {
            barrierPassed = true;
            await disablePaperclipWorkspace(x.deps, f.owner.id, f.org.id, present(x.bindings[0]).id);
          }
          return target.transaction(...args);
        };
      return Reflect.get(target, property, receiver);
    },
  });
  await executeRoutineRun(
    { ...routineDeps(f), db, paperclipCompatibilityEnabled: true },
    present(receipt.routineRunId),
  );
  expect(barrierPassed).toBe(true);
  expect(await f.db.select().from(schema.agentRuns)).toHaveLength(0);
  expect(
    (
      await f.db
        .select()
        .from(schema.routineRuns)
        .where(eq(schema.routineRuns.id, present(receipt.routineRunId)))
    )[0],
  ).toMatchObject({ status: "skipped", code: "paperclip_workspace_changed" });
});
