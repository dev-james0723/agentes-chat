import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inSourceScope as guardianScope, revisionIdentity } from "../../../scripts/delivery/runtime-identity.mjs";
import { gitSourceEntries, inSourceScope, repoRoot, scanSourceTree, sourceIdentityOf } from "../src/source-identity";

// The Delivery Guardian's copy of the identity (plain Node, no dependencies) must say what the server says, or a
// deploy check would report a mismatch that isn't there, or a match that isn't. The server reports what it scans on
// its own disk (`scanSourceTree`), so that is what the Guardian's identity of the same commit is compared with.

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const git = (root: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString();
};

test("the Guardian's scope is the server's, for every path in this repository", () => {
  const paths = git(repoRoot, "ls-files", "-z").split("\0").filter(Boolean);
  expect(paths.length).toBeGreaterThan(1000);
  expect(paths.filter((p) => guardianScope(p) !== inSourceScope(p))).toEqual([]);
});

test("what the server scans on disk is the Guardian's identity of the commit checked out there", () => {
  const root = mkdtempSync(join(tmpdir(), "identity-parity-"));
  dirs.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "t");
  const files: Record<string, string> = {
    "package.json": "{}\n",
    "bun.lock": "lock\n",
    "apps/server/package.json": "{}\n",
    "apps/server/src/app.ts": "export {}\n",
    "apps/server/runner/bin.sh": "#!/bin/sh\n",
    "apps/server/src/line\nbreak.ts": "odd but legal\n",
    "packages/db/migrations/0001_a.sql": "select 1;\n",
    "apps/server/test/app.test.ts": "out of scope\n",
    "README.md": "out of scope\n",
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, dirname(path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  chmodSync(join(root, "apps/server/runner/bin.sh"), 0o755);
  // A symlink is neither side's file; an ignored build output in scope is on disk but not in the commit.
  symlinkSync("app.ts", join(root, "apps/server/src/alias.ts"));
  writeFileSync(join(root, ".gitignore"), "apps/server/src/generated.ts\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  const { commit, ...guardian } = revisionIdentity(root, "HEAD");
  expect(commit).toBe(git(root, "rev-parse", "HEAD").trim());
  expect(guardian).toEqual(sourceIdentityOf(scanSourceTree(root)));
  expect(guardian).toEqual(sourceIdentityOf(gitSourceEntries(root, "HEAD")));
  // An untracked file in scope is on disk only: the server would report it, so the two must differ.
  writeFileSync(join(root, "apps/server/src/generated.ts"), "built here\n");
  expect(guardian).not.toEqual(sourceIdentityOf(scanSourceTree(root)));
});

test("the Guardian's identity of this repository's commits is the server's", () => {
  const revisions = ["HEAD"];
  if (Bun.spawnSync(["git", "-C", repoRoot, "rev-parse", "--verify", "--quiet", "HEAD~1"]).exitCode === 0)
    revisions.push("HEAD~1");
  for (const revision of revisions) {
    const { commit: _, ...guardian } = revisionIdentity(repoRoot, revision);
    expect(guardian).toEqual(sourceIdentityOf(gitSourceEntries(repoRoot, revision)));
  }
});
