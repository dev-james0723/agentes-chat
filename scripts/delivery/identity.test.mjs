import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const target = new URL("./identity.mjs", import.meta.url);
const api = existsSync(target) ? await import(target.href) : {};
const now = Date.parse("2026-11-16T20:00:00Z");
const environment = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
function git(cwd, ...args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: environment });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
function fixture(t, name = "primary") {
  const parent = mkdtempSync(join(tmpdir(), "guardian-identity-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, name);
  mkdirSync(root);
  git(root, "init", "-b", "feat/task");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Test");
  writeFileSync(join(root, "sample.txt"), "fixture\n");
  git(root, "add", "--", "sample.txt");
  git(root, "commit", "-m", "fixture");
  git(root, "remote", "add", "origin", "https://github.com/Example/App.git");
  return { parent, root, input: { root, approvedRoots: [parent] } };
}
function requireFunction(name) {
  assert.equal(typeof api[name], "function", `${name} must exist`);
  return api[name];
}
const collect = (input, options = {}) => requireFunction("collectRepositoryIdentity")(input, { now, ...options });
const inventory = (input, options = {}) => requireFunction("collectRepositoryInventory")(input, { now, ...options });
const resolve = (input, options = {}) => requireFunction("resolveProjectBinding")(input, { now, ...options });
const provider =
  (change = {}) =>
  async () => ({
    source: "github_api",
    id: 12345,
    full_name: "Example/App",
    default_branch: "main",
    observedAt: new Date(now).toISOString(),
    ...change,
  });

test("canonical remote identity supports standard GitHub forms and rejects credentials/hosts", () => {
  const canonical = requireFunction("canonicalGitHubRemote");
  for (const value of [
    "https://github.com/Example/App.git",
    "git@github.com:Example/App.git",
    "ssh://git@github.com/Example/App.git",
  ])
    assert.equal(canonical(value)?.repository, "example/app");
  for (const value of [
    "https://token@github.com/example/app.git",
    "https://github.com.evil.invalid/example/app",
    "../local",
    "ext::touch marker",
    "https://github.com/example/app?token=x",
  ])
    assert.equal(canonical(value), null);
});

test("local observation preserves HEAD/index/config and does not infer provider verification", async (t) => {
  const { root, input } = fixture(t);
  const files = [".git/HEAD", ".git/index", ".git/config"];
  const before = files.map((name) => readFileSync(join(root, name)));
  const result = await collect(input);
  assert.equal(result.status, "observed");
  assert.equal(result.kind, "primary_worktree");
  assert.equal(result.repository, "example/app");
  assert.equal(result.providerVerified, false);
  assert.equal(result.checkpointEligible, false);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.branch, "feat/task");
  assert.equal(result.root, realpathSync(root));
  for (const [i, name] of files.entries()) assert.deepEqual(readFileSync(join(root, name)), before[i]);
});

test("linked worktrees share common directory; independent clones remain separate", async (t) => {
  const { root, parent } = fixture(t);
  const linked = join(parent, "linked");
  git(root, "worktree", "add", "-b", "feat/linked", linked);
  const clone = join(parent, "clone");
  git(parent, "clone", "--local", root, clone);
  git(clone, "remote", "set-url", "origin", "https://github.com/example/app.git");
  const result = await inventory({ roots: [root, linked, clone], approvedRoots: [parent] });
  assert.equal(result.coverage.complete, true);
  assert.equal(result.repositories.length, 3);
  assert.equal(result.repositories.find((r) => r.root === realpathSync(linked)).kind, "linked_worktree");
  assert.equal(result.commonDirectoryGroups.length, 2);
  assert.equal(result.cloneGroups.length, 1);
  assert.equal(result.cloneGroups[0].commonDirs.length, 2);
  assert.equal(result.destructiveActions, false);
  assert.ok(existsSync(root) && existsSync(linked) && existsSync(clone));
});

test("symlink aliases collapse to one real workspace identity", async (t) => {
  const { root, parent } = fixture(t);
  const alias = join(parent, "alias");
  symlinkSync(root, alias);
  const result = await inventory({ roots: [root, alias], approvedRoots: [parent] });
  assert.equal(result.repositories.length, 1);
  assert.equal(result.repositories[0].aliases.length, 2);
  assert.equal(result.repositories[0].workspaceKey, result.repositories[0].root);
});

test("scope escape through a symlink fails without reading the other repo", async (t) => {
  const { root, parent } = fixture(t);
  const permitted = join(parent, "permitted");
  mkdirSync(permitted);
  const escapePath = join(permitted, "escape");
  symlinkSync(root, escapePath);
  let calls = 0;
  const result = await collect(
    { root: escapePath, approvedRoots: [permitted] },
    {
      run: () => {
        calls++;
        throw new Error("must not run");
      },
    },
  );
  assert.equal(result.status, "unknown");
  assert.ok(result.reasons.includes("root_outside_approved_scope"));
  assert.equal(calls, 0);
});

test("detached HEAD and bare repositories are explicit and cannot checkpoint", async (t) => {
  const { root, parent, input } = fixture(t);
  git(root, "checkout", "--detach");
  const detached = await collect(input);
  assert.equal(detached.kind, "detached_worktree");
  assert.equal(detached.branch, null);
  assert.equal(detached.checkpointEligible, false);
  const bare = join(parent, "bare.git");
  git(parent, "clone", "--bare", root, bare);
  git(bare, "remote", "set-url", "origin", "https://github.com/example/app.git");
  const bareResult = await collect({ root: bare, approvedRoots: [parent] });
  assert.equal(bareResult.kind, "bare");
  assert.equal(bareResult.checkpointEligible, false);
});

test("submodule gitfile is classified explicitly", async (t) => {
  const { root, parent } = fixture(t);
  const superRoot = join(parent, "super");
  mkdirSync(superRoot);
  git(superRoot, "init", "-b", "feat/super");
  git(superRoot, "-c", "protocol.file.allow=always", "submodule", "add", root, "module");
  const moduleRoot = join(superRoot, "module");
  git(moduleRoot, "remote", "set-url", "origin", "https://github.com/example/app.git");
  const result = await collect({ root: moduleRoot, approvedRoots: [parent] });
  assert.equal(result.kind, "submodule");
  assert.equal(result.gitFile, true);
  assert.equal(result.checkpointEligible, false);
});

test("missing roots and bounded truncation remain coverage gaps", async (t) => {
  const { root, parent } = fixture(t);
  const missing = join(parent, "missing");
  const result = await inventory({ roots: [root, missing], approvedRoots: [parent] });
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.gaps.length, 1);
  const bounded = await inventory({ roots: [root, missing], approvedRoots: [parent] }, { maxRoots: 1 });
  assert.equal(bounded.coverage.complete, false);
  assert.equal(bounded.coverage.truncated, true);
  assert.equal(bounded.coverage.omittedCount, 1);
});

