/**
 * Offline decision/report seam beside the existing eval harnesses. No providers, environment,
 * hidden questions, storage writes or enrollment occur here. Visible cases are development seeds.
 *
 * TRUST BOUNDARY: only a server reviewer adapter may supply the resolved receipt projections below.
 * Their strings/booleans do not establish authority or authenticate a receipt. Never accept this
 * object from an optimizer/model/API body. Native reviewer-controlled storage, eligibility and ACL
 * resolution are required before a real decision; this module does not claim they exist.
 * A promote result is a statistical recommendation, never activation or a production improvement.
 */
import type { EconomicsReport } from "../src/harness-economics";

export interface EvaluationPolicy {
  approvalRef: string;
  minimumIndependentTasks: number;
  minimumTrialsPerArm: number;
  qualityNonInferiorityMargin: number;
  savingMetric: "tokens" | "cash";
}
export interface EvaluationArm {
  quality: { accepted: boolean; verifierId: string; receiptRef: string };
  safety: { critical: number; privacy: number; authority: number; verifierId: string; receiptRef: string };
  route: {
    provider: string;
    model: string;
    effort: string;
    environment: string;
    dataVersion: string;
    taskDifficulty: string;
    sourceRef: string;
  };
  /** Computed over ALL authoritative attempts, including failures, retries, Jev and review. */
  economics: EconomicsReport;
}
export interface PairedTrial {
  taskId: string;
  trialId: string;
  order: "control_first" | "candidate_first";
  control?: EvaluationArm;
  candidate?: EvaluationArm;
}
export interface PairedEvaluation {
  candidateId: string;
  authorId: string;
  comparison: "A_vs_B" | "B_vs_C";
  trials: PairedTrial[];
  review?: {
    reviewerId: string;
    optimizerIds: string[];
    receiptRef: string;
    candidateId: string;
    frozenAt: string;
    protectedSetCreatedAt: string;
    content: "protected_variants" | "visible_seeds" | "synthetic";
    storageRef: string;
    access: "reviewer_only" | "optimizer_accessible";
    scorerVersion: string;
    accessEvents: { actorId: string; resource: "grader" | "holdout"; action: "attempt" | "read" | "write" }[];
    rollbackRef: string;
  };
}
export interface Interval95 {
  mean: number;
  lower: number;
  upper: number;
}
export interface CandidateDecision {
  decision: "promote" | "hold" | "reject";
  reasons: string[];
  evidenceRefs: string[];
  report: {
    independentTasks: number;
    pairedTrials: number;
    controlTrials: number;
    candidateTrials: number;
    quality: { controlAccepted: number; candidateAccepted: number };
    qualityDifference95: Interval95 | null;
    savings95: Interval95 | null;
    intervalMethod: "task_mean_paired_t_conservative_95";
    qualityIntervalMethod: "task_cluster_hoeffding_95";
    tasks: { taskId: string; pairedTrials: number; qualityDifference: number | null; saving: number | null }[];
    comparison: PairedEvaluation["comparison"];
    savingMetric: EvaluationPolicy["savingMetric"];
    evidenceTier: string;
  };
}
const known = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const count = (value: unknown): value is number => finite(value) && Number.isSafeInteger(value) && value >= 0;
const mean = (values: number[]) => values.reduce((sum, value) => sum + value / values.length, 0);

/** Two-sided t critical values. For df>30 retain df=30, making the interval conservative. */
const T95 = [
  0, 12.706205, 4.302653, 3.182447, 2.776445, 2.570582, 2.446912, 2.364624, 2.306005, 2.262158, 2.228139, 2.200986,
  2.178813, 2.160369, 2.144787, 2.13145, 2.119906, 2.109816, 2.100923, 2.093025, 2.085964, 2.079614, 2.073874, 2.068658,
  2.063899, 2.059539, 2.055529, 2.051831, 2.048407, 2.04523, 2.042273,
];

function interval(values: number[]): Interval95 | null {
  if (values.length < 2 || !values.every(finite)) return null;
  const average = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2 / (values.length - 1), 0);
  const critical = T95[Math.min(values.length - 1, 30)];
  if (!finite(critical)) return null;
  const radius = critical * Math.sqrt(variance / values.length);
  return [average, radius].every(finite) ? { mean: average, lower: average - radius, upper: average + radius } : null;
}

