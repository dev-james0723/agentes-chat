import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { ApiError, keys, type Mission, type MissionPlanVersion, type ThreadInfo } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

const ROOT = "00000000-0000-4000-8000-000000000182";
const TITLE = "HeyTracki native preview";
const ORIGINAL_FOLDER = "repos/old-checkout";
const RECOVERY_FOLDER = "repos/dev-james0723/heytracki-finish-20261121";
const REPOSITORY_LABEL = "Pasta do repositório";
const snapshot = () => (globalThis as { geometrySnapshot?: () => void }).geometrySnapshot?.();

afterEach(() => {
  cleanup();
  localStorage.clear();
});

async function taskMission(
  options: {
    historicalCard?: boolean;
    patch?: Partial<Mission>;
    detailPatch?: Partial<Mission>;
    channelKind?: ThreadInfo["channelKind"];
    saveFolder?: (folder: string) => Promise<string>;
    start?: () => Promise<void>;
  } = {},
) {
  const state = seedState();
  const api = createFakeApi(state);
  const mission = await api.missions.create(ORG_ID, {
    agentId: ADA_ID,
    channelId: ENG_ID,
    threadId: ROOT,
    title: TITLE,
    goal: "Build the isolated native preview",
  });
  const createdAt = new Date(Date.now() - 120_000).toISOString();
  state.messages.push({
    id: ROOT,
    channelId: ENG_ID,
    threadId: null,
    author: { type: "person", id: "u-walter" },
    body: TITLE,
    mentionedAgentIds: [],
    agentRunId: null,
    meta: { taskConversation: { issueId: "issue-182", number: 182, title: TITLE } },
    createdAt,
  });
  if (options.historicalCard) {
    state.messages.push({
      id: "plan-182",
      channelId: ENG_ID,
      threadId: ROOT,
      author: { type: "agent", id: ADA_ID },
      body: "Plano proposto",
      mentionedAgentIds: [],
      agentRunId: null,
      meta: {
        missionPlan: {
          missionId: mission.id,
          title: TITLE,
          goal: mission.goal,
          computer: "MacBook",
          executor: "claude",
        },
      },
      createdAt,
    });
  }
  state.messages.push(
    ...Array.from({ length: 70 }, (_, i) => ({
      id: `reply-${i}`,
      channelId: ENG_ID,
      threadId: ROOT,
      author: { type: "agent" as const, id: ADA_ID },
      body: `Progress note ${i + 1}`,
      mentionedAgentIds: [],
      agentRunId: null,
      meta: {},
      createdAt: new Date(Date.now() - 100_000 + i * 1000).toISOString(),
    })),
  );
  const plan: MissionPlanVersion = {
    version: 1,
    items: [{ id: "baseline", title: "Verify the isolated checkout", status: "todo" }],
    source: "executor",
    taskId: null,
    createdAt,
  };
  api.missions.plan = async (_orgId, missionId) => ({ missionId, current: plan, history: [plan] });
  const ofThread = api.missions.ofThread;
  const getMission = api.missions.get;
  const folders = new Map<string, string>();
  const missionView = (m: Mission) => ({
    ...m,
    repoDir: folders.get(m.id) ?? (m.repoDir || ORIGINAL_FOLDER),
    runningTasks: 0,
    ...options.patch,
  });
  api.missions.ofThread = async (...args) => missionView(await ofThread(...args));
  api.missions.get = async (...args) => ({ ...missionView(await getMission(...args)), ...options.detailPatch });
  api.missions.setMachine = async (orgId, missionId, machineId, folder) => {
    state.calls.push({ method: "missions.setMachine", args: [orgId, missionId, machineId, folder] });
    if (folder === undefined) throw new Error("The test received no repository folder");
    const saved = options.saveFolder ? await options.saveFolder(folder) : folder;
    folders.set(missionId, saved);
    return api.missions.get(orgId, missionId);
  };
  const start = options.start;
  if (start) {
    const control = api.missions.control;
    api.missions.control = async (...args) => {
      if (args[2] === "start") await start();
      return control(...args);
    };
  }
  const channelKind = options.channelKind;
  if (channelKind) {
    const getThread = api.threads.get;
    api.threads.get = async (...args) => ({ ...(await getThread(...args)), channelKind });
  }
  const view = await renderApp(`/org/${ORG_ID}/threads/${ROOT}`, { api });
  await settle(10);
  return { state, api, mission, ...view };
}

