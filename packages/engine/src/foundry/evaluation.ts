import type {
  FoundryAdmission,
  FoundryEvaluationResult,
  FoundryExecutor,
  FoundryFrozenVersion,
  FoundryQualification,
} from "@agenteschat/adapters";
import { and, type Executor, eq, schema, sql } from "@agenteschat/db";
import { enqueue, lockJobClaim, type OutboxJob } from "../outbox";
import { resumeWaitingRunWithResult } from "../run-resume";
import { freshGrantedKeys, isAllowed, toolAccess } from "../tools/scopes";
import type { ToolContext } from "../tools/types";
import type { FoundryExecutionPolicy } from "./execution-policy";
import type { FrozenPackage } from "./packages";
import {
  type FoundryCandidate,
  type FoundryDependencies,
  FoundryError,
  type FoundryVersion,
  loadFoundryBundle,
  ownedCandidate,
} from "./service";

export const FOUNDRY_EVALUATE_JOB = "foundry.evaluate";
const { foundryVersions: versions, foundryCandidates: candidates, agentRuns } = schema;
type Qualification = Extract<FoundryQualification, { qualified: true }>;
interface EvaluationJob extends Record<string, unknown> {
  waitId: string;
  runId: string;
  toolUseId: string;
  state: "QUEUED" | "DISPATCHED" | "TERMINAL";
  revision: number;
  deadline: string;
  qualificationRef: string;
  builderPolicyDigest: string;
  runtimeDigest: string;
  profileDigest: string;
  delivered?: boolean;
  reasonCode?: string;
  receiptRef?: string;
}
interface EvaluationDependencies extends FoundryDependencies {
  executor: FoundryExecutor;
  builderPolicy?: FoundryExecutionPolicy;
  now(): Date;
  qualified(): Promise<Qualification>;
  requireLimits(bundle: FrozenPackage, qualification: Qualification): void;
  verifyEvidence(
    candidate: FoundryCandidate,
    version: FoundryVersion,
    qualification: Qualification,
    receiptRef: string,
  ): Promise<{ evaluatorId: string }>;
}
function jobOf(version: FoundryVersion): EvaluationJob | null {
  const job = version.evaluationJob;
  if (
    !job ||
    typeof job.waitId !== "string" ||
    typeof job.runId !== "string" ||
    typeof job.toolUseId !== "string" ||
    !Number.isSafeInteger(job.revision) ||
    !["QUEUED", "DISPATCHED", "TERMINAL"].includes(String(job.state)) ||
    typeof job.deadline !== "string" ||
    !Number.isFinite(Date.parse(job.deadline)) ||
    typeof job.qualificationRef !== "string" ||
    typeof job.runtimeDigest !== "string" ||
    typeof job.profileDigest !== "string"
  )
    return null;
  return job as EvaluationJob;
}

