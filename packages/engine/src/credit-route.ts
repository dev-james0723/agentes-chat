import { ProviderError, providerBillingFailure, providerCause, providerFailureFacts } from "@agenteschat/providers";

/** Legacy aliases; every new proof has an explicit provider and product. */
export const CREDIT_NAMESPACE = "anthropic";
export const CREDIT_PROVIDER = "anthropic";
export type CreditProvider = "openai" | "anthropic";
export type CreditProduct = "openai_pro_api" | "claude_ultra_api";
export type CreditRouteKind = "openai_responses" | "anthropic_messages" | "claude_agent_sdk";
export const CREDIT_PROOF_MAX_MS = 300_000;

export const CREDIT_REFUSALS = [
  "disabled",
  "unverified",
  "stale_evidence",
  "account_mismatch",
  "credential_changed",
  "endpoint_mismatch",
  "grant_expired",
  "exhausted",
  "billing_blocked",
  "unsupported_capability",
  "no_allocation",
  "paused",
  "reserved_credential",
  "reconciliation_required",
  "grant_unverified",
  "budget_exhausted",
  "spend_approval_required",
  "safety_buffer",
  "stale_owner",
  "duplicate_attempt",
  "invalid_reservation",
  "cycle_mismatch",
  "pricing_unverified",
  "pricing_expired",
  "pricing_changed",
] as const;
export type CreditRefusalReason = (typeof CREDIT_REFUSALS)[number];

/** Admission refused before dispatch. Does not assert the outcome of an older attempt. */
export class CreditRouteRefusal extends Error {
  readonly retryable = false;
  constructor(readonly reason: CreditRefusalReason) {
    super(`credit route: ${reason}`);
    this.name = "CreditRouteRefusal";
  }
}

/** Exact route references, never credentials, prompts, native sessions, or transfer authority. */
export interface CreditProof {
  routeId: string;
  poolId: string;
  credentialId: string;
  credentialVersion: string;
  model: string;
  pool: string;
  evidenceRef: string;
  observedAt: number;
  validUntil: number;
  provider: CreditProvider;
  product: CreditProduct;
  cycleId: string;
  routeKind: CreditRouteKind;
  bucket?: "automatic" | "emergency";
  approvalId?: string;
}
export type CreditQualification = { ok: true; proof: CreditProof } | { ok: false; reason: CreditRefusalReason };
export type CreditFailureClass = "exhausted" | "billing_blocked" | "credential" | "rate_limit" | "rejected" | "unknown";
export interface CreditFailure {
  class: CreditFailureClass;
  charged: "no" | "unknown";
  retryAfterMs?: number;
}

/** Real HTTP refusals can release this attempt. Accepted/partial/timeout/5xx errors remain unknown. */
export function classifyCreditFailure(error: unknown): CreditFailure {
  const unknown: CreditFailure = { class: "unknown", charged: "unknown" };
  if (!(error instanceof ProviderError) || error.partial) return unknown;
  const status = error.status ?? 0;
  const facts = providerFailureFacts(error);
  if (status < 400 || status >= 500 || status === 408 || status === 409 || (facts && !facts.httpRefusal))
    return unknown;
  const billing = facts?.billing ?? providerBillingFailure(error);
  if (billing) return { class: billing, charged: "no" };
  if (status === 402) return { class: "billing_blocked", charged: "no" };
  const cause = providerCause(error);
  if (cause === "no_credit") return { class: "exhausted", charged: "no" };
  if (status === 401 || status === 403 || cause === "invalid_key" || cause === "no_access")
    return { class: "credential", charged: "no" };
  if (cause === "rate_limit")
    return {
      class: "rate_limit",
      charged: "no",
      ...(facts?.retryAfterMs === undefined ? {} : { retryAfterMs: facts.retryAfterMs }),
    };
  return { class: "rejected", charged: "no" };
}

export const endsCreditRoute = (c: CreditFailureClass): boolean =>
  c === "exhausted" || c === "billing_blocked" || c === "credential";
export interface CreditOutcome {
  attemptId: string;
  class: CreditFailureClass;
  hold: "released" | "unknown";
}
const outcomes = new WeakMap<object, CreditOutcome>();
export function noteCreditOutcome(error: unknown, outcome: CreditOutcome): void {
  if (error !== null && typeof error === "object") outcomes.set(error, outcome);
}
export function creditOutcomeOf(error: unknown): CreditOutcome | null {
  return error !== null && typeof error === "object" ? (outcomes.get(error) ?? null) : null;
}
const providerLabel = (provider: CreditProvider) => (provider === "openai" ? "OpenAI" : "Claude");
/** Qualified model names only. Arbitrary strings are omitted from notices. */
const displayModel = (model: string) =>
  /^(?:gpt-|o[1-9](?:-|$)|claude-)[A-Za-z0-9._:-]{0,90}$/.test(model) ? ` (${model})` : "";

export function creditRouteNotice(model: string, provider: CreditProvider = "anthropic"): string {
  return (
    "This task reached a subscription limit and continues through its verified " +
    providerLabel(provider) +
    " API grant" +
    displayModel(model) +
    ". Its usage counts against the shared automatic budget."
  );
}
export function creditRouteEndedNotice(provider: CreditProvider = "anthropic"): string {
  return (
    providerLabel(provider) +
    " API fallback is paused. The existing task checkpoint is retained while another eligible route is evaluated."
  );
}
export function creditRouteUnknownNotice(provider: CreditProvider = "anthropic"): string {
  return (
    "A " +
    providerLabel(provider) +
    " API request ended without confirmed usage. Its budget remains reserved while the existing run reconciles usage and action receipts."
  );
}
