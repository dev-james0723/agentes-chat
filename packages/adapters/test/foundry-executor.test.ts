import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  createQualifiedFoundryExecutor,
  createUnavailableFoundryExecutor,
  FOUNDRY_PURE_TOOL_LIMITS,
  FOUNDRY_REQUIRED_GUARANTEES,
  FOUNDRY_REQUIRED_PROBES,
  type FoundryAdmission,
  type FoundryEvaluationResult,
  type FoundryExecutionRequest,
  type FoundryExecutionResult,
  type FoundryProbeAttestation,
  type FoundryRunnerExecutionRequest,
  type FoundryRuntimeProfile,
  hashFoundryInput,
  hashFoundryRuntimeProfile,
  type TrustedFoundryRunner,
} from "../src/foundry-executor";

// These tests simulate the trusted adapter boundary. No candidate program is
// executed, no sandbox is created, and a green suite is NOT isolation evidence.
const NOW = Date.parse("2026-11-16T12:00:00.000Z");
const DIGEST = "a".repeat(64);
const RUNTIME = "b".repeat(64);

function profile(): FoundryRuntimeProfile {
  return {
    runnerId: "simulation-runner",
    profileRef: "simulation-profile",
    runtimeDigest: RUNTIME,
    configurationDigest: "c".repeat(64),
    guarantees: Object.fromEntries(
      FOUNDRY_REQUIRED_GUARANTEES.map((key) => [key, true]),
    ) as FoundryRuntimeProfile["guarantees"],
    limits: { ...FOUNDRY_PURE_TOOL_LIMITS },
  };
}

function proof(value: FoundryRuntimeProfile): FoundryProbeAttestation {
  return {
    attestationRef: "simulation-attestation",
    authorityId: "simulation-independent-probe-service",
    runnerId: value.runnerId,
    runtimeDigest: value.runtimeDigest,
    profileDigest: hashFoundryRuntimeProfile(value),
    testedAt: new Date(NOW - 60_000).toISOString(),
    expiresAt: new Date(NOW + 60_000).toISOString(),
    revoked: false,
    probes: FOUNDRY_REQUIRED_PROBES.map((name) => ({
      name,
      outcome: "PASS",
      evidenceRef: `simulation-probe/${name}`,
    })),
  };
}

function request(overrides: Partial<FoundryExecutionRequest> = {}): FoundryExecutionRequest {
  const input = { records: [] };
  return {
    orgId: "test-org",
    digest: DIGEST,
    input,
    inputDigest: hashFoundryInput(input),
    invocationId: "test-invocation",
    fencingToken: 1,
    nativeDecisionRef: "test-decision",
    budgetReservationRef: "test-budget",
    abort: new AbortController().signal,
    ...overrides,
  };
}

function success(request: FoundryRunnerExecutionRequest, admission: FoundryAdmission): FoundryExecutionResult {
  return {
    outcome: "SUCCEEDED",
    output: { total: 2 },
    receiptRef: "simulation-execution-receipt",
    receipt: {
      receiptRef: "simulation-execution-receipt",
      orgId: request.orgId,
      digest: request.digest,
      inputDigest: request.inputDigest,
      invocationId: request.invocationId,
      fencingToken: request.fencingToken,
      runnerId: admission.runnerId,
      runtimeDigest: admission.runtimeDigest,
      profileDigest: admission.profileDigest,
      qualificationRef: admission.attestationRef,
      effectiveLimits: { ...admission.limits },
      stdoutBytes: 0,
      stderrBytes: 0,
      processTreeTerminated: true,
    },
  };
}

