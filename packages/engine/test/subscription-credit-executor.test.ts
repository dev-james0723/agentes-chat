import { afterEach, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION, noPlatformCredentials } from "@agenteschat/adapters";
import { eq, schema, sql } from "@agenteschat/db";
import { annotateProviderFailure, type ModelProvider, ProviderError } from "@agenteschat/providers";
import { createFakeProvider } from "@agenteschat/providers/testing";
import {
  type Brain,
  type BrainEvent,
  type BrainTurn,
  clearPlanLimits,
  createCredential,
  createIssue,
  createJobHandlers,
  createModelGateway,
  createQuotaCliQualifier,
  drainOutbox,
  type MachineStatus,
  postPersonMessage,
  type ToolSource,
} from "../src";
import {
  createCreditRouteQualifier,
  registerCreditPool,
  registerCreditRoute,
  setCreditRouteEnabled,
} from "../src/credit-ledger";
import { creditPricingProfile } from "../src/credit-pricing";
import type { JudgeRequest } from "../src/judge";
import { enqueue } from "../src/outbox";
import { type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

let f: Fixture;
afterEach(async () => {
  clearPlanLimits();
  await f?.close();
  f = undefined as unknown as Fixture;
});
const USD = 1e9;
const MODELS = { anthropic: "claude-sonnet-5-5", openai: "gpt-6.1-sol" } as const;
const LIMIT: BrainEvent = {
  type: "error",
  code: "plan_limit",
  message: "synthetic account limit",
  retryable: true,
  worked: false,
};
type Kind = "claude_code" | "codex";
type Provider = "anthropic" | "openai";
type Options = {
  provider?: Provider;
  sourceKind?: Kind;
  healthyAlternate?: boolean;
  limited?: boolean;
  creditOff?: boolean;
  routeOff?: boolean;
  readingAgeMs?: number;
  windows?: { kind: string; usedPercent: number }[];
  sourceScript?: (turn: number) => BrainEvent[];
  beforeSource?: (turn: BrainTurn) => Promise<void>;
  reply?: Parameters<typeof createFakeProvider>[0];
  toolSources?: ToolSource[];
  beforeJudge?: (request: JudgeRequest) => Promise<void>;
};

async function fixture(o: Options = {}) {
  f = await setup({ toolSources: o.toolSources });
  const sourceKind = o.sourceKind ?? "claude_code";
  const alternate: Kind = sourceKind === "claude_code" ? "codex" : "claude_code";
  const providerId = o.provider ?? "anthropic";
  const model = MODELS[providerId];
  const trace: string[] = [],
    qualifyingRuns: string[] = [];
  const paired = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, {
    name: "Fixture Mac",
    hostname: "fixture",
    os: "darwin",
    arch: "arm64",
    version: "0.8.0",
    protocol: MACHINE_PROTOCOL_VERSION,
    workspace: "/synthetic/agentes",
    exec: true,
  });
  const machineId = paired.machineId;
  await f.db
    .update(schema.agents)
    .set({
      machineId,
      brain: sourceKind,
      brainModel: sourceKind === "claude_code" ? "sonnet" : MODELS.openai,
      brainExtraUsage: false,
      brainFallback: false,
    })
    .where(eq(schema.agents.id, f.agent.id));
  const writeUsage = async (windows: { kind: string; usedPercent: number }[], ageMs = o.readingAgeMs ?? 0) => {
    const at = new Date(Date.now() - ageMs).toISOString();
    const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
    await f.db
      .update(schema.machines)
      .set({
        executors: {
          claude: { version: "2.1.300", loggedIn: true, authMethod: "claude.ai", plan: "ultra" },
          codex: { version: "0.163.0" },
          detectedAt: new Date().toISOString(),
          ownUsage: {
            [sourceKind]: { source: "probe", at, windows: windows.map((w) => ({ ...w, resetsAt })) },
            [alternate]: {
              source: "probe",
              at: new Date().toISOString(),
              windows: [{ kind: "seven_day", usedPercent: o.healthyAlternate ? 10 : 100, resetsAt }],
            },
          },
        } as never,
      })
      .where(eq(schema.machines.id, machineId));
  };
  await writeUsage(o.windows ?? [{ kind: "seven_day", usedPercent: o.limited === false ? 10 : 100 }]);
  const key = await createCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, {
    provider: providerId,
    label: "synthetic grant",
    apiKey: "synthetic-grant-key",
    ...(providerId === "openai" ? { organization: "fixture-upstream-org" } : {}),
  });
  const now = Date.now();
  const poolId = await registerCreditPool(f.db, f.org.id, {
    provider: providerId,
    upstreamAccount: "fixture-upstream-org",
    product: providerId === "openai" ? "openai_pro_api" : "claude_ultra_api",
    cycleKey: "fixture-cycle",
    grantId: "fixture-grant",
    grantStart: new Date(now - 86_400_000),
    grantEnd: new Date(now + 30 * 86_400_000),
    eligibleSince: new Date(now - 30 * 86_400_000),
    activatedAt: new Date(now - 86_400_000),
    enforcement: "prepaid_grant_only",
    externalSpendCoverage: "exclusive",
    externalSpendBoundNanoUsd: 0,
    evidenceRef: "fixture-provider-billing",
    verifiedByUserId: f.owner.id,
    verifiedAt: new Date(now - 1000),
    validUntil: new Date(now + 3_600_000),
    grantAmountNanoUsd: 200 * USD,
    observedRemainingNanoUsd: 200 * USD,
  });
  const routeId = await registerCreditRoute(f.db, f.org.id, {
    poolId,
    credentialId: key.id,
    model,
    supportsTools: true,
    maxPromptBytes: 400_000,
    routeKind: providerId === "openai" ? "openai_responses" : "anthropic_messages",
    accountEvidenceRef: "fixture-key-account-binding",
    capabilities: ["text", "client_tools"],
    pricingEvidence: {
      evidenceRef: "fixture-standard-price-sheet",
      verifiedAt: new Date(now - 1000),
      validUntil: new Date(now + 3_600_000),
      profileHash: creditPricingProfile(model).profileHash,
    },
  });
  if (!o.routeOff) await setCreditRouteEnabled(f.db, f.org.id, routeId, true);
  const fake = createFakeProvider(
    o.reply ?? (() => ({ chunks: ["Verified fixture answer."], usage: { inputTokens: 100, outputTokens: 10 } })),
  );
  const provider: ModelProvider = {
    ...fake,
    id: providerId,
    async stream(request, options) {
      trace.push(`api:${providerId}`);
      const result = await fake.stream(request, options);
      return { ...result, usageVerified: true, providerRequestId: `req_fixture_${fake.calls.length}` };
    },
  };
  const gateway = createModelGateway({
    db: f.db,
    keyWrappers: [f.keyWrapper],
    platformCredentials: noPlatformCredentials,
    providers: { [providerId]: provider },
    creditRoutes: !o.creditOff,
  });
  const sourceTurns: BrainTurn[] = [],
    alternateTurns: BrainTurn[] = [];
  const source: Brain = {
    kind: sourceKind,
    async *run(turn) {
      sourceTurns.push(turn);
      await o.beforeSource?.(turn);
      yield* o.sourceScript?.(sourceTurns.length) ?? [LIMIT];
    },
  };
  const target: Brain = {
    kind: alternate,
    async *run(turn) {
      alternateTurns.push(turn);
      yield { type: "done", text: "The healthy subscription completed this answer." };
    },
  };
  const machines = {
    status: async (): Promise<MachineStatus> => {
      const [row] = await f.db.select().from(schema.machines).where(eq(schema.machines.id, machineId));
      return {
        id: machineId,
        orgId: f.org.id,
        name: "Fixture Mac",
        online: true,
        execAllowed: true,
        pairedByUserId: f.owner.id,
        os: "darwin",
        protocol: MACHINE_PROTOCOL_VERSION,
        executors: row?.executors,
      } as MachineStatus;
    },
  };
  const qualifier = createQuotaCliQualifier({
    db: f.db,
    machines,
    models: { codex: MODELS.openai, claude_code: "sonnet", grok: "grok-4.7" },
  });
  const credits = createCreditRouteQualifier(f.db);
  const judge = f.context.judge;
  if (!judge) throw new Error("missing fixture judge");
  const deps = {
    ...f.jobDeps,
    context: {
      ...f.context,
      judge: {
        name: judge.name,
        async ask(request: JudgeRequest) {
          await o.beforeJudge?.(request);
          return judge.ask(request);
        },
      },
    },
    gateway,
    machines,
    brains: {
      [sourceKind]: () => source,
      [alternate]: () => target,
      grok: () =>
        ({
          kind: "grok",
          run() {
            throw new Error("unqualified subscription dispatched");
          },
        }) as Brain,
    },
    quotaCliContinuation: {
      async qualify(input: Parameters<typeof qualifier.qualify>[0]) {
        trace.push(`subscription:${input.targetKind}`);
        return o.healthyAlternate && input.targetKind === alternate ? qualifier.qualify(input) : null;
      },
    },
    ...(o.creditOff
      ? {}
      : {
          creditRoute: {
            async qualify(input: Parameters<typeof credits.qualify>[0] & { runId?: string }) {
              trace.push(`credit:${input.provider ?? "any"}`);
              if (input.runId) qualifyingRuns.push(input.runId);
              return credits.qualify(input);
            },
          },
        }),
  };
  return {
    handlers: createJobHandlers(deps),
    restart: () => createJobHandlers(deps),
    fake,
    sourceTurns,
    alternateTurns,
    trace,
    qualifyingRuns,
    poolId,
    routeId,
    model,
    machineId,
    key,
    writeUsage,
  };
}
const post = () =>
  postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev continue the same work",
  });
