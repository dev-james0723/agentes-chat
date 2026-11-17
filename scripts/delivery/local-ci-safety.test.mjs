import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const source = readFileSync(new URL("../ci-local.sh", import.meta.url), "utf8");
function runFixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), "local-ci-safety-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "packages/db/migrations"), { recursive: true });
  writeFileSync(join(root, "scripts/ci-local.sh"), source);
  const command = (name, body) => {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/bash\n${body}\n`);
    chmodSync(path, 0o755);
  };
  command(
    "bun",
    `if [ "$1" = run ] && [ "$2" = db:generate ]; then
    if [ "$DRIFT" = yes ]; then printf 'generated fixture' > packages/db/migrations/generated.sql; fi
    exit "$GENERATE_EXIT"
  fi
  exit 0`,
  );
  command(
    "git",
    `case "$1" in
    rev-parse) echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ;;
    status) if [ "$STATUS_EXIT" != 0 ]; then exit "$STATUS_EXIT"; fi
      if [ -f packages/db/migrations/generated.sql ]; then echo '?? packages/db/migrations/generated.sql'; fi ;;
    checkout|clean|reset) printf '%s\\n' "$1" >> "$FORBIDDEN_CALLS"; exit 9 ;;
    *) exit 0 ;;
  esac`,
  );
  for (const name of ["node", "shellcheck", "gitleaks"]) command(name, "exit 0");
  const forbidden = join(root, "forbidden-calls");
  const result = spawnSync("/bin/bash", ["scripts/ci-local.sh"], {
    cwd: root,
    encoding: "utf8",
    timeout: 10000,
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: root,
      TMPDIR: root,
      DRIFT: "no",
      GENERATE_EXIT: "0",
      STATUS_EXIT: "0",
      FORBIDDEN_CALLS: forbidden,
      ...options,
    },
  });
  const observations = {
    status: result.status,
    output: result.stdout + result.stderr,
    generatedFilePreserved: existsSync(join(root, "packages/db/migrations/generated.sql")),
    forbiddenCalls: existsSync(forbidden) ? readFileSync(forbidden, "utf8") : "",
    error: result.error?.message ?? null,
  };
  // Remove only this test's freshly created synthetic fixture, never a worktree.
  rmSync(root, { recursive: true, force: true });
  return observations;
}

test("local CI accepts an unchanged schema after a successful generator", () => {
  const result = runFixture();
  assert.equal(result.error, null);
  assert.equal(result.status, 0, result.output);
});
test("local CI rejects generator failure even when Git reports no drift", () => {
  const result = runFixture({ GENERATE_EXIT: "42" });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /FAIL.*migrations up to date/);
});
test("local CI rejects unreadable migration status rather than treating it as clean", () => {
  const result = runFixture({ STATUS_EXIT: "7" });
  assert.equal(result.status, 1, result.output);
});
test("local CI preserves generated migration evidence and never resets or cleans it", () => {
  const result = runFixture({ DRIFT: "yes" });
  assert.equal(result.status, 1, result.output);
  assert.equal(result.generatedFilePreserved, true);
  assert.equal(result.forbiddenCalls, "");
});
