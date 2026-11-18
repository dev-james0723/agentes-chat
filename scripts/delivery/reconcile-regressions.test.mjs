import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createNativeEvidenceReader, reconcileDelivery, reconcileOperation } from "./reconcile.mjs";

const NOW = Date.parse("2026-11-16T20:00:00.000Z");
const SOURCE = "a".repeat(40),
  INTEGRATED = "b".repeat(40);
const SOURCE_TREE = "d".repeat(40),
  INTEGRATED_TREE = "e".repeat(40);
const DIGEST = "sha256:" + "c".repeat(64);
const KINDS = ["commit", "remote_ref", "review", "integration", "test", "artifact", "promotion", "runtime", "feature"];
const CHECKS = ["unit", "typecheck", "lint", "boundaries", "build", "secrets", "regression"];
const item = () => ({
  taskId: "qa-task",
  projectId: "qa-project",
  repositoryId: "1456046543",
  candidateSha: SOURCE,
  candidateTree: SOURCE_TREE,
  branch: "feat/qa",
  targetIds: ["local"],
  closeoutGoal: "available_on_selected_targets",
});
const canonical = (value) =>
  value === null || typeof value !== "object"
    ? JSON.stringify(value)
    : Array.isArray(value)
      ? "[" + value.map(canonical).join(",") + "]"
      : "{" +
        Object.keys(value)
          .sort()
          .map((key) => JSON.stringify(key) + ":" + canonical(value[key]))
          .join(",") +
        "}";
const sign = (value) => ({
  ...value,
  payloadDigest: "sha256:" + createHash("sha256").update(canonical(value)).digest("hex"),
});
const record = (kind, extra = {}) =>
  sign({
    id: kind + "-1",
    kind,
    subjectBinding: { taskId: "qa-task", projectId: "qa-project", repositoryId: "1456046543" },
    candidateSha: SOURCE,
    capturedAt: new Date(NOW).toISOString(),
    result: "pass",
    producerIdentity: "qa-native-adapter",
    trustedIssuerRef: "native:qa",
    policyVersion: "guardian/1.1",
    facts: {},
    ...extra,
  });
const records = () => [
  record("commit", { facts: { exists: true, tree: SOURCE_TREE } }),
  record("remote_ref", { facts: { ref: "refs/heads/feat/qa", sha: SOURCE } }),
  record("review", { reviewedSha: SOURCE, facts: { independent: true, decision: "approved" } }),
  record("integration", {
    integrationSha: INTEGRATED,
    integrationTree: INTEGRATED_TREE,
    facts: { state: "merged", sourceSha: SOURCE, mergeMethod: "squash" },
  }),
  record("test", {
    integrationSha: INTEGRATED,
    facts: {
      sha: INTEGRATED,
      checks: CHECKS.map((name) => ({ name, sha: INTEGRATED, conclusion: "success", issuerRef: "actions:qa" })),
    },
  }),
  record("artifact", {
    integrationSha: INTEGRATED,
    artifactDigest: DIGEST,
    targetId: "local",
    facts: {
      sourceSha: INTEGRATED,
      tree: INTEGRATED_TREE,
      dirty: false,
      dependencyLockDigest: DIGEST,
      configDigest: DIGEST,
      toolchainIdentity: "node-24",
    },
  }),
  record("promotion", { targetId: "local", artifactDigest: DIGEST, facts: { installedArtifactDigest: DIGEST } }),
  record("runtime", {
    targetId: "local",
    artifactDigest: DIGEST,
    facts: {
      runningArtifactDigest: DIGEST,
      identityVerified: true,
      compatibilityVerified: true,
      runtimeIdentity: "current-process",
    },
  }),
  record("feature", {
    targetId: "local",
    artifactDigest: DIGEST,
    facts: {
      acceptanceIds: ["canary"],
      passedIds: ["canary"],
      fixtureApproved: true,
      runtimeIdentity: "current-process",
    },
  }),
];
function revise(values, kind, update) {
  const index = values.findIndex((value) => value.kind === kind);
  const { payloadDigest, ...payload } = structuredClone(values[index]);
  update(payload);
  values[index] = sign(payload);
}
async function project(values) {
  const byId = new Map(values.map((value) => [value.id, value]));
  const read = createNativeEvidenceReader({
    readRecord: async (id) => structuredClone(byId.get(id)),
    trustedIssuers: { "native:qa": KINDS },
    policy: { version: "guardian/1.1", trustedCheckIssuers: ["actions:qa"], requiredFeatureIds: { local: ["canary"] } },
  });
  return reconcileDelivery(item(), await read(values.map((value) => value.id)), { now: NOW + 1 });
}