function setup(controlTimeoutMs = 50) {
  const state = {
    profile: profile(),
    proof: null as FoundryProbeAttestation | null,
    now: NOW,
    calls: [] as { request: FoundryRunnerExecutionRequest; admission: FoundryAdmission }[],
    evaluateCalls: 0,
    evaluationCancelCalls: 0,
    evaluationReconcileCalls: 0,
    qualificationBlocked: false,
    evaluationReconciliation: null as FoundryEvaluationResult | null,
    cancelCalls: 0,
    reconcileCalls: 0,
    execute: async (request: FoundryRunnerExecutionRequest, admission: FoundryAdmission) => success(request, admission),
    cancellationConfirmed: true,
    reconciliation: null as FoundryExecutionResult | null,
  };
  state.proof = proof(state.profile);
  const runner: TrustedFoundryRunner = {
    async currentProfile() {
      return structuredClone(state.profile);
    },
    async execute(request, admission) {
      state.calls.push({ request, admission });
      return state.execute(request, admission);
    },
    async evaluate(version, evaluatorJobRef, admission) {
      state.evaluateCalls++;
      return {
        outcome: "PASS",
        orgId: version.orgId,
        digest: version.digest,
        evaluatorJobRef,
        evaluatorRef: "simulation-protected-evaluator",
        runtimeDigest: admission.runtimeDigest,
        profileDigest: admission.profileDigest,
        qualificationRef: admission.attestationRef,
        effectiveLimits: { ...admission.limits },
        evidenceRefs: ["simulation-holdout-receipt"],
        receiptRef: "simulation-evaluation-receipt",
        processTreeTerminated: true,
      };
    },
    async cancelEvaluation(evaluatorJobRef) {
      state.evaluationCancelCalls++;
      return {
        outcome: "CANCELLED",
        evaluatorJobRef,
        receiptRef: "simulation-evaluation-stop",
        processTreeTerminated: true,
      };
    },
    async reconcileEvaluation(evaluatorJobRef) {
      state.evaluationReconcileCalls++;
      return (
        state.evaluationReconciliation ?? {
          outcome: "UNKNOWN_OUTCOME",
          evaluatorJobRef,
          receiptRef: null,
          reconciliationRef: evaluatorJobRef,
        }
      );
    },
    async cancel(invocationId, fencingToken) {
      state.cancelCalls++;
      return state.cancellationConfirmed
        ? {
            outcome: "CANCELLED",
            invocationId,
            fencingToken,
            receiptRef: "simulation-kill-receipt",
            processTreeTerminated: true,
          }
        : { outcome: "UNKNOWN_OUTCOME", invocationId, fencingToken, receiptRef: null, reconciliationRef: invocationId };
    },
    async reconcile(invocationId) {
      state.reconcileCalls++;
      return state.reconciliation ?? { outcome: "UNKNOWN_OUTCOME", receiptRef: null, reconciliationRef: invocationId };
    },
  };
  const executor = createQualifiedFoundryExecutor({
    runner,
    qualifications: {
      authorityId: "simulation-independent-probe-service",
      async read() {
        if (state.qualificationBlocked) return new Promise<FoundryProbeAttestation | null>(() => undefined);
        return structuredClone(state.proof);
      },
    },
    now: () => state.now,
    controlTimeoutMs,
  });
  return { state, runner, executor };
}

