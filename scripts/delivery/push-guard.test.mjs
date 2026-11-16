import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("./push-guard.mjs", import.meta.url));
const environment = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
function git(root, ...args) {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", env: environment });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "push-guard-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-b", "feat/task");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Test");
  for (let i = 0; i < 100; i++) writeFileSync(join(root, `base-${i}.txt`), "baseline\n");
  git(root, "add", "--", ".");
  git(root, "commit", "-m", "baseline");
  const base = git(root, "rev-parse", "HEAD");
  git(root, "remote", "add", "origin", "https://github.com/example/app.git");
  git(root, "update-ref", "refs/remotes/origin/main", base);
  return { root, base };
}
function commit(root, path, text) {
  writeFileSync(join(root, path), text);
  git(root, "add", "--", path);
  git(root, "commit", "-m", "scoped change");
  return git(root, "rev-parse", "HEAD");
}
function hook(
  root,
  {
    ref = "refs/heads/feat/task",
    sha = git(root, "rev-parse", "HEAD"),
    url = "https://github.com/example/app.git",
    extra = "",
    empty = false,
  } = {},
) {
  assert.ok(existsSync(cli), "push guard implementation must exist");
  return spawnSync(process.execPath, [cli, "--repository", "example/app", "origin", url], {
    cwd: root,
    env: environment,
    encoding: "utf8",
    input: empty ? "" : `refs/heads/feat/task ${sha} ${ref} ${"0".repeat(40)}\n${extra}`,
  });
}
test("push hook allows one reviewed task branch and does not alter history", (t) => {
  const { root } = fixture(t);
  const head = commit(root, "safe.txt", "safe");
  const r = hook(root);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(root, "rev-parse", "HEAD"), head);
  assert.equal(git(root, "status", "--porcelain"), "");
});
test("push hook rejects direct main push", (t) => {
  const { root } = fixture(t);
  const r = hook(root, { ref: "refs/heads/main" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /protected_ref/);
});
test("push hook rejects a different repository", (t) => {
  const { root } = fixture(t);
  const r = hook(root, { url: "https://github.com/other/app.git" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /repository_mismatch/);
});
test("push hook rejects another branch object", (t) => {
  const { root, base } = fixture(t);
  commit(root, "safe.txt", "safe");
  const r = hook(root, { sha: base });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /head_mismatch/);
});
test("push hook rejects remote branch deletion", (t) => {
  const { root } = fixture(t);
  const r = hook(root, { sha: "0".repeat(40) });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /branch_deletion/);
});
test("push hook rejects multiple references", (t) => {
  const { root } = fixture(t);
  const r = hook(root, {
    extra: `refs/heads/feat/task ${git(root, "rev-parse", "HEAD")} refs/heads/another ${"0".repeat(40)}\n`,
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /multiple_refs/);
});
test("push hook rejects a secret file", (t) => {
  const { root } = fixture(t);
  commit(root, ".env", "LOCAL_ONLY=yes");
  const r = hook(root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /protected_path/);
  assert.doesNotMatch(r.stderr, /LOCAL_ONLY/);
});
test("push hook catches a token removed in the next commit, without disclosing it", (t) => {
  const { root } = fixture(t);
  const token = ["gh", "p_", "A".repeat(36)].join("");
  commit(root, "leak.txt", token);
  git(root, "rm", "leak.txt");
  git(root, "commit", "-m", "remove secret");
  const r = hook(root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /secret_pattern/);
  assert.ok(!r.stderr.includes(token));
});
test("push hook catches a private key in an ordinary text file", (t) => {
  const { root } = fixture(t);
  commit(root, "note.txt", ["-----BEGIN", " PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----"].join(""));
  const r = hook(root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /secret_pattern/);
});
test("push hook blocks mass deletion", (t) => {
  const { root } = fixture(t);
  for (let i = 0; i < 21; i++) git(root, "rm", `base-${i}.txt`);
  git(root, "commit", "-m", "large deletion");
  const r = hook(root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /bulk_deletion/);
});
test("push hook rejects added symlinks", (t) => {
  const { root } = fixture(t);
  symlinkSync("/etc/passwd", join(root, "outside"));
  git(root, "add", "outside");
  git(root, "commit", "-m", "link");
  const r = hook(root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /symlink/);
});
test("empty push is a no-op", (t) => {
  const { root } = fixture(t);
  assert.equal(hook(root, { empty: true }).status, 0);
});
