import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { createBetterAuthClient } from "@/auth/better-auth";
import { passkeyErrorText, passkeyOrigin } from "@/auth/passkeys";
import { createI18n } from "@/i18n";

const undo: (() => void)[] = [];
function replace(object: object, property: string, value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(object, property);
  Object.defineProperty(object, property, { configurable: true, writable: true, value });
  undo.push(() => {
    if (previous) Object.defineProperty(object, property, previous);
    else Reflect.deleteProperty(object, property);
  });
}
afterEach(() => {
  for (const restore of undo.splice(0).reverse()) restore();
});

const bytes = () => new Uint8Array([1, 2, 3]).buffer;
const credential = () => ({
  id: "AQID",
  rawId: bytes(),
  type: "public-key",
  authenticatorAttachment: "platform",
  response: {
    clientDataJSON: bytes(),
    authenticatorData: bytes(),
    signature: bytes(),
    userHandle: bytes(),
    attestationObject: bytes(),
    getTransports: () => ["internal"],
  },
  getClientExtensionResults: () => ({}),
});
function webauthn(
  methods: {
    get?: (options: CredentialRequestOptions) => unknown;
    create?: (options: CredentialCreationOptions) => unknown;
  } = {},
) {
  replace(window, "isSecureContext", true);
  replace(window, "PublicKeyCredential", class {});
  replace(globalThis, "PublicKeyCredential", window.PublicKeyCredential);
  replace(navigator, "credentials", {
    get: async (options: CredentialRequestOptions) => methods.get?.(options) ?? credential(),
    create: async (options: CredentialCreationOptions) => methods.create?.(options) ?? credential(),
  });
}
function fakeFetch(answer: (path: string, init?: RequestInit) => Response | Promise<Response>) {
  replace(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) =>
    answer(new URL(input instanceof Request ? input.url : String(input)).pathname, init),
  );
}
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
const options = {
  challenge: "AQID",
  rpId: "localhost",
  userVerification: "required",
  allowCredentials: [],
};
const registration = {
  challenge: "AQID",
  rp: { id: "localhost", name: "Test" },
  user: { id: "AQID", name: "ana@example.com", displayName: "Ana" },
  pubKeyCredParams: [{ type: "public-key", alg: -7 }],
  authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
};

