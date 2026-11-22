import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent } from "@testing-library/react";
import type { PasskeySummary } from "@/auth/client";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { createFakeAuth } from "./fake-auth";
import { renderApp, screen, settle } from "./render";

const management = "/desktop/sign-in?mode=passkeys";
const app = () => window as { __agentesDesktop?: unknown };
const key: PasskeySummary = {
  id: "key-1",
  name: "MacBook",
  createdAt: "2026-11-20T12:00:00.000Z",
  deviceType: "multiDevice",
  backedUp: true,
};
const stateWithPasskeys = () =>
  seedState({
    authConfig: { passkeys: { enabled: true, origin: window.location.origin } },
    signInOptions: { account: true, password: true, providers: [], canSignUp: false },
  });
const press = async (name: string | RegExp) => {
  await act(async () => fireEvent.click(screen().getByRole("button", { name })));
  await settle(6);
};
const type = async (label: string, value: string) =>
  act(async () => fireEvent.change(screen().getByLabelText(label), { target: { value } }));

afterEach(() => {
  cleanup();
  delete app().__agentesDesktop;
  sessionStorage.clear();
});

describe("passkey settings", () => {
  test("shows the current account and metadata, adds without a nickname, then renames and explicitly removes", async () => {
    const state = stateWithPasskeys();
    const { auth, calls } = createFakeAuth({ passkeys: [key] });
    await renderApp(management, { api: createFakeApi(state), auth });
    expect(screen().getByText(`Chaves de acesso de ${state.me?.user.email}`)).toBeTruthy();
    expect(screen().getByText("MacBook")).toBeTruthy();
    expect(screen().getByText("Pode sincronizar entre seus dispositivos")).toBeTruthy();
    expect(screen().getByText("Com backup no provedor da chave de acesso")).toBeTruthy();
    expect(calls).toEqual([{ method: "listPasskeys", args: [] }]);

    await press("Adicionar chave de acesso");
    expect(calls.find((call) => call.method === "addPasskey")).toEqual({ method: "addPasskey", args: [] });
    expect(screen().getByRole("status").textContent).toContain("Chave de acesso adicionada");
    await press("Renomear MacBook");
    expect(document.activeElement).toBe(screen().getByLabelText("Nome da chave de acesso"));
    await type("Nome da chave de acesso", "Office key");
    await press("Salvar");
    expect(calls.find((call) => call.method === "renamePasskey")).toEqual({
      method: "renamePasskey",
      args: ["key-1", "Office key"],
    });
    expect(screen().getByText("Office key")).toBeTruthy();
    await press("Remover Office key");
    expect(calls.some((call) => call.method === "deletePasskey")).toBe(false);
    await press("Remover chave de acesso");
    expect(calls.find((call) => call.method === "deletePasskey")).toEqual({ method: "deletePasskey", args: ["key-1"] });
    expect(screen().queryByText("Office key")).toBeNull();
    expect(calls.some((call) => call.method.startsWith("desktop"))).toBe(false);
  });

  test("a stale session goes through a real sign-in and returns, without signing any session out", async () => {
    const state = stateWithPasskeys();
    const originalUser = state.me?.user.id;
    let stale = true;
    const { auth, calls } = createFakeAuth({
      passkeys: [key],
      onSignIn: () => {
        stale = false;
      },
    });
    auth.addPasskey = async () => {
      calls.push({ method: "addPasskey", args: [] });
      return stale ? { ok: false, status: 403, code: "PASSKEY_REAUTH_REQUIRED", message: "" } : { ok: true };
    };
    const { router } = await renderApp(management, { api: createFakeApi(state), auth });
    await press("Adicionar chave de acesso");
    expect(screen().getByRole("alert").textContent).toBe("Entre de novo antes de alterar suas chaves de acesso.");
    await press("Entrar de novo");
    expect(router.state.location.pathname).toBe("/login");
    expect(router.state.location.search).toMatchObject({ redirect: management, reauthenticate: "1" });
    expect(state.me?.user.id).toBe(originalUser);
    expect(stale).toBe(true);
    expect(calls.some((call) => call.method === "signOut" || call.method === "signIn")).toBe(false);
    await type("E-mail", "ana@example.com");
    await press(/^Continuar(?! com)/);
    await type("Senha", "correct horse");
    await press(/^Entrar$/);
    expect(calls.filter((call) => call.method === "signIn")).toHaveLength(1);
    expect(stale).toBe(false);
    expect(router.state.location.pathname).toBe("/desktop/sign-in");
    expect(router.state.location.search).toEqual({ mode: "passkeys" });
    await press("Adicionar chave de acesso");
    expect(screen().queryByRole("alert")).toBeNull();
    expect(calls.some((call) => call.method === "signOut")).toBe(false);
  });

  test("a revoked session exposes no credentials and offers sign-in again", async () => {
    const { auth, calls } = createFakeAuth({
      listPasskeys: { ok: false, status: 401, code: "UNAUTHORIZED", message: "" },
    });
    await renderApp(management, { api: createFakeApi(stateWithPasskeys()), auth });
    expect(screen().getByRole("alert").textContent).toBe(
      "Sua sessão terminou. Entre de novo para gerenciar suas chaves de acesso.",
    );
    expect(screen().getByRole("button", { name: "Entrar de novo" })).toBeTruthy();
    expect(screen().queryByText("MacBook") === null).toBe(true);
    expect(calls).toEqual([{ method: "listPasskeys", args: [] }]);
  });

  test("a signed-out management visit returns here through normal login and never opens a handoff", async () => {
    const state = stateWithPasskeys();
    state.me = null;
    const { auth, calls } = createFakeAuth();
    const { router } = await renderApp(`${management}&provider=github&request=${"r".repeat(43)}&done=1`, {
      api: createFakeApi(state),
      auth,
    });
    expect(router.state.location.pathname).toBe("/login");
    expect(router.state.location.search.redirect).toBe(management);
    expect(calls).toEqual([]);
  });

  test("cancelled enrollment stays usable and can be retried", async () => {
    const { auth, calls } = createFakeAuth({
      addPasskey: { ok: false, status: 400, code: "AUTH_CANCELLED", message: "raw device text" },
    });
    await renderApp(management, { api: createFakeApi(stateWithPasskeys()), auth });
    await press("Adicionar chave de acesso");
    expect(screen().getByRole("alert").textContent).toContain("A verificação foi cancelada.");
    expect(document.body.textContent).not.toContain("raw device text");
    expect(screen().getByRole("button", { name: "Adicionar chave de acesso" }).hasAttribute("disabled")).toBe(false);
    await press("Adicionar chave de acesso");
    expect(calls.filter((call) => call.method === "addPasskey")).toHaveLength(2);
  });

  test("a failed list can be retried without presenting an empty credential list", async () => {
    const { auth, calls } = createFakeAuth();
    let fails = true;
    auth.listPasskeys = async () => {
      calls.push({ method: "listPasskeys", args: [] });
      return fails ? { ok: false, status: 0, code: "network", message: "" } : { ok: true, passkeys: [key] };
    };
    await renderApp(management, { api: createFakeApi(stateWithPasskeys()), auth });
    expect(screen().getByRole("alert")).toBeTruthy();
    expect(screen().queryByText("Você ainda não adicionou nenhuma chave de acesso.")).toBeNull();
    fails = false;
    await press("Tentar de novo");
    expect(screen().getByText("MacBook")).toBeTruthy();
  });

  test("canonical browser Account settings opens the management dialog", async () => {
    const { auth, calls } = createFakeAuth({ passkeys: [key] });
    await renderApp(`/org/${ORG_ID}/settings/account`, { api: createFakeApi(stateWithPasskeys()), auth });
    await press(/Chaves de acesso/);
    expect(screen().getByRole("dialog", { name: "Chaves de acesso" })).toBeTruthy();
    expect(screen().getByText("MacBook")).toBeTruthy();
    expect(calls).toEqual([{ method: "listPasskeys", args: [] }]);
  });

  test("desktop and local-alias settings use the exact external route on the canonical origin", async () => {
    for (const desktop of [true, false]) {
      const state = stateWithPasskeys();
      const origin = desktop ? window.location.origin : "https://auth.example.com";
      state.authConfig = { passkeys: { enabled: true, origin } };
      if (desktop) app().__agentesDesktop = { version: "0.6.0" };
      const { auth, calls } = createFakeAuth();
      const assign = spyOn(window.location, "assign").mockImplementation(() => {});
      try {
        await renderApp(`/org/${ORG_ID}/settings/account`, { api: createFakeApi(state), auth });
        await press(/Chaves de acesso/);
        expect(assign).toHaveBeenCalledWith(`${origin}${management}`);
        expect(screen().queryByRole("dialog", { name: "Chaves de acesso" })).toBeNull();
        expect(calls).toEqual([]);
      } finally {
        assign.mockRestore();
        cleanup();
        delete app().__agentesDesktop;
      }
    }
  });

  test("unknown management modes cannot be turned into a handoff or ceremony", async () => {
    const { auth, calls } = createFakeAuth();
    await renderApp(`/desktop/sign-in?mode=other&provider=passkey&request=${"r".repeat(43)}&done=1`, {
      api: createFakeApi(stateWithPasskeys()),
      auth,
    });
    expect(screen().getByRole("heading").textContent).toBe("Esse pedido expirou.");
    expect(calls).toEqual([]);
  });

  test("reauthentication does not allow an external return URL", async () => {
    const { auth, calls } = createFakeAuth();
    const { router } = await renderApp("/login?reauthenticate=1&redirect=https%3A%2F%2Fevil.example", {
      api: createFakeApi(stateWithPasskeys()),
      auth,
    });
    expect(router.state.location.pathname).toBe("/login");
    expect(router.state.matches.at(-1)?.search).toMatchObject({ redirect: undefined });
    expect(calls).toEqual([]);
  });
});

