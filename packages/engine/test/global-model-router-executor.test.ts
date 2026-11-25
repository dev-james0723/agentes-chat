import { afterEach, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION, noPlatformCredentials } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  buildDirectCloudOffers,
  type ModelOffer,
  type ModelProvider,
  ProviderError,
  parseCloudflareCatalogOffers,
  parseGroqCatalogOffers,
  parseOpenCodeCatalogOffers,
  parseOpenRouterCatalogOffers,
} from "@agenteschat/providers";
import fixture from "../../providers/test/fixtures/openrouter-models.json";
import {
  type Brain,
  clearPlanLimits,
  configureGlobalRouterPolicy,
  createCredential,
  createJobHandlers,
  createModelGateway,
  createQuotaCliQualifier,
  createRoutine,
  drainOutbox,
  type MachineStatus,
  postPersonMessage,
  readGlobalModelRouterStatus,
  reconcileGlobalRouterAttempt,
  runRoutineNow,
  syncGlobalRouterOffers,
  upsertGlobalRouterAccount,
} from "../src";
import { type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

let f: Fixture;
afterEach(async () => {
  clearPlanLimits();
  await f?.close();
});

const synthKey = (parts: string[]) => parts.join("-");

function makeOffers(nowIso: string): ModelOffer[] {
  const expiresAt = new Date(Date.parse(nowIso) + 3_600_000).toISOString();
  const goOffers = parseOpenCodeCatalogOffers(
    {
      data: [
        {
          id: "deepseek-v4.1-flash",
          name: "DeepSeek V4.1 Flash",
          type: "chat",
          canonical_id: "deepseek/deepseek-v4.1-flash",
          api: { "chat-completions": { base_url: "https://opencode.ai/inference/go/openai/v1" } },
          limit: { context: 128000, output: 32768 },
          capabilities: { tools: { supported: true }, structured_output: true, reasoning: { supported: true } },
          cost: { text: { input: { price: 0.3 }, output: { price: 1.2 } } },
          go: { zdr: true, training: false },
          modalities: { input: ["text/plain"] },
        },
      ],
    },
    "go",
    nowIso,
  );
  const groqOffers = parseGroqCatalogOffers(
    { data: [{ id: "openai/gpt-oss-120b", active: true, context_window: 131072, max_completion_tokens: 32768 }] },
    "free_only",
    nowIso,
  );
  const cfOffers = parseCloudflareCatalogOffers(
    {
      result: [
        {
          name: "@cf/openai/gpt-oss-120b",
          task: { name: "Text Generation" },
          properties: [{ property_id: "function_calling", value: "true" }],
        },
      ],
    },
    "0123456789abcdef0123456789abcdef",
    "free_only",
    nowIso,
  );
  const orOffers = parseOpenRouterCatalogOffers(fixture, nowIso);
  const paidLowCostOffer: ModelOffer = {
    offerId: "openrouter:deepseek/deepseek-v4.1-flash-1017",
    provider: "openrouter",
    lane: "paid_low_cost",
    modelId: "deepseek/deepseek-v4.1-flash-1017",
    canonicalId: "deepseek/deepseek-v4.1-flash-1017",
    label: "DeepSeek V4.1 Flash 1017",
    endpointUrl: "https://openrouter.ai/api/v1",
    apiStyle: "openai_chat",
    contextWindow: 163840,
    maxOutputTokens: 32768,
    inputModalities: ["text"],
    capabilities: { tools: true, structuredOutput: true, streaming: true, reasoning: true, cache: true },
    prices: { input: 30, output: 200, cacheRead: 15, cacheWrite: 30 },
    requestFeeNanoUsd: 0,
    freeEligible: false,
    billingPrerequisites: ["dedicated_monthly_cap"],
    quotaUnits: "nano_usd",
    privacy: { zdr: true, training: false, dataCollection: "deny", region: "global" },
    observedAt: nowIso,
    expiresAt,
    qualificationStatus: "eligible",
    quarantineReason: null,
  };
  return [...goOffers, ...groqOffers, ...cfOffers, ...orOffers, paidLowCostOffer, ...buildDirectCloudOffers(nowIso)];
}

async function runScenario(
  opts: {
    routine?: boolean;
    usedPercent?: number;
    staleTelemetry?: boolean;
    optOutAgent?: boolean;
    go429?: boolean;
    groqBadJsonThenEscalate?: boolean;
    ambiguousDrop?: boolean;
    recoverAfterTool?: boolean;
  } = {},
) {
  let recovered = false;
  let toolSideEffects = 0;
  let recoverSub: (() => Promise<void>) | undefined;

  f = await setup({
    toolSources: opts.recoverAfterTool
      ? [
          {
            name: "gmr-recovery-fixture",
            tools: async () => [
              {
                name: "commit_step",
                description: "Commit a single step receipt",
                scope: "",
                inputSchema: { type: "object", properties: {}, additionalProperties: false },
                execute: async () => {
                  toolSideEffects++;
                  await recoverSub?.();
                  return { content: "STEP_COMMITTED_ONCE" };
                },
              },
            ],
          },
        ]
      : undefined,
  });

  const paired = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, {
    name: "Router Mac",
    hostname: "router-mac",
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
      role: opts.routine ? "Operations analyst" : "Software developer",
    })
    .where(eq(schema.agents.id, f.agent.id));

  const nowIso = new Date().toISOString();
  const telemetryAt = new Date(Date.now() - (opts.staleTelemetry ? 3_600_000 : 0)).toISOString();
  const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
  const pct = opts.usedPercent ?? 100;

  await f.db
    .update(schema.machines)
    .set({
      executors: {
        claude: { version: "2.1.300", loggedIn: true, authMethod: "claude.ai", plan: "max" },
        codex: { version: "0.163.0" },
        detectedAt: nowIso,
        ownUsage: {
          claude_code: {
            source: "probe",
            at: telemetryAt,
            windows: [{ kind: "seven_day", usedPercent: pct, resetsAt }],
          },
          codex: { source: "probe", at: telemetryAt, windows: [{ kind: "seven_day", usedPercent: pct, resetsAt }] },
        },
      },
    })
    .where(eq(schema.machines.id, machineId));

  recoverSub = async () => {
    const [row] = await f.db.select().from(schema.machines).where(eq(schema.machines.id, machineId));
    if (!row) return;
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
              windows: [{ kind: "seven_day", usedPercent: 12, resetsAt }],
            },
          },
        },
      })
      .where(eq(schema.machines.id, machineId));
    recovered = true;
  };

  const okFetch = (async () => Response.json({ data: { is_management_key: false } })) as unknown as typeof fetch;
  const goCred = await createCredential(
    f.db,
    f.keyWrapper,
    f.owner.id,
    f.org.id,
    { provider: "opencode", label: "OpenCode Go Key", apiKey: `oc_sk_${"a".repeat(32)}` },
    { fetch: okFetch },
  );
  const groqCred = await createCredential(
    f.db,
    f.keyWrapper,
    f.owner.id,
    f.org.id,
    { provider: "groq", label: "Groq Free Key", apiKey: ["gsk", "b".repeat(40)].join("_") },
    { fetch: okFetch },
  );
  const orCred = await createCredential(
    f.db,
    f.keyWrapper,
    f.owner.id,
    f.org.id,
    { provider: "openrouter", label: "OpenRouter Cap Key", apiKey: synthKey(["sk", "or", "v1", "d".repeat(64)]) },
    { fetch: okFetch },
  );

  await configureGlobalRouterPolicy(f.db, f.org.id, f.owner.id, {
    enabled: true,
    optOutAgentIds: opts.optOutAgent ? [f.agent.id] : [],
    maxEscalations: 2,
    maxRetriesPerRoute: opts.go429 ? 0 : 1,
  });

  await upsertGlobalRouterAccount(f.db, f.org.id, f.owner.id, {
    provider: "opencode",
    lane: "opencode_go",
    entitlement: "subscription_go",
    credentialId: goCred.id,
    enabled: true,
    monthlyCapUsd: 0,
    allowedModels: ["deepseek-v4.1-flash"],
  });
  await upsertGlobalRouterAccount(f.db, f.org.id, f.owner.id, {
    provider: "groq",
    lane: "free_api",
    entitlement: "free_only",
    credentialId: groqCred.id,
    enabled: true,
    monthlyCapUsd: 0,
    allowedModels: ["openai/gpt-oss-120b"],
  });
  await upsertGlobalRouterAccount(f.db, f.org.id, f.owner.id, {
    provider: "openrouter",
    lane: "paid_low_cost",
    entitlement: "paid_capped",
    credentialId: orCred.id,
    enabled: true,
    monthlyCapUsd: 50,
    allowedModels: ["deepseek/deepseek-v4.1-flash-1017"],
  });

  await syncGlobalRouterOffers(f.db, f.org.id, f.owner.id, makeOffers(nowIso));

  const callOrder: string[] = [];
  let nativeSubRuns = 0;
  const resumeFlags: boolean[] = [];

  const opencodeProvider: ModelProvider = {
    id: "opencode",
    async stream(req) {
      callOrder.push(`opencode:${req.model}`);
      if (opts.ambiguousDrop) {
        throw new Error("mid-stream socket reset after dispatch");
      }
      if (opts.go429) {
        throw new ProviderError("rate limited by provider", true, 429);
      }
      if (opts.recoverAfterTool && callOrder.length === 1) {
        return {
          text: "",
          content: [{ type: "tool_use", id: "call-1", name: "commit_step", input: {} }],
          model: req.model,
          stopReason: "tool_use",
          usage: { inputTokens: 60, outputTokens: 12, cacheReadTokens: 0, cacheWriteTokens: 0 },
          usageVerified: true,
        };
      }
      return {
        text: "OpenCode Go verified answer.",
        content: [{ type: "text", text: "OpenCode Go verified answer." }],
        model: req.model,
        stopReason: "end_turn",
        usage: { inputTokens: 60, outputTokens: 15, cacheReadTokens: 0, cacheWriteTokens: 0 },
        usageVerified: true,
      };
    },
  };

  const groqProvider: ModelProvider = {
    id: "groq",
    async stream(req) {
      callOrder.push(`groq:${req.model}`);
      if (opts.groqBadJsonThenEscalate) {
        // Empty truncated output triggers Quality Guardian escalation to paid_low_cost
        return {
          text: "",
          content: [],
          model: req.model,
          stopReason: "max_tokens",
          usage: { inputTokens: 50, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          usageVerified: true,
        };
      }
      return {
        text: "Groq free verified answer.",
        content: [{ type: "text", text: "Groq free verified answer." }],
        model: req.model,
        stopReason: "end_turn",
        usage: { inputTokens: 50, outputTokens: 14, cacheReadTokens: 0, cacheWriteTokens: 0 },
        usageVerified: true,
      };
    },
  };

  const openRouterProvider: ModelProvider = {
    id: "openrouter",
    async stream(req) {
      callOrder.push(`openrouter:${req.model}`);
      return {
        text: "Low-cost OpenRouter concrete verified answer.",
        content: [{ type: "text", text: "Low-cost OpenRouter concrete verified answer." }],
        model: "deepseek/deepseek-v4.1-flash-1017",
        stopReason: "end_turn",
        usage: { inputTokens: 100, outputTokens: 25, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costNanoUsd: 8_000,
        usageVerified: true,
      };
    },
  };

  const gateway = createModelGateway({
    db: f.db,
    keyWrappers: [f.keyWrapper],
    platformCredentials: noPlatformCredentials,
    providers: {
      opencode: opencodeProvider,
      groq: groqProvider,
      openrouter: openRouterProvider,
    },
    globalModelRouterEnabled: true,
    openRouterFallbackEnabled: true,
  });

  const machines = {
    status: async (): Promise<MachineStatus> => {
      const [row] = await f.db.select().from(schema.machines).where(eq(schema.machines.id, machineId));
      return {
        id: machineId,
        orgId: f.org.id,
        name: "Router Mac",
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

  const claudeBrain: Brain = {
    kind: "claude_code",
    async *run(turn) {
      resumeFlags.push(Boolean(turn.session?.resume));
      if (pct < 100 || recovered) {
        nativeSubRuns++;
        yield { type: "done", text: "Primary subscription completed." };
        return;
      }
      yield {
        type: "error",
        code: "plan_limit",
        message: "subscription window reached 100%",
        retryable: true,
        worked: false,
      };
    },
  };

  const codexBrain: Brain = {
    kind: "codex",
    async *run() {
      if (pct < 100) {
        nativeSubRuns++;
        yield { type: "done", text: "Codex subscription completed." };
        return;
      }
      yield { type: "error", code: "plan_limit", message: "codex window reached 100%", retryable: true, worked: false };
    },
  };

  const handlers = createJobHandlers({
    ...f.jobDeps,
    gateway,
    machines,
    brains: { claude_code: () => claudeBrain, codex: () => codexBrain },
    quotaCliContinuation: {
      qualify: (input) => (pct < 100 ? qualifier.qualify(input) : Promise.resolve(null)),
    },
    globalModelRouterEnabled: true,
    openRouterFallbackEnabled: true,
  });

  if (opts.routine) {
    const rd = { db: f.db, pubsub: f.pubsub, context: f.context };
    const routine = await createRoutine(rd, f.owner.id, f.org.id, {
      name: "Daily Router Digest",
      agentId: f.agent.id,
      prompt: "Summarize operational status.",
      target: { type: "channel", channelId: f.general.id },
      trigger: { type: "schedule", phrase: "todo dia às 8h" },
    });
    await runRoutineNow(rd, f.owner.id, f.org.id, routine.id);
  } else {
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev verify router cascade",
    });
  }

  await drainOutbox(f.db, handlers);
  const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.agentId, f.agent.id));
  const status = await readGlobalModelRouterStatus(f.db, f.org.id);

  return {
    run,
    status,
    callOrder,
    nativeSubRuns,
    toolSideEffects,
    resumeFlags,
    orgId: f.org.id,
    ownerId: f.owner.id,
    db: f.db,
  };
}

