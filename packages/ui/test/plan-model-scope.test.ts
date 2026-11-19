import { expect, test } from "bun:test";
import { planBinding, planState, planUsageForModel } from "../src/plan-state";

const now = Date.parse("2026-11-19T20:00:00Z");
const resetsAt = "2026-11-25T05:00:00.000Z";
const reading = {
  source: "probe",
  at: new Date(now).toISOString(),
  windows: [
    { kind: "seven_day", usedPercent: 81, resetsAt },
    { kind: "other", label: "Fable", usedPercent: 100, resetsAt },
  ],
};

test("model quota filtering keeps the raw overview and reading metadata intact", () => {
  const sonnet = planUsageForModel(reading, "claude-sonnet-4-6");
  expect(planState(sonnet, now)).toEqual({ state: "almost", used: 81, until: null });
  expect(planState(reading, now)).toEqual({ state: "limited", used: 100, until: resetsAt });
  expect(sonnet.source).toBe("probe");
  expect(sonnet.at).toBe(reading.at);
  expect(planState(planUsageForModel(reading, "claude-fable-5"), now).state).toBe("limited");
});

test("unattributed refusals survive model filtering", () => {
  expect(planState(planUsageForModel({ ...reading, limited: true }, "sonnet"), now).state).toBe("limited");
});

test("shared and non-model windows retain their hard-limit semantics", () => {
  for (const window of [
    { kind: "other", label: "Extra usage", usedPercent: 100, resetsAt },
    { kind: "other", label: "OAuth apps", usedPercent: 100, resetsAt },
    { kind: "other", usedPercent: 100, resetsAt },
    { kind: "unknown_shared", usedPercent: 100, resetsAt },
  ]) {
    expect(planState(planUsageForModel({ ...reading, windows: [window] }, "sonnet"), now).state).toBe("limited");
  }
  expect(
    planBinding(
      {
        ...reading,
        windows: [...reading.windows, { kind: "other", label: "Extra usage", usedPercent: 100, resetsAt }],
      },
      { model: "sonnet", now },
    )?.used,
  ).toBe(81);
});

test("legacy named weekly windows count only for their model family", () => {
  const usage = {
    ...reading,
    windows: [
      { kind: "seven_day", usedPercent: 81, resetsAt },
      { kind: "seven_day_opus", usedPercent: 100, resetsAt },
      { kind: "seven_day_sonnet", usedPercent: 94, resetsAt },
    ],
  };
  expect(planState(planUsageForModel(usage, "claude-sonnet-5-5"), now).used).toBe(94);
  expect(planState(planUsageForModel(usage, "opus"), now).state).toBe("limited");
  expect(planState(planUsageForModel(usage, "auto"), now).used).toBe(81);
});
