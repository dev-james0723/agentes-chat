import { afterEach, expect, spyOn, test } from "bun:test";
import { HOST_ANTIGRAVITY_PROVIDER, MACHINE_PROTOCOL_VERSION, type ServerFrame } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  answerQuestion,
  type Brain,
  type BrainEvent,
  type BrainTurn,
  continuedTranscript,
  createAgent,
  createJobHandlers,
  createToolGateway,
  decideApproval,
  drainOutbox,
  enqueue,
  postPersonMessage,
  type ToolSource,
  type Transcript,
} from "../src";
import { computerPrompt } from "../src/brains/prompt";
import { type Fixture, setup } from "./fixtures";
import { missionRunner, pairedMachine } from "./mission-helpers";

// Synthetic CLI events through the real executor/database/pause path; no provider inference.
let f: Fixture;
afterEach(async () => {
  await f?.machineHub?.stop();
  await f?.close();
});
const MODEL = "gemini-4-argon-high";
const diagnostic = (turn: BrainTurn, acpSessionId: string, over = {}): BrainEvent => ({
  type: "tool_call",
  id: `${turn.runId}:model-selection`,
  name: "host_acp_model_selection",
  input: {},
  executed: {
    content: JSON.stringify({
      source: "cli_response",
      runId: turn.runId,
      nativeSessionId: turn.session!.id,
      acpSessionId,
      requestedModel: MODEL,
      selectedModel: "gemini-4-argon",
      thoughtLevel: "high",
      selectionMode: "config_pair_readback",
      ...over,
    }),
  },
});

async function configured(
  events: (turn: BrainTurn, io: Parameters<Brain["run"]>[1], token: string) => AsyncIterable<BrainEvent>,
  toolSources: ToolSource[] = [],
  onlyToolSources = false,
) {
  f = await setup({ machines: true, askUser: true, toolSources });
  const paired = await pairedMachine(f);
  const runner = missionRunner(f.machineHub!);
  await runner.hello(paired.token);
  let calls = 0;
  const call = async (token: string, tool: string, args: Record<string, unknown>) => {
    const callId = `native-history-${++calls}`;
    await runner.frame({ type: "mcp.call", callId, taskId: "run", token, tool, args });
    for (let i = 0; i < 400; i++) {
      const result = runner.sent.find(
        (s): s is Extract<ServerFrame, { type: "mcp.result" }> => s.type === "mcp.result" && s.callId === callId,
      );
      if (result) return result;
      await Bun.sleep(5);
    }
    throw new Error("No native bridge answer");
  };
  const accountId = crypto.randomUUID();
  const status = {
    id: paired.machineId,
    orgId: f.org.id,
    name: "Synthetic host",
    online: true,
    execAllowed: true,
    os: "darwin",
    protocol: MACHINE_PROTOCOL_VERSION,
    executors: { antigravity: { version: "synthetic", hostAuth: true as const }, detectedAt: new Date().toISOString() },
  };
  await f.db
    .update(schema.machines)
    .set({ os: status.os, protocol: status.protocol, executors: status.executors })
    .where(eq(schema.machines.id, paired.machineId));
  await f.db.insert(schema.machineAccounts).values({
    id: accountId,
    orgId: f.org.id,
    machineId: paired.machineId,
    kind: "antigravity",
    label: "Synthetic host",
    provider: HOST_ANTIGRAVITY_PROVIDER,
    createdBy: f.owner.id,
    status: "active",
  });
  await f.db
    .update(schema.agents)
    .set({
      brain: "antigravity",
      brainModel: MODEL,
      brainFallback: false,
      machineId: paired.machineId,
      brainAccountId: accountId,
    })
    .where(eq(schema.agents.id, f.agent.id));
  const handlers = createJobHandlers({
    ...f.jobDeps,
    ...(onlyToolSources ? { tools: createToolGateway({ sources: toolSources }) } : {}),
    machines: { status: async () => status },
    brains: {
      antigravity: (_agent, _run, bridge) =>
        ({ kind: "antigravity", run: (turn, io) => events(turn, io, bridge.mcpToken()) }) as Brain,
    },
  });
  const start = async () => {
    const message = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev preserve ORIGINAL_TASK_SENTINEL",
    });
    await drainOutbox(f.db, handlers);
    return (await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, message.id)))[0]!;
  };
  const steps = () => f.db.select().from(schema.agentRunSteps).orderBy(schema.agentRunSteps.seq);
  return { handlers, start, steps, accountId, machineId: paired.machineId, call };
}

