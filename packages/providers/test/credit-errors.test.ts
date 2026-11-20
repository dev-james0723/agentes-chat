import { describe, expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import {
  annotateProviderFailure,
  createAnthropicProvider,
  createOpenAIProvider,
  openAIError,
  ProviderError,
  providerFailureFacts,
  providerRetryAfterMs,
  toProviderError,
} from "../src";

const OPENAI_BILLING = [
  ["credit_balance_exhausted", "exhausted"],
  ["insufficient_quota", "exhausted"],
  ["organization_spend_limit_exceeded", "billing_blocked"],
  ["project_spend_limit_exceeded", "billing_blocked"],
  ["organization_usage_limit_exceeded", "billing_blocked"],
] as const;
function transport(status: number, body: unknown, headers: Record<string, string> = {}) {
  const requests: Record<string, unknown>[] = [];
  const fetcher = (async (_url: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  }) as typeof fetch;
  return { fetcher, requests };
}
const request = (model: string, noTransportRetries = false) => ({
  model,
  system: "fixture",
  messages: [{ role: "user" as const, content: "fixture" }],
  maxTokens: 16,
  ...(noTransportRetries ? { noTransportRetries: true as const } : {}),
});
const credentials = { apiKey: "synthetic-test-key", onDelta: () => {} };
async function rejected(call: Promise<unknown>): Promise<ProviderError> {
  try {
    await call;
    throw new Error("unexpected fixture success");
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderError);
    return error as ProviderError;
  }
}

describe("credit-aware provider refusals", () => {
  for (const [code, billing] of OPENAI_BILLING) {
    test(`OpenAI ${code} is not retried below the ledger`, async () => {
      const { fetcher, requests } = transport(429, {
        error: { code, type: "insufficient_quota", message: "Refused." },
      });
      const error = await rejected(
        createOpenAIProvider({ fetch: fetcher, maxRetries: 3 }).stream(request("gpt-6-sol"), credentials),
      );
      expect(requests).toHaveLength(1);
      expect(error.retryable).toBe(false);
      expect(providerFailureFacts(error)).toMatchObject({ code, billing, httpRefusal: true });
    });
  }
  test("OpenAI broad insufficient_quota type without a code is billing, never throttling", async () => {
    const { fetcher, requests } = transport(429, { error: { type: "insufficient_quota", message: "Refused." } });
    const error = await rejected(
      createOpenAIProvider({ fetch: fetcher, maxRetries: 3 }).stream(request("gpt-6-sol"), credentials),
    );
    expect(requests).toHaveLength(1);
    expect(error.retryable).toBe(false);
    expect(providerFailureFacts(error)?.billing).toBe("billing_blocked");
  });
  test("Claude tier spend cap wins over rate_limit_error and Retry-After", async () => {
    const { fetcher, requests } = transport(
      429,
      {
        type: "error",
        error: {
          type: "rate_limit_error",
          message: "Tier cap.",
          details: { error_code: "enforced_spend_limit_reached" },
        },
      },
      { "retry-after": "1" },
    );
    const error = await rejected(
      createAnthropicProvider({ fetch: fetcher, maxRetries: 3 }).stream(request("claude-sonnet-5-5"), credentials),
    );
    expect(requests).toHaveLength(1);
    expect(error.retryable).toBe(false);
    expect(providerFailureFacts(error)).toMatchObject({
      code: "enforced_spend_limit_reached",
      billing: "billing_blocked",
      httpRefusal: true,
      retryAfterMs: 1000,
    });
  });
  for (const message of [
    "You have reached your specified API usage limits.",
    "You have reached your specified workspace API usage limits.",
  ])
    test(`Claude configured spending cap is not a generic 400: ${message}`, async () => {
      const { fetcher } = transport(400, { type: "error", error: { type: "invalid_request_error", message } });
      const error = await rejected(
        createAnthropicProvider({ fetch: fetcher }).stream(request("claude-sonnet-5-5"), credentials),
      );
      expect(providerFailureFacts(error)?.billing).toBe("billing_blocked");
      expect(error.retryable).toBe(false);
    });
  test("Claude depleted promotional/paid balance is exhausted", async () => {
    const { fetcher } = transport(400, {
      type: "error",
      error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." },
    });
    const error = await rejected(
      createAnthropicProvider({ fetch: fetcher }).stream(request("claude-sonnet-5-5"), credentials),
    );
    expect(providerFailureFacts(error)?.billing).toBe("exhausted");
  });
  test("facts never retain arbitrary upstream fields or secrets", () => {
    const raw = OpenAI.APIError.generate(
      429,
      {
        error: {
          code: "rate_limit_exceeded",
          message: "fixture secret-value",
          apiKey: "sk-sensitive-fixture",
          details: { token: "secret-value" },
        },
      },
      undefined,
      new Headers({ authorization: "Bearer secret-value", "retry-after": "2" }),
    );
    const mapped = openAIError(raw);
    expect(providerFailureFacts(mapped)).toEqual({
      code: "rate_limit_exceeded",
      httpRefusal: true,
      retryAfterMs: 2000,
    });
    expect(JSON.stringify(providerFailureFacts(mapped))).not.toContain("secret");
    expect(providerFailureFacts(mapped)).toBe(providerFailureFacts(mapped));
  });
  test("public error redaction copies only bounded facts and preserves unknown stream provenance", () => {
    const raw = new OpenAI.APIError(
      undefined,
      { code: "credit_balance_exhausted", message: "private fixture" },
      "private fixture",
      undefined,
    );
    const original = openAIError(raw);
    const masked = annotateProviderFailure(new ProviderError("public failure", false, original.status), original);
    expect(providerFailureFacts(masked)).toEqual(providerFailureFacts(original));
    expect(providerFailureFacts(masked)?.httpRefusal).toBe(false);
    expect(masked.message).toBe("public failure");
    expect(JSON.stringify(masked)).not.toContain("private fixture");
  });
  test("SSE-derived status never pretends to be an HTTP refusal", () => {
    const raw = new OpenAI.APIError(
      undefined,
      { code: "credit_balance_exhausted", message: "Refused." },
      "Refused.",
      undefined,
    );
    expect(openAIError(raw).status).toBe(429);
    expect(providerFailureFacts(openAIError(raw))).toMatchObject({ httpRefusal: false, billing: "exhausted" });
  });
  test("Claude SDK raw details survive normalization without raw payload", () => {
    const raw = Anthropic.APIError.generate(
      429,
      {
        error: {
          type: "rate_limit_error",
          details: { error_code: "enforced_spend_limit_reached", token: "secret" },
        },
      },
      undefined,
      new Headers(),
    );
    expect(providerFailureFacts(toProviderError(raw))).toEqual({
      code: "enforced_spend_limit_reached",
      billing: "billing_blocked",
      httpRefusal: true,
    });
  });
});

