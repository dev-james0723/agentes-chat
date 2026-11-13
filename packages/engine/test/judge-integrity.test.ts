import { expect, test } from "bun:test";
import { changesPermissions, checkPermissionText } from "../src/context/items";
import { chooseDelegate } from "../src/delegation-choice";
import { callJev } from "../src/jev-key";
import { createJevJudge, createLlmJudge, type JudgeQuestion, judgmentReceiptOf, withJudgeFallback } from "../src/judge";
import { createJevRouterStrategy, routeChain } from "../src/router-jev";

const noul: JudgeQuestion = { type: "noul", instructions: "Synthetic check", criteria: { true: "yes", false: "no" } };
const choice: JudgeQuestion = {
  type: "choice",
  instructions: "Synthetic choice",
  criteria: { allowed: "eligible", none: "abstain" },
};
const score: JudgeQuestion = { type: "score", instructions: "Synthetic score", criteria: ["low", "high"] };
const box: JudgeQuestion = { type: "box", instructions: "Synthetic box" };
const request = (question: JudgeQuestion = noul) => ({
  orgId: "o",
  kind: "integrity_test",
  state: {},
  questions: { answer: question },
});

function jev(answer: unknown, usage: unknown = { input_tokens: 10, output_tokens: 0 }) {
  const recorded: unknown[] = [];
  const judge = createJevJudge({
    key: "synthetic",
    gateway: {
      recordExternalUsage: async (u) => {
        recorded.push(u);
        return "usage-id";
      },
    },
    fetch: (async () => Response.json({ model: "jev-1.14.0", answers: answer, usage })) as unknown as typeof fetch,
  });
  return { judge, recorded };
}

for (const [label, question, answer] of [
  ["missing noul", noul, {}],
  ["wrong type", noul, { answer: { type: "choice", noul: 0 } }],
  ["string noul", noul, { answer: { noul: "0" } }],
  ["out of range", noul, { answer: { noul: -0.1 } }],
  ["unknown choice", choice, { answer: { choice: "unauthorized" } }],
  ["prototype choice", choice, { answer: { choice: "toString" } }],
  ["invalid confidence", choice, { answer: { choice: "allowed", confidence: 2 } }],
  ["foreign probability", choice, { answer: { choice: "allowed", probabilities: { unauthorized: 1 } } }],
  ["bad probability", choice, { answer: { choice: "allowed", probabilities: { allowed: -1 } } }],
  ["missing score", score, { answer: {} }],
  ["high score", score, { answer: { score: 2 } }],
  ["missing box", box, { answer: {} }],
  ["reversed box", box, { answer: { box: { top: 0.8, bottom: 0.1, left: 0, right: 1 } } }],
] as [string, JudgeQuestion, unknown][]) {
  test(`Jev rejects ${label} rather than making a negative decision`, async () => {
    const { judge } = jev(answer);
    await expect(judge.ask(request(question))).rejects.toThrow("judge: invalid answer");
  });
}

test("real zero is valid; requested alias and resolved version stay distinct", async () => {
  const { judge, recorded } = jev({ answer: { type: "noul", noul: 0 } });
  expect(await judge.ask(request())).toEqual({ answer: { noul: 0 } });
  expect(recorded).toMatchObject([{ requestedModel: "jev-latest", model: "jev-1.14.0", partial: false }]);
});

test("the existing delegation tool can persist a receipt without leaking raw judgment inputs", async () => {
  const { judge } = jev({ delegate: { choice: "qa", confidence: 0.9 } });
  const result = await chooseDelegate(judge, { orgId: "o", agentId: "a", runId: "r" }, "private synthetic summary", [
    { id: "qa", handle: "qa", name: "QA", role: "review", can: "read", presence: "busy" },
  ]);
  expect(result).toMatchObject({
    status: "recommended",
    receipt: {
      judgment: {
        kind: "agent_delegation",
        requestedModel: "jev-latest",
        resolvedModel: "jev-1.14.0",
        usageRecordId: "usage-id",
        telemetry: "measured",
      },
      candidateIds: ["qa"],
      approval: "not_evaluated",
      capacityLease: "not_reserved",
      dispatch: "not_requested",
    },
  });
  expect(JSON.stringify(result)).not.toContain("private synthetic summary");
});

test("accounting failure remains visible as unrecorded, not a zero-cost success", async () => {
  const judge = createJevJudge({
    key: "synthetic",
    gateway: {
      recordExternalUsage: async () => {
        throw new Error("storage offline");
      },
    },
    fetch: (async () =>
      Response.json({
        model: "jev-1.14.0",
        answers: { answer: { noul: 1 } },
        usage: { input_tokens: 10, output_tokens: 0 },
      })) as unknown as typeof fetch,
  });
  const answers = await judge.ask(request());
  expect(judgmentReceiptOf(answers)).toMatchObject({ telemetry: "unrecorded", usageRecordId: null, costNanoUsd: null });
  expect(Object.keys(answers)).toEqual(["answer"]);
});

