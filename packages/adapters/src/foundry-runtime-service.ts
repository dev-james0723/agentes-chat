import { join } from "node:path";
import { createQualifiedFoundryExecutor, type FoundryAdmission, type FoundryFrozenVersion,
  type FoundryRunnerExecutionRequest, type FoundryExecutionRequest } from "./foundry-executor";
import { createFoundryDockerCli, createDockerFoundryRunner, FoundryDockerLedger, foundryDockerModuleFromBundle,
  type DockerFoundryOptions, type FoundryDockerPackageContent, type FoundryDockerControl } from "./foundry-docker-runner";
import { createProtectedFoundryEvaluator, ProtectedFoundryEvaluationLedger, protectedFoundryEvaluatorIdentity,
  type ProtectedFoundryBuilder } from "./foundry-protected-evaluator";
import { createPrivateFoundryQualificationStore } from "./foundry-private-qualification";
import { createFoundryRpcClient, createFoundryRpcHandler, type FoundryRpcMethod } from "./foundry-rpc";

export interface FoundryRuntimeServiceConfig extends Pick<DockerFoundryOptions, "imageId" | "architecture" | "platform" | "limits" | "seccompPath" | "runnerId" | "profileRef" | "evaluatorIdentity"> {
  transport: Parameters<typeof createFoundryDockerCli>[0];
  authorityId: string; qualificationFile: string; stateDirectory: string;
  runtimeToken: string; nativeControlUrl: string; nativeControlToken: string;
}
/** Dedicated trusted executor transport, not a scheduler/orchestrator. Work is
 * admitted only by the existing native outbox/task/approval records. */
export function createFoundryRuntimeService(config: FoundryRuntimeServiceConfig, dependencies: { docker?: FoundryDockerControl } = {}) {
  if (config.evaluatorIdentity !== protectedFoundryEvaluatorIdentity()) throw new Error("Scorer changed; independently requalify the runtime");
  const docker = dependencies.docker ?? createFoundryDockerCli(config.transport);
  const native = createFoundryRpcClient({ url: config.nativeControlUrl, token: config.nativeControlToken });
  const ledger = new FoundryDockerLedger(join(config.stateDirectory, "runner.sqlite"));
  const evaluationLedger = new ProtectedFoundryEvaluationLedger(join(config.stateDirectory, "evaluator.sqlite"));
  let evaluator: ReturnType<typeof createProtectedFoundryEvaluator>;
  const runner = createDockerFoundryRunner({ ...config, docker, ledger,
    resolvePackage: async (orgId, digest) => {
      const bundle = await native("package", { orgId, digest });
      return foundryDockerModuleFromBundle(orgId, digest, bundle as FoundryDockerPackageContent);
    },
    authorize: async (request, admission) => request.invocationId.startsWith("foundry-eval:")
      ? evaluator.authorizeCase(request, admission)
      : await native("authorizeExecution", { request: { ...request, abort: undefined }, admission }) === true,
    evaluator: { evaluate: (...args) => evaluator.evaluate(...args),
      cancelEvaluation: job => evaluator.cancelEvaluation(job), reconcileEvaluation: job => evaluator.reconcileEvaluation(job) },
  });
  evaluator = createProtectedFoundryEvaluator({ docker, ledger: evaluationLedger, imageId: config.imageId, seccompPath: config.seccompPath, limits: config.limits,
    authorize: async (version, job, admission) => await native("authorizeEvaluation", { version, job, admission }) as ProtectedFoundryBuilder | null,
    protectionCurrent: async proof => await native("protectionCurrent", { proof }) === true,
    execute: (request, admission) => runner.execute(request, admission), cancel: (id, fence) => runner.cancel(id, fence),
  });
  const executor = createQualifiedFoundryExecutor({ runner,
    qualifications: createPrivateFoundryQualificationStore({ filename: config.qualificationFile, authorityId: config.authorityId }),
    evaluationTimeoutMs: 120000, controlTimeoutMs: 5000 });
  let active = 0;
  const bounded = (method: FoundryRpcMethod): FoundryRpcMethod => async (input, signal) => {
    if (active >= 2) throw new Error("Runtime capacity unavailable");
    active++;
    try { return await method(input, signal); } finally { active--; }
  };
  const text = (v: unknown) => { if (typeof v !== "string" || !v || v.length > 1024 || /[\u0000-\u001f]/.test(v)) throw new Error("Invalid reference"); return v; };
  const fence = (v: unknown) => { if (!Number.isSafeInteger(v) || (v as number) < 1) throw new Error("Invalid fence"); return v as number; };
  const methods: Record<string, FoundryRpcMethod> = {
    qualify: async () => executor.qualify(),
    evaluate: bounded(async ({ version, job }) => executor.evaluate(version as FoundryFrozenVersion, text(job))),
    reconcileEvaluation: async ({ job }) => executor.reconcileEvaluation(text(job)),
    cancelEvaluation: async ({ job }) => executor.cancelEvaluation(text(job)),
    execute: bounded(async ({ request }, signal) => executor.execute({ ...(request as Omit<FoundryExecutionRequest, "abort">), abort: signal })),
    cancel: async ({ invocationId, fencingToken }) => executor.cancel(text(invocationId), fence(fencingToken)),
    reconcile: async ({ invocationId }) => executor.reconcile(text(invocationId)),
    resolveEvidence: async ({ orgId, receiptRef }) => evaluator.resolveEvidence(text(orgId), text(receiptRef)),
  };
  const fetch = createFoundryRpcHandler({ token: config.runtimeToken, methods });
  return { fetch, executor, async close() {
    const running = evaluationLedger.db.query<{ jobRef: string }, []>("SELECT jobRef FROM protected_evaluations WHERE phase IN ('RESERVED','RUNNING','CANCEL_REQUESTED')").all();
    for (const { jobRef } of running) await evaluator.cancelEvaluation(jobRef);
    evaluationLedger.close(); ledger.close();
  } };
}
