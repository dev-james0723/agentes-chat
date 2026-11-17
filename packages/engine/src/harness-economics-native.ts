import { and, type Database, eq, gt, schema } from "@agenteschat/db";
import { aggregateVerifiedEconomics, type EconomicsReport, type UsageAttempt } from "./harness-economics";

type NativeUsage = Pick<
  typeof schema.usageRecords.$inferSelect,
  | "id"
  | "orgId"
  | "runId"
  | "kind"
  | "purpose"
  | "provider"
  | "model"
  | "requestedModel"
  | "billedTo"
  | "partial"
  | "inputTokens"
  | "outputTokens"
  | "cacheReadTokens"
  | "cacheWriteTokens"
  | "costNanoUsd"
>;

export interface NativeHarnessEconomics {
  report: EconomicsReport;
  source: {
    kind: "native_usage_records";
    taskId: string;
    since: string;
    independentOutcomes: "unavailable";
    taskRevisionBinding: "unavailable";
    historicalPricingSource: "unavailable";
    cohortCompleteness: "not_established";
    unattributablePlatformUsage: "excluded_from_agent_scope";
    receipts: { id: string; runId: string | null; taskId: string | null }[];
  };
}

/** Native quote/counter history is preserved without upgrading unknown source or settlement metadata. */
export function nativeUsageAttempt(row: NativeUsage): UsageAttempt {
  // External services and plan brains do not share ModelUsage's token definitions. Legacy zeros
  // may stand for missing counters. Partial streams may contain estimates, not final usage.
  const countersUsable = !row.partial && row.billedTo === "org";
  return {
    id: row.id,
    orgId: row.orgId,
    runId: row.runId,
    kind: row.kind,
    purpose: row.purpose,
    provider: row.provider,
    model: row.model,
    requestedModel: row.requestedModel,
    billedTo: row.billedTo,
    partial: row.partial,
    inputTokens: countersUsable ? row.inputTokens : null,
    outputTokens: countersUsable ? row.outputTokens : null,
    cacheReadTokens: countersUsable ? row.cacheReadTokens : null,
    cacheWriteTokens: countersUsable ? row.cacheWriteTokens : null,
    costNanoUsd: row.costNanoUsd,
    usageSource: "unknown",
    tokenDefinitions: countersUsable ? { inputIncludesCache: false, outputIncludesReasoning: true } : null,
    accounting: null,
    // run.issueId is a mutable association, not a call-time task revision receipt.
  };
}

/**
 * Read-only native seam. The scorecard caller must admit the exact org/task feature and perform
 * native task visibility checks first. An issue's CURRENT revision cannot reconstruct a run's
 * revision at call time. Existing run_done/outcome feedback is not independent verification.
 */
export async function nativeHarnessEconomics(
  db: Database,
  orgId: string,
  agentId: string,
  taskId: string,
  since: Date,
): Promise<NativeHarnessEconomics> {
  const rows = await db
    .select({ usage: schema.usageRecords, taskId: schema.agentRuns.issueId })
    .from(schema.usageRecords)
    .innerJoin(
      schema.agentRuns,
      and(eq(schema.agentRuns.id, schema.usageRecords.runId), eq(schema.agentRuns.orgId, schema.usageRecords.orgId)),
    )
    .where(
      and(
        eq(schema.usageRecords.orgId, orgId),
        eq(schema.agentRuns.orgId, orgId),
        eq(schema.agentRuns.agentId, agentId),
        eq(schema.agentRuns.issueId, taskId),
        gt(schema.usageRecords.createdAt, since),
      ),
    );
  return {
    report: aggregateVerifiedEconomics(
      rows.map(({ usage }) => nativeUsageAttempt(usage)),
      [],
    ),
    source: {
      kind: "native_usage_records",
      taskId,
      since: since.toISOString(),
      independentOutcomes: "unavailable",
      taskRevisionBinding: "unavailable",
      historicalPricingSource: "unavailable",
      cohortCompleteness: "not_established",
      unattributablePlatformUsage: "excluded_from_agent_scope",
      receipts: rows.map(({ usage, taskId: issueId }) => ({ id: usage.id, runId: usage.runId, taskId: issueId })),
    },
  };
}
