import { readCapped } from "@agenteschat/adapters";
import {
  MODEL_CATALOG,
  type ModelInfo,
  type ModelTier,
  type ProviderId,
  setDiscoveredModels,
} from "@agenteschat/providers";

/**
 * Discover newly released native API models without waiting for a desktop app release.
 *
 * Models.dev is a public metadata feed, NOT proof that a workspace key can run a
 * particular model. The existing credential gate still applies. Only text-output,
 * tool-capable models with a positive documented price are admitted. Invalid, empty,
 * oversized or unavailable feeds never replace the last usable snapshot.
 *
 * No downloaded instructions, endpoints, credential information or executable
 * content are accepted. The provider adapter/base URL stays defined in catalog.ts.
 */
export const MODEL_METADATA_URL = "https://models.dev/api.json";
const MAX_BYTES = 8_000_000;
const TIMEOUT_MS = 20_000;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9_.:/+-]{1,110}$/;
const DATE = /^20\d\d-\d\d-\d\d$/;

type RecordValue = Record<string, unknown>;
const record = (v: unknown): RecordValue | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as RecordValue) : null;
const numeric = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const positive = (v: unknown) => {
  const n = numeric(v);
  return n !== null && n > 0 && n <= 1_000 ? n : null;
};
const nano = (usdPerMillion: number) => Math.round(usdPerMillion * 1000);

function price(value: unknown): ModelInfo["prices"] | null {
  const cost = record(value);
  if (!cost) return null;
  const input = positive(cost.input);
  const output = positive(cost.output);
  if (input === null || output === null) return null;
  // Missing cache rates are conservatively priced, never silently billed as zero.
  const cacheRead = numeric(cost.cache_read);
  const cacheWrite = numeric(cost.cache_write);
  return {
    input: nano(input),
    output: nano(output),
    cacheRead: nano(cacheRead !== null && cacheRead >= 0 ? cacheRead : input),
    cacheWrite: nano(cacheWrite !== null && cacheWrite >= 0 ? cacheWrite : input * 2),
  };
}

function modelTier(provider: ProviderId, id: string): ModelTier | undefined {
  if (provider === "openai") {
    if (/^gpt-\d+(?:\.\d+)?-luna(?:-|$)/.test(id)) return "small";
    if (/^gpt-\d+(?:\.\d+)?-sol(?:-|$)/.test(id)) return "medium";
    if (/^gpt-\d+(?:\.\d+)?-astra(?:-|$)/.test(id)) return "large";
  }
  if (provider === "anthropic") {
    if (/^claude-haiku-\d/.test(id)) return "small";
    if (/^claude-sonnet-\d/.test(id)) return "medium";
    if (/^claude-opus-\d/.test(id)) return "large";
  }
  if (provider === "gemini") {
    if (/^gemini-\d+(?:\.\d+)?-flash-lite(?:-|$)/.test(id)) return "small";
    if (/^gemini-\d+(?:\.\d+)?-flash(?:-|$)/.test(id)) return "medium";
    if (/^gemini-\d+(?:\.\d+)?-(?:argon|pro)(?:-|$)/.test(id)) return "large";
  }
  // All Grok API models are still user-selectable; JEV can choose the latest
  // tool-capable general model at the medium tier on an xAI-keyed workspace.
  if (provider === "xai" && /^grok-\d+(?:\.\d+)?$/.test(id)) return "medium";
  return undefined;
}

function longContext(value: unknown, context: number): ModelInfo["longContext"] | undefined {
  const source = record(value);
  const tiers = source?.tiers;
  if (!Array.isArray(tiers)) return undefined;
  let chosen: ModelInfo["longContext"] | undefined;
  for (const raw of tiers) {
    const tier = record(raw);
    const thresholdInfo = record(tier?.tier);
    // A batch, request, modality or other discount is not a long-context price.
    if (thresholdInfo?.type !== "context") continue;
    const threshold = numeric(thresholdInfo.size);
    const adjusted = price(tier);
    if (threshold === null || threshold < 32_000 || threshold >= context || !adjusted) continue;
    if (!chosen) {
      chosen = { aboveInputTokens: threshold, prices: adjusted };
      continue;
    }
    // ModelInfo represents a single threshold. Multiple context tiers must
    // conservatively reserve at least the costliest published rate at the
    // earliest threshold, rather than underbill a higher-context request.
    chosen = {
      aboveInputTokens: Math.min(chosen.aboveInputTokens, threshold),
      prices: {
        input: Math.max(chosen.prices.input, adjusted.input),
        output: Math.max(chosen.prices.output, adjusted.output),
        cacheRead: Math.max(chosen.prices.cacheRead, adjusted.cacheRead),
        cacheWrite: Math.max(chosen.prices.cacheWrite, adjusted.cacheWrite),
      },
    };
  }
  return chosen;
}

