import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Approval } from "@agenteschat/client";
import { act, cleanup, fireEvent } from "@testing-library/react";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());
test("independent: owner can withdraw a pending stale private draft when fresh server canCancel is true", async () => {
  const state = seedState();
  const a = state.approvals[0]!;
  Object.assign(a, {
    tool: "update_skill",
    scope: "skills:read",
    title: "Review sharing a private draft",
    publicationRequired: true,
    params: {},
    detail: "",
    why: null,
    approveAlways: null,
  });
  const detail: Approval = {
    ...a,
    canDecide: false,
    canCancel: true,
    publication: {
      fingerprint: "a".repeat(64),
      body: "Synthetic stale draft",
      bodyHash: "b".repeat(64),
      skillId: "s",
      skillName: "Changed target method",
      baseVersion: 1,
      baseCurrent: false,
      destination: "organization_skill_library",
    },
  };
  const api = createFakeApi(state);
  let canceled: unknown[] = [];
  let decisions = 0;
  api.approvals.get = async () => detail;
  api.approvals.cancel = async (...args) => {
    canceled = args;
    return { ...a, status: "canceled", canCancel: false, canDecide: false };
  };
  api.approvals.approve = async () => {
    decisions++;
    return detail;
  };
  await renderApp(`/org/${ORG_ID}/approvals?open=${a.id}`, { api });
  await settle(4);
  const approve = screen().queryByRole("button", { name: "Compartilhar esta versão uma vez" });
  const withdraw = screen().queryByRole("button", { name: /^(Cancelar|Retirar aprovação de compartilhamento)$/ });
  console.info(
    JSON.stringify({
      evidence: "actual_rendered_pending_stale_private_withdraw",
      serverCanCancel: true,
      status: "pending",
      baseCurrent: false,
      canDecide: false,
      approveVisible: approve !== null,
      withdrawVisible: withdraw !== null,
    }),
  );
  expect(approve).toBeNull();
  expect(withdraw).not.toBeNull();
  await act(async () => fireEvent.click(withdraw!));
  await settle(4);
  expect(canceled).toEqual([ORG_ID, a.id]);
  expect(decisions).toBe(0);
});