const runs = () => f.db.select().from(schema.agentRuns);
const attempts = () => f.db.select().from(schema.creditAttempts);
async function onlyRun() {
  const rows = await runs();
  expect(rows).toHaveLength(1);
  const run = rows[0];
  if (!run) throw new Error("missing fixture run");
  return run;
}
async function cycle() {
  const rows = await f.db.select().from(schema.creditGrantCycles);
  const row = rows[0];
  if (!row) throw new Error("missing fixture cycle");
  return row;
}
async function restartWake(handlers: ReturnType<typeof createJobHandlers>, runId: string, n: number) {
  await enqueue(f.db, {
    orgId: f.org.id,
    kind: "agent_run.execute",
    payload: { runId },
    dedupeKey: `fixture-restart-${n}`,
  });
  await drainOutbox(f.db, handlers);
}

test("a working subscription never qualifies or dispatches an API grant", async () => {
  const x = await fixture({ limited: false, sourceScript: () => [{ type: "done", text: "Subscription answer." }] });
  await post();
  await drainOutbox(f.db, x.handlers);
  expect((await onlyRun()).status).toBe("done");
  expect(x.trace.filter((v) => v.startsWith("credit:"))).toHaveLength(0);
  expect(x.fake.calls).toHaveLength(0);
  expect(await attempts()).toHaveLength(0);
}, 60_000);

