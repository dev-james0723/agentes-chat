import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkPromotion, runPlan, STEPS, sanitizeEnvironment, validateRequest } from "./local-ci.mjs";

const sha = "a".repeat(40),
  now = new Date("2026-11-16T23:00:00Z").toISOString();
const good = () => ({
  repository: "dev-james0723/agentes-chat",
  branch: "feat/task",
  head: sha,
  observedAt: now,
  clean: true,
  writerConfirmed: true,
  sourceVerified: true,
  freeBytes: 40 * 1024 ** 3,
  mode: "smoke",
  steps: ["guardian"],
});
test("trusted step registry contains no arbitrary shell inputs", () => {
  assert.ok(STEPS.guardian);
  assert.ok(STEPS.boundaries);
  assert.equal(STEPS.guardian.shell, false);
  assert.ok(!STEPS["sh -c 'rm -rf /'"]);
});
test("a valid smoke is eligible to test but not to release", () => {
  const r = validateRequest(good(), { now: Date.parse(now) });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.releaseReady, false);
});
for (const [name, change, code] of [
  ["wrong repository", (o) => (o.repository = "wrong/repo"), "repository_mismatch"],
  ["main not a test worktree", (o) => (o.branch = "main"), "protected_branch"],
  ["dirty source", (o) => (o.clean = false), "dirty_workspace"],
  ["moving head", (o) => (o.head = "b".repeat(40)), "head_mismatch"],
  ["writer uncertain", (o) => (o.writerConfirmed = false), "writer_unverified"],
  ["source not checked", (o) => (o.sourceVerified = false), "source_unverified"],
  ["expired observation", (o) => (o.observedAt = "2026-11-15T20:00:00Z"), "stale_evidence"],
  ["invalid job", (o) => (o.steps = ["execute arbitrary bash"]), "unknown_step"],
  ["no jobs", (o) => (o.steps = []), "no_steps"],
  [
    "small disk full verification",
    (o) => {
      o.mode = "full";
      o.freeBytes = 12 * 1024 ** 3;
    },
    "insufficient_disk",
  ],
  ["malformed missing size", (o) => delete o.freeBytes, "unknown_disk"],
])
  test(`preflight rejects ${name}`, () => {
    const o = good();
    change(o);
    const r = validateRequest(o, {
      now: Date.parse(now),
      expectedRepository: "dev-james0723/agentes-chat",
      expectedHead: sha,
    });
    assert.equal(r.ok, false);
    assert.ok(r.blockers.includes(code), JSON.stringify(r));
  });
test("preflight rejects spoofed trusted step shell", () => {
  const o = good();
  o.steps = [{ id: "guardian", command: "true; echo success" }];
  assert.equal(validateRequest(o, { now: Date.parse(now) }).ok, false);
});
test("a partial receipt cannot be promoted even when every executed step passed", () => {
  const r = checkPromotion({
    head: sha,
    expectedHead: sha,
    mode: "smoke",
    steps: [{ id: "guardian", exitCode: 0 }],
    source: "local",
    reviewed: true,
  });
  assert.equal(r.ok, false);
  assert.ok(r.blockers.includes("incomplete_release_suite"));
});
test("all-pass json written by a code-writing agent cannot promote itself", () => {
  const r = checkPromotion({
    head: sha,
    expectedHead: sha,
    mode: "full",
    steps: [...Object.keys(STEPS)].map((id) => ({ id, exitCode: 0 })),
    source: "untrusted",
    reviewed: true,
  });
  assert.equal(r.ok, false);
  assert.ok(r.blockers.includes("untrusted_source"));
});
test("a failed or timed-out required check blocks promotion", () => {
  for (const step of [
    { id: "typecheck", exitCode: 1 },
    { id: "typecheck", exitCode: null, timedOut: true },
  ]) {
    const r = checkPromotion({
      head: sha,
      expectedHead: sha,
      mode: "full",
      steps: [step],
      source: "trusted",
      reviewed: true,
    });
    assert.equal(r.ok, false);
    assert.ok(r.blockers.includes("failed_checks"));
  }
});
test("secret-bearing host environment is never passed to test processes", () => {
  const e = sanitizeEnvironment({
    PATH: "/usr/bin",
    HOME: "/private/home",
    CI: "true",
    GH_TOKEN: "topsecret",
    GITHUB_TOKEN: "topsecret",
    DATABASE_URL: "postgres://secret",
    AGENTES_SECRET: "hi",
    NPM_TOKEN: "secret",
  });
  assert.equal(e.GH_TOKEN, undefined);
  assert.equal(e.DATABASE_URL, undefined);
  assert.equal(e.AGENTES_SECRET, undefined);
  assert.equal(e.NPM_TOKEN, undefined);
  assert.equal(e.PATH, "/usr/bin");
  assert.equal(e.CI, "true");
});
test("runner returns a private truthful receipt for success and failure", async (t) => {
  const dest = mkdtempSync(join(tmpdir(), "local-ci-test-"));
  t.after(() => rmSync(dest, { recursive: true, force: true }));
  const result = await runPlan({
    root: dest,
    head: sha,
    plan: ["guardian", "boundaries"],
    destination: dest,
    execute: async (_cmd, step) => ({
      exitCode: step === "guardian" ? 0 : 1,
      stdout: "sample result",
      stderr: "",
      timedOut: false,
    }),
    clock: () => new Date(now),
  });
  assert.equal(result.releaseReady, false);
  assert.equal(result.steps.length, 2);
  assert.deepEqual(
    result.steps.map((x) => x.exitCode),
    [0, 1],
  );
  assert.equal(result.outcome, "failed");
  assert.ok(result.steps.every((x) => x.logSha256?.length === 64));
  assert.ok(result.steps.every((x) => !JSON.stringify(x).includes("topsecret")));
});
test("time-out never reports passed", async (t) => {
  const dest = mkdtempSync(join(tmpdir(), "local-ci-timeout-"));
  t.after(() => rmSync(dest, { recursive: true, force: true }));
  const x = await runPlan({
    root: dest,
    head: sha,
    plan: ["guardian"],
    destination: dest,
    execute: async () => ({ exitCode: null, stdout: "", stderr: "", timedOut: true }),
    clock: () => new Date(now),
  });
  assert.equal(x.outcome, "blocked");
  assert.equal(x.steps[0].state, "timeout");
  assert.equal(x.releaseReady, false);
});
