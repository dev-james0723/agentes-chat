import { expect, test } from "bun:test";
import { chooseDelegate, type DelegateCandidate, MAX_DELEGATE_CANDIDATES } from "../src/delegation-choice";
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
  const result = await chooseDelegate(
    judge,
    ids,
    "Review a synthetic change independently",
    candidates,
    "independent_reviewer",
  );
  expect(result).toMatchObject({ status: "recommended", by: "jev", agentId: "qa-id", handle: "qa" });
  expect(seen).toMatchObject({ ...ids, kind: "agent_delegation", calibrated: true });
  expect(Object.keys(seen?.state ?? {}).sort()).toEqual(["candidates", "purpose", "task", "taskFit"]);
  expect(seen?.questions.delegate).toMatchObject({ type: "choice" });
});

test("none and a Jev outage are explicit, never an LLM or arbitrary agent fallback", async () => {
  const none = await chooseDelegate(
    { name: "jev", ask: async () => ({ delegate: { choice: "none" } }) },
    ids,
    "task",
    candidates,
    "independent_reviewer",
  );
  expect(none).toMatchObject({ status: "no_match", by: "jev", taskFit: "unverified", decisionCalls: 1 });
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
    "independent_reviewer",
  );
  expect(down).toMatchObject({ status: "unavailable", by: "jev", decisionCalls: 1 });
});

test("a choice outside the authorized candidates is rejected", async () => {
  const result = await chooseDelegate(
    { name: "jev", ask: async () => ({ delegate: { choice: "hidden-agent" } }) },
    ids,
    "task",
    candidates,
    "independent_reviewer",
  );
  expect(result).toMatchObject({ status: "invalid", by: "jev", decisionCalls: 1 });
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
  expect(await chooseDelegate(judge, ids, "task", candidates, "independent_reviewer")).toMatchObject({
    status: "unavailable",
    by: "jev",
    decisionCalls: 1,
  });
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

for (const task of [
  "Choose accountable department coordinator",
  "搵部門coordinator",
  "請選部門協調人",
  "Choose設計coordinator",
]) {
  test(`missing typed purpose stays unknown before Judge: ${task}`, async () => {
    let calls = 0;
    const judge: Judge = {
      name: "offline",
      ask: async () => {
        calls++;
        return { delegate: { choice: "qa-id", confidence: 0.88 } };
      },
    };
    expect(await chooseDelegate(judge, ids, task, candidates)).toMatchObject({
      status: "insufficient_scope",
      by: "rules",
      decisionCalls: 0,
    });
    expect(calls).toBe(0);
  });
}

test("duplicate/reserved candidate IDs and over-wide shortlists do not reach Judge", async () => {
  let calls = 0;
  const judge: Judge = {
    name: "offline",
    ask: async () => {
      calls++;
      return {};
    },
  };
  const first = candidates[0];
  if (!first) throw Error("fixture missing");
  for (const pool of [
    [...candidates, first],
    [{ ...first, id: "none" }],
    Array.from({ length: MAX_DELEGATE_CANDIDATES + 1 }, (_, n) => ({ ...first, id: `candidate-${n}` })),
  ]) {
    expect((await chooseDelegate(judge, ids, "bounded task", pool, "implementer")).decisionCalls).toBe(0);
  }
  expect(calls).toBe(0);
});

test("the declared shortlist maximum is accepted in exactly one advisory decision", async () => {
  const first = candidates[0];
  if (!first) throw Error("fixture missing");
  const pool = Array.from({ length: MAX_DELEGATE_CANDIDATES }, (_, n) => ({ ...first, id: `candidate-${n}` }));
  let calls = 0;
  const judge: Judge = {
    name: "offline",
    ask: async (request) => {
      calls++;
      expect(request.state.candidates).toHaveLength(MAX_DELEGATE_CANDIDATES);
      return { delegate: { choice: "candidate-0" } };
    },
  };
  expect(await chooseDelegate(judge, ids, "bounded task", pool, "implementer")).toMatchObject({
    status: "recommended",
    agentId: "candidate-0",
    decisionCalls: 1,
  });
  expect(calls).toBe(1);
});

test("stalled accounting cannot hold an advisory decision beyond its local six-second settlement budget", async () => {
  const { createJevJudge } = await import("../src/judge");
  let release: () => void = () => {};
  const accounting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let fetches = 0;
  const judge = createJevJudge({
    key: "synthetic",
    gateway: {
      recordExternalUsage: async () => {
        await accounting;
        return "synthetic-usage";
      },
    },
    fetch: (async () => {
      fetches++;
      return Response.json({
        model: "jev-fixture",
        answers: {
          delegate: { choice: "qa-id", confidence: 0.9, probabilities: { "qa-id": 0.9, "dev-id": 0.08, none: 0.02 } },
        },
        usage: { input_tokens: 1, output_tokens: 0 },
      });
    }) as unknown as typeof fetch,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      chooseDelegate(judge, ids, "bounded advisory task", candidates, "independent_reviewer"),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 6400);
      }),
    ]);
    expect(result).not.toBeNull();
    expect(result).toMatchObject({ status: "unavailable", reason: "decision_deadline", decisionCalls: 1 });
    release();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(result?.status).toBe("unavailable");
    expect(fetches).toBe(1);
  } finally {
    clearTimeout(timer);
    release();
  }
}, 10_000);

test("late Judge rejection after the local deadline stays observed without retry or promotion", async () => {
  let reject: (reason: Error) => void = () => {};
  const pending = new Promise<never>((_resolve, fail) => {
    reject = fail;
  });
  let calls = 0;
  const result = await chooseDelegate(
    {
      name: "offline",
      ask: () => {
        calls++;
        return pending;
      },
    },
    ids,
    "bounded task",
    candidates,
    "implementer",
  );
  const before = JSON.stringify(result);
  reject(Error("late synthetic rejection"));
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(result).toMatchObject({ status: "unavailable", reason: "decision_deadline", decisionCalls: 1 });
  expect(JSON.stringify(result)).toBe(before);
  expect(calls).toBe(1);
}, 10_000);
