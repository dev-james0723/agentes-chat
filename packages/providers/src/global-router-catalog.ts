import { isCustomModel, MODEL_CATALOG, type ProviderId, type TokenPrices } from "./catalog";

/**
 * Dynamic catalog and qualification primitives for the Global Model Router.
 * Discovery of a model never authorizes dispatch on its own: every offer must
 * carry live pricing/capability/privacy evidence, pass the Qwen/Ollama/Gemini-API
 * denylist, and remain within its freshness window.
 */

export type GlobalRouterLane =
  | "subscription"
  | "opencode_go"
  | "free_api"
  | "paid_low_cost"
  | "paid_dynamic"
  | "direct_api";

export type ProviderEntitlementKind = "subscription_go" | "free_only" | "paid_capped";

export type OfferQualificationStatus = "eligible" | "quarantined" | "stale" | "denied" | "requires_owner_approval";

export type BillingPrerequisite =
  | "paid_method_required"
  | "funded_account_required"
  | "go_subscription_required"
  | "dedicated_monthly_cap"
  | "native_opencode_cli_only"
  | "separate_provider_approval";

export type OfferApiStyle =
  | "openai_chat"
  | "openai_responses_nonstream"
  | "anthropic_messages"
  | "openrouter_auto"
  | "native_opencode";

export interface RateLimitTelemetry {
  rpmLimit?: number | null;
  rpmRemaining?: number | null;
  rpdLimit?: number | null;
  rpdRemaining?: number | null;
  tpmLimit?: number | null;
  tpmRemaining?: number | null;
  tpdLimit?: number | null;
  tpdRemaining?: number | null;
  dailyNeuronsLimit?: number | null;
  dailyNeuronsUsed?: number | null;
  fiveHourUsedPercent?: number | null;
  weeklyUsedPercent?: number | null;
  monthlyUsedPercent?: number | null;
  resetsAt?: string | null;
  observedAt: string;
}

export interface ModelOfferPrivacy {
  zdr: boolean;
  training: boolean | "unknown";
  dataCollection: "deny" | "allow" | "unknown";
  region: "global" | "us_eu" | "cn" | "unknown";
}

export interface ModelOffer {
  offerId: string;
  provider: ProviderId;
  lane: GlobalRouterLane;
  modelId: string;
  canonicalId: string | null;
  label: string;
  endpointUrl: string;
  apiStyle: OfferApiStyle;
  contextWindow: number;
  maxOutputTokens: number;
  inputModalities: readonly ("text" | "image" | "pdf")[];
  capabilities: {
    tools: boolean;
    structuredOutput: boolean;
    streaming: boolean;
    reasoning: boolean;
    cache: boolean;
  };
  /** Integer nano-USD per token. Null means unknown price (never treated as zero). */
  prices: TokenPrices | null;
  /** Per-request fixed fee in nano-USD when applicable. */
  requestFeeNanoUsd: number;
  /** Estimated Cloudflare Workers AI neurons per 1K input/output tokens when quotaUnits === "neurons". */
  neuronsPer1kTokens?: { input: number; output: number };
  freeEligible: boolean;
  billingPrerequisites: readonly BillingPrerequisite[];
  quotaUnits: "requests_tokens" | "neurons" | "go_shared_windows" | "nano_usd";
  privacy: ModelOfferPrivacy;
  observedAt: string;
  expiresAt: string;
  qualificationStatus: OfferQualificationStatus;
  quarantineReason: string | null;
}

export const DEFAULT_CATALOG_TTL_MS = 60 * 60_000;
export const CLOUDFLARE_FREE_DAILY_NEURONS = 10_000;
export const OPENROUTER_FREE_RPM = 20;
export const OPENROUTER_FREE_RPD = 50;

const DENIED_MODEL_PATTERN = /(?:^|[/:._-])(?:qwen[\w.-]*|ollama[\w.-]*)(?:$|[/:._-])/i;

/** Allowed official cloud inference hosts for Global Model Router adapters. */
const ALLOWED_ROUTER_HOSTS = new Set([
  "openrouter.ai",
  "api.groq.com",
  "api.cloudflare.com",
  "opencode.ai",
  "api.deepseek.com",
  "api.hunyuan.cloud.tencent.com",
  "api.minimax.io",
  "api.z.ai",
  "api.moonshot.ai",
  "api.xiaomimimo.com",
  "integrate.api.nvidia.com",
]);

function isPrivateOrLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    h === "::1" ||
    h === "0:0:0:0:0:0:0:1" ||
    h === "::" ||
    h.startsWith("fc") ||
    h.startsWith("fd") ||
    h.startsWith("fe80:")
  ) {
    return true;
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (ipv4) {
    const parts = ipv4.slice(1, 5).map(Number);
    if (parts.some((n) => n < 0 || n > 255)) return true;
    const [a = 0, b = 0] = parts;
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    ) {
      return true;
    }
    // Raw IP literals are never valid public cloud LLM API hosts.
    return true;
  }
  if (h.includes(":")) return true;
  return false;
}

