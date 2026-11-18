#!/usr/bin/env node
// Full local CI for one exact commit: every step of scripts/ci-local.sh plus a real container boot, each with its own
// log and hash, written as an unsigned `local-ci-release/v1` receipt. It never signs, never posts a status and never
// merges: `local-ci-status.mjs` verifies a signed receipt and an independent review before anything is published.
//
//   node scripts/delivery/local-ci-full.mjs run --root <clean worktree> --sha <40-hex> --repository owner/name \
//        --remote gh --branch <branch> --out <private evidence dir> [--docker-host unix:///…/docker.sock]
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REQUIRED_RELEASE_STEPS } from "./local-ci-status.mjs";

const SHA = /^[a-f0-9]{40}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MIN_FREE_BYTES = 30 * 1024 ** 3;

// Same commands, same order as scripts/ci-local.sh. `bash -c` only where ci-local.sh itself uses shell syntax.
const sh = (script) => ["bash", "-c", script];
export const FULL_STEPS = Object.freeze({
  "frozen-deps": { argv: ["bun", "install", "--frozen-lockfile"], timeoutMs: 600_000 },
  lint: { argv: ["bun", "run", "lint"], timeoutMs: 300_000 },
  shellcheck: { argv: sh("shellcheck install.sh deploy/*.sh deploy/backup/*.sh scripts/*.sh"), timeoutMs: 120_000 },
  guardian: { argv: sh("node --test scripts/delivery/*.test.mjs"), timeoutMs: 300_000 },
  "boundaries-unit": { argv: ["bun", "test", "scripts/check-boundaries.test.ts"], timeoutMs: 180_000 },
  "geometry-unit": { argv: ["bun", "test", "scripts/geometry/check.test.ts"], timeoutMs: 180_000 },
  licenses: { argv: sh("bun test scripts/check-licenses.test.ts && bun run check:licenses"), timeoutMs: 300_000 },
  typecheck: { argv: ["bun", "run", "typecheck"], timeoutMs: 900_000 },
  build: { argv: ["bun", "run", "build"], timeoutMs: 900_000 },
  "migration-drift": {
    argv: sh(
      'bun run db:generate ci-drift-check < /dev/null || exit 1; s=$(git status --porcelain -- packages/db/migrations); echo "$s"; if [ -n "$s" ]; then git checkout -- packages/db/migrations; git clean -fdq -- packages/db/migrations; exit 1; fi',
    ),
    timeoutMs: 300_000,
  },
  "migration-compat": {
    argv: sh("bun test scripts/check-migrations.test.ts && bun run check:migrations"),
    timeoutMs: 600_000,
  },
  "deployment-scripts": { argv: ["bun", "test", "./deploy/deploy.test.ts"], timeoutMs: 300_000 },
  "engine-a-m": { argv: sh("bun test packages/engine/test/[a-m]*.test.ts"), timeoutMs: 2_400_000 },
  "engine-n-z-and-packages": {
    argv: sh(
      "bun test packages/engine/test/[!a-m]*.test.ts packages/adapters packages/config packages/db packages/modules packages/providers packages/client packages/i18n packages/tokens packages/setup",
    ),
    timeoutMs: 2_400_000,
  },
  server: { argv: ["bun", "test", "apps/server"], timeoutMs: 2_400_000 },
  "web-ui": {
    argv: sh('GEOMETRY_OUT="$CI_GEOMETRY_DIR" bun test --preload ./scripts/geometry/capture.ts apps/web packages/ui'),
    timeoutMs: 1_800_000,
  },
  geometry: { argv: sh('bun run check:geometry "$CI_GEOMETRY_DIR" --text-size xs,xl'), timeoutMs: 600_000 },
  "event-dialog": {
    argv: sh("RUN_NEW_EVENT=1 bun test --timeout 20000 apps/web/test/new-event.test.tsx"),
    timeoutMs: 300_000,
  },
  "mobile-desktop": { argv: sh("bun test apps/mobile/test apps/desktop/test"), timeoutMs: 900_000 },
  "secret-scan": {
    argv: [
      "gitleaks",
      "git",
      "--config",
      ".gitleaks.toml",
      "--log-opts=HEAD",
      "--no-banner",
      "--redact",
      "--exit-code",
      "1",
      ".",
    ],
    timeoutMs: 300_000,
  },
  boundaries: { argv: ["bun", "run", "check:boundaries"], timeoutMs: 180_000 },
  "container-boot": {
    argv: ["bash", fileURLToPath(new URL("./container-boot.sh", import.meta.url))],
    timeoutMs: 2_400_000,
  },
});

export function assertStepTable() {
  const ids = Object.keys(FULL_STEPS);
  if (ids.length !== REQUIRED_RELEASE_STEPS.length || REQUIRED_RELEASE_STEPS.some((id, i) => ids[i] !== id))
    throw Error("step_table_differs_from_required_release_steps");
}

function git(root, ...args) {
  return new Promise((done) => {
    const p = spawn("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => {
      out += d;
    });
    p.on("close", (code) => done({ code, out: out.trim() }));
  });
}