test("full native provenance survives pause/resume in one run and never becomes application work", async () => {
  const seen: BrainTurn[] = [];
  const sessions = [`first-${"a".repeat(160)}`, `second-${"b".repeat(160)}`];
  const receipt = `COMPLETED_RECEIPT_${crypto.randomUUID()}`;
  let effects = 0;
  const source: ToolSource = {
    name: "synthetic-history",
    tools: async () => [
      {
        name: "create_issue",
        description: "Synthetic completed action",
        scope: "",
        inputSchema: { type: "object", properties: {} },
        execute: async () => {
          effects++;
          return { content: receipt };
        },
      },
    ],
  };
  const env = await configured(
    async function* (turn, _io, token) {
      seen.push(turn);
      yield diagnostic(turn, sessions[seen.length - 1]!);
      if (seen.length === 1) {
        expect(await env.call(token, "create_issue", {})).toMatchObject({
          ok: true,
          runState: "completed",
          text: receipt,
        });
        const result = await env.call(token, "ask_user", {
          question: "Harmless marker?",
          why: "Synthetic continuation check for preserving the original task and answer.",
        });
        expect(result).toMatchObject({ ok: true, runState: "suspended" });
        yield { type: "done", text: "" };
      } else yield { type: "done", text: "Continuation checked." };
    },
    [source],
  );
  const paused = await env.start();
  expect(paused.status).toBe("waiting_input");
  const [q] = await f.db.select().from(schema.agentQuestions).where(eq(schema.agentQuestions.runId, paused.id));
  const nonce = `answer-only-${crypto.randomUUID()}`;
  await answerQuestion({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, q!.id, { text: nonce });
  await drainOutbox(f.db, env.handlers);
  const [done] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, paused.id));
  expect(done?.status).toBe("done");
  expect(seen).toHaveLength(2);
  expect(seen[1]!.runId).toBe(paused.id);
  const resumed = computerPrompt({ ...seen[1]!, session: { ...seen[1]!.session!, resume: false } });
  expect(resumed).toContain("ORIGINAL_TASK_SENTINEL");
  expect(resumed).toContain(`The person answered: ${nonce}`);
  expect(seen[1]!.hostAcpHistory).toMatchObject({
    runId: paused.id,
    observations: [
      { name: "create_issue", content: receipt, state: "completed", partial: true },
      { name: "ask_user", content: expect.stringContaining(nonce), state: "completed" },
    ],
  });
  expect(effects).toBe(1);
  const steps = await env.steps();
  const evidence = steps
    .filter((s) => s.kind === "context" && s.data.hostAcpModelSelection)
    .map((s) => s.data.hostAcpModelSelection);
  expect(evidence).toHaveLength(2);
  for (let i = 0; i < evidence.length; i++)
    expect(evidence[i]).toMatchObject({
      source: "cli_response",
      runId: paused.id,
      nativeSessionId: seen[i]!.session!.id,
      acpSessionId: sessions[i],
      requestedModel: MODEL,
      selectedModel: "gemini-4-argon",
      thoughtLevel: "high",
      selectionMode: "config_pair_readback",
      accountId: env.accountId,
      machineId: env.machineId,
      turn: i + 1,
    });
  expect(steps.filter((s) => s.kind === "model_call").every((s) => !s.data.executed)).toBe(true);
  expect(JSON.stringify(done?.transcript)).not.toContain("host_acp_model_selection");
  expect(await f.db.select().from(schema.agentQuestions)).toHaveLength(1);
});

