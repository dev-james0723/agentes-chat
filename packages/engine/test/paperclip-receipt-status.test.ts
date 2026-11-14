import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { paperclipReceiptExecutionStatus } from "../src/paperclip-receipt-status";
import {
  createPaperclipMapping,
  dispatchPaperclipRoutine,
  setPaperclipDynamicWorkspaceScope,
  setPaperclipMappingEnabled,
} from "../src/paperclip-routines";
import { disablePaperclipWorkspace } from "../src/paperclip-workspaces";
import { executeRoutineRun, setRoutineActive } from "../src/routines";
import { type Fixture, setup } from "./fixtures";
import { routineDeps } from "./routine-fixtures";

let f: Fixture;
afterEach(async () => f?.close());
const uid = () => crypto.randomUUID();
function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected fixture value");
  return value;
}
type Receipt = typeof schema.paperclipRoutineReceipts.$inferSelect;
async function fixture(policy: "always_enqueue" | "coalesce_if_active" | "skip_if_active" = "always_enqueue") {
  f = await setup();
  const deps = { ...routineDeps(f), enabled: true };
  const company = uid(),
    trigger = uid();
  const mapping = await createPaperclipMapping(deps, f.owner.id, f.org.id, {
    sourceCompanyId: company,
    sourceRoutineId: uid(),
    sourceRevisionId: "fixture-revision",
    sourceActive: true,
    activityGatePolicy: "always",
    activityGateScope: "company",
    catchUpPolicy: "skip_missed",
    triggers: [{ id: trigger, kind: "api", enabled: true }],
    policy,
    agentId: f.agent.id,
    sourceAgentId: uid(),
    title: "Review local evidence",
    description: "PRIVATE_TASK_CONTENT_NOT_IN_STATUS",
  });
  const activate = async (m = mapping) => {
    await setRoutineActive(routineDeps(f), f.owner.id, f.org.id, m.routineId, true);
    return setPaperclipMappingEnabled(deps, f.owner.id, f.org.id, m.id, m.configHash, true);
  };
  const invoke = (m: typeof mapping, key: string, extra: Record<string, unknown> = {}) =>
    dispatchPaperclipRoutine(deps, f.owner.id, f.org.id, m.id, {
      source: "api",
      triggerId: trigger,
      expectedConfigHash: m.configHash,
      idempotencyKey: key,
      ...extra,
    });
  const read = async (r: Receipt) => {
    const m = present(
      (
        await f.db
          .select()
          .from(schema.paperclipRoutineMappings)
          .where(eq(schema.paperclipRoutineMappings.id, mapping.id))
      )[0],
    );
    const native = present(
      (await f.db.select().from(schema.routines).where(eq(schema.routines.id, mapping.routineId)))[0],
    );
    return f.db.transaction((tx) => paperclipReceiptExecutionStatus(tx, m, native, r.id));
  };
  return { deps, company, trigger, mapping, activate, invoke, read };
}
async function persistedRows() {
  return {
    receipts: await f.db.select().from(schema.paperclipRoutineReceipts),
    issues: await f.db.select().from(schema.issues),
    runs: await f.db.select().from(schema.routineRuns),
    workers: await f.db.select().from(schema.agentRuns),
    jobs: await f.db.select().from(schema.outbox),
    hooks: await f.db.select().from(schema.routineHookCalls),
  };
}
async function start(r: Receipt) {
  await executeRoutineRun({ ...routineDeps(f), paperclipCompatibilityEnabled: true }, present(r.routineRunId));
  const firing = present(
    (
      await f.db
        .select()
        .from(schema.routineRuns)
        .where(eq(schema.routineRuns.id, present(r.routineRunId)))
    )[0],
  );
  return { firing, workerId: present(firing.agentRunId) };
}
function noExecutionIds(observed: Awaited<ReturnType<typeof paperclipReceiptExecutionStatus>>) {
  expect(observed).toMatchObject({
    issueId: null,
    routineRunId: null,
    executionReceiptId: null,
    routineStatus: null,
    agentStatus: null,
    issueStatus: null,
    evidenceQualified: false,
  });
}