test("missing usage is explicitly partial, never evidence of zero cost", async () => {
  const { judge, recorded } = jev({ answer: { noul: 1 } }, {});
  await judge.ask(request());
  expect(recorded).toMatchObject([{ partial: true }]);
});

test("an invalid resolved model is unknown and marks accounting partial", async () => {
  const recorded: unknown[] = [];
  const judge = createJevJudge({
    key: "synthetic",
    gateway: {
      recordExternalUsage: async (u) => {
        recorded.push(u);
        return "usage-id";
      },
    },
    fetch: (async () =>
      Response.json({
        model: 42,
        answers: { answer: { noul: 0 } },
        usage: { input_tokens: 1, output_tokens: 0 },
      })) as unknown as typeof fetch,
  });
  const answers = await judge.ask(request());
  expect(judgmentReceiptOf(answers)).toMatchObject({ resolvedModel: null, telemetry: "partial" });
  expect(recorded).toMatchObject([{ model: "jev-latest", requestedModel: "jev-latest", partial: true }]);
});

test("malformed calibrated response never invokes the LLM fallback", async () => {
  let calls = 0;
  const { judge } = jev({});
  const wrapped = withJudgeFallback(judge, {
    name: "llm",
    ask: async () => {
      calls++;
      return {};
    },
  });
  await expect(wrapped.ask({ ...request(), calibrated: true })).rejects.toThrow();
  expect(calls).toBe(0);
});

test("malformed noncalibrated output does not silently buy an LLM fallback", async () => {
  let calls = 0;
  const { judge } = jev({});
  const wrapped = withJudgeFallback(judge, {
    name: "llm",
    ask: async () => {
      calls++;
      return {};
    },
  });
  await expect(wrapped.ask(request())).rejects.toThrow();
  expect(calls).toBe(0);
});

test("memory permission guards do not turn malformed evidence into permission to store", async () => {
  const { judge } = jev({});
  await expect(checkPermissionText(judge, "o", "synthetic text")).rejects.toThrow("judge: invalid answer");
  await expect(changesPermissions(judge, "o", "synthetic text")).rejects.toThrow("judge: invalid answer");
});

test("non-JSON Jev output cannot silently buy a fallback", async () => {
  let calls = 0;
  const primary = createJevJudge({
    key: "synthetic",
    gateway: { recordExternalUsage: async () => null },
    fetch: (async () => new Response("not JSON")) as unknown as typeof fetch,
  });
  const judge = withJudgeFallback(primary, {
    name: "llm",
    ask: async () => {
      calls++;
      return {};
    },
  });
  await expect(judge.ask(request())).rejects.toThrow();
  expect(calls).toBe(0);
});

test("non-object LLM output cannot pass a memory permission guard", async () => {
  for (const text of ["not JSON", "null", "[]"]) {
    const judge = createLlmJudge({
      resolveModel: async () => "synthetic-model",
      gateway: { complete: async () => ({ text }) } as never,
    });
    await expect(checkPermissionText(judge, "o", "synthetic text")).rejects.toThrow();
  }
});

test("malformed router output stops the model chain and leaves deterministic policy in charge", async () => {
  let paid = 0;
  const strategy = createJevRouterStrategy({
    key: "synthetic",
    recordUsage: async () => {},
    fetch: (async () => Response.json({ answers: {} })) as unknown as typeof fetch,
  });
  const chain = routeChain([
    strategy,
    {
      name: "paid",
      decide: async () => {
        paid++;
        return { agents: [] };
      },
    },
  ]);
  await expect(
    chain.decide({
      orgId: "o",
      channel: { id: "c", name: "fixture", topic: "" },
      message: { id: "m", author: "person", body: "synthetic" },
      thread: [],
      candidates: [],
    }),
  ).rejects.toThrow();
  expect(paid).toBe(0);
});

test("LLM missing answers and prototype candidates also stay unknown", async () => {
  for (const text of ["{}", '{"answer":"toString"}']) {
    const judge = createLlmJudge({
      resolveModel: async () => "synthetic-model",
      gateway: { complete: async () => ({ text }) } as never,
    });
    await expect(judge.ask(request(choice))).rejects.toThrow("judge: invalid answer");
  }
});

test("a response that sends headers then stalls its body stays within the one call deadline", async () => {
  const started = Date.now();
  await expect(
    callJev("synthetic", {
      body: {},
      timeoutMs: 25,
      fetch: (async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              setTimeout(() => {
                controller.enqueue(new TextEncoder().encode("{}"));
                controller.close();
              }, 150);
            },
          }),
        )) as unknown as typeof fetch,
    }),
  ).rejects.toThrow();
  expect(Date.now() - started).toBeLessThan(1000);
}, 1500);
