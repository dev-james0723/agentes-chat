import { createAnthropicProvider } from "./anthropic";
import { boundedFetch, withHeaders } from "./custom";
import { assertSafeRouterEndpoint, isOpencodeNativeOnlyFreeId, type RateLimitTelemetry } from "./global-router-helpers";
import { createOpenRouterProvider } from "./openrouter";
import {
  type ContentBlock,
  deniedError,
  estimateTokens,
  hasToolImages,
  laidOut,
  type ModelProvider,
  type ModelResult,
  ProviderError,
  promptChars,
  type StopReason,
  stableToolsFirst,
  systemText,
  withoutImages,
} from "./types";

/**
 * Cloud provider adapters for the Global Model Router:
 * - GroqCloud (`groq`): OpenAI-compatible Chat Completions with organization RPM/RPD/TPM/TPD header telemetry
 * - Cloudflare Workers AI (`cloudflare`): account-scoped endpoint, non-streaming GPT-OSS `/responses` normalization,
 *   and streaming Chat Completions for other eligible Workers AI models
 * - OpenCode Go / Console (`opencode`): official `agentes.chat/<version>` User-Agent + `x-opencode-session`,
 *   Extra Usage strictly disabled, native-only free models never spoofed (403 respected)
 * - Direct OpenAI-compatible cloud providers (`tencent`, `xiaomi`, `nvidia`)
 */

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const OPENCODE_GO_OPENAI_URL = "https://opencode.ai/inference/go/openai/v1";
const OPENCODE_GO_ANTHROPIC_URL = "https://opencode.ai/inference/go/anthropic";

const UPSTREAM_MODEL_MAP: Readonly<Record<string, string>> = {
  "groq/gpt-oss-120b": "openai/gpt-oss-120b",
  "groq/gpt-oss-20b": "openai/gpt-oss-20b",
  "hunyuan-hy4": "hunyuan-t1-latest",
  "hunyuan-hy4-flash": "hunyuan-turbos-latest",
  "nvidia-nemotron-3-ultra-550b-a55b": "nvidia/nemotron-3-ultra-550b-a55b",
  "nvidia-nemotron-3.5-super-vl": "nvidia/nemotron-3.5-super-vl",
  "nvidia-nemotron-3.5-lightning": "nvidia/nemotron-3.5-lightning",
};

export function upstreamModelId(model: string): string {
  return UPSTREAM_MODEL_MAP[model] ?? model;
}

function parseHeaderInt(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

export function extractRateLimitHeaders(headers: Headers, nowIso = new Date().toISOString()): RateLimitTelemetry {
  return {
    rpmLimit: parseHeaderInt(headers, "x-ratelimit-limit-requests"),
    rpmRemaining: parseHeaderInt(headers, "x-ratelimit-remaining-requests"),
    rpdLimit: parseHeaderInt(headers, "x-ratelimit-limit-requests-day"),
    rpdRemaining: parseHeaderInt(headers, "x-ratelimit-remaining-requests-day"),
    tpmLimit: parseHeaderInt(headers, "x-ratelimit-limit-tokens"),
    tpmRemaining: parseHeaderInt(headers, "x-ratelimit-remaining-tokens"),
    tpdLimit: parseHeaderInt(headers, "x-ratelimit-limit-tokens-day"),
    tpdRemaining: parseHeaderInt(headers, "x-ratelimit-remaining-tokens-day"),
    resetsAt: headers.get("x-ratelimit-reset-requests") ?? headers.get("retry-after") ?? null,
    observedAt: nowIso,
  };
}

/** Wraps `fetch` to enforce HTTPS origin allowlist, `redirect: "error"`, and optional header telemetry hook. */
function guardedCloudFetch(
  baseFetch: typeof fetch = fetch,
  onHeaders?: (headers: Headers, requestId: string | null) => void,
): typeof fetch {
  const bounded = boundedFetch(baseFetch);
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    assertSafeRouterEndpoint(rawUrl);
    const res = await bounded(input, { ...init, redirect: "error" });
    onHeaders?.(
      res.headers,
      res.headers.get("x-request-id") ?? res.headers.get("cf-ray") ?? res.headers.get("x-groq-id"),
    );
    return res;
  }) as typeof fetch;
}

