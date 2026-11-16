#!/usr/bin/env node
// Repository-local pre-push guard. A supplementary safety net, not an OS sandbox or secret scanner replacement.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { protectedPath, safePath } from "./policy.mjs";

const SHA = /^[a-f0-9]{40,64}$/;
const ZERO = /^0+$/;
const SECRET =
  /(?:^|\n)-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|sk-(?:proj-)?[A-Za-z0-9_-]{30,}/;
function git(args) {
  const r = spawnSync("git", ["--literal-pathspecs", "-c", "core.fsmonitor=false", ...args], {
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" },
  });
  if (r.error || r.status !== 0) throw new Error("git_observation_failed");
  return r.stdout;
}
const nul = (text) => {
  if (!text) return [];
  if (!text.endsWith("\0")) throw new Error("truncated_git_record");
  return text.slice(0, -1).split("\0");
};
function identity(url) {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}
function reject(code) {
  throw new Error(code);
}

export function checkPush({ repository, remote, url, input }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "")) reject("invalid_repository");
  if (identity(url) !== repository.toLowerCase()) reject("repository_mismatch");
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(remote ?? "")) reject("invalid_remote");
  if (input.length > 16384) reject("push_input_too_large");
  const lines = input.trim() ? input.trim().split("\n") : [];
  if (!lines.length) return { ok: true, commits: 0, files: 0 };
  if (lines.length !== 1) reject("multiple_refs");
  const fields = lines[0].trim().split(/\s+/);
  if (fields.length !== 4) reject("invalid_push_record");
  const [localRef, head, remoteRef, old] = fields;
  if (!SHA.test(head) || !SHA.test(old)) reject("invalid_object");
  if (ZERO.test(head)) reject("branch_deletion");
  if (!remoteRef.startsWith("refs/heads/")) reject("non_branch_ref");
  if (/^refs\/heads\/(main|master|production|prod|release(?:\/.*)?)$/i.test(remoteRef)) reject("protected_ref");
  if (head !== git(["rev-parse", "HEAD"]).trim()) reject("head_mismatch");
  if (localRef !== git(["symbolic-ref", "HEAD"]).trim() || localRef !== remoteRef) reject("branch_mismatch");
  const urls = git(["remote", "get-url", "--push", "--all", remote]).trim().split("\n");
  if (urls.length !== 1 || identity(urls[0]) !== repository.toLowerCase()) reject("configured_remote_mismatch");
  const commits = git(["rev-list", "--max-count=129", head, "--not", `--remotes=${remote}`])
    .trim()
    .split("\n")
    .filter(Boolean);
  if (commits.length > 128) reject("too_many_unpublished_commits_refresh_remote");
  if (commits.some((x) => !SHA.test(x))) reject("invalid_commit_inventory");
  let bytes = 0,
    files = 0,
    baselineCount = null;
  const deleted = new Set();
  for (const commit of [...commits].reverse()) {
    const parents = git(["rev-list", "--parents", "--max-count=1", commit]).trim().split(" ").slice(1);
    if (baselineCount === null)
      baselineCount = nul(git(["ls-tree", "-r", "--name-only", "-z", parents[0] ?? commit])).length;
    const changeArgs = [
      "diff-tree",
      "--no-commit-id",
      "-r",
      "--no-renames",
      "--name-status",
      "-z",
      ...(parents[0] ? [parents[0], commit] : ["--root", commit]),
    ];
    const entries = nul(git(changeArgs));
    if (entries.length % 2) reject("invalid_change_inventory");
    for (let i = 0; i < entries.length; i += 2) {
      const status = entries[i],
        path = entries[i + 1];
      if (!["A", "M", "D", "T"].includes(status)) reject("unrecognized_change");
      if (!safePath(path)) reject("unsafe_path");
      if (status === "D") {
        deleted.add(path);
        continue;
      }
      if (protectedPath(path)) reject("protected_path");
      if (++files > 1024) reject("too_many_changed_blobs");
      const tree = nul(git(["ls-tree", "-z", commit, "--", path]));
      if (tree.length !== 1) reject("invalid_tree_record");
      const entry = /^(\d{6}) blob ([a-f0-9]{40,64})\t([\s\S]+)$/.exec(tree[0]);
      if (!entry) reject("unsupported_tree_entry");
      if (entry[1] === "120000") reject("symlink");
      if (!["100644", "100755"].includes(entry[1])) reject("unsupported_file_mode");
      const size = Number(git(["cat-file", "-s", entry[2]]).trim());
      if (!Number.isSafeInteger(size) || size < 0 || size > 2 * 1024 * 1024) reject("large_blob_requires_review");
      bytes += size;
      if (bytes > 32 * 1024 * 1024) reject("scan_budget_exceeded");
      if (SECRET.test(git(["cat-file", "blob", entry[2]]))) reject("secret_pattern");
    }
  }
  if (deleted.size > 20 || (baselineCount > 0 && deleted.size > baselineCount * 0.2)) reject("bulk_deletion");
  return { ok: true, commits: commits.length, files, deleted: deleted.size };
}
export function main(argv = process.argv.slice(2), input = readFileSync(0, "utf8")) {
  if (argv.length !== 4 || argv[0] !== "--repository")
    reject("usage: push-guard.mjs --repository owner/name remote-name remote-url");
  const result = checkPush({ repository: argv[1], remote: argv[2], url: argv[3], input });
  console.error(
    `Delivery Guardian: push preflight passed (${result.commits} unpublished commits checked). This does not prove tests, review, merge or deployment.`,
  );
  return 0;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(
      `Delivery Guardian blocked this push: ${error instanceof Error ? error.message : "unknown_error"}. Preserve the work; ask the existing release owner to resolve the evidence. Do not bypass the hook.`,
    );
    process.exitCode = 1;
  }
}
