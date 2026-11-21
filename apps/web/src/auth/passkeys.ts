import type { AuthConfig } from "@agenteschat/client";
import { authErrorText } from "@agenteschat/client/lib/errors";
import type { TFunction } from "i18next";
import type { AuthResult } from "./client";

/** The server's single relying-party origin, never a return URL supplied by a page. */
export function passkeyOrigin(config: Pick<AuthConfig, "passkeys"> | undefined): string | null {
  const origin = config?.passkeys?.enabled ? config.passkeys.origin : null;
  if (!origin) return null;
  try {
    const url = new URL(origin);
    if (url.origin !== origin || url.username || url.password) return null;
    const host = url.hostname;
    const dnsName =
      host.length <= 253 &&
      host.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) &&
      !/^\d+\.\d+\.\d+\.\d+$/.test(host);
    const secure = url.protocol === "https:" && dnsName;
    const local = url.protocol === "http:" && host === "localhost";
    return secure || local ? url.origin : null;
  } catch {
    return null;
  }
}

export const passkeyNeedsSignIn = (result: Extract<AuthResult, { ok: false }>) =>
  result.status === 401 || result.code === "PASSKEY_REAUTH_REQUIRED" || result.code === "SESSION_NOT_FRESH";

/** Authenticator refusals have stable, translated recovery text, without exposing raw device errors. */
export function passkeyErrorText(t: TFunction, result: Extract<AuthResult, { ok: false }>, management = false): string {
  if (result.code === "PASSKEY_REAUTH_REQUIRED" || result.code === "SESSION_NOT_FRESH")
    return t("auth.passkey.signInAgainHelp");
  if (result.status === 401) return t(management ? "auth.passkey.signedOut" : "auth.passkey.failed");
  if (
    [
      "passkey_cancelled",
      "AUTH_CANCELLED",
      "REGISTRATION_CANCELLED",
      "ERROR_CEREMONY_ABORTED",
      "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY",
    ].includes(result.code ?? "")
  )
    return t("auth.passkey.cancelled");
  if (
    [
      "passkey_unsupported",
      "ERROR_BROWSER_NOT_SUPPORTED",
      "ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT",
      "ERROR_AUTHENTICATOR_NO_SUPPORTED_PUBKEYCREDPARAMS_ALG",
      "ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL_SUPPORT",
    ].includes(result.code ?? "")
  )
    return t("auth.passkey.unsupported");
  if (result.code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED" || result.code === "PREVIOUSLY_REGISTERED")
    return t("auth.passkey.alreadyAdded");
  if (result.code === "PASSKEY_ORIGIN_REQUIRED" || result.code === "ERROR_INVALID_RP_ID")
    return t("auth.passkey.canonicalRequired");
  if (result.status === 404) return t("auth.passkey.unavailable");
  if (result.code?.startsWith("ERROR_") || result.code === "UNKNOWN_ERROR") return t("auth.passkey.failed");
  return authErrorText(t, result);
}
