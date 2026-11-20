import { describe, expect, test } from "bun:test";
import { annotateProviderFailure, ProviderError } from "@agenteschat/providers";
import {
  CREDIT_REFUSALS,
  CreditRouteRefusal,
  classifyCreditFailure,
  creditOutcomeOf,
  creditRouteNotice,
  creditRouteUnknownNotice,
  endsCreditRoute,
  noteCreditOutcome,
} from "../src/credit-route";

const normalized = (status: number | undefined, body: unknown, headers = new Headers()) =>
  annotateProviderFailure(new ProviderError("fixture", false, status), { status, error: body, headers });

describe("grant failure accounting", () => {
  for (const code of ["credit_balance_exhausted", "insufficient_quota"])
    test(`OpenAI 429 ${code} is exhausted`, () => {
      expect(classifyCreditFailure(normalized(429, { code }))).toEqual({ class: "exhausted", charged: "no" });
    });
  for (const code of [
    "organization_spend_limit_exceeded",
    "project_spend_limit_exceeded",
    "organization_usage_limit_exceeded",
    "enforced_spend_limit_reached",
  ])
    test(`429 spending code ${code} ends the route`, () => {
      const error = normalized(429, { type: "rate_limit_error", details: { error_code: code } });
      expect(classifyCreditFailure(error)).toEqual({ class: "billing_blocked", charged: "no" });
      expect(endsCreditRoute(classifyCreditFailure(error).class)).toBe(true);
    });
  test("explicit Claude spending-limit words precede generic rate_limit", () => {
    const error = new ProviderError("You have reached your specified workspace API usage limits", false, 400);
    expect(classifyCreditFailure(error)).toEqual({ class: "billing_blocked", charged: "no" });
  });
  test("genuine throttling preserves Retry-After", () => {
    const error = annotateProviderFailure(new ProviderError("rate limited by provider", true, 429), {
      status: 429,
      code: "rate_limit_exceeded",
      headers: new Headers({ "retry-after": "3" }),
    });
    expect(classifyCreditFailure(error)).toEqual({ class: "rate_limit", charged: "no", retryAfterMs: 3000 });
    expect(endsCreditRoute("rate_limit")).toBe(false);
  });
  test("partial usage always holds even when a final error claims exhausted", () => {
    const error = normalized(429, { code: "credit_balance_exhausted" });
    error.partial = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, outputChars: 0 };
    expect(classifyCreditFailure(error)).toEqual({ class: "unknown", charged: "unknown" });
  });
  test("inferred status from in-stream error is not a zero-cost proof", () => {
    const error = annotateProviderFailure(new ProviderError("no prepaid credit", false, 429), {
      code: "credit_balance_exhausted",
    });
    expect(classifyCreditFailure(error)).toEqual({ class: "unknown", charged: "unknown" });
  });
  for (const status of [undefined, 408, 409, 500, 503, 529])
    test(`unknown delivery is held for status ${status}`, () => {
      expect(classifyCreditFailure(normalized(status, { code: "credit_balance_exhausted" }))).toEqual({
        class: "unknown",
        charged: "unknown",
      });
    });
  test("an arbitrary error cannot release funds", () => {
    expect(classifyCreditFailure({ status: 429, code: "credit_balance_exhausted" })).toEqual({
      class: "unknown",
      charged: "unknown",
    });
  });
  test("known credential and validation refusals release only their own attempt", () => {
    expect(classifyCreditFailure(new ProviderError("invalid provider API key", false, 401))).toEqual({
      class: "credential",
      charged: "no",
    });
    expect(classifyCreditFailure(new ProviderError("bad parameters", false, 400))).toEqual({
      class: "rejected",
      charged: "no",
    });
  });
});

test("proof refusals and weak outcomes preserve compatibility without mutating errors", () => {
  expect(CREDIT_REFUSALS).toContain("spend_approval_required");
  expect(new CreditRouteRefusal("budget_exhausted").retryable).toBe(false);
  const error = new Error("fixture"),
    before = Object.keys(error);
  const outcome = { attemptId: "fixture", class: "unknown" as const, hold: "unknown" as const };
  noteCreditOutcome(error, outcome);
  expect(creditOutcomeOf(error)).toEqual(outcome);
  expect(Object.keys(error)).toEqual(before);
  expect(creditOutcomeOf("fixture")).toBeNull();
});

test("notices distinguish provider, omit arbitrary model text and never invite replay", () => {
  expect(creditRouteNotice("gpt-6-sol", "openai")).toContain("OpenAI API grant (gpt-6-sol)");
  expect(creditRouteNotice("claude-sonnet-5-5")).toContain("Claude API grant (claude-sonnet-5-5)");
  expect(creditRouteNotice("sk-live-secret-should-not-forward", "openai")).not.toContain("sk-live");
  expect(creditRouteUnknownNotice("openai")).toContain("remains reserved");
  expect(creditRouteUnknownNotice()).not.toContain("Send the message again");
});
