import { useAuthConfig } from "@agenteschat/client";
import { authErrorText, signInRefusalText } from "@agenteschat/client/lib/errors";
import { Button } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/auth/context";
import { passkeyErrorText, passkeyOrigin } from "@/auth/passkeys";
import { AgentAvatar } from "@/components/AgentAvatar";
import { AuthShell } from "@/components/AuthLayout";
import { PasskeyManagementPage } from "@/components/PasskeySettings";
import { BROWSER_SIGN_IN_PATH, browserSignInUrl, type DesktopSignInMethod } from "@/lib/desktop";

type DesktopSignInProps = {
  provider?: DesktopSignInMethod;
  request?: string;
  done: boolean;
  error?: string;
  access?: string;
  mode?: "passkeys";
};

/** The management branch never creates or redeems a desktop handoff request. */
export function DesktopSignInPage(props: DesktopSignInProps) {
  return props.mode === "passkeys" ? <PasskeyManagementPage /> : <DesktopHandoffPage {...props} />;
}

/**
 * In the external browser, for the app: social sign-in redirects; passkeys wait for a deliberate click.
 * Both read the same pending request and require explicit matching-code confirmation before handing over.
 */
function DesktopHandoffPage({ provider, request, done, error, access }: DesktopSignInProps) {
  const { t } = useTranslation();
  const auth = useAuth();
  const config = useAuthConfig();
  const canReset = config.data?.passwordReset === true;
  const credentialOrigin = passkeyOrigin(config.data);
  const [state, setState] = useState<"opening" | "passkey" | "confirm" | "done" | "expired" | "refused">("opening");
  const [code, setCode] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (error) {
      setState("refused");
      return;
    }
    if (!provider || !request) {
      setState("expired");
      return;
    }
    if (!done) {
      if (provider === "passkey") {
        setState("passkey");
        return;
      }
      const back = `${BROWSER_SIGN_IN_PATH}?${new URLSearchParams({ provider, request, done: "1" })}`;
      const refused = browserSignInUrl(provider, request);
      void auth.signInSocial(provider, back, access, refused).then((r) => {
        if (!r.ok) setState("expired");
      });
      return;
    }
    void auth.desktopRequestCode(request).then((c) => {
      if (!c) setState("expired");
      else {
        setCode(c);
        setState("confirm");
      }
    });
  }, [auth, provider, request, done, error, access]);

  const signIn = async () => {
    if (!request || working || credentialOrigin !== window.location.origin) return;
    setWorking(true);
    setPasskeyError(null);
    try {
      const result = await auth.signInPasskey();
      if (!result.ok) {
        setPasskeyError(passkeyErrorText(t, result));
        return;
      }
      const nextCode = await auth.desktopRequestCode(request);
      if (!nextCode) setState("expired");
      else {
        setCode(nextCode);
        setState("confirm");
      }
    } catch {
      setPasskeyError(authErrorText(t, { status: 0, code: "network", message: "" }));
    } finally {
      setWorking(false);
    }
  };

  const confirm = async () => {
    if (!request || working) return;
    setWorking(true);
    const r = await auth.desktopHandoff(request).catch(() => ({ ok: false }));
    setState(r.ok ? "done" : "expired");
    setWorking(false);
  };

  const name = provider === "passkey" ? t("auth.passkey.name") : provider ? t(`auth.provider.${provider}`) : "";
  const [title, lead] =
    state === "done"
      ? [t("auth.desktop.done"), t("auth.desktop.doneLead")]
      : state === "confirm"
        ? [t("auth.desktop.confirm"), t("auth.desktop.confirmLead")]
        : state === "expired"
          ? [t("auth.desktop.expired"), t("auth.desktop.expiredLead", { provider: name })]
          : state === "refused" && error
            ? [t("auth.desktop.refused"), `${signInRefusalText(t, error, canReset)} ${t("auth.desktop.refusedLead")}`]
            : state === "passkey"
              ? [t("auth.passkey.signIn"), t("auth.passkey.help")]
              : [t("auth.desktop.opening", { provider: name }), ""];

  const passwordReturn = request ? `${browserSignInUrl("passkey", request)}&done=1` : "/";

  return (
    <AuthShell>
      <div className="auth__form">
        <header className="auth__ask">
          <AgentAvatar
            name="agentes.chat"
            size="lg"
            state={state === "opening" || working ? "writing" : undefined}
            expression={state === "done" ? "happy" : undefined}
          />
          <div className="auth__bubble" key={state} aria-live="polite">
            <h1 className="auth__title">{title}</h1>
            {lead && <p className="auth__lead">{lead}</p>}
          </div>
        </header>
        {state === "passkey" && request && (
          <div className="auth__step">
            {credentialOrigin === window.location.origin ? (
              <Button type="button" size="lg" block icon="key" onClick={() => void signIn()} loading={working}>
                {t("auth.passkey.signIn")}
              </Button>
            ) : credentialOrigin ? (
              <a className="ac-link" href={browserSignInUrl("passkey", request, undefined, credentialOrigin)}>
                {t("auth.passkey.openCanonical")}
              </a>
            ) : (
              !config.isPending && <p role="status">{t("auth.passkey.unavailable")}</p>
            )}
            {passkeyError && (
              <p className="auth__error" role="alert">
                {passkeyError}
              </p>
            )}
            <Link
              to="/login"
              search={{ redirect: passwordReturn, reauthenticate: "1" }}
              className="auth__quiet"
              disabled={working}
            >
              {t("auth.passkey.passwordFallback")}
            </Link>
          </div>
        )}
        {state === "confirm" && code && (
          <div className="auth__step">
            <div className="auth__code">
              <span className="auth__codeValue">{code}</span>
            </div>
            <Button type="button" size="lg" block onClick={() => void confirm()} disabled={working}>
              {t("auth.desktop.confirmYes")}
            </Button>
            <button type="button" className="auth__quiet" onClick={() => setState("expired")} disabled={working}>
              {t("auth.desktop.confirmNo")}
            </button>
          </div>
        )}
      </div>
    </AuthShell>
  );
}
