import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import {
  type AccountPutInput,
  deriveOverallRouterState,
  type GlobalModelRouterStatus,
  GlobalModelRouterView,
  mayReadGlobalModelRouter,
  type PolicyPatchInput,
} from "@/components/GlobalModelRouterCard";
import { createI18n } from "@/i18n";

afterEach(cleanup);

function makeBaseStatus(overrides: Partial<GlobalModelRouterStatus> = {}): GlobalModelRouterStatus {
  return {
    serverEnabled: true,
    canManagePolicy: true,
    observedAt: "2026-11-24T12:00:00.000Z",
    period: "2026-11",
    policy: {
      enabled: true,
      killSwitch: false,
      optOutAgentIds: [],
      maxEscalations: 2,
      maxRetriesPerRoute: 1,
      warnAt50: true,
      warnAt80: true,
      warnAt95: true,
      revision: 1,
    },
    accounts: [
      {
        id: "acct-or-free",
        provider: "openrouter",
        lane: "free_api",
        entitlement: "free_only",
        credentialId: "cred-or-free",
        workspaceAccountRef: null,
        enabled: true,
        killSwitch: false,
        monthlyCapNanoUsd: 0,
        spentNanoUsd: 0,
        heldNanoUsd: 0,
        allowedModels: ["nvidia/nemotron-3.5-super-vl:free"],
        rpmLimit: 20,
        rpdLimit: 50,
        dailyNeuronsLimit: 10000,
        dayRequestsUsed: 12,
        dayNeuronsUsed: 0,
        zdrRequired: true,
        allowedRegion: "global",
        healthState: "healthy",
        uiState: "eligible",
        resetsAt: "2026-11-25T00:00:00.000Z",
        quotaObservedAt: "2026-11-24T12:00:00.000Z",
      },
      {
        id: "acct-cf",
        provider: "cloudflare",
        lane: "free_api",
        entitlement: "free_only",
        credentialId: "cred-cf",
        workspaceAccountRef: "0123456789abcdef0123456789abcdef",
        enabled: true,
        killSwitch: false,
        monthlyCapNanoUsd: 0,
        spentNanoUsd: 0,
        heldNanoUsd: 0,
        allowedModels: ["@cf/openai/gpt-oss-120b"],
        rpmLimit: null,
        rpdLimit: null,
        dailyNeuronsLimit: 10000,
        dayRequestsUsed: 4,
        dayNeuronsUsed: 2400,
        zdrRequired: false,
        allowedRegion: "global",
        healthState: "healthy",
        uiState: "eligible",
        resetsAt: "2026-11-25T00:00:00.000Z",
        quotaObservedAt: "2026-11-24T12:00:00.000Z",
      },
    ],
    offers: [
      {
        offerId: "openrouter:nvidia/nemotron-3.5-super-vl:free",
        provider: "openrouter",
        lane: "free_api",
        modelId: "nvidia/nemotron-3.5-super-vl:free",
        label: "NVIDIA Nemotron 3.5 Super VL Free",
        freeEligible: true,
        qualificationStatus: "eligible",
        disabledReason: null,
        contextWindow: 131072,
        observedAt: "2026-11-24T12:00:00.000Z",
        expiresAt: "2026-11-24T13:00:00.000Z",
      },
    ],
    recentReceipts: [
      {
        id: "att-settled-1",
        runId: "run-1",
        routineRunId: null,
        agentId: "agent-1",
        turn: 1,
        lane: "free_api",
        provider: "openrouter",
        requestedModel: "nvidia/nemotron-3.5-super-vl:free",
        actualModel: "nvidia/nemotron-3.5-super-vl:free",
        reservedNanoUsd: 0,
        actualNanoUsd: 0,
        state: "settled",
        qualityVerified: true,
        latencyMs: 620,
        failureReason: null,
      },
    ],
    metrics: [
      {
        provider: "openrouter",
        lane: "free_api",
        model: "nvidia/nemotron-3.5-super-vl:free",
        attempts: 5,
        verifiedSuccesses: 5,
        totalSpendNanoUsd: 0,
        costPerVerifiedSuccessNanoUsd: 0,
        p50LatencyMs: 540,
        p95LatencyMs: 890,
      },
    ],
    latestBenchmark: {
      id: "bench-1",
      suiteVersion: "2026.11",
      taskCount: 35,
      modelCount: 32,
    },
    ...overrides,
  };
}

test("mayReadGlobalModelRouter requires owner or both manage_agents and view_usage", () => {
  expect(mayReadGlobalModelRouter({ role: "owner", permissions: [] })).toBe(true);
  expect(mayReadGlobalModelRouter({ role: "member", permissions: ["manage_agents", "view_usage"] })).toBe(true);
  expect(mayReadGlobalModelRouter({ role: "member", permissions: ["manage_agents"] })).toBe(false);
  expect(mayReadGlobalModelRouter({ role: "member", permissions: ["view_usage"] })).toBe(false);
});

