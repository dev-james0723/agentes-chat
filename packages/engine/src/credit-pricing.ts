import { createHash } from "node:crypto";
import type { schema } from "@agenteschat/db";
import { MODEL_CATALOG, type ModelUsage, type TokenPrices } from "@agenteschat/providers";
import { CreditRouteRefusal } from "./credit-route";

/** A reproducible tariff description. This helper never supplies owner approval or proves account eligibility. */
export type CreditPricingProfile = typeof schema.creditAttempts.$inferSelect.pricingSnapshot;
export type CreditCacheTtl = "default" | "1h";
export interface CreditPricingEvidence {
  evidenceRef: string;
  verifiedAt: Date;
  validUntil: Date;
  profileHash: string;
}
const SAFE_NAME = /^[A-Za-z0-9._:-]{1,200}$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
const integer = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const positive = (n: unknown): n is number => integer(n) && n > 0;
const date = (d: unknown): d is Date => d instanceof Date && Number.isFinite(d.getTime());
function unverified(): never {
  throw new CreditRouteRefusal("pricing_unverified");
}
function rates(value: TokenPrices): TokenPrices {
  // Both supported providers bill every cache category. A missing/zero catalog price is not a free grant call.
  if (!value || ![value.input, value.output, value.cacheRead, value.cacheWrite].every(positive)) unverified();
  return Object.freeze({
    input: value.input,
    output: value.output,
    cacheRead: value.cacheRead,
    cacheWrite: value.cacheWrite,
  });
}
type Core = Omit<CreditPricingProfile, "profileHash">;
function normalized(value: Core): Core {
  if (
    value?.version !== 1 ||
    !SAFE_NAME.test(value.model) ||
    !["openai", "anthropic"].includes(value.provider) ||
    value.serviceTier !== "standard" ||
    value.endpoint !== (value.provider === "openai" ? "https://api.openai.com/v1" : "https://api.anthropic.com") ||
    !positive(value.contextWindow) ||
    (value.maxOutputTokens !== null &&
      (!positive(value.maxOutputTokens) || value.maxOutputTokens > value.contextWindow)) ||
    value.longCacheWriteMultiplier !== 2
  )
    unverified();
  if (
    value.longContext &&
    (!positive(value.longContext.aboveInputTokens) || value.longContext.aboveInputTokens >= value.contextWindow)
  )
    unverified();
  return {
    version: 1,
    provider: value.provider,
    model: value.model,
    endpoint: value.endpoint,
    serviceTier: "standard",
    contextWindow: value.contextWindow,
    maxOutputTokens: value.maxOutputTokens,
    prices: rates(value.prices),
    longContext: value.longContext
      ? Object.freeze({ aboveInputTokens: value.longContext.aboveInputTokens, prices: rates(value.longContext.prices) })
      : null,
    longCacheWriteMultiplier: 2,
  };
}
const hashOf = (value: Core) => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;

/** Exact catalog model only. Introductory schedules require a separately implemented pinned effective-time policy. */
export function creditPricingProfile(model: string): CreditPricingProfile {
  if (!Object.hasOwn(MODEL_CATALOG, model)) unverified();
  const info = MODEL_CATALOG[model];
  if (
    !info ||
    (info.provider !== "openai" && info.provider !== "anthropic") ||
    info.unpriced ||
    info.endpoint ||
    info.intro ||
    !positive(info.contextWindow)
  )
    unverified();
  const core = normalized({
    version: 1,
    provider: info.provider,
    model,
    serviceTier: "standard",
    endpoint: info.provider === "openai" ? "https://api.openai.com/v1" : "https://api.anthropic.com",
    contextWindow: info.contextWindow,
    maxOutputTokens: info.maxOutputTokens ?? null,
    prices: info.prices,
    longContext: info.longContext ?? null,
    longCacheWriteMultiplier: 2,
  });
  return Object.freeze({ ...core, profileHash: hashOf(core) });
}

/** Checks the shape, currency and exact tariff of owner-supplied evidence; it does not fetch or invent evidence. */
export function assertCreditPricingEvidence(
  model: string,
  evidence: CreditPricingEvidence,
  at: Date,
  requestDeadlineMs = 120_000,
): CreditPricingProfile {
  if (
    !evidence ||
    !SAFE_NAME.test(evidence.evidenceRef) ||
    !HASH.test(evidence.profileHash) ||
    !date(evidence.verifiedAt) ||
    !date(evidence.validUntil) ||
    !date(at) ||
    !integer(requestDeadlineMs) ||
    evidence.verifiedAt > at ||
    evidence.validUntil <= evidence.verifiedAt ||
    evidence.validUntil.getTime() - evidence.verifiedAt.getTime() > 86_400_000
  )
    unverified();
  if (evidence.validUntil.getTime() < at.getTime() + requestDeadlineMs) throw new CreditRouteRefusal("pricing_expired");
  const profile = creditPricingProfile(model);
  if (profile.profileHash !== evidence.profileHash) throw new CreditRouteRefusal("pricing_changed");
  return profile;
}

export function assertCreditCachePolicy(profile: CreditPricingProfile, cacheTtl: CreditCacheTtl): void {
  if (cacheTtl !== "default" && (cacheTtl !== "1h" || profile.provider !== "anthropic"))
    throw new CreditRouteRefusal("unsupported_capability");
}

/**
 * Price actual final token categories against the tariff captured at admission. No current-catalog lookup occurs.
 * An oversized but valid receipt is returned in full so the ledger can record debt and trip its circuit breaker.
 */
export function creditReceiptCost(
  snapshot: CreditPricingProfile,
  usage: ModelUsage,
  cacheTtl: CreditCacheTtl = "default",
): number {
  const core = normalized(snapshot);
  if (!HASH.test(snapshot.profileHash) || snapshot.profileHash !== hashOf(core))
    throw new CreditRouteRefusal("pricing_changed");
  assertCreditCachePolicy(snapshot, cacheTtl);
  const long = usage.cacheWriteLongTokens ?? 0;
  if (
    ![usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, long].every(integer) ||
    long > usage.cacheWriteTokens ||
    (long > 0 && (snapshot.provider !== "anthropic" || cacheTtl !== "1h"))
  )
    throw new CreditRouteRefusal("reconciliation_required");
  const prompt = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  if (!integer(prompt)) throw new CreditRouteRefusal("reconciliation_required");
  const p = core.longContext && prompt > core.longContext.aboveInputTokens ? core.longContext.prices : core.prices;
  const amount =
    usage.inputTokens * p.input +
    usage.outputTokens * p.output +
    usage.cacheReadTokens * p.cacheRead +
    usage.cacheWriteTokens * p.cacheWrite +
    long * (core.longCacheWriteMultiplier * p.input - p.cacheWrite);
  if (!integer(amount)) throw new CreditRouteRefusal("reconciliation_required");
  return amount;
}
