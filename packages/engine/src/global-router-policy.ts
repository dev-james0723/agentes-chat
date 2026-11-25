import {
  evaluateOfferEligibility,
  type GlobalRouterLane,
  isOpenRouterAutoModel,
  type ModelOffer,
  type ModelResult,
  OPENROUTER_AUTO,
  OPENROUTER_AUTO_CODE,
  type ProviderEntitlementKind,
  routerDenylistReason,
  type ToolSpec,
} from "@agenteschat/providers";

export interface GlobalRouterTaskRequirements {
  taskClass: "engineering" | "critical" | "general" | "routine";
  estimatedPromptTokens: number;
  maxOutputTokens: number;
  requiresTools: boolean;
  requiresSchema: boolean;
  requiresImages: boolean;
  requiresPdf: boolean;
  requiresZdr: boolean;
  allowedRegions?: readonly ("global" | "us_eu" | "cn")[];
}

export interface GlobalRouterAccountCandidate {
  id: string;
  provider: string;
  lane: Exclude<GlobalRouterLane, "subscription">;
  entitlement: ProviderEntitlementKind;
  enabled: boolean;
  killSwitch: boolean;
  extraUsageAllowed: boolean;
  healthState: "healthy" | "quota_warning" | "rate_limited" | "outage" | "reauth_required" | "paused";
  monthlyCapNanoUsd: number;
  spentNanoUsd: number;
  heldNanoUsd: number;
  allowedModels: readonly string[];
  rpmLimit: number | null;
  rpdLimit: number | null;
  dayRequestsUsed: number;
  dayRequestsHeld: number;
  dailyNeuronsLimit: number;
  dayNeuronsUsed: number;
  dayNeuronsHeld: number;
  zdrRequired: boolean;
  allowedRegion: string;
}

export interface HistoricalModelQuality {
  modelKey: string;
  verifiedSuccessRate: number;
  retryRate: number;
  p95LatencyMs: number;
}

export interface GlobalRouterSelectionInput {
  policyEnabled: boolean;
  killSwitch: boolean;
  agentOptedOut: boolean;
  scopeAuthorized: boolean;
  subscriptionsConsidered: boolean;
  subscriptionSourceState: "healthy" | "near_limit" | "exhausted" | "unavailable" | "unknown";
  subscriptionAlternatives: readonly {
    id: string;
    state: "available" | "near_limit" | "exhausted" | "unavailable" | "unknown";
  }[];
  safeTurnBoundary: boolean;
  portableContextQualified: boolean;
  requirements: GlobalRouterTaskRequirements;
  accounts: readonly GlobalRouterAccountCandidate[];
  offers: readonly ModelOffer[];
  qualityStats?: ReadonlyMap<string, HistoricalModelQuality>;
  excludedOfferIds?: ReadonlySet<string>;
  minimumLaneIndex?: number;
  nowMs?: number;
}

export type GlobalRouterSelectionDecision =
  | {
      ok: true;
      accountId: string;
      provider: string;
      lane: Exclude<GlobalRouterLane, "subscription">;
      entitlement: ProviderEntitlementKind;
      offer: ModelOffer;
      requestedModel: string;
      boundNanoUsd: number;
      reservedNeurons: number;
      expectedCostPerSuccessNanoUsd: number;
    }
  | {
      ok: false;
      reason:
        | "router_disabled"
        | "kill_switch_active"
        | "agent_opted_out"
        | "scope_unauthorized"
        | "subscription_available"
        | "subscription_evidence_unknown"
        | "unsafe_checkpoint"
        | "context_unqualified"
        | "privacy_blocked"
        | "modality_incompatible"
        | "budget_or_quota_exhausted"
        | "no_eligible_offer";
    };

const LANE_PRIORITY: readonly Exclude<GlobalRouterLane, "subscription">[] = [
  "opencode_go",
  "free_api",
  "paid_low_cost",
  "direct_api",
  "paid_dynamic",
];

