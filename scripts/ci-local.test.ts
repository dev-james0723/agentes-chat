import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(options: { generateExit?: number; statusExit?: number; migrationStatus?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "agentes-local-ci-test-"));
  roots.push(root);
  const bin = join(root, "bin");
  const temporary = join(root, "tmp");
  mkdirSync(bin);
  mkdirSync(temporary);
  mkdirSync(join(root, "scripts"));
  copyFileSync(resolve(import.meta.dir, "ci-local.sh"), join(root, "scripts/ci-local.sh"));
  const stub = (name: string, source: string) => {
    writeFileSync(join(bin, name), source);
    chmodSync(join(bin, name), 0o755);
  };
  stub(
    "bun",
    `#!/bin/sh
case "$*" in
  "run db:generate ci-drift-check") exit "\${GENERATOR_EXIT:-0}" ;;
  *) exit 0 ;;
esac
`,
  );
  stub(
    "git",
    `#!/bin/sh
printf '%s\\n' "$*" >> "$TRACE_FILE"
case "$*" in
  "rev-parse --short HEAD") printf 'a1b2c3d\\n' ;;
  "status --porcelain -- packages/db/migrations")
    printf '%s' "$MIGRATION_STATUS"
    exit "\${STATUS_EXIT:-0}"
    ;;
  *) exit 0 ;;
esac
`,
  );
  for (const name of ["shellcheck", "gitleaks"]) stub(name, "#!/bin/sh\nexit 0\n");
  const run = Bun.spawnSync(["/bin/bash", join(root, "scripts/ci-local.sh")], {
    cwd: root,
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: root,
      TMPDIR: temporary,
      GENERATOR_EXIT: String(options.generateExit ?? 0),
      STATUS_EXIT: String(options.statusExit ?? 0),
      MIGRATION_STATUS: options.migrationStatus ?? "",
      TRACE_FILE: join(root, "git-calls"),
    },
    timeout: 15_000,
  });
  return {
    exitCode: run.exitCode,
    output: `${run.stdout}${run.stderr}`,
    gitCalls: readFileSync(join(root, "git-calls"), "utf8").split("\n").filter(Boolean),
  };
}

describe("local CI migration evidence", () => {
  test("a failing generator is failed even when it leaves no migration changes", () => {
    const run = fixture({ generateExit: 42 });
    expect(run.exitCode).toBe(1);
    expect(run.output).toContain("FAIL  migrations up to date with the schema");
    expect(run.output).not.toContain("PASS  migrations up to date with the schema");
  });
  test("an unreadable migration status fails closed instead of claiming no drift", () => {
    const run = fixture({ statusExit: 128 });
    expect(run.exitCode).toBe(1);
    expect(run.output).toContain("FAIL  migrations up to date with the schema");
  });
  test("generated drift fails without resetting or deleting the files under investigation", () => {
    const run = fixture({ migrationStatus: "?? packages/db/migrations/9999_synthetic_drift.sql\n" });
    expect(run.exitCode).toBe(1);
    expect(run.output).toContain("FAIL  migrations up to date with the schema");
    expect(run.gitCalls.some((call) => /^(checkout|clean|reset|restore|stash)( |$)/.test(call))).toBe(false);
  });
  test("a successful generator and clean migration status retain the positive path", () => {
    const run = fixture();
    expect(run.exitCode).toBe(0);
    expect(run.output).toContain("PASS  migrations up to date with the schema");
    expect(run.gitCalls.some((call) => /^(checkout|clean|reset|restore|stash)( |$)/.test(call))).toBe(false);
  });
});
