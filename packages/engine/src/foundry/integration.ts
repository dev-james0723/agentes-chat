import type { FoundryAdmission, FoundryFrozenVersion, FoundryRunnerExecutionRequest, FoundryRpcMethod } from "@agenteschat/adapters";
import { and, eq, inArray, isNull, schema } from "@agenteschat/db";
import { createFoundryExecutionPolicy, type FoundryBuilderRunPin, type FoundryExecutionPolicy } from "./execution-policy";
import { createFoundryLifecycle, type FoundryLifecycleDependencies } from "./lifecycle";
import { loadFoundryBundle } from "./service";
import { createFoundryToolSource } from "./tools";

/** One wiring point for native Tool Gateway, run executor, outbox and private
 * runtime callbacks. Disabled drafting MUST NOT disable persisted run policy. */
export function createNativeFoundryIntegration(options: FoundryLifecycleDependencies & { enabled: boolean }) {
  const { db } = options;
  let lifecycle: ReturnType<typeof createFoundryLifecycle>;
  const builderPolicy: FoundryExecutionPolicy = createFoundryExecutionPolicy({ pins: [],
    readPin: async (ctx, tx = db) => {
      const [r] = await tx.select({ pin: schema.agentRuns.foundryPolicy }).from(schema.agentRuns)
        .where(and(eq(schema.agentRuns.id, ctx.runId), eq(schema.agentRuns.orgId, ctx.orgId)));
      return r?.pin as unknown as FoundryBuilderRunPin | null ?? null;
    },
    readRun: async (ctx, tx = db) => (await tx.select().from(schema.agentRuns)
      .where(and(eq(schema.agentRuns.id, ctx.runId), eq(schema.agentRuns.orgId, ctx.orgId))))[0] ?? null,
    capabilities: ctx => lifecycle.discover(ctx),
  });
  const deps = { ...options, builderPolicy };
  lifecycle = createFoundryLifecycle(deps);
  const reference = (value: unknown, pattern: RegExp) => { if (typeof value !== "string" || !pattern.test(value)) throw new Error("Invalid control reference"); return value; };
  const uuid = (value: unknown) => reference(value, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i);
  const controls: Record<string, FoundryRpcMethod> = {
    authorizeExecution: async ({ request, admission }, signal) => options.enabled && lifecycle.authorizeRunnerExecution(
      { ...(request as FoundryRunnerExecutionRequest), abort: signal }, admission as FoundryAdmission),
    authorizeEvaluation: async ({ version, job, admission }) => options.enabled
      ? lifecycle.authorizeRunnerEvaluation(version as FoundryFrozenVersion, reference(job, /^[^\u0000-\u001f]{1,1024}$/), admission as FoundryAdmission) : null,
    protectionCurrent: async ({ proof }) => {
      if (!options.enabled || !proof || typeof proof !== "object") return false;
      const p = proof as Record<string, unknown>;
      const [r] = await db.select().from(schema.agentRuns).where(and(eq(schema.agentRuns.id, uuid(p.runId)), eq(schema.agentRuns.orgId, uuid(p.orgId))));
      if (!r) return false;
      const current = await builderPolicy.protection({ orgId: r.orgId, agentId: r.agentId, runId: r.id }, "read_evidence");
      return !!current && current.orgId === p.orgId && current.taskId === p.taskId && current.agentId === p.agentId &&
        current.phaseRef === p.phaseRef && current.policyDigest === p.policyDigest && current.expiresAt === p.expiresAt;
    },
    package: async ({ orgId, digest }) => {
      if (!options.enabled) throw new Error("Foundry disabled");
      const [v] = await db.select().from(schema.foundryVersions).where(and(eq(schema.foundryVersions.orgId, uuid(orgId)),
        eq(schema.foundryVersions.digest, reference(digest, /^[a-f0-9]{64}$/)), isNull(schema.foundryVersions.retiredAt),
        inArray(schema.foundryVersions.state, ["EVALUATING", "REVIEW_READY", "CANARY", "ACTIVE"])));
      if (!v) throw new Error("Frozen version not available");
      return loadFoundryBundle(deps, v);
    },
  };
  return { builderPolicy, lifecycle, deps, source: createFoundryToolSource(deps), controls };
}
export type NativeFoundryIntegration = ReturnType<typeof createNativeFoundryIntegration>;
