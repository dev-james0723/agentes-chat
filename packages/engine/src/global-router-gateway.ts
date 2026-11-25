import { and, type Database, desc, type Executor, eq, schema } from "@agenteschat/db";
import {
  autoRouterKeyWithinCap,
  costNanoUsd,
  estimateTokens,
  hasToolImages,
  isKnownModel,
  isOpenRouterAutoModel,
  type ModelOffer,
  type ModelProvider,
  type ModelRequest,
  type ModelResult,
  OPENROUTER_API,
  PDF_MEDIA_TYPE,
  ProviderError,
  promptChars,
  providerCause,
} from "@agenteschat/providers";
import type { Agent } from "./agents";
import { assertCreditClaim, type CreditNativeClaim } from "./credit-continuity";
import { sha256 } from "./crypto";
import type { GatewayCall, GatewayResult } from "./gateway";
import { GlobalRouterRefusal, reserveGlobalRouterAttempt, settleGlobalRouterAttempt } from "./global-router-ledger";
import {
  decideQualityEscalation,
  type GlobalRouterAccountCandidate,
  type GlobalRouterTaskRequirements,
  type HistoricalModelQuality,
  selectGlobalRouterCandidate,
  verifyGlobalRouterOutput,
} from "./global-router-policy";
import { assertPersonUnderLimit, personSpendAdded } from "./person-usage";
import { hasCredentialText } from "./quota-qualifier";

export interface GlobalRouterRouteRecord {
  schema: "global-model-router/1";
  policyRevision: number;
  taskClass: "engineering" | "critical" | "general" | "routine";
  requiresZdr?: boolean;
}

const periodOf = (at: Date) => at.toISOString().slice(0, 7);

/** Dedicated Global Router keys are reserved and cannot be used by ordinary unbudgeted calls. */
export async function globalRouterKeyReserved(
  db: Executor,
  orgId: string,
  credentialId: string | null,
  fingerprint: string,
): Promise<boolean> {
  const [byFp] = await db
    .select({ id: schema.globalRouterAccounts.id })
    .from(schema.globalRouterAccounts)
    .where(eq(schema.globalRouterAccounts.credentialFingerprint, fingerprint))
    .limit(1);
  if (byFp) return true;
  if (!credentialId) return false;
  const [byId] = await db
    .select({ id: schema.globalRouterAccounts.id })
    .from(schema.globalRouterAccounts)
    .where(
      and(eq(schema.globalRouterAccounts.orgId, orgId), eq(schema.globalRouterAccounts.credentialId, credentialId)),
    )
    .limit(1);
  return Boolean(byId);
}

