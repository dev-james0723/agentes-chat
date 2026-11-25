import {
  autoRouterParameters,
  OPENROUTER_AUTO,
  OPENROUTER_AUTO_CODE,
  type OpenRouterAutoModel,
  type OpenRouterAutoPolicy,
} from "@agenteschat/providers";

/**
 * Subscription-first fallback admission decision (not a dispatcher or budget ledger).
 * Evidence must come from the native executor/model inspector, not an agent's prompt.
 * Missing/stale evidence is unknown, never equivalent to exhaustion.
 */
export interface OpenRouterFallbackInput {
  enabled: boolean;
  task: "engineering" | "general";
  subscriptionsConsidered: boolean;
  source: "exhausted" | "unavailable" | "healthy" | "unknown";
  alternatives: readonly { id: string; state: "available" | "exhausted" | "unavailable" | "unknown" }[];
  scopeAuthorized: boolean;
  safeTurnBoundary: boolean;
  portableContextQualified: boolean;
  keyLimitVerified: boolean;
  policy?: OpenRouterAutoPolicy;
}

export type OpenRouterFallbackDecision =
  | { ok: true; model: OpenRouterAutoModel }
  | {
      ok: false;
      reason:
        | "disabled"
        | "subscription_available"
        | "subscription_evidence_unknown"
        | "scope_unauthorized"
        | "unsafe_checkpoint"
        | "context_unqualified"
        | "key_limit_unverified"
        | "routing_policy_unverified";
    };

/** A positive decision permits a gateway reservation attempt only, not any billable request. */
export function decideOpenRouterFallback(input: OpenRouterFallbackInput): OpenRouterFallbackDecision {
  if (input.enabled !== true) return { ok: false, reason: "disabled" };
  if (input.source === "healthy" || input.alternatives.some((a) => a.state === "available"))
    return { ok: false, reason: "subscription_available" };
  if (
    input.subscriptionsConsidered !== true ||
    (input.source !== "exhausted" && input.source !== "unavailable") ||
    new Set(input.alternatives.map((a) => a.id)).size !== input.alternatives.length ||
    input.alternatives.some((a) => !a.id || (a.state !== "exhausted" && a.state !== "unavailable"))
  )
    return { ok: false, reason: "subscription_evidence_unknown" };
  if (input.scopeAuthorized !== true) return { ok: false, reason: "scope_unauthorized" };
  if (input.safeTurnBoundary !== true) return { ok: false, reason: "unsafe_checkpoint" };
  if (input.portableContextQualified !== true) return { ok: false, reason: "context_unqualified" };
  if (input.keyLimitVerified !== true) return { ok: false, reason: "key_limit_unverified" };
  try {
    autoRouterParameters(input.policy);
  } catch {
    return { ok: false, reason: "routing_policy_unverified" };
  }
  if (input.task !== "engineering" && input.task !== "general")
    return { ok: false, reason: "routing_policy_unverified" };
  return { ok: true, model: input.task === "engineering" ? OPENROUTER_AUTO_CODE : OPENROUTER_AUTO };
}
