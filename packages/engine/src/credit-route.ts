import { ProviderError, providerCause } from "@agenteschat/providers";

/**
 * Credit routes (ADR 0200): what a refusal is called, and what a provider's failure means for the money. Pure: the
 * ledger that holds the hold is `credit-ledger.ts`.
 */

/** The only billing authority a credit route may run on. Another endpoint's eligibility is never borrowed. */
export const CREDIT_NAMESPACE = "anthropic";
export const CREDIT_PROVIDER = "anthropic";

/** How long one qualification stays valid at most; the gateway admits again at the last moment. */
export const CREDIT_PROOF_MAX_MS = 300_000;

export const CREDIT_REFUSALS = [
  /** No route is registered or enabled: the feature is off here. */
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
] as const;
export type CreditRefusalReason = (typeof CREDIT_REFUSALS)[number];

/** The call was not made. Nothing was charged and nothing was sent. */
export class CreditRouteRefusal extends Error {
  readonly retryable = false;
  constructor(readonly reason: CreditRefusalReason) {
    super(`credit route: ${reason}`);
    this.name = "CreditRouteRefusal";
  }
}

/** What qualification hands the run: an exact route, never a key and never a promise of a balance. */
export interface CreditProof {
  routeId: string;
  poolId: string;
  credentialId: string;
  credentialVersion: string;
  model: string;
  /** `namespace:account`, the one upstream pool every credential and agent shares. */
  pool: string;
  evidenceRef: string;
  observedAt: number;
  validUntil: number;
}

export type CreditQualification = { ok: true; proof: CreditProof } | { ok: false; reason: CreditRefusalReason };

/** The money a failed call leaves behind: nothing, or something nobody can tell yet. */
export type CreditFailureClass =
  /** The provider says the grant or balance is empty. Known refusal, nothing charged. */
  | "exhausted"
  /** 402: a billing problem that needs a person at the provider. Known refusal. */
  | "billing_blocked"
  /** 401/403: the credential or its access is wrong. Known refusal. */
  | "credential"
  /** 429: throughput, not money. Known refusal; the same call may be made again later. */
  | "rate_limit"
  /** Any other refusal the provider answered before generating anything. */
  | "rejected"
  /** A timeout, a 5xx, a dropped connection or a stream that began: it may have run and charged. */
  | "unknown";

export interface CreditFailure {
  class: CreditFailureClass;
  /** `no`: the provider answered a refusal before generating. `unknown`: it may have charged. */
  charged: "no" | "unknown";
}

/**
 * What a call's failure means for the money. Only an HTTP answer in the 4xx range before any output counts as a
 * refusal that charged nothing: every 429 is a throughput answer, never "out of credit", and a timeout, a 5xx or
 * anything that arrived mid-stream is unknown. An error that is not the provider's is unknown too.
 */
export function classifyCreditFailure(error: unknown): CreditFailure {
  if (!(error instanceof ProviderError)) return { class: "unknown", charged: "unknown" };
  if (error.partial) return { class: "unknown", charged: "unknown" };
  const status = error.status ?? 0;
  if (status < 400 || status >= 500) return { class: "unknown", charged: "unknown" };
  if (status === 402) return { class: "billing_blocked", charged: "no" };
  const cause = providerCause(error);
  if (cause === "no_credit") return { class: "exhausted", charged: "no" };
  if (status === 429 || cause === "rate_limit") return { class: "rate_limit", charged: "no" };
  if (status === 401 || status === 403 || cause === "invalid_key" || cause === "no_access")
    return { class: "credential", charged: "no" };
  return { class: "rejected", charged: "no" };
}

/** Whether a failure ends the route for good: the money or the credential is the problem, not the moment. */
export const endsCreditRoute = (c: CreditFailureClass): boolean =>
  c === "exhausted" || c === "billing_blocked" || c === "credential";

/** What the gateway made of a call it admitted, kept beside the error it threw so the engine can act on it. */
export interface CreditOutcome {
  attemptId: string;
  class: CreditFailureClass;
  /** `released`: the hold was returned. `unknown`: it stays held until someone reconciles it. */
  hold: "released" | "unknown";
}
const outcomes = new WeakMap<object, CreditOutcome>();
export function noteCreditOutcome(error: unknown, outcome: CreditOutcome): void {
  if (error !== null && typeof error === "object") outcomes.set(error, outcome);
}
export function creditOutcomeOf(error: unknown): CreditOutcome | null {
  return error !== null && typeof error === "object" ? (outcomes.get(error) ?? null) : null;
}

/** One line for the people in the task. It names no balance: nobody here can read one. */
export function creditRouteNotice(model: string): string {
  return `The Claude subscription reached its usage limit, so this task continues on the workspace's Claude API credits (${model}). No action needed.`;
}

export function creditRouteEndedNotice(): string {
  return "The Claude API credits can't be used for this task right now, so it is looking for another way to continue. Nothing already done will be repeated.";
}

export function creditRouteUnknownNotice(): string {
  return "A Claude API call was interrupted and I couldn't confirm whether it was charged, so I stopped instead of sending it again. Send the message again once someone has checked the API usage.";
}
