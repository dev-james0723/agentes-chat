import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Memory } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { TeamMemoryCard } from "@/components/TeamMemory";
import { ADA_ID, createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, renderPage, screen, settle } from "./render";

afterEach(() => cleanup());

const click = async (element: Element) => {
  await act(async () => fireEvent.click(element));
  await settle(3);
};

function fixture(team = false, version: number | undefined = 7) {
  const state = seedState();
  const source = state.memories.find((m) => m.agentId === ADA_ID && !m.archived);
  if (!source) throw new Error("Missing fixture memory");
  const memory: Memory = {
    ...source,
    agentId: team ? "" : ADA_ID,
    text: "Orion uses the original method.",
    summary: null,
    kind: "fact",
    learned: true,
    howTo: false,
    playbook: false,
    lowTrust: false,
    verified: false,
    version,
  };
  state.memories = [memory];
  return { state, memory, api: createFakeApi(state) };
}

async function learned(f: ReturnType<typeof fixture>) {
  const rendered = await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}?tab=memory`, { api: f.api });
  await settle(6);
  await click(within(screen().getByRole("radiogroup", { name: "Tipo" })).getByRole("radio", { name: /Aprendizados/ }));
  const row = document.querySelector(`[data-item-id="${f.memory.id}"]`);
  if (!(row instanceof HTMLElement)) throw new Error("Missing memory row");
  return { ...rendered, row };
}

test("a learned-memory editor sends its opening revision even after a background refresh", async () => {
  const f = fixture();
  const writes: unknown[][] = [];
  f.api.memory.edit = async (...args) => {
    writes.push(args);
    return { ...f.memory, text: args[2] };
  };
  const { row, services } = await learned(f);
  await click(within(row).getByRole("button", { name: "Editar" }));
  await act(async () =>
    fireEvent.change(within(row).getByRole("textbox"), { target: { value: "My unsaved method." } }),
  );
  f.state.memories = [{ ...f.memory, text: "A concurrent update.", version: 8 }];
  await act(async () => {
    await services.queryClient.invalidateQueries();
  });
  await settle(5);
  expect((within(row).getByRole("textbox") as HTMLTextAreaElement).value).toBe("My unsaved method.");
  await click(within(row).getByRole("button", { name: "Salvar" }));
  expect(writes).toEqual([[ORG_ID, f.memory.id, "My unsaved method.", 7]]);
});

for (const action of ["confirm", "archive"] as const) {
  test(`the learned-memory ${action} action sends the displayed revision`, async () => {
    const f = fixture();
    const writes: unknown[][] = [];
    if (action === "confirm")
      f.api.memory.confirm = async (...args) => {
        writes.push(args);
        return f.memory;
      };
    else
      f.api.memory.setArchived = async (...args) => {
        writes.push(args);
        return f.memory;
      };
    const { row } = await learned(f);
    await click(within(row).getByRole("button", { name: action === "confirm" ? "Confirmar" : "Esquecer" }));
    expect(writes).toEqual([action === "confirm" ? [ORG_ID, f.memory.id, 7] : [ORG_ID, f.memory.id, true, 7]]);
  });
}

test("team-memory drafts retain the revision opened, not a newer list revision", async () => {
  const f = fixture(true);
  const writes: unknown[][] = [];
  f.api.memory.edit = async (...args) => {
    writes.push(args);
    return { ...f.memory, text: args[2] };
  };
  const { services } = await renderPage(<TeamMemoryCard />, { api: f.api, org: true });
  await settle(5);
  await click(screen().getByRole("button", { name: "Editar" }));
  f.state.memories = [{ ...f.memory, text: "Another editor's update.", version: 8 }];
  await act(async () => {
    await services.queryClient.invalidateQueries();
  });
  await settle(5);
  await act(async () => fireEvent.change(screen().getByRole("textbox"), { target: { value: "My team correction." } }));
  await click(screen().getByRole("button", { name: "Salvar" }));
  expect(writes).toEqual([[ORG_ID, f.memory.id, "My team correction.", 7]]);
});

test("an older server without memory versions remains usable", async () => {
  const f = fixture();
  delete f.memory.version;
  const writes: unknown[][] = [];
  f.api.memory.setArchived = async (...args) => {
    writes.push(args);
    return f.memory;
  };
  const { row } = await learned(f);
  await click(within(row).getByRole("button", { name: "Esquecer" }));
  expect(writes).toEqual([[ORG_ID, f.memory.id, true, undefined]]);
});
