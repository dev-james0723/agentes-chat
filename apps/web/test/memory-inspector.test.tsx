import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { MemoryHistory } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = async (element: Element) => {
  await act(async () => fireEvent.click(element));
  await settle(4);
};

function fixture() {
  const state = seedState();
  const memory = state.memories.find((m) => m.agentId === ADA_ID && m.supersedes && !m.archived);
  if (!memory) throw new Error("Missing a memory that replaced another");
  Object.assign(memory, {
    scope: { type: "channel", id: "c-eng" },
    trust: "low",
    status: "active",
    validFrom: "2026-03-01T00:00:00.000Z",
    validTo: null,
    sourceRevision: null,
    sourceMessage: { messageId: "m-source", channelId: "c-eng", threadId: null, at: "2026-03-01T00:00:00.000Z" },
  });
  const api = createFakeApi(state);
  const asked: string[] = [];
  const reverted: string[] = [];
  const history: MemoryHistory = {
    versions: [
      {
        id: "older",
        version: 1,
        text: "Deploy em produção só depois das 18h.",
        current: false,
        status: "archived",
        createdAt: "2026-02-01T00:00:00.000Z",
        supersededAt: "2026-03-01T00:00:00.000Z",
        validFrom: null,
        validTo: null,
      },
      {
        id: memory.id,
        version: 2,
        text: memory.text,
        current: true,
        status: "active",
        createdAt: "2026-03-01T00:00:00.000Z",
        supersededAt: null,
        validFrom: null,
        validTo: null,
      },
    ],
    runs: [
      {
        runId: "run-1",
        agentId: ADA_ID,
        agentName: "Ada",
        channelId: "c-eng",
        channelName: "eng",
        createdAt: new Date().toISOString(),
      },
    ],
  };
  api.memory.history = async (orgId, id) => {
    asked.push(`${orgId}/${id}`);
    return history;
  };
  api.memory.revert = async (orgId, id) => {
    reverted.push(`${orgId}/${id}`);
  };
  return { memory, api, asked, reverted };
}

async function open(f: ReturnType<typeof fixture>) {
  await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}/memory`, { api: f.api });
  await settle(6);
  const row = document.querySelector(`[data-item-id="${f.memory.id}"]`);
  if (!(row instanceof HTMLElement)) throw new Error("Missing memory row");
  return row;
}

test("a memory shows where it applies, its trust, status, validity and a link to its source message", async () => {
  const f = fixture();
  const row = await open(f);
  const facts = row.querySelector(".memory-item__facts");
  expect(facts?.textContent).toContain("Vale para um canal");
  expect(facts?.textContent).toContain("Fonte externa");
  expect(facts?.textContent).toContain("Em uso");
  expect(facts?.textContent).toContain("Vale a partir de");
  const source = within(row).getByRole("link", { name: "Abrir a mensagem de origem" });
  expect(source.getAttribute("href")).toBe(`/org/${ORG_ID}/c/c-eng?m=m-source`);
});

test("History & use opens the versions and the runs that used it, asked only when opened", async () => {
  const f = fixture();
  const row = await open(f);
  expect(f.asked).toEqual([]);
  const toggle = within(row).getByRole("button", { name: "Histórico e uso" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  await click(toggle);
  expect(f.asked).toEqual([`${ORG_ID}/${f.memory.id}`]);
  const panel = within(row).getByRole("region", { name: "Histórico e uso" });
  const versions = panel.querySelectorAll("ol li");
  expect(versions).toHaveLength(2);
  expect(versions[0]?.textContent).toContain("Versão 1");
  expect(versions[0]?.textContent).toContain("Deploy em produção só depois das 18h.");
  expect(versions[1]?.getAttribute("aria-current")).toBe("true");
  expect(versions[1]?.textContent).toContain("(esta)");
  expect(panel.textContent).toContain("Ada em #eng");
});

test("Revert asks first, then calls the revert endpoint", async () => {
  const f = fixture();
  const row = await open(f);
  await click(within(row).getByRole("button", { name: "Reverter" }));
  const dialog = screen().getByRole("dialog", { name: "Voltar à versão anterior?" });
  expect(f.reverted).toEqual([]);
  await click(within(dialog).getByRole("button", { name: "Cancelar" }));
  expect(f.reverted).toEqual([]);
  await click(within(row).getByRole("button", { name: "Reverter" }));
  await click(
    within(screen().getByRole("dialog", { name: "Voltar à versão anterior?" })).getByRole("button", {
      name: "Reverter",
    }),
  );
  expect(f.reverted).toEqual([`${ORG_ID}/${f.memory.id}`]);
  expect(screen().queryByRole("dialog", { name: "Voltar à versão anterior?" })).toBeNull();
});

test("a memory with no earlier version has no Revert, and older servers show no facts line", async () => {
  const f = fixture();
  const row = await open(f);
  const plain = Array.from(document.querySelectorAll<HTMLElement>("[data-item-id]")).find(
    (el) => el !== row && !el.textContent?.includes("Substitui:"),
  );
  if (!plain) throw new Error("Missing a plain memory");
  expect(within(plain).queryByRole("button", { name: "Reverter" })).toBeNull();
  expect(plain.querySelector(".memory-item__facts")).toBeNull();
});
