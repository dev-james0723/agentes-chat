import { afterEach, beforeEach, expect, test } from "bun:test";
import { testConfig } from "@agenteschat/config";
import { rejectForwardedLocal } from "../src/dual-origin-guard";
import { personUpgrade } from "../src/realtime/ws";
import { allowedOrigins, requestOriginAllowed } from "../src/routes/app/context";
import { createTestServer, type TestServer } from "./harness";

const publicOrigin = "https://james.example.test:8445";
const localOrigin = "http://localhost:3000";
const creds = { email: "owner@example.test", password: "correct horse battery" };
function sessionToken(response: Response): string {
  const token = response.headers.getSetCookie().find((cookie) => cookie.includes("session_token="));
  if (!token) throw new Error("Session cookie missing");
  return token;
}
function cookiePair(token: string): string {
  const pair = token.split(";")[0];
  if (!pair) throw new Error("Session cookie is empty");
  return pair;
}
let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ env: { PUBLIC_URL: publicOrigin, LOCAL_HTTP_LOGIN: "true" } });
});
afterEach(() => t.close());

test("local alias cannot enter any app route or websocket after a proxy", async () => {
  const config = testConfig({ PUBLIC_URL: publicOrigin, LOCAL_HTTP_LOGIN: "true" });
  const forwarded = ["Forwarded", "X-Forwarded-Host", "X-Forwarded-Proto", "X-Forwarded-For", "X-Forwarded-Port"];
  for (const header of forwarded) {
    for (const value of ["", "untrusted"]) {
      for (const path of ["/api/health", "/api/auth/get-session", "/api/app/me", "/", "/api/ws"]) {
        const raw = new Request(`${localOrigin}${path}`, { headers: { host: "LOCALHOST:3000", [header]: value } });
        const refusal = rejectForwardedLocal(config, raw);
        expect(refusal?.status).toBe(421);
        if (path !== "/api/ws") expect((await t.app.fetch(raw)).status).toBe(421);
      }
    }
  }
  expect(
    rejectForwardedLocal(config, new Request(`${localOrigin}/api/ws`, { headers: { host: "localhost:3000" } })),
  ).toBeNull();
  expect(
    rejectForwardedLocal(
      config,
      new Request(`${publicOrigin}/api/ws`, {
        headers: { host: new URL(publicOrigin).host, "x-forwarded-host": "evil" },
      }),
    ),
  ).toBeNull();
});