describe("official passkey client adapter", () => {
  test("uses explicit discoverable authentication and preserves required device verification", async () => {
    let prompt: CredentialRequestOptions | undefined;
    const requests: string[] = [];
    webauthn({
      get: (value) => {
        prompt = value;
        return credential();
      },
    });
    fakeFetch((path) => {
      requests.push(path);
      return json(path.endsWith("generate-authenticate-options") ? options : { session: {}, user: {} });
    });
    expect(await createBetterAuthClient().signInPasskey()).toEqual({ ok: true });
    expect(prompt?.mediation).toBeUndefined();
    expect(prompt?.publicKey?.allowCredentials).toBeUndefined();
    expect(prompt?.publicKey?.userVerification).toBe("required");
    expect(requests).toEqual([
      "/api/auth/passkey/generate-authenticate-options",
      "/api/auth/passkey/verify-authentication",
    ]);
  });

  test("registers the account identity and never sends a cosmetic name or creates a session", async () => {
    let prompt: CredentialCreationOptions | undefined;
    const bodies: Record<string, unknown>[] = [];
    const urls: string[] = [];
    webauthn({
      create: (value) => {
        prompt = value;
        return credential();
      },
    });
    replace(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      urls.push(url.href);
      if (init?.body) bodies.push(JSON.parse(String(init.body)));
      return json(url.pathname.endsWith("generate-register-options") ? registration : { id: "key-1" });
    });
    expect(await createBetterAuthClient().addPasskey()).toEqual({ ok: true });
    expect(prompt?.publicKey?.user.name).toBe("ana@example.com");
    expect(prompt?.publicKey?.authenticatorSelection?.residentKey).toBe("required");
    expect(prompt?.publicKey?.authenticatorSelection?.userVerification).toBe("required");
    expect(urls.every((url) => !new URL(url).searchParams.has("name"))).toBe(true);
    expect(bodies[0]).not.toHaveProperty("name");
    expect(bodies[0]).not.toHaveProperty("createSession");
  });

  test("returns only display metadata and uses official rename/delete endpoints", async () => {
    const mutations: { path: string; body: unknown }[] = [];
    fakeFetch((path, init) => {
      if (path.endsWith("list-user-passkeys"))
        return json([
          {
            id: "key-1",
            name: "Mac",
            createdAt: "2026-11-20T12:00:00.000Z",
            deviceType: "multiDevice",
            backedUp: true,
            publicKey: "private-to-protocol",
            credentialID: "credential-id",
            userId: "owner-1",
            counter: 2,
          },
        ]);
      mutations.push({ path, body: JSON.parse(String(init?.body)) });
      return json({ status: true });
    });
    const auth = createBetterAuthClient();
    expect(await auth.listPasskeys()).toEqual({
      ok: true,
      passkeys: [
        {
          id: "key-1",
          name: "Mac",
          createdAt: "2026-11-20T12:00:00.000Z",
          deviceType: "multiDevice",
          backedUp: true,
        },
      ],
    });
    expect(await auth.renamePasskey("key-1", "Office")).toEqual({ ok: true });
    expect(await auth.deletePasskey("key-1")).toEqual({ ok: true });
    expect(mutations).toEqual([
      { path: "/api/auth/passkey/update-passkey", body: { id: "key-1", name: "Office" } },
      { path: "/api/auth/passkey/delete-passkey", body: { id: "key-1" } },
    ]);
  });

  test("unsupported browsers settle before fetching any challenge", async () => {
    let asked = false;
    replace(window, "PublicKeyCredential", undefined);
    fakeFetch(() => {
      asked = true;
      return json({});
    });
    expect(await createBetterAuthClient().signInPasskey()).toMatchObject({ ok: false, code: "passkey_unsupported" });
    expect(asked).toBe(false);
  });

  test("the real browser cancellation code gets recoverable translated text", async () => {
    webauthn({
      get: () => {
        throw new DOMException("private device detail", "NotAllowedError");
      },
    });
    fakeFetch(() => json(options));
    const result = await createBetterAuthClient().signInPasskey();
    expect(result).toMatchObject({ ok: false, code: "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY" });
    if (!result.ok)
      expect(passkeyErrorText(createI18n("en").t, result)).toBe(
        "Verification was cancelled. Try again or sign in with email and password.",
      );
  });

  test("network failure during verification remains a network error even when the plugin catches it", async () => {
    webauthn();
    fakeFetch((path) => {
      if (path.endsWith("generate-authenticate-options")) return json(options);
      throw new TypeError("Failed to fetch");
    });
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await createBetterAuthClient().signInPasskey()).toEqual({
        ok: false,
        status: 0,
        code: "network",
        message: "",
      });
    } finally {
      log.mockRestore();
    }
  });

  test("stale and ownership errors are preserved for management recovery", async () => {
    fakeFetch(() => json({ code: "PASSKEY_REAUTH_REQUIRED", message: "Sign in again" }, 403));
    expect(await createBetterAuthClient().renamePasskey("key-1", "Office")).toMatchObject({
      ok: false,
      status: 403,
      code: "PASSKEY_REAUTH_REQUIRED",
    });
  });
});

describe("canonical passkey origins", () => {
  test("accepts the exact configured HTTPS origin or explicit local development", () => {
    for (const origin of ["https://auth.example.com", "https://auth.example.com:8443", "http://localhost:3000"]) {
      expect(passkeyOrigin({ passkeys: { enabled: true, origin } })).toBe(origin);
    }
  });
  test("rejects disabled, missing, credential-bearing, noncanonical and insecure remote URLs", () => {
    expect(passkeyOrigin(undefined)).toBeNull();
    expect(passkeyOrigin({ passkeys: { enabled: false, origin: "https://auth.example.com" } })).toBeNull();
    for (const origin of [
      "http://auth.example.com",
      "https://auth.example.com/path",
      "https://user@auth.example.com",
      "javascript:alert(1)",
      "https://auth.example.com/?redirect=https://evil.example",
    ]) {
      expect(passkeyOrigin({ passkeys: { enabled: true, origin } })).toBeNull();
    }
  });
});
