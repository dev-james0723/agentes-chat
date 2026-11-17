import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { observe } from "./guardian.mjs";

const entry = fileURLToPath(new URL("./local-ci.mjs", import.meta.url));
test("CLI entrypoint executes when the script path is a symlinked macOS workspace", (t) => {
  const home = mkdtempSync(join(tmpdir(), "local-ci-symlink-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const alias = join(home, "entry.mjs");
  symlinkSync(entry, alias);
  const r = spawnSync(process.execPath, [alias], { encoding: "utf8", timeout: 15000 });
  assert.equal(r.status, 2, "CLI silently skipped its main on a symlink");
  assert.match(r.stderr, /Local CI blocked/);
});
test("direct CLI with no args fails rather than reporting success", () => {
  const r = spawnSync(process.execPath, [entry], { encoding: "utf8", timeout: 15000 });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Local CI blocked/);
});

test("Guardian accepts an alias of the same repository root but rejects nested directories", (t) => {
  const temp = mkdtempSync(join(tmpdir(), "guardian-root-alias-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const root = join(temp, "repository");
  mkdirSync(root);
  const run = (...args) => {
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  run("init", "-b", "feat/local-ci");
  run("config", "user.name", "Local CI Test");
  run("config", "user.email", "ci@example.invalid");
  writeFileSync(join(root, "sample.txt"), "sample");
  run("add", "--", "sample.txt");
  run("commit", "-m", "fixture");
  run("remote", "add", "origin", "https://github.com/example/app.git");
  const alias = join(temp, "alias");
  symlinkSync(root, alias, "dir");
  const observed = observe(alias, { remote: "origin" });
  assert.equal(observed.repository, "example/app");
  assert.equal(observed.stable, true);
  mkdirSync(join(root, "nested"));
  assert.throws(() => observe(join(alias, "nested"), { remote: "origin" }), /repository root/);
});
