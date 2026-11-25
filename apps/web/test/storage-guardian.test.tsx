import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { StorageGuardianView, StorageReviewItem } from "@agenteschat/client";
import { act, cleanup, fireEvent } from "@testing-library/react";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const view: StorageGuardianView = {
  enabled: true,
  modeOverride: null,
  computers: [{ id: "m1", name: "Mac do escritório", level: "low", freeGb: 25, use: 0.96, mode: "elevated" }],
  scopes: [{ id: "s1", machineId: "m1", root: "scratch/", mode: "shadow" }],
  states: { deleted: 3, review: 1 },
  figures: {
    unlinked: 3,
    logicalBytes: 3 * 1024 * 1024,
    allocatedBytes: 3 * 1024 * 1024,
    freeDeltaBytes: 2 * 1024 * 1024,
    measuredRounds: 1,
    shadowFiles: 2,
    shadowBytes: 2048,
    relocated: 0,
    archived: 0,
    openReview: 1,
  },
  recent: [],
};
const item: StorageReviewItem = {
  id: "0195f1a2-0000-7000-8000-000000000001",
  status: "open",
  code: "role_unknown",
  reason: "nobody said what it is for",
  history: [],
  createdAt: "2026-11-25T10:00:00Z",
  file: {
    id: "f1",
    path: "scratch/shot.png",
    kind: "image",
    role: "unknown",
    state: "review",
    size: 2048,
    sha256: null,
    agentId: "a1",
    machineId: "m1",
    capturedBy: "browser_screenshot",
  },
};

describe("Storage Guardian (ADR 0213)", () => {
  test("shows the switch, separate figures, folders and the review queue; decisions go to the server", async () => {
    const state = seedState();
    state.storageGuardian = view;
    state.storageReview = [item];
    await renderApp(`/org/${ORG_ID}/settings/storage`, { api: createFakeApi(state) });
    await settle(5);
    expect(screen().getByText("Storage Guardian")).toBeTruthy();
    expect(screen().getByText("Limpando enquanto os agentes trabalham")).toBeTruthy();
    expect(screen().getByText("Arquivos removidos")).toBeTruthy();
    expect(screen().getByText(/Blocos de disco medidos/)).toBeTruthy();
    expect(screen().getByText(/1 arquivo espera por você/)).toBeTruthy();
    expect(screen().getByText("scratch/shot.png")).toBeTruthy();
    await act(async () => fireEvent.click(screen().getByRole("checkbox")));
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Proteger" })));
    await settle(3);
    expect(state.calls.some((c) => c.method === "storageGuardian.decide" && c.args[2] === "protect")).toBe(true);
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Desligar" })));
    await settle(3);
    expect(state.calls.some((c) => c.method === "storageGuardian.settings")).toBe(true);
  });
});
