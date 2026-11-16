/**
 * Pure projections of native usage receipts, not a billing ledger or an authority resolver.
 *
 * The caller must authorize the cohort, include ALL its attempts (failed/retried/reviewer/Jev/tool
 * calls included), resolve task revisions and independent verification receipts from native state,
 * and preserve provider field definitions. None of these strings establish authority themselves.
 * In particular, NEVER construct outcomes directly from worker text or a lifecycle "done" state.
 *
 * Attribution/definitions/accounting are additive optional adapter metadata, not columns claimed
 * to exist today. Legacy zero-filled/estimated counters must be mapped to null when unknown.
 * Native costNanoUsd alone is a catalog quote; it does not establish a settled cash charge.
 * No prices, exchange rates, inference calls, stores or mutable global state are introduced here.
 */
export interface UsageAttempt {
  id: string;
  orgId: string;
  runId?: string | null;
  kind?: string | null;
  purpose?: string | null;
  provider?: string | null;
  model?: string | null;
  requestedModel?: string | null;
  billedTo?: string | null;
  partial?: boolean;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  /** Subset of cacheWriteTokens, not extra input. */
  cacheWriteLongTokens?: number | null;
  reasoningTokens?: number | null;
  costNanoUsd?: number | null;
  usageSource?: "metered" | "estimated" | "mixed" | "unknown" | null;
  tokenDefinitions?: {
    inputIncludesCache?: boolean | null;
    outputIncludesReasoning?: boolean | null;
  } | null;
  attribution?: {
    taskId?: string | null;
    taskRevision?: number | null;
    attemptId?: string | null;
    parentRunId?: string | null;
    handoffId?: string | null;
    role?: string | null;
    effort?: string | null;
    modelResolution?: "provider_reported" | "alias" | "unknown" | null;
    sourceRef?: string | null;
    taskDifficulty?: string | null;
    environment?: string | null;
    promptVersion?: string | null;
    skillVersion?: string | null;
    schemaVersion?: string | null;
    sourceContextRefs?: string[] | null;
  } | null;
  accounting?: AccountingAmount | null;
}

export interface AccountingAmount {
  /** Nonnegative safe integer in the specified unit, e.g. nano-USD. No implicit conversion. */
  amount: number;
  currency: string;
  unit: string;
  basis: "charged" | "catalog_estimate" | "plan_estimate" | "local_estimate";
  /** Native provider settlement receipt or verified catalog/version reference, not a worker claim. */
  sourceRef: string;
  effectiveAt: string;
}

/** Only an authorized native adapter may supply these resolved projections. */
export interface VerifiedOutcome {
  id: string;
  orgId: string;
  taskId: string;
  taskRevision: number;
  currentTaskRevision: number;
  result: "success" | "failure" | "cancelled";
  producerId: string;
  verification?: {
    receiptId: string;
    orgId: string;
    taskId: string;
    taskRevision: number;
    result: "success" | "failure";
    verifierId: string;
    evidenceRefs: string[];
  } | null;
  admittedAt?: string | null;
  acceptedOutcomeAt?: string | null;
  /** Nonoverlapping task-level components; never sum overlapping parent/child run wall times. */
  latency?: {
    queueMs?: number | null;
    executionMs?: number | null;
    reviewMs?: number | null;
    humanWaitMs?: number | null;
  } | null;
}