test("an older server exposes neither a settings entry nor credential-management actions", async () => {
  const { auth, calls } = createFakeAuth();
  const api = createFakeApi(seedState());
  await renderApp(`/org/${ORG_ID}/settings/account`, { api, auth });
  expect(screen().queryByRole("button", { name: /Chaves de acesso/ })).toBeNull();
  cleanup();
  await renderApp(management, { api, auth });
  expect(screen().getByRole("status").textContent).toContain("não estão disponíveis");
  expect(screen().queryByRole("button", { name: "Adicionar chave de acesso" })).toBeNull();
  expect(calls).toEqual([]);
});

test("cached credential metadata disappears if a refresh discovers a revoked or blocked session", async () => {
  for (const status of [401, 403]) {
    const state = stateWithPasskeys();
    const { auth } = createFakeAuth();
    let refused = false;
    auth.listPasskeys = async () =>
      refused
        ? { ok: false, status, code: status === 401 ? "UNAUTHORIZED" : "ACCOUNT_BLOCKED", message: "" }
        : { ok: true, passkeys: [key] };
    const { services } = await renderApp(management, { api: createFakeApi(state), auth });
    expect(screen().getByText("MacBook")).toBeTruthy();
    refused = true;
    await act(async () => {
      await services.queryClient.invalidateQueries({ queryKey: ["account-passkeys"] });
    });
    await settle(4);
    expect(screen().getByRole("alert")).toBeTruthy();
    expect(screen().queryByText("MacBook") === null).toBe(true);
    expect(screen().queryByRole("button", { name: "Renomear MacBook" })).toBeNull();
    expect(screen().getByRole("button", { name: "Adicionar chave de acesso" }).hasAttribute("disabled")).toBe(true);
    cleanup();
  }
});
