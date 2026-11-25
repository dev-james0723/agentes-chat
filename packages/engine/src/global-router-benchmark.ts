import { type Database, schema } from "@agenteschat/db";
import type { GlobalRouterLane, ModelProvider, ModelRequest, ModelResult, ToolSpec } from "@agenteschat/providers";
import { verifyGlobalRouterOutput } from "./global-router-policy";

/**
 * Stratified Benchmark Engine (PLD-10 / PLD-11):
 * - 35 representative synthetic tasks across 7 categories (5 per category):
 *   bugfix, repo_nav, multi_tool_schema, long_context, test_authoring, summary, routine_recovery
 * - Evaluates 32+ representative models across Subscription baselines, OpenCode Go,
 *   Free API pool (OpenRouter :free, Groq, Cloudflare), OpenRouter Paid/Auto, and Direct Cloud APIs
 *   (DeepSeek, Tencent Hy, MiniMax, GLM, Kimi, Xiaomi MiMo, NVIDIA).
 * - Measures verified task success, incremental USD cost per verified success, p50/p95 latency,
 *   tool/schema reliability, and retry count against baseline thresholds without blanket equivalence claims.
 */

export type BenchmarkCategory =
  | "bugfix"
  | "repo_nav"
  | "multi_tool_schema"
  | "long_context"
  | "test_authoring"
  | "summary"
  | "routine_recovery";

export interface BenchmarkTaskSpec {
  id: string;
  category: BenchmarkCategory;
  title: string;
  critical: boolean;
  system: string;
  prompt: string;
  tools?: ToolSpec[];
  outputSchema?: Record<string, unknown>;
  verify: (result: ModelResult) => { passed: boolean; reason: string };
}

export interface BenchmarkCandidateModel {
  id: string;
  provider: string;
  lane: GlobalRouterLane;
  label: string;
  incrementalInputNanoPerToken: number;
  incrementalOutputNanoPerToken: number;
}

export interface BenchmarkModelReport {
  modelId: string;
  provider: string;
  lane: GlobalRouterLane;
  label: string;
  tasksRun: number;
  verifiedSuccesses: number;
  verifiedSuccessRate: number;
  toolSchemaReliability: number;
  totalIncrementalCostNanoUsd: number;
  costPerVerifiedSuccessNanoUsd: number | null;
  costPerVerifiedSuccessUsd: number | null;
  p50LatencyMs: number;
  p95LatencyMs: number;
  totalRetries: number;
  vsBaselineSuccessDelta: number;
  promotionDecision: "promote_all" | "promote_non_critical" | "quarantine_below_threshold";
  categoryPassCounts: Record<BenchmarkCategory, { passed: number; total: number }>;
}

export interface BenchmarkSuiteResult {
  suiteVersion: string;
  executedAt: string;
  taskCount: number;
  modelCount: number;
  executionMode: "provider_harness" | "live_api";
  baselineModelId: string;
  baselineSuccessRate: number;
  models: BenchmarkModelReport[];
}

const INSPECT_TOOL: ToolSpec = {
  name: "inspect_module",
  description: "Read metadata and exports of a repository module",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" }, checkExports: { type: "boolean" } },
    required: ["path"],
    additionalProperties: false,
  },
};

const PATCH_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    rootCause: { type: "string" },
    fixedExpression: { type: "string" },
    regressionCheck: { type: "string" },
  },
  required: ["rootCause", "fixedExpression", "regressionCheck"],
  additionalProperties: false,
};

const SUMMARY_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    status: { type: "string" },
    verifiedFacts: { type: "array", items: { type: "string" } },
    blocker: { type: "string" },
  },
  required: ["status", "verifiedFacts", "blocker"],
  additionalProperties: false,
};