test("all compatible subscription candidates are evaluated before any credit route, and a healthy one wins", async () => {
  const x = await fixture({ healthyAlternate: true });
  await post();
  await drainOutbox(f.db, x.handlers);
  const run = await onlyRun();
  expect({ status: run.status, brain: run.brain }).toEqual({ status: "done", brain: "codex" });
  expect(x.trace).toContain("subscription:codex");
  expect(x.trace).toContain("subscription:grok");
  expect(x.trace.some((v) => v.startsWith("credit:"))).toBe(false);
  expect(x.fake.calls).toHaveLength(0);
  expect(x.alternateTurns).toHaveLength(1);
  expect(x.alternateTurns[0]?.session?.resume).toBe(false);
  expect(run.brainSessionId).toBeString();
  expect((run.transcript?.quotaCliHandoff as { targetSessionId?: string })?.targetSessionId).toBe(
    run.brainSessionId ?? "",
  );
}, 60_000);

for (const provider of ["anthropic", "openai"] as const)
  test(`${provider} grants run only after subscription candidates are exhausted`, async () => {
    const x = await fixture({ provider, sourceKind: provider === "openai" ? "codex" : "claude_code" });
    await post();
    await drainOutbox(f.db, x.handlers);
    const run = await onlyRun();
    expect({ status: run.status, brain: run.brain }).toEqual({ status: "done", brain: "model" });
    const firstCredit = x.trace.findIndex((s) => s.startsWith("credit:"));
    expect(firstCredit).toBeGreaterThan(0);
    expect(x.trace.slice(0, firstCredit).filter((s) => s.startsWith("subscription:"))).toHaveLength(2);
    expect(x.fake.calls).toHaveLength(1);
    expect(x.fake.calls[0]?.request).toMatchObject({ model: x.model, noTransportRetries: true });
    expect(x.fake.countCalls).toHaveLength(0);
    expect(run.transcript?.creditRoute).toMatchObject({ provider, model: x.model, routeId: x.routeId });
    const sourceSession = (run.transcript?.creditRoute as { sourceSessionId?: string } | undefined)?.sourceSessionId;
    expect(sourceSession).toBeString();
    expect(run.brainSessionId).not.toBe(sourceSession ?? "");
    expect(JSON.stringify(x.fake.calls[0]?.request)).not.toContain(sourceSession ?? "missing-native-session");
    expect(new Set(x.qualifyingRuns)).toEqual(new Set([run.id]));
    expect((await attempts()).map((a) => a.state)).toEqual(["settled"]);
    expect((await cycle()).heldAutomaticNanoUsd).toBe(0);
    expect((await cycle()).spentAutomaticNanoUsd).toBeGreaterThan(0);
    expect((await cycle()).spentEmergencyNanoUsd).toBe(0);
  }, 60_000);

