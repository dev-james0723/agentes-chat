#!/usr/bin/env node
// Local CI is a verifier, not a merger, publisher or authentication service.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readdirSync, realpathSync, statfsSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { observe } from "./guardian.mjs";

const SHA = /^[a-f0-9]{40}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_BLOCK = /^(main|master|prod|production|release(?:\/.*)?)$/i;
export const STEPS = Object.freeze({
  guardian: Object.freeze({ argv: ["node", "--test", "scripts/delivery/*.test.mjs"], timeoutMs: 180000, shell: false }),
  boundaries: Object.freeze({ argv: ["bun", "run", "check:boundaries"], timeoutMs: 180000, shell: false }),
  lint: Object.freeze({ argv: ["bun", "run", "lint"], timeoutMs: 180000, shell: false }),
  typecheck: Object.freeze({ argv: ["bun", "run", "typecheck"], timeoutMs: 360000, shell: false }),
  build: Object.freeze({ argv: ["bun", "run", "build"], timeoutMs: 600000, shell: false }),
  regression: Object.freeze({ argv: ["bun", "test"], timeoutMs: 1800000, shell: false }),
  "secret-scan": Object.freeze({
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
    timeoutMs: 180000,
    shell: false,
  }),
});
const REQUIRED = Object.freeze(Object.keys(STEPS));
const isObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
function unique(items) {
  return [...new Set(items)];
}
function freshTime(value, now) {
  const timestamp = Date.parse(value);
  if (typeof value !== "string" || !Number.isFinite(timestamp) || timestamp > now + 30000) return "invalid";
  return now - timestamp <= 600000 ? "fresh" : "stale";
}
export function validateRequest(observation, { now = Date.now(), expectedRepository, expectedHead } = {}) {
  const o = isObject(observation) ? observation : {},
    b = [];
  const requiredRepo = expectedRepository ?? o.repository;
  if (!REPO.test(o.repository ?? "") || !REPO.test(requiredRepo ?? "") || o.repository !== requiredRepo)
    b.push("repository_mismatch");
  if (typeof o.branch !== "string" || !o.branch || BRANCH_BLOCK.test(o.branch)) b.push("protected_branch");
  if (!SHA.test(o.head ?? "") || (expectedHead && o.head !== expectedHead)) b.push("head_mismatch");
  const freshness = freshTime(o.observedAt, now);
  if (freshness !== "fresh") b.push(freshness === "stale" ? "stale_evidence" : "invalid_observation_time");
  if (o.clean !== true) b.push("dirty_workspace");
  if (o.writerConfirmed !== true) b.push("writer_unverified");
  if (o.sourceVerified !== true) b.push("source_unverified");
  if (!Number.isSafeInteger(o.freeBytes) || o.freeBytes < 0) b.push("unknown_disk");
  else if (o.freeBytes < (o.mode === "full" ? 30 : 1) * 1024 ** 3) b.push("insufficient_disk");
  if (!["smoke", "full"].includes(o.mode)) b.push("invalid_mode");
  if (!Array.isArray(o.steps) || o.steps.length === 0) b.push("no_steps");
  else if (o.steps.some((x) => typeof x !== "string" || !Object.hasOwn(STEPS, x))) b.push("unknown_step");
  else if (new Set(o.steps).size !== o.steps.length) b.push("duplicate_step");
  if (o.mode === "full" && REQUIRED.some((x) => !o.steps?.includes(x))) b.push("incomplete_release_suite");
  return {
    ok: b.length === 0,
    blockers: unique(b),
    stage: b.length ? "blocked" : "test_eligible",
    releaseReady: false,
  };
}
export function checkPromotion(receipt) {
  const r = isObject(receipt) ? receipt : {},
    b = [];
  if (!SHA.test(r.head ?? "") || r.head !== r.expectedHead) b.push("head_mismatch");
  if (r.mode !== "full" || !Array.isArray(r.steps) || REQUIRED.some((x) => !r.steps.some((y) => y.id === x)))
    b.push("incomplete_release_suite");
  if (Array.isArray(r.steps) && r.steps.some((s) => s.exitCode !== 0 || s.timedOut)) b.push("failed_checks");
  if (r.source !== "trusted") b.push("untrusted_source");
  if (r.reviewed !== true) b.push("review_unverified");
  // A JSON boolean (including source:'trusted') is not cryptographic attestator identity.
  b.push("trusted_attestor_unavailable");
  return { ok: false, blockers: unique(b), stage: "blocked" };
}
export function sanitizeEnvironment(env = process.env) {
  const allowed = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ", "NO_COLOR", "BUN_INSTALL", "USER", "LOGNAME"];
  const safe = { CI: "true", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
  for (const key of allowed) {
    if (typeof env[key] === "string") safe[key] = env[key];
  }
  return safe;
}
async function actualRun(step, stepId, { root, env }) {
  let argv = step.argv;
  if (stepId === "guardian") {
    const items = readdirSync(join(root, "scripts/delivery"))
      .filter((n) => n.endsWith(".test.mjs"))
      .sort()
      .map((n) => `scripts/delivery/${n}`);
    if (!items.length) return { exitCode: 2, stdout: "", stderr: "Missing local tests", timedOut: false };
    argv = ["node", "--test", ...items];
  }
  return new Promise((done) => {
    let finished = false,
      timedOut = false,
      killed = false,
      bytes = 0,
      output = [],
      truncated = false;
    const child = spawn(argv[0], argv.slice(1), {
      cwd: root,
      env,
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const take = (data) => {
      bytes += data.length;
      if (bytes <= 2 * 1024 * 1024) output.push(data);
      else truncated = true;
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGTERM");
        killed = true;
      } catch {}
    }, step.timeoutMs);
    const complete = (code, error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      done({
        exitCode: error ? 2 : typeof code === "number" ? code : null,
        stdout: Buffer.concat(output).toString("utf8"),
        stderr: error ? String(error.message) : "",
        timedOut,
        truncated,
        killed,
      });
    };
    child.on("error", (error) => complete(null, error));
    child.on("close", (code) => complete(code));
  });
}
export async function runPlan({
  root,
  head,
  plan,
  destination,
  execute = actualRun,
  clock = () => new Date(),
  env = sanitizeEnvironment(),
}) {
  if (!SHA.test(head ?? "")) throw Error("invalid_source_sha");
  if (!Array.isArray(plan) || !plan.length || plan.some((id) => typeof id !== "string" || !Object.hasOwn(STEPS, id)))
    throw Error("unapproved_step");
  if (!destination) throw Error("destination_required");
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const attemptId = `local-ci-${randomUUID()}`,
    start = clock().toISOString(),
    results = [];
  for (const id of plan) {
    const step = STEPS[id],
      at = clock().toISOString();
    let output;
    try {
      output = await execute(step, id, { root, env });
    } catch (error) {
      output = { exitCode: 2, stdout: "", stderr: String(error.message), timedOut: false };
    }
    const raw = String(output.stdout ?? "") + String(output.stderr ?? "");
    const path = join(destination, `${attemptId}-${id}.log`);
    const fd = openSync(path, "wx", 0o600);
    try {
      writeSync(fd, raw.slice(0, 2 * 1024 * 1024));
    } finally {
      closeSync(fd);
    }
    const state = output.timedOut ? "timeout" : output.exitCode === 0 && !output.truncated ? "passed" : "failed";
    results.push({
      id,
      startedAt: at,
      finishedAt: clock().toISOString(),
      exitCode: output.exitCode ?? null,
      state,
      timedOut: output.timedOut === true,
      logSha256: createHash("sha256")
        .update(raw.slice(0, 2 * 1024 * 1024))
        .digest("hex"),
      truncated: !!output.truncated,
      logFile: path,
    });
  }
  const outcome = results.some((x) => x.state === "timeout")
    ? "blocked"
    : results.some((x) => x.state !== "passed")
      ? "failed"
      : "tested_partial";
  const receipt = {
    schema: "local-ci-attempt/v1",
    attemptId,
    head,
    mode: "smoke",
    startedAt: start,
    finishedAt: clock().toISOString(),
    steps: results,
    outcome,
    releaseReady: false,
    publisher: "none",
    review: "not_verified",
  };
  const f = join(destination, `${attemptId}.json`);
  const fd = openSync(f, "wx", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(receipt, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
  return receipt;
}
function options(args) {
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    if (
      !["--root", "--sha", "--remote", "--repository", "--destination", "--mode"].includes(args[i]) ||
      !args[i + 1] ||
      args[i + 1].startsWith("--") ||
      parsed[args[i]]
    )
      throw Error("invalid_cli_arguments");
    parsed[args[i]] = args[++i];
  }
  return parsed;
}
export async function main(args = process.argv.slice(2)) {
  const a = options(args),
    root = resolve(a["--root"] ?? ""),
    head = a["--sha"],
    mode = a["--mode"] ?? "smoke";
  if (!a["--root"] || !SHA.test(head ?? "") || !a["--repository"] || !a["--destination"] || mode !== "smoke")
    throw Error("smoke_cli_requires_exact_repository_sha_and_private_destination");
  const remote = a["--remote"] ?? "gh";
  const obs = observe(root, { remote, network: true });
  const pre = validateRequest(
    {
      repository: obs.repository,
      branch: obs.branch,
      head: obs.head,
      observedAt: obs.observedAt,
      clean: obs.changes.length === 0 && obs.staged.length === 0,
      sourceVerified: obs.stable && obs.errors.length === 0 && obs.remote.status === "matches",
      writerConfirmed: obs.stable,
      freeBytes: statfsSync(root).bavail * statfsSync(root).bsize,
      mode,
      steps: ["guardian"],
    },
    { expectedRepository: a["--repository"], expectedHead: head },
  );
  if (!pre.ok) {
    console.log(JSON.stringify({ outcome: "blocked", preflight: pre }));
    return 1;
  }
  const receipt = await runPlan({
    root,
    head,
    plan: ["guardian"],
    destination: a["--destination"],
    env: sanitizeEnvironment({ ...process.env, HOME: resolve(a["--destination"]) }),
  });
  console.log(JSON.stringify({ outcome: receipt.outcome, head, attemptId: receipt.attemptId, releaseReady: false }));
  return receipt.outcome === "tested_partial" ? 0 : 1;
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error("Local CI blocked:", error.message);
      process.exitCode = 2;
    });
}
