import {
  createUnavailableFoundryExecutor,
  type FoundryAdmission,
  type FoundryExecutionResult,
  type FoundryExecutor,
  type FoundryQualification,
  type FoundryRunnerExecutionRequest,
  hashFoundryInput,
} from "@agenteschat/adapters";
import { and, type Executor, eq, inArray, isNull, schema, sql } from "@agenteschat/db";
import { getMembership } from "../organizations";
import { enqueue, type OutboxJob } from "../outbox";
import { actionHash } from "../tools/gateway";
import { freshGrantedKeys, isAllowed, toolAccess } from "../tools/scopes";
import type { ToolContext } from "../tools/types";
import { createDurableFoundryEvaluation } from "./evaluation";
import type { FoundryExecutionPolicy } from "./execution-policy";
import { canonicalJson, type FrozenPackage } from "./packages";
import { receiptAppliesTo, validateReceiptInput, validateReceiptOutput } from "./receipt-contract";
import {
  exactKeys,
  type FoundryCandidate,
  type FoundryDependencies,
  FoundryError,
  type FoundryVersion,
  foundryContext,
  foundryHash,
  loadFoundryBundle,
  ownedCandidate,
} from "./service";

export const FOUNDRY_ACTIVATE_TOOL = "activate_foundry_capability";
export const FOUNDRY_RECONCILE_JOB = "foundry.reconcile";
export const foundryToolName = (candidateId: string, digest: string) =>
  `foundry_receipt_normalizer_${candidateId.replaceAll("-", "").slice(0, 16)}_${digest.slice(0, 20)}`;
const {
  foundryCandidates: candidates,
  foundryVersions: versions,
  foundryBindings: bindings,
  foundryInvocations: invocations,
  approvals,
} = schema;
type Binding = typeof bindings.$inferSelect;
type Invocation = typeof invocations.$inferSelect;
type Qualification = Extract<FoundryQualification, { qualified: true }>;

export interface FoundryEvaluationEvidence {
  receiptRef: string;
  orgId: string;
  candidateId: string;
  digest: string;
  evaluatorId: string;
  protectionRef: string;
  builderReadable: false;
  builderWritable: false;
  outcome: "PASS" | "FAIL";
  runtimeDigest: string;
  profileDigest: string;
  expiresAt: string;
  canary: { input: unknown; expectedOutputDigest: string };
}
/** Authenticated server dependency. Builder-provided receipt JSON never implements this store. */
export interface TrustedFoundryEvaluationStore {
  resolve(orgId: string, receiptRef: string): Promise<FoundryEvaluationEvidence | null>;
}
export interface FoundryActivationInput {
  candidateId: string;
  candidateRevision: number;
  versionDigest: string;
  contractDigest: string;
  effectsDigest: string;
  taskId: string;
  agentId: string;
  personId: string;
  evaluationRef: string;
  runtimeDigest: string;
  profileDigest: string;
  validUntil: string;
  maxCalls: number;
  previousBindingId: string | null;
}
export interface FoundryLifecycleDependencies extends FoundryDependencies {
  executor?: FoundryExecutor;
  builderPolicy?: FoundryExecutionPolicy;
  evaluations?: TrustedFoundryEvaluationStore;
  now?: () => Date;
}
export type FoundryInvocationOutcome =
  | { outcome: "SUCCEEDED"; invocationId: string; output: unknown }
  | { outcome: "FAILED" | "CANCELLED" | "UNKNOWN_OUTCOME" | "ALREADY_ATTEMPTED"; invocationId: string; code?: string };

const ACTIVATION_KEYS = [
  "candidateId",
  "candidateRevision",
  "versionDigest",
  "contractDigest",
  "effectsDigest",
  "taskId",
  "agentId",
  "personId",
  "evaluationRef",
  "runtimeDigest",
  "profileDigest",
  "validUntil",
  "maxCalls",
  "previousBindingId",
];
const digestPattern = /^[a-f0-9]{64}$/;
function activationOf(value: unknown): FoundryActivationInput {
  if (!exactKeys(value, [...ACTIVATION_KEYS, "why"])) throw new FoundryError("SCHEMA_INVALID");
  const { why, ...input } = value;
  if (why !== undefined && (typeof why !== "string" || why.length > 2000)) throw new FoundryError("SCHEMA_INVALID");
  if (
    !ACTIVATION_KEYS.every((key) => Object.hasOwn(input, key)) ||
    !Number.isSafeInteger(input.candidateRevision) ||
    (input.candidateRevision as number) < 0 ||
    !Number.isSafeInteger(input.maxCalls) ||
    (input.maxCalls as number) < 2 ||
    (input.maxCalls as number) > 100 ||
    typeof input.validUntil !== "string" ||
    !Number.isFinite(Date.parse(input.validUntil))
  )
    throw new FoundryError("SCHEMA_INVALID");
  for (const key of ["versionDigest", "contractDigest", "effectsDigest", "runtimeDigest", "profileDigest"])
    if (typeof input[key] !== "string" || !digestPattern.test(input[key] as string))
      throw new FoundryError("SCHEMA_INVALID");
  return input as unknown as FoundryActivationInput;
}
const at = (value: string) => new Date(value);
const codeOf = (error: unknown) => (error instanceof FoundryError ? error.code : "UNVERIFIED_OUTCOME");
function requireManifestLimits(bundle: FrozenPackage, q: Qualification) {
  const r = bundle.manifest.runtimeRequest;
  if (!r) throw new FoundryError("BLOCKED_SANDBOX");
  const ceilings = {
    wallTimeMs: r.wallTimeMs,
    cpuTimeMs: r.wallTimeMs,
    memoryBytes: r.memoryMiB * 1024 * 1024,
    scratchBytes: r.scratchMiB * 1024 * 1024,
    maxProcesses: r.processes,
    stdoutBytes: r.logBytesPerStream,
    stderrBytes: r.logBytesPerStream,
    inputBytes: r.inputBytes,
    resultBytes: r.resultBytes,
  };
  for (const key of Object.keys(ceilings) as (keyof typeof ceilings)[])
    if (!Number.isSafeInteger(q.limits[key]) || q.limits[key] < 1 || q.limits[key] > ceilings[key])
      throw new FoundryError("BLOCKED_SANDBOX");
}

