import {
  FOUNDRY_PURE_TOOL_LIMITS,
  type FoundryExecutionRequest,
  type FoundryExecutionResult,
  type FoundryExecutor,
  type FoundryQualification,
  hashFoundryInput,
} from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import { grantScopes } from "../src";
import { createFoundryExecutionPolicy } from "../src/foundry/execution-policy";
import {
  createFoundryLifecycle,
  FOUNDRY_ACTIVATE_TOOL,
  type FoundryActivationInput,
  type FoundryEvaluationEvidence,
} from "../src/foundry/lifecycle";
import { freezePackage } from "../src/foundry/packages";
import { RECEIPT_INPUT_SCHEMA, RECEIPT_OUTPUT_SCHEMA } from "../src/foundry/receipt-contract";
import { createFoundryService } from "../src/foundry/service";
import { actionHash } from "../src/tools/gateway";
import type { ToolContext } from "../src/tools/types";
import type { Fixture } from "./fixtures";

// Native DB/blob/approval integration with SIMULATED external trusted services.
// Candidate files below are inert text. They are never imported or executed.
// Literal canned outputs are test oracles, not a receipt-normalizer implementation.
export const TEST_NOW = new Date("2026-11-16T12:00:00.000Z");
export const CANARY_INPUT = { records: [{ status: "unknown", tokens: 2, note: "synthetic canary" }] };
export const CANARY_OUTPUT = {
  total: 1,
  counts: { succeeded: 0, failed: 0, cancelled: 0, unknown: 1, unverified: 0 },
  tokens: 2,
};
export const FRESH_INPUT = {
  records: [
    { status: "succeeded", tokens: 3 },
    { status: "unverified", tokens: 7, note: "未驗證 🎹" },
  ],
};
export const FRESH_OUTPUT = {
  total: 2,
  counts: { succeeded: 1, failed: 0, cancelled: 0, unknown: 0, unverified: 1 },
  tokens: 10,
};
const WRONG_CANARY_OUTPUT = {
  total: 1,
  counts: { succeeded: 1, failed: 0, cancelled: 0, unknown: 0, unverified: 0 },
  tokens: 2,
};
const RUNTIME = "b".repeat(64);
const PROFILE = "c".repeat(64);
const SIMULATED_LIMITS = { ...FOUNDRY_PURE_TOOL_LIMITS, maxProcesses: 1 };
const EXPIRY = new Date(TEST_NOW.getTime() + 24 * 3600_000).toISOString();
const POSITIVE_TRIGGER = "Normalize synthetic task receipts using receipt-normalizer/v1.";

function bundle(version: string) {
  return freezePackage(
    JSON.stringify({
      schemaVersion: "1.0",
      name: "receipt-normalizer",
      version,
      kind: "pure_tool",
      description: "Aggregate synthetic task receipts while preserving unknown and unverified.",
      applicability: { useFor: ["Synthetic task receipts"], doNotUseFor: ["Expense receipts"] },
      scopeRequest: { level: "task", purpose: "Synthetic native lifecycle integration test" },
      effects: { network: "none", secrets: "none", filesystem: "none", externalActions: [], nestedCapabilities: [] },
      contracts: { input: RECEIPT_INPUT_SCHEMA, output: RECEIPT_OUTPUT_SCHEMA },
      dependencies: [],
      runtimeRequest: {
        profile: "pure-offline-v1",
        wallTimeMs: 10000,
        memoryMiB: 256,
        scratchMiB: 32,
        processes: 1,
        logBytesPerStream: 65536,
        inputBytes: 1048576,
        resultBytes: 1048576,
      },
      provenance: {
        origin: "generated",
        sourceRefs: ["synthetic-integration-fixture"],
        licenseDisposition: "original_internal",
        containsPrivateData: false,
      },
      developmentTests: ["development-fixtures.json"],
      rollback: { onFailure: "quarantine_and_revalidate_previous", previousNativeVersion: null },
    }),
    [
      {
        path: "candidate.txt",
        kind: "file",
        bytes: new TextEncoder().encode(`INERT candidate version ${version}; never executed.`),
      },
      { path: "development-fixtures.json", kind: "file", bytes: new TextEncoder().encode('{"synthetic":true}') },
    ],
  );
}