test("QA control: exact clean build and runtime binding permit projection without authority", async () => {
  const projection = await project(records());
  assert.equal(projection.goalResult, "pass");
  assert.equal(projection.isAuthorizationGrant, false);
});

test("QA regression: a dirty artifact cannot become a passing build or target", async () => {
  const values = records();
  revise(values, "artifact", (value) => {
    value.facts.dirty = true;
  });
  const projection = await project(values);
  assert.equal(projection.currentClaims.built.result, "fail");
  assert.notEqual(projection.goalResult, "pass");
  assert.notEqual(projection.targetAvailability.local.result, "pass");
});

test("QA regression: another valid tree hash cannot replace the exact integrated tree", async () => {
  const values = records();
  revise(values, "artifact", (value) => {
    value.facts.tree = "f".repeat(40);
  });
  const projection = await project(values);
  assert.equal(projection.currentClaims.built.result, "fail");
  assert.notEqual(projection.goalResult, "pass");
});

test("QA regression: an unreadable newer failure cannot leave an older pass green", async () => {
  const values = records();
  const newer = record("runtime", {
    id: "runtime-newer",
    targetId: "local",
    artifactDigest: DIGEST,
    result: "fail",
    capturedAt: new Date(NOW + 1).toISOString(),
  });
  newer.payloadDigest = "sha256:" + "0".repeat(64);
  values.push(newer);
  const projection = await project(values);
  assert.equal(projection.coverage.failed.length, 1);
  assert.equal(projection.goalResult, "unknown");
  assert.equal(projection.targetAvailability.local.result, "unknown");
});

test("QA regression: a feature pass from an older runtime instance cannot verify the current one", async () => {
  const values = records();
  revise(values, "feature", (value) => {
    value.facts.runtimeIdentity = "old-process";
  });
  const projection = await project(values);
  assert.equal(projection.currentClaims.live_verified.result, "fail");
  assert.notEqual(projection.targetAvailability.local.result, "pass");
});

test("QA regression: success readback requires the entire operation subject, beyond its key", () => {
  const subject = {
    projectId: "qa-project",
    taskId: "qa-task",
    repositoryId: "1456046543",
    operation: "deploy",
    targetId: "production",
    artifactDigest: DIGEST,
    candidateSha: SOURCE,
    idempotencyKey: "qa-attempt-1",
  };
  const attempt = { ...subject, state: "outcome_unknown" };
  const observation = { ...subject, state: "succeeded" };
  assert.equal(reconcileOperation(attempt, observation).action, "record_observed_success");
  for (const [field, other] of Object.entries({
    projectId: "other-project",
    taskId: "other-task",
    repositoryId: "other-repository",
    operation: "delete",
    targetId: "staging",
    artifactDigest: "sha256:" + "f".repeat(64),
    candidateSha: "f".repeat(40),
    idempotencyKey: "other-attempt",
  })) {
    const result = reconcileOperation(attempt, { ...observation, [field]: other });
    assert.notEqual(result.action, "record_observed_success", field);
    assert.notEqual(result.action, "reuse_result", field);
    assert.equal(result.execute, false, field);
  }
});
