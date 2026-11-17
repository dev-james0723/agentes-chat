import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { STEPS } from "./local-ci.mjs";
import { publishAttestedStatus, signReceipt } from "./local-ci-status.mjs";

const sha = "a".repeat(40),
  time = "2026-11-16T23:00:00Z",
  repo = "dev-james0723/agentes-chat";
function setup(t) {
  const home = mkdtempSync(join(tmpdir(), "local-ci-app-test-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const app = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const path = join(home, "app.pem");
  writeFileSync(path, app.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const signer = generateKeyPairSync("ed25519");
  const receipt = {
    schema: "local-ci-release/v1",
    repo,
    head: sha,
    mode: "full",
    sourceVerified: true,
    startedAt: time,
    finishedAt: time,
    review: { sha, independent: true, result: "approved" },
    steps: Object.keys(STEPS).map((id) => ({
      id,
      exitCode: 0,
      state: "passed",
      logSha256: "b".repeat(64),
      timedOut: false,
    })),
  };
  return {
    config: { authMode: "github_app", appId: 123, installationId: 456, privateKeyPath: path },
    envelope: signReceipt(receipt, signer.privateKey),
    publicKey: signer.publicKey,
    path,
  };
}
test("GitHub App flow obtains scoped token, verifies branch head and posts exactly one success", async (t) => {
  const s = setup(t);
  const old = globalThis.fetch;
  const requests = [];
  t.after(() => (globalThis.fetch = old));
  globalThis.fetch = async (url, opts) => {
    requests.push({
      url,
      method: opts.method || "GET",
      headers: opts.headers,
      body: opts.body ? JSON.parse(opts.body) : null,
    });
    if (String(url).includes("/access_tokens"))
      return { ok: true, json: async () => ({ token: "INSTALL_ONLY_TOKEN", permissions: { statuses: "write" } }) };
    if (String(url).includes("/git/ref/")) return { ok: true, json: async () => ({ object: { sha } }) };
    if (String(url).includes("/statuses/")) return { ok: true, json: async () => ({ id: 234, state: "success" }) };
    throw Error("unexpected transport");
  };
  const result = await publishAttestedStatus(s.envelope, {
    publicKey: s.publicKey,
    now: Date.parse(time),
    repository: repo,
    head: sha,
    branch: "feat/ci-tests",
    config: s.config,
  });
  assert.deepEqual(
    { id: result.id, state: result.state, appId: result.appId },
    { id: 234, state: "success", appId: 123 },
  );
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[0].body, { repositories: ["agentes-chat"], permissions: { statuses: "write" } });
  assert.equal(requests[1].method, "GET");
  assert.equal(requests[2].body.context, "local-ci/full");
  assert.equal(requests[2].body.state, "success");
  assert.equal(requests[2].headers.Authorization, "Bearer INSTALL_ONLY_TOKEN");
});
test("moved remote SHA blocks a successful status POST", async (t) => {
  const s = setup(t),
    old = globalThis.fetch;
  let writes = 0;
  t.after(() => (globalThis.fetch = old));
  globalThis.fetch = async (url, _opts) => {
    if (String(url).includes("/access_tokens"))
      return { ok: true, json: async () => ({ token: "INSTALL_ONLY_TOKEN", permissions: { statuses: "write" } }) };
    if (String(url).includes("/git/ref/")) return { ok: true, json: async () => ({ object: { sha: "b".repeat(40) } }) };
    writes++;
    return { ok: true, json: async () => ({ id: 5 }) };
  };
  await assert.rejects(
    () =>
      publishAttestedStatus(s.envelope, {
        publicKey: s.publicKey,
        now: Date.parse(time),
        repository: repo,
        head: sha,
        branch: "feat/ci-tests",
        config: s.config,
      }),
    /remote_head_moved/,
  );
  assert.equal(writes, 0);
});
test("world-readable GitHub App key blocks status publishing before network", async (t) => {
  const s = setup(t);
  chmodSync(s.path, 0o644);
  const old = globalThis.fetch;
  t.after(() => (globalThis.fetch = old));
  globalThis.fetch = async () => {
    throw Error("should_not_contact_network");
  };
  await assert.rejects(
    () =>
      publishAttestedStatus(s.envelope, {
        publicKey: s.publicKey,
        now: Date.parse(time),
        repository: repo,
        head: sha,
        branch: "feat/ci-tests",
        config: s.config,
      }),
    /app_key_permissions_unsafe/,
  );
});
