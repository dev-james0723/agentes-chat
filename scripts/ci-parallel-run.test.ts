import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const launcher = join(import.meta.dir, "ci-parallel-run.sh");
const scriptDir = import.meta.dir;
const scratch: string[] = [];
afterEach(() => {
  for (const p of scratch.splice(0)) rmSync(p, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  expect(r.status).toBe(0);
}

function fixture(localScript?: string) {
  const dir = mkdtempSync(join(tmpdir(), "ci-launcher-safe-"));
  scratch.push(dir);
  const repo = join(dir, "worktree");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  copyFileSync(join(scriptDir, "ci-lock.sh"), join(repo, "scripts", "ci-lock.sh"));
  writeFileSync(
    join(repo, "scripts", "ci-local.sh"),
    localScript ?? readFileSync(join(scriptDir, "ci-local.sh"), "utf8"),
  );
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({
      name: "local-ci-guard-fixture",
      private: true,
      scripts: { "ci:local": "bash scripts/ci-local.sh" },
    }),
  );
  git(repo, "init", "-q");
  git(repo, "add", ".");
  git(repo, "-c", "user.name=CI Test", "-c", "user.email=ci-test@local.invalid", "commit", "-qm", "initial fixture");
  return { dir, repo };
}

function run(args: string[], repo: string, extraEnv: Record<string, string> = {}) {
  return spawnSync("bash", args, {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      AGENTES_CI_STATE_DIR: join(repo, "..", "state"),
      AGENTES_CI_LOCK_WAIT: "0",
      AGENTES_CI_MAX_PARALLEL: "2",
      ...extraEnv,
    },
    timeout: 15000,
  });
}

test("launcher refuses a dirty worktree before touching any migration", () => {
  const { dir, repo } = fixture();
  const migration = join(repo, "packages", "db", "migrations", "uncommitted.sql");
  mkdirSync(join(repo, "packages", "db", "migrations"), { recursive: true });
  writeFileSync(migration, "KEEP THIS UNCOMMITTED SQL");
  const r = run([launcher, repo], repo);
  expect(r.status).toBe(2);
  expect(r.stderr).toContain("refusing dirty worktree");
  expect(readFileSync(migration, "utf8")).toBe("KEEP THIS UNCOMMITTED SQL");
  expect(existsSync(join(dir, "state", "ci.lock"))).toBe(false);
});

test("direct full CI refuses a dirty worktree before any migration cleanup", () => {
  const { repo } = fixture();
  const migration = join(repo, "packages", "db", "migrations", "agent-work.sql");
  mkdirSync(join(repo, "packages", "db", "migrations"), { recursive: true });
  writeFileSync(migration, "AGENT OWNED");
  const r = run(["scripts/ci-local.sh"], repo);
  expect(r.status).toBe(2);
  expect(r.stderr).toContain("worktree is not clean");
  expect(readFileSync(migration, "utf8")).toBe("AGENT OWNED");
});

test("launcher binds canonical worktree even with conflicting caller lock and scope", () => {
  const mini =
    "#!/usr/bin/env bash\n. scripts/ci-lock.sh\nci_lock synthetic || exit $?\nprintf 'scope=%s\\n' \"$CI_SCOPE_DIR\"\n";
  const { dir, repo } = fixture(mini);
  const r = run([launcher, repo], repo, {
    AGENTES_CI_SCOPE: join(dir, "spoofed-scope"),
    AGENTES_CI_LOCK: join(dir, "spoofed.lock"),
  });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain(`scope=${realpathSync(repo)}`);
  expect(existsSync(join(dir, "spoofed.lock"))).toBe(false);
  expect(existsSync(join(dir, "state", "ci-slots", "slot-1.lock"))).toBe(false);
});

test("migration drift fails without deleting generated files", () => {
  const { repo } = fixture();
  const source = readFileSync(join(scriptDir, "ci-local.sh"), "utf8");
  const block = source.match(/check_migration_drift\(\) \{[\s\S]*?\n\}/);
  if (!block) throw new Error("the migration drift guard was removed");
  const command = [
    block[0],
    "bun() { mkdir -p packages/db/migrations; printf 'PRESERVE GENERATED DATA' > packages/db/migrations/generated.sql; }",
    "check_migration_drift",
  ].join("\n");
  const r = spawnSync("bash", ["-c", command], { cwd: repo, encoding: "utf8" });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("migration drift detected");
  expect(readFileSync(join(repo, "packages", "db", "migrations", "generated.sql"), "utf8")).toBe(
    "PRESERVE GENERATED DATA",
  );
});
