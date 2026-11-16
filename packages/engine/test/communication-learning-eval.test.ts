import { expect, test } from "bun:test";
import { decideCandidate, type EvaluationPolicy, type PairedEvaluation } from "../eval/communication-learning";
import seeds from "../eval/communication-learning-cases.json";
import { aggregateVerifiedEconomics, type UsageAttempt, type VerifiedOutcome } from "../src/harness-economics";

const policy: EvaluationPolicy = {
  approvalRef: "native-approved-policy",
  minimumIndependentTasks: 12,
  minimumTrialsPerArm: 3,
  qualityNonInferiorityMargin: 0.05,
  savingMetric: "tokens",
};
function evaluation(): PairedEvaluation {
  const trials: PairedEvaluation["trials"] = [];
  for (let task = 0; task < 12; task++)
    for (let trial = 0; trial < 3; trial++) {
      const arm = (name: string, tokens: number) => {
        const usage: UsageAttempt = {
          id: `${task}-${trial}-${name}`,
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
          id: usage.id,
          orgId: "org",
          taskId: `task-${task}`,
          taskRevision: 1,
          currentTaskRevision: 1,
          result: "success",
          producerId: "author",
          verification: {
            receiptId: usage.id,
            orgId: "org",
            taskId: `task-${task}`,
            taskRevision: 1,
            result: "success",
            verifierId: "reviewer",
            evidenceRefs: ["native-evidence"],
          },
        };
        return {
          quality: { accepted: name === "candidate", verifierId: "reviewer", receiptRef: "resolved-quality" },
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
      };
      trials.push({
        taskId: `task-${task}`,
        trialId: `trial-${trial}`,
        order: (task + trial) % 2 ? "candidate_first" : "control_first",
        control: arm("control", 100),
        candidate: arm("candidate", 80),
      });
    }
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
  const result = decideCandidate(evaluation(), policy);
  expect(result.decision).toBe("promote");
  expect(result.report.independentTasks).toBe(12);
  expect(result.report.pairedTrials).toBe(36);
  expect(result.report.quality.candidateAccepted).toBe(36);
  expect(result.report.savings95?.lower).toBeCloseTo(0.2);
  expect(result.evidenceRefs).toContain("native-review");
});
test("quality regression and a critical safety privacy or authority failure reject", () => {
  const regression = evaluation();
  for (const pair of regression.trials) {
    if (pair.candidate) pair.candidate.quality.accepted = false;
    if (pair.control) pair.control.quality.accepted = true;
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
  for (const pair of metrics.trials) if (pair.control) pair.control.quality.accepted = true;
  expect(decideCandidate(metrics, policy).reasons).toContain("quality_noninferiority_not_established");
});
test("task-clustered interval crossing zero is inconclusive", () => {
  const metrics = evaluation();
  for (const pair of metrics.trials)
    if (pair.candidate) pair.candidate.economics.tokens.total = Number(pair.taskId.split("-")[1]) % 2 ? 80 : 120;
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
test("reviewer authority, candidate freeze, trial duplicates, policy and rollback remain explicit gates", () => {
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