test("queued, waiting, failed and finished native states are read-only observations with no qualified result", async () => {
  const x = await fixture(),
    m = await x.activate(),
    r = await x.invoke(m, "native-states");
  let before = await persistedRows();
  expect(await x.read(r)).toMatchObject({ observation: "linked", routineStatus: "queued", agentStatus: null });
  expect(await persistedRows()).toEqual(before);
  const { workerId } = await start(r);
  for (const status of [
    "queued",
    "running",
    "waiting_input",
    "waiting_approval",
    "failed",
    "canceled",
    "done",
  ] as const) {
    await f.db.update(schema.agentRuns).set({ status }).where(eq(schema.agentRuns.id, workerId));
    before = await persistedRows();
    const observed = await x.read(r);
    expect(observed).toMatchObject({
      observation: "linked",
      issueId: r.issueId,
      routineRunId: r.routineRunId,
      executionReceiptId: r.id,
      routineStatus: "started",
      agentStatus: status,
      evidenceQualified: false,
    });
    expect(await persistedRows()).toEqual(before);
  }
  await f.db
    .update(schema.routineRuns)
    .set({ status: "reported" })
    .where(eq(schema.routineRuns.id, present(r.routineRunId)));
  await f.db
    .update(schema.issues)
    .set({ status: "done" })
    .where(eq(schema.issues.id, present(r.issueId)));
  const completed = await x.read(r);
  expect(completed).toMatchObject({
    routineStatus: "reported",
    agentStatus: "done",
    issueStatus: "done",
    evidenceQualified: false,
  });
  expect(completed).not.toHaveProperty("outcome");
  expect(completed).not.toHaveProperty("continuation");
  expect(JSON.stringify(completed)).not.toContain("PRIVATE_TASK_CONTENT_NOT_IN_STATUS");
});

test("coalesced receipts follow only their original queued execution and retain their own admission identity", async () => {
  const x = await fixture("coalesce_if_active"),
    m = await x.activate(),
    a = await x.invoke(m, "original"),
    b = await x.invoke(m, "coalesced");
  expect(b.status).toBe("coalesced");
  expect(await x.read(b)).toMatchObject({
    receiptId: b.id,
    issueId: a.issueId,
    executionReceiptId: a.id,
    sharedExecution: true,
    routineRunId: a.routineRunId,
    observation: "linked",
    routineStatus: "queued",
    evidenceQualified: false,
  });
  await f.db
    .update(schema.paperclipRoutineReceipts)
    .set({ dispatchFingerprint: "f".repeat(64) })
    .where(eq(schema.paperclipRoutineReceipts.id, b.id));
  expect(await x.read(b)).toMatchObject({ observation: "held", reason: "execution_link_changed", routineStatus: null });
});

test("skipped admissions never present the active worker's completion as their execution", async () => {
  const x = await fixture("skip_if_active"),
    m = await x.activate(),
    a = await x.invoke(m, "original"),
    skipped = await x.invoke(m, "skipped");
  const { workerId } = await start(a);
  await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, workerId));
  await f.db
    .update(schema.routineRuns)
    .set({ status: "reported" })
    .where(eq(schema.routineRuns.id, present(a.routineRunId)));
  await f.db
    .update(schema.issues)
    .set({ status: "done" })
    .where(eq(schema.issues.id, present(a.issueId)));
  expect(await x.read(skipped)).toMatchObject({
    admissionStatus: "skipped",
    observation: "not_started",
    reason: "admission_skipped",
    executionReceiptId: null,
    routineStatus: null,
    agentStatus: null,
    issueStatus: null,
    evidenceQualified: false,
  });
  noExecutionIds(await x.read(skipped));
});

test("deferral status follows the atomically replaced receipt pointer without selecting a recent unrelated run", async () => {
  const x = await fixture(),
    m = await x.activate(),
    a = await x.invoke(m, "first"),
    b = await x.invoke(m, "second", { payload: { task: 2 } });
  await start(a);
  await executeRoutineRun({ ...routineDeps(f), paperclipCompatibilityEnabled: true }, present(b.routineRunId));
  const moved = present(
    (await f.db.select().from(schema.paperclipRoutineReceipts).where(eq(schema.paperclipRoutineReceipts.id, b.id)))[0],
  );
  expect(moved.routineRunId).not.toBe(b.routineRunId);
  expect(await x.read(b)).toMatchObject({
    receiptId: b.id,
    routineRunId: moved.routineRunId,
    executionReceiptId: b.id,
    observation: "linked",
    routineStatus: "queued",
    agentStatus: null,
  });
});

