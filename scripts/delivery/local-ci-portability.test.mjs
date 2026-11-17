import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

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
