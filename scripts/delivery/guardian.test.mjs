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
import { fileURLToPath } from "node:url";

const modulePath = new URL("./guardian.mjs", import.meta.url);
const implementation = existsSync(modulePath) ? await import(modulePath.href) : {};
const git = (cwd, ...args) => {
  const r = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "delivery-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-b", "feat/task");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Test");
  writeFileSync(join(root, "base.txt"), "baseline\n");
  git(root, "add", "base.txt");
  git(root, "commit", "-m", "baseline");
  git(root, "remote", "add", "origin", "https://github.com/example/app.git");
  return root;
}
function observe(root) {
  assert.equal(typeof implementation.observe, "function", "read-only collector must exist");
  return implementation.observe(root, { remote: "origin" });
}

test("observe real Git without changing HEAD, index, config or work files", (t) => {
  const root = fixture(t);
  writeFileSync(join(root, "base.txt"), "changed\n");
  const before = [".git/index", ".git/config", "base.txt"].map((p) => readFileSync(join(root, p)));
  const head = git(root, "rev-parse", "HEAD").trim();
  const x = observe(root);
  assert.equal(x.repository, "example/app");
  assert.equal(x.head, head);
  assert.equal(x.branch, "feat/task");
  assert.equal(x.stable, true);
  assert.equal(x.remote.status, "not_requested");
  assert.equal(x.remote.head, null);
  assert.equal(x.deployment.status, "unknown");
  assert.deepEqual(x.errors, []);
  assert.ok(x.changes.some((c) => c.path === "base.txt" && c.worktree === "M"));
  for (const [i, p] of [".git/index", ".git/config", "base.txt"].entries())
    assert.deepEqual(readFileSync(join(root, p)), before[i]);
});
test("untracked names preserve Unicode, spaces, newline and shell metacharacters", (t) => {
  const root = fixture(t),
    names = ["中文 樂譜.txt", "new\nline.txt", "$(touch SHOULD-NOT-EXIST).txt", "--delete.txt"];
  for (const n of names) writeFileSync(join(root, n), "test");
  const x = observe(root);
  assert.deepEqual(x.changes.map((c) => c.path).sort(), names.sort());
  assert.equal(existsSync(join(root, "SHOULD-NOT-EXIST")), false);
});
test("rename includes old and new path, staged inventory does not lose either", (t) => {
  const root = fixture(t);
  git(root, "mv", "base.txt", "renamed 文本.txt");
  const x = observe(root);
  assert.ok(x.changes.some((c) => c.path === "renamed 文本.txt" && c.originalPath === "base.txt"));
  assert.ok(x.staged.includes("base.txt"));
  assert.ok(x.staged.includes("renamed 文本.txt"));
});
test("symlink to outside worktree is classified unsafe without reading its contents", (t) => {
  const root = fixture(t);
  symlinkSync("/etc/passwd", join(root, "external.txt"));
  const x = observe(root);
  assert.ok(x.changes.some((c) => c.path === "external.txt" && c.pathSafe === false && c.symlink === true));
});
test("tracked deletion is counted", (t) => {
  const root = fixture(t);
  rmSync(join(root, "base.txt"));
  assert.deepEqual(observe(root).deletedPaths, ["base.txt"]);
});
test("different push target is an error, never a safe snapshot", (t) => {
  const root = fixture(t);
  git(root, "remote", "set-url", "--push", "origin", "https://github.com/someone/else.git");
  const x = observe(root);
  assert.ok(x.errors.includes("push_remote_mismatch"));
});
test("missing remote remains unknown instead of guessing origin", (t) => {
  const root = fixture(t);
  git(root, "remote", "remove", "origin");
  const x = observe(root);
  assert.equal(x.repository, null);
  assert.ok(x.errors.includes("remote_unavailable"));
});
test("requesting a nested directory is rejected instead of silently choosing its parent", (t) => {
  const root = fixture(t);
  mkdirSync(join(root, "nested"));
  assert.throws(() => observe(join(root, "nested")), /repository root/i);
});
test("CLI cannot commit, merge, reset or deploy", (t) => {
  const root = fixture(t);
  assert.ok(existsSync(modulePath), "collector module must exist");
  const before = git(root, "rev-parse", "HEAD");
  const r = spawnSync(process.execPath, [fileURLToPath(modulePath), "deploy", "--root", root], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.equal(git(root, "rev-parse", "HEAD"), before);
});
test("malformed status record is an error rather than silently ignored", () => {
  assert.equal(typeof implementation.parseStatus, "function");
  assert.throws(() => implementation.parseStatus("M\0"), /status/i);
});
test("report labels remote/deployment unknown and safely escapes HTML-like names", (t) => {
  const root = fixture(t);
  writeFileSync(join(root, "<script>.txt"), "x");
  const x = observe(root);
  assert.equal(typeof implementation.founderSummary, "function");
  const text = implementation.founderSummary(x);
  assert.match(text, /未核實/);
  assert.doesNotMatch(text, /已上線/);
  assert.ok(text.includes(x.head.slice(0, 9)));
});

test("text output keeps a failing observation exit code", (t) => {
  const root = fixture(t);
  git(root, "remote", "remove", "origin");
  const r = spawnSync(process.execPath, [fileURLToPath(modulePath), "observe", "--root", root, "--text"], {
    encoding: "utf8",
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /remote_unavailable/);
});

test("network observation reads a provider callback, never repo Git transport or credential helpers", (t) => {
  const root = fixture(t),
    binary = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
  const marker = join(root, "transport-ran"),
    bin = join(root, "test-bin");
  mkdirSync(bin);
  // Any old ls-remote path is caught locally; this test cannot contact GitHub.
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh\nfor arg in "$@"; do\nif [ "$arg" = "ls-remote" ]; then\nprintf called > '${marker}'\nexit 1\nfi\ndone\nexec '${binary}' "$@"\n`,
    { mode: 0o755 },
  );
  const old = process.env.PATH;
  process.env.PATH = `${bin}:${old}`;
  t.after(() => {
    process.env.PATH = old;
  });
  let calls = 0;
  const head = git(root, "rev-parse", "HEAD").trim();
  const o = implementation.observe(root, {
    network: true,
    providerRefLookup: ({ repository, branch }) => {
      calls++;
      assert.equal(repository, "example/app");
      assert.equal(branch, "feat/task");
      return { sha: head, observedAt: new Date().toISOString(), source: "github_api" };
    },
  });
  assert.equal(calls, 1);
  assert.equal(existsSync(marker), false);
  assert.equal(o.remote.status, "matches");
});

test("provider observation cannot stay stable after same-HEAD branch or remote drift", (t) => {
  const root = fixture(t),
    head = git(root, "rev-parse", "HEAD").trim();
  const o = implementation.observe(root, {
    network: true,
    providerRefLookup: () => {
      git(root, "branch", "-m", "feat/other");
      git(root, "remote", "set-url", "origin", "https://github.com/example/other.git");
      return { sha: head, observedAt: new Date().toISOString(), source: "github_api" };
    },
  });
  assert.equal(o.stable, false);
});

test("provider callback data is fresh and from the expected API", (t) => {
  const root = fixture(t),
    head = git(root, "rev-parse", "HEAD").trim();
  const o = implementation.observe(root, {
    network: true,
    providerRefLookup: () => ({ sha: head, observedAt: "2000-01-01T00:00:00Z", source: "agent_receipt" }),
  });
  assert.equal(o.remote.status, "unknown");
  assert.ok(o.errors.includes("remote_observation_failed"));
});

test("GitHub provider read uses built-in gh API and never shell or repository transport", () => {
  assert.equal(typeof implementation.collectProviderRef, "function");
  const seen = [],
    sha = "a".repeat(40);
  const r = implementation.collectProviderRef(
    { repository: "example/app", branch: "feat/task" },
    {
      run: (exe, args, options) => {
        seen.push({ exe, args, options });
        return { status: 0, stdout: JSON.stringify({ object: { type: "commit", sha } }) };
      },
    },
  );
  assert.equal(r.sha, sha);
  assert.equal(seen[0].exe, "gh");
  assert.ok(seen[0].args.includes("repos/example/app/git/ref/heads/feat%2Ftask"));
  assert.equal(seen[0].options.shell, false);
});

test("inherited Git environment cannot retarget the selected repository or its worktree", (t) => {
  const selected = fixture(t),
    redirected = fixture(t);
  git(redirected, "remote", "set-url", "origin", "https://github.com/example/redirected.git");
  git(redirected, "branch", "-m", "feat/redirected");
  writeFileSync(join(redirected, "base.txt"), "a different repository\n");
  git(redirected, "add", "base.txt");
  git(redirected, "commit", "-m", "different repository identity");
  const head = git(selected, "rev-parse", "HEAD").trim();
  const old = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
  t.after(() => {
    for (const [name, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  process.env.GIT_DIR = join(redirected, ".git");
  process.env.GIT_WORK_TREE = selected;
  const result = observe(selected);
  assert.equal(result.repository, "example/app", "the chosen root must not borrow another repository's Git directory");
  assert.equal(result.head, head);
  assert.equal(result.branch, "feat/task");
  assert.equal(result.worktree, realpathSync(selected));
  assert.equal(result.stable, true);
  assert.deepEqual(result.errors, []);
});

test("CLI rejects FIFO input without waiting for a writer", (t) => {
  const root = mkdtempSync(join(tmpdir(), "delivery-fifo-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const inputPath = join(root, "input.json");
  const made = spawnSync("mkfifo", [inputPath], { encoding: "utf8", shell: false });
  assert.equal(made.status, 0, made.stderr);
  // No writer exists. A blocking read would hang until this test's child timeout.
  const r = spawnSync(process.execPath, [fileURLToPath(modulePath), "inspect-macos", "--input", inputPath], {
    encoding: "utf8",
    shell: false,
    timeout: 2_000,
    killSignal: "SIGKILL",
  });
  assert.equal(r.status, 2, "non-regular JSON input must be rejected before attempting a blocking read");
  assert.equal(r.signal, null);
  assert.equal(r.stdout, "");
});

test("CLI bounds JSON bytes for input, release evidence and checkpoint scope", (t) => {
  const root = fixture(t),
    inputPath = join(root, "oversized.json");
  writeFileSync(inputPath, JSON.stringify({ padding: "x".repeat(128 * 1024) }));
  const calls = [
    ["inspect-macos", "--input", inputPath],
    ["check-release", "--evidence", inputPath],
    ["check-checkpoint", "--root", root, "--scope", inputPath],
  ];
  for (const args of calls) {
    const r = spawnSync(process.execPath, [fileURLToPath(modulePath), ...args], {
      encoding: "utf8",
      shell: false,
      timeout: 5_000,
    });
    assert.equal(r.status, 2, `${args[0]} must reject oversized JSON before evaluating it`);
    assert.equal(r.stdout, "");
  }
});

test("CLI malformed JSON errors never echo input payloads", (t) => {
  const root = fixture(t),
    inputPath = join(root, "malformed.json");
  // A synthetic marker, not a credential: native parser messages must not echo it.
  writeFileSync(inputPath, "SECRET_TEST_CANARY_no_real_secret\n");
  const calls = [
    ["inspect-macos", "--input", inputPath],
    ["check-release", "--evidence", inputPath],
    ["check-checkpoint", "--root", root, "--scope", inputPath],
  ];
  for (const args of calls) {
    const r = spawnSync(process.execPath, [fileURLToPath(modulePath), ...args], {
      encoding: "utf8",
      shell: false,
      timeout: 5_000,
    });
    assert.equal(r.status, 2, `${args[0]} must report invalid input`);
    assert.equal(r.stdout, "");
    assert.doesNotMatch(r.stderr, /SECRET_|CANARY|no_real_secret/, "input payloads must not appear in error output");
  }
});
