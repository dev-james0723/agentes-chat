import { afterEach, expect, test } from "bun:test";
import type { PlanUsage } from "@agenteschat/adapters";
import {
  bindingReset,
  clearPlanLimits,
  computerBrainUnavailable,
  notePlanLimit,
  planLimitOf,
  storedPlanLimit,
} from "../src/brains/select";
import type { MachineStatus } from "../src/machine-hub";

const now = Date.parse("2026-11-19T20:00:00Z");
const weeklyReset = "2026-11-25T05:00:00.000Z";
const fableReset = "2026-11-26T05:00:00.000Z";
const usage: PlanUsage = {
  plan: "ultra",
  source: "probe",
  at: new Date(now).toISOString(),
  windows: [
    { kind: "seven_day", usedPercent: 81, resetsAt: weeklyReset },
    { kind: "other", label: "Fable", usedPercent: 100, resetsAt: fableReset },
  ],
};
const status: MachineStatus = {
  id: "m1",
  orgId: "org",
  name: "Mac",
  online: true,
  execAllowed: true,
  os: "darwin",
  protocol: 8,
  executors: { claude: { version: "2.1.300", loggedIn: true }, detectedAt: usage.at },
};
const unavailable = (reading: PlanUsage, model?: string) =>
  computerBrainUnavailable("claude_code", "m1", status, now, undefined, true, reading, model);
afterEach(clearPlanLimits);

test.each(["sonnet", "claude-sonnet-4-6", "opus", undefined])(
  "Fable's full week does not refuse eligible Claude model %s",
  (model) => {
    expect(unavailable(usage, model)).toBeNull();
  },
);

test.each(["fable", "claude-fable-5", "FABLE"])("Fable's full week still refuses %s", (model) => {
  expect(unavailable(usage, model)).toMatchObject({ code: "plan_limit", resetsAt: fableReset });
});

test("a shared full week refuses Sonnet even when a different model is full too", () => {
  const full: PlanUsage = {
    ...usage,
    windows: usage.windows.map((w) => (w.kind === "seven_day" ? { ...w, usedPercent: 100 } : w)),
  };
  expect(unavailable(full, "sonnet")).toMatchObject({ code: "plan_limit", resetsAt: weeklyReset });
});

test("a refusal without model attribution is retained after unrelated windows are removed", () => {
  expect(unavailable({ ...usage, limited: true }, "sonnet")?.code).toBe("plan_limit");
  expect(unavailable({ ...usage, limited: true, windows: [] }, "sonnet")?.code).toBe("plan_limit");
  notePlanLimit("m1", "claude_code", fableReset, now);
  expect(unavailable(usage, "sonnet")?.code).toBe("plan_limit");
});

test("the chosen model's wait reset and presence do not inherit Fable's later reset", () => {
  const full: PlanUsage = {
    ...usage,
    windows: usage.windows.map((w) => (w.kind === "seven_day" ? { ...w, usedPercent: 100 } : w)),
  };
  expect(storedPlanLimit(usage, now, "sonnet")).toBeNull();
  expect(bindingReset(full, now, "sonnet")).toBe(Date.parse(weeklyReset));
  expect(planLimitOf("m1", "claude_code", undefined, usage, now, "sonnet")).toBeNull();
  expect(planLimitOf("m1", "claude_code", undefined, usage, now, "fable")).toEqual({
    until: Date.parse(fableReset),
  });
});

test("other providers keep their existing account window semantics", () => {
  expect(planLimitOf("m1", "codex", undefined, usage, now, "sonnet")).toEqual({
    until: Date.parse(fableReset),
  });
});

test("Claude CLI accounts of other providers retain their account-wide windows", () => {
  expect(planLimitOf("m1", "claude_code", "account", usage, now, "sonnet", "opencode")).toEqual({
    until: Date.parse(fableReset),
  });
});

test("an unrelated expired model window cannot clear a recent unattributed refusal", () => {
  const refused: PlanUsage = {
    source: "turn",
    at: new Date(now - 10_000).toISOString(),
    limited: true,
    windows: [
      { kind: "seven_day", usedPercent: 81 },
      { kind: "other", label: "Fable", usedPercent: 100, resetsAt: new Date(now - 1000).toISOString() },
    ],
  };
  expect(storedPlanLimit(refused, now, "sonnet")).toEqual({ until: null });
});