const bar = () => document.querySelector<HTMLElement>(".channel__composer [data-task-mission]");
const reviewBar = () => {
  const found = bar();
  if (!found) throw new Error("The task mission review control is missing");
  return found;
};

async function openReview() {
  await act(async () => fireEvent.click(within(reviewBar()).getByRole("button", { name: "Ver plano" })));
  await settle(5);
  return within(screen().getByRole("dialog", { name: TITLE }));
}

const repositoryFolder = (scope: ReturnType<typeof screen>) =>
  scope.getByRole<HTMLInputElement>("textbox", { name: REPOSITORY_LABEL });
const saveFolderButton = (scope: ReturnType<typeof screen>) =>
  scope.getByRole<HTMLButtonElement>("button", { name: "Salvar" });
const startButton = (scope: ReturnType<typeof screen>) =>
  scope.getByRole<HTMLButtonElement>("button", { name: "Começar" });

describe("a proposed mission in a task conversation", () => {
  test("the owner can review and start the existing mission without its historical plan card", async () => {
    const { state, mission } = await taskMission();
    expect(screen().getByRole("heading", { level: 1, name: "Conversa da tarefa" })).toBeTruthy();
    expect(bar()).not.toBeNull();
    expect(document.querySelectorAll(".mi-plan")).toHaveLength(0);
    expect(state.calls.filter((c) => c.method === "missions.control")).toHaveLength(0);
    await act(async () => fireEvent.click(within(reviewBar()).getByRole("button", { name: "Ver plano" })));
    await settle(5);
    const dialog = screen().getByRole("dialog", { name: TITLE });
    expect(within(dialog).getByText("Verify the isolated checkout")).toBeTruthy();
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Começar" })));
    await settle(8);
    expect(state.calls.filter((c) => c.method === "missions.control")).toEqual([
      { method: "missions.control", args: [ORG_ID, mission.id, "start"] },
    ]);
    expect(bar()).toBeNull();
    expect(screen().queryByRole("dialog", { name: TITLE })).toBeNull();
    expect(screen().getByRole("heading", { level: 1, name: "Conversa da tarefa" })).toBeTruthy();
  });

  test("review stays beside the composer when the original card is followed by 70 replies", async () => {
    await taskMission({ historicalCard: true });
    expect(screen().getByText("Progress note 70")).toBeTruthy();
    expect(document.querySelectorAll(".mi-plan")).toHaveLength(1);
    const persistent = reviewBar();
    expect(within(persistent).getByRole("button", { name: "Ver plano" })).toBeTruthy();
    expect(within(persistent).queryByRole("button", { name: "Começar" })).toBeNull();
    await act(async () => fireEvent.click(within(persistent).getByRole("button", { name: "Ver plano" })));
    await settle(5);
    const dialog = screen().getByRole("dialog", { name: TITLE });
    expect(within(dialog).getAllByRole("button", { name: "Começar" })).toHaveLength(1);
  });

  test("changing the plan closes review before moving to the task composer", async () => {
    const { state } = await taskMission();
    await act(async () => fireEvent.click(within(reviewBar()).getByRole("button", { name: "Ver plano" })));
    await settle(5);
    const dialog = screen().getByRole("dialog", { name: TITLE });
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Mudar algo" })));
    await settle(8);
    expect(screen().queryByRole("dialog", { name: TITLE })).toBeNull();
    expect(document.querySelector(".ac-composer__pill")?.textContent).toContain("Plano");
    expect(document.activeElement).toBe(document.querySelector(".channel__composer textarea"));
    expect(state.calls.filter((c) => c.method === "missions.control")).toHaveLength(0);
  });

  test("a non-owner can review but cannot start", async () => {
    const { state } = await taskMission({ patch: { role: "comment", canAct: false, canManage: false } });
    await act(async () => fireEvent.click(within(reviewBar()).getByRole("button", { name: "Ver plano" })));
    await settle(5);
    const dialog = screen().getByRole("dialog", { name: TITLE });
    expect(within(dialog).getByText("Verify the isolated checkout")).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Começar" })).toBeNull();
    expect(within(dialog).queryByRole("textbox", { name: REPOSITORY_LABEL })).toBeNull();
    expect(state.calls.filter((c) => c.method === "missions.control")).toHaveLength(0);
  });

  test.each([
    ["another thread", { threadId: "another-thread" }, undefined],
    ["another channel", { channelId: "another-channel" }, undefined],
    ["an active mission", { status: "active" }, undefined],
    ["a normal conversation", {}, "channel"],
  ] as const)("does not expose the task review control for %s", async (_name, patch, channelKind) => {
    await taskMission({ patch, channelKind });
    expect(bar()).toBeNull();
    expect(screen().queryByRole("dialog", { name: TITLE })).toBeNull();
    expect(screen().queryByRole("textbox", { name: REPOSITORY_LABEL })).toBeNull();
  });
});

