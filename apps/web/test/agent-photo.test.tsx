import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, LODI_ID, ORG_ID, seedDm, seedState, withRightHand } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const settings = `/org/${ORG_ID}/agents/${ADA_ID}?tab=settings&sec=identity`;
const heroPhoto = () => document.querySelector<HTMLImageElement>(".agp-face .ac-avatar img");
const sidebarPhotos = () =>
  screen().getByRole("navigation", { name: "Navegação do workspace" }).querySelectorAll(".ac-avatar--agent img");
const withoutPhoto = (agents: ReturnType<typeof seedState>["agents"]) => agents.map(({ avatarUrl: _photo, ...a }) => a);

describe("agent photo settings", () => {
  test("upload, reload and remove affect the existing agent photo across its profile and sidebar", async () => {
    const state = seedState();
    seedDm(state, { type: "agent", id: ADA_ID });
    const unchanged = structuredClone(withoutPhoto(state.agents));
    const api = createFakeApi(state);
    await renderApp(settings, { api });
    await settle(8);
    await click(screen().getByRole("button", { name: "Trocar foto" }));
    const dialog = screen().getByRole("dialog", { name: "Foto do perfil" });
    expect(within(dialog).queryByRole("button", { name: "Remover foto" })).toBeNull();
    const input = within(dialog).getByLabelText("Escolher imagem") as HTMLInputElement;
    await act(async () =>
      fireEvent.change(input, {
        target: { files: [new File(["original-png"], "original.png", { type: "image/png" })] },
      }),
    );
    await settle(3);
    await click(within(dialog).getByRole("button", { name: "Salvar" }));
    await settle(8);
    const upload = state.calls.find((c) => c.method === "agents.setAgentAvatar");
    expect(upload?.args.slice(0, 2)).toEqual([ORG_ID, ADA_ID]);
    expect(upload?.args[2]).toMatchObject({ contentType: "image/png" });
    const photo = state.agents.find((a) => a.id === ADA_ID)?.avatarUrl;
    expect(photo).toStartWith("data:image/png;base64,");
    expect(heroPhoto()?.getAttribute("src")).toBe(photo);
    expect([...sidebarPhotos()].some((img) => img.getAttribute("src") === photo)).toBe(true);
    expect(withoutPhoto(state.agents)).toEqual(unchanged);
    expect(state.calls.some((c) => c.method === "agents.update")).toBe(false);

    // A new app/query cache reads the saved photo from the same existing record.
    cleanup();
    await renderApp(settings, { api });
    await settle(8);
    expect(heroPhoto()?.getAttribute("src")).toBe(photo);
    await click(screen().getByRole("button", { name: "Trocar foto" }));
    await click(
      within(screen().getByRole("dialog", { name: "Foto do perfil" })).getByRole("button", { name: "Remover foto" }),
    );
    await settle(8);
    expect(state.calls.find((c) => c.method === "agents.removeAgentAvatar")?.args).toEqual([ORG_ID, ADA_ID]);
    expect(state.agents.find((a) => a.id === ADA_ID)?.avatarUrl).toBeNull();
    expect(heroPhoto()).toBeNull();
    expect(document.querySelector(".agp-face .ac-avatar canvas")).not.toBeNull();
    expect([...sidebarPhotos()].some((img) => img.getAttribute("src") === photo)).toBe(false);
    expect(withoutPhoto(state.agents)).toEqual(unchanged);
  });

  test("a member sees the saved portrait without receiving photo editing controls", async () => {
    const state = seedState();
    if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
    const agent = state.agents.find((a) => a.id === ADA_ID);
    if (agent) agent.avatarUrl = "/api/app/agent-avatars/org/ada/original.png";
    await renderApp(settings, { api: createFakeApi(state) });
    await settle(8);
    expect(heroPhoto()?.getAttribute("src")).toBe(agent?.avatarUrl);
    expect(screen().queryByRole("button", { name: "Trocar foto" })).toBeNull();
    expect(screen().queryByRole("button", { name: "Remover foto" })).toBeNull();
  });
});

test("Jasper's right-hand settings upload, reload and remove a photo while retaining name and pixel controls", async () => {
  const name = "Jasper | Your Right Hand";
  const state = withRightHand(seedState(), { name });
  seedDm(state, { type: "agent", id: LODI_ID });
  const unchanged = structuredClone(withoutPhoto(state.agents));
  const api = createFakeApi(state);
  const path = `/org/${ORG_ID}/agents/${LODI_ID}?tab=settings`;
  const photoAt = () => document.querySelector<HTMLImageElement>(".rh-set__face-edit .ac-avatar img");
  await renderApp(path, { api });
  await settle(8);
  expect(document.querySelector(".ac-pagehead__title")?.textContent).toBe(name);
  expect((document.querySelector(".rh-set__name input") as HTMLInputElement).value).toBe(name);
  await click(screen().getByRole("button", { name: "Trocar foto" }));
  const dialog = screen().getByRole("dialog", { name: "Foto do perfil" });
  await act(async () =>
    fireEvent.change(within(dialog).getByLabelText("Escolher imagem"), {
      target: { files: [new File(["original-jasper"], "jasper.png", { type: "image/png" })] },
    }),
  );
  await settle(3);
  await click(within(dialog).getByRole("button", { name: "Salvar" }));
  await settle(8);
  expect(state.calls.find((c) => c.method === "agents.setAgentAvatar")?.args.slice(0, 2)).toEqual([ORG_ID, LODI_ID]);
  const photo = state.agents.find((a) => a.id === LODI_ID)?.avatarUrl;
  expect(photoAt()?.getAttribute("src")).toBe(photo);
  expect(photo).toStartWith("data:image/png;base64,");
  expect(withoutPhoto(state.agents)).toEqual(unchanged);

  cleanup();
  await renderApp(path, { api });
  await settle(8);
  expect(photoAt()?.getAttribute("src")).toBe(photo);
  // Its existing look editor still opens independently, without altering the saved portrait.
  await click(document.querySelector(".rh-set__face-edit") as HTMLButtonElement);
  expect(screen().getByRole("group", { name: "Cor" })).toBeTruthy();
  await click(screen().getByRole("button", { name: "Cancelar" }));
  await click(screen().getByRole("button", { name: "Trocar foto" }));
  await click(
    within(screen().getByRole("dialog", { name: "Foto do perfil" })).getByRole("button", { name: "Remover foto" }),
  );
  await settle(8);
  expect(state.calls.find((c) => c.method === "agents.removeAgentAvatar")?.args).toEqual([ORG_ID, LODI_ID]);
  expect(photoAt()).toBeNull();
  expect(document.querySelector(".rh-set__face-edit .ac-avatar canvas")).not.toBeNull();
  expect((document.querySelector(".rh-set__name input") as HTMLInputElement).value).toBe(name);
  expect(withoutPhoto(state.agents)).toEqual(unchanged);
  expect(state.calls.some((c) => c.method === "agents.update")).toBe(false);
});
