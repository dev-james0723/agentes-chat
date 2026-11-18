import assert from "node:assert/strict";
import { test } from "node:test";
import { reconcileOperation } from "./reconcile.mjs";

const subject = Object.freeze({
  projectId: "project-1",
  taskId: "task-1",
  repositoryId: "repo-1",
  operation: "deploy",
  targetId: "production",
  artifactDigest: "sha256:" + "a".repeat(64),
  candidateSha: "b".repeat(40),
  idempotencyKey: "operation-1",
});

test("A37: full subject-matched succeeded observation can reuse prior outcome without executing", () => {
  const actual = reconcileOperation({ ...subject, state: "succeeded" }, { ...subject, state: "succeeded" });
  assert.equal(actual.action, "reuse_result");
  assert.equal(actual.execute, false);
});

test("A37: a succeeded label alone cannot reuse an unbound result", () => {
  for (const observation of [undefined, {}, { state: "unknown" }, { state: "succeeded" }]) {
    const actual = reconcileOperation({ idempotencyKey: "operation-1", state: "succeeded" }, observation);
    assert.notEqual(actual.action, "reuse_result", String(observation?.state ?? "absent"));
    assert.equal(actual.execute, false);
  }
});

test("A37: a failed/stale/unknown observation cannot validate a previous success", () => {
  for (const state of ["unknown", "failed", "stale", "not_run"]) {
    const actual = reconcileOperation({ ...subject, state: "succeeded" }, { ...subject, state });
    assert.notEqual(actual.action, "reuse_result", state);
    assert.equal(actual.execute, false);
  }
});

test("A37: any mismatched or missing operation identity refuses success reuse", () => {
  for (const field of Object.keys(subject)) {
    for (const variant of [
      {
        ...subject,
        [field]: field === "artifactDigest" ? "sha256:" + "f".repeat(64) : "different",
        state: "succeeded",
      },
      { ...subject, state: "succeeded", [field]: undefined },
    ]) {
      const actual = reconcileOperation({ ...subject, state: "succeeded" }, variant);
      assert.notEqual(actual.action, "reuse_result", field);
      assert.equal(actual.execute, false);
    }
  }
});

test("A37: unknown-effect recovery observes evidence before recording and never retries effects", () => {
  const pending = { ...subject, state: "outcome_unknown" };
  assert.deepEqual(reconcileOperation(pending, { ...subject, state: "succeeded" }), {
    action: "record_observed_success",
    execute: false,
  });
  for (const state of ["unknown", "failed", "stale"]) {
    const actual = reconcileOperation(pending, { ...subject, state });
    assert.equal(actual.action, "observe_outcome");
    assert.equal(actual.execute, false);
  }
});