test("diagnostic-only provider failure persists proof but no completed work/recovery label", async () => {
  const env = await configured(async function* (turn) {
    yield diagnostic(turn, `failure-${"c".repeat(160)}`);
    yield { type: "error", code: "antigravity_failed", message: "Synthetic provider failure", retryable: false };
  });
  const run = await env.start();
  const steps = await env.steps();
  expect(steps.filter((s) => s.kind === "context" && s.data.hostAcpModelSelection)).toHaveLength(1);
  expect(JSON.stringify(run.transcript)).not.toContain("host_acp_model_selection");
  expect(JSON.stringify(steps.filter((s) => s.kind !== "context"))).not.toContain("host_acp_model_selection");
  const replies = await f.db.select().from(schema.messages).where(eq(schema.messages.authorAgentId, f.agent.id));
  expect(replies.map((m) => m.body).join("\n")).not.toContain("host_acp_model_selection");
});

test("native history never carries another run's completed action receipt", async () => {
  const seen: BrainTurn[] = [];
  const receipt = `OTHER_RUN_RECEIPT_${crypto.randomUUID()}`;
  const source: ToolSource = {
    name: "scope-history",
    tools: async () => [
      {
        name: "create_issue",
        description: "Synthetic action",
        scope: "",
        inputSchema: { type: "object", properties: {} },
        execute: async () => ({ content: receipt }),
      },
    ],
  };
  const env = await configured(
    async function* (turn, _io, token) {
      seen.push(turn);
      if (seen.length === 1)
        expect(await env.call(token, "create_issue", {})).toMatchObject({ ok: true, text: receipt });
      yield { type: "done", text: "Synthetic phase finished." };
    },
    [source],
  );
  const first = await env.start();
  const second = await env.start();
  expect(first.id).not.toBe(second.id);
  expect(seen).toHaveLength(2);
  expect(seen[1]!.hostAcpHistory).toEqual({ runId: second.id, observations: [] });
  expect(JSON.stringify(await env.steps())).toContain(receipt);
});

test("side effect then transport cutoff is durably fenced before a fresh turn can dispatch B or replay A", async () => {
  let effects = 0,
    brainCalls = 0;
  const source: ToolSource = {
    name: "cutoff-effect",
    tools: async () => [
      {
        name: "run_code",
        description: "Synthetic command side effect",
        scope: "",
        inputSchema: { type: "object", properties: {} },
        execute: async () => {
          effects++;
          return { content: "completed action receipt", data: { exitCode: 0 } };
        },
      },
    ],
  };
  const env = await configured(
    async function* (turn, io, _token) {
      brainCalls++;
      expect(await io.executeTool({ id: "effect-before-cutoff", name: "run_code", input: {} })).toMatchObject({
        content: "completed action receipt",
      });
      // The native action completed, but the runner lost delivery of that result.
      yield {
        type: "error",
        code: "antigravity_delivery_unknown",
        message:
          "Tool stopped (bridge.cut_off; effect unknown; receipt native-history-1). Inspect the native receipt; do not replay.",
        retryable: false,
      };
    },
    [source],
    true,
  );
  const first = await env.start();
  const transcript = first.transcript as unknown as Transcript;
  expect(transcript.hostAcpUncertain).toMatchObject({ runId: first.id });
  expect((await env.steps()).some((s) => s.kind === "context" && s.data.hostAcpToolStop)).toBe(true);
  // Synthetic requeue of the same native run tests persistence rather than in-memory loop state.
  await f.db.update(schema.agentRuns).set({ status: "queued" }).where(eq(schema.agentRuns.id, first.id));
  await enqueue(f.db, {
    orgId: f.org.id,
    kind: "agent_run.execute",
    payload: { runId: first.id },
    dedupeKey: `fence-same-run-${first.id}`,
  });
  await drainOutbox(f.db, env.handlers);
  // The supported continuation reconstruction also keeps the stop, even for a new native run.
  const carried = continuedTranscript(transcript, "Continue with B then A only after reconciliation");
  expect(carried.hostAcpUncertain).toEqual(transcript.hostAcpUncertain);
  expect(brainCalls).toBe(1);
  expect(effects).toBe(1);
});

