import { join } from "node:path";
import {
  createHostCapabilitySync,
  type FoundryCapabilityExport,
  type FoundryCapabilityLookup,
} from "./foundry-capability-sync";
import {
  createDockerFoundryRunner,
  createFoundryDockerCli,
  type DockerFoundryOptions,
  type FoundryDockerControl,
  FoundryDockerLedger,
  type FoundryDockerPackageContent,
  foundryDockerModuleFromBundle,
} from "./foundry-docker-runner";
import {
  createQualifiedFoundryExecutor,
  type FoundryExecutionRequest,
  type FoundryFrozenVersion,
  type FoundryRunnerExecutionRequest,
} from "./foundry-executor";
import { createPrivateFoundryQualificationStore } from "./foundry-private-qualification";
import {
  createProtectedFoundryEvaluator,
  type ProtectedFoundryBuilder,
  ProtectedFoundryEvaluationLedger,
  protectedFoundryEvaluatorIdentity,
} from "./foundry-protected-evaluator";
import {
  createFoundryRpcClient,
  createFoundryRpcHandler,
  type FoundryRpcMethod,
  FoundryRuntimeBusyError,
} from "./foundry-rpc";

export interface FoundryRuntimeServiceConfig
  extends Pick<
    DockerFoundryOptions,
    "imageId" | "architecture" | "platform" | "limits" | "seccompPath" | "runnerId" | "profileRef" | "evaluatorIdentity"
  > {
  transport: Parameters<typeof createFoundryDockerCli>[0];
  authorityId: string;
  qualificationFile: string;
  stateDirectory: string;
  runtimeToken: string;
  nativeControlUrl: string;
  nativeControlToken: string;
  /** Optional: James's skills repository clone and its `sync-skill` script, on this host only (SF-19). */
  skillsSync?: { script: string; repoDir: string };
}
/** Dedicated trusted executor transport, not a scheduler/orchestrator. Work is
 * admitted only by the existing native outbox/task/approval records. */
