import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent } from "@testing-library/react";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { createFakeAuth } from "./fake-auth";
import { renderApp, screen, settle } from "./render";

const app = () => window as { __agentesDesktop?: unknown };
const PASSKEY = "Entrar com uma chave de acesso";
const CANCELLED = "A verificação foi cancelada. Tente de novo ou entre com e-mail e senha.";
const request = "r".repeat(43);

afterEach(() => {
  cleanup();
  delete app().__agentesDesktop;
  sessionStorage.clear();
});

const press = async (name: string | RegExp) => {
  await act(async () => fireEvent.click(screen().getByRole("button", { name })));
  await settle(6);
};
const stateWithPasskeys = (signedIn = false) =>
  seedState({
    ...(signedIn ? {} : { me: null }),
    authConfig: { passkeys: { enabled: true, origin: window.location.origin } },
    signInOptions: { account: true, password: true, providers: [], canSignUp: false },
  });

describe("passkey login", () => {
  test("offers a deliberate action before email, and enters the requested page without an email lookup", async () => {
    const state = stateWithPasskeys();
    const { auth, calls } = createFakeAuth();
    auth.signInPasskey = async () => {
      calls.push({ method: "signInPasskey", args: [] });
      state.me = seedState().me;
      return { ok: true };
    };
    const { router } = await renderApp(`/login?redirect=/org/${ORG_ID}/drive`, {
      api: createFakeApi(state),
      auth,
    });
    const button = screen().getByRole("button", { name: PASSKEY });
    const email = screen().getByLabelText("E-mail") as HTMLInputElement;
    expect(button.compareDocumentPosition(email) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(calls).toEqual([]);
    expect(email.value).toBe("");
    await press(PASSKEY);
    expect(calls).toEqual([{ method: "signInPasskey", args: [] }]);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/drive`);
    expect(state.calls.some((call) => call.method === "account.signInOptions")).toBe(false);
  });

  test("cancel can be retried and keeps accessible email/password fallback", async () => {
    const state = stateWithPasskeys();
    const { auth, calls } = createFakeAuth();
    auth.signInPasskey = async () => {
      calls.push({ method: "signInPasskey", args: [] });
      return { ok: false, status: 0, code: "passkey_cancelled", message: "" };
    };
    await renderApp("/login", { api: createFakeApi(state), auth });
    await press(PASSKEY);
    expect(screen().getByRole("alert").textContent).toContain(CANCELLED);
    expect(screen().getByLabelText("E-mail").getAttribute("aria-invalid")).toBeNull();
    expect(screen().getByRole("button", { name: PASSKEY }).hasAttribute("disabled")).toBe(false);
    await press(PASSKEY);
    expect(calls.filter((call) => call.method === "signInPasskey")).toHaveLength(2);
    await press("Usar e-mail e senha");
    expect(document.activeElement).toBe(screen().getByLabelText("E-mail"));
    await act(async () =>
      fireEvent.change(screen().getByLabelText("E-mail"), { target: { value: "ana@example.com" } }),
    );
    await press(/^Continuar(?! com)/);
    expect(screen().getByLabelText("Senha")).toBeTruthy();
  });

  test("older and disabled servers retain the current sign-in screen", async () => {
    for (const passkeys of [undefined, { enabled: false, origin: null }]) {
      await renderApp("/login", { api: createFakeApi(seedState({ me: null, authConfig: { passkeys } })) });
      expect(screen().queryByRole("button", { name: PASSKEY })).toBeNull();
      expect(screen().getByLabelText("E-mail")).toBeTruthy();
      cleanup();
    }
  });

  test("the desktop opens the canonical origin and keeps the verifier out of the browser URL", async () => {
    app().__agentesDesktop = { version: "0.6.0" };
    const state = stateWithPasskeys();
    state.authConfig = { passkeys: { enabled: true, origin: "https://auth.example.com" } };
    const { auth, calls } = createFakeAuth();
    const assign = spyOn(window.location, "assign").mockImplementation(() => {});
    try {
      await renderApp("/login", { api: createFakeApi(state), auth });
      await press(PASSKEY);
      const url = new URL(String(assign.mock.calls[0]?.[0]));
      expect(url.origin).toBe("https://auth.example.com");
      expect(url.pathname).toBe("/desktop/sign-in");
      expect(url.searchParams.get("provider")).toBe("passkey");
      expect(url.searchParams.get("request")).toBe(request);
      expect(url.searchParams.has("verifier")).toBe(false);
      expect(url.searchParams.has("challenge")).toBe(false);
      expect(calls.some((call) => call.method === "signInPasskey")).toBe(false);
      expect(document.querySelector(".auth__codeValue")?.textContent).toBe("KQ7M-3XPF");
    } finally {
      assign.mockRestore();
    }
  });

  test("the desktop browser waits for a click and matching-code confirmation", async () => {
    const { auth, calls } = createFakeAuth();
    auth.signInPasskey = async () => {
      calls.push({ method: "signInPasskey", args: [] });
      return { ok: true };
    };
    await renderApp(`/desktop/sign-in?provider=passkey&request=${request}`, {
      api: createFakeApi(stateWithPasskeys()),
      auth,
    });
    expect(calls).toEqual([]);
    await press(PASSKEY);
    expect(calls.map((call) => call.method)).toEqual(["signInPasskey", "desktopRequestCode"]);
    expect(document.querySelector(".auth__codeValue")?.textContent).toBe("KQ7M-3XPF");
    expect(calls.some((call) => call.method === "desktopHandoff")).toBe(false);
    await press(/Sim, entrar no app/);
    expect(calls.at(-1)).toEqual({ method: "desktopHandoff", args: [request] });
  });

  test("a malformed desktop request never offers or starts a ceremony", async () => {
    const { auth, calls } = createFakeAuth();
    await renderApp("/desktop/sign-in?provider=passkey&request=invalid", {
      api: createFakeApi(stateWithPasskeys()),
      auth,
    });
    expect(screen().getByRole("heading").textContent).toBe("Esse pedido expirou.");
    expect(screen().queryByRole("button", { name: PASSKEY })).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe("passkey recovery and canonical navigation", () => {
  test("unsupported and unreachable ceremonies remain retryable beside email/password", async () => {
    for (const result of [
      { ok: false as const, status: 0, code: "passkey_unsupported", message: "" },
      { ok: false as const, status: 0, code: "network", message: "" },
    ]) {
      const { auth } = createFakeAuth({ passkeySignIn: result });
      await renderApp("/login", { api: createFakeApi(stateWithPasskeys()), auth });
      await press(PASSKEY);
      const alert = screen().getByRole("alert").textContent;
      expect(alert).toContain(result.code === "network" ? "Sem conexão" : "não pode usar chaves de acesso");
      expect(screen().getByRole("button", { name: PASSKEY }).hasAttribute("disabled")).toBe(false);
      expect(screen().getByLabelText("E-mail").getAttribute("aria-invalid")).toBeNull();
      expect(screen().getByRole("button", { name: "Usar e-mail e senha" })).toBeTruthy();
      cleanup();
    }
  });

  test("a browser alias moves to the server-configured origin before starting a ceremony", async () => {
    const state = stateWithPasskeys();
    state.authConfig = { passkeys: { enabled: true, origin: "https://auth.example.com:8443" } };
    const { auth, calls } = createFakeAuth();
    const assign = spyOn(window.location, "assign").mockImplementation(() => {});
    try {
      await renderApp(`/login?redirect=/org/${ORG_ID}/drive`, { api: createFakeApi(state), auth });
      await press(PASSKEY);
      const url = new URL(String(assign.mock.calls[0]?.[0]));
      expect(url.origin).toBe("https://auth.example.com:8443");
      expect(url.pathname).toBe("/login");
      expect(url.searchParams.get("redirect")).toBe(`/org/${ORG_ID}/drive`);
      expect(calls).toEqual([]);
    } finally {
      assign.mockRestore();
    }
  });

  test("the desktop browser recovers from cancellation and refuses an expired request after verification", async () => {
    let cancelled = true;
    const { auth, calls } = createFakeAuth({ requestCode: null });
    auth.signInPasskey = async () => {
      calls.push({ method: "signInPasskey", args: [] });
      return cancelled ? { ok: false, status: 400, code: "AUTH_CANCELLED", message: "" } : { ok: true };
    };
    await renderApp(`/desktop/sign-in?provider=passkey&request=${request}`, {
      api: createFakeApi(stateWithPasskeys()),
      auth,
    });
    await press(PASSKEY);
    expect(screen().getByRole("alert").textContent).toContain(CANCELLED);
    expect(calls.some((call) => call.method === "desktopRequestCode")).toBe(false);
    const fallback = screen().getByRole("link", { name: "Usar e-mail e senha" });
    expect(fallback.getAttribute("href")).toContain("reauthenticate");
    cancelled = false;
    await press(PASSKEY);
    expect(screen().getByRole("heading").textContent).toBe("Esse pedido expirou.");
    expect(calls.some((call) => call.method === "desktopHandoff")).toBe(false);
  });
});