test("bad native run, session, requested model, selected pair, mode or source is never persisted as proof", async () => {
  const bad = [
    { runId: "another-run" },
    { nativeSessionId: "another-session" },
    { requestedModel: "other-model" },
    { selectedModel: "other-model" },
    { thoughtLevel: "medium" },
    { selectionMode: "ack_only" },
    { source: "model_assertion" },
    { selectionMode: "config_readback" },
    { acpSessionId: "" },
  ];
  // One database, a distinct native run per invalid diagnostic.
  let index = 0;
  let calls = 0,
    accepted = 0;
  const env = await configured(async function* (turn) {
    calls++;
    yield diagnostic(turn, "invalid-acp-session", bad[index]);
    accepted++;
    yield { type: "done", text: "Must not accept invalid evidence." };
  });
  for (index = 0; index < bad.length; index++) {
    await env.start();
  }
  expect((await env.steps()).filter((s) => s.kind === "context" && s.data.hostAcpModelSelection)).toHaveLength(0);
  expect(calls).toBe(bad.length);
  expect(accepted).toBe(0);
});

test("exact alias config/session readbacks remain valid native evidence", async () => {
  const modes = ["config_readback", "session_readback"];
  let index = 0;
  const env = await configured(async function* (turn) {
    yield diagnostic(turn, `exact-session-${index}`, {
      selectedModel: MODEL,
      thoughtLevel: undefined,
      selectionMode: modes[index],
    });
    yield { type: "done", text: "Exact selection checked." };
  });
  for (index = 0; index < modes.length; index++) await env.start();
  const evidence = (await env.steps()).filter((s) => s.kind === "context" && s.data.hostAcpModelSelection);
  expect(evidence).toHaveLength(2);
  for (const step of evidence)
    expect(step.data.hostAcpModelSelection).toMatchObject({ requestedModel: MODEL, selectedModel: MODEL });
});

test("a context-step storage failure stops without retry or application-work credit", async () => {
  let calls = 0,
    continued = 0;
  const env = await configured(async function* (turn) {
    calls++;
    yield diagnostic(turn, "storage-failure-session");
    continued++;
    yield { type: "done", text: "Must not continue after lost evidence." };
  });
  const insert = f.db.insert.bind(f.db);
  const fail = spyOn(f.db, "insert").mockImplementation(((table: Parameters<typeof insert>[0]) => {
    const builder = insert(table);
    if (table !== schema.agentRunSteps) return builder;
    return new Proxy(builder, {
      get(target, key) {
        if (key !== "values") return Reflect.get(target, key);
        return (row: { kind?: string; data?: { hostAcpModelSelection?: unknown } }) => {
          if (row.kind === "context" && row.data?.hostAcpModelSelection)
            throw new Error("Synthetic context storage failure");
          return Reflect.apply(Reflect.get(target, key), target, [row]);
        };
      },
    });
  }) as typeof f.db.insert);
  try {
    const run = await env.start();
    expect(calls).toBe(1);
    expect(continued).toBe(0);
    const steps = await env.steps();
    expect(steps.some((s) => s.kind === "context" && s.data.hostAcpModelSelection)).toBe(false);
    expect(JSON.stringify(steps)).not.toContain('"executed":1');
    expect(JSON.stringify(run.transcript)).not.toContain("host_acp_model_selection");
  } finally {
    fail.mockRestore();
  }
});

