import assert from "node:assert/strict";
import { test } from "node:test";
import { renderFounderReport } from "./reconcile.mjs";

// Presentation fixtures only: these objects are not native evidence or release authority.
const now = Date.parse("2026-11-17T00:20:00.000Z");
const status = (result) => ({ result, reasonCodes: [], evidenceIds: [] });
const fixture = (results = { local: "pass" }) => ({
  schema: "delivery-projection/v1.1",
  closeoutGoal: "available_on_selected_targets",
  goalResult: Object.values(results).every((r) => r === "pass") ? "pass" : "unknown",
  targetAvailability: Object.fromEntries(Object.entries(results).map(([id, result]) => [id, status(result)])),
  targetClaims: Object.fromEntries(
    Object.entries(results).map(([id, result]) => [
      id,
      Object.fromEntries(
        ["built", "installed_or_deployed", "running", "live_verified"].map((name) => [name, status(result)]),
      ),
    ]),
  ),
  currentClaims: Object.fromEntries([
    ...["committed", "pushed", "reviewed", "tested", "merged"].map((name) => [name, status("pass")]),
    ...["built", "installed_or_deployed", "running", "live_verified"].map((name) => [
      name,
      status(Object.values(results).every((r) => r === "pass") ? "pass" : "unknown"),
    ]),
  ]),
  missingGates: [],
  blockerOwnerRef: "private-owner-1",
  nextAction: "Internal action with private details must not be echoed",
  historicalClaims: [{ evidenceId: "private-evidence-1" }],
  observedAt: new Date(now).toISOString(),
  coverage: { attempted: ["private-evidence-1"], failed: [], omitted: [], truncated: false },
});
const render = (p, options = {}) => renderFounderReport(p, { now, ...options });

test("unknown and stale availability remain distinct from a failed target", () => {
  const report = render(fixture({ local: "unknown", desktop: "stale", staging: "fail" }));
  assert.equal(report.availableNow.local, null);
  assert.equal(report.availableNow.desktop, null);
  assert.equal(report.availableNow.staging, false);
  assert.deepEqual(
    report.publicTargets.map((t) => t.state),
    ["unknown", "stale", "unavailable"],
  );
});

test("a successful target cannot hide another failed target behind an all-green outcome", () => {
  const p = fixture({ local: "pass", desktop: "fail" });
  p.goalResult = "pass"; // A contradictory summary must not erase per-target results.
  const report = render(p);
  assert.equal(report.availableNow.local, true);
  assert.equal(report.availableNow.desktop, false);
  assert.equal(report.currentAvailability, "partial");
  assert.deepEqual(
    report.publicTargets.map((t) => t.state),
    ["available", "unavailable"],
  );
  assert.match(report.userVisibleOutcome, /部分|有目標/);
});

test("unreadable native evidence invalidates an older green presentation", () => {
  const p = fixture();
  p.coverage.failed = [{ id: "private-evidence-2", reason: "native_evidence_unavailable_or_invalid" }];
  const report = render(p);
  assert.equal(report.availableNow.local, null);
  assert.equal(report.publicTargets[0].state, "unknown");
  assert.equal(report.freshness.result, "unknown");
  assert.match(report.nextStep, /重新|更新/);
});

test("a cached green projection becomes stale after its bounded presentation lifetime", () => {
  const p = fixture();
  p.observedAt = new Date(now - 60_001).toISOString();
  const report = render(p);
  assert.equal(report.availableNow.local, null);
  assert.equal(report.publicTargets[0].state, "stale");
  assert.equal(report.freshness.result, "stale");
  assert.equal(report.freshness.observedAt, p.observedAt);
});

test("invalid or future observation dates cannot create an available target", () => {
  for (const observedAt of [
    "/Users/private/owner.cookies",
    "2026-02-30T00:00:00.000Z",
    new Date(now + 1).toISOString(),
  ]) {
    const p = fixture();
    p.observedAt = observedAt;
    const report = render(p);
    assert.equal(report.availableNow.local, null);
    assert.equal(report.publicTargets[0].state, "unknown");
    assert.equal(report.freshness.result, "unknown");
    if (observedAt.startsWith("/")) assert.equal(report.freshness.observedAt, null);
  }
});

