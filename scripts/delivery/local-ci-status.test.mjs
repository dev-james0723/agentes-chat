import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { STEPS } from "./local-ci.mjs";
import { assertPublisherConfiguration, signReceipt, statusPayload, verifyAttestation } from "./local-ci-status.mjs";

const sha = "a".repeat(40),
  wrong = "b".repeat(40);
const keys = generateKeyPairSync("ed25519");
const now = "2026-11-16T23:00:00Z";
const full = () => ({
  schema: "local-ci-release/v1",
  repo: "dev-james0723/agentes-chat",
  head: sha,
  mode: "full",
  startedAt: now,
  finishedAt: now,
  sourceVerified: true,
  review: { sha, independent: true, result: "approved" },
  steps: Object.keys(STEPS).map((id) => ({
    id,
    exitCode: 0,
    state: "passed",
    logSha256: "d".repeat(64),
    timedOut: false,
  })),
});
const sign = (receipt = full()) => signReceipt(receipt, keys.privateKey);
function verify(envelope, overrides = {}) {
  return verifyAttestation(envelope, keys.publicKey, {
    now: Date.parse(now),
    repository: "dev-james0723/agentes-chat",
    head: sha,
    ...overrides,
  });
}
test("signature of a complete exact-SHA release is verifiable, but is not itself deployment proof", () => {
  const envelope = sign();
  const result = verify(envelope);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.deployed, false);
  assert.equal(result.eligibleForStatus, true);
});
test("tampering with a passed test turns signature invalid", () => {
  const env = sign();
  env.receipt.steps[0].exitCode = 1;
  const x = verify(env);
  assert.equal(x.ok, false);
  assert.ok(x.blockers.includes("signature_invalid"));
});
test("missing signature and untrusted key fail closed", () => {
  const env = sign();
  assert.equal(verify({ receipt: env.receipt, signature: "" }).ok, false);
  assert.equal(
    verifyAttestation(env, generateKeyPairSync("ed25519").publicKey, {
      now: Date.parse(now),
      repository: env.receipt.repo,
      head: sha,
    }).ok,
    false,
  );
});
test("wrong branch head or repository does not pass", () => {
  const env = sign();
  assert.ok(verify(env, { head: wrong }).blockers.includes("head_mismatch"));
  assert.ok(verify(env, { repository: "other/repo" }).blockers.includes("repository_mismatch"));
});
test("stale or future attestations are refused", () => {
  const env = sign();
  assert.ok(verify(env, { now: Date.parse("2026-11-17T00:00:00Z") }).blockers.includes("stale_receipt"));
  assert.ok(verify(env, { now: Date.parse("2026-11-16T20:00:00Z") }).blockers.includes("invalid_receipt_time"));
});
test("a partial suite or failed test cannot get a success status", () => {
  const a = full();
  a.steps.pop();
  assert.ok(verify(sign(a)).blockers.includes("incomplete_suite"));
  const b = full();
  b.steps[0].exitCode = 1;
  assert.ok(verify(sign(b)).blockers.includes("failed_suite"));
});
test("signed record without independent review remains blocked", () => {
  const a = full();
  a.review.independent = false;
  assert.ok(verify(sign(a)).blockers.includes("review_unverified"));
});
test("signature does not forgive nonexistent log hashes or unknown test IDs", () => {
  const a = full();
  a.steps[0].logSha256 = "";
  assert.ok(verify(sign(a)).blockers.includes("invalid_step_evidence"));
  const b = full();
  b.steps.push({ id: "fake", exitCode: 0, state: "passed", logSha256: "f".repeat(64) });
  assert.ok(verify(sign(b)).blockers.includes("invalid_step_evidence"));
});
test("status payload is precise, commit scoped and bounded", () => {
  const env = sign();
  const x = statusPayload(env, {
    publicKey: keys.publicKey,
    now: Date.parse(now),
    repository: env.receipt.repo,
    head: sha,
  });
  assert.equal(x.state, "success");
  assert.equal(x.context, "local-ci/full");
  assert.ok(x.description.length <= 140);
  assert.equal(x.sha, sha);
  assert.equal(x.repository, env.receipt.repo);
});
test("status payload refuses forged or partial receipts", () => {
  const env = sign();
  env.receipt.steps.pop();
  assert.throws(
    () =>
      statusPayload(env, { publicKey: keys.publicKey, now: Date.parse(now), repository: env.receipt.repo, head: sha }),
    /not_verified/,
  );
});
test("success publisher requires dedicated GitHub App identity, never a user token", () => {
  assert.throws(
    () => assertPublisherConfiguration({ authMode: "gh_cli", token: "gh_user_token", appId: 1, installationId: 2 }),
    /app_required/,
  );
  assert.throws(
    () => assertPublisherConfiguration({ authMode: "github_app", appId: null, installationId: 2 }),
    /app_required/,
  );
  const r = assertPublisherConfiguration({
    authMode: "github_app",
    appId: 12345,
    installationId: 23456,
    privateKeyPath: "/private/app-key.pem",
  });
  assert.equal(r.appId, 12345);
});