test("exhausted native agent hands off to OpenCode Go ($0 extra spend) and records verified receipt", async () => {
  const res = await runScenario();
  expect(res.run?.status).toBe("done");
  expect(res.callOrder).toEqual(["opencode:deepseek-v4.1-flash"]);
  expect(res.status.recentReceipts[0]).toMatchObject({
    lane: "opencode_go",
    provider: "opencode",
    requestedModel: "deepseek-v4.1-flash",
    actualNanoUsd: 0,
    state: "settled",
    qualityVerified: true,
  });
}, 60_000);

test("cascade escalates from 429 OpenCode Go -> Free Groq -> Quality Guardian failure -> Paid Low-Cost OpenRouter", async () => {
  const res = await runScenario({ go429: true, groqBadJsonThenEscalate: true });
  expect(res.run?.status).toBe("done");
  expect(res.callOrder).toEqual([
    "opencode:deepseek-v4.1-flash",
    "groq:openai/gpt-oss-120b",
    "openrouter:deepseek/deepseek-v4.1-flash-1017",
  ]);
  const settled = res.status.recentReceipts.find((r) => r.provider === "openrouter");
  expect(settled).toMatchObject({
    lane: "paid_low_cost",
    actualModel: "deepseek/deepseek-v4.1-flash-1017",
    actualNanoUsd: 8_000,
    qualityVerified: true,
    state: "settled",
  });
}, 60_000);

