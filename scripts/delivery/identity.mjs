// Read-only repository identity. Provider/native authority must come from trusted adapters,
// never from fields supplied in a task, skill, receipt or command-line JSON.
import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const REMOTE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const MAX_OUTPUT = 1024 * 1024;
const MAX_WORKTREES = 256;
const validClock = (now) => Number.isFinite(now) && Number.isFinite(new Date(now).getTime());
const stamp = (now) => (validClock(now) ? new Date(now).toISOString() : null);
const clock = (value) => (typeof value === "function" ? value() : (value ?? Date.now()));
const unique = (values) => [...new Set(values)];
const oneLine = (value) => (value.endsWith("\n") ? value.slice(0, -1) : value);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function canonicalGitHubRemote(value) {
  if (typeof value !== "string" || value.length > 2048 || /[\s\0?#]/u.test(value)) return null;
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9][A-Za-z0-9_.-]*)\/([A-Za-z0-9][A-Za-z0-9_.-]*?)(?:\.git)?\/?$/i.exec(
      value,
    );
  if (!match || [match[1], match[2]].some((part) => part === "." || part === "..")) return null;
  const repository = `${match[1]}/${match[2]}`.toLowerCase();
  return { providerHost: "github.com", repository, canonicalRemote: `https://github.com/${repository}.git` };
}

function nulRecords(value) {
  if (value === "") return [];
  if (typeof value !== "string" || !value.endsWith("\0")) throw new Error("truncated_git_record");
  return value.slice(0, -1).split("\0");
}

export function parseWorktreePorcelain(value) {
  if (typeof value !== "string" || !value.endsWith("\0\0")) throw new Error("truncated_worktree_record");
  const rows = [];
  let row = null;
  for (const record of nulRecords(value)) {
    if (record === "") {
      if (
        !row ||
        (!row.bare && !SHA.test(row.head ?? "")) ||
        (row.bare && (row.head || row.branch || row.detached)) ||
        (row.detached && row.branch)
      )
        throw new Error("invalid_worktree_record");
      rows.push(row);
      row = null;
    } else if (record.startsWith("worktree ")) {
      if (row) throw new Error("duplicate_worktree_record");
      const path = record.slice(9);
      if (!path || !isAbsolute(path)) throw new Error("invalid_worktree_record");
      row = { path, head: null, branch: null, bare: false, detached: false, locked: false, prunable: false };
    } else {
      if (!row) throw new Error("invalid_worktree_record");
      if (record.startsWith("HEAD ")) {
        if (row.head !== null || !SHA.test(record.slice(5))) throw new Error("invalid_worktree_HEAD");
        row.head = record.slice(5);
      } else if (record.startsWith("branch refs/heads/")) {
        if (row.branch !== null) throw new Error("duplicate_worktree_branch");
        row.branch = record.slice(18);
      } else if (record === "bare") row.bare = true;
      else if (record === "detached") row.detached = true;
      else if (record === "locked" || record.startsWith("locked ")) row.locked = true;
      else if (record === "prunable" || record.startsWith("prunable ")) row.prunable = true;
      else throw new Error("unknown_worktree_record");
    }
  }
  if (row || !rows.length) throw new Error("truncated_worktree_record");
  return rows;
}

function inRoot(path, root) {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function gitEnvironment() {
  // Inherited GIT_DIR/GIT_WORK_TREE/config injection must not retarget the chosen root.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  return {
    ...env,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
  };
}

function gitReader(root, run = spawnSync) {
  const deadline = Date.now() + 15000;
  return async (args, allowedStatuses = [0]) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("git_observation_budget_exceeded");
    const argv = [
      "--no-optional-locks",
      "--literal-pathspecs",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      "-C",
      root,
      ...args,
    ];
    const result = await run("git", argv, {
      encoding: "utf8",
      shell: false,
      timeout: Math.min(remaining, 5000),
      maxBuffer: MAX_OUTPUT,
      env: gitEnvironment(),
    });
    if (!object(result) || result.error || !allowedStatuses.includes(result.status))
      throw new Error("git_observation_failed");
    if (typeof result.stdout !== "string" || Buffer.byteLength(result.stdout) > MAX_OUTPUT)
      throw new Error("git_output_budget_exceeded");
    return result.stdout;
  };
}

function blank(now) {
  return {
    schema: "delivery-repository-identity/v1.1",
    status: "unknown",
    observedAt: stamp(now),
    root: null,
    workspaceKey: null,
    gitDir: null,
    commonDir: null,
    kind: "unknown",
    gitFile: false,
    shallow: null,
    historyComplete: null,
    branch: null,
    head: null,
    repository: null,
    canonicalRemote: null,
    providerVerified: false,
    checkpointEligible: false,
    isAuthorizationGrant: false,
    worktrees: [],
    reasons: [],
    scopeDiagnostics: [],
    coverage: { complete: false, truncated: false, gaps: [] },
  };
}