function estimateWorstCaseNanoUsd(
  offer: ModelOffer,
  account: GlobalRouterAccountCandidate,
  allOffers: readonly ModelOffer[],
  promptTokens: number,
  maxOutputTokens: number,
): number | null {
  if (account.entitlement === "free_only" || account.entitlement === "subscription_go") {
    return offer.freeEligible ? 0 : null;
  }
  if (offer.lane === "paid_dynamic" && isOpenRouterAutoModel(offer.modelId)) {
    const concrete = allOffers.filter(
      (o) => o.provider === "openrouter" && account.allowedModels.includes(o.modelId) && o.prices !== null,
    );
    if (concrete.length !== account.allowedModels.length || concrete.length === 0) return null;
    const maxIn = Math.max(...concrete.map((c) => Math.max(c.prices!.input, c.prices!.cacheWrite)));
    const maxOut = Math.max(...concrete.map((c) => c.prices!.output));
    const maxFee = Math.max(...concrete.map((c) => c.requestFeeNanoUsd));
    return Math.ceil(promptTokens * maxIn + maxOutputTokens * maxOut + maxFee);
  }
  if (!offer.prices) return null;
  const inPrice = Math.max(offer.prices.input, offer.prices.cacheWrite);
  return Math.ceil(promptTokens * inPrice + maxOutputTokens * offer.prices.output + offer.requestFeeNanoUsd);
}

function estimateNeurons(offer: ModelOffer, promptTokens: number, maxOutputTokens: number): number {
  if (offer.provider !== "cloudflare") return 0;
  const rates = offer.neuronsPer1kTokens ?? { input: 32, output: 68 };
  return Math.max(1, Math.ceil((promptTokens / 1000) * rates.input + (maxOutputTokens / 1000) * rates.output));
}

/**
 * Deterministic multi-lane Global Model Router admission and ranking:
 * 1. Primary subscriptions win (`healthy` or `near_limit` 95% alert is NOT exhaustion).
 *    Stale/unknown subscription telemetry fails closed (`subscription_evidence_unknown`).
 * 2. Authorized OpenCode Go included allowance (`opencode_go`, Extra Usage OFF).
 * 3. Qualified Free API pool (`free_api`: OpenRouter `:free`, Groq Free, Cloudflare Free).
 *    Critical/engineering tasks never use unqualified free offers.
 * 4. Low-cost concrete paid offers (`paid_low_cost`) and approved direct APIs (`direct_api`).
 * 5. Bounded dynamic / escalated offers (`paid_dynamic`: `openrouter/auto-code` or `openrouter/auto`).
 */
