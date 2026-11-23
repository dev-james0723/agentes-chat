/**
 * Explicit policy for OpenRouter's dynamic model routers. This is not a spending
 * authorization: the gateway must reserve the full call and enforce the org cap
 * before supplying it. The ordinary model catalog must not price these aliases at zero.
 */
export const OPENROUTER_AUTO = "openrouter/auto";
export const OPENROUTER_AUTO_CODE = "openrouter/auto-code";
export type OpenRouterAutoModel = typeof OPENROUTER_AUTO | typeof OPENROUTER_AUTO_CODE;
export type OpenRouterCostTier = "low" | "medium" | "high" | "xhigh" | "max";

export interface OpenRouterAutoPolicy {
  /** Exact, reviewed concrete model IDs, not wildcards, aliases or other routers. */
  allowedModels: readonly string[];
  costTier: OpenRouterCostTier;
  /** Independently approved monthly USD cap for a dedicated OpenRouter fallback key. */
  monthlyCapUsd: number;
  /** Provider price ceilings, USD per million tokens, not monthly spend caps. */
  maxPromptUsdPerMillion: number;
  maxCompletionUsdPerMillion: number;
}

export function isOpenRouterAutoModel(model: string): model is OpenRouterAutoModel {
  return model === OPENROUTER_AUTO || model === OPENROUTER_AUTO_CODE;
}

const concreteId = /^[a-z0-9][a-z0-9.-]*\/[a-z0-9][a-z0-9._-]*$/i;
const denied = /qwen|ollama|^openrouter\//i;
const tiers = new Set(["low", "medium", "high", "xhigh", "max"]);
const price = (n: number) => typeof n === "number" && Number.isFinite(n) && n > 0 && n <= 10_000;

/** Fail closed on missing, malformed or unbounded policy before any network call. */
export function autoRouterParameters(policy: OpenRouterAutoPolicy | undefined) {
  if (
    !policy ||
    !Array.isArray(policy.allowedModels) ||
    policy.allowedModels.length < 1 ||
    policy.allowedModels.length > 64 ||
    new Set(policy.allowedModels).size !== policy.allowedModels.length ||
    !policy.allowedModels.every(
      (id) => typeof id === "string" && id.length <= 100 && concreteId.test(id) && !denied.test(id),
    ) ||
    !tiers.has(policy.costTier) ||
    !Number.isFinite(policy.monthlyCapUsd) ||
    policy.monthlyCapUsd <= 0 ||
    !Number.isSafeInteger(Math.round(policy.monthlyCapUsd * 1e9)) ||
    !price(policy.maxPromptUsdPerMillion) ||
    !price(policy.maxCompletionUsdPerMillion)
  ) {
    throw new Error("OpenRouter Auto requires an explicit bounded routing policy");
  }

  return {
    plugins: [{ id: "auto-router", cost_tier: policy.costTier, allowed_models: [...policy.allowedModels] }],
    provider: {
      require_parameters: true,
      data_collection: "deny" as const,
      zdr: true,
      max_price: { prompt: policy.maxPromptUsdPerMillion, completion: policy.maxCompletionUsdPerMillion },
    },
  };
}

/** Validate GET /api/v1/key without retaining or exposing key labels or other account metadata. */
export function autoRouterKeyWithinCap(body: unknown, capUsd: number, now = Date.now(), reservedNanoUsd = 0): boolean {
  if (!body || typeof body !== "object" || !("data" in body)) return false;
  const data = body.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const k = data as Record<string, unknown>;
  const limit = k.limit;
  const remaining = k.limit_remaining;
  return (
    Number.isFinite(capUsd) &&
    capUsd > 0 &&
    k.is_management_key === false &&
    k.disabled !== true &&
    k.is_provisioning_key !== true &&
    k.include_byok_in_limit === true &&
    k.limit_reset === "monthly" &&
    typeof limit === "number" &&
    Number.isFinite(limit) &&
    limit > 0 &&
    limit <= capUsd &&
    typeof remaining === "number" &&
    Number.isFinite(remaining) &&
    remaining > 0 &&
    Number.isSafeInteger(reservedNanoUsd) &&
    reservedNanoUsd >= 0 &&
    remaining >= reservedNanoUsd / 1e9 &&
    remaining <= limit &&
    (k.expires_at === null || (typeof k.expires_at === "string" && Date.parse(k.expires_at) > now))
  );
}