/**
 * Validates that an upstream endpoint uses HTTPS, has no embedded credentials or query secrets,
 * cannot target loopback/RFC1918/link-local addresses (SSRF defense), and belongs to an approved host.
 */
export function assertSafeRouterEndpoint(rawUrl: string, allowCustomApprovedHost = false): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Invalid provider endpoint URL");
  }
  if (parsed.protocol !== "https:") throw new Error("Provider endpoint must use HTTPS");
  if (parsed.username || parsed.password) throw new Error("Provider endpoint must not contain credentials");
  if (parsed.search || parsed.hash) throw new Error("Provider endpoint must not contain query or fragment parameters");
  if (parsed.port && parsed.port !== "443") throw new Error("Provider endpoint must use standard HTTPS port 443");
  const host = parsed.hostname.toLowerCase();
  if (isPrivateOrLoopbackHost(host)) throw new Error("Provider endpoint host is restricted");
  if (!allowCustomApprovedHost && !ALLOWED_ROUTER_HOSTS.has(host)) {
    throw new Error(`Provider endpoint host ${host} is not in the Global Router allowlist`);
  }
  return parsed;
}

/** Enforces owner policy: no Qwen, no Ollama, and no metered Gemini API fallback in Global Router. */
export function routerDenylistReason(
  provider: string,
  modelId: string,
  canonicalId?: string | null,
): "denied_qwen_ollama" | "denied_gemini_metered_api" | "unconstrained_free_router_disabled" | null {
  if (provider === "gemini") return "denied_gemini_metered_api";
  if (modelId === "openrouter/free") return "unconstrained_free_router_disabled";
  if (
    DENIED_MODEL_PATTERN.test(modelId) ||
    (canonicalId ? DENIED_MODEL_PATTERN.test(canonicalId) : false) ||
    /qwen|ollama/i.test(modelId) ||
    (canonicalId ? /qwen|ollama/i.test(canonicalId) : false)
  ) {
    return "denied_qwen_ollama";
  }
  return null;
}

/** Checks whether an offer is currently eligible and within its freshness window. */
export function evaluateOfferEligibility(
  offer: ModelOffer,
  nowMs = Date.now(),
): { eligible: true } | { eligible: false; reason: string } {
  const deny = routerDenylistReason(offer.provider, offer.modelId, offer.canonicalId);
  if (deny) return { eligible: false, reason: deny };
  if (offer.qualificationStatus !== "eligible") {
    return { eligible: false, reason: offer.quarantineReason ?? offer.qualificationStatus };
  }
  const observed = Date.parse(offer.observedAt);
  const expires = Date.parse(offer.expiresAt);
  if (!Number.isFinite(observed) || !Number.isFinite(expires) || observed > nowMs || nowMs >= expires) {
    return { eligible: false, reason: "stale_catalog" };
  }
  if (offer.lane !== "paid_dynamic" && offer.prices === null) {
    return { eligible: false, reason: "unknown_price_quarantined" };
  }
  if (offer.freeEligible) {
    if (
      !offer.prices ||
      offer.prices.input !== 0 ||
      offer.prices.output !== 0 ||
      offer.prices.cacheRead !== 0 ||
      offer.prices.cacheWrite !== 0 ||
      offer.requestFeeNanoUsd !== 0
    ) {
      // Groq/Cloudflare free accounts have zero incremental spend enforced by account entitlement,
      // whereas catalog list price is 0 for free_only offers.
      return { eligible: false, reason: "free_offer_nonzero_price" };
    }
    if (
      offer.billingPrerequisites.includes("paid_method_required") ||
      offer.billingPrerequisites.includes("funded_account_required")
    ) {
      return { eligible: false, reason: "free_offer_requires_paid_billing" };
    }
  }
  return { eligible: true };
}

type Raw = Record<string, unknown>;
const asObj = (v: unknown): Raw | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : null);
const asStrings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

function parseNanoPerToken(v: unknown, maxUsdPerToken = 0.01): number | null {
  if (typeof v !== "number" && !(typeof v === "string" && v.trim() !== "")) return null;
  const usd = Number(v);
  if (!Number.isFinite(usd) || usd < 0 || usd > maxUsdPerToken) return null;
  return Math.ceil(Math.round(usd * 1e12) / 1000);
}

function parseNanoFixedFee(v: unknown): number | null {
  if (v === undefined || v === null || v === "0" || v === 0) return 0;
  if (typeof v !== "number" && !(typeof v === "string" && v.trim() !== "")) return null;
  const usd = Number(v);
  if (!Number.isFinite(usd) || usd < 0 || usd > 10) return null;
  return Math.ceil(Math.round(usd * 1e12) / 1000);
}

/**
 * Parses OpenRouter `GET /api/v1/models` into exact `ModelOffer` records across:
 * - `free_api`: verified `:free` concrete models with zero prompt/completion/request/image cost
 * - `paid_low_cost`: concrete priced models with tools and >=32K context
 * - `paid_dynamic`: `openrouter/auto` and `openrouter/auto-code`
 * Quarantines `openrouter/free`, Qwen/Ollama, and zero-priced non-`:free` offers that require funded accounts.
 */
