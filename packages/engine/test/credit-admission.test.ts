import { afterEach, describe, expect, test } from "bun:test";
import {
  createAnthropicProvider,
  createOpenAIProvider,
  MODEL_CATALOG,
  type ModelInfo,
  type ModelRequest,
  maxCostNanoUsd,
} from "@agenteschat/providers";
import { creditAdmissionBound, creditWorkForecast } from "../src/credit-admission";
import { CreditRouteRefusal } from "../src/credit-route";

const request = (model = "gpt-6.1-sol"): ModelRequest => ({
  model,
  system: "Keep the same task and receipts.",
  messages: [{ role: "user", content: "Next safe step." }],
  maxTokens: 100,
});
const MODEL = "credit-admission-test-only";
afterEach(() => {
  delete MODEL_CATALOG[MODEL];
});
function priced(over: Partial<ModelInfo> = {}): ModelRequest {
  MODEL_CATALOG[MODEL] = {
    provider: "openai",
    label: "Test bound",
    prices: { input: 100, output: 200, cacheRead: 10, cacheWrite: 125 },
    serverSideFallback: false,
    contextWindow: 1000,
    maxOutputTokens: 500,
    ...over,
  };
  return request(MODEL);
}
const refused = (r: ModelRequest) => expect(() => creditAdmissionBound("openai", r)).toThrow(CreditRouteRefusal);

describe("credit admission hard bounds", () => {
  test("reserves the whole explicit context, never chars/3", () => {
    const r = request();
    const b = creditAdmissionBound("openai", r);
    expect(b.promptTokens).toBe(MODEL_CATALOG[r.model]?.contextWindow ?? 0);
    expect(b.amountNanoUsd).toBe(maxCostNanoUsd(r.model, b.promptTokens, r.maxTokens));
    expect(b.maxTokens).toBe(100);
    expect(b.promptBytes).toBeGreaterThan(0);
  });
  test("includes every tool schema, result and UTF-8 note in prompt bytes", () => {
    const r = request();
    const before = creditAdmissionBound("openai", r);
    r.tools = [
      {
        name: "read_file",
        description: "檔案",
        inputSchema: { type: "object", properties: { path: { type: "string", description: "🧪".repeat(30) } } },
        stable: true,
      },
    ];
    r.messages.push({
      role: "assistant",
      content: [{ type: "tool_use", id: "a", name: "read_file", input: { path: "/p" } }],
    });
    r.messages.push({ role: "user", content: [{ type: "tool_result", toolUseId: "a", content: "回覆" }] });
    r.notes = { at: 2, text: "繼續" };
    const bound = creditAdmissionBound("openai", r);
    const body = {
      model: r.model,
      system: r.system,
      messages: r.messages,
      tools: r.tools,
      notes: r.notes,
      effort: r.effort,
      cacheTtl: r.cacheTtl,
    };
    expect(bound.promptBytes).toBe(new TextEncoder().encode(JSON.stringify(body)).length);
    expect(bound.promptBytes).toBeGreaterThan(JSON.stringify(body).length);
    expect(bound.promptBytes).toBeGreaterThan(before.promptBytes);
    expect(bound.amountNanoUsd).toBe(before.amountNanoUsd); // Full context already includes all framing.
  });
  test("one-hour cache reserves the highest write rate and long-context tier", () => {
    const r = request("claude-sonnet-5-5");
    const normal = creditAdmissionBound("anthropic", r);
    r.cacheTtl = "1h";
    const long = creditAdmissionBound("anthropic", r);
    expect(long.amountNanoUsd).toBeGreaterThan(normal.amountNanoUsd);
    expect(long.amountNanoUsd).toBe(maxCostNanoUsd(r.model, long.promptTokens, r.maxTokens, true));
    const openai = creditAdmissionBound("openai", request());
    expect(openai.amountNanoUsd).toBeGreaterThan(
      openai.promptTokens * (MODEL_CATALOG["gpt-6.1-sol"]?.prices.cacheWrite ?? 0),
    );
  });
  test("rejects another provider, custom endpoint and unknown or normalized alias", () => {
    refused(request("claude-sonnet-5-5"));
    refused(request("gpt-6.1-sol-20261120"));
    refused(request("not-a-model"));
    refused(priced({ endpoint: "custom-host" }));
    expect(() => creditAdmissionBound("openrouter" as "openai", request())).toThrow(CreditRouteRefusal);
  });
  test("rejects opaque state, images, PDF, audio, server tools and structured output", () => {
    const blocks = [
      { type: "opaque", provider: "openai", data: { response_id: "opaque-state" } },
      { type: "image", data: "image" },
      { type: "audio", data: "audio" },
      { type: "tool_result", toolUseId: "x", content: "p", images: [{ mediaType: "application/pdf", data: "p" }] },
    ];
    for (const block of blocks)
      refused({ ...request(), messages: [{ role: "user", content: [block] }] } as ModelRequest);
    refused({ ...request(), tools: [{ type: "web_search_preview" }] } as unknown as ModelRequest);
    refused({
      ...request(),
      tools: [{ name: "x", description: "x", inputSchema: {}, type: "computer_use" }],
    } as unknown as ModelRequest);
    refused({ ...request(), outputSchema: { type: "object" } });
    refused({ ...request(), previous_response_id: "foreign-session" } as ModelRequest);
  });
  test("rejects unbounded, zero, fractional and above-model output requests", () => {
    for (const maxTokens of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER]) refused({ ...request(), maxTokens });
    const r = priced();
    r.maxTokens = 501;
    refused(r);
  });
  test("rejects unpriced, missing-context, malformed prices and arithmetic overflow", () => {
    refused(priced({ unpriced: true }));
    refused(priced({ contextWindow: undefined }));
    refused(priced({ prices: { input: 0, output: 200, cacheRead: 10, cacheWrite: 125 } }));
    refused(priced({ prices: { input: 100, output: NaN, cacheRead: 10, cacheWrite: 125 } }));
    refused(priced({ contextWindow: Number.MAX_SAFE_INTEGER }));
  });
  test("uses highest listed, introductory, long-context and cache-read prices", () => {
    const r = priced({
      prices: { input: 100, output: 200, cacheRead: 300, cacheWrite: 125 },
      longContext: { aboveInputTokens: 100, prices: { input: 50, output: 150, cacheRead: 10, cacheWrite: 60 } },
      intro: { until: "2099-01-01", prices: { input: 100, output: 250, cacheRead: 10, cacheWrite: 125 } },
    });
    expect(creditAdmissionBound("openai", r).amountNanoUsd).toBe(1000 * 300 + 100 * 250);
  });
  test("rejects cyclic or non-JSON tool data and oversized text", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    refused({ ...request(), tools: [{ name: "x", description: "x", inputSchema: cycle }] });
    refused({ ...request(), tools: [{ name: "x", description: "x", inputSchema: { hidden: () => 1 } }] });
    refused({ ...request(), system: "x".repeat(16_000_001) });
  });
  test("does not mutate the request or turn a cost ceiling into measured tokens", () => {
    const r = request();
    const before = JSON.stringify(r);
    Object.freeze(r);
    const bound = creditAdmissionBound("openai", r);
    expect(JSON.stringify(r)).toBe(before);
    expect(bound.promptTokens).toBeGreaterThan(bound.promptBytes);
  });
});