/** GroqCloud adapter (`https://api.groq.com/openai/v1`). */
export function createGroqProvider(
  options: { fetch?: typeof fetch; maxRetries?: number; onRateLimits?: (telemetry: RateLimitTelemetry) => void } = {},
): ModelProvider {
  return {
    id: "groq",
    async stream(request, streamOptions): Promise<ModelResult> {
      const meta: { requestId: string | null } = { requestId: null };
      const http = guardedCloudFetch(options.fetch, (headers, reqId) => {
        meta.requestId = reqId;
        options.onRateLimits?.(extractRateLimitHeaders(headers));
      });
      const inner = createOpenRouterProvider({
        compatible: { id: "groq", baseURL: GROQ_BASE_URL },
        fetch: http,
        maxRetries: request.noTransportRetries ? 0 : (options.maxRetries ?? 1),
      });
      const upstream = upstreamModelId(request.model);
      const result = await inner.stream({ ...request, model: upstream }, streamOptions);
      return {
        ...result,
        model: request.model,
        usageVerified: true,
        ...(meta.requestId ? { providerRequestId: meta.requestId.slice(0, 128) } : {}),
      };
    },
  };
}

/**
 * Cloudflare Workers AI adapter (`https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/v1`).
 * - Requires a 32-hex Cloudflare Account ID in `workspaceId` or `organization`.
 * - Handles `@cf/openai/gpt-oss-*` via non-streaming `/responses` (Cloudflare GPT-OSS Responses nonstream rule).
 * - Uses streaming `/chat/completions` for other qualified Workers AI chat models.
 */