export function parseOpenRouterCatalogOffers(
  body: unknown,
  observedAt = new Date().toISOString(),
  ttlMs = DEFAULT_CATALOG_TTL_MS,
): ModelOffer[] {
  const expiresAt = new Date(Date.parse(observedAt) + ttlMs).toISOString();
  const rawData = asObj(body)?.data;
  const rows = (Array.isArray(rawData) ? rawData : []).flatMap((item) => {
    const o = asObj(item);
    return o ? [o] : [];
  });
  const offers: ModelOffer[] = [];
  for (const m of rows) {
    const id = typeof m.id === "string" ? m.id.trim() : "";
    const name = typeof m.name === "string" && m.name.trim() ? m.name.trim().replace(/^Anthropic:\s*/i, "Claude ") : id;
    if (!id || id.length > 120) continue;

    if (id === "openrouter/auto" || id === "openrouter/auto-code") {
      offers.push({
        offerId: `openrouter:${id}`,
        provider: "openrouter",
        lane: "paid_dynamic",
        modelId: id,
        canonicalId: id,
        label: id === "openrouter/auto-code" ? "OpenRouter Auto Code" : "OpenRouter Auto",
        endpointUrl: "https://openrouter.ai/api/v1",
        apiStyle: "openrouter_auto",
        contextWindow: typeof m.context_length === "number" && m.context_length >= 32_000 ? m.context_length : 200_000,
        maxOutputTokens: 32_768,
        inputModalities: ["text"],
        capabilities: {
          tools: true,
          structuredOutput: true,
          streaming: true,
          reasoning: true,
          cache: true,
        },
        prices: null,
        requestFeeNanoUsd: 0,
        freeEligible: false,
        billingPrerequisites: ["dedicated_monthly_cap"],
        quotaUnits: "nano_usd",
        privacy: { zdr: true, training: false, dataCollection: "deny", region: "global" },
        observedAt,
        expiresAt,
        qualificationStatus: "eligible",
        quarantineReason: null,
      });
      continue;
    }

    const deny = routerDenylistReason("openrouter", id, typeof m.canonical_slug === "string" ? m.canonical_slug : null);
    if (deny) {
      offers.push({
        offerId: `openrouter:${id}`,
        provider: "openrouter",
        lane: id.endsWith(":free") || id === "openrouter/free" ? "free_api" : "paid_low_cost",
        modelId: id,
        canonicalId: typeof m.canonical_slug === "string" ? m.canonical_slug : null,
        label: name.slice(0, 120),
        endpointUrl: "https://openrouter.ai/api/v1",
        apiStyle: "openai_chat",
        contextWindow: typeof m.context_length === "number" ? m.context_length : 0,
        maxOutputTokens: 4096,
        inputModalities: ["text"],
        capabilities: { tools: false, structuredOutput: false, streaming: true, reasoning: false, cache: false },
        prices: null,
        requestFeeNanoUsd: 0,
        freeEligible: false,
        billingPrerequisites: [],
        quotaUnits: "nano_usd",
        privacy: { zdr: false, training: "unknown", dataCollection: "unknown", region: "unknown" },
        observedAt,
        expiresAt,
        qualificationStatus: "denied",
        quarantineReason: deny,
      });
      continue;
    }

    if (id.startsWith("openrouter/")) continue;

    const contextWindow =
      typeof m.context_length === "number" && Number.isInteger(m.context_length) ? m.context_length : 0;
    const params = asStrings(m.supported_parameters);
    const outMods = asStrings(asObj(m.architecture)?.output_modalities);
    const inModsRaw = asStrings(asObj(m.architecture)?.input_modalities);
    if (outMods.length > 0 && !outMods.includes("text")) continue;

    const pricing = asObj(m.pricing);
    const input = pricing ? parseNanoPerToken(pricing.prompt) : null;
    const completion = pricing ? parseNanoPerToken(pricing.completion) : null;
    const reasoningNano = pricing ? (parseNanoPerToken(pricing.internal_reasoning) ?? 0) : 0;
    const requestFee = pricing ? parseNanoFixedFee(pricing.request) : null;
    const imageFee = pricing ? parseNanoFixedFee(pricing.image) : 0;

    const prices: TokenPrices | null =
      input !== null && completion !== null
        ? {
            input,
            output: Math.max(completion, reasoningNano),
            cacheRead: (pricing && parseNanoPerToken(pricing.input_cache_read)) ?? input,
            cacheWrite: (pricing && parseNanoPerToken(pricing.input_cache_write)) ?? input,
          }
        : null;

    const isExplicitFreeVariant = id.endsWith(":free");
    const isZeroPriced =
      prices !== null &&
      prices.input === 0 &&
      prices.output === 0 &&
      prices.cacheRead === 0 &&
      prices.cacheWrite === 0 &&
      requestFee === 0 &&
      (imageFee ?? 0) === 0;

    const maxOutRaw = asObj(m.top_provider)?.max_completion_tokens;
    const maxOutputTokens =
      typeof maxOutRaw === "number" && Number.isInteger(maxOutRaw) && maxOutRaw > 0 ? maxOutRaw : 16_384;
    const tools = params.includes("tools");
    const structuredOutput = params.includes("structured_outputs") || params.includes("response_format");
    const reasoning = params.includes("reasoning") || Boolean(asObj(m.reasoning));
    const inputModalities: ("text" | "image" | "pdf")[] = [
      "text",
      ...(inModsRaw.includes("image") ? (["image"] as const) : []),
      ...(inModsRaw.includes("file") ? (["pdf"] as const) : []),
    ];

    let qualificationStatus: OfferQualificationStatus = "eligible";
    let quarantineReason: string | null = null;
    const billingPrerequisites: BillingPrerequisite[] = [];

    if (contextWindow < 32_000) {
      qualificationStatus = "quarantined";
      quarantineReason = "context_below_32k";
    } else if (prices === null || requestFee === null) {
      qualificationStatus = "quarantined";
      quarantineReason = "unknown_price_quarantined";
    } else if (isZeroPriced && !isExplicitFreeVariant) {
      // Zero-priced non-:free offers on OpenRouter can require a funded account; never admit to free_only pool.
      qualificationStatus = "quarantined";
      quarantineReason = "zero_price_without_free_contract";
      billingPrerequisites.push("funded_account_required");
    } else if (isExplicitFreeVariant && !isZeroPriced) {
      qualificationStatus = "quarantined";
      quarantineReason = "free_variant_nonzero_fee";
    } else if (!isExplicitFreeVariant) {
      billingPrerequisites.push("dedicated_monthly_cap");
    }

    offers.push({
      offerId: `openrouter:${id}`,
      provider: "openrouter",
      lane: isExplicitFreeVariant ? "free_api" : "paid_low_cost",
      modelId: id,
      canonicalId: typeof m.canonical_slug === "string" ? m.canonical_slug : id,
      label: name.slice(0, 120),
      endpointUrl: "https://openrouter.ai/api/v1",
      apiStyle: "openai_chat",
      contextWindow,
      maxOutputTokens,
      inputModalities,
      capabilities: {
        tools,
        structuredOutput,
        streaming: true,
        reasoning,
        cache: pricing?.input_cache_read !== undefined,
      },
      prices,
      requestFeeNanoUsd: requestFee ?? 0,
      freeEligible: isExplicitFreeVariant && isZeroPriced && qualificationStatus === "eligible",
      billingPrerequisites,
      quotaUnits: isExplicitFreeVariant ? "requests_tokens" : "nano_usd",
      privacy: {
        zdr: !isExplicitFreeVariant,
        training: isExplicitFreeVariant ? "unknown" : false,
        dataCollection: "deny",
        region: "global",
      },
      observedAt,
      expiresAt,
      qualificationStatus,
      quarantineReason,
    });
  }
  return offers;
}