/** No network, hooks, index writes, setup scripts or fetch. Approved roots are mandatory. */
export async function collectRepositoryIdentity(input, { run, now: givenNow } = {}) {
  const now = clock(givenNow),
    out = blank(now);
  const fail = (reason) => {
    out.status = "unknown";
    out.reasons = unique([...out.reasons, reason]);
    out.coverage.complete = false;
    out.coverage.gaps.push({ reason });
    return out;
  };
  if (!validClock(now)) return fail("invalid_clock");
  if (!object(input) || typeof input.root !== "string" || !isAbsolute(input.root) || input.root.includes("\0"))
    return fail("invalid_root");
  const remote = input.remote ?? "origin";
  if (typeof remote !== "string" || !REMOTE.test(remote)) return fail("invalid_remote_name");
  if (!Array.isArray(input.approvedRoots) || !input.approvedRoots.length || input.approvedRoots.length > 128)
    return fail("approved_roots_required");
  const roots = [];
  if (input.approvedRoots.some((p) => typeof p !== "string" || !isAbsolute(p) || p.includes("\0")))
    return fail("invalid_approved_root");
  for (const path of input.approvedRoots) {
    try {
      roots.push(realpathSync(path));
    } catch {
      out.scopeDiagnostics.push({ reason: "approved_root_unavailable", path });
    }
  }
  // The allowlist is not a list of requested inventory targets. A disconnected,
  // unrelated allowed root does not remove authority to inspect another matched root.
  if (!roots.length) return fail("approved_scope_unavailable");
  try {
    out.root = realpathSync(input.root);
    out.workspaceKey = out.root;
  } catch {
    return fail("root_unavailable");
  }
  if (!roots.some((root) => inRoot(out.root, root))) return fail("root_outside_approved_scope");
  try {
    const git = gitReader(out.root, run);
    const bare = oneLine(await git(["rev-parse", "--is-bare-repository"])) === "true";
    const shallow = oneLine(await git(["rev-parse", "--is-shallow-repository"]));
    if (!["true", "false"].includes(shallow)) return fail("invalid_shallow_observation");
    out.shallow = shallow === "true";
    // Not shallow does not prove all history/objects are available or uncorrupted.
    out.historyComplete = out.shallow ? false : null;
    out.gitDir = realpathSync(oneLine(await git(["rev-parse", "--absolute-git-dir"])));
    out.commonDir = realpathSync(oneLine(await git(["rev-parse", "--path-format=absolute", "--git-common-dir"])));
    if (!bare && realpathSync(oneLine(await git(["rev-parse", "--show-toplevel"]))) !== out.root)
      return fail("not_exact_repository_root");
    out.head = oneLine(await git(["rev-parse", "--verify", "HEAD"]));
    if (!SHA.test(out.head)) return fail("invalid_head");
    out.branch = oneLine(await git(["symbolic-ref", "--quiet", "--short", "HEAD"], [0, 1])) || null;
    let superproject = "";
    if (!bare) {
      superproject = oneLine(await git(["rev-parse", "--show-superproject-working-tree"]));
      try {
        out.gitFile = lstatSync(join(out.root, ".git")).isFile();
      } catch {
        /* Existing bare/gitdir paths are classified separately. */
      }
    }
    out.kind = bare
      ? "bare"
      : superproject
        ? "submodule"
        : !out.branch
          ? "detached_worktree"
          : out.gitDir !== out.commonDir
            ? "linked_worktree"
            : "primary_worktree";
    const rawFetch = nulRecords(await git(["config", "--null", "--get-all", `remote.${remote}.url`], [0, 1]));
    const rawPush = nulRecords(await git(["config", "--null", "--get-all", `remote.${remote}.pushurl`], [0, 1]));
    if (rawFetch.length !== 1 || rawPush.length > 1)
      return fail(rawFetch.length ? "ambiguous_remote" : "remote_unavailable");
    const fetchIdentity = canonicalGitHubRemote(rawFetch[0]);
    const pushIdentity = canonicalGitHubRemote(rawPush[0] ?? rawFetch[0]);
    if (!fetchIdentity || !pushIdentity) return fail("unsupported_remote");
    if (pushIdentity.repository !== fetchIdentity.repository) return fail("push_remote_mismatch");
    // get-url expands insteadOf/pushInsteadOf; detect retargeting without invoking any transport.
    const expandedFetch = canonicalGitHubRemote(oneLine(await git(["remote", "get-url", "--all", remote])));
    const expandedPush = canonicalGitHubRemote(oneLine(await git(["remote", "get-url", "--push", "--all", remote])));
    if (
      !expandedFetch ||
      !expandedPush ||
      expandedFetch.repository !== fetchIdentity.repository ||
      expandedPush.repository !== fetchIdentity.repository
    )
      return fail("remote_rewrite_or_ambiguity");
    out.repository = fetchIdentity.repository;
    out.canonicalRemote = fetchIdentity.canonicalRemote;
    const worktrees = parseWorktreePorcelain(await git(["worktree", "list", "--porcelain", "-z"]));
    out.coverage.truncated = worktrees.length > MAX_WORKTREES;
    if (out.coverage.truncated)
      out.coverage.gaps.push({
        reason: "worktree_inventory_truncated",
        omittedCount: worktrees.length - MAX_WORKTREES,
      });
    out.worktrees = worktrees.slice(0, MAX_WORKTREES).map((row) => {
      try {
        return { ...row, path: realpathSync(row.path), available: true };
      } catch {
        out.coverage.gaps.push({ reason: "registered_worktree_unavailable" });
        return { ...row, available: false };
      }
    });
    const end = {
      root: realpathSync(input.root),
      gitDir: realpathSync(oneLine(await git(["rev-parse", "--absolute-git-dir"]))),
      commonDir: realpathSync(oneLine(await git(["rev-parse", "--path-format=absolute", "--git-common-dir"]))),
      head: oneLine(await git(["rev-parse", "--verify", "HEAD"])),
      branch: oneLine(await git(["symbolic-ref", "--quiet", "--short", "HEAD"], [0, 1])) || null,
      fetch: canonicalGitHubRemote(oneLine(await git(["remote", "get-url", "--all", remote])))?.canonicalRemote,
      push: canonicalGitHubRemote(oneLine(await git(["remote", "get-url", "--push", "--all", remote])))
        ?.canonicalRemote,
      shallow: oneLine(await git(["rev-parse", "--is-shallow-repository"])),
    };
    if (
      ["root", "gitDir", "commonDir", "head", "branch"].some((key) => end[key] !== out[key]) ||
      end.fetch !== out.canonicalRemote ||
      end.push !== out.canonicalRemote ||
      end.shallow !== shallow
    )
      return fail("identity_changed_during_observation");
    out.status = "observed";
    out.coverage.complete = out.coverage.gaps.length === 0;
    // Local identity alone cannot grant checkpoint or claim provider/native authority.
    return out;
  } catch (error) {
    const safeReasons = [
      "truncated_git_record",
      "truncated_worktree_record",
      "invalid_worktree_record",
      "invalid_worktree_HEAD",
      "duplicate_worktree_record",
      "duplicate_worktree_branch",
      "unknown_worktree_record",
      "git_output_budget_exceeded",
      "git_observation_budget_exceeded",
    ];
    return fail(safeReasons.includes(error?.message) ? error.message : "git_observation_failed");
  }
}

