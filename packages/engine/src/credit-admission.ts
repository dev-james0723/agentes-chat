import {
  LONG_CACHE_WRITE,
  MODEL_CATALOG,
  type ModelRequest,
  maxCostNanoUsd,
  modelInfo,
  type TokenPrices,
} from "@agenteschat/providers";
import { CreditRouteRefusal } from "./credit-route";

export type CreditApiProvider = "openai" | "anthropic";
export interface CreditAdmissionBound {
  amountNanoUsd: number;
  /** An input ceiling, not measured usage or a tokenizer estimate. */
  promptTokens: number;
  maxTokens: number;
  /** UTF-8 bytes of all admitted text, client tools and notes. */
  promptBytes: number;
}
const PROMPT_BYTES_LIMIT = 16_000_000;
const integer = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const positive = (n: unknown): n is number => integer(n) && n > 0;
function refuse(): never {
  throw new CreditRouteRefusal("unsupported_capability");
}
const record = (v: unknown): v is Record<string, unknown> =>
  !!v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
function keys(value: object, allowed: readonly string[]) {
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !allowed.includes(key))) refuse();
}
function booleanOrAbsent(value: unknown) {
  if (value !== undefined && typeof value !== "boolean") refuse();
}
/** Reject non-JSON payloads instead of letting JSON.stringify silently erase billable/unsupported data. */
function jsonData(value: unknown, depth = 0, path = new WeakSet<object>(), count = { n: 0 }): void {
  if (++count.n > 100_000 || depth > 64) refuse();
  if (value === null || value === undefined || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) refuse();
    return;
  }
  if (typeof value !== "object" || (!Array.isArray(value) && !record(value)) || path.has(value)) refuse();
  path.add(value);
  for (const child of Object.values(value)) jsonData(child, depth + 1, path, count);
  path.delete(value);
}
/**
 * Preserve only the documented same-provider reasoning payloads the stateless adapters replay.
 * The provider validates its signature/encryption; this check never treats a session ID as portable.
 * Whole-context reservation and the JSON byte/depth ceiling still cover these unchanged bytes.
 */