test("deriveOverallRouterState distinguishes serverDisabled, disabled, stale_catalog, budget_held, and eligible", () => {
  expect(deriveOverallRouterState(makeBaseStatus({ serverEnabled: false }))).toBe("serverDisabled");
  expect(
    deriveOverallRouterState(
      makeBaseStatus({
        policy: { ...makeBaseStatus().policy, killSwitch: true },
      }),
    ),
  ).toBe("disabled");
  expect(deriveOverallRouterState(makeBaseStatus({ accounts: [] }))).toBe("disconnected");
  expect(
    deriveOverallRouterState(
      makeBaseStatus({
        offers: [
          {
            ...makeBaseStatus().offers[0]!,
            qualificationStatus: "stale",
            disabledReason: "stale_catalog",
          },
        ],
      }),
    ),
  ).toBe("stale_catalog");
  expect(
    deriveOverallRouterState(
      makeBaseStatus({
        accounts: [{ ...makeBaseStatus().accounts[0]!, uiState: "budget_held" }],
      }),
    ),
  ).toBe("budget_held");
  expect(deriveOverallRouterState(makeBaseStatus())).toBe("eligible");
});

test("renders quotas, Cloudflare neurons, receipts, benchmark summary, and enforces Cloudflare 32-hex Account ID", async () => {
  const savedPolicies: PolicyPatchInput[] = [];
  const savedAccounts: AccountPutInput[] = [];
  const releasedHolds: string[] = [];

  const status = makeBaseStatus({
    recentReceipts: [
      ...makeBaseStatus().recentReceipts,
      {
        id: "att-unknown-99",
        runId: "run-99",
        routineRunId: null,
        agentId: "agent-2",
        turn: 2,
        lane: "paid_low_cost",
        provider: "openrouter",
        requestedModel: "deepseek/deepseek-v4.1-flash-1017",
        actualModel: null,
        reservedNanoUsd: 5_000_000,
        actualNanoUsd: null,
        state: "unknown",
        qualityVerified: false,
        latencyMs: null,
        failureReason: "ambiguous_transport_outcome",
      },
    ],
  });

  const r = render(
    <I18nextProvider i18n={createI18n("en")}>
      <GlobalModelRouterView
        status={status}
        keys={[
          { id: "cred-cf", provider: "cloudflare", label: "Workers AI Free Key" },
          { id: "cred-or", provider: "openrouter", label: "OpenRouter Cap Key" },
        ]}
        pending={false}
        syncing={false}
        onSavePolicy={(p) => savedPolicies.push(p)}
        onSaveAccount={(a) => savedAccounts.push(a)}
        onReleaseHold={(id) => releasedHolds.push(id)}
      />
    </I18nextProvider>,
  );

  const screen = within(r.container);
  expect(screen.getByRole("status").textContent).toContain("Ready. Guarded before dispatch");
  expect(r.container.textContent).toContain("2400 / 10000 neurons");
  expect(r.container.textContent).toContain("12 / 50 RPD");
  expect(r.container.textContent).toContain("35 tasks · 32 models");

  // Reconcile unknown receipt
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Release hold" }));
  });
  expect(releasedHolds).toEqual(["att-unknown-99"]);

  // Select Cloudflare and verify 32-hex Account ID gate
  const saveLaneBtn = screen.getByRole("button", { name: "Save lane" }) as HTMLButtonElement;
  expect(saveLaneBtn.disabled).toBe(true);

  await act(async () => {
    fireEvent.change(screen.getByLabelText("Model provider"), { target: { value: "cloudflare" } });
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText("Dedicated provider key"), { target: { value: "cred-cf" } });
  });
  await act(async () => {
    fireEvent.input(screen.getByLabelText("Allowed concrete model IDs (one per line)"), {
      target: { value: "@cf/openai/gpt-oss-120b" },
    });
  });
  // Missing 32-hex account ID -> still disabled
  expect(saveLaneBtn.disabled).toBe(true);

  await act(async () => {
    fireEvent.change(screen.getByLabelText("Cloudflare 32-hex Account ID"), {
      target: { value: "abcdef0123456789abcdef0123456789" },
    });
  });
  expect(saveLaneBtn.disabled).toBe(false);

  await act(async () => {
    fireEvent.submit(saveLaneBtn.closest("form") as HTMLFormElement);
  });
  expect(savedAccounts).toMatchObject([
    {
      provider: "cloudflare",
      lane: "free_api",
      entitlement: "free_only",
      credentialId: "cred-cf",
      workspaceAccountRef: "abcdef0123456789abcdef0123456789",
      monthlyCapUsd: 0,
      allowedModels: ["@cf/openai/gpt-oss-120b"],
    },
  ]);

  // Save workspace policy with opted-out agent
  await act(async () => {
    fireEvent.input(screen.getByLabelText("Opted-out agent IDs (inherit router when empty)"), {
      target: { value: "agent-strict-1" },
    });
  });
  await act(async () => {
    fireEvent.submit(screen.getByRole("button", { name: "Save policy" }).closest("form") as HTMLFormElement);
  });
  expect(savedPolicies).toMatchObject([{ enabled: true, optOutAgentIds: ["agent-strict-1"] }]);
});

test("non-owner read-only viewer sees metrics and quotas in pt-BR without owner mutation forms", () => {
  const status = makeBaseStatus({ canManagePolicy: false });
  const r = render(
    <I18nextProvider i18n={createI18n("pt-BR")}>
      <GlobalModelRouterView status={status} keys={[]} locale="pt-BR" pending={false} syncing={false} />
    </I18nextProvider>,
  );
  const screen = within(r.container);
  expect(screen.getByRole("status").textContent).toContain("Pronto. Verificado antes do envio");
  expect(screen.queryByRole("button", { name: "Salvar política" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Salvar faixa" })).toBeNull();
});
