import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { cleanup } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { notification } from "./fakes/notifications";
import { renderApp, settle } from "./render";

afterEach(() => cleanup());

test("notification identity follows current agent IDs while historical text and draft/action labels stay intact", async () => {
  const current = "Elliott | Inbox and Correspondence";
  const kinds = ["browser_profile_request", "desktop_taken", "plan_lent", "change_request", "org_standing"] as const;
  const notifications = kinds.map((kind) =>
    notification({
      id: `identity-${kind}`,
      kind,
      actors: [{ type: "user", id: "u-joao" }],
      source: {
        agentId: ADA_ID,
        label: "Ada",
        ...(kind === "change_request" ? { proposalId: "proposal-target" } : {}),
      },
      latest: {
        text: "Ada wrote this original note.",
        ...(kind === "org_standing" ? { statusTo: "agent_hold" } : {}),
        ...(kind === "plan_lent" ? { plan: "Claude" } : {}),
      },
    }),
  );
  notifications.push(
    notification({
      id: "draft-name",
      kind: "change_request",
      actors: [{ type: "user", id: "u-joao" }],
      source: { agentId: ATLAS_ID, messageId: "new-agent", label: "New assistant" },
    }),
    notification({
      id: "thread-name",
      kind: "thread_reply",
      actors: [{ type: "user", id: "u-joao" }],
      source: { agentId: ADA_ID, channelId: ENG_ID, threadId: "m-1", label: "Ada quarterly notes" },
    }),
  );
  const state = seedState({ notifications });
  const agent = state.agents.find((a) => a.id === ADA_ID);
  if (agent) agent.name = current;
  const proposer = state.agents.find((a) => a.id === ATLAS_ID);
  if (proposer) proposer.name = "Jasper | Your Right Hand";
  const history = structuredClone(notifications.map(({ source, latest }) => ({ source, latest })));
  await renderApp(`/org/${ORG_ID}/notifications`, { api: createFakeApi(state) });
  await settle(10);
  for (const kind of kinds) {
    const headline = document.querySelector(`[data-n="identity-${kind}"] .nt-what`);
    expect(headline?.textContent).toContain(current);
    expect(headline?.textContent).not.toContain("Ada");
  }
  expect(document.querySelector('[data-n="draft-name"] .nt-what')?.textContent).toContain("New assistant");
  expect(document.querySelector('[data-n="draft-name"] .nt-what')?.textContent).not.toContain("Jasper");
  expect(document.querySelector('[data-n="thread-name"] .nt-what')?.textContent).toContain("Ada quarterly notes");
  expect(state.notifications?.map(({ source, latest }) => ({ source, latest }))).toEqual(history);
});