export function selectGlobalRouterCandidate(input: GlobalRouterSelectionInput): GlobalRouterSelectionDecision {
  if (!input.policyEnabled) return { ok: false, reason: "router_disabled" };
  if (input.killSwitch) return { ok: false, reason: "kill_switch_active" };
  if (input.agentOptedOut) return { ok: false, reason: "agent_opted_out" };
  if (!input.scopeAuthorized) return { ok: false, reason: "scope_unauthorized" };

  // 95% subscription usage (`near_limit`) is a warning only, never proof of exhaustion.
  if (
    input.subscriptionSourceState === "healthy" ||
    input.subscriptionSourceState === "near_limit" ||
    input.subscriptionAlternatives.some((a) => a.state === "available" || a.state === "near_limit")
  ) {
    return { ok: false, reason: "subscription_available" };
  }

  if (
    !input.subscriptionsConsidered ||
    (input.subscriptionSourceState !== "exhausted" && input.subscriptionSourceState !== "unavailable") ||
    new Set(input.subscriptionAlternatives.map((a) => a.id)).size !== input.subscriptionAlternatives.length ||
    input.subscriptionAlternatives.some((a) => !a.id || (a.state !== "exhausted" && a.state !== "unavailable"))
  ) {
    return { ok: false, reason: "subscription_evidence_unknown" };
  }

  if (!input.safeTurnBoundary) return { ok: false, reason: "unsafe_checkpoint" };
  if (!input.portableContextQualified) return { ok: false, reason: "context_unqualified" };

  const nowMs = input.nowMs ?? Date.now();
  const req = input.requirements;
  const totalContextNeeded = req.estimatedPromptTokens + req.maxOutputTokens;
  const minLaneIdx = input.minimumLaneIndex ?? 0;

  let sawPrivacyBlock = false;
  let sawModalityBlock = false;
  let sawBudgetOrQuotaBlock = false;

  for (let laneIdx = minLaneIdx; laneIdx < LANE_PRIORITY.length; laneIdx++) {
    const lane = LANE_PRIORITY[laneIdx]!;
    const laneAccounts = input.accounts.filter(
      (a) =>
        a.lane === lane &&
        a.enabled &&
        !a.killSwitch &&
        !a.extraUsageAllowed &&
        a.healthState !== "paused" &&
        a.healthState !== "reauth_required" &&
        a.healthState !== "outage" &&
        a.healthState !== "rate_limited",
    );
    if (laneAccounts.length === 0) continue;

    const scored: {
      account: GlobalRouterAccountCandidate;
      offer: ModelOffer;
      requestedModel: string;
      boundNanoUsd: number;
      reservedNeurons: number;
      expectedCostPerSuccess: number;
      successRate: number;
      p95LatencyMs: number;
    }[] = [];

    for (const account of laneAccounts) {
      for (const rawOffer of input.offers) {
        if (rawOffer.provider !== account.provider || rawOffer.lane !== lane) continue;
        if (input.excludedOfferIds?.has(rawOffer.offerId)) continue;

        if (lane === "paid_dynamic") {
          const wantRouter = req.taskClass === "engineering" ? OPENROUTER_AUTO_CODE : OPENROUTER_AUTO;
          if (rawOffer.modelId !== wantRouter) continue;
        } else if (!account.allowedModels.includes(rawOffer.modelId)) {
          continue;
        }

        const effectiveOffer: ModelOffer =
          lane === "direct_api" && rawOffer.qualificationStatus === "requires_owner_approval"
            ? { ...rawOffer, qualificationStatus: "eligible" }
            : rawOffer;

        const elig = evaluateOfferEligibility(effectiveOffer, nowMs);
        if (!elig.eligible) continue;

        // Hard capability & modality checks (never silently drop images/PDFs or truncate context).
        if (req.requiresImages && !effectiveOffer.inputModalities.includes("image")) {
          sawModalityBlock = true;
          continue;
        }
        if (req.requiresPdf && !effectiveOffer.inputModalities.includes("pdf")) {
          sawModalityBlock = true;
          continue;
        }
        if (req.requiresTools && !effectiveOffer.capabilities.tools) continue;
        if (req.requiresSchema && !effectiveOffer.capabilities.structuredOutput) continue;
        if (totalContextNeeded > effectiveOffer.contextWindow || req.maxOutputTokens > effectiveOffer.maxOutputTokens) {
          continue;
        }

        // Privacy & region gates (never lower privacy on fallback).
        if (
          (req.requiresZdr || account.zdrRequired) &&
          (!effectiveOffer.privacy.zdr ||
            effectiveOffer.privacy.training === true ||
            effectiveOffer.privacy.dataCollection === "allow")
        ) {
          sawPrivacyBlock = true;
          continue;
        }
        if (
          req.allowedRegions?.length &&
          effectiveOffer.privacy.region !== "unknown" &&
          !req.allowedRegions.includes(effectiveOffer.privacy.region)
        ) {
          sawPrivacyBlock = true;
          continue;
        }

        // Never send critical or engineering multi-tool tasks to an unqualified free model.
        const quality = input.qualityStats?.get(`${account.provider}:${effectiveOffer.modelId}`);
        const successRate = quality?.verifiedSuccessRate ?? (lane === "free_api" ? 0.82 : 0.92);
        const retryRate = quality?.retryRate ?? 0.05;
        const p95LatencyMs = quality?.p95LatencyMs ?? 2500;

        if (lane === "free_api" && (req.taskClass === "critical" || req.taskClass === "engineering")) {
          if (
            !effectiveOffer.capabilities.tools ||
            !effectiveOffer.capabilities.structuredOutput ||
            successRate < 0.8
          ) {
            continue;
          }
        }

        const boundNanoUsd = estimateWorstCaseNanoUsd(
          effectiveOffer,
          account,
          input.offers,
          req.estimatedPromptTokens,
          req.maxOutputTokens,
        );
        if (boundNanoUsd === null) continue;

        const reservedNeurons = estimateNeurons(effectiveOffer, req.estimatedPromptTokens, req.maxOutputTokens);

        // Pre-check account quota and budget room.
        if (account.rpdLimit !== null && account.dayRequestsUsed + account.dayRequestsHeld + 1 > account.rpdLimit) {
          sawBudgetOrQuotaBlock = true;
          continue;
        }
        if (
          account.provider === "cloudflare" &&
          account.dayNeuronsUsed + account.dayNeuronsHeld + reservedNeurons > account.dailyNeuronsLimit
        ) {
          sawBudgetOrQuotaBlock = true;
          continue;
        }
        if (
          account.entitlement === "paid_capped" &&
          account.spentNanoUsd + account.heldNanoUsd + boundNanoUsd > account.monthlyCapNanoUsd
        ) {
          sawBudgetOrQuotaBlock = true;
          continue;
        }

        const expectedCostPerSuccess =
          boundNanoUsd === 0 ? 0 : Math.round((boundNanoUsd * (1 + retryRate)) / Math.max(successRate, 0.05));

        scored.push({
          account,
          offer: effectiveOffer,
          requestedModel: effectiveOffer.modelId,
          boundNanoUsd,
          reservedNeurons,
          expectedCostPerSuccess,
          successRate,
          p95LatencyMs,
        });
      }
    }

    if (scored.length > 0) {
      scored.sort(
        (a, b) =>
          a.expectedCostPerSuccess - b.expectedCostPerSuccess ||
          b.successRate - a.successRate ||
          a.p95LatencyMs - b.p95LatencyMs ||
          a.offer.offerId.localeCompare(b.offer.offerId),
      );
      const winner = scored[0]!;
      return {
        ok: true,
        accountId: winner.account.id,
        provider: winner.account.provider,
        lane: winner.account.lane,
        entitlement: winner.account.entitlement,
        offer: winner.offer,
        requestedModel: winner.requestedModel,
        boundNanoUsd: winner.boundNanoUsd,
        reservedNeurons: winner.reservedNeurons,
        expectedCostPerSuccessNanoUsd: winner.expectedCostPerSuccess,
      };
    }
  }

  if (sawPrivacyBlock) return { ok: false, reason: "privacy_blocked" };
  if (sawModalityBlock) return { ok: false, reason: "modality_incompatible" };
  if (sawBudgetOrQuotaBlock) return { ok: false, reason: "budget_or_quota_exhausted" };
  return { ok: false, reason: "no_eligible_offer" };
}