// Approval decisions are durable native receipts even when the gateway never executed the call.
async function approvalFixture(onResume: (turn: BrainTurn, token: string) => Promise<void>) {
  let phases = 0,
    effects = 0;
  let resumeFailure: unknown;
  const source: ToolSource = {
    name: "approval-history",
    tools: async () => [
      {
        name: "create_issue",
        description: "Synthetic sensitive action",
        scope: "",
        sensitive: true,
        inputSchema: { type: "object", properties: { why: { type: "string" } } },
        execute: async () => {
          effects++;
          return { content: "APPROVED_EFFECT_RECEIPT" };
        },
      },
      {
        name: "list_issues",
        description: "Safe read after a decision",
        scope: "",
        inputSchema: { type: "object", properties: {} },
        execute: async () => ({ content: "SAFE_READ_RECEIPT" }),
      },
    ],
  };
  const env = await configured(
    async function* (turn, _io, token) {
      phases++;
      if (phases === 1) {
        expect(
          await env.call(token, "create_issue", { why: "Synthetic approval refusal and safe continuation check." }),
        ).toMatchObject({ ok: true, runState: "suspended" });
        yield { type: "done", text: "" };
      } else {
        try {
          await onResume(turn, token);
        } catch (error) {
          resumeFailure = error;
          yield {
            type: "error",
            code: "antigravity_failed",
            message: "Synthetic resume assertion failed",
            retryable: false,
          };
          return;
        }
        yield { type: "done", text: "The decision and safe continuation were checked." };
      }
    },
    [source],
  );
  const paused = await env.start();
  expect(paused.status).toBe("waiting_approval");
  const [approval] = await f.db.select().from(schema.approvals).where(eq(schema.approvals.runId, paused.id));
  expect(approval).toBeDefined();
  const requeue = async () => {
    await f.db.update(schema.agentRuns).set({ status: "queued" }).where(eq(schema.agentRuns.id, paused.id));
    await enqueue(f.db, {
      orgId: f.org.id,
      kind: "agent_run.execute",
      payload: { runId: paused.id },
      dedupeKey: `approval-history-${crypto.randomUUID()}`,
    });
    await drainOutbox(f.db, env.handlers);
  };
  const current = async () => {
    if (resumeFailure) throw resumeFailure;
    return (await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, paused.id)))[0]!;
  };
  return { ...env, paused, approval: approval!, requeue, current, effects: () => effects, phases: () => phases };
}

