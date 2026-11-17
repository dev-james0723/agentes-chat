import { createHash } from "node:crypto";
import type { CallCheck, ToolContext } from "../tools/types";

const MAX_AGE_MS = 10_000;
const MAX_REQUEST_BYTES = 128 * 1024;
const SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/;
const REASON = /^[a-z][a-z0-9_]{0,79}$/;

export interface DeliveryCall {
  tool: string;
  scope: string;
  connectionId: string;
  input: Record<string, unknown>;
  inputSchema: Record<string, unknown>;
  /** Actual MCP arguments after the host added its commit signature. */
  wireInput?: Record<string, unknown>;
  ctx: ToolContext;
}

export interface DeliveryRequest extends DeliveryCall {
  phase: "preflight" | "execute";
  /** Exact request binding, not the stable release-operation id. */
  requestKey: string;
}

/**
 * Output of a trusted host verifier, never a tool argument, file, task comment or model-authored receipt.
 * That verifier must collect current native binding, effective grants, trusted checks/review, operation state,
 * existing target lease/fencing and provider precondition itself. This seam does not implement those adapters.
 */
export type NativeDeliveryProof =
  | { decision: "blocked"; reasonCodes: string[] }
  | {
      decision: "eligible";
      requestKey: string;
      orgId: string;
      agentId: string;
      runId: string;
      connectionId: string;
      taskId: string;
      operationId: string;
      repositoryId: string;
      repository: string;
      sourceHead: string;
      targetId: string;
      authorityRef: string;
      leaseRef: string;
      fencingToken: string;
      policyVersion: string;
      evidenceIds: string[];
      observedAt: number;
      expiresAt: number;
    };

declare const nativeGuardBrand: unique symbol;
export interface NativeDeliveryGuard {
  readonly [nativeGuardBrand]: true;
}
type Verifier = {
  verify(request: DeliveryRequest): Promise<NativeDeliveryProof>;
  now?: () => number;
  /** Host may reduce this bound; it cannot extend pre-mutation freshness. */
  verificationTimeoutMs?: number;
};
const verifiers = new WeakMap<NativeDeliveryGuard, Verifier>();
const permits = new WeakMap<object, { guard: NativeDeliveryGuard; requestKey: string; expiresAt: number }>();

/**
 * Server composition only. A returned opaque handle cannot be reconstructed by JSON or a look-alike callback.
 * Never wire `verify` to caller-supplied JSON. Trusted server code can choose dependencies; this is not a sandbox
 * against that code. Without a real native verifier the catalog merge/workflow tools remain fail-closed.
 */
export function createNativeDeliveryGuard(verifier: Verifier): NativeDeliveryGuard {
  if (!verifier || typeof verifier.verify !== "function") throw new TypeError("Native verifier required");
  const timeout = verifier.verificationTimeoutMs ?? MAX_AGE_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_AGE_MS)
    throw new TypeError("Invalid native verification deadline");
  const guard = Object.freeze({}) as NativeDeliveryGuard;
  verifiers.set(guard, { verify: verifier.verify, now: verifier.now, verificationTimeoutMs: timeout });
  return guard;
}

export const guardedDeliveryScope = (scope: string) => scope === "pr.merge" || scope === "actions.run";

function blocked(
  phase: DeliveryRequest["phase"],
  reasons: string[],
  extra: Record<string, unknown> = {},
): CallCheck & { ok: false } {
  const reasonCodes = reasons.filter((r) => typeof r === "string" && REASON.test(r)).slice(0, 12);
  return {
    ok: false,
    message:
      "Delivery Guardian blocked this release action. Its native evidence or target precondition is missing or no longer valid. Continue independent authorized work.",
    data: {
      deliveryGuardian: {
        status: "blocked",
        phase,
        reasonCodes: reasonCodes.length ? reasonCodes : ["native_verification_failed"],
        isAuthorizationGrant: false,
        ...extra,
      },
    },
  };
}

