import { afterEach, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION, type PlanUsage } from "@agenteschat/adapters";
import { planState } from "@agenteschat/ui/plan-state";
import { clearPlanLimits, computerBrainUnavailable, type MachineStatus, storedPlanLimit } from "../src";

/**
 * A model's own week (Claude's `model_scoped`, stored as `other` with the model's name) holds back that model only:
 * a full Fable week leaves Sonnet free while the account's shared windows have room. The account's windows, a full
 * window of the model itself and a refusal whose scope isn't known still hold every model.
 */

afterEach(() => clearPlanLimits());

const NOW = Date.parse("2026-11-19T02:00:00Z");
const at = (ms: number) => new Date(NOW + ms).toISOString();
const DAY = 86_400_000;

const usage = (windows: PlanUsage["windows"], over: Partial<PlanUsage> = {}): PlanUsage => ({
  windows,
  source: "probe",
  at: at(-60_000),
  ...over,
});

const status: MachineStatus = {
  id: "m1",
  orgId: "org",
  name: "Mac",
  online: true,
  execAllowed: true,
  os: "darwin",
  protocol: MACHINE_PROTOCOL_VERSION,
  executors: { claude: { version: "2.1.325", loggedIn: true }, detectedAt: at(-60_000) },
};

const unavailable = (u: PlanUsage, model?: string) =>
  computerBrainUnavailable("claude_code", "m1", status, NOW, undefined, true, u, model);

/** Jasper's reading: the shared week at 70%, the Fable week full. */
const fableFull = usage([
  { kind: "five_hour", usedPercent: 12, resetsAt: at(3 * 3600_000) },
  { kind: "seven_day", usedPercent: 70, resetsAt: at(3 * DAY) },
  { kind: "other", label: "Fable", usedPercent: 100, resetsAt: at(2 * DAY) },
]);

test("a full Fable week with the shared week at 70% holds back Fable, not Sonnet", () => {
  expect(storedPlanLimit(fableFull, NOW, "claude-fable-5-2")).toEqual({ until: NOW + 2 * DAY });
  expect(unavailable(fableFull, "claude-fable-5-2")?.code).toBe("plan_limit");
  expect(storedPlanLimit(fableFull, NOW, "sonnet")).toBeNull();
  expect(storedPlanLimit(fableFull, NOW, "claude-sonnet-5-5")).toBeNull();
  expect(unavailable(fableFull, "sonnet")).toBeNull();
  expect(planState(fableFull, NOW, "sonnet")).toEqual({ state: "ok", until: null, used: 70 });
});

test("a full Sonnet week, or a full shared window, still holds back Sonnet", () => {
  const sonnetFull = usage([
    { kind: "seven_day", usedPercent: 70, resetsAt: at(3 * DAY) },
    { kind: "seven_day_sonnet", usedPercent: 100, resetsAt: at(DAY) },
  ]);
  expect(unavailable(sonnetFull, "sonnet")?.code).toBe("plan_limit");
  expect(storedPlanLimit(sonnetFull, NOW, "sonnet")).toEqual({ until: NOW + DAY });
  // A Sonnet week a provider names as its own model week holds it back too.
  const namedSonnet = usage([{ kind: "other", label: "Sonnet", usedPercent: 100, resetsAt: at(DAY) }]);
  expect(unavailable(namedSonnet, "claude-sonnet-5-5")?.code).toBe("plan_limit");
  for (const kind of ["seven_day", "five_hour"] as const) {
    const shared = usage([
      { kind, usedPercent: 100, resetsAt: at(DAY) },
      { kind: "other", label: "Fable", usedPercent: 40, resetsAt: at(2 * DAY) },
    ]);
    expect(unavailable(shared, "sonnet")?.code).toBe("plan_limit");
    expect(unavailable(shared, "claude-fable-5-2")?.code).toBe("plan_limit");
  }
});

test("a refusal whose scope isn't known still holds back every model, a full Fable week or not", () => {
  const refused = usage([{ kind: "seven_day", usedPercent: 70, resetsAt: at(3 * DAY) }], {
    limited: true,
    source: "turn",
  });
  expect(unavailable(refused, "sonnet")?.code).toBe("plan_limit");
  const refusedFable = usage(fableFull.windows, { limited: true, source: "turn" });
  expect(unavailable(refusedFable, "sonnet")?.code).toBe("plan_limit");
  expect(unavailable(refusedFable, "claude-fable-5-2")?.code).toBe("plan_limit");
});

test("with no model named, or one that names no Claude model, a full model week holds as before", () => {
  expect(storedPlanLimit(fableFull, NOW)).toEqual({ until: NOW + 2 * DAY });
  expect(planState(fableFull, NOW).state).toBe("limited");
  expect(unavailable(fableFull)?.code).toBe("plan_limit");
  expect(unavailable(fableFull, "auto")?.code).toBe("plan_limit");
  expect(unavailable(fableFull, "default")?.code).toBe("plan_limit");
});

test("a window that is no model's own week holds every model, as before", () => {
  // Antigravity's group of models, and the account's extra usage and OAuth apps.
  for (const label of ["Claude and GPT models · 5h", "Extra usage", "OAuth apps"]) {
    const u = usage([{ kind: "other", label, usedPercent: 100, resetsAt: at(DAY) }]);
    expect(storedPlanLimit(u, NOW, "sonnet")).toEqual({ until: NOW + DAY });
  }
});

test("a model's week whose reset passed holds nothing", () => {
  const reset = usage([{ kind: "other", label: "Fable", usedPercent: 100, resetsAt: at(-1000) }]);
  expect(storedPlanLimit(reset, NOW, "claude-fable-5-2")).toBeNull();
});
