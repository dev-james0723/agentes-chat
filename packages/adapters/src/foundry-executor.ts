import { createHash } from "node:crypto";

/**
 * Foundry is a subordinate adapter, not an authority or orchestrator. Native
 * policy, task ownership, publication, fencing and budgets remain in the engine.
 * This module NEVER starts a process or executes candidate code on the host.
 */
export interface FoundryLimits {
  wallTimeMs: number;
  cpuTimeMs: number;
  memoryBytes: number;
  scratchBytes: number;
  maxProcesses: number;
  stdoutBytes: number;
  stderrBytes: number;
  inputBytes: number;
  resultBytes: number;
}

export const FOUNDRY_PURE_TOOL_LIMITS: Readonly<FoundryLimits> = Object.freeze({
  wallTimeMs: 10_000,
  cpuTimeMs: 10_000,
  memoryBytes: 256 * 1024 * 1024,
  scratchBytes: 32 * 1024 * 1024,
  maxProcesses: 32,
  stdoutBytes: 64 * 1024,
  stderrBytes: 64 * 1024,
  inputBytes: 1024 * 1024,
  resultBytes: 1024 * 1024,
});

export const FOUNDRY_REQUIRED_GUARANTEES = [
  "noNetwork",
  "noDns",
  "noMetadata",
  "readOnlyInputs",
  "ephemeralScratchOnly",
  "noHostHome",
  "noHostCredentials",
  "noCloudIdentity",
  "noSockets",
  "sanitizedEnvironment",
  "tenantIsolated",
  "freshScratchPerInvocation",
  "processTreeCancellation",
] as const;

export const FOUNDRY_REQUIRED_PROBES = [
  "network-dns-metadata-denied",
  "readonly-inputs-and-bounded-scratch",
  "host-secrets-and-sockets-denied",
  "tenant-isolation-and-scratch-reset",
  "process-tree-cancellation",
  "cancel-before-dispatch-fencing",
  "wall-and-cpu-limits",
  "memory-disk-process-limits",
  "input-output-limits",
  "runtime-identity",
] as const;

export interface FoundryRuntimeProfile {
  runnerId: string;
  profileRef: string;
  /** Immutable image/module SHA-256, lowercase 64 hex; never a mutable tag. */
  runtimeDigest: string;
  /** Digest of the complete enforced configuration, including mounts/env. */
  configurationDigest: string;
  guarantees: Record<(typeof FOUNDRY_REQUIRED_GUARANTEES)[number], boolean>;
  /** Actual enforced limits, not requested command-line flags. */
  limits: FoundryLimits;
}

export interface FoundryProbeAttestation {
  attestationRef: string;
  authorityId: string;
  runnerId: string;
  runtimeDigest: string;
  profileDigest: string;
  testedAt: string;
  expiresAt: string;
  revoked: boolean;
  probes: {
    name: (typeof FOUNDRY_REQUIRED_PROBES)[number];
    outcome: "PASS" | "FAIL";
    evidenceRef: string;
  }[];
}

export interface FoundryAdmission {
  runnerId: string;
  profileRef: string;
  runtimeDigest: string;
  profileDigest: string;
  configurationDigest: string;
  attestationRef: string;
  expiresAt: string;
  limits: Readonly<FoundryLimits>;
}

export type FoundryQualification =
  | { qualified: false; code: "BLOCKED_SANDBOX"; reason: string }
  | (FoundryAdmission & {
      qualified: true;
      testedAt: string;
      evidenceRefs: readonly string[];
    });

export interface FoundryEvaluationDispatchAuthority {
  outboxId: string;
  attempt: number;
  lockedBy: string;
  evaluationRevision: number;
  runId: string;
  toolUseId: string;
}

export interface FoundryFrozenVersion {
  orgId: string;
  candidateId: string;
  /** The immutable package/version digest, including code and contracts. */
  digest: string;
  manifestRef: string;
  /** Original native outbox claim, never replaced with a newer claim by the transport. */
  dispatchAuthority?: FoundryEvaluationDispatchAuthority;
}

