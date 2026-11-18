import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { AUTO_MODEL } from "@agenteschat/providers";
import {
  chooseAutoModel,
  createFakeJudge,
  drainOutbox,
  type JudgeAnswer,
  postPersonMessage,
  statusQuestions,
  updateAgent,
} from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture | undefined;
afterEach(async () => {
  const current = f;
  f = undefined;
  await current?.close();
});

const input = {
  orgId: "o",
  agentId: "a",
  runId: "r",
  agent: { name: "Ada", role: "Developer", instructions: "Answer briefly." },
  message: "oi!",
  recent: [],
  routine: false,
  mission: false,
  computer: false,
  tools: true,
};
const candidates = [{ key: "c0", kind: "channel" as const, subject: "general", text: "Answering in #general" }];

describe("Automático and the run's status in one judge request", () => {
  test("one call answers the tier, the effort and the status questions; the status gets its answers", async () => {
    const judge = createFakeJudge((_kind, id) =>
      id === "tier" ? "small" : id === "effort" ? "low" : id === "status_line" ? "c0" : undefined,
    );
    let shared: Promise<Record<string, JudgeAnswer>> | null = null;
    const choice = await chooseAutoModel(judge, input, {
      questions: statusQuestions(candidates),
      answers: (a) => {
        shared = a;
      },
    });
    expect(choice).toMatchObject({ tier: "small", effort: "low", source: "judge" });
    expect(judge.calls).toHaveLength(1);
    expect(judge.calls[0]).toMatchObject({ kind: "auto_model", calibrated: true });
    expect(Object.keys(judge.calls[0]?.questions ?? {}).sort()).toEqual(
      ["effort", "status_line", "status_weight", "status_worth_c0", "tier"].sort(),
    );
    expect((await (shared as unknown as Promise<Record<string, JudgeAnswer>>)).status_line?.choice).toBe("c0");
  });

  test("the shared request fails (no calibrated judge): the tier and effort are asked again alone", async () => {
    const judge = createFakeJudge((_kind, id) => (id === "tier" ? "large" : id === "effort" ? "high" : undefined));
    const ask = judge.ask.bind(judge);
    judge.ask = async (request) => {
      if (request.calibrated) {
        judge.calls.push(request);
        throw new Error("judge: a calibrated judge is required (no Jev)");
      }
      return ask(request);
    };
    let failed = false;
    const choice = await chooseAutoModel(judge, input, {
      questions: statusQuestions(candidates),
      answers: (a) => {
        a.catch(() => {
          failed = true;
        });
      },
    });
    expect(choice).toMatchObject({ tier: "large", effort: "high", source: "judge" });
    expect(judge.calls.map((c) => [c.kind, Boolean(c.calibrated)])).toEqual([
      ["auto_model", true],
      ["auto_model", false],
    ]);
    await Promise.resolve();
    expect(failed).toBe(true);
  });
});

describe("judge calls at the start of a run", () => {
  const until = async (check: () => Promise<boolean>) => {
    for (let i = 0; i < 100; i++) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("timed out");
  };

  test("an agent on Automático: one judge call picks its model and its status (was two)", async () => {
    f = await setup({
      judge: (_kind, id) =>
        id === "tier"
          ? "medium"
          : id === "effort"
            ? "medium"
            : id === "status_line"
              ? "c0"
              : id === "status_weight"
                ? 3
                : id === "status_worth_c0"
                  ? 0.9
                  : undefined,
      reply: () => ({ chunks: ["Feito."] }),
    });
    const fx = f;
    await updateAgent(fx.db, fx.owner.id, fx.org.id, fx.agent.id, { model: AUTO_MODEL });
    await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, {
      body: "@dev revisa o relatório de vendas",
    });
    await drainOutbox(fx.db, fx.handlers);
    const agentRow = async () => (await fx.db.select().from(schema.agents).where(eq(schema.agents.id, fx.agent.id)))[0];
    await until(async () => (await agentRow())?.statusBusy === true);
    expect((await agentRow())?.statusKind).toBe("channel");

    const calls = (fx.context.judge as ReturnType<typeof createFakeJudge>).calls;
    const atStart = calls.filter((c) => c.kind === "auto_model" || c.kind === "agent_status");
    expect(atStart.map((c) => c.kind)).toEqual(["auto_model"]);
    expect(Object.keys(atStart[0]?.questions ?? {})).toContain("status_line");
    expect(fx.provider.calls[0]?.request).toMatchObject({ model: "claude-sonnet-5-5", effort: "medium" });
  });

  test("an agent with a set model still asks its status alone", async () => {
    f = await setup({
      judge: (_kind, id) => (id === "status_line" ? "c0" : id === "status_weight" ? 3 : undefined),
      reply: () => ({ chunks: ["Feito."] }),
    });
    const fx = f;
    await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, {
      body: "@dev revisa o relatório de vendas",
    });
    await drainOutbox(fx.db, fx.handlers);
    const calls = (fx.context.judge as ReturnType<typeof createFakeJudge>).calls;
    await until(async () => calls.some((c) => c.kind === "agent_status"));
    expect(calls.filter((c) => c.kind === "auto_model")).toHaveLength(0);
  });
});
