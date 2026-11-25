import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { openTarget } from "@agenteschat/client/lib/notifications";
import { cleanup, render, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import {
  CreditContinuityView,
  type CreditContinuityViewStatus,
  mayReadCreditContinuity,
} from "@/components/CreditContinuityCard";
import { createI18n, type LocaleCode } from "@/i18n";
import { notification } from "./fakes/notifications";

afterEach(cleanup);
function renderView(node: ReactNode, locale: LocaleCode = "en") {
  return render(<I18nextProvider i18n={createI18n(locale)}>{node}</I18nextProvider>);
}
const USD = 1e9;
function status(enabled = false): CreditContinuityViewStatus {
  return {
    enabled,
    state: enabled ? "available" : "disabled",
    observedAt: "2026-11-20T12:00:00Z",
    unresolvedCount: 1,
    pools: [
      {
        provider: "anthropic",
        enabled: true,
        paused: false,
        status: "available",
        evidenceStatus: "verified",
        pricingStatus: "verified",
        eligibleRouteCount: 1,
        verifiedAt: "2026-11-20T11:59:00Z",
        validUntil: "2026-11-20T13:00:00Z",
        grantExpiresAt: "2026-12-13T00:00:00Z",
        grantAmountNanoUsd: 200 * USD,
        automaticLimitNanoUsd: 120 * USD,
        emergencyLimitNanoUsd: 60 * USD,
        safetyBufferNanoUsd: 20 * USD,
        automaticAvailableNanoUsd: enabled ? 105 * USD : 0,
        approvedEmergencyAvailableNanoUsd: 0,
        activeReserveApprovalCount: 0,
        spentNanoUsd: 12 * USD,
        heldNanoUsd: 3 * USD,
        forecast: { sampleCount: 3, p95NanoUsd: 2 * USD, uncertainty: "high" },
      },
    ],
  };
}
function fixturePool(s: CreditContinuityViewStatus) {
  const pool = s.pools[0];
  if (!pool) throw new Error("missing fixture pool");
  return pool;
}
test("the existing usage card shows held costs even while admission is disabled", () => {
  const r = renderView(<CreditContinuityView status={status()} />);
  const screen = within(r.container);
  expect(screen.getByRole("status").textContent).toContain("disabled");
  const row = screen.getByRole("row", { name: /Claude API/ });
  expect(row.textContent).toContain("$12.00");
  expect(row.textContent).toContain("$3.00");
  expect(row.textContent).toContain("$60.00");
  expect(row.textContent).toContain("Owner approval");
  expect(row.textContent).toContain("$20.00");
  expect(r.container.textContent).toContain("reserved or unresolved costs");
});
test("unknown history and missing grant evidence never appear as verified available credits", () => {
  const s = status(true);
  s.state = "unverified";
  Object.assign(fixturePool(s), {
    evidenceStatus: "unverified",
    automaticAvailableNanoUsd: 0,
    automaticLimitNanoUsd: 0,
    emergencyLimitNanoUsd: 0,
    safetyBufferNanoUsd: 0,
    verifiedAt: null,
    grantExpiresAt: null,
    forecast: { sampleCount: 0, p95NanoUsd: null, uncertainty: "unknown" },
  });
  const r = renderView(<CreditContinuityView status={s} />);
  expect(r.container.textContent).toContain("No eligible API grants have been verified");
  expect(r.container.textContent).toContain("Not verified");
  expect(r.container.textContent).toContain("Insufficient history");
  expect(r.container.textContent).not.toContain("Ready");
});
test("unavailable accounting stays unknown and empirical p95 is explicitly uncertain", () => {
  const s = status(true);
  s.state = "unavailable";
  Object.assign(fixturePool(s), { evidenceStatus: "unavailable", spentNanoUsd: null, heldNanoUsd: null });
  const r = renderView(<CreditContinuityView status={s} />);
  expect(r.container.textContent).toContain("Unknown");
  expect(r.container.textContent).toContain("3 settled units. High uncertainty.");
  expect(r.container.textContent).toContain("Historical forecasts do not authorize spending");
});
test("the card requires both existing management and usage permissions", () => {
  expect(mayReadCreditContinuity({ permissions: ["manage_agents"] })).toBe(false);
  expect(mayReadCreditContinuity({ permissions: ["view_usage"] })).toBe(false);
  expect(mayReadCreditContinuity({ permissions: ["manage_agents", "view_usage"] })).toBe(true);
  expect(mayReadCreditContinuity({})).toBe(false);
});
test("one credit incident opens the existing usage dashboard rather than a new task or billing purchase", () => {
  const n = notification({
    id: "credit-incident",
    kind: "credit_continuity",
    latest: {
      title: "Claude API grant continuity",
      text: "An API result needs reconciliation.",
      reason: "reconciliation_required",
    },
  });
  expect(openTarget(n)).toEqual({ to: "/org/$orgId/settings/$section", params: { section: "usage" } });
});

test("a verified grant with expired pricing is blocked while existing obligations stay visible", () => {
  const s = status(true);
  s.state = "blocked";
  Object.assign(fixturePool(s), { pricingStatus: "expired", eligibleRouteCount: 0, automaticAvailableNanoUsd: 0 });
  const r = renderView(<CreditContinuityView status={s} />);
  expect(r.container.textContent).toContain("Pricing expired");
  expect(r.container.textContent).toContain("$12.00");
  expect(r.container.textContent).not.toContain("Ready");
});

test("an active owner reserve remains visibly available after the automatic bucket is spent", () => {
  const s = status(true);
  Object.assign(fixturePool(s), {
    automaticAvailableNanoUsd: 0,
    approvedEmergencyAvailableNanoUsd: 25 * USD,
    activeReserveApprovalCount: 1,
  });
  const r = renderView(<CreditContinuityView status={s} />);
  expect(r.container.textContent).toContain("Owner reserve available");
  expect(r.container.textContent).toContain("Approved available: $25.00");
  expect(r.container.textContent).toContain("1 active owner approval");
});
test("the person's selected language covers grant status, evidence and reserve approvals", () => {
  const s = status(true);
  Object.assign(fixturePool(s), {
    automaticAvailableNanoUsd: 0,
    approvedEmergencyAvailableNanoUsd: 25 * USD,
    activeReserveApprovalCount: 2,
  });
  const r = renderView(<CreditContinuityView status={s} locale="pt-BR" />, "pt-BR");
  expect(r.container.textContent).toContain("Reserva do dono disponível");
  expect(r.container.textContent).toContain("2 aprovações ativas do dono");
  expect(r.container.textContent).toContain("Incerteza alta");
  expect(r.container.textContent).not.toContain("Owner reserve");
  expect(r.container.textContent).not.toContain("creditContinuity.");
});

test("a reconciliation hold takes precedence over a stale positive budget display", () => {
  const s = status(true);
  s.state = "blocked";
  Object.assign(fixturePool(s), { status: "reconciliation_required" });
  const r = renderView(<CreditContinuityView status={s} />);
  expect(r.container.textContent).toContain("Reconciliation required");
  expect(r.container.textContent).not.toContain("Ready");
  expect(r.container.textContent).not.toContain("reconciliation_required");
});