export interface Coverage {
  known: number;
  unknown: number;
  total: number;
  complete: boolean;
}
export interface AggregateMetric {
  knownSubtotal: number | null;
  total: number | null;
  known: number;
  unknown: number;
  complete: boolean;
  overflow: boolean;
}
export interface MoneyMetric extends AggregateMetric {
  currency: string;
  unit: string;
  sources: { sourceRef: string; effectiveAt: string }[];
  perVerifiedOutcome: number | null;
}
export interface RouteProvenance {
  provider: string | null;
  model: string | null;
  requestedModel: string | null;
  modelResolution: string | null;
  effort: string | null;
  role: string | null;
  purpose: string | null;
  sourceRef: string | null;
  taskDifficulty: string | null;
  environment: string | null;
  promptVersion: string | null;
  skillVersion: string | null;
  schemaVersion: string | null;
  sourceContextRefs: string[] | null;
  attemptIds: string[];
}
export interface EconomicsReport {
  attempts: {
    supplied: number;
    unique: number;
    duplicateReceipts: number;
    conflictingReceipts: number;
    partial: number;
  };
  verifiedSuccessfulTasks: number;
  rejectedOutcomes: { id: string; reason: string }[];
  tokens: AggregateMetric;
  reasoningTokens: AggregateMetric;
  cacheReadTokens: AggregateMetric;
  cacheWriteTokens: AggregateMetric;
  tokensPerVerifiedOutcome: number | null;
  costs: {
    cash: MoneyMetric[];
    catalogEstimates: MoneyMetric[];
    planEstimates: MoneyMetric[];
    localEstimates: MoneyMetric[];
    unclassifiedNativeNanoUsd: AggregateMetric;
  };
  coverage: {
    attribution: Coverage;
    accounting: Coverage;
    cash: Coverage;
    meteredTokens: Coverage;
    usageSource: Coverage;
    exactModel: Coverage;
    effort: Coverage;
    outcomesWithUsage: Coverage;
  };
  latency: Record<"wallMs" | "queueMs" | "executionMs" | "reviewMs" | "humanWaitMs", AggregateMetric>;
  routes: RouteProvenance[];
  issues: { code: string; receiptKey: string }[];
  /** Descriptive aggregates cannot establish matched-route quality or causal savings. */
  savingsClaim: "not_evaluated";
}

const textKnown = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const countKnown = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const revisionKnown = countKnown;
const identity = (...parts: unknown[]) => JSON.stringify(parts);
const coverage = (known: number, total: number): Coverage => ({
  known,
  unknown: total - known,
  total,
  complete: total > 0 && known === total,
});

function metric(values: (number | null)[], extraUnknown = 0): AggregateMetric {
  let known = 0;
  let sum = 0;
  let overflow = false;
  for (const value of values) {
    if (countKnown(value)) {
      known++;
      if (!countKnown(sum + value)) overflow = true;
      else sum += value;
    }
  }
  const unknown = values.length - known + extraUnknown;
  const subtotal = known > 0 && !overflow ? sum : null;
  const complete = unknown === 0 && known > 0 && !overflow;
  return { knownSubtotal: subtotal, total: complete ? subtotal : null, known, unknown, complete, overflow };
}

