import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createGitReader } from "./git-read.mjs";
import { observe } from "./guardian.mjs";

const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
function git(root, ...args) {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "guardian-reader-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-b", "feat/task");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Test");
  writeFileSync(join(root, "base.txt"), "original\n");
  git(root, "add", "base.txt");
  git(root, "commit", "-m", "baseline");
  git(root, "remote", "add", "origin", "https://github.com/example/app.git");
  return root;
}
function filter(root) {
  const marker = join(root, "filter-executed"),
    script = join(root, ".git/probe.cjs");
  writeFileSync(
    script,
    `require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed');process.stdout.write(require('node:fs').readFileSync(0))`,
  );
  writeFileSync(join(root, ".gitattributes"), "base.txt filter=probe\n");
  git(root, "config", "filter.probe.clean", `"${process.execPath}" "${script}"`);
  return marker;
}

test("config added during provider read cannot execute a content filter", (t) => {
  const root = fixture(t),
    index = readFileSync(join(root, ".git/index"));
  writeFileSync(join(root, "base.txt"), "modified\n");
  let marker;
  const observed = observe(root, {
    network: true,
    providerRefLookup() {
      marker = filter(root);
      return { source: "github_api", sha: git(root, "rev-parse", "HEAD"), observedAt: new Date().toISOString() };
    },
  });
  assert.equal(existsSync(marker), false, "a readonly observation executed newly configured code");
  assert.equal(observed.stable, false);
  assert.ok(observed.errors.includes("content_filters_unverified"));
  assert.deepEqual(readFileSync(join(root, ".git/index")), index);
});

test("ambient global Git config cannot redirect the selected repository", (t) => {
  const root = fixture(t),
    config = join(root, ".git/foreign-global-config");
  writeFileSync(config, '[url "https://github.com/foreign/"]\n  insteadOf = https://github.com/example/\n');
  const previous = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = config;
  try {
    assert.equal(observe(root).repository, "example/app");
  } finally {
    if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previous;
  }
});

test("reader refuses output-writing options and network Git transports", (t) => {
  const root = fixture(t),
    output = join(root, "diff-output"),
    reader = createGitReader(root);
  assert.throws(() => reader.read(["diff", `--output=${output}`]), /Non-observation/);
  assert.throws(() => reader.read(["ls-remote", "origin"]), /Non-observation/);
  assert.equal(existsSync(output), false);
});

test("submodule content cannot run a configured filter during parent observation", (t) => {
  const root = fixture(t),
    child = join(root, "nested");
  git(root, "clone", "--quiet", root, child);
  const sha = git(child, "rev-parse", "HEAD");
  git(root, "update-index", "--add", "--cacheinfo", `160000,${sha},nested`);
  git(root, "commit", "-m", "gitlink");
  const marker = filter(child);
  writeFileSync(join(child, "base.txt"), "modified\n");
  const observed = observe(root);
  assert.equal(existsSync(marker), false);
  assert.ok(observed.errors.includes("submodule_content_unverified"));
});

test("split index is copied privately without changing either source index", (t) => {
  const root = fixture(t);
  git(root, "update-index", "--split-index");
  const path = git(root, "rev-parse", "--shared-index-path");
  const shared = path.startsWith("/") ? path : join(root, path);
  const indexBefore = readFileSync(join(root, ".git/index")),
    sharedBefore = readFileSync(shared);
  const observed = observe(root);
  assert.equal(observed.stable, true);
  assert.deepEqual(observed.errors, []);
  assert.deepEqual(readFileSync(join(root, ".git/index")), indexBefore);
  assert.deepEqual(readFileSync(shared), sharedBefore);
});

test("oversized index fails before copying it into temporary metadata", (t) => {
  const root = fixture(t);
  writeFileSync(join(root, ".git/index"), Buffer.alloc(16 * 1024 * 1024 + 1));
  assert.throws(() => observe(root), /Git index snapshot unavailable/);
});

test("index symlinks are refused without following or modifying their target", (t) => {
  const root = fixture(t),
    index = join(root, ".git/index"),
    target = join(root, ".git/index-owned-fixture");
  const before = readFileSync(index);
  renameSync(index, target);
  symlinkSync(target, index);
  assert.throws(() => observe(root), /Git index (?:snapshot unavailable|outside selected metadata)/);
  assert.deepEqual(readFileSync(target), before);
});
