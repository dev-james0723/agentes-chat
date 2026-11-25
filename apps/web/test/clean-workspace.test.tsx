import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { CleanWorkspace } from "@agenteschat/client";
import { act, cleanup, fireEvent } from "@testing-library/react";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const view: CleanWorkspace = {
  computers: [{ id: "m1", name: "Mac do escritório", level: "critical", freeGb: 12, use: 0.99 }],
  pending: 0,
  reports: [
    {
      id: "r1",
      subjectType: "issue",
      subjectId: "i1",
      outcome: "done",
      createdAt: "2026-11-19T10:00:00Z",
      kept: 2,
      candidates: 1,
      candidateBytes: 4096,
      duplicates: 1,
      snapshot: { restorable: 1, manifestOnly: 1 },
      items: [
        {
          where: "drive",
          path: "relatorio.html",
          kind: "html",
          role: "canonical",
          size: 100,
          decision: "keep",
          why: "A Drive file.",
        },
        {
          where: "computer",
          path: "scratch/frame-1.png",
          kind: "image",
          role: "scratch",
          size: 4096,
          decision: "candidate",
          why: "Scratch.",
        },
      ],
      cleanups: [],
      removedBytes: 0,
    },
  ],
};

describe("Clean workspace (ADR 0200)", () => {
  test("shows each computer's disk and an ended task's files; cleaning asks the server for that report", async () => {
    const state = seedState();
    state.cleanWorkspace = view;
    await renderApp(`/org/${ORG_ID}/settings/storage`, { api: createFakeApi(state) });
    await settle(5);
    expect(screen().getByText("Limpar o workspace")).toBeTruthy();
    expect(screen().getByText(/Quase cheio/)).toBeTruthy();
    expect(screen().getByText(/1 cópia exata/)).toBeTruthy();
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Limpar arquivos temporários" })));
    await settle(3);
    expect(state.calls.some((c) => c.method === "cleanWorkspace.approve" && c.args[1] === "r1")).toBe(true);
  });

  test("with nothing ended yet it says so, and offers nothing to clean", async () => {
    const state = seedState();
    await renderApp(`/org/${ORG_ID}/settings/storage`, { api: createFakeApi(state) });
    await settle(5);
    expect(screen().getByText(/Nenhuma tarefa terminou/)).toBeTruthy();
    expect(screen().queryByRole("button", { name: "Limpar arquivos temporários" })).toBeNull();
  });
});