async function loadRouterContext(db: Executor, orgId: string, at: Date) {
  const period = periodOf(at);
  const [policy] = await db
    .select()
    .from(schema.globalRouterPolicies)
    .where(eq(schema.globalRouterPolicies.orgId, orgId));
  const accountRows = await db
    .select()
    .from(schema.globalRouterAccounts)
    .where(eq(schema.globalRouterAccounts.orgId, orgId));
  const windowRows = await db
    .select()
    .from(schema.globalRouterWindows)
    .where(and(eq(schema.globalRouterWindows.orgId, orgId), eq(schema.globalRouterWindows.period, period)));
  const offerRows = await db.select().from(schema.globalRouterOffers).where(eq(schema.globalRouterOffers.orgId, orgId));
  const recentSettled = await db
    .select({
      provider: schema.globalRouterAttempts.provider,
      requestedModel: schema.globalRouterAttempts.requestedModel,
      qualityVerified: schema.globalRouterAttempts.qualityVerified,
      attemptIndex: schema.globalRouterAttempts.attemptIndex,
      latencyMs: schema.globalRouterAttempts.latencyMs,
    })
    .from(schema.globalRouterAttempts)
    .where(and(eq(schema.globalRouterAttempts.orgId, orgId), eq(schema.globalRouterAttempts.state, "settled")))
    .orderBy(desc(schema.globalRouterAttempts.createdAt))
    .limit(100);

  const rawQuality = new Map<
    string,
    { attempts: number; verifiedSuccesses: number; retries: number; latencies: number[] }
  >();
  for (const row of recentSettled) {
    const key = `${row.provider}:${row.requestedModel}`;
    const prev = rawQuality.get(key) ?? { attempts: 0, verifiedSuccesses: 0, retries: 0, latencies: [] };
    prev.attempts++;
    if (row.qualityVerified) prev.verifiedSuccesses++;
    if (row.attemptIndex > 1) prev.retries++;
    if (typeof row.latencyMs === "number") prev.latencies.push(row.latencyMs);
    rawQuality.set(key, prev);
  }
  const qualityMap = new Map<string, HistoricalModelQuality>();
  for (const [key, q] of rawQuality) {
    const sorted = [...q.latencies].sort((a, b) => a - b);
    const p95 = sorted.length > 0 ? (sorted[Math.floor((sorted.length - 1) * 0.95)] ?? 1000) : 1000;
    qualityMap.set(key, {
      modelKey: key,
      verifiedSuccessRate: q.attempts > 0 ? q.verifiedSuccesses / q.attempts : 1,
      retryRate: q.attempts > 0 ? q.retries / q.attempts : 0,
      p95LatencyMs: p95,
    });
  }

  const winByAccount = new Map(windowRows.map((w) => [w.accountId, w]));
  const dayKey = at.toISOString().slice(0, 10);

  const candidates: GlobalRouterAccountCandidate[] = accountRows.map((a) => {
    const w = winByAccount.get(a.id);
    const sameDay = w?.dayKey === dayKey;
    return {
      id: a.id,
      provider: a.provider,
      lane: a.lane,
      entitlement: a.entitlement,
      enabled: a.enabled,
      killSwitch: a.killSwitch,
      extraUsageAllowed: a.extraUsageAllowed,
      healthState: w?.paused ? "paused" : a.healthState,
      monthlyCapNanoUsd: a.monthlyCapNanoUsd,
      spentNanoUsd: w?.spentNanoUsd ?? 0,
      heldNanoUsd: w?.heldNanoUsd ?? 0,
      allowedModels: a.allowedModels,
      rpmLimit: a.rpmLimit,
      rpdLimit: a.rpdLimit,
      dayRequestsUsed: sameDay ? (w?.dayRequestsUsed ?? 0) : 0,
      dayRequestsHeld: sameDay ? (w?.dayRequestsHeld ?? 0) : 0,
      dailyNeuronsLimit: a.dailyNeuronsLimit,
      dayNeuronsUsed: sameDay ? (w?.dayNeuronsUsed ?? 0) : 0,
      dayNeuronsHeld: sameDay ? (w?.dayNeuronsHeld ?? 0) : 0,
      zdrRequired: a.zdrRequired,
      allowedRegion: a.allowedRegion,
    };
  });

  const offers = offerRows.map((r) => r.offer as unknown as ModelOffer);
  return { policy, candidates, offers, qualityMap };
}

/** Pre-handoff qualification check used by the native executor at a safe portable turn boundary. */
export async function qualifyGlobalRouterHandoff(
  db: Executor,
  input: {
    orgId: string;
    agentId: string;
    taskClass: "engineering" | "critical" | "general" | "routine";
    estimatedPromptTokens: number;
    maxOutputTokens: number;
    requiresTools: boolean;
    requiresImages: boolean;
    requiresPdf: boolean;
    requiresZdr?: boolean;
    subscriptionSourceState: "healthy" | "near_limit" | "exhausted" | "unavailable" | "unknown";
    subscriptionAlternatives: readonly {
      id: string;
      state: "available" | "near_limit" | "exhausted" | "unavailable" | "unknown";
    }[];
    now?: () => Date;
  },
): Promise<
  | { ok: true; route: GlobalRouterRouteRecord; initialModel: string; initialProvider: string }
  | { ok: false; reason: string }