export function createCloudflareProvider(options: { fetch?: typeof fetch; maxRetries?: number } = {}): ModelProvider {
  return {
    id: "cloudflare",
    async stream(input, streamOptions): Promise<ModelResult> {
      const accountId = (streamOptions.workspaceId ?? streamOptions.organization ?? "").trim().toLowerCase();
      if (!/^[a-f0-9]{32}$/.test(accountId)) {
        throw new ProviderError(
          "Cloudflare Workers AI requires a valid 32-character account ID in workspaceId",
          false,
          400,
        );
      }
      const baseURL = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`;
      const meta: { requestId: string | null } = { requestId: null };
      const http = guardedCloudFetch(options.fetch, (_headers, reqId) => {
        meta.requestId = reqId;
      });
      const request = laidOut(input);
      const isGptOss = /^@cf\/openai\/gpt-oss-/i.test(request.model);

      if (!isGptOss) {
        const inner = createOpenRouterProvider({
          compatible: { id: "cloudflare", baseURL },
          fetch: http,
          maxRetries: request.noTransportRetries ? 0 : (options.maxRetries ?? 1),
        });
        const result = await inner.stream(request, streamOptions);
        return {
          ...result,
          model: request.model,
          usageVerified: true,
          ...(meta.requestId ? { providerRequestId: meta.requestId.slice(0, 128) } : {}),
        };
      }

      // Non-streaming `/responses` path for Cloudflare `@cf/openai/gpt-oss-*`
      const sys = systemText(request.system).trim();
      const inputItems: Record<string, unknown>[] = [];
      if (sys) inputItems.push({ role: "developer", content: sys });
      for (const m of withoutImages(request.messages, request.model)) {
        const blocks: ContentBlock[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
        if (m.role === "assistant") {
          const text = blocks.flatMap((b) => (b.type === "text" && b.text ? [b.text] : [])).join("\n\n");
          if (text) inputItems.push({ role: "assistant", content: text });
          for (const b of blocks) {
            if (b.type === "tool_use") {
              inputItems.push({
                type: "function_call",
                call_id: b.id,
                name: b.name,
                arguments: JSON.stringify(b.input),
              });
            }
          }
        } else {
          for (const b of blocks) {
            if (b.type === "tool_result") {
              inputItems.push({
                type: "function_call_output",
                call_id: b.toolUseId,
                output: b.isError ? `ERROR: ${b.content}` : b.content,
              });
            }
          }
          const text = blocks.flatMap((b) => (b.type === "text" && b.text ? [b.text] : [])).join("\n\n");
          if (text) inputItems.push({ role: "user", content: text });
        }
      }

      const payload: Record<string, unknown> = {
        model: request.model,
        input: inputItems,
        max_output_tokens: request.maxTokens,
        stream: false,
        ...(request.tools?.length
          ? {
              tools: stableToolsFirst(request.tools).map((t) => ({
                type: "function",
                name: t.name,
                description: t.description,
                parameters: t.inputSchema,
              })),
            }
          : {}),
        ...(request.outputSchema
          ? {
              text: {
                format: {
                  type: "json_schema",
                  name: "output",
                  strict: true,
                  schema: request.outputSchema,
                },
              },
            }
          : {}),
      };

      let res: Response;
      try {
        res = await http(`${baseURL}/responses`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${streamOptions.apiKey}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(payload),
          signal: request.signal,
        });
      } catch (err) {
        if (request.signal?.aborted) throw new ProviderError("request aborted", false);
        throw new ProviderError(`could not reach provider: ${(err as Error).message}`, true);
      }

      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok) {
        const errMsg =
          (body?.error &&
          typeof body.error === "object" &&
          typeof (body.error as { message?: unknown }).message === "string"
            ? (body.error as { message: string }).message
            : Array.isArray(body?.errors) && typeof (body.errors[0] as { message?: unknown })?.message === "string"
              ? (body.errors[0] as { message: string }).message
              : "") || "";
        if (res.status === 401) throw new ProviderError("invalid provider API key", false, 401, undefined, errMsg);
        if (res.status === 402)
          throw new ProviderError("no prepaid credit left at the provider", false, 402, undefined, errMsg);
        if (res.status === 403) throw deniedError(null, errMsg);
        if (res.status === 429) throw new ProviderError("rate limited by provider", true, 429, undefined, errMsg);
        if (res.status >= 500) throw new ProviderError("provider error", true, res.status, undefined, errMsg);
        throw new ProviderError(
          `provider rejected the request (${res.status}): ${errMsg.slice(0, 200)}`,
          false,
          res.status,
          undefined,
          errMsg,
        );
      }

      const rawData =
        body?.result && typeof body.result === "object" && !Array.isArray(body.result)
          ? (body.result as Record<string, unknown>)
          : (body ?? {});
      const outputArr = Array.isArray(rawData.output) ? (rawData.output as Record<string, unknown>[]) : [];
      const content: ContentBlock[] = [];
      let text = "";

      for (const item of outputArr) {
        if (item.type === "message" && Array.isArray(item.content)) {
          for (const part of item.content as Record<string, unknown>[]) {
            if ((part.type === "output_text" || part.type === "text") && typeof part.text === "string" && part.text) {
              text += part.text;
            }
          }
        } else if (item.type === "function_call" && typeof item.name === "string") {
          let parsedArgs: Record<string, unknown> = {};
          try {
            parsedArgs =
              typeof item.arguments === "string" && item.arguments.trim()
                ? (JSON.parse(item.arguments) as Record<string, unknown>)
                : {};
          } catch (e) {
            throw new ProviderError(`could not read the model's reply: ${(e as Error).message}`, true);
          }
          content.push({
            type: "tool_use",
            id: typeof item.call_id === "string" && item.call_id ? item.call_id : `call_${content.length}`,
            name: item.name,
            input: parsedArgs,
          });
        }
      }
      if (!text && typeof rawData.output_text === "string" && rawData.output_text) {
        text = rawData.output_text;
      }
      if (text) {
        content.unshift({ type: "text", text });
        streamOptions.onDelta(text);
      }

      const rawUsage =
        rawData.usage && typeof rawData.usage === "object" ? (rawData.usage as Record<string, unknown>) : null;
      const inTokens =
        typeof rawUsage?.input_tokens === "number"
          ? rawUsage.input_tokens
          : typeof rawUsage?.prompt_tokens === "number"
            ? rawUsage.prompt_tokens
            : null;
      const outTokens =
        typeof rawUsage?.output_tokens === "number"
          ? rawUsage.output_tokens
          : typeof rawUsage?.completion_tokens === "number"
            ? rawUsage.completion_tokens
            : null;
      const usageVerified = inTokens !== null && outTokens !== null && inTokens >= 0 && outTokens >= 0;

      const stopReason: StopReason = content.some((b) => b.type === "tool_use")
        ? "tool_use"
        : rawData.status === "incomplete"
          ? "max_tokens"
          : "end_turn";

      return {
        text,
        content,
        model: typeof rawData.model === "string" && rawData.model ? rawData.model : request.model,
        stopReason,
        usage: {
          inputTokens: inTokens ?? estimateTokens(promptChars(request)),
          outputTokens: outTokens ?? estimateTokens(text.length),
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        ...(usageVerified ? { usageVerified: true as const } : {}),
        ...(meta.requestId ? { providerRequestId: meta.requestId.slice(0, 128) } : {}),
        ...(typeof rawData.id === "string" ? { providerResponseId: rawData.id.slice(0, 128) } : {}),
        ...(hasToolImages(request.messages) ? { imagesLeftOut: true as const } : {}),
      };
    },
  };
}