test("explicit native refusal preserves actor, reason and unexecuted receipt; fresh turn can perform a safe read", async () => {
  const reason = `REFUSAL_REASON_${crypto.randomUUID()}`;
  const env = await approvalFixture(async (turn, token) => {
    expect(turn.runId).toBe(env.paused.id);
    expect(computerPrompt({ ...turn, session: { ...turn.session!, resume: false } })).toContain(
      "ORIGINAL_TASK_SENTINEL",
    );
    const observation = turn.hostAcpHistory!.observations[0]!;
    expect(observation).toMatchObject({ name: "create_issue", state: "completed", isError: true });
    expect(observation.content).toContain("refused this action");
    expect(observation.content).toContain("Do not retry it");
    expect(observation.content).toContain(reason);
    expect(observation.content).toContain(env.approval.id);
    expect(observation.content).toContain(f.owner.id);
    expect(observation.content).toContain("not executed");
    expect(await env.call(token, "list_issues", {})).toMatchObject({ ok: true, text: "SAFE_READ_RECEIPT" });
  });
  await decideApproval({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, env.approval.id, {
    decision: "refuse",
    reason,
  });
  await drainOutbox(f.db, env.handlers);
  const done = await env.current();
  expect(done.status).toBe("done");
  expect((done.transcript as unknown as Transcript).hostAcpUncertain).toBeUndefined();
  expect(env.effects()).toBe(0);
  expect(env.phases()).toBe(2);
  const [approval] = await f.db.select().from(schema.approvals).where(eq(schema.approvals.id, env.approval.id));
  expect(approval).toMatchObject({ status: "refused", executedAt: null, decidedByUserId: f.owner.id });
  // No fabricated execution row: the authoritative decision itself is the completion evidence.
  expect((await env.steps()).filter((s) => s.kind === "tool_result" && s.data.name === "create_issue")).toHaveLength(0);
});

for (const status of ["expired", "canceled"] as const) {
  test(`native ${status} approval without execution is a known decision, not an uncertainty fence`, async () => {
    const env = await approvalFixture(async (turn, token) => {
      expect(turn.hostAcpHistory!.observations[0]).toMatchObject({
        name: "create_issue",
        state: "completed",
        isError: true,
      });
      expect(turn.hostAcpHistory!.observations[0]!.content).toContain(status);
      expect(turn.hostAcpHistory!.observations[0]!.content).toContain(env.approval.id);
      expect(turn.hostAcpHistory!.observations[0]!.content).toContain("not executed");
      expect(await env.call(token, "list_issues", {})).toMatchObject({ ok: true, text: "SAFE_READ_RECEIPT" });
    });
    if (status === "expired") {
      // Real decision API expires the card and enqueues its resume transactionally.
      await expect(
        decideApproval(
          { db: f.db, pubsub: f.pubsub, now: () => new Date(env.approval.expiresAt.getTime() + 1) },
          f.owner.id,
          f.org.id,
          env.approval.id,
          { decision: "approve" },
        ),
      ).rejects.toThrow("expired");
      await drainOutbox(f.db, env.handlers);
    } else {
      // A canceled run normally stays canceled; this synthetic requeue exercises its durable receipt only.
      await f.db.update(schema.approvals).set({ status }).where(eq(schema.approvals.id, env.approval.id));
      await env.requeue();
    }
    expect((await env.current()).status).toBe("done");
    expect(((await env.current()).transcript as unknown as Transcript).hostAcpUncertain).toBeUndefined();
    expect(env.effects()).toBe(0);
    expect(env.phases()).toBe(2);
  });
}

test("approved native action retains its real result and executes exactly once", async () => {
  const env = await approvalFixture(async (turn) => {
    expect(turn.hostAcpHistory!.observations[0]).toMatchObject({
      name: "create_issue",
      state: "completed",
      isError: false,
      content: "APPROVED_EFFECT_RECEIPT",
    });
  });
  await decideApproval({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, env.approval.id, { decision: "approve" });
  await drainOutbox(f.db, env.handlers);
  expect((await env.current()).status).toBe("done");
  expect(env.effects()).toBe(1);
  expect(env.phases()).toBe(2);
});

for (const scenario of [
  "pending",
  "missing",
  "foreign-run",
  "foreign-agent",
  "execution-claimed",
  "uncertain-result",
] as const) {
  test(`approval reconstruction keeps ${scenario} fenced instead of inventing nonexecution`, async () => {
    const env = await approvalFixture(async (turn) => {
      expect(turn.hostAcpHistory!.observations[0]).toMatchObject({
        name: "create_issue",
        state: "unknown",
      });
    });
    if (scenario === "missing") {
      await f.db.delete(schema.approvals).where(eq(schema.approvals.id, env.approval.id));
    } else if (scenario !== "pending") {
      const foreign =
        scenario === "foreign-agent"
          ? await createAgent(
              f.db,
              f.owner.id,
              f.org.id,
              {
                name: "Other",
                handle: "other",
                role: "Synthetic scope fixture",
                instructions: "",
                credentialId: f.credential.id,
              },
              { model: "claude-sonnet-5-5" },
            )
          : undefined;
      await f.db
        .update(schema.approvals)
        .set({
          status: "refused",
          ...(scenario === "foreign-run" ? { runId: null } : {}),
          ...(foreign ? { agentId: foreign.id } : {}),
          ...(scenario === "execution-claimed" ? { executedAt: new Date() } : {}),
        })
        .where(eq(schema.approvals.id, env.approval.id));
      if (scenario === "uncertain-result") {
        const steps = await env.steps();
        const call = steps.find((s) => s.kind === "tool_call" && s.data.name === "create_issue")!;
        // A real completion/cutoff receipt takes priority over a terminal decision row.
        await f.db.insert(schema.agentRunSteps).values({
          orgId: f.org.id,
          runId: env.paused.id,
          seq: Math.max(...steps.map((s) => s.seq)) + 1,
          kind: "tool_result",
          data: {
            toolUseId: call.data.toolUseId,
            name: "create_issue",
            content: "Delivery cut off after dispatch; inspect the receipt",
            isError: true,
            data: { code: "bridge.cut_off" },
          },
        });
      }
    }
    await env.requeue();
    if (scenario === "execution-claimed") {
      // A claimed side effect with no successful result is held by native preflight.
      // Do not restart a model turn or falsely classify this action as unexecuted.
      expect(env.phases()).toBe(1);
      expect((await env.current()).status).toBe("queued");
      const [held] = await f.db.select().from(schema.approvals).where(eq(schema.approvals.id, env.approval.id));
      expect(held?.executedAt).toBeInstanceOf(Date);
      expect(held?.result).toBeNull();
    } else {
      expect(env.phases()).toBe(2);
    }
    expect(env.effects()).toBe(0);
  });
}
