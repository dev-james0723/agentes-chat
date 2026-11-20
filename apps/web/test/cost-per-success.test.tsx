import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { CostPerSuccessRow } from "@agenteschat/client";
import { cleanup } from "@testing-library/react";
import { ATLAS_ID, createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

/** Settings › Usage shows cost per verified success (ADR 0206): unknown money reads unknown, never US$0. */
const row = (over: Partial<CostPerSuccessRow>): CostPerSuccessRow => ({
  runs: 3,
  failedRuns: 1,
  retries: 1,
  verifiedSuccesses: 1,
  tokens: 900,
  costUsd: 1.5,
  unknownCostRuns: 0,
  costPerSuccessUsd: 1.5,
  missing: null,
  text: "每個經人核實嘅成功任務平均成本 US$1.50（1 個成功，3 次運行共用 US$1.50）。",
  ...over,
});

test("each agent's cost per success; unknown cost and no success say so instead of a number", async () => {
  const state = seedState();
  const now = new Date().toISOString();
  state.costPerSuccess = {
    from: now,
    to: now,
    groups: [
      { agentId: ATLAS_ID, agentName: "Atlas", brain: "api", model: "claude-sonnet-5-5", ...row({}) },
      {
        agentId: ATLAS_ID,
        agentName: "Atlas",
        brain: "claude_code",
        model: null,
        ...row({ costUsd: null, costPerSuccessUsd: null, unknownCostRuns: 2, missing: "unknown_cost" }),
      },
      {
        agentId: ATLAS_ID,
        agentName: "Atlas",
        brain: "codex",
        model: "gpt-x",
        ...row({ verifiedSuccesses: 0, costPerSuccessUsd: null, missing: "no_success" }),
      },
    ],
    total: row({ costUsd: null, costPerSuccessUsd: null, missing: "unknown_cost", text: "每次成功成本：未知。" }),
  };
  await renderApp(`/org/${ORG_ID}/settings/usage`, { api: createFakeApi(state) });
  await settle(8);
  const title = await screen().findByText("Custo por sucesso verificado");
  const card = title.closest("[aria-labelledby]");
  const text = (card?.textContent ?? "").replace(/\s/g, " ");
  expect(text).toContain("por sucesso");
  expect(text).toContain("Custo desconhecido");
  expect(text).toContain("Nenhum sucesso verificado ainda");
  expect(text).toContain("每次成功成本：未知。");
  expect(text).not.toMatch(/\$ ?0,00/);
});