/** Stable comparisons include null/undefined and nonfinite numbers, independently of object key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify([typeof value, String(value)]);
}

function deduplicate<T extends { id: string; orgId: string }>(rows: T[]) {
  const groups = new Map<string, { row: T | null; signatures: Set<string> }>();
  for (const [index, row] of rows.entries()) {
    const validIdentity = textKnown(row.id) && textKnown(row.orgId);
    const key = validIdentity ? identity(row.orgId, row.id) : identity("invalid", index);
    const signature = canonical(row);
    const prior = groups.get(key);
    if (prior) {
      prior.signatures.add(signature);
      if (prior.signatures.size > 1) prior.row = null;
    } else groups.set(key, { row: validIdentity ? row : null, signatures: new Set([signature]) });
  }
  return {
    entries: [...groups].map(([key, value]) => ({ key, row: value.row })),
    duplicates: rows.length - groups.size,
    conflicts: [...groups.values()].filter((value) => value.row === null).length,
  };
}

function tokenTotal(row: UsageAttempt): number | null {
  if (row.partial || !countKnown(row.inputTokens) || !countKnown(row.outputTokens)) return null;
  for (const value of [row.cacheReadTokens, row.cacheWriteTokens, row.cacheWriteLongTokens, row.reasoningTokens]) {
    if (value !== null && value !== undefined && !countKnown(value)) return null;
  }
  if (
    countKnown(row.cacheWriteLongTokens) &&
    (!countKnown(row.cacheWriteTokens) || row.cacheWriteLongTokens > row.cacheWriteTokens)
  )
    return null;
  const inputDefinition = row.tokenDefinitions?.inputIncludesCache;
  const outputDefinition = row.tokenDefinitions?.outputIncludesReasoning;
  let input = row.inputTokens;
  let output = row.outputTokens;
  if (inputDefinition === false) {
    if (!countKnown(row.cacheReadTokens) || !countKnown(row.cacheWriteTokens)) return null;
    input += row.cacheReadTokens + row.cacheWriteTokens;
  } else if (inputDefinition === true) {
    if ((row.cacheReadTokens ?? 0) + (row.cacheWriteTokens ?? 0) > input) return null;
  } else if (row.cacheReadTokens !== 0 || row.cacheWriteTokens !== 0) return null;
  if (outputDefinition === false) {
    if (!countKnown(row.reasoningTokens)) return null;
    output += row.reasoningTokens;
  } else if (outputDefinition === true) {
    if (countKnown(row.reasoningTokens) && row.reasoningTokens > output) return null;
  } else if (row.reasoningTokens !== 0) return null;
  return countKnown(input + output) ? input + output : null;
}

function validAccounting(row: UsageAttempt): AccountingAmount | null {
  const amount = row.accounting;
  if (
    !amount ||
    !countKnown(amount.amount) ||
    !textKnown(amount.currency) ||
    !textKnown(amount.unit) ||
    !textKnown(amount.sourceRef) ||
    !textKnown(amount.effectiveAt) ||
    !Number.isFinite(Date.parse(amount.effectiveAt))
  )
    return null;
  if (!["charged", "catalog_estimate", "plan_estimate", "local_estimate"].includes(amount.basis)) return null;
  if ((row.billedTo === "plan") !== (amount.basis === "plan_estimate")) return null;
  return amount;
}

function attributionKey(row: UsageAttempt): string | null {
  const attribution = row.attribution;
  return textKnown(row.orgId) &&
    textKnown(attribution?.taskId) &&
    revisionKnown(attribution?.taskRevision) &&
    textKnown(attribution?.sourceRef)
    ? identity(row.orgId, attribution.taskId, attribution.taskRevision)
    : null;
}

function outcomeRejection(row: VerifiedOutcome): string | null {
  if (!textKnown(row.taskId) || !revisionKnown(row.taskRevision) || !revisionKnown(row.currentTaskRevision))
    return "missing_task_revision";
  if (row.taskRevision !== row.currentTaskRevision) return "stale_task_revision";
  if (row.result !== "success") return "not_successful";
  const verification = row.verification;
  if (
    !verification ||
    !textKnown(verification.receiptId) ||
    !textKnown(verification.verifierId) ||
    !textKnown(row.producerId) ||
    !Array.isArray(verification.evidenceRefs) ||
    verification.evidenceRefs.length === 0 ||
    !verification.evidenceRefs.every(textKnown)
  )
    return "missing_independent_receipt";
  if (verification.verifierId === row.producerId) return "self_review";
  if (verification.orgId !== row.orgId || verification.taskId !== row.taskId) return "receipt_scope_mismatch";
  if (verification.result !== "success") return "receipt_not_successful";
  if (verification.taskRevision !== row.taskRevision) return "receipt_revision_mismatch";
  return null;
}

/**
 * Aggregates an explicitly selected native task cohort. The function can validate consistency and
 * arithmetic only: the caller is responsible for receipt authenticity, scope, completeness of the
 * selected cohort and verifier eligibility. Complete coverage here means complete INPUT coverage.
 * It does not prove the gateway captured every attempt or establish a quality/savings experiment.
 */