async function request(origin: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return t.app.fetch(
    new Request(origin + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        host: new URL(origin).host,
        origin,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

test("password signup, login and session work on both exact origins with appropriate cookies", async () => {
  const signup = await request(publicOrigin, "/api/auth/sign-up/email", { ...creds, name: "Owner" });
  expect(signup.status).toBe(200);
  for (const origin of [publicOrigin, localOrigin]) {
    const signed = await request(origin, "/api/auth/sign-in/email", creds);
    expect(signed.status).toBe(200);
    const token = sessionToken(signed);
    expect(/; secure(?:;|$)/i.test(token)).toBe(origin === publicOrigin);
    expect(/; domain=/i.test(token)).toBe(false);
    const cookie = cookiePair(token);
    const session = await request(origin, "/api/auth/get-session", undefined, { cookie });
    expect(session.status).toBe(200);
    expect(((await session.json()) as { user: { email: string } }).user.email).toBe(creds.email);
    const write = await request(
      origin,
      "/api/app/organizations",
      { name: `Test ${origin}`, context: "Test" },
      { cookie },
    );
    expect([200, 201]).toContain(write.status);
    const orgId = ((await write.json()) as { organization: { id: string } }).organization.id;
    expect(typeof orgId).toBe("string");
    const cross = await request(
      origin,
      "/api/app/organizations",
      { name: "bad", context: "Test" },
      { cookie, origin: "https://evil.example" },
    );
    expect(cross.status).toBe(403);
    const origins = allowedOrigins(testConfig({ PUBLIC_URL: publicOrigin, LOCAL_HTTP_LOGIN: "true" }));
    const upgradeReq = (wsOrigin: string) =>
      new Request(`${origin}/api/ws`, { headers: { host: new URL(origin).host, origin: wsOrigin, cookie } });
    const accepted = await personUpgrade({ auth: t.auth, db: t.db }, origins, upgradeReq(origin), orgId);
    expect(accepted instanceof Response).toBe(false);
    const refused = await personUpgrade({ auth: t.auth, db: t.db }, origins, upgradeReq("https://evil.example"), orgId);
    expect(refused instanceof Response && refused.status).toBe(403);
  }
});

test("HTTP and websocket origins are exact and feature is self-host HTTPS opt-in", () => {
  const config = testConfig({ PUBLIC_URL: publicOrigin, LOCAL_HTTP_LOGIN: "true" });
  const origins = allowedOrigins(config);
  for (const origin of [publicOrigin, localOrigin])
    expect(requestOriginAllowed(origins, new Headers({ origin }))).toBe(true);
  for (const origin of ["https://evil.example", "http://james.example.test:8445", "http://localhost:3001"])
    expect(requestOriginAllowed(origins, new Headers({ origin }))).toBe(false);
  expect(() => testConfig({ PUBLIC_URL: "https://agentes.chat", LOCAL_HTTP_LOGIN: "true" })).toThrow();
  expect(() => testConfig({ PUBLIC_URL: "http://chat.example.test", LOCAL_HTTP_LOGIN: "true" })).toThrow();
  expect(allowedOrigins(testConfig({ PUBLIC_URL: publicOrigin })).has(localOrigin)).toBe(false);
});

test("TLS proxy internal HTTP request still issues HTTPS session cookies", async () => {
  const signup = await request(publicOrigin, "/api/auth/sign-up/email", { ...creds, name: "Owner" });
  expect(signup.status).toBe(200);
  const internalOrigin = `http://${new URL(publicOrigin).host}`;
  const signed = await request(internalOrigin, "/api/auth/sign-in/email", creds, {
    origin: publicOrigin,
    "x-forwarded-proto": "https",
  });
  expect(signed.status).toBe(200);
  const token = sessionToken(signed);
  expect(/; secure(?:;|$)/i.test(token)).toBe(true);
});

test("OAuth callback origin currently follows the initiating host", async () => {
  await t.close();
  t = await createTestServer({
    env: {
      PUBLIC_URL: publicOrigin,
      LOCAL_HTTP_LOGIN: "true",
      GOOGLE_CLIENT_ID: "test-id",
      GOOGLE_CLIENT_SECRET: "test-secret",
    },
  });
  for (const origin of [publicOrigin, localOrigin]) {
    const result = await request(origin, "/api/auth/sign-in/social", {
      provider: "google",
      callbackURL: "/",
      disableRedirect: true,
    });
    expect(result.status).toBe(200);
    const authUrl = new URL(((await result.json()) as { url: string }).url);
    expect(authUrl.searchParams.get("redirect_uri")).toBe(`${origin}/api/auth/callback/google`);
  }
});

test("untrusted origins and forged proxy host do not grant login", async () => {
  const signup = await request(publicOrigin, "/api/auth/sign-up/email", { ...creds, name: "Owner" });
  expect(signup.status).toBe(200);
  const cookie = cookiePair(sessionToken(signup));
  const badOrigin = await request(localOrigin, "/api/auth/sign-in/email", creds, {
    origin: "https://evil.example",
    cookie,
  });
  expect(badOrigin.status).not.toBe(200);
  const badHost = await request("http://evil.example", "/api/auth/sign-in/email", creds, {
    "x-forwarded-host": new URL(publicOrigin).host,
    "x-forwarded-proto": "https",
  });
  expect(badHost.status).not.toBe(200);
  const spoofed = await request(localOrigin, "/api/auth/sign-in/email", creds, {
    "x-forwarded-host": "evil.example",
    "x-forwarded-proto": "https",
  });
  expect(spoofed.status).toBe(421);
  const proxiedPublic = await request(publicOrigin, "/api/auth/sign-in/email", creds, {
    "x-forwarded-host": "evil.example",
    "x-forwarded-proto": "http",
  });
  expect(proxiedPublic.status).toBe(200);
  const token = sessionToken(proxiedPublic);
  expect(/; secure(?:;|$)/i.test(token)).toBe(true);
  const insecurePublic = await request(`http://${new URL(publicOrigin).host}`, "/api/auth/sign-in/email", creds, {
    cookie,
    origin: `http://${new URL(publicOrigin).host}`,
  });
  expect(insecurePublic.status).toBe(403);
});
