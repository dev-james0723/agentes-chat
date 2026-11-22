import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { RateLimiter } from "@agenteschat/adapters";
import type { Config } from "@agenteschat/config";
import { type Database, eq, schema } from "@agenteschat/db";
import { accountBlock } from "@agenteschat/engine";
import { passkey } from "@better-auth/passkey";
import { APIError, createAuthMiddleware, getAuthoritativeSessionFromCtx } from "better-auth/api";
import { FRESH_SIGN_IN_MS } from "./desktop-sign-in";
import { requestLimitIp } from "./http/client-ip";

const REGISTER_OPTIONS = "/passkey/generate-register-options";
const REGISTER = "/passkey/verify-registration";
const AUTHENTICATE_OPTIONS = "/passkey/generate-authenticate-options";
const AUTHENTICATE = "/passkey/verify-authentication";
const LIST = "/passkey/list-user-passkeys";
const WRITES = new Set([REGISTER_OPTIONS, REGISTER, "/passkey/update-passkey", "/passkey/delete-passkey"]);

/** One server-configured credential origin. Host and forwarded headers never choose a relying party. */
export function passkeyConfiguration(config: Pick<Config, "PUBLIC_URL" | "NODE_ENV">) {
  let url: URL;
  try {
    url = new URL(config.PUBLIC_URL);
  } catch {
    return null;
  }
  const host = url.hostname;
  const dnsName =
    host.length <= 253 && host.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
  const secure = url.protocol === "https:" && dnsName && !isIP(host);
  const development = config.NODE_ENV !== "production" && url.protocol === "http:" && host === "localhost";
  if ((!secure && !development) || url.username || url.password) return null;
  return { rpID: host, origin: url.origin };
}

export function passkeyCapability(config: Pick<Config, "PUBLIC_URL" | "NODE_ENV">) {
  const configured = passkeyConfiguration(config);
  return { enabled: configured !== null, origin: configured?.origin ?? null };
}

/**
 * The plugin generates a random user handle but does not persist or verify it. Use an opaque, stable
 * handle of the server-generated account id (never its email), independent of session-secret rotation.
 */
const userHandle = (userId: string) =>
  createHash("sha256").update("agentes.chat:passkey-user:v1:").update(userId).digest("base64url");

/** Better Auth owns ceremonies, one-use challenges and sessions; these hooks apply account policy. */
export function passkeyPlugins(deps: { config: Config; db: Database; rateLimiter: RateLimiter }) {
  const { config, db, rateLimiter } = deps;
  const configured = passkeyConfiguration(config);
  if (!configured) return [];
  const plugin = passkey({
    ...configured,
    rpName: "agentes.chat",
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    registration: { requireSession: true },
    authentication: {
      afterVerification: async ({ clientData }) => {
        const [credential] = await db
          .select({ userId: schema.passkeys.userId })
          .from(schema.passkeys)
          .where(eq(schema.passkeys.credentialID, clientData.id));
        if (!credential || clientData.response.userHandle !== userHandle(credential.userId)) {
          throw new APIError("UNAUTHORIZED", {
            code: "AUTHENTICATION_FAILED",
            message: "Passkey authentication failed.",
          });
        }
      },
    },
  });
  return [
    {
      ...plugin,
      hooks: {
        before: [
          {
            matcher: (ctx: { path?: string }) => ctx.path?.startsWith("/passkey/") === true,
            handler: createAuthMiddleware(async (ctx) => {
              const origin = ctx.headers?.get("origin");
              const host = ctx.headers?.get("host") ?? (ctx.request ? new URL(ctx.request.url).host : null);
              if (
                (origin && origin !== configured.origin) ||
                (!origin && host && host !== new URL(configured.origin).host)
              ) {
                throw new APIError("FORBIDDEN", {
                  code: "PASSKEY_ORIGIN_REQUIRED",
                  message: "Open this server's canonical address to use a passkey.",
                });
              }
              const verify = ctx.path === REGISTER || ctx.path === AUTHENTICATE;
              const ip = requestLimitIp(ctx.headers ?? new Headers(), config.TRUSTED_PROXIES);
              const limit = await rateLimiter.consume(`passkey:${ctx.path}:${ip}`, {
                limit: verify ? 10 : 30,
                windowMs: 60_000,
              });
              if (!limit.allowed) {
                throw new APIError("TOO_MANY_REQUESTS", {
                  code: "RATE_LIMITED",
                  message: "Too many attempts. Try again in a minute.",
                });
              }
              if (ctx.path === AUTHENTICATE_OPTIONS || ctx.path === AUTHENTICATE) return;
              if (!WRITES.has(ctx.path) && ctx.path !== LIST) return;
              // Always re-read the store: both credential writes and listing must reject a revoked cookie cache.
              const current = await getAuthoritativeSessionFromCtx(ctx);
              if (!current || current.session.expiresAt <= new Date()) {
                throw new APIError("UNAUTHORIZED", {
                  code: "UNAUTHORIZED",
                  message: "Sign in again to manage your passkeys.",
                });
              }
              if (await accountBlock(db, current.user.id)) {
                throw new APIError("FORBIDDEN", { code: "ACCOUNT_BLOCKED", message: "This account can't sign in." });
              }
              if (WRITES.has(ctx.path)) {
                const age = Date.now() - new Date(current.session.createdAt).getTime();
                if (!Number.isFinite(age) || age < 0 || age >= FRESH_SIGN_IN_MS) {
                  throw new APIError("FORBIDDEN", {
                    code: "PASSKEY_REAUTH_REQUIRED",
                    message: "Sign in again to manage your passkeys.",
                  });
                }
              }
              // Registering another key does not turn an existing session into a fresh sign-in.
              if (ctx.path === REGISTER && ctx.body?.createSession) {
                throw new APIError("BAD_REQUEST", {
                  code: "PASSKEY_REGISTRATION_SESSION_NOT_ALLOWED",
                  message: "Register this passkey without creating a new session.",
                });
              }
            }),
          },
        ],
        after: [
          {
            matcher: (ctx: { path?: string }) => ctx.path === REGISTER_OPTIONS || ctx.path === AUTHENTICATE_OPTIONS,
            handler: createAuthMiddleware(async (ctx) => {
              const returned = ctx.context.returned as {
                user?: { id: string };
                challenge?: string;
                allowCredentials?: unknown[];
              } | null;
              if (ctx.path === AUTHENTICATE_OPTIONS && returned?.challenge) {
                // An allow-list permits a null userHandle. Keep reauthentication discoverable too
                // so every assertion must identify the account (WebAuthn section 6.3.3, ADR 0209).
                returned.allowCredentials = [];
                return;
              }
              const accountId = ctx.context.session?.user.id;
              if (returned?.user && returned.challenge && accountId) {
                returned.user.id = userHandle(accountId);
              }
            }),
          },
        ],
      },
    },
  ];
}