export async function createLifecycleWorld(f: Fixture) {
  await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: null, scope: "sandbox:run" }]);
  const [task] = await f.db
    .insert(schema.issues)
    .values({
      orgId: f.org.id,
      number: 9101,
      title: "Normalize synthetic task receipts",
      createdByType: "person",
      createdById: f.owner.id,
      assigneeType: "agent",
      assigneeId: f.agent.id,
      restricted: true,
      audienceUserIds: [f.owner.id],
    })
    .returning();
  if (!task) throw new Error("native task fixture");

  async function session(body = POSITIVE_TRIGGER, taskId = task!.id): Promise<ToolContext> {
    const [message] = await f.db
      .insert(schema.messages)
      .values({
        orgId: f.org.id,
        channelId: f.general.id,
        authorType: "person",
        authorUserId: f.owner.id,
        body,
      })
      .returning();
    const [run] = await f.db
      .insert(schema.agentRuns)
      .values({
        orgId: f.org.id,
        agentId: f.agent.id,
        channelId: f.general.id,
        threadRootId: message!.id,
        triggerMessageId: message!.id,
        trigger: "mention",
        hop: 1,
        status: "running",
        brain: "model",
        issueId: taskId,
      })
      .returning();
    return {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: run!.id,
      channelId: f.general.id,
      threadRootId: message!.id,
      triggerMessageId: message!.id,
      toolUseId: crypto.randomUUID(),
    };
  }
  const ctx = await session();
  const state = {
    now: new Date(TEST_NOW.getTime()),
    qualified: true,
    mode: "normal" as "normal" | "wrong-output" | "unknown",
    executions: [] as FoundryExecutionRequest[],
    beforeExecute: null as ((request: FoundryExecutionRequest) => Promise<void>) | null,
    evaluations: 0,
    cancellations: 0,
    reconciliations: 0,
    evidence: new Map<string, FoundryEvaluationEvidence>(),
    reconciliation: null as FoundryExecutionResult | null,
  };
  const qualification: FoundryQualification = {
    qualified: true,
    runnerId: "simulation-runner",
    profileRef: "simulation-profile",
    runtimeDigest: RUNTIME,
    profileDigest: PROFILE,
    configurationDigest: "d".repeat(64),
    attestationRef: "simulation-qualification",
    expiresAt: EXPIRY,
    testedAt: new Date(TEST_NOW.getTime() - 60_000).toISOString(),
    evidenceRefs: ["simulation-probe-receipts"],
    limits: { ...SIMULATED_LIMITS },
  };
  const cannedOutputs = new Map<string, unknown>([
    [hashFoundryInput(CANARY_INPUT), CANARY_OUTPUT],
    [hashFoundryInput(FRESH_INPUT), FRESH_OUTPUT],
  ]);
  const executor: FoundryExecutor = {
    async qualify() {
      return state.qualified
        ? structuredClone(qualification)
        : {
            qualified: false,
            code: "BLOCKED_SANDBOX",
            reason: "Simulated profile became ineligible.",
          };
    },
    async evaluate(version, evaluatorJobRef) {
      state.evaluations++;
      return {
        orgId: version.orgId,
        digest: version.digest,
        evaluatorJobRef,
        evaluatorRef: "simulation-protected-evaluator",
        runtimeDigest: RUNTIME,
        profileDigest: PROFILE,
        qualificationRef: "simulation-qualification",
        effectiveLimits: { ...SIMULATED_LIMITS },
        outcome: "PASS",
        evidenceRefs: ["simulation-holdout"],
        receiptRef: `simulation-evaluation/${version.digest}`,
        processTreeTerminated: true,
      };
    },
    async execute(request) {
      state.executions.push(request);
      await state.beforeExecute?.(request);
      if (state.mode === "unknown")
        return {
          outcome: "UNKNOWN_OUTCOME",
          receiptRef: null,
          reconciliationRef: request.invocationId,
        };
      const expected = cannedOutputs.get(request.inputDigest);
      if (!expected) throw new Error("Unregistered simulation input; no candidate is executed.");
      const receiptRef = `simulation-execution/${request.invocationId}`;
      const result: FoundryExecutionResult = {
        outcome: "SUCCEEDED",
        output: structuredClone(state.mode === "wrong-output" ? WRONG_CANARY_OUTPUT : expected),
        receiptRef,
        receipt: {
          receiptRef,
          orgId: request.orgId,
          digest: request.digest,
          inputDigest: request.inputDigest,
          invocationId: request.invocationId,
          fencingToken: request.fencingToken,
          runnerId: "simulation-runner",
          runtimeDigest: RUNTIME,
          profileDigest: PROFILE,
          qualificationRef: "simulation-qualification",
          effectiveLimits: { ...SIMULATED_LIMITS },
          stdoutBytes: 0,
          stderrBytes: 0,
          processTreeTerminated: true,
        },
      };
      state.reconciliation = result;
      return result;
    },
    async cancelEvaluation(evaluatorJobRef) {
      return {
        outcome: "CANCELLED",
        evaluatorJobRef,
        receiptRef: "simulation-evaluation-stop",
        processTreeTerminated: true,
      };
    },
    async reconcileEvaluation(evaluatorJobRef) {
      return { outcome: "UNKNOWN_OUTCOME", evaluatorJobRef, receiptRef: null, reconciliationRef: evaluatorJobRef };
    },
    async cancel(invocationId, fencingToken) {
      state.cancellations++;
      return {
        outcome: "CANCELLED",
        invocationId,
        fencingToken,
        receiptRef: "simulation-stop",
        processTreeTerminated: true,
      };
    },
    async reconcile(invocationId) {
      state.reconciliations++;
      return (
        state.reconciliation ?? {
          outcome: "UNKNOWN_OUTCOME",
          receiptRef: null,
          reconciliationRef: invocationId,
        }
      );
    },
  };
  const evaluations = {
    async resolve(orgId: string, receiptRef: string) {
      return structuredClone(state.evidence.get(`${orgId}:${receiptRef}`) ?? null);
    },
  };
  const builderPolicy = createFoundryExecutionPolicy({
    pins: [],
    now: () => state.now.getTime(),
    readPin: async (context) => ({
      phaseRef: "SIMULATED-fixture-only",
      orgId: f.org.id,
      taskId: task.id,
      agentId: f.agent.id,
      runIds: [context.runId],
      expiresAt: EXPIRY,
    }),
    readRun: async (context, transaction = f.db) =>
      (await transaction.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, context.runId)))[0] ?? null,
    capabilities: async (context) => rawLifecycle.discover(context),
  });
  const makeLifecycle = (options: { unavailable?: boolean } = {}) =>
    createFoundryLifecycle({
      db: f.db,
      blobs: f.artifactDeps.blobs,
      executor: options.unavailable ? undefined : executor,
      evaluations,
      builderPolicy,
      now: () => new Date(state.now.getTime()),
    });
  const rawLifecycle = makeLifecycle();
  // Explicit simulated native inventory. This fixture makes no live reuse claim.
  const service = createFoundryService({ db: f.db, blobs: f.artifactDeps.blobs, nativeReuse: async () => null });
  async function checkpointEvaluation(evalCtx: ToolContext, waitId: string) {
    await f.db
      .update(schema.agentRuns)
      .set({
        status: "waiting_input",
        transcript: {
          pending: { calls: [{ toolUseId: evalCtx.toolUseId!, name: "evaluate_foundry_capability", waitId }] },
        },
      })
      .where(eq(schema.agentRuns.id, evalCtx.runId));
  }
  async function claimEvaluation(waitId: string) {
    const [claim] = await f.db
      .update(schema.outbox)
      .set({
        status: "processing",
        attempts: 1,
        lockedBy: "simulation-evaluation-worker",
        lockedUntil: new Date(state.now.getTime() + 120_000),
      })
      .where(eq(schema.outbox.dedupeKey, waitId))
      .returning();
    if (!claim) throw new Error("missing native evaluation job");
    return claim;
  }
  const lifecycle = {
    ...rawLifecycle,
    async evaluate(evalCtx: ToolContext, input: { candidateId: string; digest: string }) {
      const begun = await rawLifecycle.evaluate(evalCtx, input);
      if (!("pause" in begun) || !begun.pause) return begun;
      await checkpointEvaluation(evalCtx, begun.pause.id);
      const claim = await claimEvaluation(begun.pause.id);
      await rawLifecycle.reconcileEvaluation(claim);
      const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, evalCtx.runId));
      const transcript = run?.transcript as { pending?: { calls?: { result?: { content: string } }[] } } | null;
      const content = transcript?.pending?.calls?.[0]?.result?.content;
      await f.db.update(schema.agentRuns).set({ status: "running" }).where(eq(schema.agentRuns.id, evalCtx.runId));
      if (!content) return { state: "BLOCKED", code: "SIMULATION_PARENT_NOT_RESUMED" };
      return JSON.parse(content) as { state: string; code?: string };
    },
  };

  async function stage(versionName = "1.0.0") {
    const proposal = await service.propose(ctx, { needKey: "receipt-normalizer/v1" });
    if (proposal.kind !== "draft") throw new Error("expected native draft");
    const frozen = bundle(versionName);
    const version = await service.stage(ctx, {
      candidateId: proposal.candidate.id,
      revision: proposal.candidate.revision,
      bundle: frozen,
    });
    const receiptRef = `simulation-evaluation/${version.digest}`;
    state.evidence.set(`${f.org.id}:${receiptRef}`, {
      receiptRef,
      orgId: f.org.id,
      candidateId: proposal.candidate.id,
      digest: version.digest,
      evaluatorId: "simulation-protected-evaluator",
      protectionRef: "simulation-protected-artifacts",
      builderReadable: false,
      builderWritable: false,
      outcome: "PASS",
      runtimeDigest: RUNTIME,
      profileDigest: PROFILE,
      expiresAt: EXPIRY,
      canary: { input: structuredClone(CANARY_INPUT), expectedOutputDigest: hashFoundryInput(CANARY_OUTPUT) },
    });
    return { candidateId: proposal.candidate.id, digest: version.digest, version, bundle: frozen };
  }

  async function prepare(staged: Awaited<ReturnType<typeof stage>>, maxCalls = 10) {
    await lifecycle.evaluate(ctx, { candidateId: staged.candidateId, digest: staged.digest });
    const activationCtx = { ...ctx, toolUseId: crypto.randomUUID(), approved: true };
    const params = await lifecycle.activationParameters(activationCtx, {
      candidateId: staged.candidateId,
      digest: staged.digest,
      maxCalls,
      validUntil: new Date(state.now.getTime() + 30 * 60_000).toISOString(),
    });
    return { ctx: activationCtx, params };
  }

  async function approval(activationCtx: ToolContext, params: FoundryActivationInput) {
    // The DB row represents an exact native approval already consumed by the
    // Gateway immediately before this service call. No UI/global flag grants it.
    const [row] = await f.db
      .insert(schema.approvals)
      .values({
        orgId: f.org.id,
        runId: activationCtx.runId,
        agentId: f.agent.id,
        channelId: activationCtx.channelId,
        threadRootId: activationCtx.threadRootId,
        toolUseId: activationCtx.toolUseId!,
        tool: FOUNDRY_ACTIVATE_TOOL,
        scope: "sandbox:run",
        connectionId: null,
        params: { ...params },
        actionHash: actionHash({
          tool: FOUNDRY_ACTIVATE_TOOL,
          scope: "sandbox:run",
          connectionId: null,
          params: { ...params },
        }),
        title: "Activate this synthetic tool for this native task only",
        detail: "",
        why: "Synthetic exact-scope approval fixture",
        ownerUserId: f.owner.id,
        requestedByUserId: f.owner.id,
        status: "approved",
        decidedByUserId: f.owner.id,
        decidedAt: state.now,
        executedAt: state.now,
        expiresAt: new Date(params.validUntil),
      })
      .returning();
    if (!row) throw new Error("native approval fixture");
    return row;
  }

  async function activate(staged: Awaited<ReturnType<typeof stage>>, maxCalls = 10) {
    const prepared = await prepare(staged, maxCalls);
    const approved = await approval(prepared.ctx, prepared.params);
    await lifecycle.activate(prepared.ctx, prepared.params);
    const [binding] = await f.db
      .select()
      .from(schema.foundryBindings)
      .where(and(eq(schema.foundryBindings.orgId, f.org.id), eq(schema.foundryBindings.approvalId, approved.id)));
    if (!binding) throw new Error("no binding after native activation");
    return { binding, approved, ...prepared };
  }

  return {
    f,
    task,
    ctx,
    state,
    executor,
    evaluations,
    builderPolicy,
    service,
    lifecycle,
    makeLifecycle,
    rawLifecycle,
    checkpointEvaluation,
    claimEvaluation,
    session,
    stage,
    prepare,
    approval,
    activate,
  };
}

export type LifecycleWorld = Awaited<ReturnType<typeof createLifecycleWorld>>;