test("two API turns preserve the run and existing task, charge actual usage, and execute a side effect once", async () => {
  let effects = 0;
  const checkpointPhases: (string | undefined)[] = [];
  const source: ToolSource = {
    name: "continuity-fixture",
    tools: async () => [
      {
        name: "record_once",
        description: "Record one completed fixture work item",
        scope: "",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => {
          const [active] = await f.db.select().from(schema.agentRuns);
          checkpointPhases.push((active?.transcript?.creditInFlight as { phase?: string } | undefined)?.phase);
          effects++;
          return { content: "WORK_RECEIPT_ONE" };
        },
      },
    ],
  };
  const x = await fixture({
    toolSources: [source],
    reply: (_request, n) =>
      n === 1
        ? {
            chunks: [],
            opaque: [{ type: "thinking", thinking: "brief fixture reasoning", signature: "fixture-signature" }],
            toolUses: [{ id: "call-fixture-one", name: "record_once", input: {} }],
            usage: { inputTokens: 100, outputTokens: 10 },
          }
        : {
            chunks: ["WORK_RECEIPT_ONE verified; this answer is complete."],
            usage: { inputTokens: 120, outputTokens: 20 },
          },
  });
  const task = await createIssue({ db: f.db, pubsub: f.pubsub }, { type: "person", userId: f.owner.id }, f.org.id, {
    title: "Preserve existing task identity",
    criteria: ["Owner acceptance remains necessary"],
  });
  const agentBefore = (await f.db.select().from(schema.agents)).map((a) => ({
    id: a.id,
    brain: a.brain,
    ownerUserId: a.ownerUserId,
  }));
  const taskBefore = await f.db.select().from(schema.issues).where(eq(schema.issues.id, task.id));
  await post();
  await drainOutbox(f.db, x.handlers);
  const run = await onlyRun();
  expect({ status: run.status, brain: run.brain, error: run.error }).toEqual({
    status: "done",
    brain: "model",
    error: null,
  });
  expect(x.fake.calls).toHaveLength(2);
  expect(effects).toBe(1);
  expect(checkpointPhases).toEqual(["response"]);
  expect(JSON.stringify(x.fake.calls[1]?.request.messages)).toContain("WORK_RECEIPT_ONE");
  expect(new Set(x.qualifyingRuns)).toEqual(new Set([run.id]));
  const receipts = await attempts();
  expect(receipts).toHaveLength(2);
  expect(
    receipts.every((a) => a.state === "settled" && a.actualNanoUsd !== null && a.actualNanoUsd <= a.amountNanoUsd),
  ).toBe(true);
  expect(new Set(receipts.map((a) => a.workUnitKey)).size).toBe(2);
  expect((await cycle()).spentAutomaticNanoUsd).toBe(receipts.reduce((sum, a) => sum + (a.actualNanoUsd ?? 0), 0));
  expect((await cycle()).heldAutomaticNanoUsd).toBe(0);
  const steps = await f.db.select().from(schema.agentRunSteps).where(eq(schema.agentRunSteps.runId, run.id));
  expect(steps.filter((s) => s.kind === "tool_call" && s.data.name === "record_once")).toHaveLength(1);
  expect(
    steps.filter(
      (s) => s.kind === "tool_result" && (s.data.toolUseId === "call-fixture-one" || s.data.id === "call-fixture-one"),
    ),
  ).toHaveLength(1);
  expect(await f.db.select().from(schema.issues).where(eq(schema.issues.id, task.id))).toEqual(taskBefore);
  expect(
    (await f.db.select().from(schema.agents)).map((a) => ({ id: a.id, brain: a.brain, ownerUserId: a.ownerUserId })),
  ).toEqual(agentBefore);
  await restartWake(x.restart(), run.id, 1);
  expect(effects).toBe(1);
  expect(x.fake.calls).toHaveLength(2);
}, 60_000);