function measuredCost(arm: EvaluationArm, policy: EvaluationPolicy): { value: number; unit: string } | null {
  const economics = arm.economics;
  if (
    !economics.coverage.attribution.complete ||
    !economics.coverage.exactModel.complete ||
    !economics.coverage.effort.complete
  )
    return null;
  if (policy.savingMetric === "tokens") {
    const value = economics.tokens.total;
    return economics.coverage.meteredTokens.complete && count(value) ? { value, unit: "tokens" } : null;
  }
  // One exact currency+unit only; no exchange rates, subscriptions or catalog estimates are cash.
  const cash = economics.costs.cash;
  const amount = cash[0];
  return economics.coverage.cash.complete &&
    economics.coverage.accounting.complete &&
    cash.length === 1 &&
    amount &&
    count(amount.total)
    ? { value: amount.total, unit: JSON.stringify([amount.currency, amount.unit]) }
    : null;
}

export function decideCandidate(metrics: PairedEvaluation, policy: EvaluationPolicy): CandidateDecision {
  const hold = new Set<string>();
  const reject = new Set<string>();
  const evidence = new Set<string>();
  const review = metrics.review;
  if (
    !known(policy.approvalRef) ||
    !count(policy.minimumIndependentTasks) ||
    policy.minimumIndependentTasks < 2 ||
    !count(policy.minimumTrialsPerArm) ||
    policy.minimumTrialsPerArm < 1 ||
    !finite(policy.qualityNonInferiorityMargin) ||
    policy.qualityNonInferiorityMargin < 0 ||
    policy.qualityNonInferiorityMargin > 0.05 ||
    !["tokens", "cash"].includes(policy.savingMetric)
  )
    hold.add("invalid_or_unapproved_policy");
  else evidence.add(policy.approvalRef);
  if (!known(metrics.candidateId) || !known(metrics.authorId) || !["A_vs_B", "B_vs_C"].includes(metrics.comparison))
    hold.add("invalid_comparison");
  if (
    !review ||
    !known(review.receiptRef) ||
    !known(review.reviewerId) ||
    review.reviewerId === metrics.authorId ||
    review.optimizerIds.includes(review.reviewerId) ||
    !review.optimizerIds.includes(metrics.authorId) ||
    review.candidateId !== metrics.candidateId ||
    !known(review.storageRef) ||
    !known(review.scorerVersion) ||
    !known(review.rollbackRef)
  )
    hold.add("missing_independent_server_review");
  if (review) {
    evidence.add(review.receiptRef);
    if (review.content !== "protected_variants") hold.add("not_protected_transfer_evidence");
    if (review.access !== "reviewer_only") hold.add("holdout_not_reviewer_controlled");
    const freeze = Date.parse(review.frozenAt);
    const created = Date.parse(review.protectedSetCreatedAt);
    if (!finite(freeze) || !finite(created) || created <= freeze) hold.add("holdout_not_created_after_freeze");
    if (
      review.accessEvents.some(
        (event) => review.optimizerIds.includes(event.actorId) || event.actorId === metrics.authorId,
      )
    )
      reject.add("protected_access_violation");
  }
  const groups = new Map<
    string,
    { quality: number[]; control: number[]; candidate: number[]; units: string[]; total: number }
  >();
  const pairs = new Set<string>();
  const orders = new Set<string>();
  let controlTrials = 0;
  let candidateTrials = 0;
  let controlAccepted = 0;
  let candidateAccepted = 0;
  let pairedTrials = 0;
  for (const pair of metrics.trials) {
    if (pair.control) {
      controlTrials++;
      if (pair.control.quality.accepted) controlAccepted++;
    }
    if (pair.candidate) {
      candidateTrials++;
      if (pair.candidate.quality.accepted) candidateAccepted++;
    }
    if (!known(pair.taskId) || !known(pair.trialId)) {
      hold.add("missing_task_trial_identity");
      continue;
    }
    const identity = JSON.stringify([pair.taskId, pair.trialId]);
    if (pairs.has(identity)) {
      hold.add("duplicate_task_trial");
      continue;
    }
    pairs.add(identity);
    const group = groups.get(pair.taskId) ?? { quality: [], control: [], candidate: [], units: [], total: 0 };
    groups.set(pair.taskId, group);
    if (!pair.control || !pair.candidate) {
      hold.add("missing_control_or_candidate");
      continue;
    }
    pairedTrials++;
    group.total++;
    if (!["control_first", "candidate_first"].includes(pair.order)) hold.add("missing_trial_order");
    else orders.add(pair.order);
    const control = pair.control;
    const candidate = pair.candidate;
    for (const arm of [control, candidate]) {
      if (
        !review ||
        arm.quality.verifierId !== review.reviewerId ||
        arm.safety.verifierId !== review.reviewerId ||
        !known(arm.quality.receiptRef) ||
        !known(arm.safety.receiptRef) ||
        typeof arm.quality.accepted !== "boolean"
      )
        hold.add("unresolved_trial_review");
      else {
        evidence.add(arm.quality.receiptRef);
        evidence.add(arm.safety.receiptRef);
        if (![arm.safety.critical, arm.safety.privacy, arm.safety.authority].every(count))
          hold.add("incomplete_safety");
        else if (arm.safety.critical + arm.safety.privacy + arm.safety.authority > 0)
          reject.add("critical_safety_privacy_or_authority_failure");
      }
    }
    const routeKeys = ["provider", "model", "effort", "environment", "dataVersion", "taskDifficulty"] as const;
    if (
      !known(control.route.sourceRef) ||
      !known(candidate.route.sourceRef) ||
      routeKeys.some((key) => !known(control.route[key]) || control.route[key] !== candidate.route[key])
    )
      hold.add("unmatched_route_or_task");
    group.quality.push(Number(candidate.quality.accepted) - Number(control.quality.accepted));
    const a = measuredCost(control, policy);
    const b = measuredCost(candidate, policy);
    if (!a || !b) {
      hold.add("incomplete_usage");
      continue;
    }
    if (a.unit !== b.unit) {
      hold.add("unmatched_currency_or_unit");
      continue;
    }
    group.control.push(a.value);
    group.candidate.push(b.value);
    group.units.push(a.unit);
  }
  if (orders.size < 2) hold.add("order_not_counterbalanced");
  if (groups.size < policy.minimumIndependentTasks) hold.add("too_few_independent_tasks");
  const tasks: CandidateDecision["report"]["tasks"] = [];
  for (const [taskId, group] of groups) {
    if (group.total < policy.minimumTrialsPerArm) hold.add("too_few_trials");
    const qualityDifference = group.quality.length === group.total && group.total > 0 ? mean(group.quality) : null;
    const a = mean(group.control);
    const b = mean(group.candidate);
    const saving =
      group.control.length === group.total && group.total > 0 && a > 0 && new Set(group.units).size === 1
        ? (a - b) / a
        : null;
    if (saving === null || !finite(saving)) hold.add("incomplete_usage_or_zero_baseline");
    tasks.push({ taskId, pairedTrials: group.total, qualityDifference, saving: finite(saving) ? saving : null });
  }
  const qualityValues = tasks.map((task) => task.qualityDifference).filter((value): value is number => value !== null);
  const savingValues = tasks.map((task) => task.saving).filter((value): value is number => value !== null);
  // Quality is bounded [-1,1] per independent task. A distribution-free interval avoids the
  // zero-width t interval when a small cohort happens to have no observed quality regressions.
  // Twelve tasks are a pilot proposal, not guaranteed power for a five-point margin.
  const qualityMean = mean(qualityValues);
  const qualityRadius = Math.sqrt((2 * Math.log(40)) / qualityValues.length);
  const quality95 =
    qualityValues.length === tasks.length && qualityValues.length >= 2 && finite(qualityMean) && finite(qualityRadius)
      ? {
          mean: qualityMean,
          lower: Math.max(-1, qualityMean - qualityRadius),
          upper: Math.min(1, qualityMean + qualityRadius),
        }
      : null;
  const savings95 = savingValues.length === tasks.length ? interval(savingValues) : null;
  if (!quality95) hold.add("inconclusive_quality");
  else if (quality95.upper < -policy.qualityNonInferiorityMargin) reject.add("quality_regression");
  else if (quality95.lower < -policy.qualityNonInferiorityMargin) hold.add("quality_noninferiority_not_established");
  if (!savings95 || savings95.lower <= 0) hold.add("saving_interval_does_not_support_improvement");
  return {
    decision: reject.size > 0 ? "reject" : hold.size > 0 ? "hold" : "promote",
    reasons: [...reject, ...hold],
    evidenceRefs: [...evidence].filter(known),
    report: {
      independentTasks: groups.size,
      pairedTrials,
      controlTrials,
      candidateTrials,
      quality: { controlAccepted, candidateAccepted },
      qualityDifference95: quality95,
      savings95,
      intervalMethod: "task_mean_paired_t_conservative_95",
      qualityIntervalMethod: "task_cluster_hoeffding_95",
      tasks,
      comparison: metrics.comparison,
      savingMetric: policy.savingMetric,
      evidenceTier: review?.content ?? "unresolved",
    },
  };
}