test("Unicode, newline and shell characters in workspace paths survive NUL parsing", async (t) => {
  const { root, parent, input } = fixture(t, "中文 $(touch NOT-RUN)\npath");
  const linked = join(parent, "linked\n尾 ");
  git(root, "worktree", "add", "-b", "feat/newline", linked);
  const result = await collect(input);
  assert.equal(result.root, realpathSync(root));
  assert.ok(result.worktrees.some((w) => w.path === realpathSync(linked)));
  assert.equal(existsSync(join(parent, "NOT-RUN")), false);
});

test("malformed/truncated worktree records never become an empty success", () => {
  const parse = requireFunction("parseWorktreePorcelain");
  assert.throws(() => parse("worktree /tmp/repo\0HEAD abc\0"), /record|HEAD|truncat/i);
  assert.throws(() => parse("worktree /tmp/repo"), /truncat/i);
  assert.throws(
    () => parse("worktree /tmp/repo\0HEAD " + "a".repeat(40) + "\0branch refs/heads/main\0worktree /tmp/other\0\0"),
    /record|duplicate/i,
  );
});

test("sensitive remote URLs are rejected without echoing credential content", async (t) => {
  const { root, input } = fixture(t);
  const fake = "fixture-sensitive-token";
  git(root, "remote", "set-url", "origin", `https://${fake}@github.com/example/app.git`);
  const result = await collect(input);
  assert.equal(result.status, "unknown");
  assert.ok(result.reasons.includes("unsupported_remote"));
  assert.ok(!JSON.stringify(result).includes(fake));
});

test("wrong push URL is blocked", async (t) => {
  const { root, input } = fixture(t);
  git(root, "remote", "set-url", "--push", "origin", "https://github.com/other/app.git");
  const result = await collect(input);
  assert.equal(result.status, "unknown");
  assert.ok(result.reasons.includes("push_remote_mismatch"));
});

