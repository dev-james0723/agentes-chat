import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertStepTable, FULL_STEPS, runFull, verifySource } from "./local-ci-full.mjs";
import { REQUIRED_RELEASE_STEPS } from "./local-ci-status.mjs";

const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();

function repo() {
  const base = mkdtempSync(join(tmpdir(), "local-ci-full-"));
  const remote = join(base, "remote.git");
  const work = join(base, "work");
  git(base, "init", "-q", "--bare", remote);
  git(base, "clone", "-q", remote, work);
  writeFileSync(join(work, "a.txt"), "a\n");
  git(work, "add", ".");
  git(work, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "a");
  git(work, "push", "-q", "origin", "HEAD:refs/heads/candidate");
  return { base, work, sha: git(work, "rev-parse", "HEAD") };
}

test("the step table is exactly the release contract's 22 steps, in its order", () => {
  assertStepTable();
  assert.deepEqual(Object.keys(FULL_STEPS), [...REQUIRED_RELEASE_STEPS]);
});

test("a clean candidate at the remote branch's commit is verified", async () => {
  const { work, sha } = repo();
  assert.deepEqual(await verifySource({ root: work, sha, remote: "origin", branch: "candidate" }), {
    ok: true,
    blockers: [],
  });
});

test("another commit, an edited tree or a moved remote branch is not the candidate", async () => {
  const { work, sha } = repo();
  const other = "0".repeat(40);
  assert.ok(
    (await verifySource({ root: work, sha: other, remote: "origin", branch: "candidate" })).blockers.includes(
      "head_mismatch",
    ),
  );
  writeFileSync(join(work, "a.txt"), "changed\n");
  assert.ok(
    (await verifySource({ root: work, sha, remote: "origin", branch: "candidate" })).blockers.includes(
      "dirty_workspace",
    ),
  );
  git(work, "checkout", "-q", "--", "a.txt");
  writeFileSync(join(work, "b.txt"), "b\n");
  git(work, "add", ".");
  git(work, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "b");
  git(work, "push", "-q", "origin", "HEAD:refs/heads/candidate");
  git(work, "checkout", "-q", sha);
  assert.ok(
    (await verifySource({ root: work, sha, remote: "origin", branch: "candidate" })).blockers.includes(
      "remote_branch_not_at_sha",
    ),
  );
});

test("an unverified source runs no step and says why", async () => {
  const { work, base } = repo();
  const out = join(base, "evidence");
  const r = await runFull({
    root: work,
    sha: "1".repeat(40),
    repository: "o/r",
    remote: "origin",
    branch: "candidate",
    out,
  });
  assert.equal(r.sourceVerified, false);
  assert.equal(r.blocked, "source_unverified");
  assert.deepEqual(r.steps, []);
  assert.equal(JSON.parse(readFileSync(join(out, "receipt.json"), "utf8")).blocked, "source_unverified");
});

test("a step's failure is recorded as failed with its exit code and log hash, and a partial run is never full", async () => {
  const { work, base, sha } = repo();
  const out = join(base, "evidence");
  // `shellcheck` on a tree without those scripts exits non-zero: a real failing step.
  const r = await runFull({
    root: work,
    sha,
    repository: "o/r",
    remote: "origin",
    branch: "candidate",
    out,
    only: ["shellcheck"],
  });
  assert.equal(r.mode, "partial");
  assert.equal(r.steps.length, 1);
  assert.equal(r.steps[0].id, "shellcheck");
  assert.equal(r.steps[0].state, "failed");
  assert.notEqual(r.steps[0].exitCode, 0);
  assert.match(r.steps[0].logSha256, /^[a-f0-9]{64}$/);
});

