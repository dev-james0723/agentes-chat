import { afterEach, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION, noPlatformCredentials } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import { type ModelProvider, parseOpenRouterModels, setOpenRouterModels } from "@agenteschat/providers";
import fixture from "../../providers/test/fixtures/openrouter-models.json";
import {
  type Brain,
  clearPlanLimits,
  createCredential,
  createJobHandlers,
  createModelGateway,
  createQuotaCliQualifier,
  createRoutine,
  drainOutbox,
  type MachineStatus,
  postPersonMessage,
  runRoutineNow,
} from "../src";
import { configureOpenRouterFallback, readOpenRouterFallback } from "../src/openrouter-fallback-ledger";
import { type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

let f: Fixture;
afterEach(async () => {
  clearPlanLimits();
  setOpenRouterModels({}, 0);
  await f?.close();
});
async function execute(
  o: {
    routine?: boolean;
    healthy?: boolean;
    stale?: boolean;
    geminiUnknown?: boolean;
    failedReceipt?: boolean;
    recover?: boolean;
  } = {},
) {
  let recovered = false;
  let effects = 0;
  let recoverSubscription: (() => Promise<void>) | undefined;
  f = await setup({
    toolSources: o.recover
      ? [
          {
            name: "openrouter-recovery-fixture",
            tools: async () => [
              {
                name: "record_once",
                description: "Record a completed fixture work item",
                scope: "",
                inputSchema: { type: "object", properties: {}, additionalProperties: false },
                execute: async () => {
                  effects++;
                  await recoverSubscription?.();
                  return { content: "WORK_RECEIPT_ONE" };
                },
              },
            ],
          },
        ]
      : undefined,
  });
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
      brain: "claude_code",
      brainModel: "sonnet",
      brainExtraUsage: false,
      brainFallback: true,
      role: o.routine ? "Analyst" : "Software developer",
    })
    .where(eq(schema.agents.id, f.agent.id));
  const at = new Date(Date.now() - (o.stale ? 3_600_000 : 0)).toISOString();
  const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
  await f.db
    .update(schema.machines)
    .set({
      executors: {
        claude: { version: "2.1.300", loggedIn: true, authMethod: "claude.ai", plan: "max" },
        codex: { version: "0.163.0" },
        detectedAt: new Date().toISOString(),
        ...(o.geminiUnknown ? { antigravity: { version: "0.1", hostAuth: true } } : {}),
        ownUsage: {
          claude_code: { source: "probe", at, windows: [{ kind: "seven_day", usedPercent: 100, resetsAt }] },
          codex: { source: "probe", at, windows: [{ kind: "seven_day", usedPercent: o.healthy ? 10 : 100, resetsAt }] },
        },
      },
    })
    .where(eq(schema.machines.id, machineId));
  recoverSubscription = async () => {
    const [row] = await f.db.select().from(schema.machines).where(eq(schema.machines.id, machineId));
    if (!row) throw new Error("fixture machine unavailable");
    await f.db
      .update(schema.machines)
      .set({
        executors: {
          ...row.executors,
          ownUsage: {
            ...row.executors.ownUsage,
            claude_code: {
              source: "probe",
              at: new Date().toISOString(),
              windows: [{ kind: "seven_day", usedPercent: 10, resetsAt }],
            },
          },
        },
      })
      .where(eq(schema.machines.id, machineId));
    recovered = true;
  };
  const key = await createCredential(
    f.db,
    f.keyWrapper,
    f.owner.id,
    f.org.id,
    { provider: "openrouter", label: "fixture fallback", apiKey: `sk-or-v1-${"b".repeat(64)}` },
    { fetch: (async () => Response.json({ data: { is_management_key: false } })) as unknown as typeof fetch },
  );
  await configureOpenRouterFallback(f.db, f.org.id, f.owner.id, {
    enabled: true,
    credentialId: key.id,
    policy: {
      allowedModels: ["openai/gpt-6-luna"],
      monthlyCapUsd: 50,
      costTier: "medium",
      maxPromptUsdPerMillion: 4,
      maxCompletionUsdPerMillion: 20,
    },
  });
  setOpenRouterModels(parseOpenRouterModels(fixture));
  const routed: string[] = [];
  let native = 0;
  const provider: ModelProvider = {
    id: "openrouter",
    async stream(request) {
      routed.push(request.model);
      if (o.failedReceipt) throw new Error("synthetic ambiguous receipt");
      if (o.recover && routed.length === 1)
        return {
          text: "",
          content: [{ type: "tool_use", id: "fixture-record", name: "record_once", input: {} }],
          model: "openai/gpt-6-luna",
          stopReason: "tool_use",
          usage: { inputTokens: 50, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
          costNanoUsd: 100_000,
          usageVerified: true,
        };
      return {
        text: "Verified fixture answer.",
        content: [{ type: "text", text: "Verified fixture answer." }],
        model: "openai/gpt-6-luna",
        stopReason: "end_turn",
        usage: { inputTokens: 50, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costNanoUsd: 100_000,
        usageVerified: true,
      };
    },
  };
  const gateway = createModelGateway({
    db: f.db,
    keyWrappers: [f.keyWrapper],
    platformCredentials: noPlatformCredentials,
    providers: { openrouter: provider },
    openRouterFallbackEnabled: true,
    openRouterKeyFetch: (async () =>
      Response.json({
        data: {
          is_management_key: false,
          include_byok_in_limit: true,
          limit_reset: "monthly",
          limit: 50,
          limit_remaining: 50,
          expires_at: null,
        },
      })) as unknown as typeof fetch,
  });
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
        executors: row?.executors ?? {},
      };
    },
  };
  const qualifier = createQuotaCliQualifier({
    db: f.db,
    machines,
    models: { codex: "gpt-6.1-sol", claude_code: "sonnet", grok: "grok-4.7" },
  });
  const sourceSessions: string[] = [];
  const source: Brain = {
    kind: "claude_code",
    async *run(turn) {
      if (turn.session?.id) sourceSessions.push(turn.session.id);
      if (recovered) {
        yield { type: "done", text: "Recovered subscription completed." };
        return;
      }
      yield { type: "error", code: "plan_limit", message: "synthetic account limit", retryable: true, worked: false };
    },
  };
  const target: Brain = {
    kind: "codex",
    async *run() {
      native++;
      yield { type: "done", text: "Native subscription answer." };
    },
  };
  const handlers = createJobHandlers({
    ...f.jobDeps,
    gateway,
    machines,
    brains: { claude_code: () => source, codex: () => target },
    quotaCliContinuation: { qualify: (input) => (o.healthy ? qualifier.qualify(input) : Promise.resolve(null)) },
    openRouterFallbackEnabled: true,
  });
  if (o.routine) {
    const rd = { db: f.db, pubsub: f.pubsub, context: f.context };
    const routine = await createRoutine(rd, f.owner.id, f.org.id, {
      name: "Synthetic report",
      agentId: f.agent.id,
      prompt: "Synthetic bounded report.",
      target: { type: "channel", channelId: f.general.id },
      trigger: { type: "schedule", phrase: "todo dia às 8h" },
    });
    await runRoutineNow(rd, f.owner.id, f.org.id, routine.id);
  } else
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev continue the work",
    });
  await drainOutbox(f.db, handlers);
  const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.agentId, f.agent.id));
  const attempts = await f.db.select().from(schema.openRouterFallbackAttempts);
  return {
    run,
    attempts,
    routed,
    native,
    handlers,
    effects,
    sourceSessions,
    status: await readOpenRouterFallback(f.db, f.org.id),
  };
}
test("native exhausted engineering run switches to auto-code and settles actual usage", async () => {
  const x = await execute();
  expect({ status: x.run?.status, route: x.run?.transcript?.openRouterFallback, calls: x.routed }).toMatchObject({
    status: "done",
    route: { router: "openrouter/auto-code" },
    calls: ["openrouter/auto-code"],
  });
  expect(x.attempts[0]?.state).toBe("settled");
  expect(x.status.spentNanoUsd).toBe(100_000);
}, 60_000);
test("background routine uses the same pool and general auto router", async () => {
  const x = await execute({ routine: true });
  expect({ status: x.run?.status, route: x.run?.transcript?.openRouterFallback, calls: x.routed }).toMatchObject({
    status: "done",
    route: { router: "openrouter/auto" },
    calls: ["openrouter/auto"],
  });
  expect(x.run?.background).toBe(true);
  expect(x.attempts[0]?.state).toBe("settled");
}, 60_000);
test("healthy subscription wins without a paid dispatch", async () => {
  const x = await execute({ healthy: true });
  expect(x.native).toBe(1);
  expect(x.routed).toEqual([]);
}, 60_000);
for (const o of [{ stale: true }, { geminiUnknown: true }])
  test(`unverified subscription inventory blocks spend: ${JSON.stringify(o)}`, async () => {
    const x = await execute(o);
    expect(x.routed).toEqual([]);
    expect(x.attempts).toEqual([]);
  }, 60_000);
test("ambiguous paid dispatch is held without retry", async () => {
  const x = await execute({ failedReceipt: true });
  expect(x.routed).toEqual(["openrouter/auto-code"]);
  expect(x.run?.status).toBe("waiting_input");
  expect(x.run?.transcript?.openRouterHold).toBe("reconciliation_required");
  expect(x.attempts[0]?.state).toBe("unknown");
}, 60_000);

test("the source subscription recovers after one completed tool; no second API turn is dispatched", async () => {
  const x = await execute({ recover: true });
  expect(x.routed).toEqual(["openrouter/auto-code"]);
  expect(x.effects).toBe(1);
  expect(x.run?.status).toBe("done");
  expect(x.run?.brain).toBe("claude_code");
  expect(x.run?.transcript?.openRouterFallback).toMatchObject({ ended: "subscription_recovered" });
  expect(x.attempts).toHaveLength(1);
}, 60_000);
