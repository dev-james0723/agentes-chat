import { afterEach, describe, expect, test } from "bun:test";
import {
  costNanoUsd,
  listedModels,
  MODEL_CATALOG,
  modelForTier,
  modelInfo,
  setDiscoveredModels,
} from "@agenteschat/providers";
import { autoModelFor, brainModelForTier } from "../src/auto-model";
import { brainModelId, brainModelOptions, normalizeBrainModel } from "../src/brain-settings";
import { MODEL_METADATA_URL, parseProviderModels, refreshProviderModels } from "../src/model-discovery";

// Public models.dev prices can include tier arrays and unknown fields, so the
// test fixture accepts the same untrusted shape that the parser validates.
const native = (
  id: string,
  name: string,
  date: string,
  prices: unknown = { input: 2, output: 8, cache_read: 0.2 },
) => ({
  id,
  name,
  release_date: date,
  type: "chat",
  reasoning: true,
  tool_call: true,
  structured_output: true,
  modalities: { input: ["text", "image"], output: ["text"] },
  limit: { context: 500_000, output: 64_000 },
  cost: prices,
});

const sample = () => ({
  openai: {
    models: {
      "gpt-6.3-sol": native("gpt-6.3-sol", "GPT-6.3 Sol", "2026-11-20"),
      "gpt-6.2-sol": native("gpt-6.2-sol", "UNTRUSTED override", "2026-11-20"),
    },
  },
  anthropic: { models: { "claude-opus-5-6": native("claude-opus-5-6", "Claude Opus 5.6", "2026-11-20") } },
  google: { models: { "gemini-4.1-flash": native("gemini-4.1-flash", "Gemini 4.1 Flash", "2026-11-20") } },
  xai: { models: { "grok-4.8": native("grok-4.8", "Grok 4.8", "2026-11-20") } },
});

const respond = (data: unknown, status = 200): typeof fetch =>
  (async () => Response.json(data, { status })) as unknown as typeof fetch;

afterEach(() => setDiscoveredModels({}));