export function createFoundryRuntimeService(
  config: FoundryRuntimeServiceConfig,
  dependencies: { docker?: FoundryDockerControl } = {},
) {
  if (config.evaluatorIdentity !== protectedFoundryEvaluatorIdentity())
    throw new Error("Scorer changed; independently requalify the runtime");
  const docker = dependencies.docker ?? createFoundryDockerCli(config.transport);
  const native = createFoundryRpcClient({ url: config.nativeControlUrl, token: config.nativeControlToken });
  const ledger = new FoundryDockerLedger(join(config.stateDirectory, "runner.sqlite"));
  const evaluationLedger = new ProtectedFoundryEvaluationLedger(join(config.stateDirectory, "evaluator.sqlite"));
  let evaluator: ReturnType<typeof createProtectedFoundryEvaluator>;
  const runner = createDockerFoundryRunner({
    ...config,
    docker,
    ledger,
    resolvePackage: async (orgId, digest) => {
      const bundle = await native("package", { orgId, digest });
      return foundryDockerModuleFromBundle(orgId, digest, bundle as FoundryDockerPackageContent);
    },
    authorize: async (request, admission) =>
      request.invocationId.startsWith("foundry-eval:")
        ? evaluator.authorizeCase(request, admission)
        : (await native("authorizeExecution", { request: { ...request, abort: undefined }, admission })) === true,
    evaluator: {
      evaluate: (...args) => evaluator.evaluate(...args),
      cancelEvaluation: (job) => evaluator.cancelEvaluation(job),
      reconcileEvaluation: (job) => evaluator.reconcileEvaluation(job),
    },
  });
  evaluator = createProtectedFoundryEvaluator({
    docker,
    ledger: evaluationLedger,
    imageId: config.imageId,
    seccompPath: config.seccompPath,
    limits: config.limits,
    authorize: async (version, job, admission) =>
      (await native("authorizeEvaluation", { version, job, admission })) as ProtectedFoundryBuilder | null,
    protectionCurrent: async (proof) => (await native("protectionCurrent", { proof })) === true,
    execute: (request, admission) => runner.execute(request, admission),
    cancel: (id, fence) => runner.cancel(id, fence),
  });
  const executor = createQualifiedFoundryExecutor({
    runner,
    qualifications: createPrivateFoundryQualificationStore({
      filename: config.qualificationFile,
      authorityId: config.authorityId,
    }),
    evaluationTimeoutMs: 120000,
    controlTimeoutMs: 5000,
  });
  // Separate pools so long evaluations cannot starve calls, and one slot per workspace in each.
  const evaluations = createFoundryAdmission({ limit: 2, perOrg: 1 });
  const executions = createFoundryAdmission({ limit: 2, perOrg: 1 });
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject C0 control characters at the transport trust boundary.
  const CONTROL_CHARACTERS = /[\u0000-\u001f]/;
  const text = (v: unknown) => {
    if (typeof v !== "string" || !v || v.length > 1024 || CONTROL_CHARACTERS.test(v))
      throw new Error("Invalid reference");
    return v;
  };
  const fence = (v: unknown) => {
    if (!Number.isSafeInteger(v) || (v as number) < 1) throw new Error("Invalid fence");
    return v as number;
  };
  const skills = config.skillsSync ? createHostCapabilitySync(config.skillsSync) : null;
  const prose = (v: unknown) => {
    if (typeof v !== "string" || !v.trim() || v.length > 2000) throw new Error("Invalid capability text");
    return v;
  };
  const lookupOf = (v: unknown): FoundryCapabilityLookup => {
    const q = (v ?? {}) as Record<string, unknown>;
    if (q.kind !== "skill" && q.kind !== "tool") throw new Error("Invalid capability kind");
    return { digest: text(q.digest), name: text(q.name), kind: q.kind };
  };
  const exported = (v: unknown): FoundryCapabilityExport => {
    const c = (v ?? {}) as Record<string, unknown>;
    if (!Array.isArray(c.files) || c.files.length < 1 || c.files.length > 64)
      throw new Error("Invalid capability files");
    const files = c.files.map((file) => {
      const f = (file ?? {}) as Record<string, unknown>;
      if (typeof f.base64 !== "string" || f.base64.length > 8 * 1024 * 1024) throw new Error("Invalid capability file");
      return { path: text(f.path), base64: f.base64 };
    });
    return { ...lookupOf(c), agent: prose(c.agent), why: prose(c.why), use: prose(c.use), files };
  };
  const methods: Record<string, FoundryRpcMethod> = {
    qualify: async () => executor.qualify(),
    evaluate: evaluations(
      async ({ version, job }) => executor.evaluate(version as FoundryFrozenVersion, text(job)),
      ({ version }) => (version as { orgId?: unknown } | null)?.orgId,
    ),
    reconcileEvaluation: async ({ job }) => executor.reconcileEvaluation(text(job)),
    cancelEvaluation: async ({ job }) => executor.cancelEvaluation(text(job)),
    execute: executions(
      async ({ request }, signal) =>
        executor.execute({ ...(request as Omit<FoundryExecutionRequest, "abort">), abort: signal }),
      ({ request }) => (request as { orgId?: unknown } | null)?.orgId,
    ),
    cancel: async ({ invocationId, fencingToken }) => executor.cancel(text(invocationId), fence(fencingToken)),
    reconcile: async ({ invocationId }) => executor.reconcile(text(invocationId)),
    resolveEvidence: async ({ orgId, receiptRef }) => evaluator.resolveEvidence(text(orgId), text(receiptRef)),
    ...(skills
      ? {
          syncCapability: async ({ capability }) => skills.sync(exported(capability)),
          lookupCapability: async ({ query }) => skills.lookup(lookupOf(query)),
        }
      : {}),
  };
  const fetch = createFoundryRpcHandler({ token: config.runtimeToken, methods });
  return {
    fetch,
    executor,
    async close() {
      const running = evaluationLedger.db
        .query<{ jobRef: string }, []>(
          "SELECT jobRef FROM protected_evaluations WHERE phase IN ('RESERVED','RUNNING','CANCEL_REQUESTED')",
        )
        .all();
      for (const { jobRef } of running) await evaluator.cancelEvaluation(jobRef);
      evaluationLedger.close();
      ledger.close();
    },
  };
}

/** Admission before any runner sees a request: a pool limit plus a per-workspace limit. A refusal
 * throws FoundryRuntimeBusyError, which callers treat as "nothing started", never as unknown. */
export function createFoundryAdmission(options: { limit: number; perOrg: number }) {
  let active = 0;
  const byOrg = new Map<string, number>();
  return (method: FoundryRpcMethod, orgOf: (input: Record<string, unknown>) => unknown): FoundryRpcMethod =>
    async (input, signal) => {
      const org = orgOf(input);
      if (typeof org !== "string" || !org) throw new Error("Invalid organization");
      const mine = byOrg.get(org) ?? 0;
      if (active >= options.limit || mine >= options.perOrg) throw new FoundryRuntimeBusyError();
      active++;
      byOrg.set(org, mine + 1);
      try {
        return await method(input, signal);
      } finally {
        active--;
        const left = (byOrg.get(org) ?? 1) - 1;
        if (left > 0) byOrg.set(org, left);
        else byOrg.delete(org);
      }
    };
}
