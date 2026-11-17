import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Issue } from "@agenteschat/client";
import { ApiError, keys } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

type Report = NonNullable<Issue["deliveryReport"]>;
const TITLE = "交付驗證畫面測試";
const HOW = "逐個目標查看目前狀態同未完成驗證；技術紀錄由原生任務嘅私有詳情查閱。";
const PRIVATE = "PRIVATE_DELIVERY_EVIDENCE_83fe";

afterEach(() => {
  cleanup();
  setSystemTime();
});

const report = (now: number, over: Partial<Report> = {}): Report => ({
  locale: "zh-HK",
  userVisibleOutcome: "所選目標已核實可用；結果以列出嘅核查時間為準。",
  howToUse: HOW,
  currentAvailability: "available",
  publicTargets: [{ label: "目標 1", state: "available", text: "已核實可用。", missingGates: [] }],
  targetsOmitted: 0,
  missingGateLabels: [],
  ownerStatus: "發布負責人待核實。",
  nextStep: "保留最新驗證紀錄，按原有流程完成收口。",
  ownerDecisionRequired: false,
  freshness: { generatedAt: new Date(now).toISOString(), result: "pass", coverage: "complete" },
  isAuthorizationGrant: false,
  ...over,
});

/** Real route fixtures: the list has no report, matching the native API's detail-only projection. */
async function fixture(stored?: Report) {
  const state = seedState();
  const person = state.me?.user;
  if (!person) throw new Error("Expected signed-in fixture person");
  const api = createFakeApi(state);
  const issue = await api.issues.create(ORG_ID, {
    title: TITLE,
    assignee: { type: "person", id: person.id },
  });
  const originalGet = api.issues.get;
  let reads = 0;
  let failure: Error | null = null;
  api.issues.get = async (...args) => {
    reads++;
    if (failure) throw failure;
    const current = await originalGet(...args);
    return {
      ...current,
      work: null,
      ...(stored ? { deliveryReport: stored } : {}),
    };
  };
  return {
    api,
    issue,
    reads: () => reads,
    fail: (error: Error) => {
      failure = error;
    },
  };
}

async function open(f: Awaited<ReturnType<typeof fixture>>, surface: "page" | "dialog") {
  const rendered = await renderApp(`/org/${ORG_ID}/issues${surface === "page" ? `/${f.issue.number}` : ""}`, {
    api: f.api,
  });
  await settle(8);
  if (surface === "dialog") {
    const row = document.querySelector(`[data-card="${f.issue.number}"]`);
    expect(row).not.toBeNull();
    if (!row) throw new Error("Expected actual task board row");
    await act(async () => fireEvent.click(row));
    await settle(6);
  }
  return rendered;
}

const card = () => screen().getByRole("region", { name: "交付驗證" });

