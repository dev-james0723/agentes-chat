import assert from "node:assert/strict";
import { test } from "node:test";

let implementation = {};
try {
  implementation = await import("./cross-project-cli.mjs");
} catch {}
test("cross-project CLI has no mutation command and rejects command injection", async () => {
  assert.equal(typeof implementation.runCrossProject, "function");
  await assert.rejects(implementation.runCrossProject("deploy", {}), /read-only/);
  await assert.rejects(
    implementation.runCrossProject("inspect-macos", { bundlePath: "/Applications/Fileroom.app", run: "touch owned" }),
    /host-only/,
  );
});
test("identity command cannot silently scan arbitrary roots", async () => {
  assert.equal(typeof implementation.runCrossProject, "function");
  await assert.rejects(implementation.runCrossProject("identity", { root: "/" }), /approvedRoots/);
});
test("runtime command returns explicit unsupported target on this OS, not installed or live", async () => {
  assert.equal(typeof implementation.runCrossProject, "function");
  const r = await implementation.runCrossProject("inspect-macos", {
    bundlePath: "/does-not-exist.app",
    expectedBundleId: "example.test",
  });
  assert.ok(r.errors.length > 0);
  assert.notEqual(r.liveVerified, true);
});
test("serialized observations cannot become a native projection through CLI", async () => {
  assert.equal(typeof implementation.runCrossProject, "function");
  await assert.rejects(implementation.runCrossProject("reconcile", { records: [], trusted: true }), /read-only/);
});
