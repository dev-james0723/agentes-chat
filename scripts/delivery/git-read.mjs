// Fixed read operations only. Content-sensitive status uses a private metadata view,
// so concurrent repository config changes cannot introduce executable Git filters.
// This is not an OS sandbox against a process running with the same user privileges.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { devNull, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const REMOTE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const FILTER_QUERY = [
  "config",
  "--null",
  "--name-only",
  "--get-regexp",
  "^filter\\..*\\.(clean|smudge|process|required)$",
];
const STATUS = ["status", "--porcelain=v1", "-z", "--untracked-files=all"];
const MAX_INDEX_BYTES = 16 * 1024 * 1024;
const equal = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function environment() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  return {
    ...env,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: devNull,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_ATTR_NOSYSTEM: "1",
  };
}
function readCommand(a) {
  if (
    !Array.isArray(a) ||
    a.length > 16 ||
    !a.every((x) => typeof x === "string" && x.length <= 65536 && !x.includes("\0"))
  )
    return false;
  if (equal(a, FILTER_QUERY) || equal(a, STATUS)) return true;
  if (a[0] === "rev-parse")
    return [
      ["rev-parse", "HEAD"],
      ["rev-parse", "--show-toplevel"],
      ["rev-parse", "--show-object-format"],
      ["rev-parse", "--absolute-git-dir"],
      ["rev-parse", "--shared-index-path"],
      ["rev-parse", "--path-format=absolute", "--git-path", "index"],
      ["rev-parse", "--path-format=absolute", "--git-path", "objects"],
    ].some((v) => equal(a, v));
  if (a[0] === "branch") return equal(a, ["branch", "--show-current"]);
  if (a[0] === "symbolic-ref") return equal(a, ["symbolic-ref", "HEAD"]);
  if (a[0] === "remote")
    return (
      (a.length === 4 && equal(a.slice(0, 3), ["remote", "get-url", "--all"]) && REMOTE.test(a[3])) ||
      (a.length === 5 && equal(a.slice(0, 4), ["remote", "get-url", "--push", "--all"]) && REMOTE.test(a[4]))
    );
  if (a[0] === "diff")
    return equal(a, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z"]);
  if (a[0] === "ls-files") return equal(a, ["ls-files", "-z"]) || equal(a, ["ls-files", "--stage", "-z"]);
  if (a[0] === "cat-file") return a.length === 3 && ["-t", "-s", "blob"].includes(a[1]) && SHA.test(a[2]);
  if (a[0] === "merge-base") return a.length === 4 && a[1] === "--is-ancestor" && SHA.test(a[2]) && SHA.test(a[3]);
  if (a[0] === "rev-list") {
    if (a.length === 4 && a[1] === "--parents" && a[2] === "--max-count=1" && SHA.test(a[3])) return true;
    if (a[1] !== "--max-count=129") return false;
    if (a.length === 3) {
      const range = a[2].split("..");
      return range.length === 2 && range.every((v) => SHA.test(v));
    }
    return (
      a.length === 5 &&
      SHA.test(a[2]) &&
      a[3] === "--not" &&
      a[4].startsWith("--remotes=") &&
      REMOTE.test(a[4].slice(10))
    );
  }
  if (a[0] === "ls-tree")
    return (
      (a.length === 5 && equal(a.slice(0, 4), ["ls-tree", "-r", "--name-only", "-z"]) && SHA.test(a[4])) ||
      (a.length === 5 && a[1] === "-z" && SHA.test(a[2]) && a[3] === "--" && !!a[4])
    );
  if (a[0] === "diff-tree")
    return (
      a.length === 8 &&
      equal(a.slice(0, 6), ["diff-tree", "--no-commit-id", "-r", "--no-renames", "--name-status", "-z"]) &&
      (a[6] === "--root" || SHA.test(a[6])) &&
      SHA.test(a[7])
    );
  return false;
}
function boundedFile(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_INDEX_BYTES) throw new Error();
    const bytes = Buffer.alloc(stat.size + 1);
    let n = 0;
    while (n < bytes.length) {
      const got = readSync(fd, bytes, n, bytes.length - n, null);
      if (!got) break;
      n += got;
    }
    if (n !== stat.size) throw new Error();
    return bytes.subarray(0, n);
  } catch {
    throw new Error("Git index snapshot unavailable");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function createGitReader(inputRoot) {
  const root = realpathSync(inputRoot),
    env = environment(),
    deadline = Date.now() + 15000;
  const base = [
    "--no-replace-objects",
    "--no-lazy-fetch",
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
  let filtersSuppressed = false,
    submodulesSuppressed = false;
  function execute(args, allowed = [0], extra = [], extraEnv = {}) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Git observation budget exceeded");
    const r = spawnSync("git", [...base, ...extra, ...args], {
      encoding: "utf8",
      timeout: Math.min(remaining, 5000),
      maxBuffer: 8 * 1024 * 1024,
      shell: false,
      env: { ...env, ...extraEnv },
    });
    if (r.error || !allowed.includes(r.status)) throw new Error("Git observation failed");
    return { status: r.status, stdout: r.stdout };
  }
  function inspectFilters() {
    const found = execute(FILTER_QUERY, [0, 1]);
    if (found.status === 1) return;
    const keys = found.stdout.split("\0").filter(Boolean);
    if (keys.some((key) => !/^filter\..+\.(clean|smudge|process|required)$/i.test(key) || key.includes("\n")))
      throw new Error("Unsupported filter configuration");
    filtersSuppressed ||= keys.length > 0;
  }
  function metadata() {
    const read = (args) => execute(args).stdout.trim();
    const gitDir = realpathSync(read(["rev-parse", "--absolute-git-dir"]));
    const indexPath = read(["rev-parse", "--path-format=absolute", "--git-path", "index"]);
    if (!isAbsolute(indexPath) || realpathSync(dirname(indexPath)) !== gitDir || basename(indexPath) !== "index")
      throw new Error("Git index outside selected metadata");
    const index = boundedFile(indexPath);
    const objects = realpathSync(read(["rev-parse", "--path-format=absolute", "--git-path", "objects"]));
    const head = read(["rev-parse", "HEAD"]),
      format = read(["rev-parse", "--show-object-format"]);
    if (!SHA.test(head) || !["sha1", "sha256"].includes(format)) throw new Error("Git snapshot identity unavailable");
    const sharedRef = read(["rev-parse", "--shared-index-path"]);
    let sharedPath = null,
      shared = null;
    if (sharedRef) {
      sharedPath = isAbsolute(sharedRef) ? sharedRef : resolve(root, sharedRef);
      if (
        !/^sharedindex\.(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(basename(sharedPath)) ||
        realpathSync(dirname(sharedPath)) !== gitDir
      )
        throw new Error("Git shared index outside selected metadata");
      shared = boundedFile(sharedPath);
    }
    return { gitDir, indexPath, index, objects, head, format, sharedPath, shared };
  }
  function privateStatus() {
    inspectFilters();
    const before = metadata(),
      privateDir = mkdtempSync(join(tmpdir(), "guardian-git-status-"));
    try {
      mkdirSync(join(privateDir, "refs"), { mode: 0o700 });
      writeFileSync(join(privateDir, "HEAD"), `${before.head}\n`, { mode: 0o600 });
      writeFileSync(
        join(privateDir, "config"),
        `[core]\nrepositoryFormatVersion = ${before.format === "sha256" ? 1 : 0}\nbare = false\n[diff]\nignoreSubmodules = all\n${before.format === "sha256" ? "[extensions]\nobjectFormat = sha256\n" : ""}`,
        { mode: 0o600 },
      );
      writeFileSync(join(privateDir, "index"), before.index, { mode: 0o600 });
      if (before.shared) writeFileSync(join(privateDir, basename(before.sharedPath)), before.shared, { mode: 0o600 });
      const extra = [`--git-dir=${privateDir}`, `--work-tree=${root}`];
      const privateEnv = { GIT_OBJECT_DIRECTORY: before.objects };
      const inventory = execute(["ls-files", "--stage", "-z"], [0], extra, privateEnv).stdout;
      submodulesSuppressed ||= inventory.split("\0").some((row) => row.startsWith("160000 "));
      const result = execute([...STATUS, "--ignore-submodules=all"], [0], extra, privateEnv);
      const after = metadata();
      if (
        before.gitDir !== after.gitDir ||
        before.indexPath !== after.indexPath ||
        before.objects !== after.objects ||
        before.head !== after.head ||
        before.format !== after.format ||
        before.sharedPath !== after.sharedPath ||
        hash(before.index) !== hash(after.index) ||
        (before.shared && hash(before.shared) !== hash(after.shared))
      )
        throw new Error("Git state changed during observation");
      inspectFilters();
      return result;
    } finally {
      rmSync(privateDir, { recursive: true, force: true });
    }
  }
  inspectFilters();
  function result(args, allowed = [0]) {
    if (!readCommand(args) || !Array.isArray(allowed) || !allowed.every((x) => Number.isInteger(x) && x >= 0 && x <= 1))
      throw new Error("Non-observation Git command refused");
    return equal(args, STATUS) ? privateStatus() : execute(args, allowed);
  }
  return {
    read: (args) => result(args).stdout,
    result,
    get filtersSuppressed() {
      return filtersSuppressed;
    },
    get submodulesSuppressed() {
      return submodulesSuppressed;
    },
  };
}
