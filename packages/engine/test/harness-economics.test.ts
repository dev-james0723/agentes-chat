import { describe, expect, test } from "bun:test";
import { aggregateVerifiedEconomics, type UsageAttempt, type VerifiedOutcome } from "../src/harness-economics";

const accounting = (): NonNullable<UsageAttempt["accounting"]> => ({
  amount: 2,
  currency: "TST",
  unit: "fixture-unit",
  basis: "charged",
  sourceRef: "provider-receipt",
  effectiveAt: "2026-11-16T00:00:00Z",
});
const verificationReceipt = (): NonNullable<VerifiedOutcome["verification"]> => ({
  receiptId: "resolved-receipt",
  orgId: "org",
  taskId: "task",
  taskRevision: 2,
  result: "success",
  verifierId: "independent-reviewer",
  evidenceRefs: ["test-receipt"],
});

const attempt = (id: string, overrides: Partial<UsageAttempt> = {}): UsageAttempt => ({
  id,
  orgId: "org",
  runId: "run",
  kind: "agent",
  provider: "fixture",
  model: "model-exact",
  requestedModel: "alias",
  billedTo: "org",
  partial: false,
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 2,
  cacheWriteTokens: 1,
  reasoningTokens: 3,
  usageSource: "metered",
  tokenDefinitions: { inputIncludesCache: false, outputIncludesReasoning: true },
  attribution: {
    taskId: "task",
    taskRevision: 2,
    attemptId: id,
    role: "worker",
    modelResolution: "provider_reported",
    effort: "high",
    sourceRef: "native-trace",
  },
  accounting: {
    amount: 2,
    currency: "TST",
    unit: "fixture-unit",
    basis: "charged",
    sourceRef: "provider-receipt",
    effectiveAt: "2026-11-16T00:00:00Z",
  },
  ...overrides,
});
const outcome = (overrides: Partial<VerifiedOutcome> = {}): VerifiedOutcome => ({
  id: "outcome",
  orgId: "org",
  taskId: "task",
  taskRevision: 2,
  currentTaskRevision: 2,
  result: "success",
  producerId: "worker",
  verification: {
    receiptId: "resolved-receipt",
    orgId: "org",
    taskId: "task",
    taskRevision: 2,
    result: "success",
    verifierId: "independent-reviewer",
    evidenceRefs: ["test-receipt"],
  },
  admittedAt: "2026-11-16T00:00:00Z",
  acceptedOutcomeAt: "2026-11-16T00:00:10Z",
  latency: { queueMs: 1000, executionMs: 4000, reviewMs: 2000, humanWaitMs: 3000 },
  ...overrides,
});