function checkReasoning(provider: CreditApiProvider, block: Record<string, unknown>, role: unknown) {
  keys(block, ["type", "provider", "data", "restart"]);
  if (
    role !== "assistant" ||
    block.provider !== provider ||
    !record(block.data) ||
    (block.restart !== undefined && block.restart !== provider)
  )
    refuse();
  const data = block.data;
  if (provider === "anthropic") {
    if (data.type === "thinking") {
      keys(data, ["type", "thinking", "signature"]);
      if (typeof data.thinking !== "string" || typeof data.signature !== "string" || !data.signature) refuse();
    } else if (data.type === "redacted_thinking") {
      keys(data, ["type", "data"]);
      if (typeof data.data !== "string" || !data.data) refuse();
    } else refuse();
    return;
  }
  keys(data, ["type", "id", "summary", "content", "encrypted_content", "status"]);
  if (
    data.type !== "reasoning" ||
    typeof data.id !== "string" ||
    !/^rs_[A-Za-z0-9_-]{1,197}$/.test(data.id) ||
    typeof data.encrypted_content !== "string" ||
    !data.encrypted_content ||
    !Array.isArray(data.summary) ||
    (data.status !== undefined && data.status !== "completed" && data.status !== "incomplete")
  )
    refuse();
  for (const part of data.summary) {
    if (!record(part)) refuse();
    keys(part, ["type", "text"]);
    if (part.type !== "summary_text" || typeof part.text !== "string") refuse();
  }
  if (data.content !== undefined) {
    if (!Array.isArray(data.content)) refuse();
    for (const part of data.content) {
      if (!record(part)) refuse();
      keys(part, ["type", "text"]);
      if (part.type !== "reasoning_text" || typeof part.text !== "string") refuse();
    }
  }
}
function checkTextRequest(provider: CreditApiProvider, request: ModelRequest) {
  keys(request as unknown as Record<string, unknown>, [
    "model",
    "system",
    "messages",
    "maxTokens",
    "tools",
    "outputSchema",
    "effort",
    "cacheTtl",
    "notes",
    "signal",
    "noTransportRetries",
  ]);
  if (request.outputSchema !== undefined) refuse();
  if (request.cacheTtl !== undefined && request.cacheTtl !== "1h") refuse();
  if (request.effort !== undefined && !["none", "low", "medium", "high"].includes(request.effort)) refuse();
  if (typeof request.system !== "string") {
    if (!Array.isArray(request.system)) refuse();
    for (const block of request.system) {
      if (!record(block) || typeof block.text !== "string") refuse();
      keys(block, ["text", "cache", "after"]);
      booleanOrAbsent(block.cache);
      booleanOrAbsent(block.after);
    }
  }
  if (!Array.isArray(request.messages) || request.messages.length === 0) refuse();
  for (const message of request.messages) {
    if (!record(message) || !["user", "assistant"].includes(message.role as string)) refuse();
    keys(message, ["role", "content"]);
    if (typeof message.content === "string") continue;
    if (!Array.isArray(message.content)) refuse();
    for (const block of message.content) {
      if (!record(block)) refuse();
      if (block.restart !== undefined && typeof block.restart !== "string") refuse();
      if (block.type === "text") {
        keys(block, ["type", "text", "cache", "restart"]);
        if (typeof block.text !== "string") refuse();
        booleanOrAbsent(block.cache);
      } else if (block.type === "tool_use") {
        keys(block, ["type", "id", "name", "input", "restart"]);
        if (typeof block.id !== "string" || typeof block.name !== "string" || !record(block.input)) refuse();
      } else if (block.type === "tool_result") {
        keys(block, ["type", "toolUseId", "content", "isError", "images", "restart"]);
        if (typeof block.toolUseId !== "string" || typeof block.content !== "string") refuse();
        if (block.images !== undefined && (!Array.isArray(block.images) || block.images.length !== 0)) refuse();
        booleanOrAbsent(block.isError);
      } else if (block.type === "opaque") {
        checkReasoning(provider, block, message.role);
      } else refuse(); // Image, PDF, audio and server-native tools have no bound here.
    }
  }
  if (request.tools !== undefined) {
    if (!Array.isArray(request.tools) || request.tools.length > 256) refuse();
    for (const tool of request.tools) {
      if (!record(tool)) refuse();
      keys(tool, ["name", "description", "inputSchema", "stable"]);
      if (
        typeof tool.name !== "string" ||
        !tool.name ||
        typeof tool.description !== "string" ||
        !record(tool.inputSchema)
      )
        refuse();
      booleanOrAbsent(tool.stable);
    }
  }
  if (request.notes !== undefined) {
    if (!record(request.notes)) refuse();
    keys(request.notes, ["at", "text"]);
    if (
      !integer(request.notes.at) ||
      request.notes.at >= request.messages.length ||
      typeof request.notes.text !== "string"
    )
      refuse();
  }
}
function checkPrices(prices: TokenPrices) {
  if (
    !prices ||
    !positive(prices.input) ||
    !positive(prices.output) ||
    !integer(prices.cacheRead) ||
    !integer(prices.cacheWrite)
  )
    refuse();
}

/**
 * No local bytes/token ratio is a proven bound on provider tokenization and hidden framing.
 * Reserve the entire explicitly catalogued context window as INPUT, plus the maximum requested
 * output, at the highest known applicable rates. Double-counting the output room is deliberate.
 * Provider adapters must use the exact official model, no server fallback and no transport retries.
 * This is a ceiling conditional on verified provider context/pricing; it never verifies a grant.
 */