describe("Foundry executor admission (SIMULATED trusted adapters; not sandbox qualification)", () => {
  test("default unavailable executor blocks executable work without a fallback", async () => {
    const executor = createUnavailableFoundryExecutor();
    expect(await executor.qualify()).toMatchObject({ qualified: false, code: "BLOCKED_SANDBOX" });
    await expect(executor.execute(request())).rejects.toMatchObject({ code: "BLOCKED_SANDBOX" });
    await expect(
      executor.evaluate(
        { orgId: "test-org", candidateId: "test-candidate", digest: DIGEST, manifestRef: "manifest" },
        "evaluation-job",
      ),
    ).rejects.toMatchObject({ code: "BLOCKED_SANDBOX" });
    expect((await executor.cancel("unknown", 1)).outcome).toBe("UNKNOWN_OUTCOME");
    expect((await executor.reconcile("unknown")).outcome).toBe("UNKNOWN_OUTCOME");
  });

  test("valid independently stored probes admit a pinned simulation dispatch", async () => {
    const { state, executor } = setup();
    const result = await executor.execute(request());
    expect(result.outcome).toBe("SUCCEEDED");
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]?.request.inputJson).toBe('{"records":[]}');
    expect(state.calls[0]?.admission).toMatchObject({
      runnerId: "simulation-runner",
      runtimeDigest: RUNTIME,
      attestationRef: "simulation-attestation",
    });
    expect(result).toMatchObject({ receipt: { orgId: "test-org", digest: DIGEST, fencingToken: 1 } });
  });

  test("canonical input hash is independent of object insertion order", () => {
    const expected = createHash("sha256").update('{"a":[true,null],"z":"香港"}').digest("hex");
    expect(hashFoundryInput({ z: "香港", a: [true, null] })).toBe(expected);
    expect(hashFoundryInput({ a: [true, null], z: "香港" })).toBe(expected);
  });

  test("untrusted qualified flags cannot substitute for stored probe evidence", async () => {
    const { state, executor } = setup();
    state.proof = null;
    const forged = { ...request(), qualified: true, evidenceRefs: ["author-says-pass"] };
    await expect(executor.execute(forged)).rejects.toMatchObject({ code: "BLOCKED_SANDBOX" });
    expect(state.calls).toHaveLength(0);
  });

  for (const key of FOUNDRY_REQUIRED_GUARANTEES) {
    test(`missing enforced guarantee ${key} blocks before dispatch`, async () => {
      const { state, executor } = setup();
      state.profile.guarantees[key] = false;
      state.proof = proof(state.profile);
      await expect(executor.execute(request())).rejects.toMatchObject({ code: "BLOCKED_SANDBOX" });
      expect(state.calls).toHaveLength(0);
    });
  }

  for (const key of Object.keys(FOUNDRY_PURE_TOOL_LIMITS) as (keyof typeof FOUNDRY_PURE_TOOL_LIMITS)[]) {
    test(`effective ${key} over the ceiling blocks before dispatch`, async () => {
      const { state, executor } = setup();
      state.profile.limits[key] = FOUNDRY_PURE_TOOL_LIMITS[key] + 1;
      state.proof = proof(state.profile);
      await expect(executor.execute(request())).rejects.toMatchObject({ code: "BLOCKED_SANDBOX" });
      expect(state.calls).toHaveLength(0);
    });
  }

  test("stricter actual bounds remain eligible", async () => {
    const { state, executor } = setup();
    state.profile.limits.memoryBytes = 128 * 1024 * 1024;
    state.profile.limits.maxProcesses = 1;
    state.proof = proof(state.profile);
    expect((await executor.execute(request())).outcome).toBe("SUCCEEDED");
    expect(state.calls[0]?.admission.limits.memoryBytes).toBe(134_217_728);
  });

  for (const mutation of [
    "expired",
    "future",
    "revoked",
    "issuer",
    "runtime",
    "runner",
    "profile",
    "failed-probe",
    "missing-probe",
  ] as const) {
    test(`a ${mutation} attestation never authorizes execution`, async () => {
      const { state, executor } = setup();
      const evidence = state.proof!;
      if (mutation === "expired") evidence.expiresAt = new Date(NOW).toISOString();
      if (mutation === "future") evidence.testedAt = new Date(NOW + 1).toISOString();
      if (mutation === "revoked") evidence.revoked = true;
      if (mutation === "issuer") evidence.authorityId = "candidate-author";
      if (mutation === "runtime") evidence.runtimeDigest = "d".repeat(64);
      if (mutation === "runner") evidence.runnerId = "other-runner";
      if (mutation === "profile") evidence.profileDigest = "d".repeat(64);
      if (mutation === "failed-probe") evidence.probes[0]!.outcome = "FAIL";
      if (mutation === "missing-probe") evidence.probes.pop();
      await expect(executor.execute(request())).rejects.toMatchObject({ code: "BLOCKED_SANDBOX" });
      expect(state.calls).toHaveLength(0);
    });
  }

  test("profile drift invalidates a previously admitted runner at the next dispatch", async () => {
    const { state, executor } = setup();
    expect((await executor.execute(request())).outcome).toBe("SUCCEEDED");
    state.profile.configurationDigest = "e".repeat(64);
    await expect(executor.execute(request({ invocationId: "second-invocation" }))).rejects.toMatchObject({
      code: "BLOCKED_SANDBOX",
    });
    expect(state.calls).toHaveLength(1);
  });

  test("expiry and revocation are reread for each dispatch", async () => {
    const { state, executor } = setup();
    expect((await executor.execute(request())).outcome).toBe("SUCCEEDED");
    state.now += 60_000;
    await expect(executor.execute(request({ invocationId: "second-invocation" }))).rejects.toMatchObject({
      code: "BLOCKED_SANDBOX",
    });
    state.now = NOW;
    state.proof!.revoked = true;
    await expect(executor.execute(request({ invocationId: "third-invocation" }))).rejects.toMatchObject({
      code: "BLOCKED_SANDBOX",
    });
    expect(state.calls).toHaveLength(1);
  });

  test("changed input under an old input digest is rejected before dispatch", async () => {
    const { state, executor } = setup();
    await expect(executor.execute(request({ input: { records: [1] } }))).rejects.toMatchObject({
      code: "SCHEMA_INVALID",
    });
    expect(state.calls).toHaveLength(0);
  });

  test("oversized input is rejected before dispatch", async () => {
    const { state, executor } = setup();
    await expect(executor.execute(request({ input: "x".repeat(1_048_577) }))).rejects.toMatchObject({
      code: "SCHEMA_INVALID",
    });
    expect(state.calls).toHaveLength(0);
  });

  test("JSON accessors are rejected without invoking candidate-controlled getters", () => {
    let read = false;
    const input = Object.defineProperty({}, "secret", {
      enumerable: true,
      get() {
        read = true;
        return "value";
      },
    });
    expect(() => hashFoundryInput(input)).toThrow();
    expect(read).toBe(false);
  });

  test("an already aborted parent cannot dispatch", async () => {
    const { state, executor } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(executor.execute(request({ abort: controller.signal }))).rejects.toMatchObject({ code: "CANCELLED" });
    expect(state.calls).toHaveLength(0);
  });

  test("lost transport after dispatch stays unknown and is never automatically replayed", async () => {
    const { state, executor } = setup();
    state.execute = async () => {
      throw new Error("lost transport with secret details");
    };
    expect(await executor.execute(request())).toEqual({
      outcome: "UNKNOWN_OUTCOME",
      receiptRef: null,
      reconciliationRef: "test-invocation",
    });
    expect(state.calls).toHaveLength(1);
    expect((await executor.reconcile("test-invocation")).outcome).toBe("UNKNOWN_OUTCOME");
    expect(state.calls).toHaveLength(1);
    expect(state.reconcileCalls).toBe(1);
  });

  for (const field of [
    "orgId",
    "digest",
    "inputDigest",
    "invocationId",
    "fencingToken",
    "runtimeDigest",
    "profileDigest",
    "qualificationRef",
  ] as const) {
    test(`a mismatched ${field} receipt cannot report success`, async () => {
      const { state, executor } = setup();
      state.execute = async (request, admission) => {
        const result = success(request, admission);
        if (result.outcome === "SUCCEEDED") {
          if (field === "fencingToken") result.receipt.fencingToken = 2;
          else result.receipt[field] = "wrong";
        }
        return result;
      };
      expect((await executor.execute(request())).outcome).toBe("UNKNOWN_OUTCOME");
      expect(state.calls).toHaveLength(1);
    });
  }

  test("an oversized runner result or unbounded output receipt is not accepted", async () => {
    const { state, executor } = setup();
    state.execute = async (request, admission) => {
      const result = success(request, admission);
      if (result.outcome === "SUCCEEDED") result.output = "x".repeat(1_048_577);
      return result;
    };
    expect((await executor.execute(request())).outcome).toBe("UNKNOWN_OUTCOME");
    state.execute = async (request, admission) => {
      const result = success(request, admission);
      if (result.outcome === "SUCCEEDED") result.receipt.stderrBytes = 65_537;
      return result;
    };
    expect((await executor.execute(request({ invocationId: "second-invocation" }))).outcome).toBe("UNKNOWN_OUTCOME");
  });

  test("cancellation is confirmed only by a process-tree termination receipt", async () => {
    const { state, executor } = setup();
    state.cancellationConfirmed = false;
    expect((await executor.cancel("test-invocation", 1)).outcome).toBe("UNKNOWN_OUTCOME");
    state.cancellationConfirmed = true;
    expect(await executor.cancel("test-invocation", 1)).toMatchObject({
      outcome: "CANCELLED",
      processTreeTerminated: true,
      fencingToken: 1,
    });
    expect(state.cancelCalls).toBe(2);
  });

  test("revocation blocks new work while still allowing read-only reconciliation", async () => {
    const { state, executor } = setup();
    const result = await executor.execute(request());
    state.reconciliation = result;
    state.proof!.revoked = true;
    expect((await executor.reconcile("test-invocation")).outcome).toBe("SUCCEEDED");
    expect((await executor.cancel("test-invocation", 1)).outcome).toBe("CANCELLED");
    await expect(executor.execute(request({ invocationId: "new-invocation" }))).rejects.toMatchObject({
      code: "BLOCKED_SANDBOX",
    });
    expect(state.calls).toHaveLength(1);
  });

  test("evaluation has the same runtime gate and does not accept author-supplied PASS evidence", async () => {
    const { state, executor } = setup();
    const version = { orgId: "test-org", candidateId: "test-candidate", digest: DIGEST, manifestRef: "manifest" };
    const receipt = await executor.evaluate(version, "protected-job");
    expect(receipt).toMatchObject({
      outcome: "PASS",
      digest: DIGEST,
      evaluatorJobRef: "protected-job",
      runtimeDigest: RUNTIME,
      evidenceRefs: ["simulation-holdout-receipt"],
    });
    state.proof = null;
    await expect(executor.evaluate(version, "protected-job")).rejects.toMatchObject({ code: "BLOCKED_SANDBOX" });
    expect(state.evaluateCalls).toBe(1);
  });
});