describe("one dispatch per admitted API attempt", () => {
  for (const provider of ["openai", "anthropic"] as const) {
    for (const status of [429, 500, 529])
      test(`${provider} noTransportRetries blocks hidden retry ${status}`, async () => {
        const body =
          provider === "openai"
            ? { error: { type: "rate_limit_error", code: "rate_limit_exceeded", message: "Transient." } }
            : {
                type: "error",
                error: { type: status === 429 ? "rate_limit_error" : "overloaded_error", message: "Transient." },
              };
        const { fetcher, requests } = transport(status, body, { "retry-after": "0.001" });
        const adapter =
          provider === "openai"
            ? createOpenAIProvider({ fetch: fetcher, maxRetries: 3 })
            : createAnthropicProvider({ fetch: fetcher, maxRetries: 3 });
        await rejected(
          adapter.stream(request(provider === "openai" ? "gpt-6-sol" : "claude-sonnet-5-5", true), credentials),
        );
        expect(requests).toHaveLength(1);
        expect(requests[0]?.noTransportRetries).toBeUndefined();
        expect(requests[0]?.fallbacks).toBeUndefined();
      });
    test(`${provider} never retransmits an ambiguous network failure for a grant`, async () => {
      let calls = 0;
      const fetcher = (async () => {
        calls += 1;
        throw new TypeError("connection interrupted");
      }) as unknown as typeof fetch;
      const adapter =
        provider === "openai"
          ? createOpenAIProvider({ fetch: fetcher, maxRetries: 3 })
          : createAnthropicProvider({ fetch: fetcher, maxRetries: 3 });
      const error = await rejected(
        adapter.stream(request(provider === "openai" ? "gpt-6-sol" : "claude-sonnet-5-5", true), credentials),
      );
      expect(calls).toBe(1);
      expect(providerFailureFacts(error)?.httpRefusal).toBe(false);
    });
    test(`${provider} retains configured retries outside grant route`, async () => {
      const { fetcher, requests } = transport(
        429,
        provider === "openai"
          ? { error: { code: "rate_limit_exceeded", message: "Transient." } }
          : { type: "error", error: { type: "rate_limit_error", message: "Transient." } },
        { "retry-after": "0.001" },
      );
      const adapter =
        provider === "openai"
          ? createOpenAIProvider({ fetch: fetcher, maxRetries: 1 })
          : createAnthropicProvider({ fetch: fetcher, maxRetries: 1 });
      await rejected(adapter.stream(request(provider === "openai" ? "gpt-6-sol" : "claude-sonnet-5-5"), credentials));
      expect(requests).toHaveLength(2);
    });
  }
  test("Claude thinking repair cannot make a second unreserved call", async () => {
    const { fetcher, requests } = transport(400, {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "Invalid thinking signature.",
      },
    });
    await rejected(
      createAnthropicProvider({ fetch: fetcher, maxRetries: 3 }).stream(
        request("claude-sonnet-5-5", true),
        credentials,
      ),
    );
    expect(requests).toHaveLength(1);
  });
  test("Claude token-count route also obeys noTransportRetries", async () => {
    const { fetcher, requests } = transport(500, { error: { type: "api_error", message: "Transient." } });
    const adapter = createAnthropicProvider({ fetch: fetcher, maxRetries: 3 });
    if (!adapter.countTokens) throw new Error("fixture needs token-count adapter");
    await rejected(adapter.countTokens(request("claude-sonnet-5-5", true), { apiKey: credentials.apiKey }));
    expect(requests).toHaveLength(1);
  });
  test("accepted OpenAI stream retains ambiguous charge even without output", async () => {
    const response = {
      id: "resp_fixture",
      object: "response",
      created_at: 1,
      model: "gpt-6-sol",
      output: [],
      status: "in_progress",
      error: null,
    };
    const events = [
      { type: "response.created", sequence_number: 0, response },
      {
        type: "response.failed",
        sequence_number: 1,
        response: { ...response, status: "failed", error: { code: "credit_balance_exhausted", message: "Refused." } },
      },
    ];
    const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
    const { fetcher, requests } = transport(200, body, { "content-type": "text/event-stream" });
    const error = await rejected(
      createOpenAIProvider({ fetch: fetcher, maxRetries: 3 }).stream(request("gpt-6-sol", true), credentials),
    );
    expect(requests).toHaveLength(1);
    expect(error.partial).toMatchObject({ outputChars: 0, inputTokens: null });
    expect(providerFailureFacts(error)?.httpRefusal).toBe(false);
  });
});

