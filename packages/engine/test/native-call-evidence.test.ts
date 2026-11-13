import { afterEach, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  type Brain,
  createJobHandlers,
  drainOutbox,
  executeToolForRun,
  postPersonMessage,
  type ToolSource,
} from "../src";
import { type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

let f: Fixture;
afterEach(() => f?.close());

async function nativeRun(failed = false) {
  const tried: string[][] = [];
  let turns = 0;
  let calls = 0;
  const source: ToolSource = {
    name: "synthetic-read",
    tools: async () => [
      {
        name: "lookup_delegate",
        description: "Read a synthetic delegation recommendation",
        scope: "",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        async execute() {
          calls++;
          return failed
            ? { content: "Refused: no recommendation was made", isError: true, data: { code: "tool.credential" } }
            : { content: "Jev recommends @qa. Read-only: no assignment was made." };
        },
      },
    ],
  };
  f = await setup({
    toolSources: [source],
    judge: (kind, _id, state) => {
      if (kind !== "follow_through") return undefined;
      const evidence = state.tried as string[];
      tried.push(evidence);
      return evidence.some(
        (line) =>
          line.includes("lookup_delegate") && line.includes("Jev recommends @qa") && !line.includes("→ failed:"),
      )
        ? "done"
        : "unbacked";
    },
  });
  const paired = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, {
    name: "Test Mac",
    hostname: "test-mac",
    os: "darwin",
    arch: "arm64",
    version: "0.12.0",
    protocol: MACHINE_PROTOCOL_VERSION,
    workspace: "/test",
    exec: true,
  });
  await f.db
    .update(schema.agents)
    .set({ brain: "codex", brainFallback: false, machineId: paired.machineId })
    .where(eq(schema.agents.id, f.agent.id));
  const brain: Brain = {
    kind: "codex",
    async *run(turn) {
      turns++;
      // Native MCP calls go straight through the gateway. This runner did not emit a matching brain tool event.
      if (turns === 1)
        await executeToolForRun(
          f.jobDeps,
          { orgId: f.org.id, agentId: f.agent.id, runId: turn.runId, machineId: paired.machineId },
          { id: "native-lookup", name: "lookup_delegate", input: {} },
        );
      yield { type: "done", text: "The native Jev recommendation is @qa." };
    },
  };
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { codex: () => brain },
    machines: {
      status: async (id) => ({
        id,
        orgId: f.org.id,
        name: "Test Mac",
        online: true,
        execAllowed: true,
        os: "darwin",
        protocol: MACHINE_PROTOCOL_VERSION,
        executors: { codex: { version: "codex-cli 0.163.0" }, detectedAt: new Date().toISOString() },
      }),
    },
  });
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev give a synthetic read-only delegation recommendation; do not assign any work",
  });
  await drainOutbox(f.db, handlers);
  const [run] = await f.db.select().from(schema.agentRuns);
  const steps = await f.db
    .select()
    .from(schema.agentRunSteps)
    .where(eq(schema.agentRunSteps.runId, run?.id ?? ""));
  return { turns, calls, tried, run, steps };
}

test("native gateway evidence is visible to continuation even when the local executed-call count is zero", async () => {
  const result = await nativeRun();
  expect(result.calls).toBe(1);
  expect(result.run?.transcript).toMatchObject({ executedCalls: 0 });
  expect(
    result.steps.some((s) => s.kind === "tool_result" && s.data.name === "lookup_delegate" && !s.data.isError),
  ).toBe(true);
  expect(result.tried[0]?.join("\n")).toContain("Jev recommends @qa");
  expect(result.turns).toBe(1);
  expect(result.steps.some((s) => s.kind === "context" && s.data.nudged === "unbacked")).toBe(false);
  expect(result.run?.status).toBe("done");
});

test("a refused native result stays failed evidence and cannot back a success claim", async () => {
  const result = await nativeRun(true);
  expect(result.calls).toBe(1);
  expect(result.tried[0]?.join("\n")).toContain("→ failed:");
  expect(result.tried[0]?.join("\n")).not.toContain("Jev recommends @qa");
  expect(result.turns).toBe(3);
  expect(result.steps.filter((s) => s.kind === "context" && s.data.nudged === "unbacked")).toHaveLength(2);
});

test("a pure model claim with no tool evidence still reaches the honesty gate", async () => {
  let judged = 0;
  f = await setup({
    judge: (kind, _id, state) => {
      if (kind !== "follow_through") return undefined;
      expect(state.tried).toEqual([]);
      return judged++ === 0 ? "unbacked" : "done";
    },
    reply: (_request, call) => ({
      chunks: [call === 1 ? "I made a Jev decision." : "No tool was called; I cannot claim a decision."],
    }),
  });
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev get a verified delegation decision",
  });
  await drainOutbox(f.db, f.handlers);
  expect(f.provider.calls).toHaveLength(2);
  const steps = await f.db.select().from(schema.agentRunSteps);
  expect(steps.filter((s) => s.kind === "context" && s.data.nudged === "unbacked")).toHaveLength(1);
});
