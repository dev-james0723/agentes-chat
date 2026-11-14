import { and, type Database, eq, gt, lte, schema } from "@agenteschat/db";
import type { ModelProvider, ModelRequest, ModelResult, StreamOptions } from "@agenteschat/providers";
import { sha256 } from "./crypto";
import { canonicalJson } from "./tools/json-schema";

/** Only trusted server code may provide a transport that actually enforces its per-call maximum upstream.
 * No production transport is registered by this candidate. Estimates or catalog prices are not a hard cap. */
export interface SharedBudgetTransport {
  bound(request: ModelRequest): number | null;
  stream(
    provider: ModelProvider,
    request: ModelRequest,
    options: StreamOptions,
    maxNanoUsd: number,
  ): Promise<ModelResult>;
}

export class SharedBudgetAdmissionError extends Error {
  readonly retryable = false;
  constructor(reason: string) {
    super(`shared budget: ${reason}`);
    this.name = "SharedBudgetAdmissionError";
  }
}

const { sharedBudgetPolicies, sharedBudgetPools, sharedBudgetRoutes, sharedBudgetReservations } = schema;
export const SHARED_BUDGET_TOOL = "shared_budget_authorize";
export const SHARED_BUDGET_SCOPE = "shared_budget:authorize";
type Pool = typeof sharedBudgetPools.$inferSelect;
type Route = typeof sharedBudgetRoutes.$inferSelect;
/** The approval binds pool/window/ceiling and every mutable route attribute. */
export function sharedBudgetApprovalParams(pool: Pool, routes: Route[]): Record<string, unknown> {
  return {
    poolId: pool.id,
    ceilingNanoUsd: pool.ceilingNanoUsd,
    windowStart: pool.windowStart.toISOString(),
    windowEnd: pool.windowEnd.toISOString(),
    approvalUntil: pool.approvalUntil.toISOString(),
    routes: routes
      .map((r) => ({
        id: r.id,
        provider: r.provider,
        credentialId: r.credentialId,
        model: r.model,
        subject: r.subject,
        dataClass: r.dataClass,
        supportsTools: r.supportsTools,
        maxPromptBytes: r.maxPromptBytes,
        evidenceRef: r.evidenceRef,
        verifiedAt: r.verifiedAt.toISOString(),
        validUntil: r.validUntil.toISOString(),
        enabled: r.enabled,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}
export function sharedBudgetApprovalHash(params: Record<string, unknown>): string {
  return sha256(canonicalJson({ tool: SHARED_BUDGET_TOOL, scope: SHARED_BUDGET_SCOPE, connectionId: null, params }));
}
const validAmount = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/** Actual gateway dispatch wrapper. Missing policy is legacy mode, not a claim of budget protection. */
export async function withSharedBudget(
  db: Database,
  input: {
    orgId: string;
    subject: string;
    providerId: string;
    credentialId: string | null;
    required: boolean;
    dataClass?: string;
    request: ModelRequest;
    provider: ModelProvider;
    options: StreamOptions;
    transport?: SharedBudgetTransport;
    now: () => Date;
  },
): Promise<ModelResult> {
  const [policy] = await db.select().from(sharedBudgetPolicies).where(eq(sharedBudgetPolicies.orgId, input.orgId));
  if (!policy?.enabled) {
    if (input.required) throw new SharedBudgetAdmissionError("required policy unavailable");
    return input.provider.stream(input.request, input.options);
  }
  if (!input.credentialId || !input.dataClass || !input.transport)
    throw new SharedBudgetAdmissionError("route, data classification or enforceable cost bound unavailable");
  const max = input.transport.bound(input.request);
  if (!validAmount(max)) throw new SharedBudgetAdmissionError("enforceable cost bound unavailable");
  const promptBytes = new TextEncoder().encode(
    JSON.stringify({
      system: input.request.system,
      messages: input.request.messages,
      tools: input.request.tools,
    }),
  ).length;
  const reservation = await db.transaction(async (tx) => {
    // All policy/route writers must use this same lock protocol; this candidate exposes no writer API.
    const [lockedPolicy] = await tx
      .select()
      .from(sharedBudgetPolicies)
      .where(eq(sharedBudgetPolicies.orgId, input.orgId))
      .for("update");
    if (!lockedPolicy?.enabled) throw new SharedBudgetAdmissionError("policy changed");
    const at = input.now();
    const routes = await tx
      .select()
      .from(sharedBudgetRoutes)
      .where(
        and(
          eq(sharedBudgetRoutes.orgId, input.orgId),
          eq(sharedBudgetRoutes.provider, input.providerId),
          eq(sharedBudgetRoutes.credentialId, input.credentialId as string),
          eq(sharedBudgetRoutes.model, input.request.model),
          eq(sharedBudgetRoutes.subject, input.subject),
          eq(sharedBudgetRoutes.dataClass, input.dataClass as string),
          eq(sharedBudgetRoutes.enabled, true),
          lte(sharedBudgetRoutes.verifiedAt, at),
          gt(sharedBudgetRoutes.validUntil, at),
        ),
      )
      .for("update");
    if (routes.length !== 1) throw new SharedBudgetAdmissionError("route not uniquely qualified");
    const route = routes[0];
    if (
      !route ||
      !route.evidenceRef.trim() ||
      promptBytes > route.maxPromptBytes ||
      (input.request.tools?.length && !route.supportsTools)
    )
      throw new SharedBudgetAdmissionError("route capability or evidence unavailable");
    const [pool] = await tx
      .select()
      .from(sharedBudgetPools)
      .where(and(eq(sharedBudgetPools.orgId, input.orgId), eq(sharedBudgetPools.id, route.poolId)))
      .for("update");
    if (
      !pool ||
      pool.paused ||
      !pool.approvedBy.trim() ||
      !pool.approvalRef.trim() ||
      pool.windowStart > at ||
      pool.windowEnd <= at ||
      pool.approvalUntil <= at ||
      !validAmount(pool.ceilingNanoUsd) ||
      !validAmount(pool.spentNanoUsd) ||
      !validAmount(pool.heldNanoUsd) ||
      !validAmount(pool.spentNanoUsd + pool.heldNanoUsd + max) ||
      pool.spentNanoUsd + pool.heldNanoUsd + max > pool.ceilingNanoUsd
    )
      throw new SharedBudgetAdmissionError("pool unavailable or ceiling reached");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(pool.approvalRef))
      throw new SharedBudgetAdmissionError("approved authorization unavailable");
    const [approval] = await tx
      .select()
      .from(schema.approvals)
      .where(and(eq(schema.approvals.orgId, input.orgId), eq(schema.approvals.id, pool.approvalRef)))
      .for("update");
    const allRoutes = await tx
      .select()
      .from(sharedBudgetRoutes)
      .where(and(eq(sharedBudgetRoutes.orgId, input.orgId), eq(sharedBudgetRoutes.poolId, pool.id)))
      .for("update");
    const params = sharedBudgetApprovalParams(pool, allRoutes);
    const dispatchAt = input.now();
    if (
      pool.windowStart > dispatchAt ||
      pool.windowEnd <= dispatchAt ||
      pool.approvalUntil <= dispatchAt ||
      route.verifiedAt > dispatchAt ||
      route.validUntil <= dispatchAt
    )
      throw new SharedBudgetAdmissionError("authorization or route expired during admission");
    if (
      !approval ||
      approval.status !== "approved" ||
      !approval.decidedAt ||
      approval.decidedAt > dispatchAt ||
      approval.expiresAt <= dispatchAt ||
      approval.expiresAt < pool.approvalUntil ||
      approval.decidedByUserId !== pool.approvedBy ||
      approval.tool !== SHARED_BUDGET_TOOL ||
      approval.scope !== SHARED_BUDGET_SCOPE ||
      approval.connectionId !== null ||
      canonicalJson(approval.params) !== canonicalJson(params) ||
      approval.actionHash !== sharedBudgetApprovalHash(params)
    )
      throw new SharedBudgetAdmissionError("approved authorization unavailable or changed");
    const [held] = await tx
      .insert(sharedBudgetReservations)
      .values({
        orgId: input.orgId,
        poolId: pool.id,
        routeId: route.id,
        amountNanoUsd: max,
      })
      .returning();
    if (!held) throw new SharedBudgetAdmissionError("reservation failed");
    await tx
      .update(sharedBudgetPools)
      .set({ heldNanoUsd: pool.heldNanoUsd + max })
      .where(and(eq(sharedBudgetPools.orgId, input.orgId), eq(sharedBudgetPools.id, pool.id)));
    return held;
  });
  // Every thrown error or unknown cost retains the reservation, even after a restart.
  const result = await input.transport.stream(input.provider, input.request, input.options, max);
  if (result.model !== input.request.model)
    throw new SharedBudgetAdmissionError("provider returned an unqualified model; reservation held");
  if (!validAmount(result.costNanoUsd)) return result;
  const actual = result.costNanoUsd;
  await db.transaction(async (tx) => {
    const [held] = await tx
      .select()
      .from(sharedBudgetReservations)
      .where(
        and(
          eq(sharedBudgetReservations.id, reservation.id),
          eq(sharedBudgetReservations.orgId, input.orgId),
          eq(sharedBudgetReservations.state, "held"),
        ),
      )
      .for("update");
    if (!held) return;
    const [pool] = await tx
      .select()
      .from(sharedBudgetPools)
      .where(and(eq(sharedBudgetPools.id, held.poolId), eq(sharedBudgetPools.orgId, input.orgId)))
      .for("update");
    if (!pool || pool.heldNanoUsd < held.amountNanoUsd || !validAmount(pool.spentNanoUsd + actual))
      throw new SharedBudgetAdmissionError("reservation reconciliation required");
    await tx
      .update(sharedBudgetReservations)
      .set({ state: "settled", actualNanoUsd: actual, settledAt: input.now() })
      .where(eq(sharedBudgetReservations.id, held.id));
    await tx
      .update(sharedBudgetPools)
      .set({
        heldNanoUsd: pool.heldNanoUsd - held.amountNanoUsd,
        spentNanoUsd: pool.spentNanoUsd + actual,
        paused: pool.paused || actual > held.amountNanoUsd,
      })
      .where(eq(sharedBudgetPools.id, pool.id));
  });
  if (actual > max) throw new SharedBudgetAdmissionError("enforced cost bound violated; pool paused");
  return result;
}