/** Multiple physical roots are inventory entries, never deletion candidates or publication authority. */
export async function collectRepositoryInventory(input, options = {}) {
  const now = clock(options.now);
  const roots = object(input) && Array.isArray(input.roots) ? input.roots : [];
  const limit = Number.isInteger(options.maxRoots) ? Math.max(1, Math.min(options.maxRoots, 128)) : 32;
  const out = {
    schema: "delivery-repository-inventory/v1.1",
    observedAt: stamp(now),
    repositories: [],
    commonDirectoryGroups: [],
    cloneGroups: [],
    destructiveActions: false,
    coverage: {
      complete: true,
      attempted: Math.min(roots.length, limit),
      requested: roots.length,
      truncated: roots.length > limit,
      omittedCount: Math.max(0, roots.length - limit),
      gaps: [],
    },
  };
  if (!roots.length) out.coverage.gaps.push({ reason: "no_registered_roots" });
  for (const root of roots.slice(0, limit)) {
    const entry = await collectRepositoryIdentity(
      { root, approvedRoots: input.approvedRoots, remote: input.remote },
      { ...options, now },
    );
    if (entry.status !== "observed" || !entry.coverage.complete)
      out.coverage.gaps.push({ root: entry.root, reasons: entry.reasons, gaps: entry.coverage.gaps });
    const previous = entry.root && out.repositories.find((r) => r.root === entry.root);
    if (previous) previous.aliases = unique([...previous.aliases, root]);
    else out.repositories.push({ ...entry, aliases: [root] });
  }
  const good = out.repositories.filter((r) => r.status === "observed");
  for (const commonDir of unique(good.map((r) => r.commonDir))) {
    const members = good.filter((r) => r.commonDir === commonDir);
    out.commonDirectoryGroups.push({
      commonDir,
      roots: members.map((r) => r.root),
      kind: members.length > 1 ? "linked_worktrees" : "single_observed_workspace",
    });
  }
  for (const repository of unique(good.map((r) => r.repository))) {
    const members = good.filter((r) => r.repository === repository),
      commonDirs = unique(members.map((r) => r.commonDir));
    if (commonDirs.length > 1)
      out.cloneGroups.push({
        repository,
        commonDirs,
        roots: members.map((r) => r.root),
        kind: "independent_clones",
        action: "preserve",
      });
  }
  out.coverage.complete = out.coverage.gaps.length === 0 && !out.coverage.truncated;
  return out;
}