export interface FoundryExecutionRequest {
  orgId: string;
  /** The exact frozen package/version digest. */
  digest: string;
  input: unknown;
  /** hashFoundryInput(input); binds the canonical JSON sent to the runner. */
  inputDigest: string;
  invocationId: string;
  fencingToken: number;
  nativeDecisionRef: string;
  budgetReservationRef: string;
  abort: AbortSignal;
}

export interface FoundryRunnerExecutionRequest extends Omit<FoundryExecutionRequest, "input"> {
  /** Canonical bounded JSON. The adapter must verify its hash before dispatch. */
  inputJson: string;
}

export interface FoundryExecutionReceipt {
  receiptRef: string;
  orgId: string;
  digest: string;
  inputDigest: string;
  invocationId: string;
  fencingToken: number;
  runnerId: string;
  runtimeDigest: string;
  profileDigest: string;
  qualificationRef: string;
  effectiveLimits: FoundryLimits;
  stdoutBytes: number;
  stderrBytes: number;
  processTreeTerminated: boolean;
}

export const FOUNDRY_EXECUTION_FAILURE_CODES = [
  "SCHEMA_INVALID",
  "EVAL_FAILED",
  "RUNNER_UNAVAILABLE",
  "LIMIT_EXCEEDED",
  "STALE_VERSION",
  "LEASE_LOST",
  "NOT_AUTHORIZED",
  "BLOCKED_SANDBOX",
  "APPROVAL_REQUIRED",
  "BUDGET_EXHAUSTED",
  "QUOTA_UNAVAILABLE",
] as const;
export type FoundryExecutionFailureCode = (typeof FOUNDRY_EXECUTION_FAILURE_CODES)[number];

export type FoundryExecutionResult =
  | { outcome: "SUCCEEDED"; output: unknown; receiptRef: string; receipt: FoundryExecutionReceipt }
  | { outcome: "FAILED"; code: FoundryExecutionFailureCode; receiptRef: string; receipt: FoundryExecutionReceipt }
  | { outcome: "CANCELLED"; code: "CANCELLED"; receiptRef: string; receipt: FoundryExecutionReceipt }
  | { outcome: "UNKNOWN_OUTCOME"; receiptRef: string | null; reconciliationRef: string };

export interface FoundryEvaluationReceipt {
  orgId: string;
  digest: string;
  evaluatorJobRef: string;
  evaluatorRef: string;
  runtimeDigest: string;
  profileDigest: string;
  qualificationRef: string;
  effectiveLimits: FoundryLimits;
  outcome: "PASS" | "FAIL" | "BLOCKED";
  evidenceRefs: readonly string[];
  receiptRef: string;
  /** A wall timer or transport completion is not proof that children stopped. */
  processTreeTerminated: boolean;
}

export interface FoundryUnknownEvaluationOutcome {
  outcome: "UNKNOWN_OUTCOME";
  evaluatorJobRef: string;
  receiptRef: string | null;
  reconciliationRef: string;
}

export type FoundryEvaluationResult = FoundryEvaluationReceipt | FoundryUnknownEvaluationOutcome;
export type FoundryEvaluationCancellationResult =
  | { outcome: "CANCELLED"; evaluatorJobRef: string; receiptRef: string; processTreeTerminated: true }
  | FoundryUnknownEvaluationOutcome;

export type FoundryCancellationResult =
  | {
      outcome: "CANCELLED";
      invocationId: string;
      fencingToken: number;
      receiptRef: string;
      processTreeTerminated: true;
    }
  | {
      outcome: "UNKNOWN_OUTCOME";
      invocationId: string;
      fencingToken: number;
      receiptRef: string | null;
      reconciliationRef: string;
    };

export type FoundryExecutorErrorCode =
  | "BLOCKED_SANDBOX"
  | "SCHEMA_INVALID"
  | "CANCELLED"
  | "RUNNER_UNAVAILABLE"
  | "UNKNOWN_OUTCOME";

export class FoundryExecutorError extends Error {
  constructor(
    public readonly code: FoundryExecutorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "FoundryExecutorError";
  }
}