describe("bounded empirical work-unit forecast", () => {
  const now = 1_000_000_000;
  const defaults = { now, remainingNanoUsd: 500, nextUnitBoundNanoUsd: 400 };
  test("unknown samples stay unknown; only the hard bound proves room to checkpoint", () => {
    expect(creditWorkForecast({ ...defaults, samples: [] })).toEqual({
      sampleCount: 0,
      meanNanoUsd: null,
      p95NanoUsd: null,
      uncertainty: "unknown",
      estimatedUnitsAtP95: null,
      enoughToCheckpoint: true,
      admissionBasis: "hard_next_unit_bound",
    });
    expect(creditWorkForecast({ ...defaults, samples: [], nextUnitBoundNanoUsd: null }).enoughToCheckpoint).toBe(false);
  });
  test("computes nearest-rank p95 and mean from completed units, never from capacity guesses", () => {
    const samples = Array.from({ length: 20 }, (_, i) => ({
      actualNanoUsd: i + 1,
      settledAt: now - i,
      workUnitId: String(i),
    }));
    expect(creditWorkForecast({ ...defaults, samples })).toMatchObject({
      sampleCount: 20,
      meanNanoUsd: 11,
      p95NanoUsd: 19,
      uncertainty: "medium",
      estimatedUnitsAtP95: 26,
    });
  });
  test("excludes stale, future and invalid usage; deduplicates units and limits newest samples", () => {
    const samples = [
      { actualNanoUsd: 50, settledAt: now, workUnitId: "unit" },
      { actualNanoUsd: 500, settledAt: now - 1, workUnitId: "unit" },
      { actualNanoUsd: 70, settledAt: now - 2 },
      { actualNanoUsd: 10_000, settledAt: now - 101 },
      { actualNanoUsd: 10_000, settledAt: now + 1 },
      { actualNanoUsd: -1, settledAt: now },
      { actualNanoUsd: NaN, settledAt: now },
    ];
    expect(creditWorkForecast({ ...defaults, samples, maxAgeMs: 100, limit: 2 })).toMatchObject({
      sampleCount: 2,
      meanNanoUsd: 60,
      p95NanoUsd: 70,
      uncertainty: "high",
    });
  });
  test("cheap history cannot authorize an unbounded or unaffordable next work unit", () => {
    const samples = [{ actualNanoUsd: 1, settledAt: now }];
    expect(creditWorkForecast({ ...defaults, samples, nextUnitBoundNanoUsd: 501 }).enoughToCheckpoint).toBe(false);
    expect(creditWorkForecast({ ...defaults, samples, remainingNanoUsd: NaN }).enoughToCheckpoint).toBe(false);
    expect(creditWorkForecast({ ...defaults, samples, nextUnitBoundNanoUsd: 0 }).enoughToCheckpoint).toBe(false);
  });
  test("free samples do not imply unlimited work; invalid clock or overflowing sums give unknown", () => {
    expect(
      creditWorkForecast({ ...defaults, samples: [{ actualNanoUsd: 0, settledAt: now }] }).estimatedUnitsAtP95,
    ).toBeNull();
    expect(creditWorkForecast({ ...defaults, samples: [], now: NaN }).uncertainty).toBe("unknown");
    const samples = [1, 2].map((i) => ({ actualNanoUsd: Number.MAX_SAFE_INTEGER, settledAt: now - i }));
    expect(creditWorkForecast({ ...defaults, samples }).uncertainty).toBe("unknown");
  });
});

