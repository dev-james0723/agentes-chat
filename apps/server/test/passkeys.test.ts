import { afterEach, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { eq, schema } from "@agenteschat/db";
import { enableOperatorEvents } from "@agenteschat/engine";
import { FRESH_SIGN_IN_MS } from "../src/desktop-sign-in";
import { passkeyConfiguration } from "../src/passkeys";
import { type Browser, browser, createTestServer, ORIGIN, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(async () => {
  const current = t;
  t = undefined as unknown as TestServer;
  await current?.close();
});

const OPTIONS = "/api/auth/passkey/generate-register-options";
const REGISTER = "/api/auth/passkey/verify-registration";
const AUTH_OPTIONS = "/api/auth/passkey/generate-authenticate-options";
const AUTHENTICATE = "/api/auth/passkey/verify-authentication";
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest();
const base64 = (data: Buffer) => data.toString("base64url");

type RegistrationOptions = {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  authenticatorSelection: { residentKey: string; userVerification: string };
};
type AuthenticationOptions = {
  challenge: string;
  rpId: string;
  userVerification: string;
  allowCredentials?: unknown[];
};

/** Minimal definite-length CBOR for the real WebAuthn attestation and COSE public key in these tests. */
function cbor(value: number | string | Buffer | Map<number | string, unknown>): Buffer {
  const head = (major: number, length: number) => {
    if (length < 24) return Buffer.from([(major << 5) | length]);
    if (length < 256) return Buffer.from([(major << 5) | 24, length]);
    const bytes = Buffer.alloc(3);
    bytes[0] = (major << 5) | 25;
    bytes.writeUInt16BE(length, 1);
    return bytes;
  };
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)]);
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  return Buffer.concat([
    head(5, value.size),
    ...Array.from(value).flatMap(([key, item]) => [cbor(key), cbor(item as Parameters<typeof cbor>[0])]),
  ]);
}

function authenticator() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const id = randomBytes(32);
  const cose = cbor(
    new Map<number, unknown>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x ?? "", "base64url")],
      [-3, Buffer.from(jwk.y ?? "", "base64url")],
    ]),
  );
  const authData = (rpId: string, flags: number, counter: number) => {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(counter);
    return Buffer.concat([sha256(rpId), Buffer.from([flags]), count]);
  };
  return {
    id: base64(id),
    registration(
      options: RegistrationOptions,
      changes: { origin?: string; challenge?: string; rpId?: string; uv?: boolean } = {},
    ) {
      const length = Buffer.alloc(2);
      length.writeUInt16BE(id.length);
      const data = Buffer.concat([
        authData(changes.rpId ?? options.rp.id, changes.uv === false ? 0x41 : 0x45, 0),
        Buffer.alloc(16),
        length,
        id,
        cose,
      ]);
      return {
        id: base64(id),
        rawId: base64(id),
        type: "public-key",
        response: {
          clientDataJSON: base64(
            Buffer.from(
              JSON.stringify({
                type: "webauthn.create",
                challenge: changes.challenge ?? options.challenge,
                origin: changes.origin ?? ORIGIN,
              }),
            ),
          ),
          attestationObject: base64(
            cbor(
              new Map<string, unknown>([
                ["fmt", "none"],
                ["authData", data],
                ["attStmt", new Map()],
              ]),
            ),
          ),
          transports: ["internal"],
        },
        authenticatorAttachment: "platform",
        clientExtensionResults: { credProps: { rk: true } },
      };
    },
    assertion(
      options: AuthenticationOptions,
      userHandle: string,
      changes: {
        origin?: string;
        challenge?: string;
        rpId?: string;
        uv?: boolean;
        counter?: number;
        badSignature?: boolean;
      } = {},
    ) {
      const data = authData(changes.rpId ?? options.rpId, changes.uv === false ? 0x01 : 0x05, changes.counter ?? 1);
      const clientData = Buffer.from(
        JSON.stringify({
          type: "webauthn.get",
          challenge: changes.challenge ?? options.challenge,
          origin: changes.origin ?? ORIGIN,
        }),
      );
      const signature = sign("sha256", Buffer.concat([data, sha256(clientData)]), privateKey);
      if (changes.badSignature) signature[signature.length - 1] = (signature[signature.length - 1] ?? 0) ^ 1;
      return {
        id: base64(id),
        rawId: base64(id),
        type: "public-key",
        response: {
          clientDataJSON: base64(clientData),
          authenticatorData: base64(data),
          signature: base64(signature),
          userHandle,
        },
        authenticatorAttachment: "platform",
        clientExtensionResults: {},
      };
    },
  };
}