export function creditAdmissionBound(provider: CreditApiProvider, request: ModelRequest): CreditAdmissionBound {
  try {
    if (provider !== "openai" && provider !== "anthropic") refuse();
    if (!record(request) || !Object.hasOwn(MODEL_CATALOG, request.model)) refuse();
    const info = modelInfo(request.model);
    if (
      !info ||
      info.provider !== provider ||
      info.unpriced ||
      info.endpoint ||
      !positive(info.contextWindow) ||
      !positive(request.maxTokens) ||
      request.maxTokens > info.contextWindow ||
      (info.maxOutputTokens !== undefined &&
        (!positive(info.maxOutputTokens) || request.maxTokens > info.maxOutputTokens))
    )
      refuse();
    checkTextRequest(provider, request);
    const body = {
      model: request.model,
      system: request.system,
      messages: request.messages,
      tools: request.tools,
      notes: request.notes,
      effort: request.effort,
      cacheTtl: request.cacheTtl,
    };
    jsonData(body);
    const promptBytes = new TextEncoder().encode(JSON.stringify(body)).byteLength;
    if (promptBytes > PROMPT_BYTES_LIMIT) refuse();
    const prices = [
      info.prices,
      ...(info.longContext ? [info.longContext.prices] : []),
      ...(info.intro ? [info.intro.prices] : []),
    ];
    prices.forEach(checkPrices);
    if (info.longContext && !positive(info.longContext.aboveInputTokens)) refuse();
    const promptTokens = info.contextWindow;
    const maxTokens = request.maxTokens;
    const longCache = request.cacheTtl === "1h";
    const catalogBound = maxCostNanoUsd(request.model, promptTokens, maxTokens, longCache);
    // Also protect unusual catalog entries whose base, cache-read or introductory rate is higher.
    const inputRate = Math.max(
      ...prices.map((p) => Math.max(p.input, p.cacheRead, p.cacheWrite, longCache ? LONG_CACHE_WRITE * p.input : 0)),
    );
    const outputRate = Math.max(...prices.map((p) => p.output));
    const amountNanoUsd = Math.max(catalogBound, promptTokens * inputRate + maxTokens * outputRate);
    if (!positive(amountNanoUsd)) refuse();
    return { amountNanoUsd, promptTokens, maxTokens, promptBytes };
  } catch (error) {
    if (error instanceof CreditRouteRefusal) throw error;
    return refuse();
  }
}

export interface CreditWorkSample {
  /** Total actual settled cost of one completed work unit; unresolved attempts are not samples. */
  actualNanoUsd: number;
  settledAt: number;
  workUnitId?: string;
}
export interface CreditWorkForecast {
  sampleCount: number;
  meanNanoUsd: number | null;
  p95NanoUsd: number | null;
  uncertainty: "unknown" | "high" | "medium";
  /** Statistical description only; it never reserves funds or authorizes a dispatch. */
  estimatedUnitsAtP95: number | null;
  enoughToCheckpoint: boolean;
  admissionBasis: "hard_next_unit_bound";
}
/** Bounded empirical forecast. A forecast never substitutes for a calculable next-unit maximum. */
export function creditWorkForecast(input: {
  samples: readonly CreditWorkSample[];
  now: number;
  remainingNanoUsd: number;
  nextUnitBoundNanoUsd: number | null;
  maxAgeMs?: number;
  limit?: number;
}): CreditWorkForecast {
  const remainingKnown = integer(input.remainingNanoUsd);
  const enoughToCheckpoint =
    remainingKnown && positive(input.nextUnitBoundNanoUsd) && input.remainingNanoUsd >= input.nextUnitBoundNanoUsd;
  const empty: CreditWorkForecast = {
    sampleCount: 0,
    meanNanoUsd: null,
    p95NanoUsd: null,
    uncertainty: "unknown",
    estimatedUnitsAtP95: null,
    enoughToCheckpoint,
    admissionBasis: "hard_next_unit_bound",
  };
  const maxAgeMs = input.maxAgeMs ?? 7 * 86_400_000;
  const limit = input.limit ?? 100;
  if (!integer(input.now) || !positive(maxAgeMs) || !positive(limit) || limit > 1000 || !Array.isArray(input.samples))
    return empty;
  const seen = new Set<string>();
  const samples = input.samples
    .filter(
      (s) =>
        s &&
        integer(s.actualNanoUsd) &&
        integer(s.settledAt) &&
        s.settledAt <= input.now &&
        input.now - s.settledAt <= maxAgeMs,
    )
    .sort((a, b) => b.settledAt - a.settledAt)
    .filter((s) => {
      if (!s.workUnitId) return true;
      if (seen.has(s.workUnitId)) return false;
      seen.add(s.workUnitId);
      return true;
    })
    .slice(0, limit);
  if (!samples.length) return empty;
  const costs = samples.map((s) => s.actualNanoUsd).sort((a, b) => a - b);
  const total = costs.reduce((sum, cost) => sum + cost, 0);
  if (!integer(total)) return empty;
  const p95NanoUsd = costs[Math.ceil(costs.length * 0.95) - 1] as number;
  return {
    sampleCount: costs.length,
    meanNanoUsd: Math.ceil(total / costs.length),
    p95NanoUsd,
    uncertainty: costs.length < 20 ? "high" : "medium",
    estimatedUnitsAtP95: remainingKnown && p95NanoUsd > 0 ? Math.floor(input.remainingNanoUsd / p95NanoUsd) : null,
    enoughToCheckpoint,
    admissionBasis: "hard_next_unit_bound",
  };
}