export interface FoundryExecutor {
  qualify(): Promise<FoundryQualification>;
  evaluate(version: FoundryFrozenVersion, evaluatorJobRef: string): Promise<FoundryEvaluationReceipt>;
  execute(request: FoundryExecutionRequest): Promise<FoundryExecutionResult>;
  cancel(invocationId: string, fencingToken: number): Promise<FoundryCancellationResult>;
  reconcile(invocationId: string): Promise<FoundryExecutionResult>;
  cancelEvaluation(evaluatorJobRef: string): Promise<FoundryEvaluationCancellationResult>;
  reconcileEvaluation(evaluatorJobRef: string): Promise<FoundryEvaluationResult>;
}

/**
 * SERVER-ONLY trusted adapter boundary. Implementations authenticate evidence,
 * enforce builder/evaluator separation, and resolve revocation from protected
 * storage. Candidate metadata, a self-reported PASS, or a qualified=true flag
 * must never implement this interface. An in-memory fake proves no isolation.
 */
export interface TrustedFoundryQualificationStore {
  readonly authorityId: string;
  read(identity: {
    runnerId: string;
    runtimeDigest: string;
    profileDigest: string;
  }): Promise<FoundryProbeAttestation | null>;
}

/**
 * SERVER-ONLY isolated runner. A concrete adapter must be independently probed.
 * It atomically rechecks the pinned admission and expiry at dispatch, verifies
 * package/input bytes, enforces every limit at source (including capture), and
 * stops the entire process tree. It receives no host environment or credentials.
 * evaluate resolves a protected evaluator job under a separate identity; neither
 * candidate tests nor the runner itself may manufacture a PASS evaluation.
 * Cancellation acknowledgement requires a DURABLE cancel-before-dispatch
 * tombstone for the exact invocation/fence (or evaluator job), atomically checked
 * at dispatch and after restart. A stopped current process without that fence is
 * not CANCELLED. Independently probe this on every concrete runtime profile.
 * These contracts and fake tests do not prove any real process was stopped.
 * Control operations are nonblocking and bounded; both reconciliation methods
 * are read-only and never dispatch/replay work. Historical receipts survive drift.
 */
export interface TrustedFoundryRunner {
  currentProfile(): Promise<FoundryRuntimeProfile>;
  execute(request: FoundryRunnerExecutionRequest, admission: FoundryAdmission): Promise<FoundryExecutionResult>;
  evaluate(
    version: FoundryFrozenVersion,
    evaluatorJobRef: string,
    admission: FoundryAdmission,
  ): Promise<FoundryEvaluationReceipt>;
  cancel(invocationId: string, fencingToken: number): Promise<FoundryCancellationResult>;
  reconcile(invocationId: string): Promise<FoundryExecutionResult>;
  cancelEvaluation(evaluatorJobRef: string): Promise<FoundryEvaluationCancellationResult>;
  reconcileEvaluation(evaluatorJobRef: string): Promise<FoundryEvaluationResult>;
}

export interface QualifiedFoundryExecutorOptions {
  runner: TrustedFoundryRunner;
  qualifications: TrustedFoundryQualificationStore;
  now?: () => number;
  /** Server configuration only. Each control call is bounded (default 1 s, ceiling 10 s). */
  controlTimeoutMs?: number;
  /** Whole protected evaluation batch; each candidate invocation keeps its own resource limits. */
  evaluationTimeoutMs?: number;
}

const SHA256 = /^[a-f0-9]{64}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: Rejecting control bytes in untrusted receipt references is intentional.
const REFERENCE = /^[^\u0000-\u001f\u007f]{1,512}$/;
const LIMIT_KEYS = Object.keys(FOUNDRY_PURE_TOOL_LIMITS) as (keyof FoundryLimits)[];

function invalidInput(): never {
  throw new FoundryExecutorError("SCHEMA_INVALID", "Expected bounded plain JSON and valid invocation references.");
}

function validRef(value: unknown): value is string {
  return typeof value === "string" && REFERENCE.test(value);
}

