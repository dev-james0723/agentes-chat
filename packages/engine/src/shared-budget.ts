import { and, type Database, eq, gt, lte, schema } from "@agenteschat/db";
import type { ModelProvider, ModelRequest, ModelResult, StreamOptions } from "@agenteschat/providers";
import { sha256 } from "./crypto";
import { credentialVersion } from "./credentials";
import { canonicalJson } from "./tools/json-schema";

/** Only trusted server code may provide a transport that actually enforces its per-call maximum upstream.
 * No production transport is registered by this candidate. Estimates or catalog prices are not a hard cap. */
export interface SharedBudgetTransport {
  /** Trusted adapter resolves a previously verified canonical billing namespace/account/pool for this credential.
   * Namespace identifies the upstream billing authority, independently of execution provider or adapter.
   * No production adapter exists in this candidate. Returning null or an unknown identity denies dispatch. */
  identify(
    binding: Readonly<{ provider: string; credentialId: string; credentialVersion: string }>,
  ): Promise<{ namespace: string; account: string; pool: string } | null>;
  /** Trusted adapter validates exact request context, capabilities and provider-specific constraints. */
  qualifies(request: Readonly<ModelRequest>): boolean;
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
    upstreamProvider: pool.upstreamProvider,
    upstreamAccount: pool.upstreamAccount,
    upstreamPool: pool.upstreamPool,
    ceilingNanoUsd: pool.ceilingNanoUsd,
    windowStart: pool.windowStart.toISOString(),
    windowEnd: pool.windowEnd.toISOString(),
    approvalUntil: pool.approvalUntil.toISOString(),
    routes: routes
      .map((r) => ({
        id: r.id,
        provider: r.provider,
        credentialId: r.credentialId,
        credentialVersion: r.credentialVersion,
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

/** Qualified request data must be plain, acyclic JSON-like values, then is frozen before trusted adapters see it. */
function freezeData(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) throw new SharedBudgetAdmissionError("cyclic request data");
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)
    throw new SharedBudgetAdmissionError("unsupported request data");
  seen.add(value);
  for (const child of Object.values(value)) freezeData(child, seen);
  Object.freeze(value);
}

/** Actual gateway dispatch wrapper. Missing policy is legacy mode, not a claim of budget protection. */
export async function withSharedBudget(
  db: Database,
  input: {
    orgId: string;
    subject: string;
    providerId: string;
    credentialId: string | null;
    credentialVersion?: string;
    required: boolean;
    dataClass?: string;
    request: ModelRequest;
    provider: ModelProvider;
    options: StreamOptions;
    transport?: SharedBudgetTransport;
    now: () => Date;
  },
): Promise<ModelResult> {
  // Legacy mode may run on an older schema; never touch candidate tables until this gateway explicitly requires them.
  if (!input.required) return input.provider.stream(input.request, input.options);
  // Capture the exact structured request and dispatch options before any asynchronous identity check. The caller
  // cannot mutate referenced messages or endpoint settings between qualification and provider dispatch.
  const request: ModelRequest = {
    ...input.request,
    system: structuredClone(input.request.system),
    messages: structuredClone(input.request.messages),
    ...(input.request.tools ? { tools: structuredClone(input.request.tools) } : {}),
    ...(input.request.outputSchema ? { outputSchema: structuredClone(input.request.outputSchema) } : {}),
    ...(input.request.notes ? { notes: structuredClone(input.request.notes) } : {}),
  };
  freezeData(request.system);
  freezeData(request.messages);
  if (request.tools) freezeData(request.tools);
  if (request.outputSchema) freezeData(request.outputSchema);
  if (request.notes) freezeData(request.notes);
  Object.freeze(request);
  const dispatchOptions: StreamOptions = {
    ...input.options,
    ...(input.options.endpoint ? { endpoint: { ...input.options.endpoint } } : {}),
  };
  const [policy] = await db.select().from(sharedBudgetPolicies).where(eq(sharedBudgetPolicies.orgId, input.orgId));
  if (!policy?.enabled) {
    if (input.required) throw new SharedBudgetAdmissionError("required policy unavailable");
    return input.provider.stream(input.request, input.options);
  }
  if (
    !input.credentialId ||
    !input.credentialVersion ||
    !input.dataClass ||
    !input.transport ||
    !input.transport.identify
  )
    throw new SharedBudgetAdmissionError("route, credential identity or enforceable cost bound unavailable");
  const transport = input.transport;
  const { identify, qualifies, bound, stream } = transport;
  // Identity lookup is a trusted, previously verified registry lookup: it receives neither the key nor callback.
  const identity = await identify.call(
    transport,
    Object.freeze({
      provider: input.providerId,
      credentialId: input.credentialId,
      credentialVersion: input.credentialVersion,
    }),
  );
  if (
    !identity ||
    !identity.namespace?.trim() ||
    !identity.account?.trim() ||
    !identity.pool?.trim() ||
    identity.namespace !== identity.namespace.trim() ||
    identity.account !== identity.account.trim() ||
    identity.pool !== identity.pool.trim() ||
    identity.namespace.length > 256 ||
    identity.account.length > 256 ||
    identity.pool.length > 256
  )
    throw new SharedBudgetAdmissionError("verified upstream identity unavailable");
  const identityNamespace = identity.namespace;
  const identityAccount = identity.account;
  const identityPool = identity.pool;
  // This candidate has no qualified image/PDF, opaque-history or structured-output routes.
  if (
    request.outputSchema ||
    request.messages.some((m) =>
      typeof m.content === "string"
        ? false
        : !Array.isArray(m.content) ||
          m.content.some(
            (b) =>
              !b ||
              !["text", "tool_use", "tool_result"].includes(b.type) ||
              (b.type === "tool_result" && (b.images?.length ?? 0) > 0),
          ),
    )
  )
    throw new SharedBudgetAdmissionError("request modality not qualified");
  if (!qualifies || qualifies.call(transport, request) !== true)
    throw new SharedBudgetAdmissionError("request context or capabilities not qualified");
  const max = bound.call(transport, request);
  if (!validAmount(max)) throw new SharedBudgetAdmissionError("enforceable cost bound unavailable");
  const promptBytes = new TextEncoder().encode(
    JSON.stringify({
      system: request.system,
      messages: request.messages,
      tools: request.tools,
      notes: request.notes,
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
    // The fingerprint came from the exact row used to decrypt the key. Lock and compare the current row before
    // reserving; same-id rotation, revocation or endpoint/config drift invalidates the old approval.
    const [credential] = await tx
      .select()
      .from(schema.providerCredentials)
      .where(
        and(
          eq(schema.providerCredentials.orgId, input.orgId),
          eq(schema.providerCredentials.id, input.credentialId as string),
        ),
      )
      .for("update");
    if (
      !credential ||
      credential.revokedAt ||
      credential.provider !== input.providerId ||
      credentialVersion(credential) !== input.credentialVersion
    )
      throw new SharedBudgetAdmissionError("credential changed or revoked");
    const at = input.now();
    const routes = await tx
      .select()
      .from(sharedBudgetRoutes)
      .where(
        and(
          eq(sharedBudgetRoutes.orgId, input.orgId),
          eq(sharedBudgetRoutes.provider, input.providerId),
          eq(sharedBudgetRoutes.credentialId, input.credentialId as string),
          eq(sharedBudgetRoutes.model, request.model),
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
      route.credentialVersion !== input.credentialVersion ||
      promptBytes > route.maxPromptBytes ||
      (request.tools?.length && !route.supportsTools)
    )
      throw new SharedBudgetAdmissionError("route capability or evidence unavailable");
    const [pool] = await tx
      .select()
      .from(sharedBudgetPools)
      .where(and(eq(sharedBudgetPools.orgId, input.orgId), eq(sharedBudgetPools.id, route.poolId)))
      .for("update");
    if (
      !pool ||
      pool.upstreamProvider !== identityNamespace ||
      pool.upstreamAccount !== identityAccount ||
      pool.upstreamPool !== identityPool ||
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
  // No generated text reaches consumers until the transport has returned the qualified model. A bounded buffer
  // prevents an unqualified upstream stream from leaking into the caller or growing without limit.
  const chunks: string[] = [];
  let bytes = 0;
  let overflow = false;
  const result = await stream.call(
    transport,
    input.provider,
    request,
    {
      ...dispatchOptions,
      onDelta: (text) => {
        if (!text) return;
        bytes += new TextEncoder().encode(text).length;
        if (bytes > 1_000_000 || chunks.length >= 16_000) {
          overflow = true;
          return;
        }
        chunks.push(text);
      },
    },
    max,
  );
  if (overflow || result.model !== request.model)
    throw new SharedBudgetAdmissionError("provider output or model unqualified; reservation held");
  if (!validAmount(result.costNanoUsd)) {
    for (const chunk of chunks) input.options.onDelta(chunk);
    return result;
  }
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
  for (const chunk of chunks) input.options.onDelta(chunk);
  return result;
}
