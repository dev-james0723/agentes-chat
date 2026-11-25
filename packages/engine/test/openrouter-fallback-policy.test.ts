import { describe, expect, test } from "bun:test";
import { decideOpenRouterFallback, type OpenRouterFallbackInput } from "../src/openrouter-fallback-policy";

const input: OpenRouterFallbackInput = {
  enabled: true,
  task: "engineering",
  subscriptionsConsidered: true,
  source: "exhausted",
  alternatives: [
    { id: "codex", state: "exhausted" },
    { id: "claude", state: "exhausted" },
    { id: "grok", state: "unavailable" },
  ],
  scopeAuthorized: true,
  safeTurnBoundary: true,
  portableContextQualified: true,
  keyLimitVerified: true,
  policy: {
    allowedModels: ["openai/gpt-6-luna", "anthropic/claude-sonnet-5.5"],
    costTier: "medium",
    monthlyCapUsd: 20,
    maxPromptUsdPerMillion: 4,
    maxCompletionUsdPerMillion: 20,
  },
};

describe("global OpenRouter fallback decision", () => {
  test("engineering uses Auto Code; general agent or routine uses Auto Router", () => {
    expect(decideOpenRouterFallback(input)).toEqual({ ok: true, model: "openrouter/auto-code" });
    expect(decideOpenRouterFallback({ ...input, task: "general" })).toEqual({ ok: true, model: "openrouter/auto" });
  });

  test("any healthy subscription defeats paid fallback; unknown or incomplete evidence is not exhaustion", () => {
    expect(decideOpenRouterFallback({ ...input, source: "healthy" })).toEqual({
      ok: false,
      reason: "subscription_available",
    });
    expect(
      decideOpenRouterFallback({
        ...input,
        alternatives: [...input.alternatives, { id: "gemini", state: "available" }],
      }),
    ).toEqual({ ok: false, reason: "subscription_available" });
    expect(
      decideOpenRouterFallback({ ...input, alternatives: [...input.alternatives, { id: "gemini", state: "unknown" }] }),
    ).toEqual({ ok: false, reason: "subscription_evidence_unknown" });
    expect(decideOpenRouterFallback({ ...input, source: "unknown" })).toEqual({
      ok: false,
      reason: "subscription_evidence_unknown",
    });
    expect(decideOpenRouterFallback({ ...input, subscriptionsConsidered: false })).toEqual({
      ok: false,
      reason: "subscription_evidence_unknown",
    });
    expect(
      decideOpenRouterFallback({
        ...input,
        alternatives: [
          { id: "codex", state: "exhausted" },
          { id: "codex", state: "exhausted" },
        ],
      }),
    ).toEqual({ ok: false, reason: "subscription_evidence_unknown" });
  });

  test("disabled or unsafe policy cannot select a paid candidate", () => {
    for (const [patch, reason] of [
      [{ enabled: false }, "disabled"],
      [{ scopeAuthorized: false }, "scope_unauthorized"],
      [{ safeTurnBoundary: false }, "unsafe_checkpoint"],
      [{ portableContextQualified: false }, "context_unqualified"],
      [{ keyLimitVerified: false }, "key_limit_unverified"],
      [{ policy: undefined }, "routing_policy_unverified"],
      [
        {
          policy: {
            allowedModels: ["qwen/qwen3.7-flash"],
            costTier: "medium",
            monthlyCapUsd: 20,
            maxPromptUsdPerMillion: 4,
            maxCompletionUsdPerMillion: 20,
          },
        },
        "routing_policy_unverified",
      ],
    ] as const)
      expect(decideOpenRouterFallback({ ...input, ...patch })).toEqual({ ok: false, reason });
  });
});