describe("the mission plan repository folder", () => {
  test("saves the existing mission's exact machine and displays the server's returned folder", async () => {
    const { state, mission, services } = await taskMission({ saveFolder: async () => `${RECOVERY_FOLDER}-canonical` });
    const review = await openReview();
    const input = repositoryFolder(review);
    expect(input.value).toBe(ORIGINAL_FOLDER);
    expect(input.maxLength).toBe(300);
    snapshot();
    fireEvent.change(input, { target: { value: RECOVERY_FOLDER } });
    await settle();
    await act(async () => fireEvent.click(saveFolderButton(review)));
    await settle();

    expect(state.calls.filter((c) => c.method === "missions.setMachine")).toEqual([
      { method: "missions.setMachine", args: [ORG_ID, mission.id, "machine_1", RECOVERY_FOLDER] },
    ]);
    expect(state.calls.filter((c) => c.method === "missions.create")).toHaveLength(1);
    expect(state.calls.filter((c) => c.method === "missions.control")).toHaveLength(0);
    expect(input.value).toBe(`${RECOVERY_FOLDER}-canonical`);
    expect(services.queryClient.getQueryData<Mission>(keys.mission(ORG_ID, mission.id))?.repoDir).toBe(input.value);
    expect(services.queryClient.getQueryData<Mission>(keys.threadMission(ORG_ID, ROOT))?.repoDir).toBe(input.value);
  });

  test("blocks Start and duplicate Save across both copies of an investigated plan until the save finishes", async () => {
    let finish!: (folder: string) => void;
    const pending = new Promise<string>((resolve) => {
      finish = resolve;
    });
    const { state, mission, services } = await taskMission({
      historicalCard: true,
      patch: { findings: [{ kind: "read", text: "Read the native preview plan" }] },
      saveFolder: () => pending,
    });
    const historicalCard = document.querySelector<HTMLElement>(".mi-plan");
    if (!historicalCard) throw new Error("The historical plan card is missing");
    const historical = within(historicalCard);
    const historicalStart = startButton(historical);
    const historicalInput = repositoryFolder(historical);
    const review = await openReview();

    expect(startButton(review).disabled).toBe(false);
    fireEvent.change(repositoryFolder(review), { target: { value: RECOVERY_FOLDER } });
    await settle();
    expect(startButton(review).disabled).toBe(true);
    expect(historicalStart.disabled).toBe(true);
    expect(historicalInput.value).toBe(RECOVERY_FOLDER);
    fireEvent.click(historicalStart);
    const save = saveFolderButton(review);
    await act(async () => {
      fireEvent.click(save);
      fireEvent.click(save);
    });
    await settle();
    expect(save.disabled).toBe(true);
    snapshot();
    expect(startButton(review).disabled).toBe(true);
    expect(historicalStart.disabled).toBe(true);
    fireEvent.click(startButton(review));
    expect(state.calls.filter((c) => c.method === "missions.control")).toHaveLength(0);
    expect(state.calls.filter((c) => c.method === "missions.setMachine")).toHaveLength(1);

    // A realtime refresh can expose the saved path while the Save request is still in flight.
    await act(async () =>
      services.queryClient.setQueryData<Mission>(
        keys.mission(ORG_ID, mission.id),
        (current) => current && { ...current, repoDir: RECOVERY_FOLDER },
      ),
    );
    await settle();
    expect(startButton(review).disabled).toBe(true);
    expect(historicalStart.disabled).toBe(true);

    await act(async () => finish(RECOVERY_FOLDER));
    await settle();
    expect(repositoryFolder(review).value).toBe(RECOVERY_FOLDER);
    expect(historicalInput.value).toBe(RECOVERY_FOLDER);
    expect(saveFolderButton(review).disabled).toBe(true);
    expect(historicalStart.disabled).toBe(false);
    expect(startButton(review).disabled).toBe(false);
    await act(async () => fireEvent.click(startButton(review)));
    expect(state.calls.filter((c) => c.method === "missions.control")).toEqual([
      { method: "missions.control", args: [ORG_ID, mission.id, "start"] },
    ]);
  });

  test("blocks folder edits in the dialog while Start from the historical card is pending", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const { state, mission } = await taskMission({ historicalCard: true, start: () => pending });
    const historicalStart = startButton(screen());
    await act(async () => fireEvent.click(historicalStart));
    await settle();
    expect(historicalStart.disabled).toBe(true);

    const review = await openReview();
    const input = repositoryFolder(review);
    expect(input.disabled).toBe(true);
    expect(startButton(review).disabled).toBe(true);
    const form = input.closest("form");
    if (!form) throw new Error("The repository folder form is missing");
    fireEvent.change(input, { target: { value: RECOVERY_FOLDER } });
    await settle();
    expect(saveFolderButton(review).disabled).toBe(true);
    fireEvent.submit(form);
    expect(state.calls.filter((c) => c.method === "missions.setMachine")).toEqual([]);

    await act(async () => finish());
    await settle();
    expect(state.calls.filter((c) => c.method === "missions.control")).toEqual([
      { method: "missions.control", args: [ORG_ID, mission.id, "start"] },
    ]);
  });

  test("keeps a refused folder in the field and blocks Start", async () => {
    const { state } = await taskMission({
      saveFolder: async () => {
        throw new ApiError(400, "mission.bad_folder", "Server refused this folder");
      },
    });
    const review = await openReview();
    const input = repositoryFolder(review);
    fireEvent.change(input, { target: { value: RECOVERY_FOLDER } });
    await settle();
    await act(async () => fireEvent.click(saveFolderButton(review)));
    await settle();

    expect(review.getByText("A pasta precisa ficar dentro da pasta do agente.")).toBeTruthy();
    snapshot();
    expect(input.value).toBe(RECOVERY_FOLDER);
    expect(saveFolderButton(review).disabled).toBe(false);
    expect(startButton(review).disabled).toBe(true);
    fireEvent.click(startButton(review));
    expect(state.calls.filter((c) => c.method === "missions.control")).toHaveLength(0);
  });

  test.each(["/Users/james/checkout", String.raw`C:\checkout`, "repos/../checkout", String.raw`..\checkout`, "   "])(
    "blocks Save and Start for an invalid folder (%j)",
    async (invalidFolder) => {
      const { state } = await taskMission();
      const review = await openReview();
      const input = repositoryFolder(review);
      fireEvent.change(input, { target: { value: invalidFolder } });
      await settle();

      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(saveFolderButton(review).disabled).toBe(true);
      expect(startButton(review).disabled).toBe(true);
      fireEvent.click(saveFolderButton(review));
      fireEvent.click(startButton(review));
      expect(state.calls.filter((c) => c.method === "missions.setMachine" || c.method === "missions.control")).toEqual(
        [],
      );
    },
  );

  test.each([
    ["without an assigned machine", { machine: null }],
    ["with a running task", { runningTasks: 1 }],
    ["with comment-only access", { role: "comment", canAct: false, canManage: false }],
    ["with an owner role for someone else", { ownerId: "another-user" }],
  ] as const)("hides the editor %s", async (_name, patch) => {
    await taskMission({ historicalCard: true, patch });
    const review = await openReview();
    expect(review.queryByRole("textbox", { name: REPOSITORY_LABEL })).toBeNull();
    expect(document.querySelectorAll(".mi-plan input")).toHaveLength(0);
  });

  test.each([
    ["active", { status: "active" }],
    ["from another thread", { threadId: "another-thread" }],
    ["from another channel", { channelId: "another-channel" }],
  ] as const)("hides the editor when the fresh mission is %s", async (_name, detailPatch) => {
    await taskMission({ historicalCard: true, detailPatch });
    const review = await openReview();
    expect(review.queryByRole("textbox", { name: REPOSITORY_LABEL })).toBeNull();
    expect(review.queryAllByRole("button", { name: "Começar" })).toHaveLength(0);
    expect(document.querySelectorAll(".mi-plan input")).toHaveLength(0);
  });

  test("a pending save cannot replace a newer mission in the task", async () => {
    let finish!: (folder: string) => void;
    const pending = new Promise<string>((resolve) => {
      finish = resolve;
    });
    const { api, state, mission, services } = await taskMission({ saveFolder: () => pending });
    const review = await openReview();
    fireEvent.change(repositoryFolder(review), { target: { value: RECOVERY_FOLDER } });
    await settle();
    await act(async () => fireEvent.click(saveFolderButton(review)));

    const next = await api.missions.create(ORG_ID, {
      agentId: ADA_ID,
      channelId: ENG_ID,
      threadId: ROOT,
      title: TITLE,
      goal: "Verify the replacement checkout",
      folder: "repos/replacement",
    });
    await act(async () => services.queryClient.setQueryData(keys.threadMission(ORG_ID, ROOT), next));
    await settle();
    await act(async () => finish(RECOVERY_FOLDER));
    await settle();

    expect(services.queryClient.getQueryData<Mission>(keys.threadMission(ORG_ID, ROOT))?.id).toBe(next.id);
    expect(state.calls.filter((c) => c.method === "missions.setMachine")).toEqual([
      { method: "missions.setMachine", args: [ORG_ID, mission.id, "machine_1", RECOVERY_FOLDER] },
    ]);
    const nextReview = await openReview();
    expect(repositoryFolder(nextReview).value).toBe("repos/replacement");
    expect(startButton(nextReview).disabled).toBe(false);
  });

  test("a changed server folder discards the draft from the previous binding", async () => {
    const { mission, services } = await taskMission();
    const review = await openReview();
    fireEvent.change(repositoryFolder(review), { target: { value: RECOVERY_FOLDER } });
    await settle();
    expect(startButton(review).disabled).toBe(true);

    await act(async () =>
      services.queryClient.setQueryData<Mission>(
        keys.mission(ORG_ID, mission.id),
        (current) => current && { ...current, repoDir: "repos/updated-elsewhere" },
      ),
    );
    await settle();

    expect(repositoryFolder(review).value).toBe("repos/updated-elsewhere");
    expect(saveFolderButton(review).disabled).toBe(true);
    expect(startButton(review).disabled).toBe(false);
  });

  test("a replacement mission discards the previous mission's open draft", async () => {
    const { api, state, services } = await taskMission();
    const review = await openReview();
    fireEvent.change(repositoryFolder(review), { target: { value: RECOVERY_FOLDER } });
    await settle();
    expect(startButton(review).disabled).toBe(true);

    const next = await api.missions.create(ORG_ID, {
      agentId: ADA_ID,
      channelId: ENG_ID,
      threadId: ROOT,
      title: TITLE,
      goal: "Verify the replacement checkout",
      folder: "repos/replacement",
    });
    await act(async () => services.queryClient.setQueryData(keys.threadMission(ORG_ID, ROOT), next));
    await settle();

    const nextReview = await openReview();
    expect(repositoryFolder(nextReview).value).toBe("repos/replacement");
    expect(saveFolderButton(nextReview).disabled).toBe(true);
    fireEvent.click(saveFolderButton(nextReview));
    expect(state.calls.filter((c) => c.method === "missions.setMachine")).toEqual([]);
  });
});