/** Evaluation uses the existing native outbox and pending tool checkpoint. No detached tasks or model sessions. */
export function createDurableFoundryEvaluation(deps: EvaluationDependencies) {
  const { db, executor, now } = deps;
  const pending = (job: EvaluationJob) => ({
    state: "EVALUATING",
    pause: { kind: "foundry_evaluation", id: job.waitId },
  });
  async function allowed(tx: Executor, ctx: ToolContext) {
    const keys = await freshGrantedKeys(tx, ctx.orgId, ctx.agentId);
    if (!isAllowed(toolAccess(keys, { name: "evaluate_foundry_capability", scope: "sandbox:run" })))
      throw new FoundryError("AUTHORITY_DENIED");
  }
  async function begin(ctx: ToolContext, input: { candidateId: string; digest: string }) {
    if (!ctx.toolUseId) throw new FoundryError("SCHEMA_INVALID");
    const current = await ownedCandidate(db, ctx, input.candidateId);
    await allowed(db, ctx);
    const [version] = await db
      .select()
      .from(versions)
      .where(
        and(
          eq(versions.orgId, ctx.orgId),
          eq(versions.candidateId, input.candidateId),
          eq(versions.digest, input.digest),
        ),
      );
    if (!version || version.retiredAt) throw new FoundryError("NOT_FOUND");
    const protection = await deps.builderPolicy?.protection(ctx);
    if (!protection) return { state: "BLOCKED", code: "BLOCKED_BUILDER_ISOLATION" };
    let q: Qualification;
    try {
      q = await deps.qualified();
      deps.requireLimits(await loadFoundryBundle(deps, version), q);
    } catch {
      return { state: "BLOCKED", code: "BLOCKED_SANDBOX" };
    }
    if (version.state === "REVIEW_READY" && version.evaluationRef) {
      await deps.verifyEvidence(current.candidate, version, q, version.evaluationRef);
      return { state: "REVIEW_READY" };
    }
    return db.transaction(async (tx) => {
      await tx
        .select({ id: schema.issues.id })
        .from(schema.issues)
        .where(eq(schema.issues.id, current.task.id))
        .for("update");
      await ownedCandidate(tx, ctx, input.candidateId);
      await allowed(tx, ctx);
      const [locked] = await tx.select().from(versions).where(eq(versions.id, version.id)).for("update");
      if (!locked || locked.retiredAt) throw new FoundryError("STALE_VERSION");
      const existing = jobOf(locked);
      if (
        existing &&
        locked.state === "EVALUATING" &&
        existing.runId === ctx.runId &&
        existing.toolUseId === ctx.toolUseId
      )
        return pending(existing);
      if (locked.state !== "DRAFT" || existing) return { state: "BLOCKED", code: "EVALUATION_IN_PROGRESS_OR_UNKNOWN" };
      const job: EvaluationJob = {
        waitId: `foundry-evaluation:${ctx.orgId}:${version.id}`,
        runId: ctx.runId,
        toolUseId: ctx.toolUseId!,
        state: "QUEUED",
        revision: 0,
        deadline: new Date(now().getTime() + 5 * 60_000).toISOString(),
        builderPolicyDigest: protection.policyDigest,
        qualificationRef: q.attestationRef,
        runtimeDigest: q.runtimeDigest,
        profileDigest: q.profileDigest,
      };
      await tx
        .update(versions)
        .set({
          state: "EVALUATING",
          evaluationJob: job,
          runtimeDigest: q.runtimeDigest,
          profileDigest: q.profileDigest,
        })
        .where(eq(versions.id, version.id));
      await tx
        .update(candidates)
        .set({ state: "EVALUATING", reasonCode: null, updatedAt: now() })
        .where(eq(candidates.id, input.candidateId));
      await enqueue(tx, {
        orgId: ctx.orgId,
        kind: FOUNDRY_EVALUATE_JOB,
        payload: { versionId: version.id, waitId: job.waitId },
        dedupeKey: job.waitId,
        runAt: new Date(now().getTime() + 1000),
        maxAttempts: 4,
      });
      return pending(job);
    });
  }
  async function context(version: FoundryVersion, job: EvaluationJob): Promise<ToolContext> {
    const [run] = await db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.id, job.runId), eq(agentRuns.orgId, version.orgId)));
    if (!run) throw new FoundryError("AUTHORITY_DENIED");
    return {
      db,
      orgId: version.orgId,
      agentId: run.agentId,
      runId: run.id,
      channelId: run.channelId,
      threadRootId: run.threadRootId,
      triggerMessageId: run.triggerMessageId,
      toolUseId: job.toolUseId,
    };
  }
  async function checkpoint(tx: Executor, ctx: ToolContext, version: FoundryVersion, job: EvaluationJob) {
    await allowed(tx, ctx);
    const protection = await deps.builderPolicy?.protection(ctx, "active", tx);
    if (!protection || protection.policyDigest !== job.builderPolicyDigest)
      throw new FoundryError("BLOCKED_BUILDER_ISOLATION");
    return ownedCandidate(tx, ctx, version.candidateId, { waitId: job.waitId, toolUseId: job.toolUseId });
  }
  async function owns(claim: OutboxJob, version: FoundryVersion, job: EvaluationJob) {
    return db.transaction(async (tx) => {
      if (!(await lockJobClaim(tx, claim, now()))) return false;
      const [row] = await tx.select().from(versions).where(eq(versions.id, version.id)).for("update");
      const current = row && jobOf(row);
      return (
        !!current &&
        current.waitId === job.waitId &&
        current.runId === job.runId &&
        current.toolUseId === job.toolUseId &&
        current.revision === job.revision &&
        current.state !== "TERMINAL"
      );
    });
  }
  async function cancelOwned(claim: OutboxJob, version: FoundryVersion, job: EvaluationJob) {
    if (!(await owns(claim, version, job))) throw new FoundryError("STALE_FENCE");
    return executor.cancelEvaluation(job.waitId);
  }
  async function finish(
    claim: OutboxJob,
    version: FoundryVersion,
    job: EvaluationJob,
    ctx: ToolContext,
    state: "REVIEW_READY" | "BLOCKED",
    code: string | null,
    receiptRef?: string,
  ) {
    return db.transaction(async (tx) => {
      if (!(await lockJobClaim(tx, claim, now()))) throw new FoundryError("STALE_FENCE");
      const [locked] = await tx.select().from(versions).where(eq(versions.id, version.id)).for("update");
      const currentJob = locked && jobOf(locked);
      if (
        !currentJob ||
        currentJob.revision !== job.revision ||
        currentJob.state === "TERMINAL" ||
        currentJob.waitId !== job.waitId ||
        currentJob.runId !== job.runId ||
        currentJob.toolUseId !== job.toolUseId ||
        currentJob.runtimeDigest !== job.runtimeDigest ||
        currentJob.profileDigest !== job.profileDigest ||
        currentJob.qualificationRef !== job.qualificationRef
      )
        return;
      const eligibleVersion = locked!.state === "EVALUATING" && !locked!.retiredAt;
      let authorized = false;
      try {
        await checkpoint(tx, ctx, version, job);
        authorized = true;
      } catch {
        /* no wake after authority loss */
      }
      const outcome = authorized && eligibleVersion ? state : "BLOCKED";
      const reason = !eligibleVersion ? "STALE_VERSION" : authorized ? code : "AUTHORITY_CHANGED";
      const content = JSON.stringify({ state: outcome, ...(reason ? { code: reason } : {}), digest: version.digest });
      const delivered =
        authorized && eligibleVersion
          ? await resumeWaitingRunWithResult(tx, {
              orgId: version.orgId,
              runId: job.runId,
              waitId: job.waitId,
              toolUseId: job.toolUseId,
              result: { content, isError: outcome !== "REVIEW_READY" },
            })
          : null;
      if (authorized && eligibleVersion && !delivered) throw new FoundryError("CHECKPOINT_NOT_READY");
      await tx
        .update(versions)
        .set({
          ...(eligibleVersion ? { state: outcome, evaluationRef: outcome === "REVIEW_READY" ? receiptRef : null } : {}),
          evaluationJob: {
            ...job,
            state: "TERMINAL",
            revision: job.revision + 1,
            delivered: !!delivered,
            ...(reason ? { reasonCode: reason } : {}),
            ...(receiptRef ? { receiptRef } : {}),
          },
        })
        .where(eq(versions.id, version.id));
      // Quarantine/retirement belongs to its current owner. A late evaluator
      // may close its own job, but must not consume that owner's checkpoint or
      // overwrite the candidate state with the old evaluation outcome.
      if (eligibleVersion)
        await tx
          .update(candidates)
          .set({ state: outcome, reasonCode: reason, revision: sql`${candidates.revision} + 1`, updatedAt: now() })
          .where(eq(candidates.id, version.candidateId));
    });
  }
  async function run(claim: OutboxJob, finalAttempt = false) {
    if (!claim.orgId || typeof claim.payload.versionId !== "string") throw new FoundryError("SCHEMA_INVALID");
    const [version] = await db
      .select()
      .from(versions)
      .where(and(eq(versions.id, claim.payload.versionId), eq(versions.orgId, claim.orgId)));
    let job = version && jobOf(version);
    if (!version || !job || job.waitId !== claim.payload.waitId || job.state === "TERMINAL") return;
    const ctx = await context(version, job);
    try {
      await checkpoint(db, ctx, version, job);
    } catch {
      const [run] = await db.select({ status: agentRuns.status }).from(agentRuns).where(eq(agentRuns.id, job.runId));
      if (
        run?.status === "running" &&
        job.state === "QUEUED" &&
        !finalAttempt &&
        now().getTime() < Date.parse(job.deadline)
      )
        throw new FoundryError("CHECKPOINT_NOT_READY");
      await cancelOwned(claim, version, job);
      await finish(claim, version, job, ctx, "BLOCKED", "AUTHORITY_CHANGED");
      return;
    }
    let q: Qualification;
    try {
      q = await deps.qualified();
      deps.requireLimits(await loadFoundryBundle(deps, version), q);
      if (
        q.runtimeDigest !== job.runtimeDigest ||
        q.profileDigest !== job.profileDigest ||
        q.attestationRef !== job.qualificationRef
      )
        throw new FoundryError("RUNTIME_DRIFT");
    } catch {
      await cancelOwned(claim, version, job);
      await finish(claim, version, job, ctx, "BLOCKED", "BLOCKED_SANDBOX");
      return;
    }
    const dispatch = job.state === "QUEUED";
    const claimed = await db.transaction(async (tx) => {
      if (!(await lockJobClaim(tx, claim, now()))) throw new FoundryError("STALE_FENCE");
      await checkpoint(tx, ctx, version, job!);
      const [locked] = await tx.select().from(versions).where(eq(versions.id, version.id)).for("update");
      const currentJob = locked && jobOf(locked);
      if (
        !currentJob ||
        currentJob.revision !== job!.revision ||
        currentJob.state === "TERMINAL" ||
        locked!.state !== "EVALUATING" ||
        locked!.retiredAt
      )
        return null;
      const next: EvaluationJob = { ...currentJob, state: "DISPATCHED", revision: currentJob.revision + 1 };
      await tx.update(versions).set({ evaluationJob: next }).where(eq(versions.id, version.id));
      return next;
    });
    if (!claimed) return;
    job = claimed;
    let receipt: FoundryEvaluationResult;
    try {
      // Only the first durable transition may submit. Every retry only reads the same evaluator job.
      if (!(await owns(claim, version, job))) throw new FoundryError("STALE_FENCE");
      receipt =
        dispatch && now().getTime() < Date.parse(job.deadline)
          ? await executor.evaluate(
              {
                orgId: version.orgId,
                candidateId: version.candidateId,
                digest: version.digest,
                manifestRef: version.id,
                dispatchAuthority: {
                  outboxId: claim.id,
                  attempt: claim.attempts,
                  lockedBy: claim.lockedBy!,
                  evaluationRevision: job.revision,
                  runId: job.runId,
                  toolUseId: job.toolUseId,
                },
              },
              job.waitId,
            )
          : await executor.reconcileEvaluation(job.waitId);
    } catch (error) {
      if (error instanceof FoundryError && error.code === "STALE_FENCE") throw error;
      receipt = {
        outcome: "UNKNOWN_OUTCOME",
        evaluatorJobRef: job.waitId,
        receiptRef: null,
        reconciliationRef: job.waitId,
      };
    }
    if (receipt.outcome === "UNKNOWN_OUTCOME") {
      if (!finalAttempt && now().getTime() < Date.parse(job.deadline))
        throw new FoundryError("EVALUATION_PENDING_RECONCILIATION");
      await cancelOwned(claim, version, job);
      await finish(claim, version, job, ctx, "BLOCKED", "UNKNOWN_OUTCOME");
      return;
    }
    try {
      const fresh = await deps.qualified();
      if (
        fresh.runtimeDigest !== q.runtimeDigest ||
        fresh.profileDigest !== q.profileDigest ||
        fresh.attestationRef !== q.attestationRef
      )
        throw new FoundryError("RUNTIME_DRIFT");
      deps.requireLimits(await loadFoundryBundle(deps, version), fresh);
      if (
        receipt.orgId !== version.orgId ||
        receipt.digest !== version.digest ||
        receipt.evaluatorJobRef !== job.waitId ||
        receipt.runtimeDigest !== q.runtimeDigest ||
        receipt.profileDigest !== q.profileDigest ||
        receipt.qualificationRef !== q.attestationRef ||
        !receipt.processTreeTerminated ||
        receipt.outcome !== "PASS"
      )
        throw new FoundryError(receipt.outcome === "FAIL" ? "EVAL_FAILED" : "EVALUATION_UNVERIFIED");
      const current = await checkpoint(db, ctx, version, job);
      const evidence = await deps.verifyEvidence(current.candidate, version, q, receipt.receiptRef);
      if (evidence.evaluatorId !== receipt.evaluatorRef) throw new FoundryError("EVALUATION_UNVERIFIED");
      const afterEvidence = await deps.qualified();
      if (
        afterEvidence.runtimeDigest !== q.runtimeDigest ||
        afterEvidence.profileDigest !== q.profileDigest ||
        afterEvidence.attestationRef !== q.attestationRef
      )
        throw new FoundryError("RUNTIME_DRIFT");
    } catch (error) {
      await finish(
        claim,
        version,
        job,
        ctx,
        "BLOCKED",
        error instanceof FoundryError ? error.code : "EVALUATION_UNVERIFIED",
        receipt.receiptRef,
      );
      return;
    }
    await finish(claim, version, job, ctx, "REVIEW_READY", null, receipt.receiptRef);
  }
  /** Internal authenticated runner callback; never a model tool. Re-check the
   * original outbox lease, exact checkpoint and native run policy immediately
   * before each real isolated case. A new worker cannot inherit this claim. */
  async function authorizeDispatch(frozen: FoundryFrozenVersion, waitId: string, admission: FoundryAdmission) {
    try {
      const authority = frozen.dispatchAuthority;
      if (!authority) return null;
      const q = await deps.qualified();
      if (
        q.runnerId !== admission.runnerId ||
        q.runtimeDigest !== admission.runtimeDigest ||
        q.profileDigest !== admission.profileDigest ||
        q.attestationRef !== admission.attestationRef
      )
        return null;
      return await db.transaction(async (tx) => {
        const [claim] = await tx
          .select()
          .from(schema.outbox)
          .where(and(eq(schema.outbox.id, authority.outboxId), eq(schema.outbox.orgId, frozen.orgId)));
        if (
          !claim ||
          claim.attempts !== authority.attempt ||
          claim.lockedBy !== authority.lockedBy ||
          claim.kind !== FOUNDRY_EVALUATE_JOB ||
          !(await lockJobClaim(tx, claim, now()))
        )
          return null;
        const [version] = await tx
          .select()
          .from(versions)
          .where(and(eq(versions.id, frozen.manifestRef), eq(versions.orgId, frozen.orgId)));
        const job = version && jobOf(version);
        if (
          !version ||
          !job ||
          version.candidateId !== frozen.candidateId ||
          version.digest !== frozen.digest ||
          version.state !== "EVALUATING" ||
          version.retiredAt ||
          job.state !== "DISPATCHED" ||
          job.waitId !== waitId ||
          job.revision !== authority.evaluationRevision ||
          job.runId !== authority.runId ||
          job.toolUseId !== authority.toolUseId ||
          job.deadline <= now().toISOString() ||
          job.runtimeDigest !== admission.runtimeDigest ||
          job.profileDigest !== admission.profileDigest ||
          job.qualificationRef !== admission.attestationRef ||
          claim.payload.versionId !== version.id ||
          claim.payload.waitId !== waitId
        )
          return null;
        const [run] = await tx
          .select()
          .from(agentRuns)
          .where(and(eq(agentRuns.id, job.runId), eq(agentRuns.orgId, frozen.orgId)));
        if (!run) return null;
        const ctx: ToolContext = {
          db: tx as typeof db,
          orgId: frozen.orgId,
          agentId: run.agentId,
          runId: run.id,
          channelId: run.channelId,
          threadRootId: run.threadRootId,
          triggerMessageId: run.triggerMessageId,
          toolUseId: job.toolUseId,
        };
        await checkpoint(tx, ctx, version, job);
        return (await deps.builderPolicy?.protection(ctx, "active", tx)) ?? null;
      });
    } catch {
      return null;
    }
  }
  return { begin, run, authorizeDispatch };
}
