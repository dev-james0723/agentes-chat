import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

let implementation = {};
try {
  implementation = await import("./reconcile.mjs");
} catch {}
const now = Date.parse("2026-11-16T20:00:00Z");
const sha = "a".repeat(40),
  integrated = "b".repeat(40),
  digest = `sha256:${"c".repeat(64)}`;
const item = () => ({
  taskId: "task-173",
  projectId: "project-native",
  repositoryId: "1456046543",
  candidateSha: sha,
  candidateTree: "d".repeat(40),
  branch: "feat/task",
  targetIds: ["local"],
  closeoutGoal: "available_on_selected_targets",
});
const canonical = (value) =>
  value === null || typeof value !== "object"
    ? JSON.stringify(value)
    : Array.isArray(value)
      ? `[${value.map(canonical).join(",")}]`
      : `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
          .join(",")}}`;
const sign = (record) => ({
  ...record,
  payloadDigest: `sha256:${createHash("sha256").update(canonical(record)).digest("hex")}`,
});
const record = (kind, extra = {}) =>
  sign({
    id: `${kind}-1`,
    kind,
    subjectBinding: { taskId: "task-173", projectId: "project-native", repositoryId: "1456046543" },
    candidateSha: sha,
    capturedAt: new Date(now).toISOString(),
    result: "pass",
    producerIdentity: "native-integration",
    trustedIssuerRef: "native:reader",
    policyVersion: "guardian/1.1",
    facts: {},
    ...extra,
  });