function buildTasks(): BenchmarkTaskSpec[] {
  const bugfixes: BenchmarkTaskSpec[] = [
    ["BF-01", "off-by-one window expiry", "now >= expiresAt", "stale_catalog"],
    ["BF-02", "integer overflow in nanoUSD reservation", "Number.isSafeInteger", "budget_exhausted"],
    ["BF-03", "nullish cacheRead fallback", "?? input", "cacheRead"],
    ["BF-04", "missing URL redirect guard", 'redirect: "error"', "SSRF"],
    ["BF-05", "duplicate tool replay on cut turn", "tool_result", "reconciliation_required"],
  ].map(([id, title, tokenA, tokenB]) => ({
    id: id!,
    category: "bugfix",
    title: `Diagnose and repair ${title}`,
    critical: true,
    system: "Return strict JSON matching the schema with rootCause, fixedExpression, and regressionCheck.",
    prompt: `Fix ${title}: ensure ${tokenA} is enforced and ${tokenB} is tested.`,
    outputSchema: PATCH_SCHEMA,
    verify: (res) => {
      const q = verifyGlobalRouterOutput(res, { provider: "openrouter", outputSchema: PATCH_SCHEMA });
      if (!q.ok) return { passed: false, reason: q.reason ?? "schema_invalid" };
      const parsed = JSON.parse(res.text) as Record<string, string>;
      const ok =
        Boolean(parsed.fixedExpression?.includes(tokenA!)) &&
        Boolean(parsed.regressionCheck?.toLowerCase().includes(tokenB!.toLowerCase()));
      return { passed: ok, reason: ok ? "verified" : "missing_expected_fix_invariant" };
    },
  }));

  const repoNavs: BenchmarkTaskSpec[] = [
    ["RN-01", "packages/engine/src/gateway.ts", "ModelGateway"],
    ["RN-02", "packages/engine/src/executor.ts", "portableMessages"],
    ["RN-03", "packages/engine/src/routines.ts", "routineRuns"],
    ["RN-04", "packages/providers/src/openrouter.ts", "parseOpenRouterModels"],
    ["RN-05", "packages/engine/src/model-inspector.ts", "readModelInspectorCredits"],
  ].map(([id, modulePath, symbolName]) => ({
    id: id!,
    category: "repo_nav",
    title: `Locate ${symbolName} ownership in ${modulePath}`,
    critical: false,
    system: "Call inspect_module for the exact module path before summarizing.",
    prompt: `Inspect ${modulePath} to verify ownership of ${symbolName}.`,
    tools: [INSPECT_TOOL],
    verify: (res) => {
      const q = verifyGlobalRouterOutput(res, { provider: "openrouter", tools: [INSPECT_TOOL] });
      if (!q.ok) return { passed: false, reason: q.reason ?? "invalid_tool" };
      const call = res.content.find((b) => b.type === "tool_use" && b.name === "inspect_module");
      const ok = call?.type === "tool_use" && call.input.path === modulePath;
      return { passed: ok, reason: ok ? "verified" : "wrong_module_inspected" };
    },
  }));

  const multiToolSchemas: BenchmarkTaskSpec[] = [1, 2, 3, 4, 5].map((n) => ({
    id: `MT-0${n}`,
    category: "multi_tool_schema",
    title: `Structured tool dispatch & schema check #${n}`,
    critical: true,
    system: "Invoke inspect_module with checkExports=true on the requested target.",
    prompt: `Verify exports on target module packages/router/part-${n}.ts with checkExports enabled.`,
    tools: [INSPECT_TOOL],
    verify: (res) => {
      const q = verifyGlobalRouterOutput(res, { provider: "openrouter", tools: [INSPECT_TOOL] });
      if (!q.ok) return { passed: false, reason: q.reason ?? "invalid_tool_schema" };
      const call = res.content.find((b) => b.type === "tool_use" && b.name === "inspect_module");
      const ok =
        call?.type === "tool_use" &&
        call.input.path === `packages/router/part-${n}.ts` &&
        call.input.checkExports === true;
      return { passed: ok, reason: ok ? "verified" : "missing_checkExports_flag" };
    },
  }));

  const longContexts: BenchmarkTaskSpec[] = [1, 2, 3, 4, 5].map((n) => {
    const needle = `CHECKPOINT_SHA_0${n}_9F8E7D`;
    const filler = Array.from({ length: 120 }, (_, i) => `Log line ${i}: nominal telemetry ok.`).join("\n");
    return {
      id: `LC-0${n}`,
      category: "long_context",
      title: `Long-context constraint extraction #${n}`,
      critical: false,
      system: "Extract exact audit evidence in strict JSON.",
      prompt: `${filler}\nCRITICAL_EVIDENCE=${needle}\n${filler}\nReturn status="verified", verifiedFacts=[CRITICAL_EVIDENCE], blocker="none".`,
      outputSchema: SUMMARY_SCHEMA,
      verify: (res) => {
        const q = verifyGlobalRouterOutput(res, { provider: "openrouter", outputSchema: SUMMARY_SCHEMA });
        if (!q.ok) return { passed: false, reason: q.reason ?? "schema_invalid" };
        const parsed = JSON.parse(res.text) as { status?: string; verifiedFacts?: string[] };
        const ok =
          parsed.status === "verified" && Array.isArray(parsed.verifiedFacts) && parsed.verifiedFacts.includes(needle);
        return { passed: ok, reason: ok ? "verified" : "needle_lost_in_long_context" };
      },
    };
  });

  const testTasks: BenchmarkTaskSpec[] = [
    ["TA-01", "100-agent budget cap race", "budget_exhausted"],
    ["TA-02", "95% subscription warning non-exhaustion", "subscription_available"],
    ["TA-03", "Cloudflare 10k neurons daily cap", "cloudflare_neurons_exhausted"],
    ["TA-04", "OpenCode 403 third-party free chat block", "native_opencode_only"],
    ["TA-05", "Unresolved hold across monthly rollover", "reconciliation_required"],
  ].map(([id, scenario, expectedCode]) => ({
    id: id!,
    category: "test_authoring",
    title: `Regression test spec for ${scenario}`,
    critical: true,
    system: "Return strict JSON patch specification including expected error code in regressionCheck.",
    prompt: `Write regression assertion for ${scenario} verifying code ${expectedCode}.`,
    outputSchema: PATCH_SCHEMA,
    verify: (res) => {
      const q = verifyGlobalRouterOutput(res, { provider: "openrouter", outputSchema: PATCH_SCHEMA });
      if (!q.ok) return { passed: false, reason: q.reason ?? "schema_invalid" };
      const parsed = JSON.parse(res.text) as Record<string, string>;
      const ok = Boolean(parsed.regressionCheck?.includes(expectedCode!));
      return { passed: ok, reason: ok ? "verified" : "missing_assertion_code" };
    },
  }));

  const summaries: BenchmarkTaskSpec[] = [1, 2, 3, 4, 5].map((n) => ({
    id: `SM-0${n}`,
    category: "summary",
    title: `Honest operational status summary #${n}`,
    critical: false,
    system: "Summarize verified facts and blockers in JSON without inventing unverified claims.",
    prompt: `Run #${n}: local unit tests passed (SHA abc00${n}), live API key missing for provider-${n}. Summarize honestly.`,
    outputSchema: SUMMARY_SCHEMA,
    verify: (res) => {
      const q = verifyGlobalRouterOutput(res, { provider: "openrouter", outputSchema: SUMMARY_SCHEMA });
      if (!q.ok) return { passed: false, reason: q.reason ?? "schema_invalid" };
      const parsed = JSON.parse(res.text) as { status?: string; verifiedFacts?: string[]; blocker?: string };
      const ok =
        Boolean(parsed.verifiedFacts?.some((f) => f.includes(`abc00${n}`))) &&
        Boolean(parsed.blocker && parsed.blocker !== "none");
      return { passed: ok, reason: ok ? "verified" : "dishonest_or_incomplete_summary" };
    },
  }));

  const recoveries: BenchmarkTaskSpec[] = [1, 2, 3, 4, 5].map((n) => ({
    id: `RR-0${n}`,
    category: "routine_recovery",
    title: `Portable routine checkpoint continuation #${n}`,
    critical: true,
    system: "Continue from completed tool receipt without replaying already-executed side effects.",
    prompt: `Prior portable receipt: STEP_${n}_COMMITTED=true. Next pending step: verify final summary JSON with status="completed_without_replay" and blocker="none".`,
    outputSchema: SUMMARY_SCHEMA,
    verify: (res) => {
      if (res.content.some((b) => b.type === "tool_use")) {
        return { passed: false, reason: "replayed_tool_side_effect" };
      }
      const q = verifyGlobalRouterOutput(res, { provider: "openrouter", outputSchema: SUMMARY_SCHEMA });
      if (!q.ok) return { passed: false, reason: q.reason ?? "schema_invalid" };
      const parsed = JSON.parse(res.text) as { status?: string; verifiedFacts?: string[] };
      const ok =
        parsed.status === "completed_without_replay" &&
        Boolean(parsed.verifiedFacts?.some((f) => f.includes(`STEP_${n}_COMMITTED`)));
      return { passed: ok, reason: ok ? "verified" : "checkpoint_state_dropped" };
    },
  }));

  return [...bugfixes, ...repoNavs, ...multiToolSchemas, ...longContexts, ...testTasks, ...summaries, ...recoveries];
}