function copyRecord(value: Record<string, unknown>): Record<string, unknown> {
  const check = (v: unknown, depth: number): void => {
    if (depth > 16) throw new Error("Request too deep");
    if (v === null || typeof v === "string" || typeof v === "boolean") return;
    if (typeof v === "number" && Number.isFinite(v)) return;
    if (Array.isArray(v)) {
      if (v.length > 256) throw new Error("Request too wide");
      for (const x of v) check(x, depth + 1);
      return;
    }
    if (typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
      const keys = Object.keys(v);
      if (keys.length > 256) throw new Error("Request too wide");
      for (const k of keys) check((v as Record<string, unknown>)[k], depth + 1);
      return;
    }
    throw new Error("Non-JSON request");
  };
  check(value, 0);
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > MAX_REQUEST_BYTES) throw new Error("Request too large");
  const copied = JSON.parse(text) as Record<string, unknown>;
  const freeze = (v: unknown): void => {
    if (v && typeof v === "object") {
      for (const x of Object.values(v)) freeze(x);
      Object.freeze(v);
    }
  };
  freeze(copied);
  return copied;
}

function requestOf(call: DeliveryCall, phase: DeliveryRequest["phase"]): DeliveryRequest {
  const input = copyRecord(call.input);
  const wireInput = copyRecord(call.wireInput ?? call.input);
  const inputSchema = copyRecord(call.inputSchema);
  const { orgId, agentId, runId, toolUseId, bridge } = call.ctx;
  const requestKey = createHash("sha256")
    .update(
      JSON.stringify({
        tool: call.tool,
        scope: call.scope,
        connectionId: call.connectionId,
        orgId,
        agentId,
        runId,
        toolUseId,
        bridge,
        input,
        wireInput,
        inputSchema,
      }),
    )
    .digest("hex");
  return Object.freeze({
    ...call,
    input,
    wireInput,
    inputSchema,
    ctx: Object.freeze({ ...call.ctx }),
    requestKey,
    phase,
  });
}

function targetReason(r: DeliveryRequest): string | null {
  // Workflow dispatch/re-run lacks a verified immutable target/expected-head adapter here. Never infer one.
  if (r.tool === "actions_run_trigger" && r.scope === "actions.run") return "workflow_target_adapter_unavailable";
  if (r.tool !== "merge_pull_request" || r.scope !== "pr.merge") return "delivery_operation_unsupported";
  if (![r.ctx.orgId, r.ctx.agentId, r.ctx.runId, r.connectionId].every((v) => typeof v === "string" && REF.test(v)))
    return "native_subject_invalid";
  const { owner, repo, pullNumber, sha } = r.input;
  if (
    typeof owner !== "string" ||
    typeof repo !== "string" ||
    !NAME.test(owner) ||
    !NAME.test(repo) ||
    !Number.isSafeInteger(pullNumber) ||
    Number(pullNumber) <= 0
  )
    return "delivery_target_invalid";
  if (typeof sha !== "string" || !SHA.test(sha)) return "expected_head_required";
  const properties = r.inputSchema.properties as Record<string, unknown> | undefined;
  const shaSchema = properties?.sha as Record<string, unknown> | undefined;
  if (r.inputSchema.type !== "object" || shaSchema?.type !== "string") return "expected_head_precondition_unavailable";
  if (
    r.wireInput?.owner !== owner ||
    r.wireInput?.repo !== repo ||
    r.wireInput?.pullNumber !== pullNumber ||
    r.wireInput?.sha !== sha
  )
    return "wire_target_changed";
  return null;
}