function validDigest(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

function validFence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function limitsWithin(value: FoundryLimits, ceilings: Readonly<FoundryLimits>): boolean {
  return (
    !!value &&
    LIMIT_KEYS.every((key) => Number.isSafeInteger(value[key]) && value[key] > 0 && value[key] <= ceilings[key])
  );
}

/** No getters/toJSON, non-JSON values, cycles or excessive nesting are evaluated. */
function canonicalJson(input: unknown, maxBytes: number): string {
  let bytes = 0;
  const chunks: string[] = [];
  const ancestors = new Set<object>();
  const append = (text: string): void => {
    bytes += Buffer.byteLength(text, "utf8");
    if (bytes > maxBytes) invalidInput();
    chunks.push(text);
  };
  const quoted = (text: string): string => {
    if (Buffer.byteLength(text, "utf8") > maxBytes) invalidInput();
    return JSON.stringify(text);
  };
  const visit = (value: unknown, depth: number): void => {
    if (depth > 64) invalidInput();
    if (value === null) {
      append("null");
      return;
    }
    if (typeof value === "string") {
      append(quoted(value));
      return;
    }
    if (typeof value === "boolean") {
      append(value ? "true" : "false");
      return;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) invalidInput();
      append(JSON.stringify(value));
      return;
    }
    if (typeof value !== "object" || ancestors.has(value)) invalidInput();
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (!array && prototype !== Object.prototype && prototype !== null) invalidInput();
    if (array && prototype !== Array.prototype) invalidInput();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).length > 0) invalidInput();
    const keys = Object.keys(descriptors);
    for (const key of keys) {
      const descriptor = descriptors[key]!;
      if (!("value" in descriptor) || (!descriptor.enumerable && !(array && key === "length"))) invalidInput();
    }
    ancestors.add(value);
    if (array) {
      const length = descriptors.length?.value as number;
      if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes) invalidInput();
      if (keys.length !== length + 1) invalidInput();
      append("[");
      for (let index = 0; index < length; index++) {
        if (index > 0) append(",");
        const descriptor = descriptors[String(index)];
        if (!descriptor) invalidInput();
        visit(descriptor.value, depth + 1);
      }
      append("]");
    } else {
      append("{");
      keys.sort().forEach((key, index) => {
        if (index > 0) append(",");
        append(quoted(key));
        append(":");
        visit(descriptors[key]!.value, depth + 1);
      });
      append("}");
    }
    ancestors.delete(value);
  };
  visit(input, 0);
  return chunks.join("");
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function hashFoundryInput(input: unknown): string {
  return sha256(canonicalJson(input, FOUNDRY_PURE_TOOL_LIMITS.inputBytes));
}

/** All profile fields (including additional adapter fields) contribute to drift. */
export function hashFoundryRuntimeProfile(profile: FoundryRuntimeProfile): string {
  return sha256(canonicalJson(profile, 64 * 1024));
}

function unknownOutcome(invocationId: string): FoundryExecutionResult {
  return { outcome: "UNKNOWN_OUTCOME", receiptRef: null, reconciliationRef: invocationId };
}

function unknownCancellation(invocationId: string, fencingToken: number): FoundryCancellationResult {
  return { outcome: "UNKNOWN_OUTCOME", invocationId, fencingToken, receiptRef: null, reconciliationRef: invocationId };
}

function unknownEvaluationOutcome(evaluatorJobRef: string): FoundryUnknownEvaluationOutcome {
  return { outcome: "UNKNOWN_OUTCOME", evaluatorJobRef, receiptRef: null, reconciliationRef: evaluatorJobRef };
}

export function createUnavailableFoundryExecutor(): FoundryExecutor {
  const reason = "No qualified isolated executor is configured.";
  const blocked = (): never => {
    throw new FoundryExecutorError("BLOCKED_SANDBOX", reason);
  };
  return {
    async qualify() {
      return { qualified: false, code: "BLOCKED_SANDBOX", reason };
    },
    async execute() {
      return blocked();
    },
    async evaluate() {
      return blocked();
    },
    async cancel(invocationId, fencingToken) {
      return unknownCancellation(invocationId, fencingToken);
    },
    async reconcile(invocationId) {
      return unknownOutcome(invocationId);
    },
    async cancelEvaluation(evaluatorJobRef) {
      return unknownEvaluationOutcome(evaluatorJobRef);
    },
    async reconcileEvaluation(evaluatorJobRef) {
      return unknownEvaluationOutcome(evaluatorJobRef);
    },
  };
}