describe("verified economics", () => {
  test("includes_failed_attempt_and_review", () => {
    const first = attempt("failed", { partial: true });
    const second = attempt("review", {
      attribution: { ...attempt("review").attribution, role: "review", parentRunId: "run" },
      accounting: { ...accounting(), amount: 3 },
    });
    const report = aggregateVerifiedEconomics([first, second], [outcome()]);
    expect(report.costs.cash[0]?.total).toBe(5);
    expect(report.costs.cash[0]?.perVerifiedOutcome).toBe(5);
    expect(report.attempts.partial).toBe(1);
    expect(report.tokens.total).toBeNull();
  });
  test("includes_jev", () => {
    const jev = attempt("jev", {
      kind: "router",
      purpose: "route",
      billedTo: "platform",
      attribution: { ...attempt("jev").attribution, role: "jev" },
    });
    const report = aggregateVerifiedEconomics([attempt("worker"), jev], [outcome()]);
    expect(report.costs.cash[0]?.total).toBe(4);
    expect(report.routes.map((route) => route.role)).toEqual(["worker", "jev"]);
  });
  test("does_not_double_count_reasoning", () => {
    const report = aggregateVerifiedEconomics([attempt("one")], [outcome()]);
    expect(report.tokens.total).toBe(18);
    expect(report.tokensPerVerifiedOutcome).toBe(18);
    expect(report.reasoningTokens.total).toBe(3);
  });
  test("adds_only_disjoint_reasoning_and_does_not_add_cache_subsets", () => {
    expect(
      aggregateVerifiedEconomics(
        [
          attempt("one", {
            tokenDefinitions: { inputIncludesCache: false, outputIncludesReasoning: false },
          }),
        ],
        [outcome()],
      ).tokens.total,
    ).toBe(21);
    expect(
      aggregateVerifiedEconomics(
        [
          attempt("one", {
            inputTokens: 13,
            cacheWriteLongTokens: 1,
            tokenDefinitions: { inputIncludesCache: true, outputIncludesReasoning: true },
          }),
        ],
        [outcome()],
      ).tokens.total,
    ).toBe(18);
  });
  test("unknown_usage_stays_unknown", () => {
    const report = aggregateVerifiedEconomics(
      [attempt("known"), attempt("unknown", { inputTokens: null, accounting: null })],
      [outcome()],
    );
    expect(report.tokens.total).toBeNull();
    expect(report.tokens.knownSubtotal).toBe(18);
    expect(report.tokens.unknown).toBe(1);
    expect(report.costs.cash[0]?.total).toBeNull();
    expect(report.costs.cash[0]?.knownSubtotal).toBe(2);
    expect(report.costs.cash[0]?.perVerifiedOutcome).toBeNull();
    expect(report.coverage.cash.complete).toBe(false);
    expect(report.tokensPerVerifiedOutcome).toBeNull();
    expect(report.savingsClaim).toBe("not_evaluated");
  });
  test("zero_success_denominator_is_null", () => {
    const report = aggregateVerifiedEconomics([attempt("one")], [outcome({ result: "failure" })]);
    expect(report.verifiedSuccessfulTasks).toBe(0);
    expect(report.costs.cash[0]?.total).toBe(2);
    expect(report.costs.cash[0]?.perVerifiedOutcome).toBeNull();
    expect(report.tokensPerVerifiedOutcome).toBeNull();
  });
  test("subscription_is_not_cash", () => {
    const report = aggregateVerifiedEconomics(
      [
        attempt("plan", {
          billedTo: "plan",
          accounting: { ...accounting(), basis: "plan_estimate", amount: 7 },
        }),
      ],
      [outcome()],
    );
    expect(report.costs.cash).toEqual([]);
    expect(report.costs.planEstimates[0]?.total).toBe(7);
    expect(report.coverage.cash.complete).toBe(true);
    const invalid = aggregateVerifiedEconomics([attempt("plan", { billedTo: "plan" })], [outcome()]);
    expect(invalid.costs.cash).toEqual([]);
    expect(invalid.coverage.accounting.complete).toBe(false);
  });
  test("deduplicates_same_usage_receipt", () => {
    const one = attempt("same");
    const reordered = Object.fromEntries(Object.entries(one).reverse()) as unknown as UsageAttempt;
    const report = aggregateVerifiedEconomics([one, reordered], [outcome()]);
    expect(report.attempts.unique).toBe(1);
    expect(report.attempts.duplicateReceipts).toBe(1);
    expect(report.costs.cash[0]?.total).toBe(2);
    expect(report.tokens.total).toBe(18);
  });
  test("conflicting_duplicate_receipts_are_quarantined_not_order_selected", () => {
    const first = attempt("same");
    const second = attempt("same", { accounting: { ...accounting(), amount: 999 } });
    const report = aggregateVerifiedEconomics([first, second, attempt("other")], [outcome()]);
    const reverse = aggregateVerifiedEconomics([second, first, attempt("other")], [outcome()]);
    expect(report.costs.cash[0]?.total).toBeNull();
    expect(report.costs.cash[0]?.knownSubtotal).toBe(2);
    expect(report.tokens.total).toBeNull();
    expect(report.attempts.conflictingReceipts).toBe(1);
    expect(reverse.costs).toEqual(report.costs);
  });
  test("tenant_scoped_identity_and_multiple_currencies", () => {
    const report = aggregateVerifiedEconomics(
      [attempt("same"), attempt("same", { orgId: "another-org", accounting: { ...accounting(), currency: "EUR" } })],
      [outcome()],
    );
    expect(report.attempts.unique).toBe(2);
    expect(report.attempts.duplicateReceipts).toBe(0);
    expect(report.costs.cash.map((money) => [money.currency, money.total, money.perVerifiedOutcome])).toEqual([
      ["TST", 2, 2],
      ["EUR", 2, 2],
    ]);
  });
  test("catalog_and_local_estimates_are_separate_from_cash", () => {
    const report = aggregateVerifiedEconomics(
      [
        attempt("catalog", { accounting: { ...accounting(), basis: "catalog_estimate" } }),
        attempt("local", { accounting: { ...accounting(), basis: "local_estimate" } }),
      ],
      [outcome()],
    );
    expect(report.costs.cash).toEqual([]);
    expect(report.costs.catalogEstimates[0]?.total).toBe(2);
    expect(report.costs.localEstimates[0]?.total).toBe(2);
    expect(report.coverage.cash.complete).toBe(false);
  });
  test("native_legacy_cost_does_not_invent_pricing_source", () => {
    const report = aggregateVerifiedEconomics(
      [
        attempt("legacy", {
          costNanoUsd: 42,
          accounting: undefined,
          usageSource: undefined,
        }),
      ],
      [outcome()],
    );
    expect(report.costs.unclassifiedNativeNanoUsd.total).toBe(42);
    expect(report.costs.cash).toEqual([]);
    expect(report.coverage.accounting.complete).toBe(false);
    expect(report.coverage.meteredTokens.complete).toBe(false);
  });
  test("multiple_outcomes_for_one_task_count_once", () => {
    const report = aggregateVerifiedEconomics([attempt("one")], [outcome(), outcome({ id: "second" })]);
    expect(report.verifiedSuccessfulTasks).toBe(1);
    expect(report.costs.cash[0]?.perVerifiedOutcome).toBe(2);
    expect(report.latency.wallMs.total).toBe(10000);
  });
  test("lifecycle_done_and_self_review_do_not_verify_an_outcome", () => {
    const report = aggregateVerifiedEconomics(
      [attempt("one")],
      [
        outcome({ verification: null }),
        outcome({ id: "self", verification: { ...verificationReceipt(), verifierId: "worker" } }),
      ],
    );
    expect(report.verifiedSuccessfulTasks).toBe(0);
    expect(report.rejectedOutcomes).toHaveLength(2);
  });
  test("verification_matches_current_revision_exactly", () => {
    const report = aggregateVerifiedEconomics(
      [attempt("one")],
      [
        outcome({ currentTaskRevision: 3 }),
        outcome({ id: "mismatch", verification: { ...verificationReceipt(), taskRevision: 1 } }),
      ],
    );
    expect(report.verifiedSuccessfulTasks).toBe(0);
    expect(report.rejectedOutcomes.every((item) => item.reason === "conflicting_verification_receipt")).toBe(true);
    const mismatch = outcome({ verification: { ...verificationReceipt(), taskRevision: 1 } });
    expect(aggregateVerifiedEconomics([], [mismatch]).rejectedOutcomes[0]?.reason).toBe("receipt_revision_mismatch");
  });
  test("another_usage_revision_cannot_complete_outcome_coverage", () => {
    const report = aggregateVerifiedEconomics(
      [
        attempt("old", {
          attribution: { ...attempt("old").attribution, taskRevision: 1 },
        }),
      ],
      [outcome()],
    );
    expect(report.verifiedSuccessfulTasks).toBe(1);
    expect(report.coverage.outcomesWithUsage.complete).toBe(false);
    expect(report.costs.cash[0]?.perVerifiedOutcome).toBeNull();
    expect(report.tokensPerVerifiedOutcome).toBeNull();
  });
  test("unattributed_attempts_remain_in_cost_and_block_ratios", () => {
    const report = aggregateVerifiedEconomics(
      [
        attempt("known"),
        attempt("unlinked", {
          attribution: undefined,
        }),
      ],
      [outcome()],
    );
    expect(report.costs.cash[0]?.total).toBe(4);
    expect(report.costs.cash[0]?.perVerifiedOutcome).toBeNull();
    expect(report.coverage.attribution.unknown).toBe(1);
  });
  test("missing_overlap_definition_and_partial_counters_are_unknown", () => {
    const report = aggregateVerifiedEconomics(
      [attempt("ambiguous", { tokenDefinitions: undefined }), attempt("partial", { partial: true })],
      [outcome()],
    );
    expect(report.tokens.total).toBeNull();
    expect(report.tokens.knownSubtotal).toBeNull();
    expect(report.tokens.unknown).toBe(2);
  });
  test("invalid_numbers_and_inconsistent_subsets_are_unknown", () => {
    for (const overrides of [
      { inputTokens: -1 },
      { outputTokens: Number.NaN },
      { cacheWriteLongTokens: 2 },
      { inputTokens: Number.MAX_SAFE_INTEGER + 1 },
      { tokenDefinitions: { inputIncludesCache: true, outputIncludesReasoning: true }, cacheReadTokens: 20 },
      { reasoningTokens: 6 },
    ] satisfies Partial<UsageAttempt>[]) {
      expect(aggregateVerifiedEconomics([attempt("invalid", overrides)], [outcome()]).tokens.total).toBeNull();
    }
    const report = aggregateVerifiedEconomics(
      [
        attempt("money", {
          accounting: { ...accounting(), amount: Infinity },
        }),
      ],
      [outcome()],
    );
    expect(report.costs.cash).toEqual([]);
    expect(report.coverage.cash.complete).toBe(false);
  });
  test("exact_model_effort_and_human_wait_are_preserved", () => {
    const report = aggregateVerifiedEconomics(
      [
        attempt("old"),
        attempt("upgrade", {
          model: "model-upgraded",
          attribution: { ...attempt("upgrade").attribution, effort: "low", role: "review" },
        }),
      ],
      [outcome()],
    );
    expect(report.routes.map((route) => [route.model, route.requestedModel, route.effort])).toEqual([
      ["model-exact", "alias", "high"],
      ["model-upgraded", "alias", "low"],
    ]);
    expect(report.latency.humanWaitMs.total).toBe(3000);
    expect(report.latency.wallMs.total).toBe(10000);
    expect(report.savingsClaim).toBe("not_evaluated");
  });
  test("missing_latency_and_empty_inputs_are_not_zero_imputed", () => {
    const report = aggregateVerifiedEconomics(
      [attempt("one")],
      [
        outcome({
          admittedAt: undefined,
          latency: { executionMs: 4000 },
        }),
      ],
    );
    expect(report.latency.wallMs.total).toBeNull();
    expect(report.latency.executionMs.total).toBe(4000);
    expect(report.latency.humanWaitMs.total).toBeNull();
    const empty = aggregateVerifiedEconomics([], []);
    expect(empty.tokens.total).toBeNull();
    expect(empty.tokensPerVerifiedOutcome).toBeNull();
    expect(empty.latency.wallMs.total).toBeNull();
  });
  test("receipt_scope_result_and_reuse_are_checked", () => {
    for (const verification of [
      { ...verificationReceipt(), taskId: "other" },
      { ...verificationReceipt(), orgId: "other" },
      { ...verificationReceipt(), result: "failure" as const },
    ])
      expect(aggregateVerifiedEconomics([], [outcome({ verification })]).verifiedSuccessfulTasks).toBe(0);
    const reused = outcome({
      id: "other",
      taskId: "other",
      verification: { ...verificationReceipt(), taskId: "other" },
    });
    expect(aggregateVerifiedEconomics([], [outcome(), reused]).verifiedSuccessfulTasks).toBe(0);
  });
  test("aggregate_overflow_is_unknown_even_when_each_receipt_is_safe", () => {
    const large = attempt("large", {
      accounting: { ...accounting(), amount: Number.MAX_SAFE_INTEGER },
    });
    const report = aggregateVerifiedEconomics([large, attempt("another")], [outcome()]);
    expect(report.costs.cash[0]?.total).toBeNull();
    expect(report.costs.cash[0]?.knownSubtotal).toBeNull();
    expect(report.costs.cash[0]?.overflow).toBe(true);
  });
  test("conflicting_outcome_receipts_cannot_expand_denominator", () => {
    const report = aggregateVerifiedEconomics([attempt("one")], [outcome(), outcome({ result: "failure" })]);
    expect(report.verifiedSuccessfulTasks).toBe(0);
    expect(report.rejectedOutcomes[0]?.reason).toBe("conflicting_outcome_receipt");
  });
});

test("independently checked failures preserve cost and receipt evidence without a success denominator", () => {
  const failed = outcome({ result: "failure", verification: { ...verificationReceipt(), result: "failure" } });
  const report = aggregateVerifiedEconomics([attempt("failed"), attempt("review")], [failed]);
  expect(report.verifiedSuccessfulTasks).toBe(0);
  expect(report.tokens.total).toBe(36);
  expect(report.tokensPerVerifiedOutcome).toBeNull();
  expect(report.costs.cash[0]?.total).toBe(4);
  expect(report.costs.cash[0]?.perVerifiedOutcome).toBeNull();
  expect(report.outcomeEvidence).toEqual([
    {
      id: failed.id,
      orgId: "org",
      taskId: "task",
      taskRevision: 2,
      result: "failure",
      verificationReceiptId: "resolved-receipt",
      verifierId: "independent-reviewer",
    },
  ]);
  const unverified = aggregateVerifiedEconomics([attempt("one")], [outcome({ result: "failure", verification: null })]);
  expect(unverified.outcomeEvidence).toEqual([]);
});
