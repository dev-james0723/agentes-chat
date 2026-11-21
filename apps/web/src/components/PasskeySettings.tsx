import { useAuthConfig, useMe } from "@agenteschat/client";
import { Button, Field, Input } from "@agenteschat/ui";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AuthResult } from "@/auth/client";
import { useAuth } from "@/auth/context";
import { passkeyErrorText, passkeyNeedsSignIn, passkeyOrigin } from "@/auth/passkeys";
import { AuthShell } from "@/components/AuthLayout";
import { BROWSER_SIGN_IN_PATH, inDesktopApp, passkeyManagementUrl } from "@/lib/desktop";

const MANAGEMENT_RETURN = `${BROWSER_SIGN_IN_PATH}?mode=passkeys`;
const NETWORK_ERROR: Extract<AuthResult, { ok: false }> = { ok: false, status: 0, code: "network", message: "" };

class PasskeyRefused extends Error {
  constructor(readonly result: Extract<AuthResult, { ok: false }>) {
    super(result.code);
  }
}

/** Credential management shared by Account settings and the external browser's standalone page. */
export function PasskeySettings({
  accountId,
  accountEmail,
  onSignInAgain,
}: {
  accountId: string;
  accountEmail: string;
  onSignInAgain: () => void;
}) {
  const { t, i18n } = useTranslation();
  const auth = useAuth();
  const list = useQuery({
    queryKey: ["account-passkeys", accountId],
    queryFn: async () => {
      const result = await auth.listPasskeys();
      if (!result.ok) throw new PasskeyRefused(result);
      return result.passkeys;
    },
    retry: false,
    staleTime: 0,
  });
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<Extract<AuthResult, { ok: false }> | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [name, setName] = useState("");
  const listFailure = list.error instanceof PasskeyRefused ? list.error.result : list.error ? NETWORK_ERROR : null;
  // React Query retains its previous data after a failed refetch. A revoked/blocked session must not keep
  // showing those credential names or controls. Freshness-only refusals still allow the owner's list.
  const unauthorized = [error, listFailure].find(
    (result) =>
      result?.status === 401 ||
      (result?.status === 403 && result.code !== "PASSKEY_REAUTH_REQUIRED" && result.code !== "SESSION_NOT_FRESH"),
  );
  const failure = unauthorized ?? error ?? listFailure;

  const change = async (action: "added" | "renamed" | "removed", call: () => Promise<AuthResult>) => {
    if (working) return;
    setWorking(action);
    setError(null);
    setNotice(null);
    try {
      const result = await call();
      if (!result.ok) {
        setError(result);
        return;
      }
      setEditing(null);
      setRemoving(null);
      setNotice(t(`auth.passkey.${action}`));
      await list.refetch();
    } catch {
      setError(NETWORK_ERROR);
    } finally {
      setWorking(null);
    }
  };

  return (
    <div className="passkeys">
      <p className="passkeys__account">{t("auth.passkey.account", { email: accountEmail })}</p>
      <p className="muted">{t("auth.passkey.settingsHelp")}</p>
      {failure && (
        <div className="passkeys__feedback">
          <p className="auth__error" role="alert">
            {passkeyErrorText(t, failure, true)}
          </p>
          {passkeyNeedsSignIn(failure) ? (
            <Button onClick={onSignInAgain} disabled={!!working}>
              {t("auth.passkey.signInAgain")}
            </Button>
          ) : list.isError ? (
            <Button onClick={() => void list.refetch()} disabled={!!working}>
              {t("auth.passkey.retry")}
            </Button>
          ) : null}
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      {unauthorized ? null : list.isPending ? (
        <p role="status">{t("common.loading")}</p>
      ) : list.data?.length === 0 ? (
        <p className="muted">{t("auth.passkey.empty")}</p>
      ) : (
        <ul className="passkeys__list" aria-label={t("auth.passkey.title")}>
          {(list.data ?? []).map((key) => {
            const label = key.name || t("auth.passkey.unnamed");
            const created = key.createdAt ? new Date(key.createdAt) : null;
            const date =
              created && !Number.isNaN(created.getTime())
                ? new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium" }).format(created)
                : null;
            return (
              <li key={key.id} className="passkeys__item">
                <div className="passkeys__details">
                  <strong>{label}</strong>
                  {date && <span className="small muted">{t("auth.passkey.created", { date })}</span>}
                  <span className="small muted">
                    {t(key.deviceType === "multiDevice" ? "auth.passkey.multiDevice" : "auth.passkey.singleDevice")}
                  </span>
                  <span className="small muted">
                    {t(key.backedUp ? "auth.passkey.backedUp" : "auth.passkey.notBackedUp")}
                  </span>
                </div>
                {editing === key.id ? (
                  <form
                    className="passkeys__edit"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (name.trim() && name.trim().length <= 100)
                        void change("renamed", () => auth.renamePasskey(key.id, name.trim()));
                    }}
                  >
                    <Field label={t("auth.passkey.nameLabel")} id={`passkey-name-${key.id}`}>
                      <Input
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        maxLength={100}
                        autoFocus
                        disabled={!!working}
                        autoComplete="off"
                      />
                    </Field>
                    <div className="passkeys__actions">
                      <Button type="submit" disabled={!name.trim() || !!working}>
                        {t("common.save")}
                      </Button>
                      <Button type="button" onClick={() => setEditing(null)} disabled={!!working}>
                        {t("common.cancel")}
                      </Button>
                    </div>
                  </form>
                ) : removing === key.id ? (
                  <fieldset className="passkeys__edit" aria-label={t("auth.passkey.removeConfirm", { name: label })}>
                    <p>{t("auth.passkey.removeHelp", { name: label })}</p>
                    <div className="passkeys__actions">
                      <Button
                        variant="danger"
                        onClick={() => void change("removed", () => auth.deletePasskey(key.id))}
                        disabled={!!working}
                      >
                        {t("auth.passkey.remove")}
                      </Button>
                      <Button onClick={() => setRemoving(null)} disabled={!!working}>
                        {t("common.cancel")}
                      </Button>
                    </div>
                  </fieldset>
                ) : (
                  <div className="passkeys__actions">
                    <Button
                      size="sm"
                      onClick={() => {
                        setEditing(key.id);
                        setRemoving(null);
                        setName(key.name ?? "");
                      }}
                      aria-label={t("auth.passkey.renameNamed", { name: label })}
                      disabled={!!working}
                    >
                      {t("auth.passkey.rename")}
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => {
                        setRemoving(key.id);
                        setEditing(null);
                      }}
                      aria-label={t("auth.passkey.removeNamed", { name: label })}
                      disabled={!!working}
                    >
                      {t("auth.passkey.remove")}
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <Button
        icon="plus"
        onClick={() => void change("added", () => auth.addPasskey())}
        loading={working === "added"}
        disabled={!!working || list.isPending || list.isError || !!unauthorized}
      >
        {t("auth.passkey.add")}
      </Button>
      {working && <p role="status">{t(working === "added" ? "auth.passkey.verifying" : "auth.passkey.saving")}</p>}
    </div>
  );
}

/** A normal authenticated browser page on the same canonical origin used by credential ceremonies. */
export function PasskeyManagementPage() {
  const { t } = useTranslation();
  const config = useAuthConfig();
  const me = useMe();
  const navigate = useNavigate();
  const origin = passkeyOrigin(config.data);
  const here = origin === window.location.origin && !inDesktopApp();
  useEffect(() => {
    if (here && me.isSuccess && !me.data) {
      void navigate({ to: "/login", replace: true, search: { redirect: MANAGEMENT_RETURN } });
    }
  }, [here, me.isSuccess, me.data, navigate]);
  const signInAgain = () =>
    void navigate({
      to: "/login",
      search: { redirect: MANAGEMENT_RETURN, reauthenticate: "1" },
    });

  return (
    <AuthShell>
      <div className="auth__form">
        <h1 className="auth__title">{t("auth.passkey.title")}</h1>
        {config.isPending || me.isPending ? (
          <p role="status">{t("common.loading")}</p>
        ) : !origin ? (
          <p role="status">{t("auth.passkey.unavailable")}</p>
        ) : !here ? (
          <>
            <p>{t("auth.passkey.canonicalRequired")}</p>
            <a className="ac-link" href={passkeyManagementUrl(origin)}>
              {t("auth.passkey.openCanonical")}
            </a>
          </>
        ) : me.isError ? (
          <div className="passkeys__feedback">
            <p role="alert">{passkeyErrorText(t, NETWORK_ERROR)}</p>
            <Button onClick={() => void me.refetch()}>{t("auth.passkey.retry")}</Button>
          </div>
        ) : me.data ? (
          <PasskeySettings accountId={me.data.user.id} accountEmail={me.data.user.email} onSignInAgain={signInAgain} />
        ) : (
          <p role="status">{t("common.loading")}</p>
        )}
        <Link to="/" className="auth__quiet">
          {t("auth.passkey.back")}
        </Link>
      </div>
    </AuthShell>
  );
}
