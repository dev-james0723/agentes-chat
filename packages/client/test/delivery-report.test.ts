import { expect, test } from "bun:test";
import type { Issue, IssueDeliveryReport } from "../src/api/types";
import { deliveryReportView } from "../src/lib/delivery-report";

const now = Date.parse("2026-11-17T01:00:00.000Z");
const report = (over: Partial<IssueDeliveryReport> = {}): IssueDeliveryReport => ({
  locale: "zh-HK",
  userVisibleOutcome: "所選目標已核實可用；結果以列出嘅核查時間為準。",
  howToUse: "逐個目標查看目前狀態同未完成驗證；技術紀錄由原生任務嘅私有詳情查閱。",
  currentAvailability: "available",
  publicTargets: [{ label: "目標 1", state: "available", text: "已核實可用。", missingGates: [] }],
  targetsOmitted: 0,
  missingGateLabels: [],
  ownerStatus: "發布負責人待核實。",
  nextStep: "保留最新驗證紀錄，按原有流程完成收口。",
  ownerDecisionRequired: false,
  freshness: { generatedAt: new Date(now).toISOString(), result: "pass", coverage: "complete" },
  isAuthorizationGrant: false,
  ...over,
});

test("old server or ordinary task with no report keeps its existing view", () => {
  expect(deliveryReportView(undefined, now)).toBeNull();
  expect(deliveryReportView(null, now)).toBeNull();
});

test("a fresh complete public report keeps its target-specific result", () => {
  expect(deliveryReportView(report(), now + 60_000)).toEqual(report());
});

test("cached green expires without a refetch or an active task worker", () => {
  const cached: Pick<Issue, "work" | "deliveryReport"> = { work: null, deliveryReport: report() };
  expect(deliveryReportView(cached.deliveryReport, now)?.currentAvailability).toBe("available");
  // A failed/offline refetch leaves the same data object in the query cache.
  const visible = deliveryReportView(cached.deliveryReport, now + 60_001);
  expect(visible).toMatchObject({
    currentAvailability: "stale",
    publicTargets: [{ state: "stale" }],
    ownerDecisionRequired: null,
    freshness: { result: "stale" },
    isAuthorizationGrant: false,
  });
  expect(visible?.userVisibleOutcome).not.toContain("已核實可用");
  expect(visible?.publicTargets[0]?.text).not.toContain("已核實可用");
  expect(visible?.nextStep).toContain("重新");
  expect(cached.deliveryReport?.currentAvailability).toBe("available");
});

test("missing or non-calendar timestamps cannot preserve a green claim", () => {
  for (const generatedAt of [null, "invalid", "2026-02-30T01:00:00.000Z", "2026-11-17", "2026-11-17T01:00:00.000Z\n"]) {
    const visible = deliveryReportView(
      report({ freshness: { generatedAt, result: "pass", coverage: "complete" } }),
      now,
    );
    expect(visible).toMatchObject({
      currentAvailability: "unknown",
      publicTargets: [{ state: "unknown" }],
      ownerDecisionRequired: null,
      freshness: { generatedAt: null, result: "unknown" },
    });
  }
});

test("a future report and a non-finite clock cannot preserve green", () => {
  const future = report({
    freshness: { generatedAt: new Date(now + 1).toISOString(), result: "pass", coverage: "complete" },
  });
  expect(deliveryReportView(future, now)?.currentAvailability).toBe("unknown");
  for (const clock of [NaN, Infinity, -Infinity])
    expect(deliveryReportView(report(), clock)?.currentAvailability).toBe("unknown");
});

test("incomplete evidence coverage cannot preserve green or a decision assertion", () => {
  const visible = deliveryReportView(
    report({
      ownerDecisionRequired: true,
      freshness: { generatedAt: new Date(now).toISOString(), result: "pass", coverage: "incomplete" },
    }),
    now,
  );
  expect(visible).toMatchObject({
    currentAvailability: "unknown",
    publicTargets: [{ state: "unknown" }],
    ownerDecisionRequired: null,
    freshness: { result: "unknown", coverage: "incomplete" },
    isAuthorizationGrant: false,
  });
});

test("fresh mixed targets preserve the good target until the report itself expires", () => {
  const mixed = report({
    currentAvailability: "partial",
    userVisibleOutcome: "各目標進度唔一致；仍有目標未通過或未完成驗證。",
    publicTargets: [
      { label: "目標 1", state: "available", text: "已核實可用。", missingGates: [] },
      { label: "目標 2", state: "unavailable", text: "未通過今次交付驗證。", missingGates: ["真實功能操作驗證"] },
    ],
    freshness: { generatedAt: new Date(now).toISOString(), result: "fail", coverage: "complete" },
  });
  expect(deliveryReportView(mixed, now)?.publicTargets.map((target) => target.state)).toEqual([
    "available",
    "unavailable",
  ]);
  expect(deliveryReportView(mixed, now + 60_001)?.publicTargets.map((target) => target.state)).toEqual([
    "stale",
    "stale",
  ]);
});

test("unknown configured targets stay unknown and retain their missing gates", () => {
  const unknown = report({
    currentAvailability: "unknown",
    userVisibleOutcome: "目前可用狀態未核實。",
    publicTargets: [{ label: "目標 1", state: "unknown", text: "目前狀態未核實。", missingGates: ["實際運行版本"] }],
    missingGateLabels: ["實際運行版本"],
    ownerDecisionRequired: null,
    freshness: { generatedAt: new Date(now).toISOString(), result: "unknown", coverage: "incomplete" },
  });
  const visible = deliveryReportView(unknown, now);
  expect(visible).toMatchObject({ currentAvailability: "unknown", missingGateLabels: ["實際運行版本"] });
  expect(visible?.publicTargets[0]?.missingGates).toEqual(["實際運行版本"]);
  expect(visible).not.toHaveProperty("verifiedAt");
  expect(visible?.freshness).not.toHaveProperty("observedAt");
});

test("usage instructions remain visible when a cached delivery report expires", () => {
  const cached = report();
  expect(deliveryReportView(cached, now + 60_001)?.howToUse).toBe(cached.howToUse);
});

test("a current source read failure immediately downgrades fresh cached delivery", () => {
  const cached = report({ ownerDecisionRequired: true });
  const visible = deliveryReportView(cached, now, { sourceReadFailed: true });
  expect(visible).toMatchObject({
    currentAvailability: "unknown",
    publicTargets: [{ state: "unknown" }],
    ownerDecisionRequired: null,
    freshness: { result: "unknown", coverage: "incomplete" },
    isAuthorizationGrant: false,
  });
  expect(visible?.userVisibleOutcome).not.toContain("已核實可用");
  expect(visible?.publicTargets[0]?.text).not.toContain("已核實可用");
  expect(visible?.howToUse).toBe(cached.howToUse);
  expect(cached.currentAvailability).toBe("available");
  expect(cached.ownerDecisionRequired).toBe(true);
  expect(deliveryReportView(cached, now, { sourceReadFailed: false })).toEqual(cached);
  expect(deliveryReportView(undefined, now, { sourceReadFailed: true })).toBeNull();
});