const records = () => [
  record("commit", { facts: { exists: true, tree: "d".repeat(40) } }),
  record("remote_ref", { facts: { ref: "refs/heads/feat/task", sha } }),
  record("review", { reviewedSha: sha, facts: { independent: true, decision: "approved" } }),
  record("integration", {
    integrationSha: integrated,
    integrationTree: "e".repeat(40),
    facts: { state: "merged", sourceSha: sha, mergeMethod: "squash" },
  }),
  record("test", {
    integrationSha: integrated,
    facts: {
      sha: integrated,
      checks: ["unit", "typecheck", "lint", "boundaries", "build", "secrets", "regression"].map((name) => ({
        name,
        conclusion: "success",
        sha: integrated,
        issuerRef: "actions:15368",
      })),
    },
  }),
  record("artifact", {
    integrationSha: integrated,
    artifactDigest: digest,
    targetId: "local",
    facts: {
      sourceSha: integrated,
      tree: "e".repeat(40),
      dirty: false,
      dependencyLockDigest: digest,
      configDigest: digest,
      toolchainIdentity: "node-24",
    },
  }),
  record("promotion", { targetId: "local", artifactDigest: digest, facts: { installedArtifactDigest: digest } }),
  record("runtime", {
    targetId: "local",
    artifactDigest: digest,
    facts: {
      runningArtifactDigest: digest,
      identityVerified: true,
      compatibilityVerified: true,
      runtimeIdentity: "current-process",
    },
  }),
  record("feature", {
    targetId: "local",
    artifactDigest: digest,
    facts: {
      acceptanceIds: ["canary"],
      passedIds: ["canary"],
      fixtureApproved: true,
      runtimeIdentity: "current-process",
    },
  }),
];
const policy = () => ({
  version: "guardian/1.1",
  requiredFeatureIds: { local: ["canary"] },
  trustedCheckIssuers: ["actions:15368"],
});
async function verified(input, overrides = {}) {
  assert.equal(typeof implementation.createNativeEvidenceReader, "function", "native evidence boundary must exist");
  const byId = new Map(input.map((r) => [r.id, r]));
  return implementation.createNativeEvidenceReader({
    readRecord: async (id) => structuredClone(byId.get(id)),
    trustedIssuers: {
      "native:reader": [
        "commit",
        "remote_ref",
        "review",
        "integration",
        "test",
        "artifact",
        "promotion",
        "runtime",
        "feature",
        "exception",
      ],
    },
    policy: policy(),
    ...overrides,
  })(input.map((r) => r.id));
}
async function projection(input = records(), delivery = item(), options = {}) {
  const set = await verified(input);
  return implementation.reconcileDelivery(delivery, set, { now, ...options });
}
test("fresh native-read evidence distinguishes every stage and permits a current availability projection only", async () => {
  const p = await projection();
  for (const stage of [
    "committed",
    "pushed",
    "reviewed",
    "tested",
    "merged",
    "built",
    "installed_or_deployed",
    "running",
    "live_verified",
  ])
    assert.equal(p.currentClaims[stage].result, "pass", stage);
  assert.equal(p.goalResult, "pass");
  assert.equal(p.isAuthorizationGrant, false);
});
test("serialized evidence including forged trusted and pass flags is never authenticated", () => {
  assert.equal(typeof implementation.reconcileDelivery, "function");
  const p = implementation.reconcileDelivery(item(), { records: records(), trusted: true }, { now });
  assert.equal(p.currentClaims.committed.result, "unknown");
  assert.equal(p.goalResult, "unknown");
});
test("serialization of a valid handle loses the native provenance binding", async () => {
  const set = await verified(records());
  const p = implementation.reconcileDelivery(item(), JSON.parse(JSON.stringify(set)), { now });
  assert.equal(p.currentClaims.committed.result, "unknown");
});
test("a payload digest mismatch cannot be repaired by a pass status", async () => {
  const rs = records();
  rs[0].facts.tree = "f".repeat(40);
  assert.equal((await projection(rs)).currentClaims.committed.result, "unknown");
});
test("an unapproved issuer cannot impersonate a trusted check with the same name", async () => {
  const rs = records();
  const t = rs.find((r) => r.kind === "test");
  t.facts.checks[0].issuerRef = "untrusted:bot";
  delete t.payloadDigest;
  rs[rs.indexOf(t)] = sign(t);
  assert.equal((await projection(rs)).currentClaims.tested.result, "fail");
});
test("evidence for another native task or repository cannot be reused", async () => {
  const rs = records();
  const r = rs[0];
  delete r.payloadDigest;
  r.subjectBinding.repositoryId = "other";
  rs[0] = sign(r);
  assert.equal((await projection(rs)).currentClaims.committed.result, "unknown");
});
test("squash mapping requires final integration SHA tests", async () => {
  const rs = records();
  const t = rs.find((r) => r.kind === "test");
  delete t.payloadDigest;
  t.facts.sha = sha;
  t.facts.checks.forEach((c) => {
    c.sha = sha;
  });
  rs[rs.indexOf(t)] = sign(t);
  assert.equal((await projection(rs)).currentClaims.tested.result, "fail");
});
test("candidate ancestry alone is not an integration mapping", async () => {
  const rs = records();
  const r = rs.find((r) => r.kind === "integration");
  delete r.payloadDigest;
  r.facts = { ancestor: true };
  rs[rs.indexOf(r)] = sign(r);
  assert.equal((await projection(rs)).currentClaims.merged.result, "fail");
});
test("a newer reverted integration degrades availability without deleting historical evidence", async () => {
  const rs = records();
  rs.push(
    record("integration", {
      id: "integration-2",
      capturedAt: new Date(now + 1).toISOString(),
      integrationSha: integrated,
      facts: { state: "reverted", sourceSha: sha, mergeMethod: "squash" },
    }),
  );
  const p = await projection(rs, item(), { now: now + 1 });
  assert.equal(p.currentClaims.merged.result, "fail");
  assert.notEqual(p.currentClaims.live_verified.result, "pass");
  assert.equal(p.historicalClaims.length, rs.length);
});
test("a stale runtime degrades current availability", async () => {
  const p = await projection(records(), item(), { now: now + 60_001 });
  assert.equal(p.currentClaims.running.result, "stale");
  assert.notEqual(p.goalResult, "pass");
});
test("future observations are unknown and never current green", async () => {
  const p = await projection(records(), item(), { now: now - 1 });
  assert.equal(p.currentClaims.committed.result, "unknown");
});
test("one passing target cannot hide an unobserved mandatory target", async () => {
  const d = item();
  d.targetIds.push("another-device");
  const p = await projection(records(), d);
  assert.equal(p.targetAvailability.local.result, "pass");
  assert.equal(p.targetAvailability["another-device"].result, "not_run");
  assert.notEqual(p.goalResult, "pass");
});
test("a runtime artifact mismatch blocks the target even if feature receipt says pass", async () => {
  const rs = records();
  const r = rs.find((r) => r.kind === "runtime");
  delete r.payloadDigest;
  r.facts.runningArtifactDigest = `sha256:${"f".repeat(64)}`;
  rs[rs.indexOf(r)] = sign(r);
  assert.equal((await projection(rs)).targetAvailability.local.result, "fail");
});
test("HTTP health alone is not a safe fixture feature result", async () => {
  const rs = records();
  const r = rs.find((r) => r.kind === "feature");
  delete r.payloadDigest;
  r.facts = { httpStatus: 200 };
  rs[rs.indexOf(r)] = sign(r);
  assert.equal((await projection(rs)).currentClaims.live_verified.result, "fail");
});
test("backed_up is a selected goal and does not imply merged or deployed", async () => {
  const d = item();
  d.closeoutGoal = "backed_up";
  const p = await projection(
    records().filter((r) => ["commit", "remote_ref"].includes(r.kind)),
    d,
  );
  assert.equal(p.goalResult, "pass");
  assert.equal(p.currentClaims.merged.result, "not_run");
  assert.equal(p.currentClaims.live_verified.result, "not_run");
});
test("missing required tests cannot become not_applicable from a caller flag", async () => {
  const d = item();
  d.docsOnly = true;
  assert.equal(
    (
      await projection(
        records().filter((r) => r.kind !== "test"),
        d,
      )
    ).currentClaims.tested.result,
    "not_run",
  );
});
test("record load failure is explicit coverage failure, not an empty success", async () => {
  const set = await verified(records(), {
    readRecord: async () => {
      throw new Error("private credential must not leak");
    },
  });
  const p = implementation.reconcileDelivery(item(), set, { now });
  assert.equal(p.coverage.failed.length, records().length);
  assert.equal(p.goalResult, "unknown");
  assert.ok(!JSON.stringify(p).includes("private credential"));
});
test("two conflicting records with the same newest timestamp cannot be arbitrarily selected", async () => {
  const rs = records();
  rs.push(record("runtime", { id: "runtime-2", targetId: "local", artifactDigest: digest, result: "fail" }));
  assert.equal((await projection(rs)).currentClaims.running.result, "unknown");
});
test("mutation preflight cannot grant authority from JSON even with all flags set", () => {
  assert.equal(typeof implementation.validateTransition, "function");
  const d = implementation.validateTransition(
    { operation: "deploy", idempotencyKey: "stable-1", candidateSha: sha, targetId: "local" },
    { trusted: true },
    { state: "valid", observedAt: new Date(now).toISOString() },
    { state: "held", observedAt: new Date(now).toISOString() },
    { now },
  );
  assert.equal(d.decision, "blocked");
  assert.equal(d.isAuthorizationGrant, false);
  assert.ok(d.reasonCodes.includes("trusted_publisher_required"));
});
test("an unknown side effect is reconciled without retry", () => {
  assert.equal(typeof implementation.reconcileOperation, "function");
  assert.equal(
    implementation.reconcileOperation({ idempotencyKey: "same", state: "outcome_unknown" }, { state: "unknown" })
      .action,
    "observe_outcome",
  );
  assert.equal(
    implementation.reconcileOperation({ idempotencyKey: "same", state: "succeeded" }, { state: "unknown" }).action,
    "observe_outcome",
  );
  assert.equal(
    implementation.reconcileOperation(
      { idempotencyKey: "same", state: "outcome_unknown" },
      { state: "succeeded", idempotencyKey: "other" },
    ).action,
    "observe_outcome",
  );
});
test("fresh current reports state missing stages without claiming automatic deployment", async () => {
  const p = await projection(records().filter((r) => r.kind !== "feature"));
  assert.equal(typeof implementation.renderFounderReport, "function");
  const report = implementation.renderFounderReport(p);
  assert.equal(report.locale, "zh-HK");
  assert.equal(report.availableNow.local, false);
  assert.ok(report.notYetAvailable.includes("live_verified"));
});
