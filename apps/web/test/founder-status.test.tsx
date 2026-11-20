import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { FounderStatus } from "@agenteschat/client";
import { cleanup } from "@testing-library/react";
import { FounderStatusBody } from "@/components/FounderStatus";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderPage, settle } from "./render";

afterEach(() => cleanup());

// ADR 0204: the panel shows the server's evidence lines as they are, and Needs you only with a real request.

const status = (over: Partial<FounderStatus> = {}): FounderStatus => ({
  issueId: "i1",
  number: 7,
  observedAt: "2026-11-19T10:00:00Z",
  changed: { title: "Preview", pullRequests: [], why: null, text: "改動：#7「Preview」（PR #42）。" },
  delivery: {
    state: "merged_not_deployed",
    available: false,
    merge: null,
    deploy: null,
    running: null,
    text: "程式碼：已合併（aaaaaaaaa），但未有部署紀錄，現用版本未有。",
  },
  verification: {
    state: "done_unverified",
    verified: false,
    criteria: { total: 1, checkedByPerson: 0 },
    checks: [],
    text: "驗收：標咗完成，但冇人逐項驗收嘅紀錄（0／1 項由人剔過），只算「已實作」。",
  },
  blockers: [],
  next: { action: "deploy", owner: null, text: "下一步：部署到現用版本（負責人：未有紀錄）。" },
  needsMe: { needed: false, decisions: [], text: "唔使你決定任何嘢。" },
  summary: "",
  ...over,
});

const render = async (s: FounderStatus) => {
  await renderPage(<FounderStatusBody status={s} />, { api: createFakeApi(seedState()), org: true });
  await settle(2);
  return document.body;
};

describe("a task's evidence status", () => {
  test("negative control: merged but not deployed, done but not verified: neither shows as so", async () => {
    const body = await render(status());
    expect(body.textContent).toContain("Fora do app em uso");
    expect(body.textContent).toContain("Não verificada");
    expect(body.textContent).not.toContain("Precisa de você");
    expect(body.querySelector("ul")?.getAttribute("lang")).toBe("zh-HK");
    expect(body.textContent).toContain("未有部署紀錄");
  });

  test("a real pending approval: Needs you, linking to that approval's own details", async () => {
    const decision = {
      approvalId: "ap-1",
      title: "Merge PR #42 in acme/app",
      channelId: "c",
      threadId: "t",
      messageId: "m",
      expiresAt: "2026-11-19T11:00:00Z",
    };
    const body = await render(
      status({
        delivery: { ...status().delivery, state: "available", available: true, text: "部署：已喺現用版本。" },
        needsMe: { needed: true, decisions: [decision], text: "要你決定：1 項等緊你批准。" },
      }),
    );
    expect(body.textContent).toContain("No app em uso");
    expect(body.textContent).toContain("Precisa de você");
    const link = [...body.querySelectorAll("a")].find((a) => a.textContent === decision.title);
    expect(link?.getAttribute("href")).toBe(`/org/${ORG_ID}/approvals?open=ap-1`);
  });
});