export interface QualityVerificationResult {
  ok: boolean;
  qualityVerified: boolean;
  safetyRefusal: boolean;
  escalate: boolean;
  reason: string | null;
}

/**
 * Quality Guardian: validates model reply structure, JSON output schema compliance,
 * and tool-call schema integrity. Safety refusals are never escalated around.
 */
export function verifyGlobalRouterOutput(
  result: Pick<ModelResult, "text" | "content" | "stopReason" | "model">,
  options: {
    provider: string;
    tools?: readonly ToolSpec[];
    outputSchema?: Record<string, unknown>;
  },
): QualityVerificationResult {
  const deny = routerDenylistReason(options.provider, result.model);
  if (deny) {
    return { ok: false, qualityVerified: false, safetyRefusal: false, escalate: false, reason: deny };
  }
  if (result.stopReason === "refusal") {
    // Never route around a safety refusal.
    return { ok: false, qualityVerified: false, safetyRefusal: true, escalate: false, reason: "safety_refusal" };
  }

  const toolUses = result.content.filter((b) => b.type === "tool_use");
  if (!result.text.trim() && toolUses.length === 0) {
    return { ok: false, qualityVerified: false, safetyRefusal: false, escalate: true, reason: "empty_output" };
  }

  if (toolUses.length > 0) {
    const allowedTools = new Map((options.tools ?? []).map((t) => [t.name, t]));
    for (const call of toolUses) {
      if (call.type !== "tool_use") continue;
      const spec = allowedTools.get(call.name);
      if (!spec) {
        return {
          ok: false,
          qualityVerified: false,
          safetyRefusal: false,
          escalate: true,
          reason: `unknown_tool:${call.name}`,
        };
      }
      if (!call.input || typeof call.input !== "object" || Array.isArray(call.input)) {
        return {
          ok: false,
          qualityVerified: false,
          safetyRefusal: false,
          escalate: true,
          reason: `invalid_tool_input:${call.name}`,
        };
      }
      const required = Array.isArray(spec.inputSchema.required)
        ? (spec.inputSchema.required as unknown[]).filter((k): k is string => typeof k === "string")
        : [];
      for (const reqKey of required) {
        if (!(reqKey in call.input) || call.input[reqKey] === undefined) {
          return {
            ok: false,
            qualityVerified: false,
            safetyRefusal: false,
            escalate: true,
            reason: `missing_tool_arg:${call.name}.${reqKey}`,
          };
        }
      }
    }
  }

  if (options.outputSchema && toolUses.length === 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.text);
    } catch {
      return {
        ok: false,
        qualityVerified: false,
        safetyRefusal: false,
        escalate: true,
        reason: "malformed_json_output",
      };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        ok: false,
        qualityVerified: false,
        safetyRefusal: false,
        escalate: true,
        reason: "schema_root_not_object",
      };
    }
    const required = Array.isArray(options.outputSchema.required)
      ? (options.outputSchema.required as unknown[]).filter((k): k is string => typeof k === "string")
      : [];
    for (const reqKey of required) {
      if (!(reqKey in (parsed as Record<string, unknown>))) {
        return {
          ok: false,
          qualityVerified: false,
          safetyRefusal: false,
          escalate: true,
          reason: `schema_missing_field:${reqKey}`,
        };
      }
    }
  }

  return { ok: true, qualityVerified: true, safetyRefusal: false, escalate: false, reason: null };
}