export const GLOBAL_ROUTER_BENCHMARK_TASKS: readonly BenchmarkTaskSpec[] = buildTasks();

export const REPRESENTATIVE_BENCHMARK_MODELS: readonly BenchmarkCandidateModel[] = [
  // Primary Subscription Baselines (4)
  {
    id: "claude-sonnet-5-5",
    provider: "anthropic",
    lane: "subscription",
    label: "Claude Sonnet 5.5 (Sub Baseline)",
    incrementalInputNanoPerToken: 0,
    incrementalOutputNanoPerToken: 0,
  },
  {
    id: "gpt-6.1-sol",
    provider: "openai",
    lane: "subscription",
    label: "GPT-6.1 Sol (Codex Sub Baseline)",
    incrementalInputNanoPerToken: 0,
    incrementalOutputNanoPerToken: 0,
  },
  {
    id: "grok-4.7",
    provider: "openai",
    lane: "subscription",
    label: "Grok 4.7 (Sub Baseline)",
    incrementalInputNanoPerToken: 0,
    incrementalOutputNanoPerToken: 0,
  },
  {
    id: "gemini-4-argon",
    provider: "gemini",
    lane: "subscription",
    label: "Gemini 4 Argon (Sub Baseline)",
    incrementalInputNanoPerToken: 0,
    incrementalOutputNanoPerToken: 0,
  },
  // OpenCode Go Included Allowance (6)
  {
    id: "opencode:go:deepseek-v4.1-flash",
    provider: "opencode",
    lane: "opencode_go",
    label: "OpenCode Go DeepSeek V4.1 Flash",
    incrementalInputNanoPerToken: 0,
    incrementalOutputNanoPerToken: 0,
  },
  {
    id: "opencode:go:deepseek-v4-pro",
    provider: "opencode",
    lane: "opencode_go",
    label: "OpenCode Go DeepSeek V4 Pro",
    incrementalInputNanoPerToken: 0,
    incrementalOutputNanoPerToken: 0,
  },
  {
    id: "opencode:go:glm-5.3",
    provider: "opencode",
    lane: "opencode_go",
    label: "OpenCode Go GLM-5.3",
    incrementalInputNanoPerToken: 0,
    incrementalOutputNanoPerToken: 0,
  },
  {
    id: "opencode:go:kimi-k3.1-pro",
    provider: "opencode",
    lane: "opencode_go",
    label: "OpenCode Go Kimi K3.1 Pro",
    incrementalInputNanoPerToken: 0,
    incrementalOutputNanoPerToken: 0,
  },
  {
    id: "opencode:go:minimax-m3",
    provider: "opencode",
    lane: "opencode_go",
    label: "OpenCode Go MiniMax M3",
    incrementalInputNanoPerToken: 0,
    incrementalOutputNanoPerToken: 0,
  },
  {
    id: "opencode:go:mimo-v2.6-pro",
    provider: "opencode",
    lane: "opencode_go",
    label: "OpenCode Go Xiaomi MiMo V2.6 Pro",
    incrementalInputNanoPerToken: 0,
    incrementalOutputNanoPerToken: 0,
  },
  // Free API Pool (6)
  {
    id: "nvidia/nemotron-3.5-super-vl:free",
    provider: "openrouter",
    lane: "free_api",
    label: "OpenRouter Nemotron 3.5 Super VL Free",
    incrementalInputNanoPerToken: 0,
    incrementalOutputNanoPerToken: 0,
  },
  {
    id: "nvidia/nemotron-3-ultra-550b-a55b:free",
    provider: "openrouter",
    lane: "free_api",
    label: "OpenRouter Nemotron 3 Ultra Free",
    incrementalInputNanoPerToken: 0,
    incrementalOutputNanoPerToken: 0,
  },
  {
    id: "baidu/ernie-5.5-flash-preview:free",
    provider: "openrouter",
    lane: "free_api",
    label: "OpenRouter ERNIE 5.5 Flash Free",
    incrementalInputNanoPerToken: 0,
    incrementalOutputNanoPerToken: 0,
  },
  {
    id: "inclusionai/ling-3.2-flash:free",
    provider: "openrouter",
    lane: "free_api",
    label: "OpenRouter Ling 3.2 Flash Free",
    incrementalInputNanoPerToken: 0,
    incrementalOutputNanoPerToken: 0,
  },
  {
    id: "groq/gpt-oss-120b",
    provider: "groq",
    lane: "free_api",
    label: "GroqCloud GPT-OSS 120B Free",
    incrementalInputNanoPerToken: 0,
    incrementalOutputNanoPerToken: 0,
  },
  {
    id: "@cf/openai/gpt-oss-120b",
    provider: "cloudflare",
    lane: "free_api",
    label: "Workers AI GPT-OSS 120B Free",
    incrementalInputNanoPerToken: 0,
    incrementalOutputNanoPerToken: 0,
  },
  // OpenRouter Paid Concrete & Dynamic (9)
  {
    id: "deepseek/deepseek-v4.1-flash-1017",
    provider: "openrouter",
    lane: "paid_low_cost",
    label: "OpenRouter DeepSeek V4.1 Flash 1017",
    incrementalInputNanoPerToken: 30,
    incrementalOutputNanoPerToken: 200,
  },
  {
    id: "deepseek/deepseek-v4-pro",
    provider: "openrouter",
    lane: "paid_low_cost",
    label: "OpenRouter DeepSeek V4 Pro",
    incrementalInputNanoPerToken: 1280,
    incrementalOutputNanoPerToken: 2560,
  },
  {
    id: "tencent/hy4-flash",
    provider: "openrouter",
    lane: "paid_low_cost",
    label: "OpenRouter Tencent Hy4 Flash",
    incrementalInputNanoPerToken: 35,
    incrementalOutputNanoPerToken: 141,
  },
  {
    id: "minimax/minimax-m3.1-flash",
    provider: "openrouter",
    lane: "paid_low_cost",
    label: "OpenRouter MiniMax M3.1 Flash",
    incrementalInputNanoPerToken: 150,
    incrementalOutputNanoPerToken: 600,
  },
  {
    id: "z-ai/glm-5.3-flash",
    provider: "openrouter",
    lane: "paid_low_cost",
    label: "OpenRouter GLM-5.3 Flash",
    incrementalInputNanoPerToken: 120,
    incrementalOutputNanoPerToken: 380,
  },
  {
    id: "z-ai/glm-5.3",
    provider: "openrouter",
    lane: "paid_low_cost",
    label: "OpenRouter GLM-5.3",
    incrementalInputNanoPerToken: 70,
    incrementalOutputNanoPerToken: 1400,
  },
  {
    id: "moonshotai/kimi-k3.1-pro",
    provider: "openrouter",
    lane: "paid_low_cost",
    label: "OpenRouter Kimi K3.1 Pro",
    incrementalInputNanoPerToken: 241,
    incrementalOutputNanoPerToken: 8403,
  },
  {
    id: "xiaomi/mimo-v2.6-flash",
    provider: "openrouter",
    lane: "paid_low_cost",
    label: "OpenRouter Xiaomi MiMo V2.6 Flash",
    incrementalInputNanoPerToken: 140,
    incrementalOutputNanoPerToken: 280,
  },
  {
    id: "openrouter/auto-code",
    provider: "openrouter",
    lane: "paid_dynamic",
    label: "OpenRouter Auto Code",
    incrementalInputNanoPerToken: 150,
    incrementalOutputNanoPerToken: 600,
  },
  // Direct Cloud APIs (7)
  {
    id: "deepseek-flash",
    provider: "deepseek",
    lane: "direct_api",
    label: "DeepSeek Direct Flash",
    incrementalInputNanoPerToken: 300,
    incrementalOutputNanoPerToken: 1200,
  },
  {
    id: "deepseek-v4-pro",
    provider: "deepseek",
    lane: "direct_api",
    label: "DeepSeek Direct V4 Pro",
    incrementalInputNanoPerToken: 1320,
    incrementalOutputNanoPerToken: 3960,
  },
  {
    id: "hunyuan-hy4",
    provider: "tencent",
    lane: "direct_api",
    label: "Tencent Hunyuan Direct Hy4",
    incrementalInputNanoPerToken: 417,
    incrementalOutputNanoPerToken: 1251,
  },
  {
    id: "MiniMax-M3",
    provider: "minimax",
    lane: "direct_api",
    label: "MiniMax Direct M3",
    incrementalInputNanoPerToken: 300,
    incrementalOutputNanoPerToken: 1200,
  },
  {
    id: "glm-5.3",
    provider: "zai",
    lane: "direct_api",
    label: "Z.ai Direct GLM-5.3",
    incrementalInputNanoPerToken: 1400,
    incrementalOutputNanoPerToken: 4400,
  },
  {
    id: "kimi-k3.1-pro",
    provider: "moonshot",
    lane: "direct_api",
    label: "Moonshot Direct Kimi K3.1 Pro",
    incrementalInputNanoPerToken: 2000,
    incrementalOutputNanoPerToken: 10000,
  },
  {
    id: "nvidia-nemotron-3-ultra-550b-a55b",
    provider: "nvidia",
    lane: "direct_api",
    label: "NVIDIA NIM Nemotron 3 Ultra",
    incrementalInputNanoPerToken: 500,
    incrementalOutputNanoPerToken: 2200,
  },
];

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? 0;
}

