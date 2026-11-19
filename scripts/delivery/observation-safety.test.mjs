import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { REQUIRED_RELEASE_CHECKS } from "./policy.mjs";

const collector = fileURLToPath(new URL("./guardian.mjs", import.meta.url));
const pushGuard = fileURLToPath(new URL("./push-guard.mjs", import.meta.url));
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
function git(root, ...args) {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
function fixture(t, content = "original\n") {
  const root = mkdtempSync(join(tmpdir(), "guardian-trust-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-b", "feat/task");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Test");
  writeFileSync(join(root, "base.txt"), content);
  git(root, "add", "base.txt");
  git(root, "commit", "-m", "baseline");
  git(root, "remote", "add", "origin", "https://github.com/example/app.git");
  const base = git(root, "rev-parse", "HEAD");
  git(root, "update-ref", "refs/remotes/origin/main", base);
  return { root, base };
}
function observe(root, extraEnv = {}) {
  return spawnSync(process.execPath, [collector, "observe", "--root", root], {
    encoding: "utf8",
    env: { ...env, ...extraEnv },
  });
}
function commit(root, path, text) {
  writeFileSync(join(root, path), text);
  git(root, "add", "--", path);
  git(root, "commit", "-m", "change");
  return git(root, "rev-parse", "HEAD");
}
function push(root, old = "0".repeat(40)) {
  const head = git(root, "rev-parse", "HEAD");
  return spawnSync(
    process.execPath,
    [pushGuard, "--repository", "example/app", "origin", "https://github.com/example/app.git"],
    {
      cwd: root,
      env,
      encoding: "utf8",
      input: `refs/heads/feat/task ${head} refs/heads/feat/task ${old}\n`,
    },
  );
}

test("explicit repository identity cannot be redirected by inherited GIT_DIR and GIT_WORK_TREE", (t) => {
  const target = fixture(t),
    foreign = fixture(t, "different\n");
  const r = observe(target.root, { GIT_DIR: join(foreign.root, ".git"), GIT_WORK_TREE: target.root });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).head, target.base);
});

test("observation ignores an inherited foreign index without modifying either index", (t) => {
  const target = fixture(t),
    foreign = fixture(t, "different\n");
  const index = join(foreign.root, ".git/index"),
    before = readFileSync(index);
  const r = observe(target.root, { GIT_INDEX_FILE: index });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).staged, []);
  assert.deepEqual(readFileSync(index), before);
});

test("read-only observation never runs a configured clean filter", (t) => {
  const { root } = fixture(t);
  commit(root, ".gitattributes", "base.txt filter=probe\n");
  const marker = join(root, "filter-executed"),
    script = join(root, ".git/probe.cjs");
  writeFileSync(
    script,
    `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},'executed');process.stdout.write(fs.readFileSync(0));`,
  );
  git(root, "config", "filter.probe.clean", `"${process.execPath}" "${script}"`);
  writeFileSync(join(root, "base.txt"), "modified\n");
  utimesSync(join(root, "base.txt"), new Date(100000), new Date(100000));
  const r = observe(root);
  assert.equal(existsSync(marker), false, "observation executed repository-supplied code");
  const o = JSON.parse(r.stdout);
  assert.equal(r.status, 1, "suppressed filters must not silently certify a clean worktree");
  assert.ok(o.errors.includes("content_filters_unverified"));
});

test("a caller-written all-pass release JSON is never a trusted release receipt", (t) => {
  const { root, base } = fixture(t),
    now = new Date().toISOString();
  const evidence = {
    head: base,
    expectedHead: base,
    observedAt: now,
    authorized: true,
    trustedChecks: true,
    requiredChecks: [...REQUIRED_RELEASE_CHECKS],
    checks: REQUIRED_RELEASE_CHECKS.map((name) => ({ name, sha: base, conclusion: "success", observedAt: now })),
    review: { sha: base, decision: "approved", independent: true, observedAt: now },
    activeRuns: 0,
    hazardsReviewed: true,
    exclusiveLease: true,
    backupRestoreVerified: true,
    stagedArtifactVerified: true,
    rollbackVerified: true,
    runnerCompatible: true,
  };
  const file = join(root, "self-asserted.json");
  writeFileSync(file, JSON.stringify(evidence));
  const r = spawnSync(process.execPath, [collector, "check-release", "--evidence", file], { env, encoding: "utf8" });
  assert.equal(r.status, 1);
  const result = JSON.parse(r.stdout);
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes("untrusted_checks"));
  assert.equal(result.assessmentOnly, true);
});

test("replacement objects cannot conceal a secret in unpublished history", (t) => {
  const { root, base } = fixture(t),
    token = ["gh", "p_", "A".repeat(36)].join("");
  const secretCommit = commit(root, "leak.txt", token);
  git(root, "rm", "leak.txt");
  git(root, "commit", "-m", "remove leaked content");
  const tree = git(root, "rev-parse", `${base}^{tree}`);
  const replacement = git(root, "commit-tree", tree, "-p", base, "-m", "benign replacement");
  git(root, "replace", secretCommit, replacement);
  const r = push(root, base);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /secret_pattern/);
  assert.ok(!r.stderr.includes(token));
});

test("pre-push refuses a non-fast-forward change to an existing task branch", (t) => {
  const { root, base } = fixture(t);
  commit(root, "safe.txt", "safe");
  const sibling = git(
    root,
    "commit-tree",
    git(root, "rev-parse", `${base}^{tree}`),
    "-p",
    base,
    "-m",
    "server-only branch",
  );
  const r = push(root, sibling);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /non_fast_forward/);
});

test("advertised remote target, not a misleading cached ref, bounds an existing branch scan", (t) => {
  const { root, base } = fixture(t),
    token = ["gh", "p_", "B".repeat(36)].join("");
  const head = commit(root, "leak.txt", token);
  git(root, "update-ref", "refs/remotes/origin/misleading", head);
  const r = push(root, base);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /secret_pattern/);
  assert.ok(!r.stderr.includes(token));
});