/** The candidate is exactly `sha`, clean, and the same commit the remote branch names now. */
export async function verifySource({ root, sha, remote, branch, fresh = false }) {
  const blockers = [];
  const head = await git(root, "rev-parse", "HEAD");
  if (head.code !== 0 || head.out !== sha) blockers.push("head_mismatch");
  const status = await git(root, "status", "--porcelain", "--untracked-files=normal");
  if (status.code !== 0 || status.out !== "") blockers.push("dirty_workspace");
  // Before the run the candidate must be a fresh checkout: ignored leftovers (an old build, dist) could be what the
  // tests or the image build actually use.
  if (fresh) {
    const ignored = await git(root, "status", "--porcelain", "--ignored", "--untracked-files=all");
    if (ignored.code !== 0 || ignored.out !== "") blockers.push("not_fresh_checkout");
  }
  const ls = await git(root, "ls-remote", remote, `refs/heads/${branch}`);
  if (ls.code !== 0 || ls.out.split(/\s+/)[0] !== sha) blockers.push("remote_branch_not_at_sha");
  return { ok: blockers.length === 0, blockers };
}

function runStep(id, step, { root, out, env }) {
  const logPath = join(out, `${id}.log`);
  const fd = openSync(logPath, "w");
  const started = Date.now();
  return new Promise((done) => {
    const [cmd, ...args] = step.argv;
    const p = spawn(cmd, args, { cwd: root, env, stdio: ["ignore", fd, fd], detached: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-p.pid, "SIGTERM");
      } catch {}
      setTimeout(() => {
        try {
          process.kill(-p.pid, "SIGKILL");
        } catch {}
      }, 120_000).unref();
    }, step.timeoutMs);
    const finish = (exitCode) => {
      clearTimeout(timer);
      closeSync(fd);
      const logSha256 = createHash("sha256").update(readFileSync(logPath)).digest("hex");
      done({
        id,
        exitCode,
        timedOut,
        state: exitCode === 0 && !timedOut ? "passed" : "failed",
        elapsedSeconds: Math.round((Date.now() - started) / 100) / 10,
        logSha256,
        log: `${id}.log`,
      });
    };
    p.on("error", () => finish(127));
    p.on("close", (code) => finish(code ?? 1));
  });
}

// `minFreeBytes` lowers the disk floor for a partial run only (`only`), so a test can run one step on a small
// temporary disk; a full run, the only kind a status can come from, always needs MIN_FREE_BYTES.
export async function runFull({ root, sha, repository, remote, branch, out, dockerHost, only, minFreeBytes }) {
  assertStepTable();
  if (!SHA.test(sha ?? "")) throw Error("invalid_sha");
  if (!REPO.test(repository ?? "")) throw Error("invalid_repository");
  const absRoot = resolve(root);
  mkdirSync(out, { recursive: true });
  const free = statfsSync(absRoot);
  const freeBytes = free.bavail * free.bsize;
  const startedAt = new Date().toISOString();
  const source = await verifySource({ root: absRoot, sha, remote, branch, fresh: true });
  const receipt = {
    schema: "local-ci-release/v1",
    mode: only ? "partial" : "full",
    repo: repository,
    head: sha,
    branch,
    host: process.env.HOSTNAME ?? null,
    startedAt,
    finishedAt: null,
    freeBytesAtStart: freeBytes,
    sourceVerified: source.ok,
    sourceBlockers: source.blockers,
    steps: [],
    review: null,
  };
  const floor = only && Number.isSafeInteger(minFreeBytes) && minFreeBytes >= 0 ? minFreeBytes : MIN_FREE_BYTES;
  if (!source.ok || freeBytes < floor) {
    receipt.finishedAt = new Date().toISOString();
    receipt.blocked = !source.ok ? "source_unverified" : "insufficient_disk";
    writeFileSync(join(out, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
    return receipt;
  }
  const geometry = mkdtempSync(join(tmpdir(), "agentes-ci-geometry-"));
  const env = {
    ...process.env,
    CI: "true",
    CI_GEOMETRY_DIR: geometry,
    CI_CANDIDATE_SHA: sha,
    ...(dockerHost ? { DOCKER_HOST: dockerHost } : {}),
  };
  try {
    for (const [id, step] of Object.entries(FULL_STEPS)) {
      if (only && !only.includes(id)) continue;
      const result = await runStep(id, step, { root: absRoot, out, env });
      receipt.steps.push(result);
      writeFileSync(join(out, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
    }
  } finally {
    rmSync(geometry, { recursive: true, force: true });
  }
  // A step that changed tracked files (other than what the drift check restores) means the run did not test `sha`.
  const after = await verifySource({ root: absRoot, sha, remote, branch });
  receipt.sourceVerified = receipt.sourceVerified && after.ok;
  receipt.sourceBlockersAfter = after.blockers;
  receipt.finishedAt = new Date().toISOString();
  writeFileSync(join(out, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]?.replace(/^--/, "");
    if (!k || argv[i + 1] === undefined) throw Error("expected --name value pairs");
    o[k] = argv[i + 1];
  }
  return o;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd !== "run") {
    console.error(
      "usage: local-ci-full.mjs run --root … --sha … --repository … --remote … --branch … --out … [--only a,b]",
    );
    process.exit(64);
  }
  const o = args(rest);
  const receipt = await runFull({ ...o, only: o.only?.split(",") });
  const failed = receipt.steps.filter((s) => s.state !== "passed").map((s) => s.id);
  console.log(
    JSON.stringify({ sourceVerified: receipt.sourceVerified, blocked: receipt.blocked ?? null, failed }, null, 2),
  );
  process.exit(receipt.sourceVerified && !receipt.blocked && failed.length === 0 ? 0 : 1);
}