test("expected immutable ID and caller-provided provider receipt cannot self-verify", async (t) => {
  const { input } = fixture(t);
  const result = await resolve({
    ...input,
    expectedRepository: "example/app",
    expectedRepositoryId: 12345,
    providerObservation: await provider()(),
  });
  assert.equal(result.verificationState, "unknown");
  assert.equal(result.providerVerified, false);
  assert.ok(result.reasons.includes("provider_lookup_required"));
});

test("fresh trusted provider adapter binds immutable ID and default branch", async (t) => {
  const { input } = fixture(t);
  const result = await resolve(
    { ...input, expectedRepository: "example/app", expectedRepositoryId: 12345 },
    { providerLookup: provider() },
  );
  assert.equal(result.verificationState, "verified");
  assert.equal(result.providerVerified, true);
  assert.equal(result.providerRepositoryId, "12345");
  assert.equal(result.defaultBranch, "main");
  assert.equal(result.isAuthorizationGrant, false);
  assert.equal(result.verificationScope, "repository_identity_only");
});

test("different expected repository or provider immutable ID conflicts", async (t) => {
  const { input } = fixture(t);
  const wrongRepo = await resolve(
    { ...input, expectedRepository: "wrong/app", expectedRepositoryId: 12345 },
    { providerLookup: provider() },
  );
  assert.equal(wrongRepo.verificationState, "conflict");
  const wrongId = await resolve(
    { ...input, expectedRepository: "example/app", expectedRepositoryId: 999 },
    { providerLookup: provider() },
  );
  assert.equal(wrongId.verificationState, "conflict");
  assert.ok(wrongId.reasons.includes("provider_repository_id_mismatch"));
});

test("missing expected identity fails closed even with a provider response", async (t) => {
  const { input } = fixture(t);
  const result = await resolve(input, { providerLookup: provider() });
  assert.equal(result.verificationState, "unknown");
  assert.ok(result.reasons.includes("expected_repository_identity_required"));
});

test("stale, future, wrong-issuer and wrong-name provider data cannot verify", async (t) => {
  const { input } = fixture(t);
  for (const change of [
    { observedAt: new Date(now - 120001).toISOString() },
    { observedAt: new Date(now + 30001).toISOString() },
    { source: "agent_json" },
    { full_name: "someone/else" },
    { id: null },
    { default_branch: null },
  ]) {
    const result = await resolve(
      { ...input, expectedRepository: "example/app", expectedRepositoryId: 12345 },
      { providerLookup: provider(change) },
    );
    assert.notEqual(result.verificationState, "verified", JSON.stringify(change));
    assert.equal(result.providerVerified, false);
  }
});

test("provider outage is unknown without disclosing exception text", async (t) => {
  const { input } = fixture(t);
  const result = await resolve(
    { ...input, expectedRepository: "example/app", expectedRepositoryId: 12345 },
    {
      providerLookup: async () => {
        throw new Error("private credential detail");
      },
    },
  );
  assert.equal(result.verificationState, "unknown");
  assert.ok(result.reasons.includes("provider_lookup_failed"));
  assert.ok(!JSON.stringify(result).includes("private credential"));
});

test("local fsmonitor config is not executed by identity observation", async (t) => {
  const { root, parent, input } = fixture(t);
  const hook = join(parent, "fsmonitor.sh"),
    marker = join(parent, "ran");
  writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
  git(root, "config", "core.fsmonitor", hook);
  const result = await collect(input);
  assert.equal(result.status, "observed");
  assert.equal(existsSync(marker), false);
});

test("invalid remote argument is rejected before any subprocess", async (t) => {
  const { input } = fixture(t);
  let calls = 0;
  const result = await collect(
    { ...input, remote: "--upload-pack=bad" },
    {
      run: () => {
        calls++;
      },
    },
  );
  assert.equal(result.status, "unknown");
  assert.ok(result.reasons.includes("invalid_remote_name"));
  assert.equal(calls, 0);
});

test("runner seam uses argv and strict output limits, never a shell", async (t) => {
  const { input } = fixture(t);
  const calls = [];
  const run = (executable, args, options) => {
    calls.push({ executable, args, options });
    return spawnSync(executable, args, { ...options, encoding: "utf8" });
  };
  assert.equal((await collect(input, { run })).status, "observed");
  assert.ok(calls.length > 0);
  assert.ok(
    calls.every(
      (c) =>
        c.executable === "git" &&
        Array.isArray(c.args) &&
        c.options.shell === false &&
        c.options.timeout <= 15000 &&
        c.options.maxBuffer <= 1048576,
    ),
  );
  assert.ok(calls.every((c) => !c.args.includes("fetch") && !c.args.includes("ls-remote")));
});