export function createFoundryLifecycle(deps: FoundryLifecycleDependencies) {
  const { db } = deps;
  // Revoking policy must never remove the trusted stop/reconciliation path.
  // Qualification and every executable entry still require builder protection.
  const executor: FoundryExecutor = deps.executor ?? createUnavailableFoundryExecutor();
  const now = deps.now ?? (() => new Date());

  async function qualified(): Promise<Qualification> {
    if (!deps.builderPolicy) throw new FoundryError("BLOCKED_SANDBOX");
    const result = await executor.qualify();
    if (!result.qualified) throw new FoundryError("BLOCKED_SANDBOX");
    return result;
  }
  async function versionOf(ctx: ToolContext, candidateId: string, digest: string) {
    const current = await ownedCandidate(db, ctx, candidateId);
    const [version] = await db
      .select()
      .from(versions)
      .where(
        and(
          eq(versions.orgId, ctx.orgId),
          eq(versions.candidateId, candidateId),
          eq(versions.digest, digest),
          isNull(versions.retiredAt),
        ),
      );
    if (!version) throw new FoundryError("NOT_FOUND");
    const bundle = await loadFoundryBundle(deps, version);
    return { ...current, version, bundle };
  }
  async function evidence(
    candidate: FoundryCandidate,
    version: FoundryVersion,
    q: Qualification,
    receiptRef = version.evaluationRef,
  ) {
    const e = receiptRef ? await deps.evaluations?.resolve(candidate.orgId, receiptRef) : null;
    if (
      !e ||
      e.receiptRef !== receiptRef ||
      e.orgId !== candidate.orgId ||
      e.candidateId !== candidate.id ||
      e.digest !== version.digest ||
      e.outcome !== "PASS" ||
      !e.evaluatorId ||
      e.evaluatorId === candidate.agentId ||
      !e.protectionRef ||
      e.builderReadable !== false ||
      e.builderWritable !== false ||
      e.runtimeDigest !== q.runtimeDigest ||
      e.profileDigest !== q.profileDigest ||
      !Number.isFinite(Date.parse(e.expiresAt)) ||
      at(e.expiresAt) <= now() ||
      !validateReceiptInput(e.canary?.input) ||
      !digestPattern.test(e.canary?.expectedOutputDigest ?? "")
    )
      throw new FoundryError("EVALUATION_UNVERIFIED");
    return e;
  }
  async function scopeAllowed(tx: Executor, ctx: ToolContext, candidateId: string, digest: string) {
    const keys = await freshGrantedKeys(tx, ctx.orgId, ctx.agentId);
    const known = await tx
      .select({ digest: versions.digest })
      .from(versions)
      .where(and(eq(versions.orgId, ctx.orgId), eq(versions.candidateId, candidateId)));
    const names = [
      foundryToolName(candidateId, digest),
      `foundry_receipt_normalizer_${candidateId.replaceAll("-", "").slice(0, 16)}`,
      ...known.map((v) => foundryToolName(candidateId, v.digest)),
    ];
    for (const name of names)
      if (!isAllowed(toolAccess(keys, { name, scope: "sandbox:run" }))) throw new FoundryError("AUTHORITY_DENIED");
  }
  async function currentApproval(tx: Executor, binding: Binding) {
    const [approval] = await tx
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.id, binding.approvalId),
          eq(approvals.orgId, binding.orgId),
          eq(approvals.agentId, binding.agentId),
        ),
      );
    if (
      !approval ||
      approval.status !== "approved" ||
      approval.expiresAt <= now() ||
      approval.supersededById ||
      !approval.decidedByUserId ||
      !approval.executedAt ||
      approval.actionHash !== binding.approvalHash ||
      approval.tool !== FOUNDRY_ACTIVATE_TOOL ||
      approval.scope !== "sandbox:run" ||
      approval.connectionId ||
      actionHash({
        tool: approval.tool,
        scope: approval.scope,
        connectionId: approval.connectionId,
        params: approval.params,
      }) !== approval.actionHash ||
      !(await getMembership(tx, approval.decidedByUserId, binding.orgId))
    )
      throw new FoundryError("AUTHORITY_DENIED");
    return approval;
  }
  async function guard(ctx: ToolContext, bindingId: string, allowed: readonly string[], expectedDigest?: string) {
    if (ctx.signal?.aborted) throw new FoundryError("CANCELLED");
    if (!(await deps.builderPolicy?.protection(ctx))) throw new FoundryError("BLOCKED_BUILDER_ISOLATION");
    const current = await foundryContext(db, ctx);
    const [binding] = await db
      .select()
      .from(bindings)
      .where(
        and(
          eq(bindings.id, bindingId),
          eq(bindings.orgId, ctx.orgId),
          eq(bindings.taskId, current.task.id),
          eq(bindings.agentId, ctx.agentId),
          eq(bindings.personId, current.personId),
        ),
      );
    if (!binding) throw new FoundryError("NOT_FOUND");
    if (binding.revokedAt || binding.expiresAt <= now() || !allowed.includes(binding.state))
      throw new FoundryError("AUTHORITY_DENIED");
    const [version] = await db
      .select()
      .from(versions)
      .where(
        and(
          eq(versions.id, binding.versionId),
          eq(versions.orgId, ctx.orgId),
          eq(versions.candidateId, binding.candidateId),
          isNull(versions.retiredAt),
        ),
      );
    if (!version || version.state !== "REVIEW_READY" || (expectedDigest && version.digest !== expectedDigest))
      throw new FoundryError("STALE_VERSION");
    const { candidate } = await ownedCandidate(db, ctx, binding.candidateId);
    await scopeAllowed(db, ctx, candidate.id, version.digest);
    const approval = await currentApproval(db, binding);
    const params = activationOf(approval.params);
    if (
      params.versionDigest !== version.digest ||
      params.contractDigest !== version.contractDigest ||
      params.effectsDigest !== version.effectsDigest ||
      params.taskId !== binding.taskId ||
      params.agentId !== binding.agentId ||
      params.personId !== binding.personId ||
      params.candidateId !== candidate.id ||
      params.evaluationRef !== version.evaluationRef ||
      params.previousBindingId !== binding.previousBindingId ||
      at(params.validUntil).getTime() !== binding.expiresAt.getTime() ||
      params.maxCalls !== binding.maxCalls
    )
      throw new FoundryError("AUTHORITY_DENIED");
    const bundle = await loadFoundryBundle(deps, version);
    const q = await qualified();
    requireManifestLimits(bundle, q);
    if (q.runtimeDigest !== params.runtimeDigest || q.profileDigest !== params.profileDigest)
      throw new FoundryError("RUNTIME_DRIFT");
    const e = await evidence(candidate, version, q);
    return { ...current, candidate, binding, version, approval, qualification: q, evidence: e };
  }
  async function activity(tx: Executor, ctx: ToolContext, taskId: string, text: string, data: Record<string, unknown>) {
    await tx.insert(schema.issueActivity).values({
      orgId: ctx.orgId,
      issueId: taskId,
      kind: "event",
      authorType: "agent",
      authorId: ctx.agentId,
      text,
      event: "foundry_state_changed",
      data,
    });
  }
  async function applicable(ctx: ToolContext) {
    const [message] = await db
      .select({ body: schema.messages.body })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.orgId, ctx.orgId),
          eq(schema.messages.id, ctx.triggerMessageId),
          isNull(schema.messages.deletedAt),
        ),
      );
    return !!message && receiptAppliesTo(message.body);
  }
  async function resolveVersion(ctx: ToolContext, input: { candidateId: string; digest: string }) {
    const current = await versionOf(ctx, input.candidateId, input.digest);
    const q = await qualified();
    requireManifestLimits(current.bundle, q);
    if (current.version.state !== "REVIEW_READY") throw new FoundryError("EVALUATION_UNVERIFIED");
    const e = await evidence(current.candidate, current.version, q);
    return { ...current, qualification: q, evidence: e };
  }
  async function parameters(
    ctx: ToolContext,
    input: { candidateId: string; digest: string; maxCalls: number; validUntil: string },
  ) {
    const current = await resolveVersion(ctx, input);
    await scopeAllowed(db, ctx, input.candidateId, input.digest);
    if (
      !Number.isSafeInteger(input.maxCalls) ||
      input.maxCalls < 2 ||
      input.maxCalls > 100 ||
      !Number.isFinite(Date.parse(input.validUntil)) ||
      at(input.validUntil) <= now() ||
      at(input.validUntil).getTime() > now().getTime() + 24 * 3600_000
    )
      throw new FoundryError("SCHEMA_INVALID");
    const [previous] = await db
      .select()
      .from(bindings)
      .where(
        and(
          eq(bindings.orgId, ctx.orgId),
          eq(bindings.candidateId, input.candidateId),
          eq(bindings.taskId, current.task.id),
          eq(bindings.agentId, ctx.agentId),
          eq(bindings.state, "ACTIVE"),
          isNull(bindings.revokedAt),
        ),
      );
    return {
      candidateId: input.candidateId,
      candidateRevision: current.candidate.revision,
      versionDigest: input.digest,
      contractDigest: current.version.contractDigest,
      effectsDigest: current.version.effectsDigest,
      taskId: current.task.id,
      agentId: ctx.agentId,
      personId: current.personId,
      evaluationRef: current.evidence.receiptRef,
      runtimeDigest: current.qualification.runtimeDigest,
      profileDigest: current.qualification.profileDigest,
      validUntil: input.validUntil,
      maxCalls: input.maxCalls,
      previousBindingId: previous?.id ?? null,
    } satisfies FoundryActivationInput;
  }
  async function nativeContextFor(row: Invocation): Promise<ToolContext> {
    const [run] = await db
      .select()
      .from(schema.agentRuns)
      .where(and(eq(schema.agentRuns.id, row.runId), eq(schema.agentRuns.orgId, row.orgId)));
    if (!run) throw new FoundryError("AUTHORITY_DENIED");
    return {
      db,
      orgId: row.orgId,
      agentId: run.agentId,
      runId: run.id,
      channelId: run.channelId,
      threadRootId: run.threadRootId,
      triggerMessageId: run.triggerMessageId,
      toolUseId: row.toolUseId,
    };
  }
  function receiptMatches(row: Invocation, result: FoundryExecutionResult) {
    if (result.outcome === "UNKNOWN_OUTCOME") return false;
    const p = row.receipt?.pinned as Record<string, unknown> | undefined;
    const r = result.receipt;
    return (
      !!p &&
      r.orgId === row.orgId &&
      r.invocationId === row.id &&
      r.digest === row.digest &&
      r.inputDigest === row.inputDigest &&
      r.fencingToken === row.fencingToken &&
      r.runnerId === p.runnerId &&
      r.runtimeDigest === p.runtimeDigest &&
      r.profileDigest === p.profileDigest &&
      r.qualificationRef === p.qualificationRef &&
      r.receiptRef === result.receiptRef &&
      r.processTreeTerminated
    );
  }
  async function finish(
    ctx: ToolContext,
    row: Invocation,
    result: FoundryExecutionResult,
    recoveryRevision: number,
  ): Promise<FoundryInvocationOutcome> {
    let outcome: FoundryInvocationOutcome["outcome"] = result.outcome;
    let code: string | undefined;
    if (result.outcome !== "UNKNOWN_OUTCOME" && !receiptMatches(row, result)) {
      outcome = "UNKNOWN_OUTCOME";
      code = "RECEIPT_MISMATCH";
    } else if (result.outcome === "SUCCEEDED" && !validateReceiptOutput(result.output)) {
      outcome = "FAILED";
      code = "SCHEMA_INVALID";
    } else if (result.outcome === "FAILED") code = result.code;
    let admitted: Awaited<ReturnType<typeof guard>> | null = null;
    try {
      admitted = await guard(ctx, row.bindingId, ["CANARY", "ACTIVE"], row.digest);
    } catch {
      if (outcome === "SUCCEEDED") {
        outcome = "CANCELLED";
        code = "AUTHORITY_CHANGED";
      }
    }
    const completed = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from foundry_bindings where org_id=${row.orgId}::uuid and id=${row.bindingId}::uuid for update`,
      );
      const [binding] = await tx
        .select()
        .from(bindings)
        .where(and(eq(bindings.orgId, row.orgId), eq(bindings.id, row.bindingId)));
      if (!binding || binding.generation !== row.bindingGeneration || binding.revokedAt) {
        if (outcome === "SUCCEEDED") {
          outcome = "CANCELLED";
          code = "AUTHORITY_CHANGED";
        }
      } else if (outcome === "SUCCEEDED") {
        try {
          await foundryContext(tx, ctx);
          await scopeAllowed(tx, ctx, binding.candidateId, row.digest);
          await currentApproval(tx, binding);
        } catch {
          outcome = "CANCELLED";
          code = "AUTHORITY_CHANGED";
        }
      }
      const [updated] = await tx
        .update(invocations)
        .set({
          state: outcome,
          reasonCode: code ?? null,
          completedAt: outcome === "UNKNOWN_OUTCOME" ? null : now(),
          resultDigest:
            outcome === "SUCCEEDED" && result.outcome === "SUCCEEDED" ? hashFoundryInput(result.output) : null,
          receipt: {
            ...row.receipt,
            receiptRef: result.receiptRef,
            terminalVerified: result.outcome !== "UNKNOWN_OUTCOME" && receiptMatches(row, result),
            terminalIdentity:
              result.outcome !== "UNKNOWN_OUTCOME" && receiptMatches(row, result) ? result.receipt : null,
          },
        })
        .where(
          and(
            eq(invocations.id, row.id),
            eq(invocations.orgId, row.orgId),
            eq(invocations.fencingToken, row.fencingToken),
            eq(invocations.recoveryRevision, recoveryRevision),
            inArray(invocations.state, ["DISPATCHED", "RECONCILING"]),
          ),
        )
        .returning();
      return updated;
    });
    if (!completed) return { outcome: "UNKNOWN_OUTCOME", invocationId: row.id, code: "STALE_FENCE" };
    if (outcome === "SUCCEEDED" && result.outcome === "SUCCEEDED" && admitted)
      return { outcome: "SUCCEEDED", invocationId: row.id, output: result.output };
    return {
      outcome: outcome as Exclude<FoundryInvocationOutcome["outcome"], "SUCCEEDED">,
      invocationId: row.id,
      ...(code ? { code } : {}),
    };
  }
  async function dispatch(
    ctx: ToolContext,
    bindingId: string,
    digest: string,
    input: unknown,
    canary: boolean,
  ): Promise<FoundryInvocationOutcome> {
    if (!ctx.toolUseId || !validateReceiptInput(input)) throw new FoundryError("SCHEMA_INVALID");
    const proof = await guard(ctx, bindingId, canary ? ["CANARY"] : ["ACTIVE"], digest);
    if (canary && proof.approval.runId !== ctx.runId) throw new FoundryError("CANARY_SCOPE");
    if (!canary && !(await applicable(ctx))) throw new FoundryError("NOT_APPLICABLE");
    const inputDigest = hashFoundryInput(input);
    const reserved = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from foundry_bindings where org_id=${ctx.orgId}::uuid and id=${bindingId}::uuid for update`,
      );
      await foundryContext(tx, ctx);
      await scopeAllowed(tx, ctx, proof.candidate.id, proof.version.digest);
      const [binding] = await tx
        .select()
        .from(bindings)
        .where(and(eq(bindings.id, bindingId), eq(bindings.orgId, ctx.orgId)));
      if (
        !binding ||
        binding.generation !== proof.binding.generation ||
        binding.revokedAt ||
        binding.expiresAt <= now() ||
        binding.state !== (canary ? "CANARY" : "ACTIVE")
      )
        throw new FoundryError("AUTHORITY_DENIED");
      await currentApproval(tx, binding);
      const [previous] = await tx
        .select()
        .from(invocations)
        .where(
          and(
            eq(invocations.orgId, ctx.orgId),
            eq(invocations.runId, ctx.runId),
            eq(invocations.toolUseId, ctx.toolUseId!),
          ),
        );
      if (previous) {
        if (previous.bindingId !== bindingId || previous.digest !== digest || previous.inputDigest !== inputDigest)
          throw new FoundryError("IDEMPOTENCY_CONFLICT");
        return { row: previous, fresh: false };
      }
      if (binding.reservedCalls >= binding.maxCalls || (canary && binding.reservedCalls >= 1))
        throw new FoundryError("BUDGET_EXHAUSTED");
      const leaseUntil = new Date(now().getTime() + 30_000);
      const [row] = await tx
        .insert(invocations)
        .values({
          orgId: ctx.orgId,
          bindingId,
          runId: ctx.runId,
          toolUseId: ctx.toolUseId!,
          digest,
          inputDigest,
          fencingToken: 1,
          bindingGeneration: binding.generation,
          leaseUntil,
          receipt: {
            purpose: canary ? "canary" : "call",
            pinned: {
              runnerId: proof.qualification.runnerId,
              runtimeDigest: proof.qualification.runtimeDigest,
              profileDigest: proof.qualification.profileDigest,
              qualificationRef: proof.qualification.attestationRef,
            },
          },
        })
        .returning();
      await tx
        .update(bindings)
        .set({ reservedCalls: binding.reservedCalls + 1 })
        .where(eq(bindings.id, bindingId));
      await enqueue(tx, {
        orgId: ctx.orgId,
        kind: FOUNDRY_RECONCILE_JOB,
        payload: { invocationId: row!.id },
        dedupeKey: `foundry:reconcile:${ctx.orgId}:${row!.id}`,
        runAt: leaseUntil,
        maxAttempts: 1,
      });
      return { row: row!, fresh: true };
    });
    if (!reserved.fresh)
      return {
        outcome: reserved.row.state === "UNKNOWN_OUTCOME" ? "UNKNOWN_OUTCOME" : "ALREADY_ATTEMPTED",
        invocationId: reserved.row.id,
      };
    const row = reserved.row;
    try {
      await guard(ctx, bindingId, canary ? ["CANARY"] : ["ACTIVE"], digest);
      const [claimed] = await db
        .update(invocations)
        .set({ state: "DISPATCHED" })
        .where(
          and(
            eq(invocations.id, row.id),
            eq(invocations.orgId, ctx.orgId),
            eq(invocations.state, "RESERVED"),
            eq(invocations.recoveryRevision, 0),
            sql`exists (select 1 from foundry_bindings b where b.id=${bindingId}::uuid and b.org_id=${ctx.orgId}::uuid
          and b.generation=${row.bindingGeneration} and b.revoked_at is null and b.expires_at > ${now()})`,
          ),
        )
        .returning();
      if (!claimed) throw new FoundryError("AUTHORITY_DENIED");
      const result = await executor.execute({
        orgId: ctx.orgId,
        digest,
        input,
        inputDigest,
        invocationId: row.id,
        fencingToken: row.fencingToken,
        nativeDecisionRef: proof.approval.id,
        budgetReservationRef: row.id,
        abort: ctx.signal ?? new AbortController().signal,
      });
      return finish(ctx, row, result, 0);
    } catch (error) {
      // The runtime's admission gate refuses before it hands the request to any runner, so nothing
      // started: close the call as CANCELLED and give back its reserved call instead of UNKNOWN.
      if ((error as { code?: unknown } | null)?.code === "RUNTIME_BUSY") {
        await db.transaction(async (tx) => {
          const [closed] = await tx
            .update(invocations)
            .set({ state: "CANCELLED", reasonCode: "RUNTIME_BUSY", completedAt: now() })
            .where(
              and(
                eq(invocations.id, row.id),
                eq(invocations.recoveryRevision, 0),
                inArray(invocations.state, ["RESERVED", "DISPATCHED"]),
              ),
            )
            .returning({ id: invocations.id });
          if (closed)
            await tx
              .update(bindings)
              .set({ reservedCalls: sql`${bindings.reservedCalls} - 1` })
              .where(and(eq(bindings.id, bindingId), sql`${bindings.reservedCalls} > 0`));
        });
        return { outcome: "CANCELLED", invocationId: row.id, code: "RUNTIME_BUSY" };
      }
      const [current] = await db.select().from(invocations).where(eq(invocations.id, row.id));
      const unknown = current?.state === "DISPATCHED";
      await db
        .update(invocations)
        .set({
          state: unknown ? "UNKNOWN_OUTCOME" : "CANCELLED",
          reasonCode: codeOf(error),
          completedAt: unknown ? null : now(),
        })
        .where(
          and(
            eq(invocations.id, row.id),
            eq(invocations.recoveryRevision, 0),
            inArray(invocations.state, ["RESERVED", "DISPATCHED"]),
          ),
        );
      return { outcome: unknown ? "UNKNOWN_OUTCOME" : "CANCELLED", invocationId: row.id, code: codeOf(error) };
    }
  }
  async function rollback(
    ctx: ToolContext,
    failed: Binding,
    allowRestore = true,
    owned: () => Promise<boolean> = async () => true,
  ): Promise<string | null> {
    let previous: Awaited<ReturnType<typeof guard>> | null = null;
    if (allowRestore && failed.previousBindingId) {
      try {
        previous = await guard(ctx, failed.previousBindingId, ["SUPERSEDED"]);
      } catch {
        /* no eligible fallback */
      }
    }
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from foundry_candidates where org_id=${ctx.orgId}::uuid and id=${failed.candidateId}::uuid for update`,
      );
      const [current] = await tx
        .select()
        .from(bindings)
        .where(and(eq(bindings.orgId, ctx.orgId), eq(bindings.id, failed.id)));
      if (!current || current.state !== "CANARY" || current.generation !== failed.generation || !(await owned()))
        return null;
      await tx
        .update(bindings)
        .set({ state: "QUARANTINED", generation: current.generation + 1 })
        .where(eq(bindings.id, failed.id));
      await tx.update(versions).set({ state: "QUARANTINED" }).where(eq(versions.id, failed.versionId));
      let restored: string | null = null;
      if (previous) {
        try {
          await foundryContext(tx, ctx);
          await scopeAllowed(tx, ctx, previous.candidate.id, previous.version.digest);
          await currentApproval(tx, previous.binding);
          if (!(await owned())) throw new FoundryError("STALE_FENCE");
          const [row] = await tx
            .update(bindings)
            .set({ state: "ACTIVE", generation: previous.binding.generation + 1 })
            .where(
              and(
                eq(bindings.id, previous.binding.id),
                eq(bindings.orgId, ctx.orgId),
                eq(bindings.state, "SUPERSEDED"),
                eq(bindings.generation, previous.binding.generation),
                isNull(bindings.revokedAt),
                sql`${bindings.expiresAt} > ${now()}`,
              ),
            )
            .returning();
          restored = row?.id ?? null;
        } catch (error) {
          if (error instanceof FoundryError && error.code === "STALE_FENCE") throw error;
          /* keep the capability unavailable */
        }
      }
      if (!(await owned())) throw new FoundryError("STALE_FENCE");
      await tx
        .update(candidates)
        .set({
          state: restored ? "ACTIVE" : "QUARANTINED",
          reasonCode: restored ? "CANARY_ROLLED_BACK" : "NO_ELIGIBLE_PREVIOUS",
          updatedAt: now(),
        })
        .where(eq(candidates.id, failed.candidateId));
      await activity(
        tx,
        ctx,
        failed.taskId,
        restored
          ? "Capability canary failed; previous authorized version restored."
          : "Capability canary failed; capability remains unavailable.",
        { bindingId: failed.id, restoredBindingId: restored },
      );
      return restored;
    });
  }

  async function completeCanary(ctx: ToolContext, row: Invocation, owned: () => Promise<boolean> = async () => true) {
    const pending = { outcome: "PENDING" as const, restoredBindingId: null };
    if (
      row.receipt?.purpose !== "canary" ||
      !["SUCCEEDED", "FAILED", "CANCELLED"].includes(row.state) ||
      row.receipt?.terminalVerified !== true ||
      !row.receipt.terminalIdentity ||
      typeof row.receipt.receiptRef !== "string"
    )
      return pending;
    const stored = row.receipt.terminalIdentity as Extract<FoundryExecutionResult, { outcome: "SUCCEEDED" }>["receipt"];
    if (
      !receiptMatches(row, { outcome: "SUCCEEDED", output: null, receiptRef: row.receipt.receiptRef, receipt: stored })
    )
      return pending;
    let proof: Awaited<ReturnType<typeof guard>>;
    try {
      proof = await guard(ctx, row.bindingId, ["CANARY"], row.digest);
    } catch (error) {
      if (error instanceof FoundryError) return pending;
      throw error;
    }
    if (
      proof.binding.generation !== row.bindingGeneration ||
      proof.approval.runId !== row.runId ||
      hashFoundryInput(proof.evidence.canary.input) !== row.inputDigest ||
      !(await owned())
    )
      return pending;
    if (row.state !== "SUCCEEDED" || row.resultDigest !== proof.evidence.canary.expectedOutputDigest)
      return { outcome: "FAIL" as const, restoredBindingId: await rollback(ctx, proof.binding, true, owned) };
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from foundry_candidates where org_id=${ctx.orgId}::uuid and id=${proof.candidate.id}::uuid for update`,
      );
      await ownedCandidate(tx, ctx, proof.candidate.id);
      await scopeAllowed(tx, ctx, proof.candidate.id, proof.version.digest);
      await currentApproval(tx, proof.binding);
      if (!(await owned())) return pending;
      const [active] = await tx
        .update(bindings)
        .set({ state: "ACTIVE" })
        .where(
          and(
            eq(bindings.id, row.bindingId),
            eq(bindings.orgId, ctx.orgId),
            eq(bindings.generation, row.bindingGeneration),
            eq(bindings.state, "CANARY"),
            isNull(bindings.revokedAt),
            sql`${bindings.expiresAt} > ${now()}`,
          ),
        )
        .returning();
      if (!active) return pending;
      await tx
        .update(candidates)
        .set({ state: "ACTIVE", reasonCode: null, updatedAt: now() })
        .where(eq(candidates.id, active.candidateId));
      await activity(tx, ctx, active.taskId, "Verified canary completed; exact task-scoped capability is available.", {
        bindingId: active.id,
        invocationId: row.id,
        digest: row.digest,
        state: "ACTIVE",
      });
      return { outcome: "PASS" as const, restoredBindingId: null };
    });
  }

  const api = {
    authorizeRunnerEvaluation: createDurableFoundryEvaluation({
      ...deps,
      executor,
      now,
      qualified,
      requireLimits: requireManifestLimits,
      verifyEvidence: evidence,
    }).authorizeDispatch,
    evaluate: createDurableFoundryEvaluation({
      ...deps,
      executor,
      now,
      qualified,
      requireLimits: requireManifestLimits,
      verifyEvidence: evidence,
    }).begin,
    reconcileEvaluation(job: OutboxJob, finalAttempt = false) {
      return createDurableFoundryEvaluation({
        ...deps,
        executor,
        now,
        qualified,
        requireLimits: requireManifestLimits,
        verifyEvidence: evidence,
      }).run(job, finalAttempt);
    },
    activationParameters: parameters,
    async activate(ctx: ToolContext, raw: FoundryActivationInput) {
      const input = activationOf(raw);
      if (!ctx.approved || !ctx.toolUseId) throw new FoundryError("NEEDS_APPROVAL");
      const proof = await resolveVersion(ctx, { candidateId: input.candidateId, digest: input.versionDigest });
      if (
        input.taskId !== proof.task.id ||
        input.agentId !== ctx.agentId ||
        input.personId !== proof.personId ||
        input.contractDigest !== proof.version.contractDigest ||
        input.effectsDigest !== proof.version.effectsDigest ||
        input.evaluationRef !== proof.evidence.receiptRef ||
        input.runtimeDigest !== proof.qualification.runtimeDigest ||
        input.profileDigest !== proof.qualification.profileDigest
      )
        throw new FoundryError("AUTHORITY_DENIED");
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`select id from foundry_candidates where org_id=${ctx.orgId}::uuid and id=${input.candidateId}::uuid for update`,
        );
        const current = await ownedCandidate(tx, ctx, input.candidateId);
        await scopeAllowed(tx, ctx, input.candidateId, input.versionDigest);
        const [approval] = await tx
          .select()
          .from(approvals)
          .where(
            and(
              eq(approvals.orgId, ctx.orgId),
              eq(approvals.runId, ctx.runId),
              eq(approvals.agentId, ctx.agentId),
              eq(approvals.toolUseId, ctx.toolUseId!),
              eq(approvals.tool, FOUNDRY_ACTIVATE_TOOL),
              eq(approvals.scope, "sandbox:run"),
            ),
          )
          .for("update");
        if (
          !approval ||
          approval.connectionId ||
          approval.status !== "approved" ||
          approval.supersededById ||
          !approval.executedAt ||
          !approval.decidedByUserId ||
          approval.expiresAt <= now() ||
          approval.channelId !== ctx.channelId ||
          approval.threadRootId !== ctx.threadRootId ||
          at(input.validUntil) <= now() ||
          at(input.validUntil) > approval.expiresAt ||
          at(input.validUntil).getTime() > now().getTime() + 24 * 3600_000 ||
          !(await getMembership(tx, approval.decidedByUserId, ctx.orgId)) ||
          actionHash({
            tool: approval.tool,
            scope: approval.scope,
            connectionId: approval.connectionId,
            params: approval.params,
          }) !== approval.actionHash ||
          canonicalJson(activationOf(approval.params)) !== canonicalJson(input)
        )
          throw new FoundryError("NEEDS_APPROVAL");
        const [used] = await tx
          .select()
          .from(bindings)
          .where(and(eq(bindings.orgId, ctx.orgId), eq(bindings.approvalId, approval.id)));
        if (used) {
          if (used.revokedAt || !["CANARY", "ACTIVE"].includes(used.state)) throw new FoundryError("AUTHORITY_DENIED");
          return used;
        }
        if (current.candidate.revision !== input.candidateRevision) throw new FoundryError("STALE_VERSION");
        const [active] = await tx
          .select()
          .from(bindings)
          .where(
            and(
              eq(bindings.orgId, ctx.orgId),
              eq(bindings.candidateId, input.candidateId),
              eq(bindings.taskId, current.task.id),
              eq(bindings.agentId, ctx.agentId),
              inArray(bindings.state, ["ACTIVE", "CANARY"]),
            ),
          );
        if ((active?.id ?? null) !== input.previousBindingId || active?.state === "CANARY")
          throw new FoundryError("STALE_VERSION");
        if (active)
          await tx
            .update(bindings)
            .set({ state: "SUPERSEDED", generation: active.generation + 1 })
            .where(eq(bindings.id, active.id));
        const [binding] = await tx
          .insert(bindings)
          .values({
            orgId: ctx.orgId,
            candidateId: input.candidateId,
            versionId: proof.version.id,
            taskId: current.task.id,
            agentId: ctx.agentId,
            personId: current.personId,
            approvalId: approval.id,
            approvalHash: approval.actionHash,
            previousBindingId: active?.id ?? null,
            maxCalls: input.maxCalls,
            expiresAt: at(input.validUntil),
          })
          .returning();
        await tx
          .update(candidates)
          .set({ state: "CANARY", revision: current.candidate.revision + 1, updatedAt: now() })
          .where(eq(candidates.id, input.candidateId));
        await activity(
          tx,
          ctx,
          current.task.id,
          "Exact task-scoped capability enabled for one canary; live reuse is not yet verified.",
          { bindingId: binding!.id, digest: input.versionDigest, state: "CANARY" },
        );
        return binding!;
      });
    },
    async runCanary(ctx: ToolContext, bindingId: string) {
      const proof = await guard(ctx, bindingId, ["CANARY"]);
      const result = await dispatch(ctx, bindingId, proof.version.digest, proof.evidence.canary.input, true);
      if (result.outcome === "ALREADY_ATTEMPTED") return { outcome: "PENDING" as const, restoredBindingId: null };
      // Refused before anything started: not a canary result, so nothing to quarantine or roll back.
      if (result.outcome === "CANCELLED" && "code" in result && result.code === "RUNTIME_BUSY")
        return { outcome: "BUSY" as const, code: "RUNTIME_BUSY" as const, restoredBindingId: null };
      const [terminal] = await db
        .select()
        .from(invocations)
        .where(and(eq(invocations.orgId, ctx.orgId), eq(invocations.id, result.invocationId)));
      if (terminal?.receipt?.terminalVerified === true) return completeCanary(ctx, terminal);
      const pass =
        result.outcome === "SUCCEEDED" &&
        hashFoundryInput(result.output) === proof.evidence.canary.expectedOutputDigest;
      if (!pass) {
        let terminated = result.outcome !== "UNKNOWN_OUTCOME";
        if (!terminated) {
          terminated = await executor
            .cancel(result.invocationId, 1)
            .then(
              (r) =>
                r.outcome === "CANCELLED" &&
                r.invocationId === result.invocationId &&
                r.fencingToken === 1 &&
                r.processTreeTerminated,
            )
            .catch(() => false);
        }
        return { outcome: "FAIL" as const, restoredBindingId: await rollback(ctx, proof.binding, terminated) };
      }
      return { outcome: "PENDING" as const, restoredBindingId: null };
    },
    /** Server-to-runner control only. Never present this method as a tool. */
    async authorizeRunnerExecution(
      request: FoundryRunnerExecutionRequest,
      admission: FoundryAdmission,
    ): Promise<boolean> {
      try {
        if (
          request.abort?.aborted ||
          request.budgetReservationRef !== request.invocationId ||
          Buffer.byteLength(request.inputJson) > admission.limits.inputBytes ||
          hashFoundryInput(JSON.parse(request.inputJson)) !== request.inputDigest
        )
          return false;
        const [row] = await db
          .select()
          .from(invocations)
          .where(and(eq(invocations.id, request.invocationId), eq(invocations.orgId, request.orgId)));
        if (
          !row ||
          row.state !== "DISPATCHED" ||
          row.recoveryRevision !== 0 ||
          row.fencingToken !== request.fencingToken ||
          row.digest !== request.digest ||
          row.inputDigest !== request.inputDigest ||
          row.leaseUntil <= now()
        )
          return false;
        const ctx = await nativeContextFor(row);
        const canary = row.receipt?.purpose === "canary";
        if (!canary && (row.receipt?.purpose !== "call" || !(await applicable(ctx)))) return false;
        const proof = await guard(ctx, row.bindingId, canary ? ["CANARY"] : ["ACTIVE"], request.digest);
        const q = proof.qualification;
        if (
          proof.binding.generation !== row.bindingGeneration ||
          proof.approval.id !== request.nativeDecisionRef ||
          (canary && proof.approval.runId !== row.runId) ||
          q.runnerId !== admission.runnerId ||
          q.runtimeDigest !== admission.runtimeDigest ||
          q.profileDigest !== admission.profileDigest ||
          q.attestationRef !== admission.attestationRef ||
          hashFoundryInput(q.limits) !== hashFoundryInput(admission.limits)
        )
          return false;
        // Re-read after all external control/evidence calls, before the runner starts.
        const [fresh] = await db.select().from(invocations).where(eq(invocations.id, row.id));
        return (
          !!fresh &&
          fresh.state === "DISPATCHED" &&
          fresh.recoveryRevision === 0 &&
          fresh.fencingToken === request.fencingToken &&
          fresh.leaseUntil > now()
        );
      } catch {
        return false;
      }
    },
    async execute(ctx: ToolContext, input: { bindingId: string; digest: string; input: unknown }) {
      return dispatch(ctx, input.bindingId, input.digest, input.input, false);
    },
    async discover(ctx: ToolContext): Promise<{ candidateId: string; bindingId: string; digest: string }[]> {
      try {
        const current = await foundryContext(db, ctx);
        if (!(await applicable(ctx))) return [];
        const rows = await db
          .select()
          .from(bindings)
          .where(
            and(
              eq(bindings.orgId, ctx.orgId),
              eq(bindings.taskId, current.task.id),
              eq(bindings.agentId, ctx.agentId),
              eq(bindings.personId, current.personId),
              eq(bindings.state, "ACTIVE"),
              isNull(bindings.revokedAt),
            ),
          )
          .orderBy(bindings.id);
        const visible: { candidateId: string; bindingId: string; digest: string }[] = [];
        for (const row of rows) {
          try {
            const p = await guard(ctx, row.id, ["ACTIVE"]);
            visible.push({ candidateId: p.candidate.id, bindingId: p.binding.id, digest: p.version.digest });
          } catch {
            /* filter before any name, description or ranking is exposed */
          }
          if (visible.length === 3) break;
        }
        return visible;
      } catch {
        return [];
      }
    },
    async revoke(ctx: ToolContext, bindingId: string) {
      const current = await foundryContext(db, ctx);
      const [binding] = await db
        .select()
        .from(bindings)
        .where(
          and(
            eq(bindings.orgId, ctx.orgId),
            eq(bindings.id, bindingId),
            eq(bindings.taskId, current.task.id),
            eq(bindings.personId, current.personId),
            eq(bindings.agentId, ctx.agentId),
          ),
        );
      if (!binding) throw new FoundryError("NOT_FOUND");
      await db
        .update(bindings)
        .set({ state: "REVOKED", revokedAt: now(), generation: sql`${bindings.generation} + 1` })
        .where(and(eq(bindings.id, bindingId), isNull(bindings.revokedAt)));
      const pending = await db
        .select()
        .from(invocations)
        .where(
          and(
            eq(invocations.orgId, ctx.orgId),
            eq(invocations.bindingId, bindingId),
            inArray(invocations.state, ["RESERVED", "DISPATCHED", "UNKNOWN_OUTCOME", "RECONCILING"]),
          ),
        );
      for (const row of pending) {
        if (row.state === "RESERVED") {
          const [neverDispatched] = await db
            .update(invocations)
            .set({
              state: "CANCELLED",
              reasonCode: "AUTHORITY_REVOKED",
              recoveryRevision: sql`${invocations.recoveryRevision} + 1`,
              completedAt: now(),
            })
            .where(and(eq(invocations.id, row.id), eq(invocations.orgId, ctx.orgId), eq(invocations.state, "RESERVED")))
            .returning();
          if (neverDispatched) continue;
        }
        const [current] = await db
          .select()
          .from(invocations)
          .where(and(eq(invocations.id, row.id), eq(invocations.orgId, ctx.orgId)));
        if (!current || !["DISPATCHED", "UNKNOWN_OUTCOME", "RECONCILING"].includes(current.state)) continue;
        const stopped = await executor
          .cancel(current.id, current.fencingToken)
          .then(
            (r) =>
              r.outcome === "CANCELLED" &&
              r.invocationId === row.id &&
              r.fencingToken === row.fencingToken &&
              r.processTreeTerminated,
          )
          .catch(() => false);
        await db
          .update(invocations)
          .set({
            state: stopped ? "CANCELLED" : "UNKNOWN_OUTCOME",
            reasonCode: "AUTHORITY_REVOKED",
            recoveryRevision: sql`${invocations.recoveryRevision} + 1`,
            completedAt: stopped ? now() : null,
          })
          .where(
            and(
              eq(invocations.id, row.id),
              eq(invocations.orgId, ctx.orgId),
              inArray(invocations.state, ["RESERVED", "DISPATCHED", "UNKNOWN_OUTCOME", "RECONCILING"]),
            ),
          );
      }
      return { revoked: true };
    },
    /** Native outbox handler only. Never retries candidate execution or releases recovered output to a model. */
    async reconcile(orgId: string, invocationId: string, owned: () => Promise<boolean> = async () => true) {
      if (!(await owned())) return { outcome: "UNKNOWN_OUTCOME" as const };
      const [row] = await db
        .select()
        .from(invocations)
        .where(and(eq(invocations.orgId, orgId), eq(invocations.id, invocationId)));
      if (
        row &&
        row.leaseUntil <= now() &&
        ["SUCCEEDED", "FAILED", "CANCELLED"].includes(row.state) &&
        row.receipt?.purpose === "canary"
      ) {
        const ctx = await nativeContextFor(row);
        const canary = await completeCanary(ctx, row, owned);
        return { outcome: row.state, canary: canary.outcome };
      }
      if (
        !row ||
        !["RESERVED", "DISPATCHED", "UNKNOWN_OUTCOME", "RECONCILING"].includes(row.state) ||
        row.leaseUntil > now()
      )
        return { outcome: row?.state ?? "UNKNOWN_OUTCOME" };
      const [claim] = await db
        .update(invocations)
        .set({
          state: "RECONCILING",
          recoveryRevision: row.recoveryRevision + 1,
          leaseUntil: new Date(now().getTime() + 30_000),
        })
        .where(
          and(
            eq(invocations.id, row.id),
            eq(invocations.orgId, orgId),
            eq(invocations.recoveryRevision, row.recoveryRevision),
            eq(invocations.state, row.state),
          ),
        )
        .returning();
      if (!claim) return { outcome: "UNKNOWN_OUTCOME" as const };
      if (row.state === "RESERVED") {
        await db
          .update(invocations)
          .set({ state: "CANCELLED", reasonCode: "DISPATCH_NOT_PROVEN", completedAt: now() })
          .where(and(eq(invocations.id, row.id), eq(invocations.recoveryRevision, claim.recoveryRevision)));
        return { outcome: "CANCELLED" as const };
      }
      const result = await executor.reconcile(invocationId).catch(() => ({
        outcome: "UNKNOWN_OUTCOME" as const,
        receiptRef: null,
        reconciliationRef: invocationId,
      }));
      if (!(await owned())) return { outcome: "UNKNOWN_OUTCOME" as const };
      const ctx = await nativeContextFor(row);
      const completed = await finish(ctx, row, result, claim.recoveryRevision);
      if (completed.outcome !== "UNKNOWN_OUTCOME" && row.receipt?.purpose === "canary") {
        const [terminal] = await db
          .select()
          .from(invocations)
          .where(and(eq(invocations.id, row.id), eq(invocations.orgId, orgId)));
        if (terminal) await completeCanary(ctx, terminal, owned);
      }
      // Recovered output does not wake another run. The original native task keeps its truthful outcome receipt.
      return { outcome: completed.outcome };
    },
    /** Soft retirement only. Referenced versions and recovery evidence are never deleted. */
    async retire(ctx: ToolContext, versionId: string) {
      const [version] = await db
        .select()
        .from(versions)
        .where(and(eq(versions.orgId, ctx.orgId), eq(versions.id, versionId)));
      if (!version) throw new FoundryError("NOT_FOUND");
      await ownedCandidate(db, ctx, version.candidateId);
      const referenced = await db
        .select({ id: bindings.id })
        .from(bindings)
        .where(and(eq(bindings.orgId, ctx.orgId), eq(bindings.versionId, versionId)))
        .limit(1);
      if (referenced.length || version.state === "EVALUATING") throw new FoundryError("REFERENCED_VERSION");
      await db.update(versions).set({ state: "RETIRED", retiredAt: now() }).where(eq(versions.id, versionId));
      return { retired: true };
    },
  };
  return api;
}