test("public fields never echo arbitrary owner, action, gate, evidence or target payloads", () => {
  const secret = ["gh", "p_", "A".repeat(36)].join("");
  const privatePath = "/Users/private/owner.cookies";
  const p = fixture({ local: "not_run", [privatePath]: "pass", [secret]: "pass" });
  p.blockerOwnerRef = secret;
  p.nextAction = `Read ${privatePath} with ${secret}`;
  p.missingGates = ["live_verified", privatePath, secret];
  p.historicalClaims = [{ evidenceId: secret }, { evidenceId: privatePath }, { evidenceId: "private-evidence-1" }];
  const report = render(p);
  assert.equal(report.owner, null);
  assert.match(report.ownerStatus, /待核實/);
  assert.deepEqual(report.notYetAvailable, ["live_verified"]);
  assert.deepEqual(report.evidenceRefs, []);
  assert.equal(report.privateDetails, undefined);
  assert.ok(report.missingGateLabels.includes("真實功能操作驗證"));
  for (const unsafe of [secret, privatePath, "private-evidence-1"]) assert.ok(!JSON.stringify(report).includes(unsafe));
  assert.ok(!report.nextStep.includes(p.nextAction));
});

test("technical references are available only in an explicitly requested private record", () => {
  const p = fixture();
  const ordinary = render(p),
    detailed = render(p, { includePrivateDetails: true });
  assert.equal(ordinary.privateDetails, undefined);
  assert.equal(ordinary.owner, null);
  assert.deepEqual(ordinary.evidenceRefs, []);
  assert.deepEqual(detailed.privateDetails.evidenceRefs, ["private-evidence-1"]);
  assert.equal(detailed.privateDetails.ownerRef, "private-owner-1");
  assert.deepEqual(detailed.privateDetails.targetRefs, [{ label: "目標 1", ref: "local" }]);
  assert.equal(detailed.privateDetails.requiresNativeAccessControl, true);
  assert.equal(detailed.isAuthorizationGrant, false);
});

test("owner and approval uncertainty are not turned into an invented decision", () => {
  const p = fixture({ local: "not_run" });
  assert.equal(render(p).ownerDecisionRequired, null);
  assert.equal(render(p).owner, null);
  p.ownerDecisionRequired = true;
  assert.equal(render(p).ownerDecisionRequired, true);
  p.ownerDecisionRequired = false;
  assert.equal(render(p).ownerDecisionRequired, false);
  p.ownerDecisionRequired = "approved";
  assert.equal(render(p).ownerDecisionRequired, null);
});

test("not-run preserves the legacy flag but explicitly says verification has not run", () => {
  const p = fixture({ local: "not_run" });
  p.missingGates = ["live_verified"];
  const report = render(p);
  assert.equal(report.availableNow.local, false);
  assert.equal(report.publicTargets[0].state, "not_run");
  assert.match(report.publicTargets[0].text, /未核實|未執行/);
  assert.ok(report.notYetAvailable.includes("live_verified"));
  assert.match(report.howToUse, /目標/);
  assert.equal(report.locale, "zh-HK");
});

test("a backup goal never states that the product is live", () => {
  const p = fixture({ local: "not_run" });
  p.closeoutGoal = "backed_up";
  p.goalResult = "pass";
  const report = render(p);
  assert.match(report.userVisibleOutcome, /備份/);
  assert.equal(report.currentAvailability, "not_run");
  assert.equal(report.availableNow.local, false);
});

test("malformed presentation input remains bounded and unknown without mutating its source", () => {
  for (const p of [null, [], { targetAvailability: [] }, { targetAvailability: { local: null } }]) {
    const before = JSON.stringify(p);
    const report = render(p);
    assert.equal(report.currentAvailability, "unknown");
    assert.equal(report.ownerDecisionRequired, null);
    assert.equal(JSON.stringify(p), before);
  }
});

test("an unsupported projection schema cannot produce a green report", () => {
  const p = fixture();
  p.schema = "delivery-projection/future";
  const report = render(p);
  assert.equal(report.availableNow.local, null);
  assert.equal(report.publicTargets[0].state, "unknown");
  assert.equal(report.freshness.result, "unknown");
});

