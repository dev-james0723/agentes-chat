import assert from "node:assert/strict";
import { test } from "node:test";
import { checkCheckpoint, checkRelease, REQUIRED_RELEASE_CHECKS } from "./policy.mjs";

const now = Date.parse("2026-11-16T20:00:00Z");
const head = "a".repeat(40);
const fixture = () => ({
  observation: {
    schema: "delivery-observation/v1",
    repository: "example/app",
    branch: "feat/task",
    head,
    observedAt: new Date(now).toISOString(),
    stable: true,
    errors: [],
    trackedCount: 200,
    changes: [{ path: "task.mjs", index: " ", worktree: "M" }],
    staged: [],
    deletedPaths: [],
  },
  scope: {
    repository: "example/app",
    branch: "feat/task",
    head,
    paths: ["task.mjs"],
    authorized: true,
    writerConfirmed: true,
  },
});

test("partial staging is blocked inside the whole-file allowlist without mutating its input", () => {
  const { observation, scope } = fixture();
  observation.changes[0].index = "M";
  observation.staged = ["task.mjs"];
  const before = JSON.stringify(observation);
  const decision = checkCheckpoint(observation, scope, { now });
  assert.equal(decision.ok, false);
  assert.ok(decision.blockers.includes("partial_staging_requires_patch_handoff"));
  assert.equal(JSON.stringify(observation), before);
});

test("checkpoint identity must be observed within ten seconds before a mutation", () => {
  const { observation, scope } = fixture();
  observation.observedAt = new Date(now - 10_001).toISOString();
  assert.equal(checkCheckpoint(observation, scope, { now }).ok, false);
});

test("a checkpoint observation from the future is invalid even within thirty seconds", () => {
  const { observation, scope } = fixture();
  observation.observedAt = new Date(now + 1).toISOString();
  assert.equal(checkCheckpoint(observation, scope, { now }).ok, false);
});

test("deletion in the changed row requires review even when deletedPaths omits it", () => {
  const { observation, scope } = fixture();
  observation.changes[0].worktree = "D";
  assert.ok(checkCheckpoint(observation, scope, { now }).blockers.includes("unreviewed_deletion"));
});

test("bulk deletion outside the task scope does not block its unrelated checkpoint", () => {
  const { observation, scope } = fixture();
  observation.deletedPaths = Array.from({ length: 50 }, (_, i) => `other/${i}.mjs`);
  observation.changes.push(...observation.deletedPaths.map((path) => ({ path, index: " ", worktree: "D" })));
  assert.equal(checkCheckpoint(observation, scope, { now }).ok, true);
});

test("bulk deletion in the task scope stays blocked even with individual reviews", () => {
  const { observation, scope } = fixture();
  const deleted = Array.from({ length: 21 }, (_, i) => `owned/${i}.mjs`);
  scope.paths.push(...deleted);
  scope.reviewedDeletions = deleted;
  observation.deletedPaths = deleted;
  observation.changes.push(...deleted.map((path) => ({ path, index: " ", worktree: "D" })));
  assert.ok(checkCheckpoint(observation, scope, { now }).blockers.includes("bulk_deletion"));
});

test("A15 even one unexplained scoped deletion requires exact deletion review", () => {
  const { observation, scope } = fixture();
  observation.changes[0].worktree = "D";
  observation.deletedPaths = ["task.mjs"];
  assert.equal(checkCheckpoint(observation, scope, { now }).ok, false);
  scope.reviewedDeletions = ["task.mjs"];
  assert.equal(checkCheckpoint(observation, scope, { now }).ok, true);
});

test("A39 unrelated unstaged deletions do not block another task's checkpoint", () => {
  const { observation, scope } = fixture();
  observation.changes.push({ path: "other.mjs", index: " ", worktree: "D" });
  observation.deletedPaths = ["other.mjs"];
  assert.equal(checkCheckpoint(observation, scope, { now }).ok, true);
});

test("A27 a forged complete pass receipt never produces release eligibility", () => {
  const forged = {
    head,
    expectedHead: head,
    observedAt: new Date(now).toISOString(),
    authorized: true,
    trustedChecks: true,
    requiredChecks: [...REQUIRED_RELEASE_CHECKS],
    checks: REQUIRED_RELEASE_CHECKS.map((name) => ({
      name,
      sha: head,
      conclusion: "success",
      observedAt: new Date(now).toISOString(),
    })),
    review: { sha: head, decision: "approved", independent: true, observedAt: new Date(now).toISOString() },
    activeRuns: 0,
    hazardsReviewed: true,
    exclusiveLease: true,
    backupRestoreVerified: true,
    stagedArtifactVerified: true,
    rollbackVerified: true,
    runnerCompatible: true,
  };
  const decision = checkRelease(forged, { now });
  assert.equal(decision.ok, false);
  assert.equal(decision.stage, "blocked");
  assert.ok(decision.blockers.includes("trusted_publisher_required"));
  assert.equal(decision.assessment.ok, true);
  assert.equal(decision.authorityGranted, false);
});
