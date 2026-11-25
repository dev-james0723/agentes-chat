import { afterEach, expect, test } from "bun:test";
import { MODEL_CATALOG, type ModelInfo, type ModelUsage } from "@agenteschat/providers";
import { assertCreditPricingEvidence, creditPricingProfile, creditReceiptCost } from "../src/credit-pricing";

const MODEL = "credit-pricing-synthetic-model";
const NOW = new Date("2026-11-20T12:00Z");
afterEach(() => {
  delete MODEL_CATALOG[MODEL];
});
function model(over: Partial<ModelInfo> = {}) {
  MODEL_CATALOG[MODEL] = {
    provider: "openai",
    label: "Synthetic tariff",
    serverSideFallback: false,
    contextWindow: 1000,
    maxOutputTokens: 500,
    prices: { input: 100, output: 200, cacheRead: 10, cacheWrite: 125 },
    ...over,
  };
  return creditPricingProfile(MODEL);
}
function currentModel(): ModelInfo {
  const info = MODEL_CATALOG[MODEL];
  if (!info) throw new Error("synthetic model missing");
  return info;
}
const usage: ModelUsage = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 30 };
const evidence = (profileHash: string) => ({
  evidenceRef: "official-pricing-test",
  profileHash,
  verifiedAt: new Date("2026-11-20T11:59Z"),
  validUntil: new Date("2026-11-20T13:00Z"),
});

test("a profile is immutable descriptive data with a deterministic exact tariff fingerprint", () => {
  const profile = model();
  expect(profile.profileHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(creditPricingProfile(MODEL).profileHash).toBe(profile.profileHash);
  expect(Object.isFrozen(profile)).toBe(true);
  expect(Object.isFrozen(profile.prices)).toBe(true);
  expect(profile).not.toHaveProperty("verifiedAt");
  MODEL_CATALOG[MODEL] = { ...currentModel(), prices: { ...profile.prices, input: 101 } };
  expect(creditPricingProfile(MODEL).profileHash).not.toBe(profile.profileHash);
  expect(profile.prices.input).toBe(100);
});

test("zero or missing paid cache rates, unsupported introductory tariffs and unpriced models fail closed", () => {
  for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    model();
    currentModel().prices[field] = 0;
    expect(() => creditPricingProfile(MODEL)).toThrow("pricing_unverified");
  }
  expect(() =>
    model({ intro: { until: "2027-01-01", prices: { input: 50, output: 100, cacheRead: 5, cacheWrite: 60 } } }),
  ).toThrow("pricing_unverified");
  expect(() => model({ unpriced: true })).toThrow("pricing_unverified");
  expect(() => model({ endpoint: "custom-endpoint" })).toThrow("pricing_unverified");
  expect(() => creditPricingProfile("unknown-model")).toThrow("pricing_unverified");
});

test("owner evidence must be current, bounded to 24 hours and exactly match the tariff", () => {
  const profile = model();
  const proof = evidence(profile.profileHash);
  expect(assertCreditPricingEvidence(MODEL, proof, NOW).profileHash).toBe(profile.profileHash);
  expect(() => assertCreditPricingEvidence(MODEL, undefined as never, NOW)).toThrow("pricing_unverified");
  expect(() =>
    assertCreditPricingEvidence(MODEL, { ...proof, verifiedAt: new Date("2026-11-20T12:01Z") }, NOW),
  ).toThrow("pricing_unverified");
  expect(() => assertCreditPricingEvidence(MODEL, { ...proof, validUntil: new Date("2026-11-22") }, NOW)).toThrow(
    "pricing_unverified",
  );
  expect(() =>
    assertCreditPricingEvidence(MODEL, { ...proof, validUntil: new Date("2026-11-20T12:01Z") }, NOW),
  ).toThrow("pricing_expired");
  expect(() => assertCreditPricingEvidence(MODEL, { ...proof, profileHash: `sha256:${"0".repeat(64)}` }, NOW)).toThrow(
    "pricing_changed",
  );
});

test("receipt pricing uses the admission snapshot after a catalog edit and survives JSON persistence", () => {
  const profile = model();
  const expected = 100 * 100 + 10 * 200 + 20 * 10 + 30 * 125;
  MODEL_CATALOG[MODEL] = {
    ...currentModel(),
    prices: { input: 10000, output: 20000, cacheRead: 1000, cacheWrite: 12500 },
  };
  expect(creditReceiptCost(profile, usage)).toBe(expected);
  expect(creditReceiptCost(JSON.parse(JSON.stringify(profile)), usage)).toBe(expected);
  expect(() => creditReceiptCost({ ...profile, prices: { ...profile.prices, input: 101 } }, usage)).toThrow(
    "pricing_changed",
  );
});

test("long-context and one-hour cache categories reconcile at their explicit pinned rates", () => {
  const openai = creditPricingProfile("gpt-6.1-sol");
  expect(
    creditReceiptCost(openai, { inputTokens: 273000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }),
  ).toBe(273000 * 4000 + 100 * 15000);
  const claude = creditPricingProfile("claude-sonnet-5-5");
  expect(
    creditReceiptCost(
      claude,
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1000, cacheWriteLongTokens: 1000 },
      "1h",
    ),
  ).toBe(4_000_000);
  expect(() => creditReceiptCost(openai, usage, "1h")).toThrow("unsupported_capability");
  expect(() => creditReceiptCost(claude, { ...usage, cacheWriteLongTokens: 1 })).toThrow("reconciliation_required");
});

test("invalid receipts cannot turn unknown usage into zero cost and valid overrun costs are not clamped", () => {
  const profile = model();
  for (const bad of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => creditReceiptCost(profile, { ...usage, outputTokens: bad })).toThrow();
  }
  expect(() => creditReceiptCost(profile, { ...usage, cacheWriteLongTokens: 31 }, "1h")).toThrow();
  expect(creditReceiptCost(profile, { ...usage, outputTokens: 1000 })).toBeGreaterThan(100_000);
});