test("finite but out-of-range clock is unknown rather than throwing", async (t) => {
  const { input } = fixture(t);
  const result = await collect(input, { now: Number.MAX_VALUE });
  assert.equal(result.status, "unknown");
  assert.ok(result.reasons.includes("invalid_clock"));
});

test("contradictory worktree flags fail closed", () => {
  const parse = requireFunction("parseWorktreePorcelain");
  const head = "HEAD " + "a".repeat(40) + "\0";
  assert.throws(
    () => parse("worktree /tmp/repo\0" + head + "branch refs/heads/main\0detached\0\0"),
    /invalid|conflict/i,
  );
  assert.throws(() => parse("worktree /tmp/repo\0bare\0" + head + "\0"), /invalid|conflict/i);
});

for (const change of ["remote", "branch", "remote_and_branch"]) {
  test(`provider lookup cannot verify an identity that changed ${change} at the same HEAD`, async (t) => {
    const { root, input } = fixture(t);
    const head = git(root, "rev-parse", "HEAD");
    const result = await resolve(
      { ...input, expectedRepository: "example/app", expectedRepositoryId: 12345 },
      {
        providerLookup: async () => {
          if (change.includes("remote")) git(root, "remote", "set-url", "origin", "https://github.com/other/app.git");
          if (change.includes("branch")) git(root, "branch", "-m", "main");
          return provider()();
        },
      },
    );
    assert.equal(git(root, "rev-parse", "HEAD"), head);
    assert.equal(result.verificationState, "unknown");
    assert.equal(result.providerVerified, false);
    assert.ok(result.reasons.includes("identity_changed_during_observation"));
  });
}

test("local observation rejects a same-HEAD remote/branch change before its final read", async (t) => {
  const { root, input } = fixture(t);
  let changed = false;
  const run = (executable, args, options) => {
    const result = spawnSync(executable, args, options);
    if (!changed && args.includes("worktree") && args.includes("list")) {
      changed = true;
      git(root, "remote", "set-url", "origin", "https://github.com/other/app.git");
      git(root, "branch", "-m", "main");
    }
    return result;
  };
  const result = await collect(input, { run });
  assert.equal(changed, true);
  assert.equal(result.status, "unknown");
  assert.ok(result.reasons.includes("identity_changed_during_observation"));
});

test("an unrelated unavailable allowlist root does not block a verified selected repo", async (t) => {
  const { root, parent, input } = fixture(t);
  const missing = join(parent, "offline-approved-root");
  const roots = [parent, missing];
  const local = await collect({ ...input, approvedRoots: roots });
  assert.equal(local.status, "observed");
  assert.equal(local.coverage.complete, true);
  assert.ok(local.scopeDiagnostics.some((d) => d.reason === "approved_root_unavailable"));
  const binding = await resolve(
    { ...input, approvedRoots: roots, expectedRepository: "example/app", expectedRepositoryId: 12345 },
    { providerLookup: provider() },
  );
  assert.equal(binding.verificationState, "verified");
  const all = await inventory({ roots: [root, missing], approvedRoots: roots });
  assert.equal(all.coverage.complete, false);
  assert.equal(all.coverage.gaps.length, 1);
  assert.equal(all.repositories.find((r) => r.root === realpathSync(root)).status, "observed");
});

test("shallow clone is reported explicitly without inferring complete history", async (t) => {
  const { root, parent, input } = fixture(t);
  assert.equal((await collect(input)).shallow, false);
  const shallowRoot = join(parent, "shallow");
  git(parent, "-c", "protocol.file.allow=always", "clone", "--depth", "1", pathToFileURL(root).href, shallowRoot);
  git(shallowRoot, "remote", "set-url", "origin", "https://github.com/example/app.git");
  const shallow = await collect({ root: shallowRoot, approvedRoots: [parent] });
  assert.equal(shallow.status, "observed");
  assert.equal(shallow.shallow, true);
  assert.equal(shallow.historyComplete, false);
  assert.equal(shallow.checkpointEligible, false);
});

test("provider evidence freshness is checked after final local revalidation", async (t) => {
  const { input } = fixture(t);
  let reads = 0;
  const result = await resolve(
    { ...input, expectedRepository: "example/app", expectedRepositoryId: 12345 },
    {
      now: () => (++reads === 1 ? now : now + 120001),
      providerLookup: provider(),
    },
  );
  assert.equal(result.verificationState, "unknown");
  assert.equal(result.providerVerified, false);
  assert.ok(result.reasons.includes("provider_observation_stale_or_invalid"));
});
