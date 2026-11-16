#!/usr/bin/env node
// Read-only delivery observation. This utility never commits, pushes, merges or deploys.
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkCheckpoint, checkRelease, safePath } from "./policy.mjs";

function runGit(root, args) {
  const r = spawnSync("git", ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-C", root, ...args], {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" },
  });
  if (r.error || r.status !== 0) throw new Error("Git observation failed");
  return r.stdout;
}
const records = (text) => {
  if (text === "") return [];
  if (!text.endsWith("\0")) throw new Error("Truncated Git record");
  return text.slice(0, -1).split("\0");
};
export function parseStatus(text) {
  const parts = records(text),
    rows = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4 || entry[2] !== " " || !/^[ MADRCU?!]{2}$/.test(entry.slice(0, 2)))
      throw new Error("Invalid Git status record");
    const row = { index: entry[0], worktree: entry[1], path: entry.slice(3) };
    if (/[RC]/.test(entry.slice(0, 2))) {
      if (!parts[i + 1]) throw new Error("Truncated Git rename status");
      row.originalPath = parts[++i];
    }
    row.conflict = entry.slice(0, 2).includes("U") || ["AA", "DD"].includes(entry.slice(0, 2));
    rows.push(row);
  }
  return rows;
}
function pathInfo(root, relative) {
  if (!safePath(relative)) return { pathSafe: false, symlink: false };
  let current = root;
  for (const part of relative.split("/")) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) return { pathSafe: false, symlink: true };
    } catch (error) {
      if (error.code === "ENOENT") return { pathSafe: true, symlink: false };
      throw error;
    }
  }
  return { pathSafe: true, symlink: false };
}
function repoFromUrl(url) {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url);
  return match ? `${match[1]}/${match[2]}` : null;
}
export function observe(inputRoot, { remote = "origin", network = false } = {}) {
  if (typeof remote !== "string" || !/^[A-Za-z0-9_.-]+$/.test(remote) || remote.startsWith("-"))
    throw new Error("Invalid remote name");
  const root = realpathSync(inputRoot);
  if (realpathSync(runGit(root, ["rev-parse", "--show-toplevel"]).trim()) !== root)
    throw new Error("Select the exact repository root");
  const startHead = runGit(root, ["rev-parse", "HEAD"]).trim();
  const before = runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const errors = [];
  let repository = null;
  try {
    const fetchUrls = runGit(root, ["remote", "get-url", "--all", remote]).trim().split("\n");
    const pushUrls = runGit(root, ["remote", "get-url", "--push", "--all", remote]).trim().split("\n");
    if (fetchUrls.length !== 1 || pushUrls.length !== 1) errors.push("ambiguous_remote");
    repository = repoFromUrl(fetchUrls[0]);
    if (!repository) errors.push("unsupported_remote");
    if (repoFromUrl(pushUrls[0]) !== repository) errors.push("push_remote_mismatch");
  } catch {
    errors.push("remote_unavailable");
  }
  const changes = parseStatus(before).map((row) => ({ ...row, ...pathInfo(root, row.path) }));
  const staged = records(
    runGit(root, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z"]),
  );
  const trackedCount = records(runGit(root, ["ls-files", "-z"])).length;
  const branch = runGit(root, ["branch", "--show-current"]).trim();
  const deletedPaths = [...new Set(changes.filter((c) => c.index === "D" || c.worktree === "D").map((c) => c.path))];
  const remoteState = { name: remote, status: "not_requested", head: null };
  if (network) {
    if (errors.length || !branch) remoteState.status = "blocked";
    else {
      try {
        const lines = runGit(root, ["ls-remote", "--heads", remote, `refs/heads/${branch}`]).trim();
        if (!lines) remoteState.status = "branch_absent";
        else {
          const match = /^([a-f0-9]{40,64})\t([^\r\n]+)$/.exec(lines);
          if (!match || match[2] !== `refs/heads/${branch}`) throw new Error("Invalid remote result");
          remoteState.head = match[1];
          remoteState.status = match[1] === startHead ? "matches" : "differs";
        }
      } catch {
        remoteState.status = "unknown";
        errors.push("remote_observation_failed");
      }
    }
  }
  const endHead = runGit(root, ["rev-parse", "HEAD"]).trim();
  const after = runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  return {
    schema: "delivery-observation/v1",
    repository,
    worktree: root,
    branch,
    head: startHead,
    observedAt: new Date().toISOString(),
    stable: startHead === endHead && before === after,
    errors,
    trackedCount,
    changes,
    staged,
    deletedPaths,
    remote: remoteState,
    deployment: { status: "unknown", reason: "Server image, runner and user-path evidence must be checked separately" },
  };
}
export function founderSummary(o) {
  const lines = [
    `檢查時間：${o.observedAt}`,
    `程式碼：${o.repository ?? "未核實"} · ${o.branch || "未選分支"} · ${o.head.slice(0, 9)}`,
    `未提交改動：${o.changes.length}；已暫存：${o.staged.length}`,
  ];
  lines.push(
    o.remote.status === "matches"
      ? "GitHub 分支：已核對與本機 commit 相同"
      : `GitHub 分支：未核實與本機相同（${o.remote.status}）`,
  );
  lines.push("正式版及執行器：未核實；commit 或 push 不代表部署完成。");
  if (o.errors.length) lines.push(`需要處理：${o.errors.join("、")}`);
  if (!o.stable) lines.push("檢查期間程式碼有變，請重新核對。");
  return lines.join("\n");
}
function argsOf(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (["--network", "--text"].includes(flag)) {
      if (args[flag]) throw new Error("Duplicate flag");
      args[flag] = true;
    } else if (["--root", "--remote", "--scope", "--evidence"].includes(flag)) {
      if (args[flag] || !argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error("Missing or duplicate argument");
      args[flag] = argv[++i];
    } else throw new Error("Unknown argument");
  }
  return args;
}
export function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (!["observe", "check-checkpoint", "check-release"].includes(command))
    throw new Error("Usage: guardian.mjs observe|check-checkpoint|check-release (read-only; never commits or deploys)");
  const a = argsOf(rest);
  let value;
  let observationFailed = false;
  if (command === "check-release") {
    if (!a["--evidence"] || a["--root"] || a["--scope"] || a["--network"] || a["--text"])
      throw new Error("check-release requires --evidence only");
    value = checkRelease(JSON.parse(readFileSync(a["--evidence"], "utf8")));
  } else {
    if (!a["--root"] || a["--evidence"]) throw new Error("Select --root");
    const o = observe(a["--root"], { remote: a["--remote"] ?? "origin", network: a["--network"] ?? false });
    observationFailed = o.errors.length > 0 || o.stable !== true;
    if (command === "check-checkpoint") {
      if (!a["--scope"] || a["--text"]) throw new Error("check-checkpoint requires --scope");
      value = { observation: o, ...checkCheckpoint(o, JSON.parse(readFileSync(a["--scope"], "utf8"))) };
    } else {
      if (a["--scope"]) throw new Error("observe does not take scope");
      value = a["--text"] ? founderSummary(o) : o;
    }
  }
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
  if (observationFailed || value?.ok === false || value?.errors?.length || value?.stable === false) return 1;
  return 0;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Delivery observation failed");
    process.exitCode = 2;
  }
}
