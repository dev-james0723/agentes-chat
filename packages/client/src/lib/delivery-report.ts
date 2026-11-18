import type { IssueDeliveryReport } from "../api/types";

function isoDate(value: string | null | undefined): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  const normalized = new Date(time).toISOString();
  const expanded = value.includes(".")
    ? value.replace(/\.(\d{1,3})Z$/, (_, digits: string) => `.${digits.padEnd(3, "0")}Z`)
    : value.replace(/Z$/, ".000Z");
  return normalized === expanded ? normalized : null;
}

/** Expire the cached display without a worker, successful refetch or new evidence. This grants no authority. */
export function deliveryReportView(
  report: IssueDeliveryReport | null | undefined,
  now = Date.now(),
  options: { sourceReadFailed?: boolean } = {},
): IssueDeliveryReport | null {
  if (!report) return null;
  const generatedAt = isoDate(report.freshness?.generatedAt);
  const time = generatedAt ? Date.parse(generatedAt) : NaN;
  const validTime = Number.isFinite(now) && Number.isFinite(time) && time <= now;
  const state =
    options.sourceReadFailed || !validTime || report.freshness?.coverage !== "complete"
      ? "unknown"
      : now - time > 60_000 || report.freshness.result === "stale"
        ? "stale"
        : null;
  if (!state) return report;
  const text = state === "stale" ? "核查資料已過期，要重新確認目前狀態。" : "目前狀態未核實。";
  return {
    ...report,
    currentAvailability: state,
    userVisibleOutcome:
      state === "stale" ? "核查資料已過期；目前可用狀態要重新確認。" : "目前可用狀態未核實；需補齊最新可信證據。",
    publicTargets: report.publicTargets.map((target) => ({ ...target, state, text })),
    ownerDecisionRequired: null,
    nextStep: "重新讀取原生證據，再逐個目標確認實際可用狀態。",
    freshness: {
      generatedAt: validTime ? generatedAt : null,
      result: state,
      coverage: !options.sourceReadFailed && report.freshness?.coverage === "complete" ? "complete" : "incomplete",
    },
    isAuthorizationGrant: false,
  };
}
