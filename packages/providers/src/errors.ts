import type { ProviderError } from "./types";

/** Safe machine-readable facts, never a retained SDK request, body, key, or headers. */
export interface ProviderFailureFacts {
  code?: string;
  billing?: "exhausted" | "billing_blocked";
  /** A real HTTP refusal before a stream, never an inferred status from an SSE error. */
  httpRefusal: boolean;
  retryAfterMs?: number;
}
const facts = new WeakMap<object, Readonly<ProviderFailureFacts>>();
const CODES = new Set([
  "insufficient_quota",
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
  "enforced_spend_limit_reached",
  "rate_limit_exceeded",
  "rate_limit_error",
  "slow_down",
  "server_is_overloaded",
  "overloaded_error",
  "invalid_api_key",
  "authentication_error",
  "permission_error",
]);
const row = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};

/** Read only known billing codes/phrases. Unknown codes and provider prose never enter metadata. */
export function providerBillingFailure(source: unknown): "exhausted" | "billing_blocked" | undefined {
  const top = row(source),
    body = row(top.error),
    inner = row(body.error);
  const details = [row(top.details), row(body.details), row(inner.details)];
  const codes = [top.code, body.code, inner.code, ...details.map((d) => d.error_code)];
  if (
    codes.some(
      (c) =>
        c === "organization_spend_limit_exceeded" ||
        c === "project_spend_limit_exceeded" ||
        c === "organization_usage_limit_exceeded" ||
        c === "enforced_spend_limit_reached",
    )
  )
    return "billing_blocked";
  if (codes.some((c) => c === "credit_balance_exhausted" || c === "insufficient_quota")) return "exhausted";
  // A broad quota type without a specific code is still billing, never throughput.
  if ([top.type, body.type, inner.type].includes("insufficient_quota")) return "billing_blocked";
  const words = [top.message, top.said, body.message, inner.message]
    .filter((v): v is string => typeof v === "string")
    .join(" ");
  if (
    /reached your (?:specified (?:workspace )?)?api usage limits|monthly api usage threshold|(?:organization|project|workspace) spend limit|billing (?:hard )?limit/i.test(
      words,
    )
  )
    return "billing_blocked";
  if (
    /no prepaid credit|insufficient[ _](?:credits?|quota|balance|funds)|credit balance (?:is )?(?:too low|exhausted|depleted)|exceeded your current quota/i.test(
      words,
    )
  )
    return "exhausted";
  return undefined;
}

/** Retry-After may be seconds or HTTP-date. A long wait must not become an early retry. */
export function providerRetryAfterMs(headers: unknown, now = Date.now()): number | undefined {
  if (!(headers instanceof Headers)) return undefined;
  const millis = headers.get("retry-after-ms");
  if (millis !== null && /^\d+(?:\.\d+)?$/.test(millis)) {
    const value = Number(millis);
    if (Number.isSafeInteger(Math.ceil(value))) return Math.ceil(value);
  }
  const value = headers.get("retry-after");
  if (value === null) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const ms = Math.ceil(Number(value) * 1000);
    return Number.isSafeInteger(ms) ? ms : undefined;
  }
  if (!/^[A-Za-z]{3},\s\d{2}\s[A-Za-z]{3}\s\d{4}\s\d{2}:\d{2}:\d{2}\sGMT$/.test(value)) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? Math.max(0, time - now) : undefined;
}

export function annotateProviderFailure(mapped: ProviderError, source: unknown): ProviderError {
  if (source !== null && typeof source === "object") {
    const known = facts.get(source);
    if (known) {
      facts.set(mapped, known);
      return mapped;
    }
  }
  const top = row(source),
    body = row(top.error),
    inner = row(body.error);
  const candidates = [
    row(inner.details).error_code,
    row(body.details).error_code,
    row(top.details).error_code,
    top.code,
    body.code,
    inner.code,
    top.type,
    body.type,
    inner.type,
  ];
  const code = candidates.find((c): c is string => typeof c === "string" && CODES.has(c));
  const status = typeof top.status === "number" ? top.status : 0;
  facts.set(
    mapped,
    Object.freeze({
      ...(code ? { code } : {}),
      ...(providerBillingFailure(source) ? { billing: providerBillingFailure(source) } : {}),
      httpRefusal: status >= 400 && status < 500 && status !== 408 && status !== 409,
      ...(providerRetryAfterMs(top.headers) === undefined ? {} : { retryAfterMs: providerRetryAfterMs(top.headers) }),
    }),
  );
  return mapped;
}

export const providerFailureFacts = (error: unknown): Readonly<ProviderFailureFacts> | null =>
  error !== null && typeof error === "object" ? (facts.get(error) ?? null) : null;

/**
 * SDKs otherwise retry 429s before adapters identify billing refusals. Preserve ordinary transient retries,
 * but mark explicit billing responses non-retryable. Per-request noTransportRetries disables every SDK retry.
 * Reads at most 64 KiB of the cloned error response; nothing read is persisted.
 */
export function withoutBillingRetries(fetcher: typeof fetch): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const response = await fetcher(input, init);
    if (![400, 402, 403, 429].includes(response.status)) return response;
    const reader = response.clone().body?.getReader();
    if (!reader) return response;
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 65_536) {
          void reader.cancel();
          return response;
        }
        chunks.push(next.value);
      }
      const all = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) {
        all.set(chunk, offset);
        offset += chunk.byteLength;
      }
      if (!providerBillingFailure(JSON.parse(new TextDecoder().decode(all)))) return response;
      const headers = new Headers(response.headers);
      headers.set("x-should-retry", "false");
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    } catch {
      return response;
    }
  }) as typeof fetch;
}

/** Upstream receipt identifiers only; exclude arbitrary response headers and token-shaped strings. */
export const safeProviderRequestId = (value: unknown): string | undefined =>
  typeof value === "string" && /^(?:req_[A-Za-z0-9_-]{1,160}|[a-f0-9-]{16,64})$/.test(value) ? value : undefined;
export const safeProviderResponseId = (value: unknown): string | undefined =>
  typeof value === "string" && /^(?:resp_|msg_)[A-Za-z0-9_-]{1,160}$/.test(value) ? value : undefined;
