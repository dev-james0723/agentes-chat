import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Approval } from "@agenteschat/client";
import { keys } from "@agenteschat/client";
import { onlineManager } from "@tanstack/react-query";
import { act, cleanup } from "@testing-library/react";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  onlineManager.setOnline(true);
});

test("independent: an offline-paused protected recheck hides cached draft and one-time consent", async () => {
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
  const marker = "SYNTHETIC_CACHED_PRIVATE_OFFLINE_0191";
  const detail: Approval = {
    ...a,
    publication: {
      fingerprint: "a".repeat(64),
      body: marker,
      bodyHash: "b".repeat(64),
      skillId: "s",
      skillName: "Offline recheck method",
      baseVersion: 1,
      baseCurrent: true,
      destination: "organization_skill_library",
    },
  };
  const api = createFakeApi(state);
  let gets = 0;
  api.approvals.get = async () => {
    gets++;
    return detail;
  };
  const rendered = await renderApp(`/org/${ORG_ID}/approvals?open=${a.id}`, { api });
  const qc = rendered.services.queryClient;
  try {
    await settle(4);
    expect(screen().getByLabelText("Texto completo da habilidade").textContent).toBe(marker);
    const before = gets;
    onlineManager.setOnline(false);
    await act(async () => {
      void qc.invalidateQueries({ queryKey: keys.approval(ORG_ID, a.id), exact: true });
    });
    await settle(4);
    const query = qc.getQueryState(keys.approval(ORG_ID, a.id));
    const bodyVisible = screen().queryByLabelText("Texto completo da habilidade") !== null;
    const consentVisible = screen().queryByRole("button", { name: "Compartilhar esta versão uma vez" }) !== null;
    console.info(
      JSON.stringify({
        evidence: "actual_rendered_offline_paused_private_recheck",
        fetchStatus: query?.fetchStatus,
        status: query?.status,
        isInvalidated: query?.isInvalidated,
        newProtectedGets: gets - before,
        bodyVisible,
        consentVisible,
      }),
    );
    expect(query?.fetchStatus).toBe("paused");
    expect(gets).toBe(before);
    expect(bodyVisible).toBe(false);
    expect(consentVisible).toBe(false);
  } finally {
    cleanup();
    await qc.cancelQueries();
    qc.clear();
    onlineManager.setOnline(true);
  }
});
