import type {
  FoundryCancellationResult,
  FoundryEvaluationCancellationResult,
  FoundryEvaluationReceipt,
  FoundryEvaluationResult,
  FoundryExecutionResult,
  FoundryExecutor,
  FoundryQualification,
} from "./foundry-executor";
import type { ProtectedFoundryEvidence } from "./foundry-protected-evaluator";
import { createFoundryRpcClient } from "./foundry-rpc";

/** Native server adapter; it never receives a Docker socket, host shell or
 * evaluator file path. The dedicated runtime retains its own qualification and
 * dispatch journals and calls the server back for current native authorization. */
export function createRemoteFoundryExecutor(options: { url: string; token: string; fetch?: typeof fetch }) {
  const call = createFoundryRpcClient(options);
  const executor: FoundryExecutor = {
    async qualify(): Promise<FoundryQualification> {
      try {
        const result = (await call("qualify", {})) as FoundryQualification;
        return result && typeof result.qualified === "boolean"
          ? result
          : { qualified: false, code: "BLOCKED_SANDBOX", reason: "Protected runtime is unavailable." };
      } catch {
        return { qualified: false, code: "BLOCKED_SANDBOX", reason: "Protected runtime is unavailable." };
      }
    },
    async evaluate(version, job): Promise<FoundryEvaluationReceipt> {
      try {
        return (await call("evaluate", { version, job }, 115000)) as FoundryEvaluationReceipt;
      } catch {
        await executor.cancelEvaluation(job);
        throw new Error("Protected evaluation outcome unknown; reconcile the same job.");
      }
    },
    async reconcileEvaluation(job): Promise<FoundryEvaluationResult> {
      try {
        return (await call("reconcileEvaluation", { job })) as FoundryEvaluationResult;
      } catch {
        return { outcome: "UNKNOWN_OUTCOME", evaluatorJobRef: job, receiptRef: null, reconciliationRef: job };
      }
    },
    async cancelEvaluation(job): Promise<FoundryEvaluationCancellationResult> {
      try {
        return (await call("cancelEvaluation", { job }, 10000)) as FoundryEvaluationCancellationResult;
      } catch {
        return { outcome: "UNKNOWN_OUTCOME", evaluatorJobRef: job, receiptRef: null, reconciliationRef: job };
      }
    },
    async execute(request): Promise<FoundryExecutionResult> {
      const { abort, ...wire } = request;
      const cancel = () => {
        void executor.cancel(request.invocationId, request.fencingToken);
      };
      if (abort.aborted) cancel();
      abort.addEventListener("abort", cancel, { once: true });
      try {
        return (await call("execute", { request: wire }, 15000, abort)) as FoundryExecutionResult;
      } catch {
        await executor.cancel(request.invocationId, request.fencingToken);
        return { outcome: "UNKNOWN_OUTCOME", receiptRef: null, reconciliationRef: request.invocationId };
      } finally {
        abort.removeEventListener("abort", cancel);
      }
    },
    async cancel(invocationId, fencingToken): Promise<FoundryCancellationResult> {
      try {
        return (await call("cancel", { invocationId, fencingToken }, 10000)) as FoundryCancellationResult;
      } catch {
        return {
          outcome: "UNKNOWN_OUTCOME",
          invocationId,
          fencingToken,
          receiptRef: null,
          reconciliationRef: invocationId,
        };
      }
    },
    async reconcile(invocationId): Promise<FoundryExecutionResult> {
      try {
        return (await call("reconcile", { invocationId })) as FoundryExecutionResult;
      } catch {
        return { outcome: "UNKNOWN_OUTCOME", receiptRef: null, reconciliationRef: invocationId };
      }
    },
  };
  return {
    executor,
    evaluations: {
      async resolve(orgId: string, receiptRef: string): Promise<ProtectedFoundryEvidence | null> {
        try {
          return (await call("resolveEvidence", { orgId, receiptRef })) as ProtectedFoundryEvidence | null;
        } catch {
          return null;
        }
      },
    },
  };
}
