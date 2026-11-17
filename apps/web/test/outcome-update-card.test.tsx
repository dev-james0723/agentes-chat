import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { IssueFounderUpdate } from "@agenteschat/client";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { OutcomeUpdateCard } from "@/components/agents/OutcomeUpdateCard";
import { IssueDetails } from "@/pages/IssuePage";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderPage, settle } from "./render";

afterEach(() => cleanup());

const update: IssueFounderUpdate = {
  taskId: "task-1",
  taskRevision: 3,
  lifecycle: "in_progress",
  locale: "en",
  style: "simple",
  outcome: "The change is available locally. A failed check still needs attention.",
  deliveryStage: "CODED",
  availability: "local",
  checks: { passed: 4, failed: 1, notRun: 2, scope: "local unit tests" },
  howToTry: null,
  remaining: ["Fix the failed check"],
  blocker: { summary: "One check failed", ownerRef: "agent-1", nextAdmissibleAction: "Inspect the failed check" },
  nextOwner: { type: "agent", id: "agent-1" },
  decisionNeeded: false,
  evidence: [],
  generatedAt: "2026-11-16T12:00:00Z",
  contractUnavailable: [],
};

describe("native outcome update card", () => {
  test("simple preference keeps local availability and failed/unrun checks visible before disclosure", () => {
    const view = render(<OutcomeUpdateCard update={update} ownerName="Ada" />);
    expect(view.getByText("Local only")).toBeTruthy();
    expect(view.getByText(/1 failed/)).toBeTruthy();
    expect(view.getByText(/2 not run/)).toBeTruthy();
    expect(view.getByText("One check failed")).toBeTruthy();
    expect(view.getByText("Fix the failed check")).toBeTruthy();
    expect(view.getByText(/Ada/)).toBeTruthy();
    expect(view.queryByRole("region", { name: "Engineering evidence" })).toBeNull();
    expect(view.queryByText("How to try")).toBeNull();
  });

  test("technical preference expands details with an accessible keyboard button and keeps toggle focus", () => {
    const view = render(<OutcomeUpdateCard update={{ ...update, style: "technical" }} />);
    const toggle = view.getByRole("button", { name: "Engineering evidence" });
    expect(toggle.tagName).toBe("BUTTON");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(view.getByRole("region", { name: "Engineering evidence" })).toBeTruthy();
    toggle.focus();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle);
    expect(view.queryByRole("region", { name: "Engineering evidence" })).toBeNull();
  });

  test("unknown checks and receipt data never appear as zero failures or verified completion", () => {
    const view = render(
      <OutcomeUpdateCard
        update={{
          ...update,
          checks: null,
          evidence: [],
          deliveryStage: null,
          availability: "unknown",
          style: "technical",
        }}
      />,
    );
    expect(view.getByText("No check results recorded")).toBeTruthy();
    expect(view.getByText("Availability unknown")).toBeTruthy();
    expect(view.getByText("No authorized receipt data")).toBeTruthy();
    expect(view.queryByText(/0 failed/)).toBeNull();
    expect(view.queryByText("LIVE_VERIFIED")).toBeNull();
  });

  test("long zh-HK text and absent how-to remain readable with an announcement and last-updated time", () => {
    const outcome = "任務仍未通過驗證，請先處理失敗的檢查。".repeat(30);
    const view = render(<OutcomeUpdateCard update={{ ...update, locale: "zh-HK", outcome }} />);
    expect(view.getByRole("status").textContent).toContain(outcome);
    expect(view.getByText("只可在本機使用")).toBeTruthy();
    expect(view.queryByText("如何試用")).toBeNull();
    expect(view.container.querySelector("time")?.getAttribute("datetime")).toBe(update.generatedAt);
    expect(view.container.querySelector("section")?.style.overflowWrap).toBe("anywhere");
    expect(view.container.querySelector("section")?.getAttribute("lang")).toBe("zh-HK");
  });

  test("revoked evidence is named without an arbitrary external link", () => {
    const view = render(
      <OutcomeUpdateCard
        update={{
          ...update,
          style: "technical",
          evidence: [
            {
              id: "receipt-old",
              kind: "live_check",
              status: "revoked",
              environment: "preview",
              sourceRevision: "git-old",
              stage: null,
            },
          ],
        }}
      />,
    );
    expect(view.getByText(/revoked/)).toBeTruthy();
    expect(view.getByText(/receipt-old/)).toBeTruthy();
    expect(view.container.querySelector("a")).toBeNull();
  });

  test("native task details render the read-only projection only when the detail API supplies it", async () => {
    const api = createFakeApi(seedState());
    const issue = await api.issues.create(ORG_ID, { title: "Inspect this task" });
    await renderPage(
      <IssueDetails
        issue={{ ...issue, founderUpdate: { ...update, taskId: issue.id } }}
        variant="page"
        onConversation={() => {}}
      />,
      { api, org: true },
    );
    await settle(2);
    expect(document.querySelector('[aria-label="Outcome update"]')).toBeTruthy();
    cleanup();
    await renderPage(<IssueDetails issue={issue} variant="page" onConversation={() => {}} />, { api, org: true });
    await settle(2);
    expect(document.querySelector('[aria-label="Outcome update"]')).toBeNull();
  });
});