/**
 * Parses OpenCode Go `GET https://opencode.ai/inference/go/v1/models` and Zen `GET https://opencode.ai/zen/v1/models`.
 * - Go models use included subscription allowance (`opencode_go` lane, Extra Usage OFF).
 * - Free-tier Zen models (`*-free` without Go entitlement) require native OpenCode CLI (`native_opencode_cli_only`)
 *   and return HTTP 403 on third-party harnesses; never spoofed.
 * - Qwen and metered Gemini offers are denied.
 */
export function parseOpenCodeCatalogOffers(
  body: unknown,
  surface: "go" | "zen",
  observedAt = new Date().toISOString(),
  ttlMs = DEFAULT_CATALOG_TTL_MS,
): ModelOffer[] {
  const expiresAt = new Date(Date.parse(observedAt) + ttlMs).toISOString();
  const rawData = asObj(body)?.data;
  const rows = (Array.isArray(rawData) ? rawData : []).flatMap((item) => {
    const o = asObj(item);
    return o ? [o] : [];
  });
  const offers: ModelOffer[] = [];
  for (const m of rows) {
    const id = typeof m.id === "string" ? m.id.trim() : "";
    if (!id || id.length > 100) continue;
    if (m.type !== "chat") continue;
    const canonicalId = typeof m.canonical_id === "string" ? m.canonical_id : null;
    const label = typeof m.name === "string" && m.name.trim() ? m.name.trim().replace(/^Anthropic\s+/i, "Claude ") : id;

    const deny =
      routerDenylistReason("opencode", id, canonicalId) ??
      (canonicalId?.startsWith("google/gemini") ? ("denied_gemini_metered_api" as const) : null);
    if (deny) {
      offers.push({
        offerId: `opencode:${surface}:${id}`,
        provider: "opencode",
        lane: surface === "go" ? "opencode_go" : "free_api",
        modelId: id,
        canonicalId,
        label,
        endpointUrl: "https://opencode.ai/inference/go/openai/v1",
        apiStyle: "openai_chat",
        contextWindow: 0,
        maxOutputTokens: 0,
        inputModalities: ["text"],
        capabilities: { tools: false, structuredOutput: false, streaming: false, reasoning: false, cache: false },
        prices: null,
        requestFeeNanoUsd: 0,
        freeEligible: false,
        billingPrerequisites: [],
        quotaUnits: "go_shared_windows",
        privacy: { zdr: false, training: "unknown", dataCollection: "unknown", region: "unknown" },
        observedAt,
        expiresAt,
        qualificationStatus: "denied",
        quarantineReason: deny,
      });
      continue;
    }

    const api = asObj(m.api);
    const chatApi = asObj(api?.["chat-completions"]);
    const anthropicApi = asObj(api?.messages);
    const apiStyle: OfferApiStyle =
      surface === "zen" && id.endsWith("-free")
        ? "native_opencode"
        : chatApi
          ? "openai_chat"
          : anthropicApi
            ? "anthropic_messages"
            : "openai_chat";
    const endpointUrl =
      typeof chatApi?.base_url === "string"
        ? chatApi.base_url
        : typeof anthropicApi?.base_url === "string"
          ? anthropicApi.base_url.replace(/\/v1$/, "")
          : surface === "go"
            ? "https://opencode.ai/inference/go/openai/v1"
            : "https://opencode.ai/inference/openai/v1";

    if (!chatApi && !anthropicApi && apiStyle !== "native_opencode") {
      // Responses-only or proprietary sub-protocols not yet normalized for chat/tools are quarantined safely.
      offers.push({
        offerId: `opencode:${surface}:${id}`,
        provider: "opencode",
        lane: surface === "go" ? "opencode_go" : "direct_api",
        modelId: id,
        canonicalId,
        label,
        endpointUrl: "https://opencode.ai/inference/go/openai/v1",
        apiStyle: "openai_chat",
        contextWindow: typeof asObj(m.limit)?.context === "number" ? (asObj(m.limit)?.context as number) : 128_000,
        maxOutputTokens: 16_384,
        inputModalities: ["text"],
        capabilities: { tools: false, structuredOutput: false, streaming: false, reasoning: false, cache: false },
        prices: null,
        requestFeeNanoUsd: 0,
        freeEligible: false,
        billingPrerequisites: ["go_subscription_required"],
        quotaUnits: "go_shared_windows",
        privacy: { zdr: false, training: "unknown", dataCollection: "unknown", region: "global" },
        observedAt,
        expiresAt,
        qualificationStatus: "quarantined",
        quarantineReason: "protocol_family_unverified",
      });
      continue;
    }

    const limit = asObj(m.limit);
    const contextWindow = typeof limit?.context === "number" && limit.context > 0 ? limit.context : 128_000;
    const maxOutputTokens = typeof limit?.output === "number" && limit.output > 0 ? limit.output : 32_768;
    const caps = asObj(m.capabilities);
    const tools = asObj(caps?.tools)?.supported === true;
    const structuredOutput = caps?.structured_output === true;
    const reasoning = asObj(caps?.reasoning)?.supported === true;

    const textCost = asObj(asObj(m.cost)?.text);
    const inUsdPerM = asObj(textCost?.input)?.price;
    const outUsdPerM = asObj(textCost?.output)?.price;
    const cacheReadUsdPerM = asObj(asObj(textCost?.input)?.cache)?.read;
    const multipliers = Array.isArray(asObj(m.cost)?.multipliers) ? (asObj(m.cost)?.multipliers as Raw[]) : [];
    const maxFactor = multipliers.reduce((acc, item) => {
      const f = typeof item?.factor === "number" && Number.isFinite(item.factor) && item.factor > 1 ? item.factor : 1;
      return Math.max(acc, f);
    }, 1);

    const prices: TokenPrices | null =
      typeof inUsdPerM === "number" &&
      Number.isFinite(inUsdPerM) &&
      inUsdPerM >= 0 &&
      typeof outUsdPerM === "number" &&
      Number.isFinite(outUsdPerM) &&
      outUsdPerM >= 0
        ? {
            input: Math.ceil(inUsdPerM * 1000 * maxFactor),
            output: Math.ceil(outUsdPerM * 1000 * maxFactor),
            cacheRead:
              typeof cacheReadUsdPerM === "number" && Number.isFinite(cacheReadUsdPerM) && cacheReadUsdPerM >= 0
                ? Math.ceil(cacheReadUsdPerM * 1000 * maxFactor)
                : Math.ceil(inUsdPerM * 1000 * maxFactor),
            cacheWrite: Math.ceil(inUsdPerM * 1000 * maxFactor),
          }
        : null;

    const goMeta = asObj(m.go);
    const zdr = goMeta?.zdr === true;
    const training =
      typeof goMeta?.training === "boolean" ? goMeta.training : /contributor/i.test(id) ? true : "unknown";
    const modalsIn = asStrings(asObj(m.modalities)?.input);
    const inputModalities: ("text" | "image" | "pdf")[] = [
      "text",
      ...(modalsIn.some((x) => x.startsWith("image/")) ? (["image"] as const) : []),
    ];

    if (surface === "zen" && id.endsWith("-free")) {
      offers.push({
        offerId: `opencode:zen:${id}`,
        provider: "opencode",
        lane: "free_api",
        modelId: id,
        canonicalId,
        label,
        endpointUrl: "opencode://native-cli",
        apiStyle: "native_opencode",
        contextWindow,
        maxOutputTokens,
        inputModalities,
        capabilities: { tools, structuredOutput, streaming: true, reasoning, cache: false },
        prices: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        requestFeeNanoUsd: 0,
        freeEligible: true,
        billingPrerequisites: ["native_opencode_cli_only"],
        quotaUnits: "requests_tokens",
        privacy: { zdr, training, dataCollection: training === true ? "allow" : "unknown", region: "global" },
        observedAt,
        expiresAt,
        // Native OpenCode free chat is gated on permitted native CLI harness + verified checkpoint; never external HTTP.
        qualificationStatus: "quarantined",
        quarantineReason: "native_opencode_harness_required",
      });
      continue;
    }

    const isGoIncluded = surface === "go" && Boolean(goMeta);
    offers.push({
      offerId: `opencode:${surface}:${id}`,
      provider: "opencode",
      lane: isGoIncluded ? "opencode_go" : "direct_api",
      modelId: id,
      canonicalId,
      label,
      endpointUrl,
      apiStyle,
      contextWindow,
      maxOutputTokens,
      inputModalities,
      capabilities: { tools, structuredOutput, streaming: true, reasoning, cache: cacheReadUsdPerM !== undefined },
      // On an authorized Go subscription with Extra Usage OFF, included calls incur 0 incremental metered USD.
      prices: isGoIncluded ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } : prices,
      requestFeeNanoUsd: 0,
      freeEligible: isGoIncluded,
      billingPrerequisites: isGoIncluded ? ["go_subscription_required"] : ["separate_provider_approval"],
      quotaUnits: isGoIncluded ? "go_shared_windows" : "nano_usd",
      privacy: {
        zdr,
        training,
        dataCollection: training === false ? "deny" : training === true ? "allow" : "unknown",
        region: "global",
      },
      observedAt,
      expiresAt,
      qualificationStatus: prices === null ? "quarantined" : isGoIncluded ? "eligible" : "requires_owner_approval",
      quarantineReason: prices === null ? "unknown_price_quarantined" : null,
    });
  }
  return offers;
}