test("coalesced receipts keep sharing their canonical execution when native deferral replaces both pointers", async () => {
  const x = await fixture("coalesce_if_active"),
    m = await x.activate();
  const first = await x.invoke(m, "active", { payload: { task: 1 } });
  const queued = await x.invoke(m, "queued", { payload: { task: 2 } });
  const coalesced = await x.invoke(m, "coalesced", { payload: { task: 2 } });
  await start(first);
  await executeRoutineRun({ ...routineDeps(f), paperclipCompatibilityEnabled: true }, present(queued.routineRunId));
  const status = await x.read(coalesced);
  expect(status).toMatchObject({
    receiptId: coalesced.id,
    executionReceiptId: queued.id,
    sharedExecution: true,
    observation: "linked",
    routineStatus: "queued",
    agentStatus: null,
  });
  expect(status?.routineRunId).not.toBe(queued.routineRunId);
  expect(status?.routineRunId).not.toBe(first.routineRunId);
});

test("missing, cross-org and unrelated execution pointers withhold state and foreign identifiers", async () => {
  const x = await fixture(),
    m = await x.activate(),
    a = await x.invoke(m, "own"),
    b = await x.invoke(m, "other", { payload: { task: 2 } });
  const original = present(
    (
      await f.db
        .select()
        .from(schema.routineRuns)
        .where(eq(schema.routineRuns.id, present(a.routineRunId)))
    )[0],
  );
  const event = present(original.event);
  await f.db
    .update(schema.routineRuns)
    .set({ event: { ...event, receiptId: b.id } })
    .where(eq(schema.routineRuns.id, original.id));
  expect(await x.read(a)).toMatchObject({ observation: "held", reason: "execution_link_changed", agentStatus: null });
  await f.db.update(schema.routineRuns).set({ event }).where(eq(schema.routineRuns.id, original.id));
  await f.db
    .update(schema.paperclipRoutineReceipts)
    .set({ issueId: b.issueId })
    .where(eq(schema.paperclipRoutineReceipts.id, a.id));
  expect(await x.read(a)).toMatchObject({ observation: "held", reason: "execution_link_changed", issueStatus: null });
  await f.db
    .update(schema.paperclipRoutineReceipts)
    .set({ issueId: a.issueId })
    .where(eq(schema.paperclipRoutineReceipts.id, a.id));
  const otherOrg = uid();
  await f.db.insert(schema.organizations).values({ id: otherOrg, name: "Other tenant" });
  await f.db.update(schema.routineRuns).set({ orgId: otherOrg }).where(eq(schema.routineRuns.id, original.id));
  const foreign = await x.read(a);
  expect(foreign).toMatchObject({ observation: "held", routineRunId: null, routineStatus: null, agentStatus: null });
  expect(JSON.stringify(foreign)).not.toContain(original.id);
  await f.db
    .update(schema.routineRuns)
    .set({ orgId: f.org.id, status: "unrecognized-native-state" })
    .where(eq(schema.routineRuns.id, original.id));
  expect(await x.read(a)).toMatchObject({
    observation: "held",
    reason: "execution_state_unknown",
    routineStatus: null,
  });
});

test("wrong agent runs or non-background turns cannot become receipt execution observations", async () => {
  const x = await fixture(),
    m = await x.activate(),
    r = await x.invoke(m, "worker-identity");
  const { workerId } = await start(r);
  await f.db.update(schema.agentRuns).set({ background: false }).where(eq(schema.agentRuns.id, workerId));
  expect(await x.read(r)).toMatchObject({ observation: "held", reason: "execution_link_changed", agentStatus: null });
  const otherAgent = { ...f.agent, id: uid(), name: "Other fixture agent", handle: "other-status-agent" };
  await f.db.insert(schema.agents).values(otherAgent);
  await f.db
    .update(schema.agentRuns)
    .set({ background: true, agentId: otherAgent.id })
    .where(eq(schema.agentRuns.id, workerId));
  expect(await x.read(r)).toMatchObject({ observation: "held", agentStatus: null });
});

