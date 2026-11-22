import type { AuthClient, AuthResult, PasskeySummary } from "@/auth/client";

/** A call's arguments, with the bot check's token only when one was sent. */
const withToken = (input: unknown, humanCheck: string | undefined) =>
  humanCheck === undefined ? [input] : [input, humanCheck];

export function createFakeAuth(
  options: {
    signIn?: AuthResult;
    signUp?: AuthResult;
    passkeySignIn?: AuthResult;
    addPasskey?: AuthResult;
    passkeys?: PasskeySummary[];
    listPasskeys?: Extract<AuthResult, { ok: false }>;
    renamePasskey?: AuthResult;
    deletePasskey?: AuthResult;
    reset?: AuthResult;
    redeem?: boolean;
    open?: { requestId: string; code: string } | null;
    requestCode?: string | null;
    oneTime?: AuthResult;
    claim?: AuthResult;
    verification?: AuthResult;
    updateName?: AuthResult;
    changeEmail?: AuthResult;
    onSignIn?: () => void;
  } = {},
) {
  const calls: { method: string; args: unknown[] }[] = [];
  let passkeys = options.passkeys ?? [];
  const auth: AuthClient = {
    signInPasskey: async () => {
      calls.push({ method: "signInPasskey", args: [] });
      const result = options.passkeySignIn ?? { ok: true };
      if (result.ok) options.onSignIn?.();
      return result;
    },
    addPasskey: async () => {
      calls.push({ method: "addPasskey", args: [] });
      const result = options.addPasskey ?? { ok: true };
      if (result.ok)
        passkeys = [
          ...passkeys,
          {
            id: "new-passkey",
            name: null,
            createdAt: "2026-11-21T12:00:00.000Z",
            deviceType: "multiDevice",
            backedUp: true,
          },
        ];
      return result;
    },
    listPasskeys: async () => {
      calls.push({ method: "listPasskeys", args: [] });
      return options.listPasskeys ?? { ok: true, passkeys };
    },
    renamePasskey: async (id, name) => {
      calls.push({ method: "renamePasskey", args: [id, name] });
      const result = options.renamePasskey ?? { ok: true };
      if (result.ok) passkeys = passkeys.map((key) => (key.id === id ? { ...key, name } : key));
      return result;
    },
    deletePasskey: async (id) => {
      calls.push({ method: "deletePasskey", args: [id] });
      const result = options.deletePasskey ?? { ok: true };
      if (result.ok) passkeys = passkeys.filter((key) => key.id !== id);
      return result;
    },
    signIn: async (input, humanCheck) => {
      calls.push({ method: "signIn", args: withToken(input, humanCheck) });
      const result = options.signIn ?? { ok: true };
      if (result.ok) options.onSignIn?.();
      return result;
    },
    signUp: async (input, humanCheck) => {
      calls.push({ method: "signUp", args: withToken(input, humanCheck) });
      return options.signUp ?? { ok: true };
    },
    updateName: async (name) => {
      calls.push({ method: "updateName", args: [name] });
      return options.updateName ?? { ok: true };
    },
    changeEmail: async (email) => {
      calls.push({ method: "changeEmail", args: [email] });
      return options.changeEmail ?? { ok: true };
    },
    sendVerificationEmail: async (email) => {
      calls.push({ method: "sendVerificationEmail", args: [email] });
      return options.verification ?? { ok: true };
    },
    signInSocial: async (provider, callbackURL, earlyAccess, errorCallbackURL) => {
      calls.push({
        method: "signInSocial",
        args: errorCallbackURL
          ? [provider, callbackURL, earlyAccess, errorCallbackURL]
          : earlyAccess
            ? [provider, callbackURL, earlyAccess]
            : [provider, callbackURL],
      });
      return { ok: true };
    },
    requestPasswordReset: async (input, humanCheck) => {
      calls.push({ method: "requestPasswordReset", args: withToken(input, humanCheck) });
      return { ok: true };
    },
    resetPassword: async (input) => {
      calls.push({ method: "resetPassword", args: [input] });
      return options.reset ?? { ok: true };
    },
    signOut: async () => {
      calls.push({ method: "signOut", args: [] });
    },
    desktopOpen: async (challenge) => {
      calls.push({ method: "desktopOpen", args: [challenge] });
      return options.open === undefined ? { requestId: "r".repeat(43), code: "KQ7M-3XPF" } : options.open;
    },
    desktopRequestCode: async (requestId) => {
      calls.push({ method: "desktopRequestCode", args: [requestId] });
      return options.requestCode === undefined ? "KQ7M-3XPF" : options.requestCode;
    },
    desktopHandoff: async (requestId) => {
      calls.push({ method: "desktopHandoff", args: [requestId] });
      return { ok: true };
    },
    desktopRedeem: async (verifier) => {
      calls.push({ method: "desktopRedeem", args: [verifier] });
      return options.redeem ?? false;
    },
    signInOneTime: async (token) => {
      calls.push({ method: "signInOneTime", args: [token] });
      return options.oneTime ?? { ok: true };
    },
    ownerClaim: async (input) => {
      calls.push({ method: "ownerClaim", args: [input] });
      return options.claim ?? { ok: true };
    },
  };
  return { auth, calls };
}