export function aggregateVerifiedEconomics(attempts: UsageAttempt[], outcomes: VerifiedOutcome[]): EconomicsReport {
  const usage = deduplicate(attempts);
  const resolvedOutcomes = deduplicate(outcomes);
  const issues: EconomicsReport["issues"] = [];
  const rejectedOutcomes: EconomicsReport["rejectedOutcomes"] = [];
  const candidates = new Map<string, VerifiedOutcome[]>();
  const receiptBindings = new Map<string, Set<string>>();
  for (const { row } of resolvedOutcomes.entries) {
    if (!row?.verification || !textKnown(row.verification.receiptId)) continue;
    const key = identity(row.orgId, row.verification.receiptId);
    const bindings = receiptBindings.get(key) ?? new Set<string>();
    bindings.add(canonical(row.verification));
    receiptBindings.set(key, bindings);
  }
  for (const entry of resolvedOutcomes.entries) {
    if (!entry.row) {
      rejectedOutcomes.push({ id: entry.key, reason: "conflicting_outcome_receipt" });
      continue;
    }
    const verification = entry.row.verification;
    const inconsistentReceipt =
      verification && (receiptBindings.get(identity(entry.row.orgId, verification.receiptId))?.size ?? 0) > 1;
    const reason = inconsistentReceipt ? "conflicting_verification_receipt" : outcomeRejection(entry.row);
    if (reason) {
      rejectedOutcomes.push({ id: entry.row.id, reason });
      continue;
    }
    const key = identity(entry.row.orgId, entry.row.taskId);
    const rows = candidates.get(key) ?? [];
    rows.push(entry.row);
    candidates.set(key, rows);
  }
  const successfulTasks: VerifiedOutcome[][] = [];
  for (const rows of candidates.values()) {
    if (new Set(rows.map((row) => row.taskRevision)).size > 1) {
      for (const row of rows) rejectedOutcomes.push({ id: row.id, reason: "conflicting_current_task_revision" });
    } else successfulTasks.push(rows);
  }
  const denominator = successfulTasks.length;
  const rows = usage.entries.map((entry) => {
    if (!entry.row) issues.push({ code: "conflicting_usage_receipt", receiptKey: entry.key });
    return entry.row;
  });
  const tokenValues = rows.map((row) => (row ? tokenTotal(row) : null));
  const attributed = rows.map((row) => (row ? attributionKey(row) : null));
  const usageKeys = new Set(attributed.filter((key): key is string => key !== null));
  const outcomesWithUsage = coverage(
    successfulTasks.filter(([row]) => row && usageKeys.has(identity(row.orgId, row.taskId, row.taskRevision))).length,
    denominator,
  );
  const attribution = coverage(attributed.filter((key) => key !== null).length, rows.length);
  const accounting = rows.map((row) => (row ? validAccounting(row) : null));
  const accountingCoverage = coverage(accounting.filter((amount) => amount !== null).length, rows.length);
  const cashCoverage = coverage(
    rows.filter(
      (row, index) =>
        row &&
        (row.billedTo === "plan" ||
          accounting[index]?.basis === "charged" ||
          accounting[index]?.basis === "local_estimate"),
    ).length,
    rows.length,
  );
  const sourceCoverage = coverage(
    rows.filter((row) => row && ["metered", "estimated", "mixed"].includes(row.usageSource ?? "")).length,
    rows.length,
  );
  const comparableScope = attribution.complete && outcomesWithUsage.complete && denominator > 0;
  const ratio = (value: number | null, eligible = true) =>
    comparableScope && eligible && value !== null ? value / denominator : null;

  const money = (basis: AccountingAmount["basis"]): MoneyMetric[] => {
    const buckets = new Map<string, AccountingAmount[]>();
    for (const amount of accounting) {
      if (amount?.basis !== basis) continue;
      const key = identity(amount.currency, amount.unit);
      const values = buckets.get(key) ?? [];
      values.push(amount);
      buckets.set(key, values);
    }
    return [...buckets.values()].map((values) => {
      const first = values[0] as AccountingAmount;
      const aggregate = metric(
        values.map((value) => value.amount),
        basis === "charged" ? cashCoverage.unknown : accountingCoverage.unknown,
      );
      const sources = new Map<string, MoneyMetric["sources"][number]>();
      for (const value of values)
        sources.set(identity(value.sourceRef, value.effectiveAt), {
          sourceRef: value.sourceRef,
          effectiveAt: value.effectiveAt,
        });
      return {
        ...aggregate,
        currency: first.currency,
        unit: first.unit,
        sources: [...sources.values()].sort((a, b) => identity(a).localeCompare(identity(b))),
        perVerifiedOutcome: ratio(aggregate.total),
      };
    });
  };
  for (const [index, row] of rows.entries()) {
    if (row && !accounting[index]) issues.push({ code: "invalid_accounting", receiptKey: identity(row.orgId, row.id) });
    if (row && tokenValues[index] === null)
      issues.push({ code: "incomplete_token_usage", receiptKey: identity(row.orgId, row.id) });
  }

  const routes = new Map<string, RouteProvenance>();
  for (const row of rows) {
    if (!row) continue;
    const a = row.attribution;
    const route = {
      provider: row.provider ?? null,
      model: row.model ?? null,
      requestedModel: row.requestedModel ?? null,
      modelResolution: a?.modelResolution ?? null,
      effort: a?.effort ?? null,
      role: a?.role ?? null,
      purpose: row.purpose ?? null,
      sourceRef: a?.sourceRef ?? null,
      taskDifficulty: a?.taskDifficulty ?? null,
      environment: a?.environment ?? null,
      promptVersion: a?.promptVersion ?? null,
      skillVersion: a?.skillVersion ?? null,
      schemaVersion: a?.schemaVersion ?? null,
      sourceContextRefs: a?.sourceContextRefs ? [...a.sourceContextRefs] : null,
    };
    const key = canonical(route);
    const previous = routes.get(key);
    if (previous) previous.attemptIds.push(row.id);
    else routes.set(key, { ...route, attemptIds: [row.id] });
  }

  const taskMetric = (read: (row: VerifiedOutcome) => number | null): AggregateMetric =>
    metric(
      successfulTasks.map((taskRows) => {
        const values = taskRows.map(read);
        return values.every((value) => value === values[0]) ? (values[0] ?? null) : null;
      }),
    );
  const wallMs = (row: VerifiedOutcome): number | null => {
    if (!textKnown(row.admittedAt) || !textKnown(row.acceptedOutcomeAt)) return null;
    const elapsed = Date.parse(row.acceptedOutcomeAt) - Date.parse(row.admittedAt);
    return countKnown(elapsed) ? elapsed : null;
  };
  const component = (row: VerifiedOutcome, field: keyof NonNullable<VerifiedOutcome["latency"]>): number | null => {
    const value = row.latency?.[field];
    if (!countKnown(value)) return null;
    const wall = wallMs(row);
    if (wall !== null && value > wall) return null;
    const values = ["queueMs", "executionMs", "reviewMs", "humanWaitMs"].map(
      (key) => row.latency?.[key as keyof NonNullable<VerifiedOutcome["latency"]>],
    );
    if (values.every(countKnown)) {
      const sum = values.reduce<number>((total, entry) => total + (entry as number), 0);
      if (!countKnown(sum) || (wall !== null && sum > wall)) return null;
    }
    return value;
  };

  const tokens = metric(tokenValues);
  const nonPartial = (field: "reasoningTokens" | "cacheReadTokens" | "cacheWriteTokens") =>
    metric(rows.map((row) => (row && !row.partial && countKnown(row[field]) ? (row[field] as number) : null)));
  return {
    attempts: {
      supplied: attempts.length,
      unique: rows.length,
      duplicateReceipts: usage.duplicates,
      conflictingReceipts: usage.conflicts,
      partial: rows.filter((row) => row?.partial).length,
    },
    verifiedSuccessfulTasks: denominator,
    rejectedOutcomes,
    tokens,
    reasoningTokens: nonPartial("reasoningTokens"),
    cacheReadTokens: nonPartial("cacheReadTokens"),
    cacheWriteTokens: nonPartial("cacheWriteTokens"),
    tokensPerVerifiedOutcome: ratio(tokens.total, sourceCoverage.complete),
    costs: {
      cash: money("charged"),
      catalogEstimates: money("catalog_estimate"),
      planEstimates: money("plan_estimate"),
      localEstimates: money("local_estimate"),
      unclassifiedNativeNanoUsd: metric(
        rows
          .filter((_, index) => !accounting[index])
          .map((row) => (row && countKnown(row.costNanoUsd) ? row.costNanoUsd : null)),
      ),
    },
    coverage: {
      attribution,
      accounting: accountingCoverage,
      cash: cashCoverage,
      usageSource: sourceCoverage,
      meteredTokens: coverage(
        rows.filter((row, index) => row?.usageSource === "metered" && tokenValues[index] !== null).length,
        rows.length,
      ),
      exactModel: coverage(
        rows.filter(
          (row) =>
            textKnown(row?.model) &&
            row?.attribution?.modelResolution === "provider_reported" &&
            textKnown(row.attribution.sourceRef),
        ).length,
        rows.length,
      ),
      effort: coverage(
        rows.filter((row) => textKnown(row?.attribution?.effort) && textKnown(row?.attribution?.sourceRef)).length,
        rows.length,
      ),
      outcomesWithUsage,
    },
    latency: {
      wallMs: taskMetric(wallMs),
      queueMs: taskMetric((row) => component(row, "queueMs")),
      executionMs: taskMetric((row) => component(row, "executionMs")),
      reviewMs: taskMetric((row) => component(row, "reviewMs")),
      humanWaitMs: taskMetric((row) => component(row, "humanWaitMs")),
    },
    routes: [...routes.values()],
    issues,
    savingsClaim: "not_evaluated",
  };
}