async function registrationOptions(b: Browser) {
  const res = await b(OPTIONS);
  expect(res.status).toBe(200);
  return (await res.json()) as RegistrationOptions;
}

test("auth-config advertises the canonical passkey capability", async () => {
  t = await createTestServer();
  expect(await (await browser(t)("/api/app/auth-config")).json()).toMatchObject({
    passkeys: { enabled: true, origin: ORIGIN },
  });
});

test("registration requires a signed-in account", async () => {
  t = await createTestServer();
  expect((await browser(t)(OPTIONS)).status).toBe(401);
});

test("registration requests a discoverable credential and required user verification", async () => {
  t = await createTestServer();
  const b = browser(t);
  await signUp(b, "passkey@example.com");
  const options = await registrationOptions(b);
  expect(options.rp.id).toBe("localhost");
  expect(options.authenticatorSelection).toMatchObject({ residentKey: "required", userVerification: "required" });
  expect(options.user.name).toBe("passkey@example.com");
});

test("a fresh account registers a valid public-key proof", async () => {
  t = await createTestServer();
  const b = browser(t);
  await signUp(b, "passkey@example.com");
  const key = authenticator();
  const options = await registrationOptions(b);
  const res = await b(REGISTER, { json: { response: key.registration(options) } });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ credentialID: key.id });
});

test("a registration for another origin is refused", async () => {
  t = await createTestServer();
  const b = browser(t);
  await signUp(b, "passkey@example.com");
  const key = authenticator();
  const options = await registrationOptions(b);
  const res = await b(REGISTER, { json: { response: key.registration(options, { origin: "https://other.example" }) } });
  expect(res.status).toBe(400);
});

const LIST = "/api/auth/passkey/list-user-passkeys";
const UPDATE = "/api/auth/passkey/update-passkey";
const DELETE = "/api/auth/passkey/delete-passkey";

async function register(b: Browser) {
  const key = authenticator();
  const options = await registrationOptions(b);
  const res = await b(REGISTER, { json: { response: key.registration(options) } });
  expect(res.status).toBe(200);
  const credential = (await res.json()) as { id: string; userId: string; credentialID: string };
  return { key, userHandle: options.user.id, credential };
}

async function authenticationOptions(b: Browser) {
  const res = await b(AUTH_OPTIONS);
  expect(res.status).toBe(200);
  return (await res.json()) as AuthenticationOptions;
}

async function registered() {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "passkey@example.com");
  const result = await register(owner);
  await owner("/api/auth/sign-out", { json: {} });
  return result;
}

const withCookie = (cookie: string, path: string, json?: unknown) =>
  t.app.request(path, {
    method: json === undefined ? "GET" : "POST",
    headers: { origin: ORIGIN, cookie, ...(json === undefined ? {} : { "content-type": "application/json" }) },
    body: json === undefined ? undefined : JSON.stringify(json),
  });

test("configuration enables only a canonical HTTPS domain or explicit development localhost", () => {
  expect(passkeyConfiguration({ PUBLIC_URL: "https://auth.example:8443/a?b=c", NODE_ENV: "production" })).toEqual({
    rpID: "auth.example",
    origin: "https://auth.example:8443",
  });
  expect(passkeyConfiguration({ PUBLIC_URL: ORIGIN, NODE_ENV: "test" })).toEqual({ rpID: "localhost", origin: ORIGIN });
  for (const url of [
    "http://auth.example",
    "https://127.0.0.1",
    "https://[::1]",
    "https://user:secret@auth.example",
    "invalid",
  ]) {
    expect(passkeyConfiguration({ PUBLIC_URL: url, NODE_ENV: "test" })).toBeNull();
  }
  expect(passkeyConfiguration({ PUBLIC_URL: ORIGIN, NODE_ENV: "production" })).toBeNull();
});

test("an insecure non-local server advertises no capability and has no ceremony", async () => {
  t = await createTestServer({ env: { PUBLIC_URL: "http://auth.example" } });
  expect(await (await browser(t)("/api/app/auth-config")).json()).toMatchObject({
    passkeys: { enabled: false, origin: null },
  });
  expect((await browser(t)(AUTH_OPTIONS, { origin: "http://auth.example" })).status).toBe(404);
});

