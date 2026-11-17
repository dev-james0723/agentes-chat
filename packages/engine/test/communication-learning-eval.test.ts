import { expect, test } from "bun:test";
import {
  decideCandidate,
  type EvaluationArm,
  type EvaluationPolicy,
  type PairedEvaluation,
} from "../eval/communication-learning";
import seeds from "../eval/communication-learning-cases.json";
import { aggregateVerifiedEconomics, type UsageAttempt, type VerifiedOutcome } from "../src/harness-economics";

const policy: EvaluationPolicy = {
  approvalRef: "native-approved-policy",
  minimumIndependentTasks: 12,
  minimumTrialsPerArm: 3,
  qualityNonInferiorityMargin: 0.05,
  savingMetric: "tokens",
};

function arm(task: number, trial: number, name: string, tokens: number, accepted: boolean): EvaluationArm {
  const receiptId = `${task}-${trial}-${name}`;
  const usage: UsageAttempt = {
    id: receiptId,
    orgId: "org",
    provider: "fixture",
    model: "exact",
    billedTo: "org",
    inputTokens: tokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    usageSource: "metered",
    tokenDefinitions: { inputIncludesCache: false, outputIncludesReasoning: true },
    attribution: {
      taskId: `task-${task}`,
      taskRevision: 1,
      sourceRef: "native-trace",
      modelResolution: "provider_reported",
      effort: "high",
    },
    accounting: {
      amount: tokens,
      currency: "TST",
      unit: "unit",
      basis: "charged",
      sourceRef: "native-settlement",
      effectiveAt: "2026-11-16T00:00:00Z",
    },
  };
  const outcome: VerifiedOutcome = {
    id: receiptId,
    orgId: "org",
    taskId: `task-${task}`,
    taskRevision: 1,
    currentTaskRevision: 1,
    result: accepted ? "success" : "failure",
    producerId: "author",
    verification: {
      receiptId,
      orgId: "org",
      taskId: `task-${task}`,
      taskRevision: 1,
      result: accepted ? "success" : "failure",
      verifierId: "reviewer",
      evidenceRefs: ["native-evidence"],
    },
  };
  return {
    quality: { accepted, verifierId: "reviewer", receiptRef: receiptId },
    safety: { critical: 0, privacy: 0, authority: 0, verifierId: "reviewer", receiptRef: "resolved-safety" },
    route: {
      provider: "fixture",
      model: "exact",
      effort: "high",
      environment: "isolated",
      dataVersion: "v1",
      taskDifficulty: "matched",
      sourceRef: "native-route",
    },
    economics: aggregateVerifiedEconomics([usage], [outcome]),
  };
}
function evaluation(tasks = 12): PairedEvaluation {
  const trials: PairedEvaluation["trials"] = [];
  for (let task = 0; task < tasks; task++)
    for (let trial = 0; trial < 3; trial++)
      trials.push({
        taskId: `task-${task}`,
        trialId: `trial-${trial}`,
        order: (task + trial) % 2 ? "candidate_first" : "control_first",
        control: arm(task, trial, "control", trial === 0 ? 0 : 100, trial !== 0),
        candidate: arm(task, trial, "candidate", 80, true),
      });
  return {
    candidateId: "candidate-v1",
    authorId: "author",
    comparison: "B_vs_C",
    trials,
    review: {
      reviewerId: "reviewer",
      optimizerIds: ["author"],
      receiptRef: "native-review",
      candidateId: "candidate-v1",
      frozenAt: "2026-11-15T00:00:00Z",
      protectedSetCreatedAt: "2026-11-16T00:00:00Z",
      content: "protected_variants",
      storageRef: "native-reviewer-store",
      access: "reviewer_only",
      scorerVersion: "grader-v1",
      accessEvents: [],
      rollbackRef: "native-rollback",
    },
  };
}
const firstCandidate = (metrics: PairedEvaluation) => {
  const candidate = metrics.trials[0]?.candidate;
  if (!candidate) throw new Error("fixture candidate missing");
  return candidate;
};