export interface EscalationDecisionInput {
  escalationsUsed: number;
  maxEscalations: number;
  retriesOnCurrentOffer: number;
  maxRetriesPerRoute: number;
  sideEffectUncertain: boolean;
  safetyRefusal: boolean;
  retryableTransportError: boolean;
  elapsedMs: number;
  maxElapsedMs?: number;
}

export function decideQualityEscalation(input: EscalationDecisionInput): {
  action: "retry_same" | "escalate_next" | "needs_owner";
  reason: string;
} {
  if (input.sideEffectUncertain) return { action: "needs_owner", reason: "reconciliation_required" };
  if (input.safetyRefusal) return { action: "needs_owner", reason: "safety_refusal" };
  if (input.elapsedMs >= (input.maxElapsedMs ?? 180_000)) {
    return { action: "needs_owner", reason: "escalation_deadline_exceeded" };
  }
  if (input.retryableTransportError && input.retriesOnCurrentOffer < Math.min(input.maxRetriesPerRoute, 1)) {
    return { action: "retry_same", reason: "bounded_route_retry" };
  }
  if (input.escalationsUsed < Math.min(input.maxEscalations, 2)) {
    return { action: "escalate_next", reason: "quality_or_availability_escalation" };
  }
  return { action: "needs_owner", reason: "escalation_budget_exhausted" };
}