test("local HTTP aliases cannot perform ceremonies for the canonical HTTPS server", async () => {
  t = await createTestServer({ env: { PUBLIC_URL: "https://auth.example", LOCAL_HTTP_LOGIN: "true" } });
  expect(
    (
      await t.app.request(`http://localhost:3000${AUTH_OPTIONS}`, {
        headers: { host: "localhost:3000", origin: ORIGIN },
      })
    ).status,
  ).toBe(403);
  const canonical = await t.app.request(`https://auth.example${AUTH_OPTIONS}`, {
    headers: { host: "auth.example", origin: "https://auth.example" },
  });
  expect(canonical.status).toBe(200);
  expect(await canonical.json()).toMatchObject({ rpId: "auth.example", userVerification: "required" });
});

test("the account's opaque user handle remains stable across registration options", async () => {
  t = await createTestServer();
  const b = browser(t);
  await signUp(b, "passkey@example.com");
  const a = await registrationOptions(b);
  const next = await registrationOptions(b);
  expect(next.user.id).toBe(a.user.id);
  expect(Buffer.from(a.user.id, "base64url")).toHaveLength(32);
  expect(Buffer.from(a.user.id, "base64url").toString()).not.toContain("passkey@example.com");
  expect(next.challenge).not.toBe(a.challenge);
});

test("email-free login verifies a real signature and creates an audited ordinary session", async () => {
  const { key, userHandle, credential } = await registered();
  const b = browser(t);
  const options = await authenticationOptions(b);
  expect(options.userVerification).toBe("required");
  expect(options.allowCredentials ?? []).toEqual([]);
  enableOperatorEvents();
  try {
    const res = await b(AUTHENTICATE, {
      json: { response: key.assertion(options, userHandle) },
      headers: { "user-agent": "PasskeyTest/1.0" },
    });
    expect(res.status).toBe(200);
    expect(await (await b("/api/app/me")).json()).toMatchObject({ user: { email: "passkey@example.com" } });
    const sessions = await t.db.select().from(schema.sessions);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.userId).toBe(credential.userId);
    const events = await t.db
      .select()
      .from(schema.operatorEvents)
      .where(eq(schema.operatorEvents.type, "session.created"));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ userId: credential.userId, data: { userAgent: "PasskeyTest/1.0" } });
  } finally {
    enableOperatorEvents(false);
  }
});

test.each([
  { label: "challenge", changes: { challenge: "wrong-challenge" } },
  { label: "RP id", changes: { rpId: "other.example" } },
  { label: "user verification", changes: { uv: false } },
])("registration rejects incorrect $label", async ({ changes }) => {
  t = await createTestServer();
  const b = browser(t);
  await signUp(b, "passkey@example.com");
  const key = authenticator();
  const options = await registrationOptions(b);
  expect((await b(REGISTER, { json: { response: key.registration(options, changes) } })).status).toBe(400);
  expect(await t.db.select().from(schema.passkeys)).toHaveLength(0);
});

test.each([
  { label: "challenge", changes: { challenge: "wrong-challenge" } },
  { label: "origin", changes: { origin: "https://other.example" } },
  { label: "RP id", changes: { rpId: "other.example" } },
  { label: "signature", changes: { badSignature: true }, status: 401 },
  { label: "user verification", changes: { uv: false } },
])("authentication rejects incorrect $label without creating a session", async ({ changes, status }) => {
  const { key, userHandle } = await registered();
  const b = browser(t);
  const options = await authenticationOptions(b);
  expect((await b(AUTHENTICATE, { json: { response: key.assertion(options, userHandle, changes) } })).status).toBe(
    status ?? 400,
  );
  expect(await t.db.select().from(schema.sessions)).toHaveLength(0);
  expect((await b("/api/app/me")).status).toBe(401);
});

test.each(["another-account", ""])(
  "a valid signature cannot authenticate with a mismatched or empty user handle: %s",
  async (handle) => {
    const { key } = await registered();
    const b = browser(t);
    const options = await authenticationOptions(b);
    expect((await b(AUTHENTICATE, { json: { response: key.assertion(options, handle) } })).status).toBe(401);
    expect(await t.db.select().from(schema.sessions)).toHaveLength(0);
  },
);

