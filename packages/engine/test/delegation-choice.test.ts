import { expect, test } from "bun:test";
import { chooseDelegate, type DelegateCandidate } from "../src/delegation-choice";
import type { Judge, JudgeRequest } from "../src/judge";
import { withJudgeFallback } from "../src/judge";

const candidates: DelegateCandidate[] = [
  { id: "qa-id", handle: "qa", name: "QA", role: "Independent review", can: "Read code", presence: "online" },
  { id: "dev-id", handle: "dev", name: "Dev", role: "Implementation", can: "Edit code", presence: "busy" },
];
const ids = { orgId: "org", agentId: "manager", runId: "run" };

test("delegation uses the calibrated workspace Jev judge and only bounded role metadata", async () => {
  let seen: JudgeRequest | undefined;
  const judge: Judge = {
    name: "jev",
    ask: async (request) => {
      seen = request;
      return { delegate: { choice: "qa-id", probabilities: { "qa-id": 0.94 }, confidence: 0.9 } };
    },
  };
  const result = await chooseDelegate(judge, ids, "Review a synthetic change independently", candidates);
  expect(result).toMatchObject({ status: "recommended", by: "jev", agentId: "qa-id", handle: "qa" });
  expect(seen).toMatchObject({ ...ids, kind: "agent_delegation", calibrated: true });
  expect(Object.keys(seen?.state ?? {}).sort()).toEqual(["candidates", "task"]);
  expect(seen?.questions.delegate).toMatchObject({ type: "choice" });
});

test("none and a Jev outage are explicit, never an LLM or arbitrary agent fallback", async () => {
  const none = await chooseDelegate(
    { name: "jev", ask: async () => ({ delegate: { choice: "none" } }) },
    ids,
    "task",
    candidates,
  );
  expect(none).toEqual({ status: "no_match", by: "jev" });
  const down = await chooseDelegate(
    {
      name: "jev",
      ask: async () => {
        throw new Error("down");
      },
    },
    ids,
    "task",
    candidates,
  );
  expect(down).toEqual({ status: "unavailable", by: "jev" });
});

test("a choice outside the authorized candidates is rejected", async () => {
  const result = await chooseDelegate(
    { name: "jev", ask: async () => ({ delegate: { choice: "hidden-agent" } }) },
    ids,
    "task",
    candidates,
  );
  expect(result).toEqual({ status: "invalid", by: "jev" });
});

test("the production fallback wrapper never uses the main LLM for a delegation decision", async () => {
  let fallbacks = 0;
  const judge = withJudgeFallback(
    {
      name: "jev",
      ask: async () => {
        throw new Error("no credit");
      },
    },
    {
      name: "llm",
      ask: async () => {
        fallbacks++;
        return { delegate: { choice: "dev-id" } };
      },
    },
  );
  expect(await chooseDelegate(judge, ids, "task", candidates)).toEqual({ status: "unavailable", by: "jev" });
  expect(fallbacks).toBe(0);
});

test("empty and oversized requests do not call Jev", async () => {
  let called = false;
  const judge: Judge = {
    name: "jev",
    ask: async () => {
      called = true;
      return {};
    },
  };
  expect(await chooseDelegate(judge, ids, "task", [])).toMatchObject({ status: "no_candidates" });
  expect(await chooseDelegate(judge, ids, "x".repeat(1201), candidates)).toMatchObject({ status: "invalid_input" });
  expect(called).toBe(false);
});
