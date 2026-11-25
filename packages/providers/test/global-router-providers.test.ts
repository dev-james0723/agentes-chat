import { describe, expect, test } from "bun:test";
import {
  assertSafeRouterEndpoint,
  buildDirectCloudOffers,
  createCloudflareProvider,
  createGroqProvider,
  createOpenAICompatibleDirectProvider,
  createOpenCodeProvider,
  createOpenRouterProvider,
  evaluateOfferEligibility,
  parseCloudflareCatalogOffers,
  parseGroqCatalogOffers,
  parseOpenCodeCatalogOffers,
  parseOpenRouterCatalogOffers,
  type RateLimitTelemetry,
  routerDenylistReason,
} from "../src";

const sseStream = (chunks: unknown[]) =>
  new Response(
    new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        for (const c of chunks) controller.enqueue(enc.encode(`data: ${JSON.stringify(c)}\n\n`));
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
    {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "x-request-id": "req_synth_001",
        "x-ratelimit-limit-requests": "30",
        "x-ratelimit-remaining-requests": "29",
        "x-ratelimit-limit-tokens": "15000",
        "x-ratelimit-remaining-tokens": "14920",
      },
    },
  );

describe("Global Model Router dynamic catalog & security gates", () => {
  test("SSRF and HTTPS origin guard rejects plaintext HTTP, loopback, RFC1918, IPv6, credentials and unknown hosts", () => {
    expect(() => assertSafeRouterEndpoint("http://openrouter.ai/api/v1")).toThrow(/HTTPS/);
    expect(() => assertSafeRouterEndpoint("https://127.0.0.1/v1")).toThrow(/restricted/);
    expect(() => assertSafeRouterEndpoint("https://10.0.0.5/v1")).toThrow(/restricted/);
    expect(() => assertSafeRouterEndpoint("https://192.168.1.1/v1")).toThrow(/restricted/);
    expect(() => assertSafeRouterEndpoint("https://169.254.169.254/latest")).toThrow(/restricted/);
    expect(() => assertSafeRouterEndpoint("https://[::1]/v1")).toThrow(/restricted/);
    expect(() => assertSafeRouterEndpoint("https://user:secret@openrouter.ai/api/v1")).toThrow(/credentials/);
    expect(() => assertSafeRouterEndpoint("https://openrouter.ai:8443/api/v1")).toThrow(/port 443/);
    expect(() => assertSafeRouterEndpoint("https://openrouter.ai/api/v1?api_key=leak")).toThrow(/query/);
    expect(() => assertSafeRouterEndpoint("https://evil-proxy.example.com/v1")).toThrow(/allowlist/);
    expect(assertSafeRouterEndpoint("https://openrouter.ai/api/v1").hostname).toBe("openrouter.ai");
    expect(assertSafeRouterEndpoint("https://api.groq.com/openai/v1").hostname).toBe("api.groq.com");
    expect(assertSafeRouterEndpoint("https://opencode.ai/inference/go/openai/v1").hostname).toBe("opencode.ai");
  });

  test("enforces Qwen/Ollama/Gemini-API/openrouter-free denylist across all providers", () => {
    expect(routerDenylistReason("openrouter", "qwen/qwen3.8-max")).toBe("denied_qwen_ollama");
    expect(routerDenylistReason("opencode", "qwen3.8-flash", "alibaba/qwen3.8-flash")).toBe("denied_qwen_ollama");
    expect(routerDenylistReason("custom", "ollama/llama3")).toBe("denied_qwen_ollama");
    expect(routerDenylistReason("gemini", "gemini-3.8-flash")).toBe("denied_gemini_metered_api");
    expect(routerDenylistReason("openrouter", "openrouter/free")).toBe("unconstrained_free_router_disabled");
    expect(routerDenylistReason("openrouter", "deepseek/deepseek-v4.1-flash-1017")).toBeNull();
  });

  test("OpenRouter catalog parser qualifies :free, paid concrete, and auto/auto-code while quarantining unsafe offers", () => {
    const now = "2026-11-23T21:00:00.000Z";
    const offers = parseOpenRouterCatalogOffers(
      {
        data: [
          {
            id: "nvidia/nemotron-3.5-super-vl:free",
            name: "NVIDIA Nemotron 3.5 Super VL (free)",
            context_length: 1_000_000,
            supported_parameters: ["tools", "structured_outputs"],
            architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
            pricing: { prompt: "0", completion: "0", request: "0", image: "0" },
          },
          {
            id: "google/lyria-3-pro-preview",
            name: "Lyria Zero Promo",
            context_length: 1_048_576,
            supported_parameters: ["tools"],
            architecture: { output_modalities: ["text"] },
            pricing: { prompt: "0", completion: "0" },
          },
          {
            id: "deepseek/deepseek-v4.1-flash-1017",
            name: "DeepSeek V4.1 Flash 1017",
            context_length: 1_048_576,
            supported_parameters: ["tools", "structured_outputs", "reasoning"],
            architecture: { output_modalities: ["text"] },
            pricing: { prompt: "0.00000003", completion: "0.0000002" },
          },
          {
            id: "qwen/qwen3.8-coder:free",
            name: "Qwen Coder",
            context_length: 256_000,
            supported_parameters: ["tools"],
            architecture: { output_modalities: ["text"] },
            pricing: { prompt: "0", completion: "0" },
          },
          { id: "openrouter/free", name: "Free Router", context_length: 200_000 },
          { id: "openrouter/auto", name: "Auto", context_length: 2_000_000 },
          { id: "openrouter/auto-code", name: "Auto Code", context_length: 2_000_000 },
        ],
      },
      now,
      3_600_000,
    );

    const nemotronFree = offers.find((o) => o.modelId === "nvidia/nemotron-3.5-super-vl:free");
    expect(nemotronFree).toMatchObject({
      lane: "free_api",
      freeEligible: true,
      qualificationStatus: "eligible",
      prices: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    expect(evaluateOfferEligibility(nemotronFree!, Date.parse(now) + 1000)).toEqual({ eligible: true });
    // Stale check after TTL expiry:
    expect(evaluateOfferEligibility(nemotronFree!, Date.parse(now) + 3_600_001)).toEqual({
      eligible: false,
      reason: "stale_catalog",
    });

    // Zero-priced without :free suffix requires funded account -> quarantined from free pool!
    const promo = offers.find((o) => o.modelId === "google/lyria-3-pro-preview");
    expect(promo?.freeEligible).toBe(false);
    expect(promo?.qualificationStatus).toBe("quarantined");
    expect(promo?.quarantineReason).toBe("zero_price_without_free_contract");

    // Paid concrete DeepSeek V4.1 Flash 1017:
    const ds = offers.find((o) => o.modelId === "deepseek/deepseek-v4.1-flash-1017");
    expect(ds).toMatchObject({
      lane: "paid_low_cost",
      freeEligible: false,
      qualificationStatus: "eligible",
      prices: { input: 30, output: 200, cacheRead: 30, cacheWrite: 30 },
    });

    // Qwen and openrouter/free denied:
    expect(offers.find((o) => o.modelId === "qwen/qwen3.8-coder:free")?.qualificationStatus).toBe("denied");
    expect(offers.find((o) => o.modelId === "openrouter/free")?.qualificationStatus).toBe("denied");
    expect(offers.find((o) => o.modelId === "openrouter/auto-code")?.lane).toBe("paid_dynamic");
  });

  test("OpenCode Go/Zen catalog qualifies Go included allowance, denies Qwen/Gemini, and quarantines native-only free chat", () => {
    const goOffers = parseOpenCodeCatalogOffers(
      {
        data: [
          {
            id: "deepseek-v4.1-flash",
            name: "DeepSeek V4.1 Flash 1017",
            canonical_id: "deepseek/deepseek-v4.1-flash-1017",
            type: "chat",
            capabilities: { tools: { supported: true }, structured_output: true, reasoning: { supported: true } },
            limit: { context: 1_000_000, output: 384_000 },
            cost: { text: { input: { price: 0.15, cache: { read: 0.003 } }, output: { price: 0.6 } } },
            api: { "chat-completions": { base_url: "https://opencode.ai/inference/go/openai/v1" } },
            go: { monthly_usage: { go: 100 }, training: false, zdr: true },
          },
          {
            id: "qwen3.8-max",
            name: "Qwen 3.8 Max",
            canonical_id: "alibaba/qwen3.8-max",
            type: "chat",
            capabilities: { tools: { supported: true } },
            limit: { context: 1_000_000, output: 64_000 },
            cost: { text: { input: { price: 2 }, output: { price: 6 } } },
            api: { messages: { base_url: "https://opencode.ai/inference/go/anthropic/v1" } },
            go: { monthly_usage: { go: 50 }, training: false, zdr: true },
          },
          {
            id: "gemini-4-argon",
            name: "Gemini 4 Argon",
            canonical_id: "google/gemini-4-argon",
            type: "chat",
          },
        ],
      },
      "go",
    );
    expect(goOffers.find((o) => o.modelId === "deepseek-v4.1-flash")).toMatchObject({
      lane: "opencode_go",
      freeEligible: true,
      qualificationStatus: "eligible",
      quotaUnits: "go_shared_windows",
    });
    expect(goOffers.find((o) => o.modelId === "qwen3.8-max")?.qualificationStatus).toBe("denied");
    expect(goOffers.find((o) => o.modelId === "gemini-4-argon")?.qualificationStatus).toBe("denied");

    const zenOffers = parseOpenCodeCatalogOffers(
      {
        data: [
          {
            id: "hy4-flash-free",
            name: "Tencent Hy4 Flash Free",
            canonical_id: "tencent/hy4-flash",
            type: "chat",
            capabilities: { tools: { supported: true } },
            limit: { context: 256_000, output: 16_384 },
            cost: { text: { input: { price: 0 }, output: { price: 0 } } },
            api: { "chat-completions": { base_url: "https://opencode.ai/inference/openai/v1" } },
          },
        ],
      },
      "zen",
    );
    expect(zenOffers[0]).toMatchObject({
      apiStyle: "native_opencode",
      qualificationStatus: "quarantined",
      quarantineReason: "native_opencode_harness_required",
    });
  });

  test("Groq free and Cloudflare Workers AI free catalogs enforce zero-spend and paid-billing guards", () => {
    const groqOffers = parseGroqCatalogOffers(
      {
        data: [
          { id: "openai/gpt-oss-120b", active: true, context_window: 131_072, max_completion_tokens: 32_768 },
          { id: "qwen/qwen3-32b", active: true, context_window: 131_072 },
        ],
      },
      "free_only",
    );
    expect(groqOffers.find((o) => o.modelId === "openai/gpt-oss-120b")).toMatchObject({
      lane: "free_api",
      freeEligible: true,
      qualificationStatus: "eligible",
    });
    expect(groqOffers.find((o) => o.modelId === "qwen/qwen3-32b")?.qualificationStatus).toBe("denied");

    const cfOffers = parseCloudflareCatalogOffers(
      {
        result: [
          { name: "@cf/openai/gpt-oss-120b", task: { name: "Text Generation" } },
          {
            name: "@cf/deepseek-ai/deepseek-r1-distill-32b",
            task: { name: "Text Generation" },
            requires_paid_plan: true,
          },
        ],
      },
      "0123456789abcdef0123456789abcdef",
      "free_only",
    );
    const gptOss = cfOffers.find((o) => o.modelId === "@cf/openai/gpt-oss-120b");
    expect(gptOss).toMatchObject({
      apiStyle: "openai_responses_nonstream",
      freeEligible: true,
      qualificationStatus: "eligible",
      quotaUnits: "neurons",
    });
    const paidGated = cfOffers.find((o) => o.modelId === "@cf/deepseek-ai/deepseek-r1-distill-32b");
    expect(paidGated).toMatchObject({
      freeEligible: false,
      qualificationStatus: "quarantined",
      quarantineReason: "cloudflare_paid_method_required",
    });

    const directOffers = buildDirectCloudOffers();
    expect(directOffers.map((o) => o.provider)).toEqual(
      expect.arrayContaining(["deepseek", "tencent", "minimax", "zai", "moonshot", "xiaomi", "nvidia"]),
    );
    expect(directOffers.every((o) => o.qualificationStatus === "requires_owner_approval")).toBe(true);
  });
});

describe("Global Model Router cloud provider adapters", () => {
  test("OpenRouter :free adapter sends max_price=0, allow_fallbacks=false, and rejects nonzero cost receipts", async () => {
    let sentBody: Record<string, unknown> | undefined;
    const or = createOpenRouterProvider({
      fetch: (async (_url, init) => {
        sentBody = JSON.parse(String(init?.body ?? "{}"));
        return sseStream([
          {
            model: "nvidia/nemotron-3.5-super-vl:free",
            choices: [{ delta: { content: "Free verified." }, finish_reason: null }],
          },
          {
            model: "nvidia/nemotron-3.5-super-vl:free",
            choices: [{ delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 40, completion_tokens: 5, cost: 0 },
          },
        ]);
      }) as typeof fetch,
    });

    const res = await or.stream(
      {
        model: "nvidia/nemotron-3.5-super-vl:free",
        system: "Be concise.",
        messages: [{ role: "user", content: "Ping" }],
        maxTokens: 64,
        openRouterFreeOnly: true,
        noTransportRetries: true,
      },
      { apiKey: ["sk", "or", "v1", "a".repeat(64)].join("-"), onDelta: () => {} },
    );
    expect(sentBody?.provider).toEqual({
      allow_fallbacks: false,
      data_collection: "deny",
      max_price: { prompt: 0, completion: 0 },
    });
    expect(res.costNanoUsd).toBe(0);
    expect(res.usageVerified).toBe(true);
  });

  test("GroqCloud adapter normalizes upstream model id and captures organization RPM/TPM rate-limit headers", async () => {
    let capturedTelemetry: RateLimitTelemetry | undefined;
    let sentModel = "";
    const groq = createGroqProvider({
      onRateLimits: (t) => {
        capturedTelemetry = t;
      },
      fetch: (async (_url, init) => {
        sentModel = JSON.parse(String(init?.body ?? "{}")).model;
        return sseStream([
          {
            model: "openai/gpt-oss-120b",
            choices: [{ delta: { content: "Groq ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 20, completion_tokens: 4 },
          },
        ]);
      }) as typeof fetch,
    });
    const res = await groq.stream(
      {
        model: "groq/gpt-oss-120b",
        system: "Test",
        messages: [{ role: "user", content: "Hi" }],
        maxTokens: 32,
      },
      { apiKey: ["gsk", "x".repeat(32)].join("_"), onDelta: () => {} },
    );
    expect(sentModel).toBe("openai/gpt-oss-120b");
    expect(res.model).toBe("groq/gpt-oss-120b");
    expect(res.text).toBe("Groq ok");
    expect(capturedTelemetry).toMatchObject({ rpmLimit: 30, rpmRemaining: 29, tpmLimit: 15000, tpmRemaining: 14920 });
  });

  test("Cloudflare Workers AI adapter uses non-streaming /responses for GPT-OSS and normalizes tool calls", async () => {
    let calledUrl = "";
    let calledBody: Record<string, unknown> | undefined;
    const cf = createCloudflareProvider({
      fetch: (async (url, init) => {
        calledUrl = String(url);
        calledBody = JSON.parse(String(init?.body ?? "{}"));
        return Response.json(
          {
            result: {
              id: "resp_cf_1",
              model: "@cf/openai/gpt-oss-120b",
              status: "completed",
              output: [
                { type: "message", content: [{ type: "output_text", text: "Checking status." }] },
                { type: "function_call", call_id: "call_cf_1", name: "read_status", arguments: '{"scope":"all"}' },
              ],
              usage: { input_tokens: 55, output_tokens: 18 },
            },
          },
          { headers: { "cf-ray": "ray_synth_99" } },
        );
      }) as typeof fetch,
    });
    const deltas: string[] = [];
    const res = await cf.stream(
      {
        model: "@cf/openai/gpt-oss-120b",
        system: "Use tools.",
        messages: [{ role: "user", content: "Check status" }],
        maxTokens: 128,
        tools: [{ name: "read_status", description: "Read status", inputSchema: { type: "object" } }],
      },
      {
        apiKey: ["cfut", "y".repeat(32)].join("_"),
        workspaceId: "0123456789abcdef0123456789abcdef",
        onDelta: (d) => deltas.push(d),
      },
    );
    expect(calledUrl).toBe(
      "https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/v1/responses",
    );
    expect(calledBody?.stream).toBe(false);
    expect(deltas).toEqual(["Checking status."]);
    expect(res.stopReason).toBe("tool_use");
    expect(res.usageVerified).toBe(true);
    expect(res.content).toContainEqual({
      type: "tool_use",
      id: "call_cf_1",
      name: "read_status",
      input: { scope: "all" },
    });
  });

  test("OpenCode adapter sends official agentes.chat User-Agent, Extra Usage OFF, and refuses native-only free chat without spoofing", async () => {
    let seenHeaders: Headers | undefined;
    const oc = createOpenCodeProvider({
      version: "2.4.0",
      fetch: (async (_url, init) => {
        seenHeaders = new Headers(init?.headers);
        return sseStream([
          {
            model: "deepseek-v4.1-flash",
            choices: [{ delta: { content: "Go included ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 30, completion_tokens: 6 },
          },
        ]);
      }) as typeof fetch,
    });

    await expect(
      oc.stream(
        {
          model: "opencode/deepseek-v4.1-flash-free",
          system: "Test",
          messages: [{ role: "user", content: "Hi" }],
          maxTokens: 32,
        },
        { apiKey: ["oc", "sk", "z".repeat(24)].join("_"), session: "sess-123", onDelta: () => {} },
      ),
    ).rejects.toMatchObject({ status: 403, retryable: false });

    const ok = await oc.stream(
      {
        model: "opencode:go:deepseek-v4.1-flash",
        system: "Test",
        messages: [{ role: "user", content: "Hi" }],
        maxTokens: 32,
      },
      { apiKey: ["oc", "sk", "z".repeat(24)].join("_"), session: "sess-123", onDelta: () => {} },
    );
    expect(ok.text).toBe("Go included ok");
    expect(seenHeaders?.get("user-agent")).toBe("agentes.chat/2.4.0");
    expect(seenHeaders?.get("x-opencode-session")).toBe("sess-123");
    expect(seenHeaders?.get("x-opencode-extra-usage")).toBe("false");
  });

  test("Direct OpenAI-compatible adapters (Tencent, Xiaomi, NVIDIA) normalize model IDs and stream cleanly", async () => {
    for (const [id, baseURL, model, expectedUpstream] of [
      ["tencent", "https://api.hunyuan.cloud.tencent.com/v1", "hunyuan-hy4-flash", "hunyuan-turbos-latest"],
      ["xiaomi", "https://api.xiaomimimo.com/v1", "mimo-v2.6-flash", "mimo-v2.6-flash"],
      ["nvidia", "https://integrate.api.nvidia.com/v1", "nvidia-nemotron-3.5-super-vl", "nvidia/nemotron-3.5-super-vl"],
    ] as const) {
      let sent = "";
      const p = createOpenAICompatibleDirectProvider({
        id,
        baseURL,
        fetch: (async (_url, init) => {
          sent = JSON.parse(String(init?.body ?? "{}")).model;
          return sseStream([
            {
              model: expectedUpstream,
              choices: [{ delta: { content: `${id} ok` }, finish_reason: "stop" }],
              usage: { prompt_tokens: 12, completion_tokens: 3 },
            },
          ]);
        }) as typeof fetch,
      });
      const r = await p.stream(
        { model, system: "Test", messages: [{ role: "user", content: "Ping" }], maxTokens: 32 },
        { apiKey: `${id}-synthetic-key-1234567890`, onDelta: () => {} },
      );
      expect(sent).toBe(expectedUpstream);
      expect(r.model).toBe(model);
      expect(r.text).toBe(`${id} ok`);
    }
  });
});