function validTerminalResult(
  result: FoundryExecutionResult,
  invocationId: string,
  expected?: { request: FoundryRunnerExecutionRequest; admission: FoundryAdmission },
): boolean {
  if (!result || result.outcome === "UNKNOWN_OUTCOME") return false;
  if (!["SUCCEEDED", "FAILED", "CANCELLED"].includes(result.outcome)) return false;
  const receipt = result.receipt;
  if (
    !receipt ||
    !validRef(result.receiptRef) ||
    receipt.receiptRef !== result.receiptRef ||
    receipt.invocationId !== invocationId ||
    !validRef(receipt.orgId) ||
    !validDigest(receipt.digest) ||
    !validDigest(receipt.inputDigest) ||
    !validFence(receipt.fencingToken) ||
    !validRef(receipt.runnerId) ||
    !validDigest(receipt.runtimeDigest) ||
    !validDigest(receipt.profileDigest) ||
    !validRef(receipt.qualificationRef) ||
    receipt.processTreeTerminated !== true ||
    !limitsWithin(receipt.effectiveLimits, expected?.admission.limits ?? FOUNDRY_PURE_TOOL_LIMITS)
  )
    return false;
  for (const key of ["stdoutBytes", "stderrBytes"] as const) {
    if (!Number.isSafeInteger(receipt[key]) || receipt[key] < 0 || receipt[key] > receipt.effectiveLimits[key])
      return false;
  }
  if (expected) {
    const { request, admission } = expected;
    if (
      receipt.orgId !== request.orgId ||
      receipt.digest !== request.digest ||
      receipt.inputDigest !== request.inputDigest ||
      receipt.fencingToken !== request.fencingToken ||
      receipt.runnerId !== admission.runnerId ||
      receipt.runtimeDigest !== admission.runtimeDigest ||
      receipt.profileDigest !== admission.profileDigest ||
      receipt.qualificationRef !== admission.attestationRef
    )
      return false;
  }
  if (result.outcome === "SUCCEEDED") {
    canonicalJson(result.output, receipt.effectiveLimits.resultBytes);
  } else if (result.outcome === "CANCELLED") {
    if (result.code !== "CANCELLED") return false;
  } else if (!FOUNDRY_EXECUTION_FAILURE_CODES.includes(result.code)) {
    return false;
  }
  return true;
}

function validEvaluationReceipt(
  receipt: FoundryEvaluationResult,
  evaluatorJobRef: string,
  expected?: { version: FoundryFrozenVersion; admission: FoundryAdmission },
): receipt is FoundryEvaluationReceipt {
  if (
    !receipt ||
    receipt.outcome === "UNKNOWN_OUTCOME" ||
    !["PASS", "FAIL", "BLOCKED"].includes(receipt.outcome) ||
    receipt.evaluatorJobRef !== evaluatorJobRef ||
    !validRef(receipt.orgId) ||
    !validDigest(receipt.digest) ||
    !validRef(receipt.evaluatorRef) ||
    !validDigest(receipt.runtimeDigest) ||
    !validDigest(receipt.profileDigest) ||
    !validRef(receipt.qualificationRef) ||
    !validRef(receipt.receiptRef) ||
    receipt.processTreeTerminated !== true ||
    !limitsWithin(receipt.effectiveLimits, expected?.admission.limits ?? FOUNDRY_PURE_TOOL_LIMITS) ||
    !Array.isArray(receipt.evidenceRefs) ||
    receipt.evidenceRefs.length === 0 ||
    receipt.evidenceRefs.length > 128 ||
    !receipt.evidenceRefs.every(validRef)
  )
    return false;
  return (
    !expected ||
    (receipt.orgId === expected.version.orgId &&
      receipt.digest === expected.version.digest &&
      receipt.runtimeDigest === expected.admission.runtimeDigest &&
      receipt.profileDigest === expected.admission.profileDigest &&
      receipt.qualificationRef === expected.admission.attestationRef)
  );
}