test("a missing user handle is rejected before creating a session", async () => {
  const { key, userHandle } = await registered();
  const b = browser(t);
  const options = await authenticationOptions(b);
  const assertion = key.assertion(options, userHandle);
  const { userHandle: _handle, ...response } = assertion.response;
  expect((await b(AUTHENTICATE, { json: { response: { ...assertion, response } } })).status).toBe(401);
  expect(await t.db.select().from(schema.sessions)).toHaveLength(0);
});

test("a zero-counter authenticator's proof is accepted once and cannot be replayed", async () => {
  const { key, userHandle } = await registered();
  const b = browser(t);
  const options = await authenticationOptions(b);
  const cookie = b.cookie();
  const response = key.assertion(options, userHandle, { counter: 0 });
  expect((await withCookie(cookie, AUTHENTICATE, { response })).status).toBe(200);
  expect((await withCookie(cookie, AUTHENTICATE, { response })).status).toBe(400);
  expect(await t.db.select().from(schema.sessions)).toHaveLength(1);
});

test("concurrent verification consumes one challenge and creates exactly one session", async () => {
  const { key, userHandle } = await registered();
  const b = browser(t);
  const options = await authenticationOptions(b);
  const cookie = b.cookie();
  const response = key.assertion(options, userHandle, { counter: 0 });
  const results = await Promise.all([
    withCookie(cookie, AUTHENTICATE, { response }),
    withCookie(cookie, AUTHENTICATE, { response }),
  ]);
  expect(results.map((res) => res.status).sort()).toEqual([200, 400]);
  expect(await t.db.select().from(schema.sessions)).toHaveLength(1);
});

test("an expired challenge rejects a valid proof", async () => {
  const { key, userHandle } = await registered();
  const b = browser(t);
  const options = await authenticationOptions(b);
  await t.db.update(schema.verifications).set({ expiresAt: new Date(Date.now() - 1_000) });
  expect((await b(AUTHENTICATE, { json: { response: key.assertion(options, userHandle) } })).status).toBe(400);
  expect(await t.db.select().from(schema.sessions)).toHaveLength(0);
});

test("registration challenges cannot authorize authentication", async () => {
  t = await createTestServer();
  const b = browser(t);
  await signUp(b, "passkey@example.com");
  const { key, userHandle } = await register(b);
  const options = await registrationOptions(b);
  const assertion = key.assertion(
    { challenge: options.challenge, rpId: "localhost", userVerification: "required" },
    userHandle,
  );
  expect((await b(AUTHENTICATE, { json: { response: assertion } })).status).toBe(400);
  expect(await t.db.select().from(schema.sessions)).toHaveLength(1);
});

test("stale database sign-in time rejects every credential write despite a fresh cached cookie", async () => {
  t = await createTestServer();
  const b = browser(t);
  await signUp(b, "passkey@example.com");
  const { credential } = await register(b);
  const options = await registrationOptions(b);
  const response = authenticator().registration(options);
  const cookie = b.cookie();
  await t.db.update(schema.sessions).set({ createdAt: new Date(Date.now() - FRESH_SIGN_IN_MS - 1_000) });
  for (const [path, json] of [
    [OPTIONS, undefined],
    [REGISTER, { response }],
    [UPDATE, { id: credential.id, name: "Changed" }],
    [DELETE, { id: credential.id }],
  ] as const) {
    const res = await withCookie(cookie, path, json);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "PASSKEY_REAUTH_REQUIRED" });
  }
  expect((await withCookie(cookie, LIST)).status).toBe(200);
  expect(await t.db.select().from(schema.passkeys)).toHaveLength(1);
});

test("revoked sessions cannot list or mutate passkeys through their signed cookie cache", async () => {
  t = await createTestServer();
  const b = browser(t);
  await signUp(b, "passkey@example.com");
  const { credential } = await register(b);
  const options = await registrationOptions(b);
  const response = authenticator().registration(options);
  const cookie = b.cookie();
  await t.db.delete(schema.sessions);
  for (const [path, json] of [
    [OPTIONS, undefined],
    [REGISTER, { response }],
    [LIST, undefined],
    [UPDATE, { id: credential.id, name: "Changed" }],
    [DELETE, { id: credential.id }],
  ] as const) {
    expect((await withCookie(cookie, path, json)).status).toBe(401);
  }
  expect(await t.db.select().from(schema.passkeys)).toHaveLength(1);
});