test("background routine inherits Global Model Router per run without mutating permanent agent brain", async () => {
  const res = await runScenario({ routine: true });
  expect(res.run?.status).toBe("done");
  expect(res.run?.background).toBe(true);
  expect(res.callOrder).toEqual(["opencode:deepseek-v4.1-flash"]);
  const [agentAfter] = await res.db.select().from(schema.agents).where(eq(schema.agents.id, f.agent.id));
  expect(agentAfter?.brain).toBe("claude_code");
}, 60_000);

test("95% subscription usage warning does NOT trigger exhaustion or fallback dispatch", async () => {
  const res = await runScenario({ usedPercent: 95 });
  expect(res.nativeSubRuns).toBeGreaterThanOrEqual(1);
  expect(res.callOrder).toEqual([]);
  expect(res.status.recentReceipts).toEqual([]);
}, 60_000);

test("stale subscription telemetry and opted-out agents fail closed with zero fallback calls", async () => {
  const staleRes = await runScenario({ staleTelemetry: true });
  expect(staleRes.callOrder).toEqual([]);
  await f.close();

  const optOutRes = await runScenario({ optOutAgent: true });
  expect(optOutRes.callOrder).toEqual([]);
}, 60_000);

test("subscription recovery resumes cleanly on a fresh session (resume: false) without replaying tool side effects", async () => {
  const res = await runScenario({ recoverAfterTool: true });
  expect(res.run?.status).toBe("done");
  expect(res.toolSideEffects).toBe(1);
  expect(res.callOrder).toEqual(["opencode:deepseek-v4.1-flash"]);
  expect(res.run?.brain).toBe("claude_code");
  // When returning to claude_code after fallback, resume must be false so stale local CLI transcript is never reused.
  expect(res.resumeFlags.at(-1)).toBe(false);
}, 60_000);

test("ambiguous mid-stream drop holds liability without retry until owner reconciles", async () => {
  const res = await runScenario({ ambiguousDrop: true });
  expect(res.callOrder).toEqual(["opencode:deepseek-v4.1-flash"]);
  expect(res.run?.status).toBe("waiting_input");
  const heldAttempt = res.status.recentReceipts[0];
  expect(heldAttempt?.state).toBe("unknown");

  await reconcileGlobalRouterAttempt(res.db, res.orgId, res.ownerId, heldAttempt!.id, {
    kind: "proven_no_send",
    note: "Verified upstream logs recorded zero completion",
  });
  const after = await readGlobalModelRouterStatus(res.db, res.orgId);
  expect(after.recentReceipts[0]?.state).toBe("released");
  expect(after.accounts.find((a) => a.provider === "opencode")?.uiState).toBe("eligible");
}, 60_000);