> {
  const at = (input.now ?? (() => new Date()))();
  const { policy, candidates, offers, qualityMap } = await loadRouterContext(db, input.orgId, at);
  if (!policy?.enabled || policy.killSwitch) return { ok: false, reason: "router_disabled" };
  const decision = selectGlobalRouterCandidate({
    policyEnabled: policy.enabled,
    killSwitch: policy.killSwitch,
    agentOptedOut: policy.optOutAgentIds.includes(input.agentId),
    scopeAuthorized: true,
    subscriptionsConsidered: true,
    subscriptionSourceState: input.subscriptionSourceState,
    subscriptionAlternatives: input.subscriptionAlternatives,
    safeTurnBoundary: true,
    portableContextQualified: true,
    requirements: {
      taskClass: input.taskClass,
      estimatedPromptTokens: Math.max(256, input.estimatedPromptTokens),
      maxOutputTokens: Math.max(256, input.maxOutputTokens),
      requiresTools: input.requiresTools,
      requiresSchema: false,
      requiresImages: input.requiresImages,
      requiresPdf: input.requiresPdf,
      requiresZdr: Boolean(input.requiresZdr),
    },
    accounts: candidates,
    offers,
    qualityStats: qualityMap,
    nowMs: at.getTime(),
  });
  if (!decision.ok) return { ok: false, reason: decision.reason };
  return {
    ok: true,
    route: {
      schema: "global-model-router/1",
      policyRevision: policy.revision,
      taskClass: input.taskClass,
      ...(input.requiresZdr ? { requiresZdr: true } : {}),
    },
    initialModel: decision.requestedModel,
    initialProvider: decision.provider,
  };
}

function requestModalities(messages: GatewayCall["messages"]) {
  let requiresImages = false;
  let requiresPdf = false;
  let hasOpaque = false;
  for (const m of messages) {
    if (typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type === "opaque") hasOpaque = true;
      if (b.type === "tool_result" && b.images?.length) {
        for (const img of b.images) {
          if (img.mediaType === PDF_MEDIA_TYPE) requiresPdf = true;
          else requiresImages = true;
        }
      }
    }
  }
  return { requiresImages, requiresPdf, hasOpaque };
}

function computeOfferActualNanoUsd(
  offer: ModelOffer,
  entitlement: string,
  result: ModelResult,
  at: Date,
): number | null {
  if (entitlement === "free_only" || entitlement === "subscription_go") {
    if (result.costNanoUsd !== undefined && result.costNanoUsd !== 0) return null;
    return 0;
  }
  if (result.costNanoUsd !== undefined) {
    return Number.isSafeInteger(result.costNanoUsd) && result.costNanoUsd >= 0 ? result.costNanoUsd : null;
  }
  if (offer.prices) {
    return (
      result.usage.inputTokens * offer.prices.input +
      result.usage.outputTokens * offer.prices.output +
      result.usage.cacheReadTokens * offer.prices.cacheRead +
      result.usage.cacheWriteTokens * offer.prices.cacheWrite +
      offer.requestFeeNanoUsd
    );
  }
  if (isKnownModel(result.model)) {
    return costNanoUsd(result.model, result.usage, at);
  }
  return null;
}

/**
 * Sole inference ingress execution for Global Model Router runs and routines:
 * - Atomically reserves Budget Guardian quota/spend before dispatch
 * - Validates Quality Guardian invariants (JSON schema, tool schema, non-empty output)
 * - Performs bounded retry (`<= 1`) and escalation (`<= 2`) across lanes without replaying side effects
 * - Retains holds on ambiguous mid-stream failures
 */
