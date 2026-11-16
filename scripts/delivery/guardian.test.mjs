import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const modulePath = new URL("./guardian.mjs", import.meta.url);
const implementation = existsSync(modulePath) ? await import(modulePath.href) : {};
const git = (cwd, ...args) => {
  const r = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "delivery-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-b", "feat/task");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Test");
  writeFileSync(join(root, "base.txt"), "baseline\n");
  git(root, "add", "base.txt");
  git(root, "commit", "-m", "baseline");
  git(root, "remote", "add", "origin", "https://github.com/example/app.git");
  return root;
}
function observe(root) {
  assert.equal(typeof implementation.observe, "function", "read-only collector must exist");
  return implementation.observe(root, { remote: "origin" });
}

test("observe real Git without changing HEAD, index, config or work files", (t) => {
  const root = fixture(t);
  writeFileSync(join(root, "base.txt"), "changed\n");
  const before = [".git/index", ".git/config", "base.txt"].map((p) => readFileSync(join(root, p)));
  const head = git(root, "rev-parse", "HEAD").trim();
  const x = observe(root);
  assert.equal(x.repository, "example/app");
  assert.equal(x.head, head);
  assert.equal(x.branch, "feat/task");
  assert.equal(x.stable, true);
  assert.equal(x.remote.status, "not_requested");
  assert.equal(x.remote.head, null);
  assert.equal(x.deployment.status, "unknown");
  assert.deepEqual(x.errors, []);
  assert.ok(x.changes.some((c) => c.path === "base.txt" && c.worktree === "M"));
  for (const [i, p] of [".git/index", ".git/config", "base.txt"].entries())
    assert.deepEqual(readFileSync(join(root, p)), before[i]);
});
test("untracked names preserve Unicode, spaces, newline and shell metacharacters", (t) => {
  const root = fixture(t),
    names = ["中文 樂譜.txt", "new\nline.txt", "$(touch SHOULD-NOT-EXIST).txt", "--delete.txt"];
  for (const n of names) writeFileSync(join(root, n), "test");
  const x = observe(root);
  assert.deepEqual(x.changes.map((c) => c.path).sort(), names.sort());
  assert.equal(existsSync(join(root, "SHOULD-NOT-EXIST")), false);
});
test("rename includes old and new path, staged inventory does not lose either", (t) => {
  const root = fixture(t);
  git(root, "mv", "base.txt", "renamed 文本.txt");
  const x = observe(root);
  assert.ok(x.changes.some((c) => c.path === "renamed 文本.txt" && c.originalPath === "base.txt"));
  assert.ok(x.staged.includes("base.txt"));
  assert.ok(x.staged.includes("renamed 文本.txt"));
});
test("symlink to outside worktree is classified unsafe without reading its contents", (t) => {
  const root = fixture(t);
  symlinkSync("/etc/passwd", join(root, "external.txt"));
  const x = observe(root);
  assert.ok(x.changes.some((c) => c.path === "external.txt" && c.pathSafe === false && c.symlink === true));
});
test("tracked deletion is counted", (t) => {
  const root = fixture(t);
  rmSync(join(root, "base.txt"));
  assert.deepEqual(observe(root).deletedPaths, ["base.txt"]);
});
test("different push target is an error, never a safe snapshot", (t) => {
  const root = fixture(t);
  git(root, "remote", "set-url", "--push", "origin", "https://github.com/someone/else.git");
  const x = observe(root);
  assert.ok(x.errors.includes("push_remote_mismatch"));
});
test("missing remote remains unknown instead of guessing origin", (t) => {
  const root = fixture(t);
  git(root, "remote", "remove", "origin");
  const x = observe(root);
  assert.equal(x.repository, null);
  assert.ok(x.errors.includes("remote_unavailable"));
});
test("requesting a nested directory is rejected instead of silently choosing its parent", (t) => {
  const root = fixture(t);
  mkdirSync(join(root, "nested"));
  assert.throws(() => observe(join(root, "nested")), /repository root/i);
});
test("CLI cannot commit, merge, reset or deploy", (t) => {
  const root = fixture(t);
  assert.ok(existsSync(modulePath), "collector module must exist");
  const before = git(root, "rev-parse", "HEAD");
  const r = spawnSync(process.execPath, [fileURLToPath(modulePath), "deploy", "--root", root], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.equal(git(root, "rev-parse", "HEAD"), before);
});
test("malformed status record is an error rather than silently ignored", () => {
  assert.equal(typeof implementation.parseStatus, "function");
  assert.throws(() => implementation.parseStatus("M\0"), /status/i);
});
test("report labels remote/deployment unknown and safely escapes HTML-like names", (t) => {
  const root = fixture(t);
  writeFileSync(join(root, "<script>.txt"), "x");
  const x = observe(root);
  assert.equal(typeof implementation.founderSummary, "function");
  const text = implementation.founderSummary(x);
  assert.match(text, /未核實/);
  assert.doesNotMatch(text, /已上線/);
  assert.ok(text.includes(x.head.slice(0, 9)));
});

test("text output keeps a failing observation exit code", (t) => {
  const root = fixture(t);
  git(root, "remote", "remove", "origin");
  const r = spawnSync(process.execPath, [fileURLToPath(modulePath), "observe", "--root", root, "--text"], {
    encoding: "utf8",
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /remote_unavailable/);
});