test("held same-tenant cross-mapping and sibling-run pointers expose none of the unrelated execution IDs", async () => {
  const x = await fixture(),
    m = await x.activate(),
    own = await x.invoke(m, "own");
  const other = await createPaperclipMapping(x.deps, f.owner.id, f.org.id, {
    sourceCompanyId: uid(),
    sourceRoutineId: uid(),
    sourceRevisionId: "other-revision",
    sourceActive: true,
    activityGatePolicy: "always",
    activityGateScope: "company",
    catchUpPolicy: "skip_missed",
    triggers: [{ id: x.trigger, kind: "api", enabled: true }],
    policy: "always_enqueue",
    agentId: f.agent.id,
    sourceAgentId: uid(),
    title: "Other private mapping",
    description: "Other private work",
  });
  const otherEnabled = await x.activate(other),
    otherReceipt = await x.invoke(otherEnabled, "other");
  await f.db
    .update(schema.paperclipRoutineReceipts)
    .set({ issueId: otherReceipt.issueId })
    .where(eq(schema.paperclipRoutineReceipts.id, own.id));
  let before = await persistedRows();
  const mismatchedIssue = await x.read(own);
  noExecutionIds(mismatchedIssue);
  expect(mismatchedIssue).toMatchObject({
    observation: "held",
    reason: "execution_link_changed",
    receiptId: own.id,
    mappingId: m.id,
    acceptedConfigHash: m.configHash,
  });
  expect(JSON.stringify(mismatchedIssue)).not.toContain(present(otherReceipt.issueId));
  expect(await persistedRows()).toEqual(before);
  const sibling = await x.invoke(m, "sibling", { payload: { task: 2 } });
  await f.db
    .update(schema.paperclipRoutineReceipts)
    .set({ issueId: own.issueId, routineRunId: sibling.routineRunId })
    .where(eq(schema.paperclipRoutineReceipts.id, own.id));
  before = await persistedRows();
  const mismatchedRun = await x.read(own);
  noExecutionIds(mismatchedRun);
  expect(JSON.stringify(mismatchedRun)).not.toContain(present(sibling.routineRunId));
  expect(JSON.stringify(mismatchedRun)).not.toContain(sibling.id);
  expect(await persistedRows()).toEqual(before);
});

for (const missing of ["issue", "firing", "worker"] as const) {
  test(`a missing ${missing} withholds even the otherwise valid execution identifiers`, async () => {
    const x = await fixture(),
      m = await x.activate(),
      r = await x.invoke(m, "missing");
    if (missing === "issue") await f.db.delete(schema.issues).where(eq(schema.issues.id, present(r.issueId)));
    if (missing === "firing")
      await f.db.delete(schema.routineRuns).where(eq(schema.routineRuns.id, present(r.routineRunId)));
    if (missing === "worker") {
      const { workerId } = await start(r);
      await f.db.delete(schema.agentRuns).where(eq(schema.agentRuns.id, workerId));
    }
    const before = await persistedRows(),
      observed = await x.read(r);
    noExecutionIds(observed);
    expect(observed).toMatchObject({
      observation: "held",
      reason: "execution_link_changed",
      receiptId: r.id,
      configHash: m.configHash,
    });
    expect(await persistedRows()).toEqual(before);
  });
}

test("a missing canonical admission cannot disclose its coalesced execution pointers", async () => {
  const x = await fixture("coalesce_if_active"),
    m = await x.activate(),
    original = await x.invoke(m, "canonical"),
    coalesced = await x.invoke(m, "coalesced");
  await f.db.delete(schema.paperclipRoutineReceipts).where(eq(schema.paperclipRoutineReceipts.id, original.id));
  const before = await persistedRows(),
    observed = await x.read(coalesced);
  noExecutionIds(observed);
  expect(observed).toMatchObject({
    observation: "held",
    reason: "execution_link_changed",
    receiptId: coalesced.id,
    sharedExecution: true,
  });
  expect(JSON.stringify(observed)).not.toContain(present(original.issueId));
  expect(JSON.stringify(observed)).not.toContain(present(original.routineRunId));
  expect(await persistedRows()).toEqual(before);
});

test("malformed stored scope and status values are withheld rather than returned as raw metadata", async () => {
  const x = await fixture(),
    m = await x.activate(),
    r = await x.invoke(m, "malformed-metadata");
  await f.db
    .update(schema.paperclipRoutineReceipts)
    .set({
      workspaceSelection: {
        bindingId: "/PRIVATE_PATH_NOT_IN_STATUS",
        sourceProjectId: { token: "PRIVATE_METADATA_NOT_IN_STATUS" },
      } as unknown as NonNullable<Receipt["workspaceSelection"]>,
    })
    .where(eq(schema.paperclipRoutineReceipts.id, r.id));
  const malformed = await x.read(r);
  expect(malformed).toMatchObject({ observation: "held", workspace: null, routineStatus: null });
  expect(JSON.stringify(malformed)).not.toContain("PRIVATE_");
  await f.db
    .update(schema.paperclipRoutineReceipts)
    .set({ workspaceSelection: null, status: "PRIVATE_STATE_NOT_IN_STATUS" as Receipt["status"] })
    .where(eq(schema.paperclipRoutineReceipts.id, r.id));
  const unknown = await x.read(r);
  expect(unknown).toMatchObject({ observation: "held", admissionStatus: null, reason: "admission_state_unknown" });
  expect(JSON.stringify(unknown)).not.toContain("PRIVATE_");
});

