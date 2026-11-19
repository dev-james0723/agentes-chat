import { expect, test } from "bun:test";
import { inSourceScope as guardianScope, revisionIdentity } from "../../../scripts/delivery/runtime-identity.mjs";
import { gitSourceEntries, inSourceScope, repoRoot, sourceIdentityOf } from "../src/source-identity";

// The Delivery Guardian's copy of the identity (plain Node, no dependencies) must say what the server says, or a
// deploy check would report a mismatch that isn't there, or a match that isn't.

test("the Guardian's scope is the server's, for every path in this repository", () => {
  const r = Bun.spawnSync(["git", "-C", repoRoot, "ls-files", "-z"], { stdout: "pipe" });
  const paths = r.stdout.toString().split("\0").filter(Boolean);
  expect(paths.length).toBeGreaterThan(1000);
  const differ = paths.filter((p) => guardianScope(p) !== inSourceScope(p));
  expect(differ).toEqual([]);
});

test("the Guardian's identity of a revision is the server's", () => {
  for (const revision of ["HEAD", "HEAD~1"]) {
    expect(revisionIdentity(repoRoot, revision)).toEqual(sourceIdentityOf(gitSourceEntries(repoRoot, revision)));
  }
});