describe("Foundry invocation recovery (SIMULATIONS; no candidate process)", () => {
  test("an invalid termination receipt requests a process-tree stop", async () => {
    const { state, executor } = setup();
    state.execute = async (request, admission) => {
      const result = success(request, admission);
      if (result.outcome === "SUCCEEDED") result.receipt.processTreeTerminated = false;
      return result;
    };
    expect((await executor.execute(request())).outcome).toBe("UNKNOWN_OUTCOME");
    expect(state.cancelCalls).toBe(1);
  });

  test("lost dispatch transport requests stop without replaying the invocation", async () => {
    const { state, executor } = setup();
    state.execute = async () => {
      throw new Error("transport disconnected");
    };
    expect((await executor.execute(request())).outcome).toBe("UNKNOWN_OUTCOME");
    expect(state.cancelCalls).toBe(1);
    expect(state.calls).toHaveLength(1);
  });

  test("mid-flight parent cancellation requests stop and awaits reconciliation", async () => {
    const { state, executor } = setup();
    let started!: () => void;
    const start = new Promise<void>((resolve) => {
      started = resolve;
    });
    state.execute = async () => {
      started();
      return new Promise<FoundryExecutionResult>(() => undefined);
    };
    const controller = new AbortController();
    const result = executor.execute(request({ abort: controller.signal }));
    await start;
    controller.abort();
    expect((await result).outcome).toBe("UNKNOWN_OUTCOME");
    expect(state.cancelCalls).toBe(1);
    expect(state.calls[0]?.request.abort.aborted).toBe(true);
  });

  test("a silent runner exceeds its pinned deadline without reporting success", async () => {
    const { state, executor } = setup();
    state.profile.limits.wallTimeMs = 5;
    state.proof = proof(state.profile);
    state.execute = async () => new Promise<FoundryExecutionResult>(() => undefined);
    expect((await executor.execute(request())).outcome).toBe("UNKNOWN_OUTCOME");
    expect(state.cancelCalls).toBe(1);
  });

  test("input changes during qualification do not change the pinned bytes", async () => {
    const { state, executor } = setup();
    const input: { records: number[] } = { records: [] };
    const pending = executor.execute(request({ input, inputDigest: hashFoundryInput(input) }));
    input.records.push(42);
    expect((await pending).outcome).toBe("SUCCEEDED");
    expect(state.calls[0]?.request.inputJson).toBe('{"records":[]}');
  });

  test("a cross-organization evaluation receipt cannot become a PASS", async () => {
    const { runner, executor } = setup();
    const evaluate = runner.evaluate.bind(runner);
    runner.evaluate = async (version, job, admission) => ({
      ...(await evaluate(version, job, admission)),
      orgId: "other-org",
    });
    await expect(
      executor.evaluate(
        { orgId: "test-org", candidateId: "test-candidate", digest: DIGEST, manifestRef: "manifest" },
        "protected-job",
      ),
    ).rejects.toMatchObject({ code: "UNKNOWN_OUTCOME" });
  });

  test("a receipt for another invocation cannot reconcile this one", async () => {
    const { state, executor } = setup();
    state.reconciliation = await executor.execute(request());
    expect((await executor.reconcile("other-invocation")).outcome).toBe("UNKNOWN_OUTCOME");
    expect(state.calls).toHaveLength(1);
  });
});