test("Retry-After seconds, HTTP dates and millisecond headers are bounded numbers without shorter waits", () => {
  expect(providerRetryAfterMs(new Headers({ "retry-after": "1.5" }), 0)).toBe(1500);
  expect(providerRetryAfterMs(new Headers({ "retry-after": "Thu, 01 Jan 1970 00:00:02 GMT" }), 1000)).toBe(1000);
  expect(providerRetryAfterMs(new Headers({ "retry-after-ms": "150" }), 0)).toBe(150);
  expect(providerRetryAfterMs(new Headers({ "retry-after": "not a date" }), 0)).toBeUndefined();
  expect(providerRetryAfterMs(new Headers({ "retry-after": "-1" }), 0)).toBeUndefined();
  expect(providerRetryAfterMs(new Headers({ "retry-after": "9007199254740991000" }), 0)).toBeUndefined();
});

describe("final API usage evidence for grant settlement", () => {
  const openAIReply = (
    usage: unknown,
    model = "gpt-6-sol",
    status = "completed",
    receipt: Record<string, unknown> = { service_tier: "default" },
  ) => {
    const response = {
      id: "resp_credit_fixture",
      object: "response",
      created_at: 1,
      model,
      output: [],
      status: "in_progress",
      error: null,
    };
    const final = {
      ...response,
      status,
      usage,
      ...receipt,
      incomplete_details: status === "incomplete" ? { reason: "max_output_tokens" } : null,
    };
    return [
      { type: "response.created", sequence_number: 0, response },
      {
        type: status === "incomplete" ? "response.incomplete" : "response.completed",
        sequence_number: 1,
        response: final,
      },
    ]
      .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
      .join("");
  };
  const openAIUsage = {
    input_tokens: 10,
    output_tokens: 2,
    input_tokens_details: { cached_tokens: 3 },
    output_tokens_details: { reasoning_tokens: 1 },
    total_tokens: 12,
  };
  for (const status of ["completed", "incomplete"])
    test(`OpenAI final ${status} receipt verifies cost, not task completion`, async () => {
      const { fetcher, requests } = transport(200, openAIReply(openAIUsage, "gpt-6-sol", status), {
        "content-type": "text/event-stream",
        "x-request-id": "req_openai_fixture",
      });
      const result = await createOpenAIProvider({ fetch: fetcher }).stream(request("gpt-6-sol", true), credentials);
      expect(result.usageVerified).toBe(true);
      expect(result.providerRequestId).toBe("req_openai_fixture");
      expect(result.providerResponseId).toBe("resp_credit_fixture");
      expect(requests[0]?.service_tier).toBe("default");
      expect(result.usage).toMatchObject({ inputTokens: 7, cacheReadTokens: 3, outputTokens: 2 });
      expect(result.stopReason).toBe(status === "incomplete" ? "max_tokens" : "end_turn");
      expect(requests).toHaveLength(1);
    });
  for (const [label, usage, model] of [
    ["missing usage", undefined, "gpt-6-sol"],
    ["negative tokens", { ...openAIUsage, input_tokens: -1 }, "gpt-6-sol"],
    ["cache exceeds input", { ...openAIUsage, input_tokens: 1 }, "gpt-6-sol"],
    ["model changed", openAIUsage, "gpt-6-astra"],
  ] as const)
    test(`OpenAI holds cost on ${label}`, async () => {
      const { fetcher, requests } = transport(200, openAIReply(usage, model), { "content-type": "text/event-stream" });
      const error = await rejected(
        createOpenAIProvider({ fetch: fetcher }).stream(request("gpt-6-sol", true), credentials),
      );
      expect(error.partial).toBeDefined();
      expect(requests).toHaveLength(1);
    });

  const claudeReply = (
    delta = true,
    model = "claude-sonnet-5-5",
    input = 10,
    receipt: Record<string, unknown> = { service_tier: "standard", speed: "standard" },
  ) => {
    const events: Record<string, unknown>[] = [
      {
        type: "message_start",
        message: {
          id: "msg_credit_fixture",
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: input,
            output_tokens: 1,
            cache_read_input_tokens: 3,
            cache_creation_input_tokens: 2,
            cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 0 },
            ...receipt,
          },
        },
      },
    ];
    if (delta)
      events.push({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 2 },
      });
    events.push({ type: "message_stop" });
    return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  };
  test("Claude final usage has request and response receipt identities", async () => {
    const { fetcher, requests } = transport(200, claudeReply(), {
      "content-type": "text/event-stream",
      "request-id": "req_claude_fixture",
    });
    const result = await createAnthropicProvider({ fetch: fetcher }).stream(
      request("claude-sonnet-5-5", true),
      credentials,
    );
    expect(result.usageVerified).toBe(true);
    expect(result.providerRequestId).toBe("req_claude_fixture");
    expect(result.providerResponseId).toBe("msg_credit_fixture");
    expect(requests[0]).toMatchObject({ service_tier: "standard_only", speed: "standard" });
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 2 });
    expect(requests).toHaveLength(1);
  });
  for (const [label, delta, model, input] of [
    ["missing final output receipt", false, "claude-sonnet-5-5", 10],
    ["negative input", true, "claude-sonnet-5-5", -1],
    ["different reserved model", true, "claude-opus-5-5", 10],
  ] as const)
    test(`Claude holds cost on ${label}`, async () => {
      const { fetcher, requests } = transport(200, claudeReply(delta, model, input), {
        "content-type": "text/event-stream",
      });
      const error = await rejected(
        createAnthropicProvider({ fetch: fetcher }).stream(request("claude-sonnet-5-5", true), credentials),
      );
      expect(error.partial).toBeDefined();
      expect(requests).toHaveLength(1);
    });

  test("Claude final receipt preserves mixed cache TTL costs", async () => {
    const { fetcher, requests } = transport(
      200,
      claudeReply(true, "claude-sonnet-5-5", 10, {
        service_tier: "standard",
        speed: "standard",
        cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 1 },
      }),
      { "content-type": "text/event-stream" },
    );
    const result = await createAnthropicProvider({ fetch: fetcher }).stream(
      request("claude-sonnet-5-5", true),
      credentials,
    );
    expect(result.usageVerified).toBe(true);
    expect(result.usage).toMatchObject({ cacheWriteTokens: 2, cacheWriteLongTokens: 1 });
    expect(requests).toHaveLength(1);
  });
  for (const cacheCreation of [
    undefined,
    null,
    { ephemeral_5m_input_tokens: 2 },
    { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 0 },
    { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 3 },
    { ephemeral_5m_input_tokens: -1, ephemeral_1h_input_tokens: 3 },
  ]) {
    test(`Claude holds cost for missing or inconsistent cache TTL receipt ${JSON.stringify(cacheCreation)}`, async () => {
      const { fetcher, requests } = transport(
        200,
        claudeReply(true, "claude-sonnet-5-5", 10, {
          service_tier: "standard",
          speed: "standard",
          cache_creation: cacheCreation,
        }),
        { "content-type": "text/event-stream" },
      );
      const error = await rejected(
        createAnthropicProvider({ fetch: fetcher }).stream(request("claude-sonnet-5-5", true), credentials),
      );
      expect(error.partial).toBeDefined();
      expect(requests).toHaveLength(1);
    });
  }
  for (const missing of ["cache_read_input_tokens", "cache_creation_input_tokens"] as const) {
    test(`Claude holds cost when final ${missing} is omitted`, async () => {
      const { fetcher } = transport(
        200,
        claudeReply(true, "claude-sonnet-5-5", 10, {
          service_tier: "standard",
          speed: "standard",
          [missing]: undefined,
        }),
        { "content-type": "text/event-stream" },
      );
      const error = await rejected(
        createAnthropicProvider({ fetch: fetcher }).stream(request("claude-sonnet-5-5", true), credentials),
      );
      expect(error.partial).toBeDefined();
    });
  }

  for (const receipt of [
    { service_tier: "priority" },
    { service_tier: "fast" },
    { service_tier: "ultrafast" },
    { service_tier: "flex" },
    { service_tier: "auto" },
    { service_tier: null },
    {},
  ]) {
    test(`OpenAI retains unknown cost for unexpected or missing final tier ${JSON.stringify(receipt)}`, async () => {
      const { fetcher, requests } = transport(200, openAIReply(openAIUsage, "gpt-6-sol", "completed", receipt), {
        "content-type": "text/event-stream",
      });
      const error = await rejected(
        createOpenAIProvider({ fetch: fetcher }).stream(request("gpt-6-sol", true), credentials),
      );
      expect(error.partial).toBeDefined();
      expect(requests).toHaveLength(1);
      expect(requests[0]?.service_tier).toBe("default");
    });
  }
  for (const receipt of [
    { service_tier: "priority", speed: "standard" },
    { service_tier: "batch", speed: "standard" },
    { service_tier: "standard", speed: "fast" },
    { service_tier: "standard", speed: null },
    { service_tier: "standard" },
    { speed: "standard" },
    {},
  ]) {
    test(`Claude retains unknown cost for unexpected or missing tier/speed ${JSON.stringify(receipt)}`, async () => {
      const { fetcher, requests } = transport(200, claudeReply(true, "claude-sonnet-5-5", 10, receipt), {
        "content-type": "text/event-stream",
      });
      const error = await rejected(
        createAnthropicProvider({ fetch: fetcher }).stream(request("claude-sonnet-5-5", true), credentials),
      );
      expect(error.partial).toBeDefined();
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ service_tier: "standard_only", speed: "standard" });
    });
  }
  test("Claude prewarm also pins standard tier and holds a nonstandard receipt", async () => {
    const reply = {
      id: "msg_prewarm_fixture",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5-5",
      content: [],
      stop_reason: "max_tokens",
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        service_tier: "priority",
        speed: "fast",
      },
    };
    const { fetcher, requests } = transport(200, reply);
    const r = { ...request("claude-sonnet-5-5", true), maxTokens: 0 };
    const error = await rejected(createAnthropicProvider({ fetch: fetcher }).stream(r, credentials));
    expect(error.partial).toBeDefined();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ service_tier: "standard_only", speed: "standard", stream: false });
  });
});

