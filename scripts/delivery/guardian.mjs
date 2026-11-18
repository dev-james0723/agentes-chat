#!/usr/bin/env node
// Read-only delivery observation. This utility never commits, pushes, merges or deploys.
import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCrossProject } from "./cross-project-cli.mjs";
import { createGitReader } from "./git-read.mjs";
import { canonicalGitHubRemote } from "./identity.mjs";

function readJsonInput(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const info = fstatSync(fd),
      limit = 128 * 1024;
    if (!info.isFile() || info.size > limit) throw new Error();
    const buffer = Buffer.alloc(limit + 1);
    let bytes = 0;
    while (bytes <= limit) {
      const count = readSync(fd, buffer, bytes, buffer.length - bytes, bytes);
      if (!count) break;
      bytes += count;
    }
    if (bytes > limit) throw new Error();
    return JSON.parse(buffer.subarray(0, bytes).toString("utf8"));
  } catch {
    // Parser and OS errors can contain private input fragments or paths.
    throw new Error("Invalid JSON input: select a regular file of at most 128 KiB");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

import { checkCheckpoint, checkRelease, safePath } from "./policy.mjs";

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
  return canonicalGitHubRemote(url)?.repository ?? null;
}
// Built-in provider API only: Git credential helpers, transports and repository
// setup commands must not run as part of a read-only network observation.
export function collectProviderRef({ repository, branch }, { run = spawnSync } = {}) {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "") ||
    typeof branch !== "string" ||
    !branch ||
    branch.length > 1024
  )
    throw new Error("Invalid provider subject");
  const r = run(
    "gh",
    ["api", "--hostname", "github.com", `repos/${repository}/git/ref/heads/${encodeURIComponent(branch)}`],
    {
      cwd: tmpdir(),
      encoding: "utf8",
      shell: false,
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_PAGER: "cat", GH_FORCE_TTY: "0" },
    },
  );
  if (r.error || r.status !== 0) throw new Error("Provider ref unavailable");
  const value = JSON.parse(r.stdout);
  if (value?.object?.type !== "commit" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value?.object?.sha ?? ""))
    throw new Error("Invalid provider ref");
  return { source: "github_api", sha: value.object.sha, observedAt: new Date().toISOString() };
}
export function observe(
  inputRoot,
  { remote = "origin", network = false, providerRefLookup = collectProviderRef } = {},
) {
  if (typeof remote !== "string" || !/^[A-Za-z0-9_.-]+$/.test(remote) || remote.startsWith("-"))
    throw new Error("Invalid remote name");
  const root = realpathSync(inputRoot);
  const reader = createGitReader(root);
  // macOS APFS may expose the same directory as /Volumes/Data and /Volumes/Macintosh HD.
  // Compare filesystem identity, not differing display paths. Nested directories remain rejected.
  const top = reader.read(["rev-parse", "--show-toplevel"]).trim();
  const currentStat = statSync(root);
  const topStat = statSync(top);
  if (currentStat.dev !== topStat.dev || currentStat.ino !== topStat.ino)
    throw new Error("Select the exact repository root");
  const startHead = reader.read(["rev-parse", "HEAD"]).trim();
  const branch = reader.read(["branch", "--show-current"]).trim();
  const before = reader.read(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const errors = reader.filtersSuppressed ? ["content_filters_unverified"] : [];
  let repository = null;
  let beforeRemote = null;
  try {
    const fetchUrls = reader.read(["remote", "get-url", "--all", remote]).trim().split("\n");
    const pushUrls = reader.read(["remote", "get-url", "--push", "--all", remote]).trim().split("\n");
    beforeRemote = JSON.stringify([fetchUrls, pushUrls]);
    if (fetchUrls.length !== 1 || pushUrls.length !== 1) errors.push("ambiguous_remote");
    repository = repoFromUrl(fetchUrls[0]);
    if (!repository) errors.push("unsupported_remote");
    if (repoFromUrl(pushUrls[0]) !== repository) errors.push("push_remote_mismatch");
  } catch {
    errors.push("remote_unavailable");
  }
  const changes = parseStatus(before).map((row) => ({ ...row, ...pathInfo(root, row.path) }));
  const staged = records(
    reader.read(["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z"]),
  );
  const trackedCount = records(reader.read(["ls-files", "-z"])).length;
  const deletedPaths = [...new Set(changes.filter((c) => c.index === "D" || c.worktree === "D").map((c) => c.path))];
  const remoteState = { name: remote, status: "not_requested", head: null };
  if (network) {
    if (errors.length || !branch) remoteState.status = "blocked";
    else {
      try {
        const ref = providerRefLookup({ repository, branch });
        const time = Date.parse(ref?.observedAt),
          now = Date.now();
        if (
          ref?.source !== "github_api" ||
          !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(ref?.sha ?? "") ||
          !Number.isFinite(time) ||
          time > now ||
          now - time > 120_000
        )
          throw new Error("Invalid remote result");
        remoteState.head = ref.sha;
        remoteState.status = ref.sha === startHead ? "matches" : "differs";
        remoteState.observedAt = ref.observedAt;
        remoteState.source = ref.source;
      } catch {
        remoteState.status = "unknown";
        errors.push("remote_observation_failed");
      }
    }
  }
  const endHead = reader.read(["rev-parse", "HEAD"]).trim();
  const after = reader.read(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const endBranch = reader.read(["branch", "--show-current"]).trim();
  let afterRemote = null;
  try {
    afterRemote = JSON.stringify([
      reader.read(["remote", "get-url", "--all", remote]).trim().split("\n"),
      reader.read(["remote", "get-url", "--push", "--all", remote]).trim().split("\n"),
    ]);
  } catch {
    errors.push("remote_unavailable");
  }
  if (reader.filtersSuppressed && !errors.includes("content_filters_unverified"))
    errors.push("content_filters_unverified");
  if (reader.submodulesSuppressed) errors.push("submodule_content_unverified");
  return {
    schema: "delivery-observation/v1",
    repository,
    worktree: root,
    branch,
    head: startHead,
    observedAt: new Date().toISOString(),
    stable: startHead === endHead && before === after && branch === endBranch && beforeRemote === afterRemote,
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
    } else if (["--root", "--remote", "--scope", "--evidence", "--input"].includes(flag)) {
      if (args[flag] || !argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error("Missing or duplicate argument");
      args[flag] = argv[++i];
    } else throw new Error("Unknown argument");
  }
  return args;
}
export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const crossProject = ["identity", "inspect-macos", "inspect-agent-chats"].includes(command);
  if (!crossProject && !["observe", "check-checkpoint", "check-release"].includes(command))
    throw new Error(
      "Usage: guardian.mjs observe|check-checkpoint|check-release|identity|inspect-macos|inspect-agent-chats (read-only; never commits or deploys)",
    );
  const a = argsOf(rest);
  if (crossProject) {
    if (Object.keys(a).length !== 1 || !a["--input"]) throw new Error("Observer requires bounded --input JSON only");
    const result = await runCrossProject(command, readJsonInput(a["--input"]));
    console.log(JSON.stringify(result, null, 2));
    return result.errors?.length || result.coverage?.gaps?.length || result.coverage?.truncated ? 1 : 0;
  }
  if (a["--input"]) throw new Error("--input is only for cross-project observers");
  let value;
  let observationFailed = false;
  if (command === "check-release") {
    if (!a["--evidence"] || a["--root"] || a["--scope"] || a["--network"] || a["--text"])
      throw new Error("check-release requires --evidence only");
    value = {
      ...checkRelease({ ...readJsonInput(a["--evidence"]), trustedChecks: false }),
      assessmentOnly: true,
      proofSource: "untrusted_file",
    };
  } else {
    if (!a["--root"] || a["--evidence"]) throw new Error("Select --root");
    const o = observe(a["--root"], { remote: a["--remote"] ?? "origin", network: a["--network"] ?? false });
    observationFailed = o.errors.length > 0 || o.stable !== true;
    if (command === "check-checkpoint") {
      if (!a["--scope"] || a["--text"]) throw new Error("check-checkpoint requires --scope");
      value = { observation: o, ...checkCheckpoint(o, readJsonInput(a["--scope"])) };
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
    process.exitCode = await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Delivery observation failed");
    process.exitCode = 2;
  }
}