test("unknown API outcomes park the same run durably and restarting never re-dispatches", async () => {
  const x = await fixture({ reply: () => new ProviderError("synthetic lost connection", true) });
  await post();
  await drainOutbox(f.db, x.handlers);
  const run = await onlyRun();
  expect({ status: run.status, brain: run.brain }).toEqual({ status: "waiting_input", brain: "model" });
  expect(run.transcript?.creditHold).toMatchObject({
    schema: "credit-reconciliation/1",
    nextSafeAction: "reconcile_usage_and_action_receipts",
  });
  expect(run.transcript?.creditInFlight).toMatchObject({ schema: "credit-turn/1" });
  const held = (await cycle()).heldAutomaticNanoUsd;
  expect(held).toBeGreaterThan(0);
  expect((await attempts()).map((a) => a.state)).toEqual(["unknown"]);
  for (let n = 1; n <= 3; n++) await restartWake(x.restart(), run.id, n);
  expect(x.fake.calls).toHaveLength(1);
  expect((await onlyRun()).status).toBe("waiting_input");
  expect((await cycle()).heldAutomaticNanoUsd).toBe(held);
  expect((await f.db.select().from(schema.notifications)).filter((n) => n.kind === "credit_continuity")).toHaveLength(
    1,
  );
}, 60_000);

test("confirmed non-billable refusal returns to a fresh source session without replaying API work", async () => {
  const x = await fixture({
    limited: false,
    beforeSource: async () => {
      await x.writeUsage([{ kind: "seven_day", usedPercent: 100 }]);
    },
    reply: () =>
      annotateProviderFailure(new ProviderError("grant exhausted", false, 429), {
        status: 429,
        code: "insufficient_quota",
      }),
  });
  await post();
  await drainOutbox(f.db, x.handlers);
  const run = await onlyRun();
  expect(x.fake.calls).toHaveLength(1);
  expect(run.status).not.toBe("done");
  expect(run.status).not.toBe("failed");
  expect(run.brain).toBe("claude_code");
  const credit = run.transcript?.creditRoute as { ended?: string; sourceSessionId?: string };
  expect(credit.ended).toBe("exhausted");
  expect(run.brainSessionId).not.toBe(credit.sourceSessionId);
  expect((await attempts()).map((a) => a.state)).toEqual(["released"]);
  expect((await cycle()).heldAutomaticNanoUsd).toBe(0);
}, 60_000);

for (const fault of ["model-only", "stale", "generic429", "credit-off", "route-off"] as const)
  test(`credit fallback refuses ${fault} without any API spend`, async () => {
    const x = await fixture({
      ...(fault === "model-only" ? { windows: [{ kind: "seven_day_sonnet", usedPercent: 100 }] } : {}),
      ...(fault === "stale" ? { readingAgeMs: 600_000 } : {}),
      ...(fault === "generic429"
        ? {
            limited: false,
            sourceScript: () => [
              {
                type: "error",
                code: "rate_limit",
                message: "HTTP 429 throttle",
                retryable: true,
                worked: false,
              } as BrainEvent,
            ],
          }
        : {}),
      ...(fault === "credit-off" ? { creditOff: true } : {}),
      ...(fault === "route-off" ? { routeOff: true } : {}),
    });
    await post();
    await drainOutbox(f.db, x.handlers);
    expect(x.fake.calls).toHaveLength(0);
    expect(await attempts()).toHaveLength(0);
    expect((await onlyRun()).status).not.toBe("done");
    expect((await cycle()).spentAutomaticNanoUsd).toBe(0);
  }, 60_000);