test("explicit failed target evidence cannot be hidden by a pass summary", () => {
  const p = fixture();
  p.targetClaims.local.live_verified = status("fail");
  const report = render(p);
  assert.notEqual(report.availableNow.local, true);
  assert.notEqual(report.currentAvailability, "available");
  assert.notEqual(report.freshness.result, "pass");
  assert.ok(report.publicTargets[0].missingGates.includes("真實功能操作驗證"));
});

test("explicit shared test failure invalidates an available target summary", () => {
  const p = fixture();
  p.currentClaims.tested = status("fail");
  const report = render(p);
  assert.notEqual(report.availableNow.local, true);
  assert.notEqual(report.freshness.result, "pass");
  assert.ok(report.publicTargets[0].missingGates.includes("必要測試"));
});

test("a backup headline cannot contradict failed or unknown commit and push claims", () => {
  const p = fixture({ local: "not_run" });
  p.closeoutGoal = "backed_up";
  p.goalResult = "pass";
  p.currentClaims.committed = status("fail");
  p.currentClaims.pushed = status("unknown");
  p.missingGates = ["committed", "pushed"];
  const report = render(p);
  assert.doesNotMatch(report.userVisibleOutcome, /備份已核實/);
  assert.notEqual(report.freshness.result, "pass");
});

test("unknown required gates are surfaced without echoing raw names or retaining green", () => {
  const p = fixture();
  p.missingGates = ["new_required_gate"];
  const report = render(p);
  assert.equal(report.availableNow.local, null);
  assert.equal(report.currentAvailability, "unknown");
  assert.equal(report.freshness.result, "unknown");
  assert.ok(report.missingGateLabels.includes("未能辨識嘅驗收關卡"));
  assert.ok(!JSON.stringify(report).includes("new_required_gate"));
});

test("an old or unreadable report cannot retain an owner approval decision", () => {
  for (const required of [true, false]) {
    for (const change of [
      (p) => {
        p.observedAt = new Date(now - 60_001).toISOString();
      },
      (p) => {
        p.schema = "delivery-projection/future";
      },
      (p) => {
        p.coverage.failed = [{ reason: "native_evidence_unavailable_or_invalid" }];
      },
    ]) {
      const p = fixture();
      p.ownerDecisionRequired = required;
      change(p);
      assert.equal(render(p).ownerDecisionRequired, null);
    }
  }
});

test("a known missing gate cannot coexist with an all-pass available summary", () => {
  for (const gate of ["tested", "live_verified"]) {
    const p = fixture();
    p.missingGates = [gate];
    const report = render(p);
    assert.equal(report.availableNow.local, null);
    assert.equal(report.currentAvailability, "unknown");
    assert.equal(report.freshness.result, "unknown");
  }
});

test("a genuine aggregate gate missing on another target preserves the passing target", () => {
  const p = fixture({ local: "pass", desktop: "fail" });
  p.currentClaims.live_verified = status("fail");
  p.missingGates = ["live_verified"];
  const report = render(p);
  assert.equal(report.availableNow.local, true);
  assert.equal(report.availableNow.desktop, false);
  assert.equal(report.currentAvailability, "partial");
});

test("a verified backup stays complete while an unrelated runtime summary is inconsistent", () => {
  const p = fixture();
  p.closeoutGoal = "backed_up";
  p.goalResult = "pass";
  p.targetClaims.local.live_verified = status("fail");
  const report = render(p);
  assert.equal(report.availableNow.local, null);
  assert.match(report.userVisibleOutcome, /備份已核實/);
  assert.equal(report.freshness.result, "pass");
});

test("an unrelated runtime gate contradiction does not erase verified backup claims", () => {
  const p = fixture();
  p.closeoutGoal = "backed_up";
  p.goalResult = "pass";
  p.missingGates = ["live_verified"];
  const report = render(p);
  assert.equal(report.availableNow.local, null);
  assert.match(report.userVisibleOutcome, /備份已核實/);
  assert.equal(report.freshness.result, "pass");
});