describe("native model discovery", () => {
  test("adds tool-capable models for explicit selection without unverified automatic promotion", () => {
    const found = parseProviderModels(sample());
    expect(found).not.toBeNull();
    expect(Object.keys(found ?? {})).toEqual(["gpt-6.3-sol", "claude-opus-5-6", "gemini-4.1-flash", "grok-4.8"]);
    expect(found?.["gpt-6.3-sol"]).toMatchObject({
      provider: "openai",
      releasedAt: "2026-11-20",
      prices: { input: 2000, output: 8000, cacheRead: 200, cacheWrite: 4000 },
      contextWindow: 500_000,
      maxOutputTokens: 64_000,
      tier: "medium",
    });
    expect(found?.["claude-opus-5-6"]?.tier).toBe("large");
    expect(found?.["grok-4.8"]?.provider).toBe("xai");
    // Static reviewed data remains authoritative over external metadata.
    expect(found?.["gpt-6.2-sol"]).toBeUndefined();
    setDiscoveredModels(found ?? {});
    expect(modelInfo("gpt-6.2-sol")).toBe(MODEL_CATALOG["gpt-6.2-sol"]);
    // Public metadata does not prove the linked credential can use the model.
    // Explicit workspace choice can still opt in after provider entitlement is checked.
    expect(modelForTier("openai", "medium")).toBe("gpt-6.2-sol");
    expect(modelForTier("anthropic", "large")).toBe("claude-opus-5-5");
    expect(modelForTier("xai", "medium")).toBe("grok-4.7");
    expect(autoModelFor("openai", "medium", { medium: "gpt-6.3-sol" })).toBe("gpt-6.3-sol");
    expect(listedModels().map(([id]) => id)).toContain("gpt-6.3-sol");
    expect(brainModelOptions("codex").map((o) => o.value)).toContain("gpt-6.3-sol");
    expect(brainModelOptions("claude_code").map((o) => o.value)).toContain("claude-opus-5-6");
    expect(brainModelId("claude_code", "opus")).toBe("claude-opus-5-5");
    expect(brainModelForTier("claude_code", "large")).toBe("opus");
    expect(normalizeBrainModel("claude_code", "claude-opus-5-6")).toBe("claude-opus-5-6");
  });

  test("keeps batch discounts out of context prices and bounds multi-context costs", () => {
    const doc = sample();
    const tierCost = {
      input: 2,
      output: 8,
      cache_read: 0.5,
      tiers: [
        { tier: { type: "batch", size: 32_000 }, input: 0.2, output: 1, cache_read: 0.05 },
        { tier: { type: "context", size: 200_000 }, input: 4, output: 16, cache_read: 0.4 },
        { tier: { type: "context", size: 350_000 }, input: 6, output: 24, cache_read: 0.6 },
      ],
    };
    const parsed = parseProviderModels({
      ...doc,
      openai: {
        models: {
          ...doc.openai.models,
          "gpt-6.3-sol": native("gpt-6.3-sol", "GPT-6.3 Sol", "2026-11-20", tierCost),
        },
      },
    });
    expect(parsed?.["gpt-6.3-sol"]?.longContext).toEqual({
      aboveInputTokens: 200_000,
      prices: { input: 6000, output: 24000, cacheRead: 600, cacheWrite: 12000 },
    });
    setDiscoveredModels(parsed ?? {});
    expect(
      costNanoUsd("gpt-6.3-sol", { inputTokens: 200_001, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    ).toBe(200_001 * 6000 + 1000 * 24000);
    // A batch-only entry must not be interpreted as an automatic long-context discount.
    const batchOnly = parseProviderModels({
      ...doc,
      openai: {
        models: {
          ...doc.openai.models,
          "gpt-6.3-sol": native("gpt-6.3-sol", "GPT-6.3 Sol", "2026-11-20", {
            input: 2,
            output: 8,
            cache_read: 0.5,
            tiers: [tierCost.tiers[0]],
          }),
        },
      },
    });
    expect(batchOnly?.["gpt-6.3-sol"]?.longContext).toBeUndefined();
  });

  test("retains context tiers at small and exact-window thresholds, rejects unknown expensive tiers", () => {
    const base = sample();
    const withCost = (cost: unknown) => ({
      ...base,
      openai: {
        models: {
          ...base.openai.models,
          "gpt-6.3-sol": native("gpt-6.3-sol", "GPT-6.3 Sol", "2026-11-20", cost),
          "gpt-6.3-astra": native("gpt-6.3-astra", "GPT-6.3 Astra", "2026-11-20"),
        },
      },
    });
    const prices = { input: 2, output: 8, cache_read: 0.5 };
    const tiny = parseProviderModels(
      withCost({
        ...prices,
        tiers: [{ tier: { type: "context", size: 16_000 }, input: 4, output: 16 }],
      }),
    );
    expect(tiny?.["gpt-6.3-sol"]?.longContext).toMatchObject({ aboveInputTokens: 16_000 });
    const exactWindow = parseProviderModels(
      withCost({
        ...prices,
        tiers: [
          { tier: { type: "context", size: 200_000 }, input: 4, output: 16 },
          { tier: { type: "context", size: 500_000 }, input: 10, output: 40 },
        ],
      }),
    );
    expect(exactWindow?.["gpt-6.3-sol"]?.longContext).toMatchObject({
      aboveInputTokens: 200_000,
      prices: { input: 10_000, output: 40_000 },
    });
    for (const invalid of [
      [{ tier: { type: "context", size: 350_000 }, input: 10, output: 1500 }],
      [{ tier: { type: "context", size: 350_000 }, input: 10 }],
      [{ tier: { type: "context", size: 550_000 }, input: 10, output: 40 }],
    ]) {
      const parsed = parseProviderModels(
        withCost({
          ...prices,
          tiers: [{ tier: { type: "context", size: 200_000 }, input: 4, output: 16 }, ...invalid],
        }),
      );
      expect(parsed).not.toBeNull();
      expect(parsed?.["gpt-6.3-sol"]).toBeUndefined();
      expect(parsed?.["gpt-6.3-astra"]).toBeDefined();
    }
  });

  test("rejects unsupported, unpriced, non-tool, multimedia, invalid ID and empty feeds", () => {
    const invalid = sample();
    invalid.openai.models = {
      "gpt-6.3-sol": { ...native("gpt-6.3-sol", "GPT 6.3", "2026-11-20"), tool_call: false },
      "gpt-6.2-sol": {
        ...native("gpt-6.2-sol", "GPT 6.2", "2026-11-20"),
        cost: { input: 0, output: 0, cache_read: 0 },
      },
    };
    expect(parseProviderModels(invalid)).toBeNull();
    expect(parseProviderModels({ data: [] })).toBeNull();
    expect(parseProviderModels(null)).toBeNull();
  });

  test("fails closed when the upstream is down, malformed or unavailable; previous list survives", async () => {
    const asked: string[] = [];
    const fetched = async (url: string) => {
      asked.push(url);
      return Response.json(sample());
    };
    const updated = await refreshProviderModels(fetched as typeof fetch);
    expect(updated).toEqual({ updated: true, count: 4 });
    expect(asked).toEqual([MODEL_METADATA_URL]);
    expect(modelInfo("gpt-6.3-sol")?.label).toBe("GPT-6.3 Sol");
    const bad = await refreshProviderModels(respond({ error: "Unavailable" }, 503));
    expect(bad).toEqual({ updated: false, count: 4 });
    const missing = await refreshProviderModels(respond({ data: [] }));
    expect(missing).toEqual({ updated: false, count: 4 });
    const offline = await refreshProviderModels((async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch);
    expect(offline).toEqual({ updated: false, count: 4 });
    expect(modelInfo("gpt-6.3-sol")?.label).toBe("GPT-6.3 Sol");
  });

  test("does not alter pinned models when the dynamic catalog refreshes", () => {
    const next = parseProviderModels(sample());
    expect(next).not.toBeNull();
    setDiscoveredModels(next ?? {});
    expect(modelInfo("gpt-6.1-sol")?.label).toBe("GPT-6.1 Sol");
    setDiscoveredModels({});
    expect(listedModels().some(([id]) => id === "gpt-6.3-sol")).toBe(false);
    expect(modelForTier("openai", "medium")).toBe("gpt-6.2-sol");
  });
});