describe("delivery status in the actual web task views", () => {
  test("the actual web issue route shows public outcome, usage, missing gates, owner and next action", async () => {
    const now = Date.now();
    const stored = Object.assign(
      report(now, {
        currentAvailability: "unknown",
        userVisibleOutcome: "目前可用狀態未核實。",
        publicTargets: [
          { label: "目標 1", state: "unknown", text: "目前狀態未核實。", missingGates: ["實際運行版本"] },
        ],
        missingGateLabels: ["實際運行版本"],
        ownerDecisionRequired: null,
        freshness: { generatedAt: new Date(now).toISOString(), result: "unknown", coverage: "incomplete" },
      }),
      {
        privateDetails: { evidenceRefs: [PRIVATE], owner: "/Users/private-owner" },
        availableNow: { [PRIVATE]: true },
      },
    );
    const f = await fixture(stored);
    await open(f, "page");
    expect(document.body.textContent).toContain(TITLE);
    expect(f.reads()).toBeGreaterThan(0);
    const section = card();
    expect(section.textContent).toContain("目前可用狀態未核實");
    expect(section.textContent).toContain(`點樣用：${HOW}`);
    expect(section.textContent).toContain("尚欠：實際運行版本");
    expect(section.textContent).toContain("發布負責人待核實。");
    expect(section.textContent).toContain("是否需要負責人決定：待核實。");
    expect(section.textContent).toContain("下一步：重新讀取原生證據");
    expect(section.textContent).toContain("狀態整理時間：");
    expect(section.textContent).not.toContain("實際驗證時間");
    for (const hidden of [
      PRIVATE,
      "/Users/private-owner",
      f.issue.id,
      "availableNow",
      "privateDetails",
      "isAuthorizationGrant",
    ])
      expect(section.textContent).not.toContain(hidden);
    expect(within(section).queryByRole("button")).toBeNull();
  });

  test("the actual task board dialog reads its detail report although list rows have none", async () => {
    const f = await fixture(report(Date.now()));
    const listed = (await f.api.issues.list(ORG_ID)).find((i) => i.id === f.issue.id);
    expect(listed?.deliveryReport).toBeUndefined();
    await open(f, "dialog");
    expect(f.reads()).toBeGreaterThan(0);
    const dialog = screen().getAllByRole("dialog").at(-1);
    if (!dialog) throw new Error("Expected actual task dialog");
    const section = within(dialog).getByRole("region", { name: "交付驗證" });
    expect(section.textContent).toContain("已核實可用");
    expect(section.textContent).toContain(`點樣用：${HOW}`);
    expect(section.textContent).toContain("今次資料未顯示需要負責人決定。");
  });

  for (const surface of ["page", "dialog"] as const) {
    test(`an ordinary task or older server without a report keeps the ${surface} unchanged`, async () => {
      const f = await fixture();
      await open(f, surface);
      expect(document.body.textContent).toContain(TITLE);
      expect(screen().queryByRole("region", { name: "交付驗證" })).toBeNull();
    });

    test(`cached green in the ${surface} expires with no worker or new detail read`, async () => {
      const now = Date.now();
      setSystemTime(new Date(now));
      const stored = report(now);
      const f = await fixture(stored);
      const rendered = await open(f, surface);
      expect(card().textContent).toContain("已核實可用");
      expect(rendered.services.queryClient.getQueryData<Issue>(keys.issue(ORG_ID, f.issue.number))?.work).toBeNull();
      const beforeExpiry = f.reads();
      setSystemTime(new Date(now + 60_001));
      // useNow's existing real one-second timer expires the display without another HTTP read.
      await act(() => new Promise((resolve) => setTimeout(resolve, 1_100)));
      await settle(2);
      expect(card().textContent).toContain("核查資料已過期");
      expect(card().textContent).not.toContain("已核實可用");
      expect(card().textContent).toContain(`點樣用：${HOW}`);
      expect(card().textContent).toContain("是否需要負責人決定：待核實。");
      expect(f.reads()).toBe(beforeExpiry);
      expect(stored.currentAvailability).toBe("available");
    });

    test(`a failed detail refresh immediately downgrades cached green in the ${surface}`, async () => {
      const now = Date.now();
      setSystemTime(new Date(now));
      const stored = report(now);
      const f = await fixture(stored);
      const rendered = await open(f, surface);
      expect(card().textContent).toContain("已核實可用");
      expect(rendered.services.queryClient.getQueryData<Issue>(keys.issue(ORG_ID, f.issue.number))?.work).toBeNull();
      f.fail(new Error(`Fixture read failure with ${PRIVATE}`));
      const beforeRefresh = f.reads();
      await act(async () => {
        await rendered.services.queryClient.refetchQueries({
          queryKey: keys.issue(ORG_ID, f.issue.number),
          exact: true,
        });
      });
      await settle(2);
      expect(f.reads()).toBeGreaterThan(beforeRefresh);
      expect(Date.now() - now).toBeLessThan(60_000);
      expect(card().textContent).not.toContain("已核實可用");
      expect(card().textContent).toContain("目前可用狀態未核實");
      expect(card().textContent).toContain(`點樣用：${HOW}`);
      expect(card().textContent).toContain("是否需要負責人決定：待核實。");
      expect(card().textContent).not.toContain(PRIVATE);
      expect(stored.currentAvailability).toBe("available");
      expect(
        rendered.services.queryClient.getQueryData<Issue>(keys.issue(ORG_ID, f.issue.number))?.deliveryReport
          ?.currentAvailability,
      ).toBe("available");
    });
  }

  for (const surface of ["page", "dialog"] as const) {
    for (const status of [401, 403, 404]) {
      test(`a denied ${status} detail read removes the ${surface} report despite its cached data`, async () => {
        const f = await fixture(report(Date.now()));
        const rendered = await open(f, surface);
        expect(card().textContent).toContain("已核實可用");
        f.fail(new ApiError(status, "not_available", `Fixture task is no longer visible: ${PRIVATE}`));
        await act(async () => {
          await rendered.services.queryClient.refetchQueries({
            queryKey: keys.issue(ORG_ID, f.issue.number),
            exact: true,
          });
        });
        await settle(3);
        expect(screen().queryByRole("region", { name: "交付驗證" })).toBeNull();
        expect(document.body.textContent).not.toContain(PRIVATE);
      });
    }
  }
});