/**
 * Parses GroqCloud `GET https://api.groq.com/openai/v1/models` for free-only or paid-capped accounts.
 * On `free_only` accounts, incremental USD spend is strictly 0 and org RPM/RPD/TPM/TPD limits govern admission.
 */
export function parseGroqCatalogOffers(
  body: unknown,
  entitlement: ProviderEntitlementKind,
  observedAt = new Date().toISOString(),
  ttlMs = DEFAULT_CATALOG_TTL_MS,
): ModelOffer[] {
  const expiresAt = new Date(Date.parse(observedAt) + ttlMs).toISOString();
  const rawData = asObj(body)?.data;
  const rows = (Array.isArray(rawData) ? rawData : []).flatMap((item) => {
    const o = asObj(item);
    return o ? [o] : [];
  });
  const offers: ModelOffer[] = [];
  for (const m of rows) {
    const id = typeof m.id === "string" ? m.id.trim() : "";
    if (!id || m.active === false) continue;
    if (/whisper|tts|guard|safeguard|embed/i.test(id)) continue;
    const deny = routerDenylistReason("groq", id);
    if (deny) {
      offers.push({
        offerId: `groq:${id}`,
        provider: "groq",
        lane: "free_api",
        modelId: id,
        canonicalId: id,
        label: id,
        endpointUrl: "https://api.groq.com/openai/v1",
        apiStyle: "openai_chat",
        contextWindow: 0,
        maxOutputTokens: 0,
        inputModalities: ["text"],
        capabilities: { tools: false, structuredOutput: false, streaming: true, reasoning: false, cache: false },
        prices: null,
        requestFeeNanoUsd: 0,
        freeEligible: false,
        billingPrerequisites: [],
        quotaUnits: "requests_tokens",
        privacy: { zdr: false, training: false, dataCollection: "deny", region: "us_eu" },
        observedAt,
        expiresAt,
        qualificationStatus: "denied",
        quarantineReason: deny,
      });
      continue;
    }
    const contextWindow =
      typeof m.context_window === "number" && m.context_window >= 32_000 ? m.context_window : 131_072;
    const maxOutputTokens =
      typeof m.max_completion_tokens === "number" && m.max_completion_tokens > 0 ? m.max_completion_tokens : 32_768;
    const isFreeAccount = entitlement === "free_only";
    const isGptOss = /gpt-oss-(?:120b|20b)/i.test(id);
    const listPrices: TokenPrices | null = isFreeAccount
      ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      : /120b/i.test(id)
        ? { input: 150, output: 600, cacheRead: 75, cacheWrite: 150 }
        : /20b/i.test(id)
          ? { input: 75, output: 300, cacheRead: 38, cacheWrite: 75 }
          : null;

    offers.push({
      offerId: `groq:${id}`,
      provider: "groq",
      lane: isFreeAccount ? "free_api" : "direct_api",
      modelId: id,
      canonicalId: id,
      label: `Groq ${id}`,
      endpointUrl: "https://api.groq.com/openai/v1",
      apiStyle: "openai_chat",
      contextWindow,
      maxOutputTokens,
      inputModalities: ["text"],
      capabilities: {
        tools: true,
        structuredOutput: isGptOss,
        streaming: true,
        reasoning: isGptOss,
        cache: false,
      },
      prices: listPrices,
      requestFeeNanoUsd: 0,
      freeEligible: isFreeAccount,
      billingPrerequisites: isFreeAccount ? [] : ["separate_provider_approval"],
      quotaUnits: isFreeAccount ? "requests_tokens" : "nano_usd",
      privacy: { zdr: false, training: false, dataCollection: "deny", region: "us_eu" },
      observedAt,
      expiresAt,
      qualificationStatus: listPrices === null ? "quarantined" : isFreeAccount ? "eligible" : "requires_owner_approval",
      quarantineReason: listPrices === null ? "unknown_price_quarantined" : null,
    });
  }
  return offers;
}

