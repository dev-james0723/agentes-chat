import { describe, expect, test } from "bun:test";
import {
  autoRouterKeyWithinCap,
  autoRouterParameters,
  createOpenRouterProvider,
  isOpenRouterAutoModel,
  type ModelRequest,
  type OpenRouterAutoPolicy,
} from "../src";

const policy: OpenRouterAutoPolicy = {
  allowedModels: ["openai/gpt-6-luna", "anthropic/claude-sonnet-5.5"],
  costTier: "medium",
  monthlyCapUsd: 20,
  maxPromptUsdPerMillion: 4,
  maxCompletionUsdPerMillion: 20,
};
const key = {
  is_management_key: false,
  is_provisioning_key: false,
  include_byok_in_limit: true,
  limit_reset: "monthly",
  limit: 20,
  limit_remaining: 18,
  expires_at: null,
};
const keyReply = (patch: Record<string, unknown> = {}) => Response.json({ data: { ...key, ...patch } });
const make = (model: string, extra: Partial<ModelRequest> = {}): ModelRequest => ({
  model,
  system: "s",
  messages: [{ role: "user", content: "fix the tests" }],
  maxTokens: 64,
  ...extra,
});

describe("OpenRouter dynamic router transport", () => {
  test("only the official stable router IDs are recognized", () => {
    expect(isOpenRouterAutoModel("openrouter/auto")).toBe(true);
    expect(isOpenRouterAutoModel("openrouter/auto-code")).toBe(true);
    expect(isOpenRouterAutoModel("openrouter/auto-beta")).toBe(false);
    expect(isOpenRouterAutoModel("openai/gpt-6-luna")).toBe(false);
  });

  test("rejects missing policy, wildcard, alias, excluded models, and invalid price ceilings", () => {
    for (const invalid of [
      undefined,
      { ...policy, allowedModels: [] },
      { ...policy, allowedModels: ["openai/*"] },
      { ...policy, allowedModels: ["~openai/gpt-luna-latest"] },
      { ...policy, allowedModels: ["qwen/qwen3.7-flash"] },
      { ...policy, allowedModels: ["ollama/local"] },
      { ...policy, allowedModels: ["openrouter/auto"] },
      { ...policy, allowedModels: ["openai/gpt-6-luna", "openai/gpt-6-luna"] },
      { ...policy, monthlyCapUsd: 0 },
      { ...policy, monthlyCapUsd: Infinity },
      { ...policy, allowedModels: ["alibaba/qwen-3"] },
      { ...policy, maxPromptUsdPerMillion: Infinity },
      { ...policy, maxCompletionUsdPerMillion: 0 },
    ])
      expect(() => autoRouterParameters(invalid)).toThrow();
  });

  test("no bounded policy means zero dispatches for both router IDs", async () => {
    let requests = 0;
    const fetcher = (async () => {
      requests++;
      throw new Error("must not dispatch");
    }) as unknown as typeof fetch;
    const provider = createOpenRouterProvider({ fetch: fetcher });
    for (const model of ["openrouter/auto", "openrouter/auto-code"]) {
      await expect(provider.stream(make(model), { apiKey: "fake-key", onDelta: () => {} })).rejects.toThrow(
        "bounded routing policy",
      );
    }
    expect(requests).toBe(0);
  });

  test("sends approved router policy and records the concrete model and actual charge", async () => {
    const requests: Record<string, unknown>[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      if (String(url).endsWith("/key")) return keyReply();
      requests.push(JSON.parse(String(init.body)));
      const chunk = {
        id: "gen-test",
        object: "chat.completion.chunk",
        created: 1,
        model: "openai/gpt-6-luna",
        choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16, cost: 0.0001 },
      };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;
    const provider = createOpenRouterProvider({ fetch: fetcher });
    for (const model of ["openrouter/auto", "openrouter/auto-code"]) {
      const result = await provider.stream(make(model, { openRouterAuto: policy, effort: "high" }), {
        apiKey: "fake-key",
        onDelta: () => {},
      });
      expect(result.model).toBe("openai/gpt-6-luna");
      expect(result.costNanoUsd).toBe(100_000);
      expect(result.text).toBe("done");
    }
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      model: "openrouter/auto-code",
      plugins: [{ id: "auto-router", allowed_models: policy.allowedModels, cost_tier: "medium" }],
      provider: {
        require_parameters: true,
        data_collection: "deny",
        zdr: true,
        max_price: { prompt: 4, completion: 20 },
      },
    });
    expect(requests[1]?.reasoning).toBeUndefined();
  });

  test("requires a dedicated capped monthly key including BYOK and rejects expired or exhausted limits", () => {
    expect(autoRouterKeyWithinCap({ data: key }, 20)).toBe(true);
    for (const patch of [
      { limit: null },
      { limit: 21 },
      { limit_reset: "daily" },
      { limit_remaining: 0 },
      { limit_remaining: 21 },
      { include_byok_in_limit: false },
      { is_management_key: true },
      { disabled: true },
      { is_provisioning_key: true },
      { expires_at: "2020-01-01T00:00:00Z" },
      { expires_at: "invalid" },
    ])
      expect(autoRouterKeyWithinCap({ data: { ...key, ...patch } }, 20)).toBe(false);
  });

  test("key limit rejection sends no paid completion request", async () => {
    let keyChecks = 0;
    let completions = 0;
    const fetcher = (async (url: string) => {
      if (String(url).endsWith("/key")) {
        keyChecks++;
        return keyReply({ limit: null });
      }
      completions++;
      throw new Error("must not dispatch");
    }) as unknown as typeof fetch;
    await expect(
      createOpenRouterProvider({ fetch: fetcher }).stream(make("openrouter/auto-code", { openRouterAuto: policy }), {
        apiKey: "fake-key",
        onDelta: () => {},
      }),
    ).rejects.toThrow("monthly limit");
    expect(keyChecks).toBe(1);
    expect(completions).toBe(0);
  });

  test("unrecognized routers cannot dispatch; admitted auto requests never retry a failed transport", async () => {
    let keyChecks = 0;
    let completions = 0;
    const fetcher = (async (url: string) => {
      if (String(url).endsWith("/key")) {
        keyChecks++;
        return keyReply();
      }
      completions++;
      return Response.json({ error: { message: "synthetic unavailable", code: 503 } }, { status: 503 });
    }) as unknown as typeof fetch;
    const provider = createOpenRouterProvider({ fetch: fetcher, maxRetries: 3 });
    const options = { apiKey: "fake-key", onDelta: () => {} };
    await expect(provider.stream(make("openrouter/auto-beta"), options)).rejects.toThrow(
      "Unsupported OpenRouter router alias",
    );
    expect(keyChecks).toBe(0);
    expect(completions).toBe(0);
    await expect(provider.stream(make("openrouter/auto-code", { openRouterAuto: policy }), options)).rejects.toThrow();
    expect(keyChecks).toBe(1);
    expect(completions).toBe(1);
  });

  test("a router policy cannot be sent to a compatible third-party endpoint or another model", async () => {
    let requests = 0;
    const fetcher = (async () => {
      requests++;
      throw new Error("must not dispatch");
    }) as unknown as typeof fetch;
    const opt = { apiKey: "fake-key", onDelta: () => {} };
    await expect(
      createOpenRouterProvider({
        fetch: fetcher,
        compatible: { id: "custom", baseURL: "https://example.test/v1" },
      }).stream(make("openrouter/auto-code", { openRouterAuto: policy }), opt),
    ).rejects.toThrow("official OpenRouter endpoint");
    await expect(
      createOpenRouterProvider({ fetch: fetcher }).stream(make("openai/gpt-6-luna", { openRouterAuto: policy }), opt),
    ).rejects.toThrow("official router model");
    expect(requests).toBe(0);
  });
});