test("review, sign and verify: only a complete, passed, reviewed, signed receipt for its own head verifies", async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const { attachReview } = await import("./local-ci-attest.mjs");
  const { signReceipt, verifyAttestation } = await import("./local-ci-status.mjs");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const now = Date.now();
  const head = "a".repeat(40);
  const receipt = {
    schema: "local-ci-release/v1",
    mode: "full",
    repo: "o/r",
    head,
    sourceVerified: true,
    startedAt: new Date(now - 60_000).toISOString(),
    finishedAt: new Date(now - 1_000).toISOString(),
    steps: REQUIRED_RELEASE_STEPS.map((id) => ({
      id,
      exitCode: 0,
      state: "passed",
      timedOut: false,
      logSha256: "b".repeat(64),
    })),
  };
  const reviewed = attachReview(receipt, {
    reviewer: "independent-agent",
    result: "approved",
    evidenceSha256: "c".repeat(64),
  });
  const ok = verifyAttestation(signReceipt(reviewed, privateKey), publicKey, { now, repository: "o/r", head });
  assert.equal(ok.ok, true, ok.blockers.join());
  // Negative controls: no review, one failed step, another head, a receipt edited after signing.
  assert.ok(
    verifyAttestation(signReceipt(receipt, privateKey), publicKey, { now, repository: "o/r", head }).blockers.includes(
      "review_unverified",
    ),
  );
  const failed = {
    ...reviewed,
    steps: reviewed.steps.map((s, i) => (i === 3 ? { ...s, exitCode: 1, state: "failed" } : s)),
  };
  assert.ok(
    verifyAttestation(signReceipt(failed, privateKey), publicKey, { now, repository: "o/r", head }).blockers.includes(
      "failed_suite",
    ),
  );
  assert.ok(
    verifyAttestation(signReceipt(reviewed, privateKey), publicKey, {
      now,
      repository: "o/r",
      head: "d".repeat(40),
    }).blockers.includes("head_mismatch"),
  );
  const env = signReceipt(reviewed, privateKey);
  env.receipt.steps[0].exitCode = 0;
  env.receipt.mode = "full ";
  assert.ok(verifyAttestation(env, publicKey, { now, repository: "o/r", head }).blockers.includes("signature_invalid"));
  assert.throws(
    () => attachReview(receipt, { reviewer: "x", result: "lgtm", evidenceSha256: "c".repeat(64) }),
    /invalid_review_result/,
  );
});

test("leftover ignored files make a candidate not fresh, so the run does not start", async () => {
  const { work, sha } = repo();
  writeFileSync(join(work, ".gitignore"), "dist/\n");
  git(work, "add", ".");
  git(work, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "ignore");
  git(work, "push", "-q", "origin", "HEAD:refs/heads/candidate");
  const head = git(work, "rev-parse", "HEAD");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(work, "dist"));
  writeFileSync(join(work, "dist", "old.js"), "stale");
  const v = await verifySource({ root: work, sha: head, remote: "origin", branch: "candidate", fresh: true });
  assert.ok(v.blockers.includes("not_fresh_checkout"));
  assert.equal((await verifySource({ root: work, sha: head, remote: "origin", branch: "candidate" })).ok, true);
  assert.notEqual(sha, head);
});

test("a review counts only when its file names this exact head and a result", async () => {
  const { reviewFromFile } = await import("./local-ci-attest.mjs");
  const head = "a".repeat(40);
  assert.equal(reviewFromFile(`reviewer notes\nhead: ${head}\nresult: approved\n`, head), "approved");
  assert.throws(
    () => reviewFromFile(`head: ${"b".repeat(40)}\nresult: approved\n`, head),
    /review_does_not_name_this_head/,
  );
  assert.throws(() => reviewFromFile(`head: ${head}\nlooks good\n`, head), /review_result_missing/);
  assert.throws(() => reviewFromFile(`head: .*\nresult: approved\n`, ".*"), /invalid_head/);
});

test("signing rechecks every step log against its hash", async () => {
  const { checkLogs } = await import("./local-ci-attest.mjs");
  const { createHash } = await import("node:crypto");
  const dir = mkdtempSync(join(tmpdir(), "local-ci-logs-"));
  writeFileSync(join(dir, "lint.log"), "ok\n");
  const good = createHash("sha256").update("ok\n").digest("hex");
  const receipt = { mode: "full", sourceVerified: true, steps: [{ id: "lint", logSha256: good }] };
  checkLogs(receipt, dir);
  writeFileSync(join(dir, "lint.log"), "edited\n");
  assert.throws(() => checkLogs(receipt, dir), /log_hash_mismatch:lint/);
  assert.throws(() => checkLogs({ ...receipt, mode: "partial" }, dir), /receipt_not_full/);
});

test("the publisher takes the signer's key from its own config only", async () => {
  const { pinnedPublicKey } = await import("./local-ci-attest.mjs");
  const { generateKeyPairSync } = await import("node:crypto");
  const dir = mkdtempSync(join(tmpdir(), "local-ci-pin-"));
  const { publicKey } = generateKeyPairSync("ed25519");
  const path = join(dir, "signer.pub.pem");
  writeFileSync(path, publicKey.export({ type: "spki", format: "pem" }), { mode: 0o600 });
  assert.equal(pinnedPublicKey({ signerPublicKeyPath: path }).asymmetricKeyType, "ed25519");
  assert.throws(() => pinnedPublicKey({}), /signer_public_key_not_pinned/);
  const { chmodSync } = await import("node:fs");
  chmodSync(path, 0o644);
  assert.throws(() => pinnedPublicKey({ signerPublicKeyPath: path }), /key_file_permissions_unsafe/);
});
