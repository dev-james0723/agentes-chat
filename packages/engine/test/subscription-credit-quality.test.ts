import { expect, test } from "bun:test";
import { MODEL_CATALOG } from "@agenteschat/providers";
import { creditModelMeetsRequirement, deriveCreditRequirements } from "../src/credit-quality";

test("the source rank and durable task requirements form a no-downgrade floor", () => {
  expect(
    deriveCreditRequirements({
      sourceKind: "claude_code",
      sourceModel: "sonnet",
      taskTiers: ["large", "small"],
      efforts: ["low", "high"],
      tools: true,
    }),
  ).toEqual({ minimumTier: "large", effort: "high" });
  expect(
    deriveCreditRequirements({
      sourceKind: "claude_code",
      sourceModel: "opus",
      taskTiers: ["small"],
      efforts: ["medium"],
      tools: false,
    }),
  ).toEqual({ minimumTier: "large", effort: "medium" });
  expect(
    deriveCreditRequirements({
      sourceKind: "codex",
      sourceModel: "gpt-6.1-sol",
      taskTiers: [],
      efforts: ["max"],
      tools: true,
    }),
  ).toEqual({ minimumTier: "medium", effort: "high" });
});

test("Claude Code max/xhigh cannot be lowered to API high, while Codex retains its native normalization", () => {
  for (const effort of ["xhigh", "max"]) {
    expect(
      deriveCreditRequirements({
        sourceKind: "claude_code",
        sourceModel: "opus",
        efforts: [effort],
        tools: true,
      }),
    ).toBeNull();
    expect(
      deriveCreditRequirements({
        sourceKind: "claude_code",
        sourceModel: "sonnet",
        efforts: ["high", effort, "medium"],
        tools: true,
      }),
    ).toBeNull();
    expect(
      deriveCreditRequirements({
        sourceKind: "codex",
        sourceModel: "gpt-6.1-sol",
        efforts: [effort],
        tools: true,
      }),
    ).toEqual({ minimumTier: "medium", effort: "high" });
  }
});

test("tool work raises a small source floor and an absent effort is conservatively high", () => {
  expect(deriveCreditRequirements({ sourceKind: "claude_code", sourceModel: "haiku", tools: true })).toEqual({
    minimumTier: "medium",
    effort: "high",
  });
  expect(deriveCreditRequirements({ sourceKind: "claude_code", sourceModel: "haiku", tools: false })).toEqual({
    minimumTier: "small",
    effort: "high",
  });
});

test("unknown source quality, unresolved auto and malformed persisted decisions cannot authorize a route", () => {
  for (const sourceModel of ["gpt-6-astra", "gpt-6.1-terra", "auto", "new-unranked-model", undefined]) {
    expect(
      deriveCreditRequirements({
        sourceKind: "codex",
        sourceModel,
        taskTiers: ["large"],
        efforts: ["high"],
        tools: true,
      }),
    ).toBeNull();
  }
  expect(
    deriveCreditRequirements({ sourceKind: "claude_code", sourceModel: "claude-fable-5-1", tools: true }),
  ).toBeNull();
  expect(deriveCreditRequirements({ sourceKind: "codex", sourceModel: "claude-opus-5-5", tools: true })).toBeNull();
  expect(deriveCreditRequirements({ sourceKind: "grok", sourceModel: "gpt-6.1-sol", tools: true })).toBeNull();
  expect(
    deriveCreditRequirements({ sourceKind: "codex", sourceModel: "gpt-6.1-sol", taskTiers: ["unknown"], tools: true }),
  ).toBeNull();
  expect(
    deriveCreditRequirements({ sourceKind: "codex", sourceModel: "gpt-6.1-sol", efforts: ["fast"], tools: true }),
  ).toBeNull();
});

test("source aliases and dated catalog identities keep the existing catalog's quality classification", () => {
  expect(
    deriveCreditRequirements({
      sourceKind: "claude_code",
      sourceModel: "claude-opus-5-5-20261001[1m]",
      tools: true,
      efforts: ["high"],
    }),
  ).toEqual({ minimumTier: "large", effort: "high" });
  expect(
    deriveCreditRequirements({
      sourceKind: "claude_code",
      sourceModel: "SONNET",
      tools: true,
      efforts: [null, undefined, "auto", "low"],
    }),
  ).toEqual({ minimumTier: "medium", effort: "low" });
});

test("API candidates must meet an explicit floor; the nearest smaller model is never substituted", () => {
  expect(creditModelMeetsRequirement("claude-opus-5-5", "large", "high")).toBe(true);
  expect(creditModelMeetsRequirement("claude-sonnet-5-5", "large", "high")).toBe(false);
  expect(creditModelMeetsRequirement("claude-haiku-5-5", "medium", "high")).toBe(false);
  expect(creditModelMeetsRequirement("gpt-6.1-sol", "medium", "high")).toBe(true);
  expect(creditModelMeetsRequirement("gpt-6-luna", "medium", "high")).toBe(false);
  expect(creditModelMeetsRequirement("gpt-6.1-sol", "large", "high")).toBe(false);
  expect(creditModelMeetsRequirement("gpt-6-astra", "large", "high")).toBe(false);
  expect(creditModelMeetsRequirement("claude-fable-5-1", "large", "high")).toBe(false);
  expect(creditModelMeetsRequirement("claude-opus-5-5", undefined, "high")).toBe(false);
  expect(creditModelMeetsRequirement("claude-opus-5-5", "large", undefined)).toBe(false);
});

test("a catalog effort restriction cannot silently lower the requested reasoning", () => {
  const model = MODEL_CATALOG["gpt-6.1-sol"]!;
  const original = model.efforts;
  try {
    model.efforts = ["low"];
    expect(creditModelMeetsRequirement("gpt-6.1-sol", "medium", "high")).toBe(false);
    expect(creditModelMeetsRequirement("gpt-6.1-sol", "medium", "low")).toBe(true);
  } finally {
    model.efforts = original;
  }
});