type EligibleProof = Extract<NativeDeliveryProof, { decision: "eligible" }>;
function proofReason(proof: NativeDeliveryProof, r: DeliveryRequest, now: number): string | null {
  if (!proof || proof.decision !== "eligible") return "native_verification_failed";
  if (
    proof.requestKey !== r.requestKey ||
    proof.orgId !== r.ctx.orgId ||
    proof.agentId !== r.ctx.agentId ||
    proof.runId !== r.ctx.runId ||
    proof.connectionId !== r.connectionId
  )
    return "native_subject_mismatch";
  if (
    proof.repository !== `${r.input.owner}/${r.input.repo}`.toLowerCase() ||
    proof.sourceHead !== r.input.sha ||
    typeof proof.repositoryId !== "string" ||
    !/^[1-9][0-9]{0,29}$/.test(proof.repositoryId)
  )
    return "native_candidate_mismatch";
  for (const key of [
    "taskId",
    "operationId",
    "targetId",
    "authorityRef",
    "leaseRef",
    "fencingToken",
    "policyVersion",
  ] as const)
    if (typeof proof[key] !== "string" || !REF.test(proof[key])) return "native_binding_incomplete";
  if (
    !Array.isArray(proof.evidenceIds) ||
    proof.evidenceIds.length === 0 ||
    proof.evidenceIds.length > 64 ||
    proof.evidenceIds.some((id) => typeof id !== "string" || !REF.test(id))
  )
    return "native_evidence_missing";
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(proof.observedAt) ||
    !Number.isFinite(proof.expiresAt) ||
    proof.observedAt > now ||
    now - proof.observedAt > MAX_AGE_MS ||
    proof.expiresAt <= now ||
    proof.expiresAt > proof.observedAt + MAX_AGE_MS
  )
    return "native_proof_stale";
  return null;
}

function proofData(proof: EligibleProof, phase: DeliveryRequest["phase"]) {
  return {
    deliveryGuardian: {
      status: "eligible",
      phase,
      taskId: proof.taskId,
      operationId: proof.operationId,
      targetId: proof.targetId,
      repositoryId: proof.repositoryId,
      sourceHead: proof.sourceHead,
      policyVersion: proof.policyVersion,
      evidenceIds: [...proof.evidenceIds],
      isAuthorizationGrant: false,
    },
  };
}

class VerificationStopped extends Error {
  readonly code: "native_verification_timeout" | "delivery_call_aborted";
  constructor(code: "native_verification_timeout" | "delivery_call_aborted") {
    super(code);
    this.code = code;
  }
}

async function boundedVerification(verifier: Verifier, request: DeliveryRequest): Promise<NativeDeliveryProof> {
  const controller = new AbortController();
  const upstream = request.ctx.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    abort = () => {
      controller.abort();
      reject(new VerificationStopped("delivery_call_aborted"));
    };
    if (upstream?.aborted) {
      abort();
      return;
    }
    upstream?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => {
      controller.abort();
      reject(new VerificationStopped("native_verification_timeout"));
    }, verifier.verificationTimeoutMs ?? MAX_AGE_MS);
  });
  try {
    const current = Object.freeze({ ...request, ctx: Object.freeze({ ...request.ctx, signal: controller.signal }) });
    return await Promise.race([stopped, Promise.resolve().then(() => verifier.verify(current))]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) upstream?.removeEventListener("abort", abort);
  }
}

type VerifiedCall =
  | { ok: false; refusal: CallCheck & { ok: false } }
  | { ok: true; guard: NativeDeliveryGuard; request: DeliveryRequest; proof: EligibleProof; verifier: Verifier };