function oneModel(id: string, raw: unknown, provider: ProviderId): ModelInfo | null {
  if (!MODEL_ID.test(id) || Object.hasOwn(MODEL_CATALOG, id)) return null;
  const m = record(raw);
  if (!m || (m.type !== undefined && !["chat", "language", "text"].includes(String(m.type)))) return null;
  if (m.tool_call !== true || m.structured_output === false) return null;
  const modalities = record(m.modalities);
  if (!Array.isArray(modalities?.input) || !modalities.input.includes("text")) return null;
  if (!Array.isArray(modalities?.output) || modalities.output.length !== 1 || modalities.output[0] !== "text")
    return null;
  const costs = price(m.cost);
  const limits = record(m.limit);
  const context = numeric(limits?.context);
  if (!costs || context === null || context < 16_000 || context > 10_000_000) return null;
  const max = numeric(limits?.output);
  const candidate =
    typeof m.name === "string" && m.name.length <= 100 && ![...m.name].some((ch) => ch.charCodeAt(0) < 32)
      ? m.name
      : id;
  // Do not advertise future-dated preview entries as released.
  if (typeof m.release_date === "string" && DATE.test(m.release_date) && Date.parse(m.release_date) > Date.now())
    return null;
  const released =
    typeof m.release_date === "string" &&
    DATE.test(m.release_date) &&
    Number.isFinite(Date.parse(m.release_date)) &&
    Date.parse(m.release_date) <= Date.now()
      ? m.release_date
      : undefined;
  const reasoningOpts = m.reasoning_options;
  const efforts: string[] = [];
  if (Array.isArray(reasoningOpts)) {
    for (const opt of reasoningOpts) {
      const o = record(opt);
      if (o?.type === "effort" && Array.isArray(o.values)) {
        for (const level of ["max", "xhigh", "high", "medium", "low", "minimal", "none"]) {
          if (o.values.includes(level)) efforts.push(level);
        }
      }
    }
  }
  return {
    provider,
    label: candidate,
    prices: costs,
    serverSideFallback: false,
    reasoning: m.reasoning === true,
    contextWindow: context,
    ...(max !== null && max >= 1000 && max <= 1_000_000 ? { maxOutputTokens: max } : {}),
    ...(longContext(m.cost, context) ? { longContext: longContext(m.cost, context) } : {}),
    ...(efforts.length ? { efforts } : {}),
    ...(released ? { releasedAt: released } : {}),
    ...(modelTier(provider, id) ? { tier: modelTier(provider, id) } : {}),
  };
}

export function parseProviderModels(document: unknown): Record<string, ModelInfo> | null {
  const root = record(document);
  if (!root) return null;
  // A truncated or changed feed must not wipe the running catalog.
  const sources = [
    ["openai", "openai"],
    ["anthropic", "anthropic"],
    ["google", "gemini"],
    ["xai", "xai"],
  ] as const satisfies readonly (readonly [string, ProviderId])[];
  const models: Record<string, ModelInfo> = {};
  for (const [source, provider] of sources) {
    const group = record(root[source]);
    const entries = record(group?.models);
    if (!entries || Object.keys(entries).length > 500) return null;
    for (const [id, raw] of Object.entries(entries)) {
      const parsed = oneModel(id, raw, provider);
      if (parsed && !Object.hasOwn(models, id)) models[id] = parsed;
    }
  }
  return Object.keys(models).length >= 4 ? models : null;
}

let lastEtag: string | null = null;
let count = 0;

/** Called on worker boot and once per hour. Provider-key access is still checked by the normal gateway. */
export async function refreshProviderModels(read: typeof fetch = fetch): Promise<{ updated: boolean; count: number }> {
  try {
    const response = await read(MODEL_METADATA_URL, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      ...(lastEtag ? { headers: { "If-None-Match": lastEtag } } : {}),
    });
    if (response.status === 304) return { updated: false, count };
    if (!response.ok) return { updated: false, count };
    const bytes = await readCapped(response, MAX_BYTES);
    if (!bytes) return { updated: false, count };
    const found = parseProviderModels(JSON.parse(new TextDecoder().decode(bytes)));
    if (!found) return { updated: false, count };
    setDiscoveredModels(found);
    count = Object.keys(found).length;
    lastEtag = response.headers.get("etag")?.slice(0, 200) ?? null;
    return { updated: true, count };
  } catch {
    return { updated: false, count };
  }
}
