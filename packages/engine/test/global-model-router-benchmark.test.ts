import { afterEach, expect, test } from "bun:test";
import type { ModelResult } from "@agenteschat/providers";
import {
  type BenchmarkCandidateModel,
  type BenchmarkTaskSpec,
  GLOBAL_ROUTER_BENCHMARK_TASKS,
  REPRESENTATIVE_BENCHMARK_MODELS,
  readGlobalModelRouterStatus,
  refreshLiveGlobalRouterCatalog,
  runGlobalRouterBenchmarkSuite,
} from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

function buildDeterministicHarnessReply(
  candidate: BenchmarkCandidateModel,
  task: BenchmarkTaskSpec,
  attempt: number,
): { result: ModelResult; latencyMs: number } {
  const isFlashFreeTier = candidate.id.includes("ling-3.2-flash:free") || candidate.id.includes("ernie-5.5-flash");
  const isExperimentalWeaker = candidate.id.includes("ernie-5.5-flash-preview:free");

  // Simulate realistic transient schema hiccup on attempt 1 for one free flash model so retry accounting is exercised.
  if (isFlashFreeTier && attempt === 1 && task.id === "BF-01") {
    return {
      latencyMs: 310,
      result: {
        text: "{truncated",
        content: [{ type: "text", text: "{truncated" }],
        model: candidate.id,
        stopReason: "max_tokens",
        usage: { inputTokens: 280, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
        usageVerified: true,
      },
    };
  }

  // Simulate realistic critical-task miss on preview-only flash model so non-critical vs full promotion tiers are proven.
  if (isExperimentalWeaker && task.critical && (task.id.endsWith("04") || task.id.endsWith("05"))) {
    return {
      latencyMs: 260,
      result: {
        text: JSON.stringify({ rootCause: "partial", fixedExpression: "incomplete", regressionCheck: "todo" }),
        content: [
          {
            type: "text",
            text: JSON.stringify({ rootCause: "partial", fixedExpression: "incomplete", regressionCheck: "todo" }),
          },
        ],
        model: candidate.id,
        stopReason: "end_turn",
        usage: { inputTokens: 320, outputTokens: 45, cacheReadTokens: 0, cacheWriteTokens: 0 },
        usageVerified: true,
      },
    };
  }

  if (task.category === "repo_nav") {
    const match = /Inspect (\S+) to verify/.exec(task.prompt);
    const modPath = match?.[1] ?? "packages/engine/src/gateway.ts";
    return {
      latencyMs: candidate.lane === "free_api" && candidate.provider === "groq" ? 190 : 480,
      result: {
        text: "",
        content: [{ type: "tool_use", id: `call_${task.id}`, name: "inspect_module", input: { path: modPath } }],
        model: candidate.id,
        stopReason: "tool_use",
        usage: { inputTokens: 300, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 },
        usageVerified: true,
      },
    };
  }

  if (task.category === "multi_tool_schema") {
    const match = /target module (\S+) with checkExports/.exec(task.prompt);
    const modPath = match?.[1] ?? "packages/router/part-1.ts";
    return {
      latencyMs: 510,
      result: {
        text: "",
        content: [
          {
            type: "tool_use",
            id: `call_${task.id}`,
            name: "inspect_module",
            input: { path: modPath, checkExports: true },
          },
        ],
        model: candidate.id,
        stopReason: "tool_use",
        usage: { inputTokens: 340, outputTokens: 48, cacheReadTokens: 0, cacheWriteTokens: 0 },
        usageVerified: true,
      },
    };
  }

  if (task.category === "bugfix") {
    const match = /ensure (.+) is enforced and (\S+) is tested/.exec(task.prompt);
    const json = JSON.stringify({
      rootCause: `Identified ${task.title}`,
      fixedExpression: `if (!(${match?.[1] ?? "valid"})) throw refusal`,
      regressionCheck: `expect(err.reason).toBe("${match?.[2] ?? "verified"}")`,
    });
    return {
      latencyMs: 640,
      result: {
        text: json,
        content: [{ type: "text", text: json }],
        model: candidate.id,
        stopReason: "end_turn",
        usage: { inputTokens: 420, outputTokens: 85, cacheReadTokens: 0, cacheWriteTokens: 0 },
        usageVerified: true,
      },
    };
  }

  if (task.category === "long_context") {
    const match = /CRITICAL_EVIDENCE=(CHECKPOINT_SHA_\S+)/.exec(task.prompt);
    const json = JSON.stringify({
      status: "verified",
      verifiedFacts: [match?.[1] ?? "CHECKPOINT_SHA"],
      blocker: "none",
    });
    return {
      latencyMs: 790,
      result: {
        text: json,
        content: [{ type: "text", text: json }],
        model: candidate.id,
        stopReason: "end_turn",
        usage: { inputTokens: 1600, outputTokens: 60, cacheReadTokens: 0, cacheWriteTokens: 0 },
        usageVerified: true,
      },
    };
  }

  if (task.category === "test_authoring") {
    const match = /verifying code (\S+)\./.exec(task.prompt);
    const json = JSON.stringify({
      rootCause: "Concurrency and boundary guard check",
      fixedExpression: "FOR UPDATE row lock check",
      regressionCheck: `assert error code ${match?.[1] ?? "budget_exhausted"}`,
    });
    return {
      latencyMs: 560,
      result: {
        text: json,
        content: [{ type: "text", text: json }],
        model: candidate.id,
        stopReason: "end_turn",
        usage: { inputTokens: 380, outputTokens: 75, cacheReadTokens: 0, cacheWriteTokens: 0 },
        usageVerified: true,
      },
    };
  }

  if (task.category === "summary") {
    const shaMatch = /\(SHA (abc\d+)\)/.exec(task.prompt);
    const provMatch = /missing for (provider-\d+)/.exec(task.prompt);
    const json = JSON.stringify({
      status: "locally_verified_waiting_key",
      verifiedFacts: [`Unit suite green at ${shaMatch?.[1] ?? "abc001"}`],
      blocker: `Owner API key required for ${provMatch?.[1] ?? "provider-1"}`,
    });
    return {
      latencyMs: 430,
      result: {
        text: json,
        content: [{ type: "text", text: json }],
        model: candidate.id,
        stopReason: "end_turn",
        usage: { inputTokens: 310, outputTokens: 64, cacheReadTokens: 0, cacheWriteTokens: 0 },
        usageVerified: true,
      },
    };
  }

  // routine_recovery
  const stepMatch = /(STEP_\d+_COMMITTED)/.exec(task.prompt);
  const json = JSON.stringify({
    status: "completed_without_replay",
    verifiedFacts: [stepMatch?.[1] ?? "STEP_1_COMMITTED"],
    blocker: "none",
  });
  return {
    latencyMs: 450,
    result: {
      text: json,
      content: [{ type: "text", text: json }],
      model: candidate.id,
      stopReason: "end_turn",
      usage: { inputTokens: 350, outputTokens: 58, cacheReadTokens: 0, cacheWriteTokens: 0 },
      usageVerified: true,
    },
  };
}

test("executes full 35-task x 32-model stratified benchmark suite (1,120 evaluations) and persists receipt", async () => {
  f = await setup();
  expect(GLOBAL_ROUTER_BENCHMARK_TASKS.length).toBe(35);
  expect(REPRESENTATIVE_BENCHMARK_MODELS.length).toBe(32);

  const suite = await runGlobalRouterBenchmarkSuite({
    executionMode: "provider_harness",
    runner: async (candidate, task, _req, attempt) => buildDeterministicHarnessReply(candidate, task, attempt),
    db: f.db,
    orgId: f.org.id,
  });

  expect(suite.taskCount).toBe(35);
  expect(suite.modelCount).toBe(32);
  expect(suite.baselineModelId).toBe("claude-sonnet-5-5");
  expect(suite.baselineSuccessRate).toBe(1);

  // Free & Go models must report strictly $0 incremental cost per verified success
  for (const m of suite.models.filter((r) => r.lane === "free_api" || r.lane === "opencode_go")) {
    expect(m.totalIncrementalCostNanoUsd).toBe(0);
    expect(m.costPerVerifiedSuccessNanoUsd).toBe(0);
  }

  // Paid models report positive integer nano-USD cost per verified success
  for (const m of suite.models.filter((r) => r.lane === "paid_low_cost" || r.lane === "direct_api")) {
    expect(m.costPerVerifiedSuccessNanoUsd).toBeGreaterThan(0);
  }

  // Preview flash model with lower critical pass rate is classified as promote_non_critical, never blanket-promoted
  const ernie = suite.models.find((r) => r.modelId === "baidu/ernie-5.5-flash-preview:free");
  expect(ernie?.promotionDecision).toBe("promote_non_critical");

  // Retry accounting captured the bounded Quality Guardian retry on BF-01
  const ling = suite.models.find((r) => r.modelId === "inclusionai/ling-3.2-flash:free");
  expect(ling?.totalRetries).toBeGreaterThanOrEqual(1);
  expect(ling?.promotionDecision).toBe("promote_all");

  const status = await readGlobalModelRouterStatus(f.db, f.org.id);
  expect(status.latestBenchmark).toMatchObject({
    taskCount: 35,
    modelCount: 32,
  });
}, 60_000);

test("refreshLiveGlobalRouterCatalog syncs OpenRouter, OpenCode Go/Zen, and Direct APIs while quarantining Qwen/Ollama/Gemini API", async () => {
  f = await setup();
  const mockFetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("openrouter.ai")) {
      return Response.json({
        data: [
          {
            id: "nvidia/nemotron-3.5-super-vl:free",
            name: "Nemotron 3.5 Super VL Free",
            context_length: 131072,
            pricing: { prompt: "0", completion: "0", request: "0" },
            supported_parameters: ["tools", "structured_outputs"],
            architecture: { input_modalities: ["text", "image"] },
          },
          {
            id: "qwen/qwen3-coder:free",
            name: "Denied Qwen Free",
            context_length: 128000,
            pricing: { prompt: "0", completion: "0", request: "0" },
          },
        ],
      });
    }
    if (url.includes("opencode.ai/inference/go")) {
      return Response.json({
        data: [
          {
            id: "kimi-k3.1-pro",
            name: "Kimi K3.1 Pro",
            type: "chat",
            canonical_id: "moonshotai/kimi-k3.1-pro",
            api: { "chat-completions": { base_url: "https://opencode.ai/inference/go/openai/v1" } },
            limit: { context: 256000, output: 32768 },
            capabilities: { tools: { supported: true }, structured_output: true },
            cost: { text: { input: { price: 0.6 }, output: { price: 2.5 } } },
            go: { zdr: false, training: false },
          },
        ],
      });
    }
    return Response.json({ data: [] });
  }) as unknown as typeof fetch;

  const synced = await refreshLiveGlobalRouterCatalog(f.db, f.org.id, f.owner.id, {
    fetch: mockFetch,
    sources: ["openrouter", "opencode", "direct"],
  });

  expect(synced.stored).toBeGreaterThan(10);
  const status = await readGlobalModelRouterStatus(f.db, f.org.id);
  const qwen = status.offers.find((o) => o.modelId.includes("qwen"));
  expect(qwen?.qualificationStatus).toBe("denied");
  const nemotron = status.offers.find((o) => o.modelId === "nvidia/nemotron-3.5-super-vl:free");
  expect(nemotron?.qualificationStatus).toBe("eligible");
  const kimiGo = status.offers.find((o) => o.offerId === "opencode:go:kimi-k3.1-pro");
  expect(kimiGo?.qualificationStatus).toBe("eligible");
}, 60_000);