export async function executeGlobalRouterGatewayStream(deps: {
  db: Database;
  call: GatewayCall;
  agent: Agent;
  native: {
    route: GlobalRouterRouteRecord;
    claim: CreditNativeClaim;
    turn: number;
    routineRunId?: string | null;
  };
  sharedBudgetRequired: boolean;
  globalRouterEnabled: boolean;
  openRouterKeyFetch?: typeof fetch;
  now: () => Date;
  providerFor: (providerId: string) => ModelProvider;
  resolveKey: (
    orgId: string,
    provider: string,
    credentialId?: string | null,
  ) => Promise<{
    apiKey: string;
    workspaceId?: string;
    organization?: string;
    project?: string;
    endpoint?: { style: "openai" | "anthropic"; baseURL: string };
    credentialId: string | null;
    credentialVersion?: string;
  }>;
  reserveAgentBudget: (
    agent: Agent,
    model: string,
    promptTokens: number,
    maxTokens: number,
    longCache?: boolean,
    exactBound?: number,
  ) => Promise<{
    reservation: { id: string; agentId: string; periodStart: string } | null;
    maxTokens: number;
  }>;
  releaseAgentBudget: (
    reservation: { id: string; agentId: string; periodStart: string } | null,
    agent: Agent,
  ) => Promise<void>;
  settleAgentCall: (input: {
    agent: Agent;
    reservation: { id: string; agentId: string; periodStart: string } | null;
    runId?: string;
    personId?: string | null;
    credentialId: string | null;
    provider: string;
    model: string;
    usage: ModelResult["usage"];
    reportedCost?: number;
  }) => Promise<{ record: { id: string; cost: number }; spent: number; personSpent: number | null }>;
  checkThresholds: (agent: Agent, spent: number, actual: number) => Promise<void>;
}): Promise<GatewayResult> {
  const { db, call, agent, native, now } = deps;
  if (!call.runId || call.credit || call.openRouterFallback || deps.sharedBudgetRequired || !deps.globalRouterEnabled) {
    throw new GlobalRouterRefusal("route_disabled");
  }
  if (native.route.schema !== "global-model-router/1") {
    throw new GlobalRouterRefusal("invalid_route_schema");
  }

  const serialized = JSON.stringify({
    system: call.system,
    messages: call.messages,
    tools: call.tools,
    notes: call.notes,
  });
  const promptBytes = new TextEncoder().encode(serialized).length;
  const { requiresImages, requiresPdf, hasOpaque } = requestModalities(call.messages);
  if (hasCredentialText(serialized) || hasOpaque || promptBytes > 800_000) {
    throw new GlobalRouterRefusal("context_unqualified");
  }

  const estimatedPromptTokens = Math.max(
    64,
    estimateTokens(promptChars({ system: call.system, messages: call.messages, tools: call.tools })),
    Math.ceil(promptBytes / 4),
  );
  const personId = call.personId ?? null;
  if (personId) await assertPersonUnderLimit(db, call.orgId, personId, now());

  const startedMs = Date.now();
  const excludedOfferIds = new Set<string>();
  let escalationsUsed = 0;
  let retriesOnCurrentOffer = 0;
  let attemptIndex = 0;
  let lastAttemptId: string | null = null;
  let pinnedRetryOfferId: string | null = null;

  for (;;) {
    const at = now();
    const { policy, candidates, offers, qualityMap } = await loadRouterContext(db, call.orgId, at);
    if (!policy?.enabled || policy.killSwitch) throw new GlobalRouterRefusal("router_disabled");
    if (policy.revision !== native.route.policyRevision) throw new GlobalRouterRefusal("policy_changed");

    const requirements: GlobalRouterTaskRequirements = {
      taskClass: native.route.taskClass,
      estimatedPromptTokens,
      maxOutputTokens: Math.max(256, call.maxTokens),
      requiresTools: Boolean(call.tools?.length),
      requiresSchema: false,
      requiresImages,
      requiresPdf,
      requiresZdr: Boolean(native.route.requiresZdr),
    };

    const effectiveOffers = pinnedRetryOfferId ? offers.filter((o) => o.offerId === pinnedRetryOfferId) : offers;

    const selection = selectGlobalRouterCandidate({
      policyEnabled: policy.enabled,
      killSwitch: policy.killSwitch,
      agentOptedOut: policy.optOutAgentIds.includes(call.agentId),
      scopeAuthorized: true,
      subscriptionsConsidered: true,
      subscriptionSourceState: "exhausted",
      subscriptionAlternatives: [],
      safeTurnBoundary: true,
      portableContextQualified: true,
      requirements,
      accounts: candidates,
      offers: effectiveOffers,
      qualityStats: qualityMap,
      excludedOfferIds,
      nowMs: at.getTime(),
    });

    if (!selection.ok) {
      throw new GlobalRouterRefusal(selection.reason);
    }
    pinnedRetryOfferId = null;
    attemptIndex++;

    const maxTokensCap = Math.min(call.maxTokens, selection.offer.maxOutputTokens);
    const agentBudget = await deps.reserveAgentBudget(
      agent,
      selection.requestedModel,
      0,
      maxTokensCap,
      false,
      selection.boundNanoUsd,
    );

    let admission: Awaited<ReturnType<typeof reserveGlobalRouterAttempt>>;
    try {
      admission = await reserveGlobalRouterAttempt(db, {
        orgId: call.orgId,
        accountId: selection.accountId,
        runId: call.runId,
        routineRunId: native.routineRunId ?? null,
        agentId: call.agentId,
        turn: native.turn,
        attemptIndex,
        idempotencyKey: `${call.runId}:t${native.turn}:a${attemptIndex}`,
        requestedModel: selection.requestedModel,
        boundNanoUsd: selection.boundNanoUsd,
        estimatedPromptTokens,
        maxOutputTokens: maxTokensCap,
        reservedNeurons: selection.reservedNeurons,
        escalatedFromId: lastAttemptId,
        now,
      });
    } catch (err) {
      await deps.releaseAgentBudget(agentBudget.reservation, agent);
      throw err;
    }

    let key: Awaited<ReturnType<typeof deps.resolveKey>>;
    try {
      key = await deps.resolveKey(call.orgId, admission.provider, admission.credentialId);
      if (
        key.endpoint ||
        key.credentialVersion !== admission.credentialVersion ||
        sha256(key.apiKey) !== admission.credentialFingerprint
      ) {
        throw new GlobalRouterRefusal("credential_changed");
      }
      if (admission.provider === "openrouter" && isOpenRouterAutoModel(selection.requestedModel)) {
        const capUsd = admission.monthlyCapNanoUsd / 1e9;
        const keyRes = await (deps.openRouterKeyFetch ?? fetch)(`${OPENROUTER_API}/key`, {
          headers: { authorization: `Bearer ${key.apiKey}` },
          redirect: "error",
          signal: AbortSignal.timeout(5000),
        });
        if (
          !keyRes.ok ||
          !autoRouterKeyWithinCap(await keyRes.json(), capUsd, at.getTime(), admission.reservedNanoUsd)
        ) {
          throw new GlobalRouterRefusal("key_limit_unverified");
        }
      }
    } catch (preSendError) {
      await settleGlobalRouterAttempt(
        db,
        call.orgId,
        admission.attemptId,
        { kind: "not_sent", reason: "preflight_failed", upstreamAttempted: false },
        now(),
      ).catch(() => {});
      await deps.releaseAgentBudget(agentBudget.reservation, agent).catch(() => {});
      excludedOfferIds.add(selection.offer.offerId);
      const esc = decideQualityEscalation({
        escalationsUsed,
        maxEscalations: policy.maxEscalations,
        retriesOnCurrentOffer,
        maxRetriesPerRoute: policy.maxRetriesPerRoute,
        sideEffectUncertain: false,
        safetyRefusal: false,
        retryableTransportError: false,
        elapsedMs: Date.now() - startedMs,
      });
      if (esc.action === "escalate_next") {
        escalationsUsed++;
        retriesOnCurrentOffer = 0;
        lastAttemptId = admission.attemptId;
        continue;
      }
      throw preSendError instanceof GlobalRouterRefusal ? preSendError : new GlobalRouterRefusal("preflight_failed");
    }

    const request: ModelRequest = {
      model: selection.requestedModel,
      system: structuredClone(call.system),
      messages: structuredClone(call.messages),
      maxTokens: agentBudget.maxTokens,
      ...(call.tools ? { tools: structuredClone(call.tools) } : {}),
      ...(call.notes ? { notes: structuredClone(call.notes) } : {}),
      ...(call.effort ? { effort: call.effort } : {}),
      noTransportRetries: true,
      ...(admission.provider === "openrouter" && admission.entitlement === "free_only"
        ? { openRouterFreeOnly: true as const }
        : {}),
      ...(admission.provider === "openrouter" &&
      admission.lane === "paid_low_cost" &&
      !isOpenRouterAutoModel(selection.requestedModel)
        ? {
            openRouterConcretePolicy: {
              maxPromptUsdPerMillion: admission.maxPromptNanoPerToken / 1000,
              maxCompletionUsdPerMillion: admission.maxCompletionNanoPerToken / 1000,
              zdr: admission.zdrRequired,
            },
          }
        : {}),
      ...(admission.provider === "openrouter" && isOpenRouterAutoModel(selection.requestedModel)
        ? {
            openRouterAuto: {
              allowedModels: admission.allowedModels,
              costTier: "medium" as const,
              monthlyCapUsd: admission.monthlyCapNanoUsd / 1e9,
              maxPromptUsdPerMillion: admission.maxPromptNanoPerToken / 1000,
              maxCompletionUsdPerMillion: admission.maxCompletionNanoPerToken / 1000,
            },
            openRouterReservedNanoUsd: admission.reservedNanoUsd,
          }
        : {}),
      signal: AbortSignal.any([...(call.signal ? [call.signal] : []), AbortSignal.timeout(120_000)]),
    };

    const chunks: string[] = [];
    let outputBytes = 0;
    const callStartMs = Date.now();
    let result: ModelResult;

    try {
      await assertCreditClaim(db, call.orgId, call.runId, native.claim, now());
      result = await deps.providerFor(admission.provider).stream(request, {
        apiKey: key.apiKey,
        workspaceId: admission.workspaceAccountRef ?? key.workspaceId,
        organization: key.organization,
        project: key.project,
        session: call.runId,
        onDelta: (chunk) => {
          outputBytes += new TextEncoder().encode(chunk).length;
          if (outputBytes <= 1_000_000 && chunks.length < 16_000) chunks.push(chunk);
        },
      });
    } catch (transportErr) {
      const pErr = transportErr instanceof ProviderError ? transportErr : null;
      const cause = pErr ? providerCause(pErr) : null;
      const provenUncharged =
        pErr !== null &&
        !pErr.partial &&
        outputBytes === 0 &&
        (pErr.status === 401 ||
          pErr.status === 402 ||
          pErr.status === 403 ||
          pErr.status === 404 ||
          pErr.status === 429);

      if (!provenUncharged) {
        // Ambiguous mid-stream or unknown transport drop: retain liability and stop replay.
        await settleGlobalRouterAttempt(
          db,
          call.orgId,
          admission.attemptId,
          { kind: "unknown", reason: "ambiguous_transport_outcome" },
          now(),
        ).catch(() => {});
        await deps.releaseAgentBudget(agentBudget.reservation, agent).catch(() => {});
        throw new GlobalRouterRefusal("reconciliation_required");
      }

      await settleGlobalRouterAttempt(
        db,
        call.orgId,
        admission.attemptId,
        {
          kind: "not_sent",
          reason: cause ?? `http_${pErr.status}`,
          upstreamAttempted: admission.provider === "openrouter" && admission.entitlement === "free_only",
        },
        now(),
      ).catch(() => {});
      await deps.releaseAgentBudget(agentBudget.reservation, agent).catch(() => {});

      const retryable = pErr.status === 429;
      const esc = decideQualityEscalation({
        escalationsUsed,
        maxEscalations: policy.maxEscalations,
        retriesOnCurrentOffer,
        maxRetriesPerRoute: policy.maxRetriesPerRoute,
        sideEffectUncertain: false,
        safetyRefusal: false,
        retryableTransportError: retryable,
        elapsedMs: Date.now() - startedMs,
      });

      if (esc.action === "retry_same") {
        retriesOnCurrentOffer++;
        pinnedRetryOfferId = selection.offer.offerId;
        lastAttemptId = admission.attemptId;
        continue;
      }
      if (esc.action === "escalate_next") {
        excludedOfferIds.add(selection.offer.offerId);
        escalationsUsed++;
        retriesOnCurrentOffer = 0;
        lastAttemptId = admission.attemptId;
        continue;
      }
      throw new GlobalRouterRefusal(cause ?? "provider_refused");
    }

    const latencyMs = Math.max(1, Date.now() - callStartMs);
    const actualNanoUsd = computeOfferActualNanoUsd(selection.offer, admission.entitlement, result, now());
    if (outputBytes > 1_000_000 || chunks.length >= 16_000 || actualNanoUsd === null) {
      await settleGlobalRouterAttempt(
        db,
        call.orgId,
        admission.attemptId,
        { kind: "unknown", reason: "receipt_unqualified" },
        now(),
      ).catch(() => {});
      await deps.releaseAgentBudget(agentBudget.reservation, agent).catch(() => {});
      throw new GlobalRouterRefusal("reconciliation_required");
    }

    const quality = verifyGlobalRouterOutput(result, {
      provider: admission.provider,
      tools: call.tools,
    });

    const settledAgent = await deps.settleAgentCall({
      agent: { ...agent, model: selection.requestedModel },
      reservation: agentBudget.reservation,
      runId: call.runId,
      personId,
      credentialId: key.credentialId,
      provider: admission.provider,
      model: result.model,
      usage: result.usage,
      reportedCost: actualNanoUsd,
    });

    await settleGlobalRouterAttempt(
      db,
      call.orgId,
      admission.attemptId,
      {
        kind: "settled",
        actualModel: result.model,
        actualNanoUsd,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cacheReadTokens: result.usage.cacheReadTokens,
        latencyMs,
        qualityVerified: quality.qualityVerified,
        providerRequestId: result.providerRequestId ?? null,
      },
      now(),
    );

    await assertCreditClaim(db, call.orgId, call.runId, native.claim, now());
    await deps.checkThresholds(agent, settledAgent.spent, actualNanoUsd);
    if (personId && settledAgent.personSpent !== null) {
      await personSpendAdded(
        db,
        { orgId: call.orgId, personId, amountNanoUsd: actualNanoUsd, at: now() },
        settledAgent.personSpent,
      );
    }

    if (quality.safetyRefusal) {
      for (const chunk of chunks) call.onDelta(chunk);
      return {
        ...result,
        usageRecordId: settledAgent.record.id,
        costNanoUsd: actualNanoUsd,
        maxTokens: agentBudget.maxTokens,
      };
    }

    if (!quality.ok && quality.escalate) {
      const esc = decideQualityEscalation({
        escalationsUsed,
        maxEscalations: policy.maxEscalations,
        retriesOnCurrentOffer,
        maxRetriesPerRoute: policy.maxRetriesPerRoute,
        sideEffectUncertain: false,
        safetyRefusal: false,
        retryableTransportError: false,
        elapsedMs: Date.now() - startedMs,
      });
      if (esc.action === "escalate_next") {
        excludedOfferIds.add(selection.offer.offerId);
        escalationsUsed++;
        retriesOnCurrentOffer = 0;
        lastAttemptId = admission.attemptId;
        continue;
      }
      throw new GlobalRouterRefusal(quality.reason ?? "quality_validation_failed");
    }

    for (const chunk of chunks) call.onDelta(chunk);
    return {
      ...result,
      usageRecordId: settledAgent.record.id,
      costNanoUsd: actualNanoUsd,
      maxTokens: agentBudget.maxTokens,
    };
  }
}