describe("bounded stateless reasoning replay", () => {
  const claudeThinking = { type: "thinking", thinking: "", signature: "fixture-signature" };
  const openaiThinking = {
    type: "reasoning",
    id: "rs_fixture",
    summary: [],
    encrypted_content: "fixture-encrypted-content",
    status: "completed",
  };
  function replay(provider: "openai" | "anthropic", data: Record<string, unknown>, role = "assistant"): ModelRequest {
    return {
      ...request(provider === "openai" ? "gpt-6.1-sol" : "claude-sonnet-5-5"),
      messages: [
        { role: "user", content: "Continue the same request." },
        { role, content: [{ type: "opaque", provider, data }] },
      ],
    } as ModelRequest;
  }
  test("keeps signed Claude and encrypted OpenAI reasoning unchanged within the whole-context bound", () => {
    for (const [provider, data] of [
      ["anthropic", claudeThinking],
      ["anthropic", { type: "redacted_thinking", data: "fixture-redacted-content" }],
      ["openai", openaiThinking],
    ] as const) {
      const r = replay(provider, data);
      const before = JSON.stringify(r);
      const b = creditAdmissionBound(provider, r);
      expect(b.promptBytes).toBeGreaterThan(JSON.stringify(data).length);
      expect(b.amountNanoUsd).toBe(creditAdmissionBound(provider, request(r.model)).amountNanoUsd);
      expect(JSON.stringify(r)).toBe(before);
    }
  });
  test("rejects foreign state, partial reasoning, arbitrary server items and extra reference fields", () => {
    const bad = [
      { ...openaiThinking, encrypted_content: null },
      { ...openaiThinking, status: "in_progress" },
      { ...openaiThinking, previous_response_id: "resp_foreign" },
      { type: "item_reference", id: "rs_remote" },
      { type: "web_search_call", id: "ws_foreign", status: "completed" },
      { ...openaiThinking, content: [{ type: "input_image", image_url: "https://other.test/image" }] },
      { ...openaiThinking, summary: [{ type: "summary_text", text: "x", tool: "web_search" }] },
    ];
    for (const data of bad)
      expect(() => creditAdmissionBound("openai", replay("openai", data))).toThrow(CreditRouteRefusal);
    expect(() => creditAdmissionBound("openai", replay("openai", openaiThinking, "user"))).toThrow(CreditRouteRefusal);
    expect(() => creditAdmissionBound("anthropic", replay("anthropic", openaiThinking))).toThrow(CreditRouteRefusal);
    expect(() => creditAdmissionBound("anthropic", replay("anthropic", { ...claudeThinking, signature: "" }))).toThrow(
      CreditRouteRefusal,
    );
    const foreign = replay("anthropic", claudeThinking);
    foreign.messages[1] = {
      role: "assistant",
      content: [{ type: "opaque", provider: "openai", data: openaiThinking }],
    };
    expect(() => creditAdmissionBound("anthropic", foreign)).toThrow(CreditRouteRefusal);
    const oversized = replay("anthropic", { ...claudeThinking, signature: "x".repeat(16_000_001) });
    expect(() => creditAdmissionBound("anthropic", oversized)).toThrow(CreditRouteRefusal);
  });

  const sse = (events: Record<string, unknown>[]) =>
    events
      .map(
        (event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`,
      )
      .join("");
  function claudeResponse(model: string, first: boolean) {
    const blocks = first
      ? [claudeThinking, { type: "tool_use", id: "toolu_fixture", name: "read_file", input: { path: "/fixture" } }]
      : [{ type: "text", text: "Checkpoint verified." }];
    return sse([
      {
        type: "message_start",
        message: {
          id: "msg_fixture",
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 10,
            output_tokens: 1,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            service_tier: "standard",
            speed: "standard",
          },
        },
      },
      ...blocks.flatMap((block, index) => [
        { type: "content_block_start", index, content_block: block },
        { type: "content_block_stop", index },
      ]),
      {
        type: "message_delta",
        delta: { stop_reason: first ? "tool_use" : "end_turn", stop_sequence: null },
        usage: { output_tokens: 4 },
      },
      { type: "message_stop" },
    ]);
  }
  function openaiResponse(model: string, first: boolean) {
    const output = first
      ? [
          openaiThinking,
          {
            type: "function_call",
            id: "fc_fixture",
            call_id: "toolu_fixture",
            name: "read_file",
            arguments: '{"path":"/fixture"}',
            status: "completed",
          },
        ]
      : [
          {
            type: "message",
            id: "m_fixture",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "Checkpoint verified.", annotations: [] }],
          },
        ];
    const response = {
      id: "resp_fixture",
      object: "response",
      service_tier: "default",
      created_at: 1,
      model,
      output: [],
      status: "in_progress",
      error: null,
    };
    return sse([
      { type: "response.created", response },
      {
        type: "response.completed",
        response: {
          ...response,
          output,
          status: "completed",
          usage: {
            input_tokens: 10,
            output_tokens: 4,
            total_tokens: 14,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 1 },
          },
        },
      },
    ]);
  }
  for (const provider of ["openai", "anthropic"] as const) {
    test(`${provider} completes a two-turn thinking/tool roundtrip with two explicit bounds and no hidden request`, async () => {
      const requests: Record<string, unknown>[] = [];
      const model = provider === "openai" ? "gpt-6.1-sol" : "claude-sonnet-5-5";
      const fetcher = (async (_url: unknown, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body ?? "{}")));
        const reply =
          provider === "openai"
            ? openaiResponse(model, requests.length === 1)
            : claudeResponse(model, requests.length === 1);
        return new Response(reply, {
          headers: { "content-type": "text/event-stream", "request-id": "req_fixture", "x-request-id": "req_fixture" },
        });
      }) as unknown as typeof fetch;
      const adapter =
        provider === "openai" ? createOpenAIProvider({ fetch: fetcher }) : createAnthropicProvider({ fetch: fetcher });
      const r = request(model);
      r.noTransportRetries = true;
      r.tools = [{ name: "read_file", description: "Read a fixture", inputSchema: { type: "object" } }];
      const firstBound = creditAdmissionBound(provider, r);
      const first = await adapter.stream(r, { apiKey: "sk-synthetic-test-only", onDelta: () => {} });
      expect(first.usageVerified).toBe(true);
      expect(first.stopReason).toBe("tool_use");
      expect(first.content[0]).toEqual({
        type: "opaque",
        provider,
        data: provider === "openai" ? openaiThinking : claudeThinking,
      });
      r.messages.push({ role: "assistant", content: first.content });
      r.messages.push({
        role: "user",
        content: [{ type: "tool_result", toolUseId: "toolu_fixture", content: "Fixture read receipt." }],
      });
      const checkpoint = JSON.stringify(r.messages);
      const secondBound = creditAdmissionBound(provider, r);
      const second = await adapter.stream(r, { apiKey: "sk-synthetic-test-only", onDelta: () => {} });
      expect(second.usageVerified).toBe(true);
      expect(second.stopReason).toBe("end_turn");
      expect(second.text).toBe("Checkpoint verified.");
      expect(requests).toHaveLength(2);
      expect(secondBound.amountNanoUsd).toBe(firstBound.amountNanoUsd);
      expect(secondBound.promptBytes).toBeGreaterThan(firstBound.promptBytes);
      expect(JSON.stringify(r.messages)).toBe(checkpoint);
      if (provider === "openai") {
        expect(requests[1]?.input).toContainEqual(openaiThinking);
        expect(requests[1]?.store).toBe(false);
        expect(requests[1]?.previous_response_id).toBeUndefined();
      } else {
        const messages = requests[1]?.messages as { content: Record<string, unknown>[] }[];
        expect(messages[1]?.content[0]).toEqual(claudeThinking);
        expect(messages[1]?.content[1]).toMatchObject({ type: "tool_use", id: "toolu_fixture" });
      }
    });
  }
});