describe("grant endpoint binding", () => {
  for (const provider of ["openai", "anthropic"] as const) {
    const model = provider === "openai" ? "gpt-6-sol" : "claude-sonnet-5-5";
    const official = provider === "openai" ? "https://api.openai.com/v1" : "https://api.anthropic.com";
    const create = provider === "openai" ? createOpenAIProvider : createAnthropicProvider;
    test(`${provider} refuses a configured alternate endpoint before transport`, async () => {
      const { fetcher, requests } = transport(400, { error: { message: "fixture" } });
      await rejected(
        create({ baseURL: "https://fixture.invalid/v1", fetch: fetcher }).stream(request(model, true), credentials),
      );
      expect(requests).toHaveLength(0);
    });
    test(`${provider} allows the explicit official endpoint and preserves ordinary custom routes`, async () => {
      for (const [baseURL, grant] of [
        [official, true],
        ["https://fixture.invalid/v1", false],
      ] as const) {
        const urls: string[] = [];
        const fetcher = (async (input: string | URL | Request) => {
          urls.push(input instanceof Request ? input.url : String(input));
          return new Response(JSON.stringify({ error: { message: "fixture" } }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }) as typeof fetch;
        await rejected(create({ baseURL, fetch: fetcher, maxRetries: 0 }).stream(request(model, grant), credentials));
        expect(urls).toHaveLength(1);
        expect(urls[0]?.startsWith(`${baseURL}/`)).toBe(true);
      }
    });
    test(`${provider} ignores inherited alternate SDK endpoint in an isolated process`, async () => {
      // A subprocess receives only synthetic endpoint variables; the parent environment is never read or changed.
      const modulePath = new URL("../src/index.ts", import.meta.url).pathname;
      const script = [
        `import { createOpenAIProvider, createAnthropicProvider } from ${JSON.stringify(modulePath)};`,
        "const urls = [];",
        "const fetcher = async (input) => { urls.push(input instanceof Request ? input.url : String(input)); return new Response(JSON.stringify({ error: { message: 'fixture' } }), { status: 400, headers: { 'content-type': 'application/json' } }); };",
        "const adapter = " +
          (provider === "openai" ? "createOpenAIProvider" : "createAnthropicProvider") +
          "({ fetch: fetcher });",
        "try { await adapter.stream(" +
          JSON.stringify(request(model, true)) +
          ", { apiKey: 'synthetic-test-key', onDelta: () => {} }); } catch {}",
        "if (urls.length !== 1) throw new Error('unexpected transport count');",
        "const target = new URL(urls[0]); console.log(target.origin + target.pathname);",
      ].join("\n");
      const child = Bun.spawn([process.execPath, "--eval", script], {
        env: {
          OPENAI_BASE_URL: "https://openai-fixture.invalid/v1",
          ANTHROPIC_BASE_URL: "https://claude-fixture.invalid",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
      expect(stdout.trim()).toBe(provider === "openai" ? `${official}/responses` : `${official}/v1/messages`);
    });
  }
  test("Claude token counting refuses an alternate grant endpoint before transport", async () => {
    const { fetcher, requests } = transport(200, { input_tokens: 1 });
    const adapter = createAnthropicProvider({ baseURL: "https://fixture.invalid", fetch: fetcher });
    if (!adapter.countTokens) throw new Error("fixture needs countTokens");
    await rejected(adapter.countTokens(request("claude-sonnet-5-5", true), { apiKey: credentials.apiKey }));
    expect(requests).toHaveLength(0);
  });
  test("an Anthropic-compatible adapter cannot impersonate the official grant route", async () => {
    const { fetcher, requests } = transport(400, { error: { message: "fixture" } });
    const adapter = createAnthropicProvider({ id: "custom", compat: { toolChoiceAny: true }, fetch: fetcher });
    await rejected(adapter.stream(request("claude-sonnet-5-5", true), credentials));
    expect(requests).toHaveLength(0);
  });
});