test("decision gate reports independent task clusters and raw repeated-trial denominators", () => {
  // A large synthetic quality improvement exercises promote; this is not a real protected study.
  const result = decideCandidate(evaluation(100), policy);
  expect(result.decision).toBe("promote");
  expect(result.report.independentTasks).toBe(100);
  expect(result.report.pairedTrials).toBe(300);
  expect(result.report.quality.candidateAccepted).toBe(300);
  expect(result.report.savings95?.lower).toBeCloseTo(0.2);
  expect(result.report.tasks[0]?.control).toEqual({ rawTotal: 200, verifiedOutcomes: 2, perVerifiedOutcome: 100 });
  expect(result.evidenceRefs).toContain("native-review");
});
test("quality regression and critical safety privacy or authority failures reject", () => {
  const regression = evaluation(100);
  for (const [index, pair] of regression.trials.entries()) {
    const task = Math.floor(index / 3),
      trial = index % 3;
    pair.control = arm(task, trial, "control", 100, true);
    pair.candidate = arm(task, trial, "candidate", 80, false);
  }
  expect(decideCandidate(regression, policy).decision).toBe("reject");
  for (const failure of ["critical", "privacy", "authority"] as const) {
    const metrics = evaluation();
    firstCandidate(metrics).safety[failure] = 1;
    expect(decideCandidate(metrics, policy).decision).toBe("reject");
  }
});
test("missing usage, too few independent tasks, no control or route change hold", () => {
  const incomplete = evaluation();
  firstCandidate(incomplete).economics.tokens.total = null;
  expect(decideCandidate(incomplete, policy).reasons).toContain("incomplete_usage");
  const small = evaluation();
  small.trials = small.trials.filter((pair) => pair.taskId === "task-0");
  expect(decideCandidate(small, policy).reasons).toContain("too_few_independent_tasks");
  const noControl = evaluation();
  if (noControl.trials[0]) noControl.trials[0].control = undefined;
  expect(decideCandidate(noControl, policy).reasons).toContain("missing_control_or_candidate");
  const upgraded = evaluation();
  firstCandidate(upgraded).route.model = "upgraded";
  expect(decideCandidate(upgraded, policy).reasons).toContain("unmatched_route_or_task");
});
test("a small all-success cohort cannot establish a five-point quality margin", () => {
  const metrics = evaluation();
  for (const [index, pair] of metrics.trials.entries())
    pair.control = arm(Math.floor(index / 3), index % 3, "control", 100, true);
  expect(decideCandidate(metrics, policy).reasons).toContain("quality_noninferiority_not_established");
});
test("task-clustered per-outcome interval crossing zero is inconclusive", () => {
  const metrics = evaluation();
  for (const [index, pair] of metrics.trials.entries()) {
    const task = Math.floor(index / 3);
    pair.candidate = arm(task, index % 3, "candidate", task % 2 ? 80 : 120, true);
  }
  const result = decideCandidate(metrics, policy);
  expect(result.decision).toBe("hold");
  expect(result.report.savings95?.lower).toBeLessThan(0);
  expect(result.report.savings95?.upper).toBeGreaterThan(0);
});
test("optimizer grader or holdout access attempts reject and visible seeds cannot promote", () => {
  for (const resource of ["grader", "holdout"] as const) {
    const metrics = evaluation();
    if (metrics.review) metrics.review.accessEvents.push({ actorId: "author", resource, action: "attempt" });
    expect(decideCandidate(metrics, policy).reasons).toContain("protected_access_violation");
  }
  for (const content of ["visible_seeds", "synthetic"] as const) {
    const metrics = evaluation();
    if (metrics.review) metrics.review.content = content;
    expect(decideCandidate(metrics, policy).decision).toBe("hold");
  }
  expect(seeds.purpose).toContain("Visible development seeds");
  expect(seeds.paidOrLiveRunsAuthorized).toBe(false);
  expect(seeds.cases.every((seed) => seed.independentHoldout === false && seed.status === "NOT_RUN")).toBe(true);
});
test("reviewer authority, candidate freeze, duplicate trials and policy remain explicit gates", () => {
  const absent = evaluation();
  absent.review = undefined;
  expect(decideCandidate(absent, policy).decision).toBe("hold");
  const self = evaluation();
  if (self.review) self.review.reviewerId = "author";
  expect(decideCandidate(self, policy).decision).toBe("hold");
  const old = evaluation();
  if (old.review) old.review.protectedSetCreatedAt = "2020-01-01T00:00:00Z";
  expect(decideCandidate(old, policy).reasons).toContain("holdout_not_created_after_freeze");
  const duplicated = evaluation();
  const pair = duplicated.trials[0];
  if (pair) duplicated.trials.push(pair);
  expect(decideCandidate(duplicated, policy).reasons).toContain("duplicate_task_trial");
  expect(decideCandidate(evaluation(), { ...policy, approvalRef: "" }).decision).toBe("hold");
});

