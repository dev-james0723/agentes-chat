// Read-only Git commands: do not inherit a different repository/index or run content filters.
import { spawnSync } from "node:child_process";
import { devNull } from "node:os";

function environment() {
  const env = {};
  // Keep explicitly selected config files (including tests' isolated global config), not command/config injection.
  const configFiles = new Set(["GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"]);
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_") || configFiles.has(key)) env[key] = value;
  }
  return { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", GIT_NO_REPLACE_OBJECTS: "1" };
}

function readCommand(args) {
  const command = args[0];
  if (
    [
      "rev-parse",
      "status",
      "diff",
      "ls-files",
      "ls-remote",
      "rev-list",
      "ls-tree",
      "diff-tree",
      "cat-file",
      "merge-base",
    ].includes(command)
  )
    return true;
  if (command === "branch") return args.length === 2 && args[1] === "--show-current";
  if (command === "symbolic-ref") return args.length === 2 && args[1] === "HEAD";
  if (command === "remote") return args[1] === "get-url";
  return (
    command === "config" &&
    args[1] === "--null" &&
    args[2] === "--name-only" &&
    args[3] === "--get-regexp" &&
    args.length === 5
  );
}

export function createGitReader(root) {
  const env = environment();
  const base = [
    "--no-replace-objects",
    "--literal-pathspecs",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.untrackedCache=false",
    "-c",
    `core.hooksPath=${devNull}`,
    "-c",
    "diff.external=",
    "-C",
    root,
  ];
  let filters = [];
  function result(args, allowed = [0]) {
    if (!Array.isArray(args) || !args.every((x) => typeof x === "string") || !readCommand(args))
      throw new Error("Non-observation Git command refused");
    const r = spawnSync("git", [...base, ...filters, ...args], {
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 8 * 1024 * 1024,
      env,
    });
    if (r.error || !allowed.includes(r.status)) throw new Error("Git observation failed");
    return { status: r.status, stdout: r.stdout };
  }
  const config = result(
    ["config", "--null", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$"],
    [0, 1],
  );
  const keys = config.status === 1 ? [] : config.stdout.split("\0").filter(Boolean);
  if (keys.some((key) => !/^filter\..+\.(clean|smudge|process|required)$/i.test(key) || key.includes("\n")))
    throw new Error("Unsupported filter configuration");
  filters = [...new Set(keys)].flatMap((key) => ["-c", `${key}=${/\.required$/i.test(key) ? "false" : ""}`]);
  return {
    read: (args) => result(args).stdout,
    result,
    filtersSuppressed: keys.length > 0,
  };
}