async function verifyCall(
  guard: NativeDeliveryGuard | undefined,
  call: DeliveryCall,
  phase: DeliveryRequest["phase"],
): Promise<VerifiedCall> {
  const verifier = guard && typeof guard === "object" ? verifiers.get(guard) : undefined;
  if (!guard || !verifier) return { ok: false, refusal: blocked(phase, ["native_delivery_adapter_unavailable"]) };
  try {
    if (call.ctx.signal?.aborted) return { ok: false, refusal: blocked(phase, ["delivery_call_aborted"]) };
    const request = requestOf(call, phase);
    const target = targetReason(request);
    if (target) return { ok: false, refusal: blocked(phase, [target]) };
    const proof = await boundedVerification(verifier, request);
    if (proof?.decision === "blocked") return { ok: false, refusal: blocked(phase, proof.reasonCodes) };
    const checkedAt = (verifier.now ?? Date.now)();
    const reason = proofReason(proof, request, checkedAt);
    if (reason) return { ok: false, refusal: blocked(phase, [reason]) };
    if (call.ctx.signal?.aborted) return { ok: false, refusal: blocked(phase, ["delivery_call_aborted"]) };
    if (requestOf(call, phase).requestKey !== request.requestKey)
      return { ok: false, refusal: blocked(phase, ["delivery_call_changed"]) };
    if (proof.decision !== "eligible") return { ok: false, refusal: blocked(phase, ["native_verification_failed"]) };
    return { ok: true, guard, request, proof: { ...proof, evidenceIds: [...proof.evidenceIds] }, verifier };
  } catch (error) {
    return {
      ok: false,
      refusal: blocked(phase, [error instanceof VerificationStopped ? error.code : "native_verification_failed"]),
    };
  }
}

/** The Gateway runs this before approval and re-runs it after approval. It creates no execution permit. */
export async function checkConnectorDelivery(
  guard: NativeDeliveryGuard | undefined,
  call: DeliveryCall,
): Promise<CallCheck> {
  const checked = await verifyCall(guard, call, "preflight");
  if (!checked.ok) return checked.refusal;
  return { ok: true, data: proofData(checked.proof, "preflight") };
}

function unknownOutcome(proof: EligibleProof): CallCheck & { ok: false } {
  return {
    ok: false,
    message:
      "The delivery action was attempted and may have been sent, but its outcome could not be verified. Reconcile the existing operation with the real provider before retrying.",
    data: {
      deliveryGuardian: {
        ...proofData(proof, "execute").deliveryGuardian,
        status: "outcome_unknown",
        reasonCodes: ["outcome_unknown"],
        outcomeVerified: false,
      },
    },
  };
}

/**
 * Call inside the established provider session, after credential acquisition/signing. It verifies again, binds a
 * single-use permit, then invokes the supplied provider operation without another asynchronous preparation step.
 * A transport failure is outcome_unknown, never an instruction to retry. The native verifier must reconcile the
 * stable operation id before it admits a later call. The Gateway's existing approvals/grants remain required.
 */
export async function runConnectorDelivery<T>(
  guard: NativeDeliveryGuard | undefined,
  call: DeliveryCall,
  execute: () => Promise<T>,
): Promise<{ ok: true; value: T; data: Record<string, unknown> } | (CallCheck & { ok: false })> {
  const checked = await verifyCall(guard, call, "execute");
  if (!checked.ok) return checked.refusal;
  const permit = Object.freeze({});
  permits.set(permit, {
    guard: checked.guard,
    requestKey: checked.request.requestKey,
    expiresAt: checked.proof.expiresAt,
  });
  const held = permits.get(permit);
  permits.delete(permit);
  try {
    if (
      !held ||
      held.guard !== guard ||
      held.requestKey !== requestOf(call, "execute").requestKey ||
      held.expiresAt <= (checked.verifier.now ?? Date.now)() ||
      call.ctx.signal?.aborted
    )
      return blocked("execute", ["delivery_permit_lost"]);
  } catch {
    return blocked("execute", ["delivery_permit_lost"]);
  }
  try {
    const value = await execute();
    // MCP may encode a timeout or uncertain effect in an error reply instead of throwing.
    if (value && typeof value === "object" && "isError" in value && value.isError === true)
      return unknownOutcome(checked.proof);
    const data = proofData(checked.proof, "execute");
    return {
      ok: true,
      value,
      data: { deliveryGuardian: { ...data.deliveryGuardian, status: "submitted_unverified", outcomeVerified: false } },
    };
  } catch {
    return unknownOutcome(checked.proof);
  }
}