/**
 * Parses Cloudflare Workers AI models for an account (`10,000 Neurons/day` free plan).
 * Enforces:
 * - `@cf/openai/gpt-oss-*` uses `openai_responses_nonstream` (GPT-OSS Responses nonstream only).
 * - Models requiring a paid billing method (such as paid-gated DeepSeek/Kimi/GLM variants on Workers AI)
 *   are quarantined on `free_only` accounts so zero Unified Billing/paid leakage can occur.
 */
export function parseCloudflareCatalogOffers(
  body: unknown,
  accountId: string,
  entitlement: ProviderEntitlementKind,
  observedAt = new Date().toISOString(),
  ttlMs = DEFAULT_CATALOG_TTL_MS,
): ModelOffer[] {
  if (!/^[a-f0-9]{32}$/i.test(accountId.trim())) {
    throw new Error("Cloudflare Workers AI requires a valid 32-hex account ID");
  }
  const cleanAccount = accountId.trim().toLowerCase();
  const endpointUrl = `https://api.cloudflare.com/client/v4/accounts/${cleanAccount}/ai/v1`;
  const expiresAt = new Date(Date.parse(observedAt) + ttlMs).toISOString();
  const root = asObj(body);
  const rawList = Array.isArray(root?.result) ? root.result : Array.isArray(root?.data) ? root.data : [];
  const rows = rawList.flatMap((item) => {
    const o = asObj(item);
    return o ? [o] : [];
  });
  const offers: ModelOffer[] = [];
  for (const m of rows) {
    const id = typeof m.name === "string" ? m.name.trim() : typeof m.id === "string" ? m.id.trim() : "";
    if (!id.startsWith("@cf/") && !id.startsWith("@hf/")) continue;
    const taskName = typeof asObj(m.task)?.name === "string" ? (asObj(m.task)?.name as string) : "Text Generation";
    if (!/text generation/i.test(taskName)) continue;

    const deny = routerDenylistReason("cloudflare", id);
    if (deny) {
      offers.push({
        offerId: `cloudflare:${id}`,
        provider: "cloudflare",
        lane: "free_api",
        modelId: id,
        canonicalId: id,
        label: id,
        endpointUrl,
        apiStyle: "openai_chat",
        contextWindow: 0,
        maxOutputTokens: 0,
        inputModalities: ["text"],
        capabilities: { tools: false, structuredOutput: false, streaming: false, reasoning: false, cache: false },
        prices: null,
        requestFeeNanoUsd: 0,
        freeEligible: false,
        billingPrerequisites: [],
        quotaUnits: "neurons",
        privacy: { zdr: false, training: false, dataCollection: "deny", region: "global" },
        observedAt,
        expiresAt,
        qualificationStatus: "denied",
        quarantineReason: deny,
      });
      continue;
    }

    const props = Array.isArray(m.properties) ? (m.properties as Raw[]) : [];
    const propMap = new Map(
      props.flatMap((p) => (typeof p?.property_id === "string" ? [[p.property_id, p.value] as const] : [])),
    );
    const paidRequired =
      m.requires_paid_plan === true || propMap.get("paid_plan_only") === "true" || /deepseek|kimi|glm/i.test(id);
    const isGptOss = /@cf\/openai\/gpt-oss-(?:120b|20b)/i.test(id);
    const supportsTools = isGptOss || propMap.get("function_calling") === "true";
    const contextWindow =
      Number(propMap.get("context_window")) >= 32_000 ? Number(propMap.get("context_window")) : 128_000;
    const isFreeAccount = entitlement === "free_only";

    const prerequisites: BillingPrerequisite[] = paidRequired ? ["paid_method_required"] : [];
    const freeEligible = isFreeAccount && !paidRequired;
    const qualificationStatus: OfferQualificationStatus =
      isFreeAccount && paidRequired ? "quarantined" : isFreeAccount ? "eligible" : "requires_owner_approval";

    offers.push({
      offerId: `cloudflare:${id}`,
      provider: "cloudflare",
      lane: isFreeAccount ? "free_api" : "direct_api",
      modelId: id,
      canonicalId: id,
      label: `Workers AI ${id}`,
      endpointUrl,
      // Official Workers AI constraint: GPT-OSS Responses endpoint is non-streaming only.
      apiStyle: isGptOss ? "openai_responses_nonstream" : "openai_chat",
      contextWindow,
      maxOutputTokens: 16_384,
      inputModalities: ["text"],
      capabilities: {
        tools: supportsTools,
        structuredOutput: isGptOss,
        streaming: !isGptOss,
        reasoning: isGptOss,
        cache: false,
      },
      prices: freeEligible ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } : null,
      requestFeeNanoUsd: 0,
      neuronsPer1kTokens: /120b/i.test(id) ? { input: 32, output: 68 } : { input: 18, output: 27 },
      freeEligible,
      billingPrerequisites: prerequisites,
      quotaUnits: "neurons",
      privacy: { zdr: false, training: false, dataCollection: "deny", region: "global" },
      observedAt,
      expiresAt,
      qualificationStatus,
      quarantineReason: isFreeAccount && paidRequired ? "cloudflare_paid_method_required" : null,
    });
  }
  return offers;
}