/**
 * This factory checks authenticated adapter evidence; it does not establish an
 * isolation boundary by itself. Do not construct it from request/candidate data.
 * A concrete independently qualified runner is intentionally not shipped here.
 */
export function createQualifiedFoundryExecutor(options: QualifiedFoundryExecutorOptions): FoundryExecutor {
  if (options.evaluationTimeoutMs !== undefined && (!Number.isSafeInteger(options.evaluationTimeoutMs) ||
    options.evaluationTimeoutMs < 1 || options.evaluationTimeoutMs > 120_000))
    throw new FoundryExecutorError("SCHEMA_INVALID", "Evaluation batch deadline must be bounded.");
  const { runner, qualifications } = options;
  const now = options.now ?? Date.now;
  const authorityId = qualifications.authorityId;
  const controlTimeoutMs = options.controlTimeoutMs ?? 1_000;
  if (
    !Number.isSafeInteger(controlTimeoutMs) ||
    controlTimeoutMs <= 0 ||
    controlTimeoutMs > FOUNDRY_PURE_TOOL_LIMITS.wallTimeMs
  ) {
    throw new FoundryExecutorError("BLOCKED_SANDBOX", "Invalid trusted control deadline.");
  }
  const control = async <T>(operation: () => Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new FoundryExecutorError("RUNNER_UNAVAILABLE", "Trusted control call timed out.")),
            controlTimeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  const qualify = async (): Promise<FoundryQualification> => {
    const blocked: FoundryQualification = {
      qualified: false,
      code: "BLOCKED_SANDBOX",
      reason: "Current trusted runner identity, enforced isolation or independent probe evidence is unavailable.",
    };
    try {
      // A profile cannot be admitted without its stop and read-only recovery paths.
      if (
        ![
          "currentProfile",
          "execute",
          "evaluate",
          "cancel",
          "reconcile",
          "cancelEvaluation",
          "reconcileEvaluation",
        ].every((name) => typeof runner[name as keyof TrustedFoundryRunner] === "function")
      )
        return blocked;
      // Snapshot before consulting the protected attestation store; never cache.
      const profile = JSON.parse(
        canonicalJson(await control(() => runner.currentProfile()), 64 * 1024),
      ) as FoundryRuntimeProfile;
      if (
        !validRef(profile.runnerId) ||
        !validRef(profile.profileRef) ||
        !validDigest(profile.runtimeDigest) ||
        !validDigest(profile.configurationDigest) ||
        !profile.guarantees ||
        !FOUNDRY_REQUIRED_GUARANTEES.every((key) => profile.guarantees[key] === true) ||
        !limitsWithin(profile.limits, FOUNDRY_PURE_TOOL_LIMITS) ||
        !validRef(authorityId)
      )
        return blocked;
      const profileDigest = hashFoundryRuntimeProfile(profile);
      const proof = await control(() =>
        qualifications.read({
          runnerId: profile.runnerId,
          runtimeDigest: profile.runtimeDigest,
          profileDigest,
        }),
      );
      const timestamp = now();
      if (
        !proof ||
        !Number.isFinite(timestamp) ||
        proof.revoked !== false ||
        proof.authorityId !== authorityId ||
        !validRef(proof.attestationRef) ||
        proof.runnerId !== profile.runnerId ||
        proof.runtimeDigest !== profile.runtimeDigest ||
        proof.profileDigest !== profileDigest
      )
        return blocked;
      const testedAt = Date.parse(proof.testedAt);
      const expiresAt = Date.parse(proof.expiresAt);
      if (
        !Number.isFinite(testedAt) ||
        !Number.isFinite(expiresAt) ||
        testedAt > timestamp ||
        expiresAt <= timestamp ||
        expiresAt <= testedAt
      )
        return blocked;
      if (
        !Array.isArray(proof.probes) ||
        proof.probes.length !== FOUNDRY_REQUIRED_PROBES.length ||
        !FOUNDRY_REQUIRED_PROBES.every((name) => {
          const matches = proof.probes.filter((probe) => probe.name === name);
          return matches.length === 1 && matches[0]!.outcome === "PASS" && validRef(matches[0]!.evidenceRef);
        })
      )
        return blocked;
      return Object.freeze({
        qualified: true,
        runnerId: profile.runnerId,
        profileRef: profile.profileRef,
        runtimeDigest: profile.runtimeDigest,
        configurationDigest: profile.configurationDigest,
        profileDigest,
        attestationRef: proof.attestationRef,
        testedAt: proof.testedAt,
        expiresAt: proof.expiresAt,
        evidenceRefs: Object.freeze(proof.probes.map((probe) => probe.evidenceRef)),
        limits: Object.freeze({ ...profile.limits }),
      });
    } catch {
      return blocked;
    }
  };

  const admit = async (): Promise<FoundryAdmission> => {
    const qualification = await qualify();
    if (!qualification.qualified) throw new FoundryExecutorError("BLOCKED_SANDBOX", qualification.reason);
    const { qualified: _qualified, testedAt: _testedAt, evidenceRefs: _evidenceRefs, ...pin } = qualification;
    return Object.freeze(pin);
  };

  const cancel = async (invocationId: string, fencingToken: number): Promise<FoundryCancellationResult> => {
    if (!validRef(invocationId) || !validFence(fencingToken)) invalidInput();
    try {
      // Revocation/expiry must not disable the stop path.
      const result = await control(() => runner.cancel(invocationId, fencingToken));
      if (
        result?.outcome === "CANCELLED" &&
        result.invocationId === invocationId &&
        result.fencingToken === fencingToken &&
        result.processTreeTerminated === true &&
        validRef(result.receiptRef)
      ) {
        return Object.freeze({ ...result });
      }
    } catch {
      // A missing kill acknowledgement is not evidence of process termination.
    }
    return unknownCancellation(invocationId, fencingToken);
  };

  const execute = async (request: FoundryExecutionRequest): Promise<FoundryExecutionResult> => {
    if (
      !request ||
      !validRef(request.orgId) ||
      !validDigest(request.digest) ||
      !validDigest(request.inputDigest) ||
      !validRef(request.invocationId) ||
      !validFence(request.fencingToken) ||
      !validRef(request.nativeDecisionRef) ||
      !validRef(request.budgetReservationRef) ||
      !request.abort ||
      typeof request.abort.addEventListener !== "function"
    )
      invalidInput();
    if (request.abort.aborted) throw new FoundryExecutorError("CANCELLED", "Parent was cancelled before dispatch.");
    const inputJson = canonicalJson(request.input, FOUNDRY_PURE_TOOL_LIMITS.inputBytes);
    if (sha256(inputJson) !== request.inputDigest) invalidInput();
    // Snapshot caller data before the first await. No caller object is dispatched.
    const snapshot = {
      orgId: request.orgId,
      digest: request.digest,
      inputDigest: request.inputDigest,
      invocationId: request.invocationId,
      fencingToken: request.fencingToken,
      nativeDecisionRef: request.nativeDecisionRef,
      budgetReservationRef: request.budgetReservationRef,
      abort: request.abort,
      inputJson,
    };
    const admission = await admit();
    if (Buffer.byteLength(inputJson, "utf8") > admission.limits.inputBytes) invalidInput();
    if (snapshot.abort.aborted) throw new FoundryExecutorError("CANCELLED", "Parent was cancelled before dispatch.");
    const controller = new AbortController();
    const dispatched = Object.freeze({ ...snapshot, abort: controller.signal });

    return new Promise<FoundryExecutionResult>((resolve) => {
      let settled = false;
      let stopRequested = false;
      const finish = (result: FoundryExecutionResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        snapshot.abort.removeEventListener("abort", stop);
        resolve(result);
      };
      const stop = (): void => {
        if (stopRequested || settled) return;
        stopRequested = true;
        controller.abort();
        // Ask the trusted control path to kill the whole tree. Until a bound
        // terminal receipt is reconciled, transport loss/cancellation is unknown.
        void cancel(snapshot.invocationId, snapshot.fencingToken).catch(() => undefined);
        finish(unknownOutcome(snapshot.invocationId));
      };
      const timer = setTimeout(stop, admission.limits.wallTimeMs);
      snapshot.abort.addEventListener("abort", stop, { once: true });
      if (snapshot.abort.aborted) {
        stop();
        return;
      }
      try {
        Promise.resolve(runner.execute(dispatched, admission)).then((result) => {
          if (settled) return;
          try {
            if (validTerminalResult(result, snapshot.invocationId, { request: dispatched, admission })) finish(result);
            else stop();
          } catch {
            stop();
          }
        }, stop);
      } catch {
        stop();
      }
    });
  };

  const cancelEvaluation = async (evaluatorJobRef: string): Promise<FoundryEvaluationCancellationResult> => {
    if (!validRef(evaluatorJobRef)) invalidInput();
    try {
      const result = await control(() => runner.cancelEvaluation(evaluatorJobRef));
      if (
        result?.outcome === "CANCELLED" &&
        result.evaluatorJobRef === evaluatorJobRef &&
        result.processTreeTerminated === true &&
        validRef(result.receiptRef)
      ) {
        return Object.freeze({ ...result });
      }
    } catch {
      // Unknown transport state cannot acknowledge process termination or a tombstone.
    }
    return unknownEvaluationOutcome(evaluatorJobRef);
  };

  const reconcileEvaluation = async (evaluatorJobRef: string): Promise<FoundryEvaluationResult> => {
    if (!validRef(evaluatorJobRef)) invalidInput();
    try {
      const result = await control(() => runner.reconcileEvaluation(evaluatorJobRef));
      // The engine additionally compares the historical receipt with its durable
      // job/org/version/pin before publishing. This operation never runs an eval.
      return validEvaluationReceipt(result, evaluatorJobRef) ? result : unknownEvaluationOutcome(evaluatorJobRef);
    } catch {
      return unknownEvaluationOutcome(evaluatorJobRef);
    }
  };

  const evaluate = async (
    version: FoundryFrozenVersion,
    evaluatorJobRef: string,
  ): Promise<FoundryEvaluationReceipt> => {
    if (
      !version ||
      !validRef(version.orgId) ||
      !validRef(version.candidateId) ||
      !validRef(version.manifestRef) ||
      !validDigest(version.digest) ||
      !validRef(evaluatorJobRef)
    )
      invalidInput();
    const authority = version.dispatchAuthority;
    if (authority && (!validRef(authority.outboxId) || !validRef(authority.lockedBy) ||
      !validRef(authority.runId) || !validRef(authority.toolUseId) ||
      !validFence(authority.attempt) || !validFence(authority.evaluationRevision))) invalidInput();
    const snapshot = Object.freeze({ ...version,
      ...(authority ? { dispatchAuthority: Object.freeze({ ...authority }) } : {}) });
    const admission = await admit();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const receipt = await Promise.race([
        runner.evaluate(snapshot, evaluatorJobRef, admission),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new FoundryExecutorError("UNKNOWN_OUTCOME", "Evaluation outcome requires reconciliation.")),
            options.evaluationTimeoutMs ?? admission.limits.wallTimeMs,
          );
        }),
      ]);
      if (!validEvaluationReceipt(receipt, evaluatorJobRef, { version: snapshot, admission })) {
        throw new FoundryExecutorError("UNKNOWN_OUTCOME", "Evaluation receipt could not be verified.");
      }
      return receipt;
    } catch {
      // Best-effort bounded job cancellation is not itself a terminal evaluation
      // receipt. Persist UNKNOWN and use the explicit read-only job reconciler.
      void cancelEvaluation(evaluatorJobRef).catch(() => undefined);
      throw new FoundryExecutorError("UNKNOWN_OUTCOME", "Evaluation outcome requires reconciliation.");
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    qualify,
    execute,
    evaluate,
    cancel,
    cancelEvaluation,
    reconcileEvaluation,
    async reconcile(invocationId) {
      if (!validRef(invocationId)) invalidInput();
      try {
        // Read-only historical reconciliation remains available after revocation.
        // The engine also compares this receipt with its durable invocation row.
        const result = await control(() => runner.reconcile(invocationId));
        return validTerminalResult(result, invocationId) ? result : unknownOutcome(invocationId);
      } catch {
        return unknownOutcome(invocationId);
      }
    },
  };
}