/**
 * Executes the stratified 35-task benchmark suite across the supplied models using a
 * caller-supplied `ModelProvider` runner (either live API credentials or calibrated provider harnesses).
 */
export async function runGlobalRouterBenchmarkSuite(options: {
  models?: readonly BenchmarkCandidateModel[];
  tasks?: readonly BenchmarkTaskSpec[];
  executionMode: "provider_harness" | "live_api";
  runner: (
    candidate: BenchmarkCandidateModel,
    task: BenchmarkTaskSpec,
    request: ModelRequest,
    attempt: number,
  ) => Promise<{ result: ModelResult; latencyMs: number }>;
  db?: Database;
  orgId?: string;
}): Promise<BenchmarkSuiteResult> {
  const models = options.models ?? REPRESENTATIVE_BENCHMARK_MODELS;
  const tasks = options.tasks ?? GLOBAL_ROUTER_BENCHMARK_TASKS;
  if (tasks.length < 30) {
    throw new Error("Benchmark suite requires at least 30 stratified tasks");
  }

  const reports: BenchmarkModelReport[] = [];
  for (const candidate of models) {
    let verifiedSuccesses = 0;
    let schemaChecks = 0;
    let schemaPasses = 0;
    let totalCostNano = 0;
    let totalRetries = 0;
    const latencies: number[] = [];
    const categoryPassCounts: Record<BenchmarkCategory, { passed: number; total: number }> = {
      bugfix: { passed: 0, total: 0 },
      repo_nav: { passed: 0, total: 0 },
      multi_tool_schema: { passed: 0, total: 0 },
      long_context: { passed: 0, total: 0 },
      test_authoring: { passed: 0, total: 0 },
      summary: { passed: 0, total: 0 },
      routine_recovery: { passed: 0, total: 0 },
    };

    for (const task of tasks) {
      categoryPassCounts[task.category].total++;
      const needsSchemaOrTool = Boolean(task.outputSchema || task.tools?.length);
      if (needsSchemaOrTool) schemaChecks++;

      const request: ModelRequest = {
        model: candidate.id,
        system: task.system,
        messages: [{ role: "user", content: task.prompt }],
        maxTokens: 512,
        ...(task.tools ? { tools: task.tools } : {}),
        ...(task.outputSchema ? { outputSchema: task.outputSchema } : {}),
        noTransportRetries: true,
      };

      let passed = false;
      let schemaValid = false;
      for (let attempt = 1; attempt <= 2; attempt++) {
        if (attempt > 1) totalRetries++;
        const { result, latencyMs } = await options.runner(candidate, task, request, attempt);
        latencies.push(latencyMs);
        const callCost =
          result.costNanoUsd ??
          result.usage.inputTokens * candidate.incrementalInputNanoPerToken +
            result.usage.outputTokens * candidate.incrementalOutputNanoPerToken;
        totalCostNano += callCost;

        const q = verifyGlobalRouterOutput(result, {
          provider: candidate.provider,
          tools: task.tools,
          outputSchema: task.outputSchema,
        });
        if (q.ok) schemaValid = true;
        const verdict = task.verify(result);
        if (verdict.passed) {
          passed = true;
          break;
        }
        // Bounded single retry only when Quality Guardian flags structural/transient issue.
        if (!q.escalate) break;
      }

      if (needsSchemaOrTool && schemaValid) schemaPasses++;
      if (passed) {
        verifiedSuccesses++;
        categoryPassCounts[task.category].passed++;
      }
    }

    const verifiedSuccessRate = Number((verifiedSuccesses / tasks.length).toFixed(4));
    const toolSchemaReliability = schemaChecks > 0 ? Number((schemaPasses / schemaChecks).toFixed(4)) : 1;
    const costPerVerifiedSuccessNanoUsd = verifiedSuccesses > 0 ? Math.round(totalCostNano / verifiedSuccesses) : null;

    const promotionDecision: BenchmarkModelReport["promotionDecision"] =
      verifiedSuccessRate >= 0.85 && toolSchemaReliability >= 0.95
        ? "promote_all"
        : verifiedSuccessRate >= 0.7 && toolSchemaReliability >= 0.85
          ? "promote_non_critical"
          : "quarantine_below_threshold";

    reports.push({
      modelId: candidate.id,
      provider: candidate.provider,
      lane: candidate.lane,
      label: candidate.label,
      tasksRun: tasks.length,
      verifiedSuccesses,
      verifiedSuccessRate,
      toolSchemaReliability,
      totalIncrementalCostNanoUsd: totalCostNano,
      costPerVerifiedSuccessNanoUsd,
      costPerVerifiedSuccessUsd:
        costPerVerifiedSuccessNanoUsd !== null ? Number((costPerVerifiedSuccessNanoUsd / 1e9).toFixed(8)) : null,
      p50LatencyMs: percentile(latencies, 0.5),
      p95LatencyMs: percentile(latencies, 0.95),
      totalRetries,
      vsBaselineSuccessDelta: 0,
      promotionDecision,
      categoryPassCounts,
    });
  }

  const baseline = reports.find((r) => r.modelId === "claude-sonnet-5-5") ?? reports[0];
  const baselineSuccessRate = baseline?.verifiedSuccessRate ?? 1;
  for (const r of reports) {
    r.vsBaselineSuccessDelta = Number((r.verifiedSuccessRate - baselineSuccessRate).toFixed(4));
  }

  const suiteResult: BenchmarkSuiteResult = {
    suiteVersion: "gmr-bench-2026.11.23-v1",
    executedAt: new Date().toISOString(),
    taskCount: tasks.length,
    modelCount: reports.length,
    executionMode: options.executionMode,
    baselineModelId: baseline?.modelId ?? "claude-sonnet-5-5",
    baselineSuccessRate,
    models: reports,
  };

  if (options.db && options.orgId) {
    await options.db.insert(schema.globalRouterBenchmarks).values({
      orgId: options.orgId,
      suiteVersion: suiteResult.suiteVersion,
      taskCount: suiteResult.taskCount,
      modelCount: suiteResult.modelCount,
      summary: {
        executionMode: suiteResult.executionMode,
        baselineModelId: suiteResult.baselineModelId,
        baselineSuccessRate: suiteResult.baselineSuccessRate,
        promotedAllCount: reports.filter((r) => r.promotionDecision === "promote_all").length,
        promotedNonCriticalCount: reports.filter((r) => r.promotionDecision === "promote_non_critical").length,
        quarantinedCount: reports.filter((r) => r.promotionDecision === "quarantine_below_threshold").length,
      },
      results: reports,
    });
  }

  return suiteResult;
}