test("legacy unknown admission and later configuration changes never relabel accepted history", async () => {
  const x = await fixture(),
    m = await x.activate(),
    r = await x.invoke(m, "history");
  const changed = "c".repeat(64);
  await f.db
    .update(schema.paperclipRoutineMappings)
    .set({ configHash: changed })
    .where(eq(schema.paperclipRoutineMappings.id, m.id));
  expect(await x.read(r)).toMatchObject({
    configHash: m.configHash,
    acceptedConfigHash: m.configHash,
    currentConfigHash: changed,
    observation: "held",
    reason: "configuration_changed",
    routineStatus: null,
    evidenceQualified: false,
  });
  noExecutionIds(await x.read(r));
  await f.db
    .update(schema.paperclipRoutineReceipts)
    .set({ acceptedConfigHash: null })
    .where(eq(schema.paperclipRoutineReceipts.id, r.id));
  const before = await persistedRows();
  expect(await x.read(r)).toMatchObject({
    configHash: null,
    acceptedConfigHash: null,
    currentConfigHash: changed,
    admissionConfigStatus: "unknown_legacy",
    observation: "unknown_legacy",
    routineStatus: null,
  });
  noExecutionIds(await x.read(r));
  expect(await persistedRows()).toEqual(before);
});

test("an immutable selected workspace is observed without host paths and revocation withholds execution state", async () => {
  const x = await fixture(),
    machineId = uid();
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
  const binding = {
    id: uid(),
    orgId: f.org.id,
    ownerId: f.owner.id,
    machineId,
    generation: uid(),
    sourceCompanyId: x.company,
    sourceProjectId: uid(),
    sourceWorkspaceId: uid(),
    projectDigest: "a".repeat(64),
    snapshotDigest: "b".repeat(64),
    bindingDigest: "c".repeat(64),
    targetCwd: "/PRIVATE_HOST_PATH_NOT_IN_STATUS",
    agents: [{ id: f.agent.id, ownerId: f.owner.id, brain: "codex" as const, model: "fixture-model", accountId: null }],
  };
  await f.db.insert(schema.paperclipWorkspaceBindings).values(binding);
  const configured = await setPaperclipDynamicWorkspaceScope(x.deps, f.owner.id, f.org.id, x.mapping.id, {
    expectedConfigHash: x.mapping.configHash,
    bindingIds: [binding.id],
  });
  const m = await x.activate(configured),
    r = await x.invoke(m, "workspace", {
      workspace: {
        bindingId: binding.id,
        projectId: binding.sourceProjectId,
        projectWorkspaceId: binding.sourceWorkspaceId,
      },
    });
  const observed = await x.read(r);
  expect(observed).toMatchObject({
    observation: "linked",
    scopeQualification: "qualified",
    workspace: { bindingId: binding.id, generation: binding.generation, bindingDigest: binding.bindingDigest },
  });
  expect(JSON.stringify(observed)).not.toContain(binding.targetCwd);
  expect(observed?.workspace).not.toHaveProperty("machineId");
  expect(observed?.workspace).not.toHaveProperty("agent");
  await f.db
    .update(schema.paperclipRoutineReceipts)
    .set({ workspaceSelection: null })
    .where(eq(schema.paperclipRoutineReceipts.id, r.id));
  expect(await x.read(r)).toMatchObject({
    observation: "held",
    reason: "accepted_workspace_unknown",
    routineStatus: null,
  });
  await f.db
    .update(schema.paperclipRoutineReceipts)
    .set({ workspaceSelection: r.workspaceSelection })
    .where(eq(schema.paperclipRoutineReceipts.id, r.id));
  await f.db.update(schema.agents).set({ brainModel: "changed-model" }).where(eq(schema.agents.id, f.agent.id));
  expect(await x.read(r)).toMatchObject({ observation: "held", scopeQualification: "changed", routineStatus: null });
  await f.db.update(schema.agents).set({ brainModel: "fixture-model" }).where(eq(schema.agents.id, f.agent.id));
  await disablePaperclipWorkspace(x.deps, f.owner.id, f.org.id, binding.id);
  expect(await x.read(r)).toMatchObject({
    observation: "held",
    scopeQualification: "changed",
    reason: "workspace_changed",
    routineStatus: null,
    agentStatus: null,
    evidenceQualified: false,
  });
});