/**
 * Builds documented direct-provider cloud catalog offers (DeepSeek, Tencent Hy, MiniMax, Z.ai GLM,
 * Moonshot Kimi, Xiaomi MiMo, NVIDIA NIM) from verified catalog metadata. All direct paid APIs default
 * to `requires_owner_approval` until an owner explicitly binds a credential and monthly cap for that provider.
 */
export function buildDirectCloudOffers(
  observedAt = new Date().toISOString(),
  ttlMs = DEFAULT_CATALOG_TTL_MS,
): ModelOffer[] {
  const expiresAt = new Date(Date.parse(observedAt) + ttlMs).toISOString();
  const directProviders: ReadonlySet<ProviderId> = new Set([
    "deepseek",
    "tencent",
    "minimax",
    "zai",
    "moonshot",
    "xiaomi",
    "nvidia",
  ]);
  const endpointByProvider: Record<string, { url: string; style: OfferApiStyle; region: ModelOfferPrivacy["region"] }> =
    {
      deepseek: { url: "https://api.deepseek.com/anthropic", style: "anthropic_messages", region: "global" },
      moonshot: { url: "https://api.moonshot.ai/anthropic", style: "anthropic_messages", region: "global" },
      zai: { url: "https://api.z.ai/api/anthropic", style: "anthropic_messages", region: "global" },
      minimax: { url: "https://api.minimax.io/anthropic", style: "anthropic_messages", region: "global" },
      tencent: { url: "https://api.hunyuan.cloud.tencent.com/v1", style: "openai_chat", region: "global" },
      xiaomi: { url: "https://api.xiaomimimo.com/v1", style: "openai_chat", region: "global" },
      nvidia: { url: "https://integrate.api.nvidia.com/v1", style: "openai_chat", region: "us_eu" },
    };

  const out: ModelOffer[] = [];
  for (const [modelId, info] of Object.entries(MODEL_CATALOG)) {
    if (!directProviders.has(info.provider) || isCustomModel(modelId)) continue;
    const ep = endpointByProvider[info.provider];
    if (!ep) continue;
    out.push({
      offerId: `${info.provider}:${modelId}`,
      provider: info.provider,
      lane: "direct_api",
      modelId,
      canonicalId: `${info.provider}/${modelId}`,
      label: info.label,
      endpointUrl: ep.url,
      apiStyle: ep.style,
      contextWindow: info.contextWindow ?? 200_000,
      maxOutputTokens: info.maxOutputTokens ?? 32_768,
      inputModalities: ["text"],
      capabilities: {
        tools: true,
        structuredOutput: info.structuredOutput !== false,
        streaming: true,
        reasoning: Boolean(info.reasoning || info.leastThinking),
        cache: info.prices.cacheRead < info.prices.input,
      },
      prices: { ...info.prices },
      requestFeeNanoUsd: 0,
      freeEligible: false,
      billingPrerequisites: ["separate_provider_approval"],
      quotaUnits: "nano_usd",
      privacy: { zdr: false, training: false, dataCollection: "deny", region: ep.region },
      observedAt,
      expiresAt,
      qualificationStatus: "requires_owner_approval",
      quarantineReason: null,
    });
  }
  return out;
}
