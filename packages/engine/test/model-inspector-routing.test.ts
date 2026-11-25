import { expect, test } from "bun:test";
import { quotaReserveOf } from "../src/brains/select";
import type { Judge, JudgeRequest } from "../src/judge";
import { chooseModelInspectorRoute as choose } from "../src/model-inspector-routing";

const codex = {
  id: "codex-own",
  kind: "codex",
  model: "gpt-6.2",
  accountId: null,
  machineId: "machine",
  pool: "codex:machine:own",
  usedPercent: 20,
  quotaState: "normal",
  pressure: 0,
} as const;
const grok = {
  id: "grok-account",
  kind: "grok",
  model: "grok-4.7",
  accountId: "account",
  machineId: "machine",
  pool: "grok:machine:account",
  usedPercent: null,
  quotaState: "unknown",
  pressure: 0,
} as const;
const input = {
  orgId: "org",
  agentId: "agent",
  role: "Engineer",
  instructions: "Preserve existing work",
  task: "Implement a frontend using native tools",
  mission: true,
  routine: false,
  tools: ["read_file", "run_command"],
  candidates: [codex, grok],
};
const judge = (answer: (request: JudgeRequest) => Promise<Record<string, { choice: string }>>): Judge => ({
  name: "jev",
  ask: answer,
});

test("JEV can choose only a supplied route and returns fresh task tier and effort", async () => {
  let request: JudgeRequest | undefined;
  const result = await choose(
    judge(async (r) => {
      request = r;
      return { route: { choice: grok.id }, tier: { choice: "large" }, effort: { choice: "high" } };
    }),
    input,
  );
  expect(result).toMatchObject({ candidate: grok, tier: "large", effort: "high", source: "judge" });
  expect(request?.kind).toBe("model_inspector_route");
  expect(request?.calibrated).toBe(true);
  expect(request?.state.task).toBe(input.task);
  expect(request?.questions.route?.type).toBe("choice");
});

test("a fabricated JEV route cannot create a provider or account", async () => {
  const result = await choose(
    judge(async () => ({
      route: { choice: "paid-unconfigured-model" },
      tier: { choice: "large" },
      effort: { choice: "high" },
    })),
    input,
  );
  expect(result).toMatchObject({ candidate: codex, source: "fallback" });
});

test("fallback ranks proven room before unknown Grok capacity", async () => {
  const result = await choose(undefined, { ...input, candidates: [grok, codex] });
  expect(result?.candidate).toEqual(codex);
  expect(result?.source).toBe("fallback");
  expect(grok.usedPercent).toBeNull();
});

test("fallback includes shared-pool pressure instead of moving all agents to the same account", async () => {
  const crowded = { ...codex, pressure: 30 };
  const roomy = { ...codex, id: "codex-other", accountId: "other", pool: "codex:machine:other", usedPercent: 30 };
  const result = await choose(undefined, { ...input, candidates: [crowded, roomy] });
  expect(result?.candidate.id).toBe(roomy.id);
});

test("a slow or unavailable JEV does not stop deterministic routing", async () => {
  const result = await choose(
    judge(() => new Promise(() => {})),
    { ...input, timeoutMs: 5 },
  );
  expect(result).toMatchObject({ candidate: codex, source: "fallback" });
});

test("unknown capacity can be tried without inventing a percentage; no candidate returns null", async () => {
  expect(await choose(undefined, { ...input, candidates: [] })).toBeNull();
  expect(await choose(undefined, { ...input, candidates: [grok] })).toMatchObject({
    candidate: { usedPercent: null, quotaState: "unknown" },
    source: "fallback",
  });
});

test("routing refuses a candidate at the proactive threshold or malformed capacity", async () => {
  expect(
    await choose(undefined, {
      ...input,
      candidates: [
        { ...codex, usedPercent: 95 },
        { ...grok, usedPercent: Number.NaN },
      ],
    }),
  ).toBeNull();
});

test("model-specific quota reserve considers only the selected Claude model and stays unknown when stale", () => {
  const now = Date.now();
  const usage = {
    source: "probe" as const,
    at: new Date(now).toISOString(),
    windows: [
      { kind: "seven_day" as const, usedPercent: 80 },
      { kind: "seven_day_opus" as const, usedPercent: 99 },
      { kind: "other" as const, label: "Fable", usedPercent: 96 },
    ],
  };
  const pool = { kind: "claude_code" as const, machineId: "machine", accountId: null };
  expect(quotaReserveOf(usage, pool, { now, thresholdPercent: 95, model: "sonnet" })).toMatchObject({
    state: "normal",
    usedPercent: 80,
  });
  expect(quotaReserveOf(usage, pool, { now, thresholdPercent: 95, model: "opus" })).toMatchObject({
    state: "low",
    usedPercent: 99,
  });
  expect(quotaReserveOf(usage, pool, { now, thresholdPercent: 95, model: "claude-fable-5-2" })).toMatchObject({
    state: "low",
    usedPercent: 96,
  });
  expect(quotaReserveOf(usage, pool, { now: now + 300001, maxAgeMs: 300000, model: "opus" })).toMatchObject({
    state: "unknown",
  });
});
