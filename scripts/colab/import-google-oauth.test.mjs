import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { importGoogleOAuth } from "./import-google-oauth.mjs";

const publicUrl = "https://chat.example.com";
const callback = `${publicUrl}/api/app/connectors/oauth/callback`;
const web = {
  client_id: "123-fixture.apps.googleusercontent.com",
  // Built from parts so secret scanners see no credential-shaped literal; it is a synthetic test value.
  client_secret: ["GOCSPX", "fixture_secret_12345678"].join("-"),
  redirect_uris: [callback],
};

function fixture(fn, env = `PUBLIC_URL=${publicUrl}\nOTHER_SETTING=keep-me\n`) {
  const dir = mkdtempSync(join(tmpdir(), "agentes-colab-import-test-"));
  const envPath = join(dir, ".env");
  const oauthJsonPath = join(dir, "oauth.json");
  writeFileSync(envPath, env, { mode: 0o644 });
  writeFileSync(oauthJsonPath, JSON.stringify({ web }));
  try {
    fn({ dir, envPath, oauthJsonPath, publicUrl });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("imports only the two Colab keys, preserves every other line, and protects the result", () => {
  const original = `# Settings\r\nPUBLIC_URL="${publicUrl}"\r\nOTHER_SETTING='keep # this'\r\nMULTILINE="first\r\nsecond"\r\n`;
  fixture((f) => {
    assert.deepEqual(importGoogleOAuth(f), { checked: true, changed: true });
    const result = readFileSync(f.envPath, "utf8");
    assert.equal(
      result,
      `${original}CONNECTOR_COLAB_CLIENT_ID=${web.client_id}\r\nCONNECTOR_COLAB_CLIENT_SECRET=${web.client_secret}\r\n`,
    );
    assert.equal(statSync(f.envPath).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(f.dir).sort(), [".env", "oauth.json"]);
    assert.deepEqual(importGoogleOAuth(f), { checked: true, changed: false });
    assert.equal(readFileSync(f.envPath, "utf8"), result);
  }, original);
});

test("replaces duplicate Colab assignments without changing other settings", () => {
  fixture((f) => {
    importGoogleOAuth(f);
    assert.equal(
      readFileSync(f.envPath, "utf8"),
      `PUBLIC_URL=${publicUrl}\nKEEP=one\nKEEP_TWO=two\nCONNECTOR_COLAB_CLIENT_ID=${web.client_id}\nCONNECTOR_COLAB_CLIENT_SECRET=${web.client_secret}\n`,
    );
  }, `PUBLIC_URL=${publicUrl}\nCONNECTOR_COLAB_CLIENT_ID=old\nKEEP=one\nexport CONNECTOR_COLAB_CLIENT_SECRET='old-secret'\nCONNECTOR_COLAB_CLIENT_ID=duplicate\nKEEP_TWO=two\n`);
});

test("check mode validates without changing the file or its mode", () => {
  fixture((f) => {
    const before = readFileSync(f.envPath);
    assert.deepEqual(importGoogleOAuth({ ...f, check: true }), { checked: true, changed: false });
    assert.deepEqual(readFileSync(f.envPath), before);
    assert.equal(statSync(f.envPath).mode & 0o777, 0o644);
  });
});

test("wrong callback, Desktop client, newline secret and mismatched PUBLIC_URL leave config untouched", () => {
  fixture((f) => {
    const before = readFileSync(f.envPath);
    for (const bad of [
      { web: { ...web, redirect_uris: ["https://other.example.com/callback"] } },
      { installed: web },
      { web: { ...web, client_secret: "unsafe\nOTHER_SETTING=changed" } },
    ]) {
      writeFileSync(f.oauthJsonPath, JSON.stringify(bad));
      assert.throws(() => importGoogleOAuth(f));
      assert.deepEqual(readFileSync(f.envPath), before);
    }
    writeFileSync(f.oauthJsonPath, JSON.stringify({ web }));
    assert.throws(() => importGoogleOAuth({ ...f, publicUrl: "http://public.example.com" }), /HTTPS/);
    writeFileSync(f.envPath, "PUBLIC_URL=https://different.example.com\n");
    assert.throws(() => importGoogleOAuth(f), /does not match/);
    assert.equal(readFileSync(f.envPath, "utf8"), "PUBLIC_URL=https://different.example.com\n");
    assert.deepEqual(readdirSync(f.dir).sort(), [".env", "oauth.json"]);
  });
});

test("multiline existing Colab values and symlink targets are refused", () => {
  fixture((f) => {
    writeFileSync(f.envPath, `PUBLIC_URL=${publicUrl}\nCONNECTOR_COLAB_CLIENT_SECRET="first\nsecond"\n`);
    const before = readFileSync(f.envPath);
    assert.throws(() => importGoogleOAuth(f), /single-line/);
    assert.deepEqual(readFileSync(f.envPath), before);
    const link = join(f.dir, "linked.env");
    symlinkSync(f.envPath, link);
    assert.throws(() => importGoogleOAuth({ ...f, envPath: link }));
    assert.deepEqual(readFileSync(f.envPath), before);
    assert.equal(
      readdirSync(f.dir).some((name) => name.endsWith(".lock") || name.endsWith(".tmp")),
      false,
    );
  });
});

test("CLI never echoes a downloaded secret, including malformed JSON errors", () => {
  fixture((f) => {
    const script = fileURLToPath(new URL("./import-google-oauth.mjs", import.meta.url));
    const args = [script, "--oauth-json", f.oauthJsonPath, "--env-file", f.envPath, "--public-url", publicUrl];
    const success = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(success.status, 0);
    assert.match(success.stdout, /settings updated/);
    assert.equal((success.stdout + success.stderr).includes(web.client_secret), false);
    writeFileSync(f.oauthJsonPath, `{"web":{"client_secret":"${web.client_secret}" BROKEN}`);
    const failure = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(failure.status, 1);
    assert.match(failure.stderr, /valid OAuth JSON/);
    assert.equal((failure.stdout + failure.stderr).includes(web.client_secret), false);
  });
});

test("assignment-looking lines inside unrelated multiline values stay literal", () => {
  const original = `PUBLIC_URL=${publicUrl}\nOTHER="first\nCONNECTOR_COLAB_CLIENT_ID=literal\nPUBLIC_URL=https://embedded.example.com\nCONNECTOR_COLAB_CLIENT_SECRET=literal\nlast"\nKEEP=yes\n`;
  fixture((f) => {
    importGoogleOAuth(f);
    assert.equal(
      readFileSync(f.envPath, "utf8"),
      `${original}CONNECTOR_COLAB_CLIENT_ID=${web.client_id}\nCONNECTOR_COLAB_CLIENT_SECRET=${web.client_secret}\n`,
    );
  }, original);
});