/** Models on OpenCode Go that speak Anthropic Messages rather than OpenAI Chat Completions. */
const OPENCODE_ANTHROPIC_MODELS = new Set(["claude-haiku-5-5", "minimax-m3"]);

/**
 * OpenCode Go & Console official external client adapter.
 * - Uses documented `agentes.chat/<version>` User-Agent and `x-opencode-session` header (never spoofs OpenCode CLI).
 * - Blocks `native_opencode_cli_only` free models (`opencode/*-free`, `hy4-flash-free`, etc.) before external HTTP call,
 *   and respects HTTP 403 without bypass if upstream rejects a free-tier model.
 * - Sends `x-opencode-extra-usage: false` so Extra Usage credits are never consumed.
 */
export function createOpenCodeProvider(
  options: { fetch?: typeof fetch; maxRetries?: number; version?: string } = {},
): ModelProvider {
  const version = options.version ?? "dev";
  return {
    id: "opencode",
    async stream(request, streamOptions): Promise<ModelResult> {
      const cleanModel = request.model.replace(/^opencode:(?:go|zen):/, "");
      if (isOpencodeNativeOnlyFreeId(cleanModel)) {
        throw deniedError(
          "native_opencode_only",
          "OpenCode free-tier chat models require the native OpenCode harness and cannot be called from external HTTP clients",
        );
      }
      if (/qwen|ollama/i.test(cleanModel)) {
        throw deniedError("model_denied", "Qwen and Ollama models are disabled by workspace routing policy");
      }

      const meta: { requestId: string | null } = { requestId: null };
      const guarded = guardedCloudFetch(options.fetch, (_headers, reqId) => {
        meta.requestId = reqId;
      });
      const session = streamOptions.session ?? crypto.randomUUID();
      const http = withHeaders(guarded, {
        "user-agent": `agentes.chat/${version}`,
        "x-opencode-session": session,
        "x-opencode-extra-usage": "false",
      });

      const useAnthropic = OPENCODE_ANTHROPIC_MODELS.has(cleanModel);
      const inner = useAnthropic
        ? createAnthropicProvider({
            id: "opencode",
            baseURL: OPENCODE_GO_ANTHROPIC_URL,
            compat: { toolChoiceAny: false, images: /claude/i.test(cleanModel) },
            fetch: http,
            maxRetries: request.noTransportRetries ? 0 : (options.maxRetries ?? 1),
          })
        : createOpenRouterProvider({
            compatible: { id: "opencode", baseURL: OPENCODE_GO_OPENAI_URL },
            fetch: http,
            maxRetries: request.noTransportRetries ? 0 : (options.maxRetries ?? 1),
          });

      const result = await inner.stream({ ...request, model: cleanModel }, streamOptions);
      return {
        ...result,
        model: request.model,
        usageVerified: true,
        ...(meta.requestId ? { providerRequestId: meta.requestId.slice(0, 128) } : {}),
      };
    },
  };
}

/** Direct OpenAI-compatible cloud provider (`tencent`, `xiaomi`, `nvidia`). */
export function createOpenAICompatibleDirectProvider(options: {
  id: string;
  baseURL: string;
  fetch?: typeof fetch;
  maxRetries?: number;
}): ModelProvider {
  assertSafeRouterEndpoint(options.baseURL);
  return {
    id: options.id,
    async stream(request, streamOptions): Promise<ModelResult> {
      const meta: { requestId: string | null } = { requestId: null };
      const http = guardedCloudFetch(options.fetch, (_headers, reqId) => {
        meta.requestId = reqId;
      });
      const inner = createOpenRouterProvider({
        compatible: { id: options.id, baseURL: options.baseURL },
        fetch: http,
        maxRetries: request.noTransportRetries ? 0 : (options.maxRetries ?? 1),
      });
      const upstream = upstreamModelId(request.model);
      const result = await inner.stream({ ...request, model: upstream }, streamOptions);
      return {
        ...result,
        model: request.model,
        usageVerified: true,
        ...(meta.requestId ? { providerRequestId: meta.requestId.slice(0, 128) } : {}),
      };
    },
  };
}
