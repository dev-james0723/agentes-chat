import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Mission, MissionPlanVersion, ThreadInfo } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

const ROOT = "00000000-0000-4000-8000-000000000182";
const TITLE = "HeyTracki native preview";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

async function taskMission(
  options: { historicalCard?: boolean; patch?: Partial<Mission>; channelKind?: ThreadInfo["channelKind"] } = {},
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
  api.missions.ofThread = async (...args) => ({ ...(await ofThread(...args)), ...options.patch });
  api.missions.get = async (...args) => ({ ...(await getMission(...args)), ...options.patch });
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
  });
});
