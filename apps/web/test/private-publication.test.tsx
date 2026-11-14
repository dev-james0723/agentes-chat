import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Approval } from "@agenteschat/client";
import { cacheApproval } from "@agenteschat/client";
import { act, cleanup, fireEvent } from "@testing-library/react";
import { createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());
const body = "A complete private draft.\n".repeat(500) + "PRIVATE_TRAILING_MARKER_0191";
const fingerprint = "a".repeat(64);
function fixture() {
  const state = seedState();
  const a = state.approvals[0]!;
  Object.assign(a, { publicationRequired: true, params: {}, detail: "", why: null, approveAlways: null });
  const api = createFakeApi(state);
  const detail: Approval = {
    ...a,
    publication: {
      fingerprint,
      body,
      bodyHash: "b".repeat(64),
      skillId: "s",
      baseVersion: 1,
      baseCurrent: true,
      destination: "organization_skill_library",
    },
  };
  return { state, a, api, detail };
}
test("the owner reads the whole protected draft and explicitly shares this exact version once", async () => {
  const { a, api, detail } = fixture();
  let release!: (a: Approval) => void;
  let got = 0;
  let sent: unknown[] = [];
  api.approvals.get = async () => {
    got++;
    return new Promise((r) => {
      release = r;
    });
  };
  api.approvals.approve = async (...args) => {
    sent = args;
    return { ...a, status: "approved" };
  };
  await renderApp(`/org/${ORG_ID}/approvals?open=${a.id}`, { api });
  await settle(4);
  expect(got).toBeGreaterThan(0);
  expect(screen().queryByText("PRIVATE_TRAILING_MARKER_0191", { exact: false })).toBeNull();
  expect(screen().queryByRole("button", { name: "Compartilhar esta versão uma vez" })).toBeNull();
  await act(async () => release(detail));
  await settle(4);
  const preview = screen().getByLabelText("Texto completo da habilidade");
  expect(preview.textContent).toBe(body);
  expect(preview.className).not.toContain("is-folded");
  expect(screen().getByText("Destino: biblioteca de habilidades da organização")).toBeDefined();
  await act(async () => fireEvent.click(screen().getByRole("button", { name: "Compartilhar esta versão uma vez" })));
  await settle(3);
  expect(sent).toEqual([ORG_ID, a.id, undefined, undefined, undefined, fingerprint]);
});
test("private cards open the protected review without inline or remembered consent", async () => {
  const { state, api } = fixture();
  await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
  await settle(4);
  expect(screen().queryByRole("button", { name: /Aprovar sempre/ })).toBeNull();
  expect(screen().queryByRole("button", { name: /^Aprovar$/ })).toBeNull();
  expect(screen().getByRole("link", { name: "Revisar rascunho privado" })).toBeDefined();
  expect(JSON.stringify(state.approvals)).not.toContain("PRIVATE_TRAILING_MARKER_0191");
});

test("an owner refresh clears the old preview and a failed recheck leaves no body or consent", async () => {
  const { a, api, detail } = fixture();
  let fail = false;
  api.approvals.get = async () => {
    if (fail) throw new Error("revoked");
    return detail;
  };
  const rendered = await renderApp(`/org/${ORG_ID}/approvals?open=${a.id}`, { api });
  await settle(4);
  expect(screen().getByLabelText("Texto completo da habilidade").textContent).toBe(body);
  fail = true;
  await act(async () => cacheApproval(rendered.services.queryClient, ORG_ID, a));
  await settle(5);
  expect(screen().queryByLabelText("Texto completo da habilidade")).toBeNull();
  expect(screen().queryByRole("button", { name: "Compartilhar esta versão uma vez" })).toBeNull();
  expect(screen().getByRole("button", { name: "Tentar de novo" })).toBeDefined();
});

test("a current protected preview of a stale base is visible but cannot be approved", async () => {
  const { a, api, detail } = fixture();
  api.approvals.get = async () => ({
    ...detail,
    canDecide: false,
    publication: { ...detail.publication!, baseCurrent: false },
  });
  await renderApp(`/org/${ORG_ID}/approvals?open=${a.id}`, { api });
  await settle(4);
  expect(screen().getByLabelText("Texto completo da habilidade").textContent).toBe(body);
  expect(screen().getByText("Esta habilidade mudou. Peça um novo pedido de compartilhamento.")).toBeDefined();
  expect(screen().queryByRole("button", { name: "Compartilhar esta versão uma vez" })).toBeNull();
});