test("expired sessions cannot register through their signed cookie cache", async () => {
  t = await createTestServer();
  const b = browser(t);
  await signUp(b, "passkey@example.com");
  const cookie = b.cookie();
  await t.db.update(schema.sessions).set({ expiresAt: new Date(Date.now() - 1_000) });
  expect((await withCookie(cookie, OPTIONS)).status).toBe(401);
});

test("registration cannot silently refresh the existing sign-in", async () => {
  t = await createTestServer();
  const b = browser(t);
  await signUp(b, "passkey@example.com");
  const options = await registrationOptions(b);
  expect(
    (await b(REGISTER, { json: { response: authenticator().registration(options), createSession: true } })).status,
  ).toBe(400);
  expect(await t.db.select().from(schema.sessions)).toHaveLength(1);
  expect(await t.db.select().from(schema.passkeys)).toHaveLength(0);
});

test("only the owner can list, rename and revoke a credential", async () => {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" } });
  const owner = browser(t);
  const other = browser(t);
  await signUp(owner, "passkey@example.com");
  const { credential } = await register(owner);
  await signUp(other, "other@example.com");
  expect(await (await other(LIST)).json()).toEqual([]);
  expect((await other(UPDATE, { json: { id: credential.id, name: "Stolen" } })).status).toBe(401);
  expect((await other(DELETE, { json: { id: credential.id } })).status).toBe(401);
  expect((await owner(UPDATE, { json: { id: credential.id, name: "My device" } })).status).toBe(200);
  expect(await (await owner(LIST)).json()).toMatchObject([{ id: credential.id, name: "My device" }]);
});

test("a registration challenge belongs to the account that started it", async () => {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" } });
  const owner = browser(t);
  const other = browser(t);
  await signUp(owner, "passkey@example.com");
  const options = await registrationOptions(owner);
  const challengeCookie = owner
    .cookie()
    .split("; ")
    .find((cookie) => cookie.includes("passkey="));
  expect(challengeCookie).toBeDefined();
  await signUp(other, "other@example.com");
  const res = await withCookie(`${other.cookie()}; ${challengeCookie}`, REGISTER, {
    response: authenticator().registration(options),
  });
  expect(res.status).toBe(401);
  expect(await t.db.select().from(schema.passkeys)).toHaveLength(0);
});

test("revoking a passkey prevents its next sign-in and keeps password fallback", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "passkey@example.com");
  const { key, userHandle, credential } = await register(owner);
  expect((await owner(DELETE, { json: { id: credential.id } })).status).toBe(200);
  await owner("/api/auth/sign-out", { json: {} });
  const b = browser(t);
  const options = await authenticationOptions(b);
  expect((await b(AUTHENTICATE, { json: { response: key.assertion(options, userHandle) } })).status).toBe(401);
  expect(await t.db.select().from(schema.sessions)).toHaveLength(0);
  expect(
    (
      await b("/api/auth/sign-in/email", {
        json: { email: "passkey@example.com", password: "correct horse battery" },
      })
    ).status,
  ).toBe(200);
});

test("a blocked account cannot manage credentials or create a session with a valid passkey", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "passkey@example.com");
  const { key, userHandle, credential } = await register(owner);
  await t.db.update(schema.users).set({ blockedAt: new Date() }).where(eq(schema.users.id, credential.userId));
  expect((await owner(OPTIONS)).status).toBe(403);
  expect((await owner(DELETE, { json: { id: credential.id } })).status).toBe(403);
  await owner("/api/auth/sign-out", { json: {} });
  const b = browser(t);
  const options = await authenticationOptions(b);
  const res = await b(AUTHENTICATE, { json: { response: key.assertion(options, userHandle) } });
  expect(res.status).toBe(403);
  expect(await res.json()).toMatchObject({ code: "ACCOUNT_BLOCKED" });
  expect(await t.db.select().from(schema.sessions)).toHaveLength(0);
});

test("unauthenticated option and verification requests have bounded per-IP budgets", async () => {
  t = await createTestServer();
  const b = browser(t);
  for (let i = 0; i < 30; i++) expect((await b(AUTH_OPTIONS)).status).toBe(200);
  expect((await b(AUTH_OPTIONS)).status).toBe(429);
  const anonymous = browser(t);
  for (let i = 0; i < 10; i++) expect((await anonymous(AUTHENTICATE, { json: { response: {} } })).status).toBe(400);
  expect((await anonymous(AUTHENTICATE, { json: { response: {} } })).status).toBe(429);
});