test("complete usage with zero verified successes cannot support an efficiency recommendation", () => {
  const metrics = evaluation();
  for (const [index, pair] of metrics.trials.entries())
    pair.candidate = arm(Math.floor(index / 3), index % 3, "candidate", 80, false);
  const result = decideCandidate(metrics, policy);
  expect(result.decision).toBe("hold");
  expect(result.reasons).toContain("zero_verified_outcome_denominator");
  expect(result.report.tasks[0]?.candidate).toEqual({ rawTotal: 240, verifiedOutcomes: 0, perVerifiedOutcome: null });
});
test("missing independent outcome evidence or a null canonical ratio holds despite complete raw usage", () => {
  for (const metric of ["tokens", "cash"] as const) {
    const missing = evaluation();
    const arm = firstCandidate(missing);
    arm.economics.outcomeEvidence = [];
    arm.economics.verifiedSuccessfulTasks = 0;
    arm.economics.tokensPerVerifiedOutcome = null;
    for (const money of arm.economics.costs.cash) money.perVerifiedOutcome = null;
    expect(decideCandidate(missing, { ...policy, savingMetric: metric }).reasons).toContain("incomplete_usage");
    const ratio = evaluation();
    if (metric === "tokens") firstCandidate(ratio).economics.tokensPerVerifiedOutcome = null;
    else for (const money of firstCandidate(ratio).economics.costs.cash) money.perVerifiedOutcome = null;
    expect(decideCandidate(ratio, { ...policy, savingMetric: metric }).reasons).toContain("incomplete_usage");
  }
});
test("cheap failed repetitions stay in the numerator and cannot reward a cost-per-success regression", () => {
  for (const failedCost of [0, 9]) {
    const metrics = evaluation();
    metrics.trials = [];
    for (let task = 0; task < 12; task++)
      for (let trial = 0; trial < 25; trial++)
        metrics.trials.push({
          taskId: `task-${task}`,
          trialId: `trial-${trial}`,
          order: trial % 2 ? "candidate_first" : "control_first",
          control: arm(task, trial, "control", 100, true),
          candidate: arm(task, trial, "candidate", trial === 0 ? failedCost : 102, trial !== 0),
        });
    for (const savingMetric of ["tokens", "cash"] as const) {
      const result = decideCandidate(metrics, { ...policy, savingMetric });
      expect(result.report.savings95?.mean).toBeCloseTo((100 - (24 * 102 + failedCost) / 24) / 100);
      expect(result.report.tasks[0]?.candidate).toEqual({
        rawTotal: 24 * 102 + failedCost,
        verifiedOutcomes: 24,
        perVerifiedOutcome: (24 * 102 + failedCost) / 24,
      });
      expect(result.report.pairedTrials).toBe(300);
      expect(result.decision).toBe("hold");
    }
  }
});
test("quality must bind the same task, result and independently checked outcome receipt as economics", () => {
  const unbound = evaluation();
  firstCandidate(unbound).quality.receiptRef = "a-different-receipt";
  expect(decideCandidate(unbound, policy).reasons).toContain("incomplete_usage");
  const wrongTask = evaluation();
  const evidence = firstCandidate(wrongTask).economics.outcomeEvidence[0];
  if (evidence) evidence.taskId = "another-task";
  expect(decideCandidate(wrongTask, policy).reasons).toContain("incomplete_usage");
  const falseGrade = evaluation();
  firstCandidate(falseGrade).quality.accepted = false;
  expect(decideCandidate(falseGrade, policy).reasons).toContain("incomplete_usage");
});