function repositoryId(value) {
  if (Number.isSafeInteger(value) && value > 0) return String(value);
  return typeof value === "string" && /^[1-9][0-9]*$/.test(value) && value.length <= 30 ? value : null;
}
function branchName(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 255 &&
    !/[\s~^:?*[\\]/u.test(value) &&
    !Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !value.startsWith("-") &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.endsWith(".") &&
    !value.endsWith(".lock") &&
    !value.includes("//")
  );
}

/**
 * providerLookup is executable trusted-host configuration, not a JSON input field.
 * It must perform the provider read itself and return {source:'github_api', id,
 * full_name, default_branch, observedAt}. This module neither authenticates a caller
 * nor verifies native project/task authority; the result explicitly limits its scope.
 */
export async function resolveProjectBinding(input, options = {}) {
  const now = clock(options.now);
  const local = await collectRepositoryIdentity(input, { ...options, now });
  const out = {
    ...local,
    verificationState: "unknown",
    verificationScope: "repository_identity_only",
    providerRepositoryId: null,
    defaultBranch: null,
    providerObservedAt: null,
  };
  const reject = (reason, conflict = false) => {
    out.verificationState = conflict ? "conflict" : "unknown";
    out.providerVerified = false;
    out.reasons = unique([...out.reasons, reason]);
    return out;
  };
  if (local.status !== "observed" || !local.coverage.complete) return reject("local_identity_unverified");
  const expected =
    typeof input.expectedRepository === "string" && REPOSITORY.test(input.expectedRepository)
      ? input.expectedRepository.toLowerCase()
      : null;
  const expectedId = repositoryId(input.expectedRepositoryId);
  if (!expected || !expectedId) return reject("expected_repository_identity_required");
  if (expected !== local.repository) return reject("repository_mismatch", true);
  if (typeof options.providerLookup !== "function") return reject("provider_lookup_required");
  let provider;
  try {
    provider = await options.providerLookup({ providerHost: "github.com", repository: local.repository });
  } catch {
    return reject("provider_lookup_failed");
  }
  if (!object(provider) || provider.source !== "github_api") return reject("untrusted_provider_source");
  const providerTime =
    typeof provider.observedAt === "string" && /(?:Z|[+-]\d\d:\d\d)$/.test(provider.observedAt)
      ? Date.parse(provider.observedAt)
      : NaN;
  if (!Number.isFinite(providerTime) || providerTime > now + 30000 || now - providerTime > 120000)
    return reject("provider_observation_stale_or_invalid");
  const id = repositoryId(provider.id);
  if (!id || !branchName(provider.default_branch)) return reject("incomplete_provider_identity");
  if (typeof provider.full_name !== "string" || provider.full_name.toLowerCase() !== expected)
    return reject("provider_repository_mismatch", true);
  if (id !== expectedId) return reject("provider_repository_id_mismatch", true);
  // A provider read may take time. Revalidate the selected physical workspace,
  // branch and both remote directions; matching HEAD alone cannot detect retargeting.
  const revalidated = await collectRepositoryIdentity(input, { ...options, now: clock(options.now) });
  const identityFields = [
    "root",
    "gitDir",
    "commonDir",
    "head",
    "branch",
    "kind",
    "gitFile",
    "repository",
    "canonicalRemote",
    "shallow",
  ];
  if (
    revalidated.status !== "observed" ||
    !revalidated.coverage.complete ||
    identityFields.some((key) => revalidated[key] !== local[key])
  ) {
    out.status = "unknown";
    return reject("identity_changed_during_observation");
  }
  Object.assign(out, revalidated);
  const completedAt = clock(options.now);
  if (!validClock(completedAt) || providerTime > completedAt + 30000 || completedAt - providerTime > 120000)
    return reject("provider_observation_stale_or_invalid");
  out.providerRepositoryId = id;
  out.defaultBranch = provider.default_branch;
  out.providerObservedAt = provider.observedAt;
  out.providerVerified = true;
  out.verificationState = "verified";
  return out;
}