test("a runner's arbitrary failure message is not exposed as a typed error code (SIMULATION)", async () => {
  const { state, executor } = setup();
  state.execute = async (request, admission) =>
    ({
      ...success(request, admission),
      outcome: "FAILED",
      code: "SECRET=untrusted-runner-diagnostic",
    }) as unknown as FoundryExecutionResult;
  expect(await executor.execute(request())).toEqual({
    outcome: "UNKNOWN_OUTCOME",
    receiptRef: null,
    reconciliationRef: "test-invocation",
  });
});

describe("bounded executor control and evaluator recovery (SIMULATIONS only)", () => {
  test("a silent profile lookup fails closed within the trusted control deadline", async () => {
    const { runner, executor, state } = setup(5);
    runner.currentProfile = async () => new Promise<FoundryRuntimeProfile>(() => undefined);
    expect(await executor.qualify()).toMatchObject({ qualified: false, code: "BLOCKED_SANDBOX" });
    expect(state.calls).toHaveLength(0);
  }, 150);

  test("a silent protected attestation lookup fails closed within the trusted control deadline", async () => {
    const { executor, state } = setup(5);
    state.qualificationBlocked = true;
    expect(await executor.qualify()).toMatchObject({ qualified: false, code: "BLOCKED_SANDBOX" });
    expect(state.calls).toHaveLength(0);
  }, 150);

  test("silent cancellation cannot strand the caller or invent process termination", async () => {
    const { executor, runner } = setup(5);
    runner.cancel = async () => new Promise<never>(() => undefined);
    expect(await executor.cancel("test-invocation", 1)).toMatchObject({
      outcome: "UNKNOWN_OUTCOME",
      invocationId: "test-invocation",
      fencingToken: 1,
    });
  }, 150);

  test("silent read-only reconciliation returns unknown without replay", async () => {
    const { executor, runner, state } = setup(5);
    runner.reconcile = async () => new Promise<never>(() => undefined);
    expect(await executor.reconcile("test-invocation")).toEqual({
      outcome: "UNKNOWN_OUTCOME",
      receiptRef: null,
      reconciliationRef: "test-invocation",
    });
    expect(state.calls).toHaveLength(0);
  }, 150);

  test("an evaluation wall timeout requests job cancellation and never proves termination by the timer", async () => {
    const { executor, runner, state } = setup(5);
    state.profile.limits.wallTimeMs = 5;
    state.proof = proof(state.profile);
    runner.evaluate = async () => new Promise<never>(() => undefined);
    await expect(
      executor.evaluate(
        { orgId: "test-org", candidateId: "test-candidate", digest: DIGEST, manifestRef: "manifest" },
        "protected-job",
      ),
    ).rejects.toMatchObject({ code: "UNKNOWN_OUTCOME" });
    expect(state.evaluationCancelCalls).toBe(1);
    expect(state.evaluateCalls).toBe(0);
  }, 150);

  test("a PASS evaluation receipt without whole-tree termination is rejected", async () => {
    const { executor, runner } = setup();
    const evaluate = runner.evaluate.bind(runner);
    runner.evaluate = async (version, job, admission) => ({
      ...(await evaluate(version, job, admission)),
      processTreeTerminated: false,
    });
    await expect(
      executor.evaluate(
        { orgId: "test-org", candidateId: "test-candidate", digest: DIGEST, manifestRef: "manifest" },
        "protected-job",
      ),
    ).rejects.toMatchObject({ code: "UNKNOWN_OUTCOME" });
  });

  test("evaluation cancellation reports an acknowledgement only for the exact job", async () => {
    const { executor, runner } = setup(5);
    expect(typeof executor.cancelEvaluation).toBe("function");
    expect(await executor.cancelEvaluation("protected-job")).toMatchObject({
      outcome: "CANCELLED",
      evaluatorJobRef: "protected-job",
      processTreeTerminated: true,
    });
    runner.cancelEvaluation = async () => ({
      outcome: "CANCELLED",
      evaluatorJobRef: "different-job",
      receiptRef: "simulation-wrong-stop",
      processTreeTerminated: true,
    });
    expect((await executor.cancelEvaluation("protected-job")).outcome).toBe("UNKNOWN_OUTCOME");
    runner.cancelEvaluation = async () => new Promise<never>(() => undefined);
    expect((await executor.cancelEvaluation("protected-job")).outcome).toBe("UNKNOWN_OUTCOME");
  }, 150);

  test("evaluation reconciliation stays read-only and rejects a receipt for another job", async () => {
    const { executor, state } = setup(5);
    expect(typeof executor.reconcileEvaluation).toBe("function");
    state.evaluationReconciliation = {
      orgId: "test-org",
      digest: DIGEST,
      evaluatorJobRef: "protected-job",
      evaluatorRef: "simulation-protected-evaluator",
      runtimeDigest: RUNTIME,
      profileDigest: hashFoundryRuntimeProfile(state.profile),
      qualificationRef: state.proof!.attestationRef,
      effectiveLimits: { ...state.profile.limits },
      outcome: "PASS",
      evidenceRefs: ["simulation-protected-receipt"],
      receiptRef: "simulation-evaluation-receipt",
      processTreeTerminated: true,
    };
    expect((await executor.reconcileEvaluation("protected-job")).outcome).toBe("PASS");
    expect((await executor.reconcileEvaluation("different-job")).outcome).toBe("UNKNOWN_OUTCOME");
    expect(state.evaluateCalls).toBe(0);
    expect(state.calls).toHaveLength(0);
  });

  test("silent evaluator reconciliation is bounded and unavailable defaults remain inert", async () => {
    const { executor, runner } = setup(5);
    expect(typeof executor.reconcileEvaluation).toBe("function");
    runner.reconcileEvaluation = async () => new Promise<never>(() => undefined);
    expect((await executor.reconcileEvaluation("protected-job")).outcome).toBe("UNKNOWN_OUTCOME");
    const unavailable = createUnavailableFoundryExecutor();
    expect((await unavailable.cancelEvaluation("protected-job")).outcome).toBe("UNKNOWN_OUTCOME");
    expect((await unavailable.reconcileEvaluation("protected-job")).outcome).toBe("UNKNOWN_OUTCOME");
  }, 150);

  test.each([0, 10_001, Number.NaN])("trusted control deadline %s cannot disable the bound", (timeout) => {
    expect(() => setup(timeout)).toThrow();
  });

  test("a runner without independently attested cancel-before-dispatch fencing is ineligible", async () => {
    const { state, executor } = setup();
    state.proof!.probes = state.proof!.probes.filter((probe) => probe.name !== "cancel-before-dispatch-fencing");
    expect(await executor.qualify()).toMatchObject({ qualified: false, code: "BLOCKED_SANDBOX" });
    expect(state.calls).toHaveLength(0);
  });
});