for (const fault of ["unmatched-tool", "effect-uncertain", "pending-approval", "pending-only", "worked-turn"] as const)
  test(`unsafe native boundary ${fault} does not hand off or duplicate effects`, async () => {
    const x = await fixture({
      limited: false,
      beforeSource: async (turn) => {
        await x.writeUsage([{ kind: "seven_day", usedPercent: 100 }]);
        if (fault === "unmatched-tool")
          await f.db.insert(schema.agentRunSteps).values({
            orgId: f.org.id,
            runId: turn.runId,
            seq: 90,
            kind: "tool_call",
            data: { toolUseId: "native-unknown", name: "Bash", input: { command: "synthetic-no-command" } },
          });
        // Native approvals commit status + pending atomically. Pending-only injects a corrupt or partial writer.
        if (fault === "pending-approval" || fault === "pending-only")
          await f.db
            .update(schema.agentRuns)
            .set({
              ...(fault === "pending-approval" ? { status: "waiting_approval" as const } : {}),
              transcript: sql`jsonb_set(${schema.agentRuns.transcript}, '{pending}', '{"calls":[{"toolUseId":"approval-pending","name":"Bash","approvalId":"fixture-approval"}]}'::jsonb)`,
            })
            .where(eq(schema.agentRuns.id, turn.runId));
        if (fault === "effect-uncertain")
          await f.db
            .update(schema.agentRuns)
            .set({
              transcript: sql`jsonb_set(${schema.agentRuns.transcript}, '{effectUncertain}', '{"toolUseId":"native-unknown"}'::jsonb)`,
            })
            .where(eq(schema.agentRuns.id, turn.runId));
      },
      sourceScript: () =>
        fault === "worked-turn"
          ? [
              {
                type: "tool_call",
                id: "native-done",
                name: "Bash",
                input: {},
                executed: { content: "synthetic effect receipt" },
              },
              { ...LIMIT, worked: true } as BrainEvent,
            ]
          : [LIMIT],
    });
    await post();
    await drainOutbox(f.db, x.handlers);
    expect(x.fake.calls).toHaveLength(0);
    expect(await attempts()).toHaveLength(0);
    const held = await onlyRun();
    expect(held.status).not.toBe("done");
    if (fault === "pending-approval") expect(held.status).toBe("waiting_approval");
    if (fault === "pending-approval" || fault === "pending-only")
      expect(held.transcript?.pending).toMatchObject({
        calls: [{ toolUseId: "approval-pending", approvalId: "fixture-approval" }],
      });
  }, 60_000);

test("a lease lost during JEV acceptance cannot publish a final answer or mark done, and restart holds its checkpoint", async () => {
  let cut = 0;
  const x = await fixture({
    reply: () => ({ chunks: ["LEASE_LOST_FINAL_REPLY"], usage: { inputTokens: 100, outputTokens: 10 } }),
    beforeJudge: async (request) => {
      if (request.kind !== "follow_through" || !request.runId || cut) return;
      cut++;
      await f.db
        .update(schema.outbox)
        .set({ lockedUntil: new Date(0) })
        .where(sql`${schema.outbox.payload}->>'runId' = ${request.runId} and ${schema.outbox.status} = 'processing'`);
    },
  });
  await post();
  await drainOutbox(f.db, x.handlers);
  const run = await onlyRun();
  expect(cut).toBe(1);
  expect(run.status).not.toBe("done");
  expect(run.replyMessageId).toBeNull();
  expect(run.transcript?.creditInFlight).toMatchObject({ phase: "response" });
  expect((await f.db.select().from(schema.messages)).some((m) => m.body.includes("LEASE_LOST_FINAL_REPLY"))).toBe(
    false,
  );
  expect(x.fake.calls).toHaveLength(1);
  await restartWake(x.restart(), run.id, 1);
  const held = await onlyRun();
  expect(held.status).toBe("waiting_input");
  expect(held.transcript?.creditHold).toMatchObject({ nextSafeAction: "reconcile_usage_and_action_receipts" });
  expect(x.fake.calls).toHaveLength(1);
}, 60_000);
