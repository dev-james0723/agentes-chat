import { expect, setDefaultTimeout, test } from "bun:test";
import { schema } from "@agenteschat/db";
import { memoryScorecard } from "../src/context/scorecard";
import { nativeUsageAttempt } from "../src/harness-economics-native";
import { setup } from "./fixtures";

setDefaultTimeout(120_000);

test("native scorecard consumes scoped receipts without manufacturing cash, revisions or successes", async () => {
  const f = await setup();
  try {
    const runId = crypto.randomUUID();
    const taskId = crypto.randomUUID();
    const policy = { enabled: true, orgIds: [f.org.id], taskIds: [taskId], features: ["economics"] as const };
    await f.db.insert(schema.agentRuns).values({
      id: runId,
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: crypto.randomUUID(),
      triggerMessageId: crypto.randomUUID(),
      trigger: "mention",
      hop: 0,
      status: "done",
      issueId: taskId,
    });
    const receipt = {
      orgId: f.org.id,
      agentId: f.agent.id,
      kind: "agent" as const,
      runId,
      provider: "fixture",
      model: "exact",
      requestedModel: "alias",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costNanoUsd: 2,
    };
    await f.db.insert(schema.usageRecords).values([
      receipt,
      { ...receipt, partial: true, costNanoUsd: 3 },
      {
        ...receipt,
        agentId: null,
        kind: "router",
        provider: "jev",
        purpose: "route",
        billedTo: "platform",
        inputTokens: 0,
        outputTokens: 0,
        costNanoUsd: 4,
      },
      { ...receipt, billedTo: "plan", costNanoUsd: 7 },
      { ...receipt, runId: null, createdAt: new Date("2000-01-01"), costNanoUsd: 1000 },
      { ...receipt, runId: null, agentId: null, billedTo: "platform", costNanoUsd: 1000 },
    ]);
    expect(await memoryScorecard(f.db, f.org.id, f.agent.id)).not.toHaveProperty("economics");
    expect(
      await memoryScorecard(f.db, f.org.id, f.agent.id, 7, { taskId, policy: { ...policy, enabled: false } }),
    ).not.toHaveProperty("economics");
    const scorecard = await memoryScorecard(f.db, f.org.id, f.agent.id, 7, { taskId, policy });
    const economics = scorecard.economics;
    if (!economics) throw new Error("admitted task economics missing");
    expect(economics.report.attempts.unique).toBe(4);
    expect(economics.report.costs.unclassifiedNativeNanoUsd.total).toBe(16);
    expect(economics.report.costs.cash).toEqual([]);
    expect(economics.report.verifiedSuccessfulTasks).toBe(0);
    expect(economics.report.tokensPerVerifiedOutcome).toBeNull();
    expect(economics.report.tokens.total).toBeNull();
    expect(economics.report.coverage.attribution.complete).toBe(false);
    expect(economics.report.coverage.meteredTokens.complete).toBe(false);
    expect(economics.source.independentOutcomes).toBe("unavailable");
    expect(economics.source.taskRevisionBinding).toBe("unavailable");
    expect(economics.source.unattributablePlatformUsage).toBe("excluded_from_agent_scope");
    expect(economics.source.receipts.filter((row) => row.runId === runId)).toHaveLength(4);
    expect(economics.report.savingsClaim).toBe("not_evaluated");
    const otherAgent = await memoryScorecard(f.db, f.org.id, crypto.randomUUID(), 7, { taskId, policy });
    expect(otherAgent.economics?.report.attempts.unique).toBe(0);
    const otherOrg = await memoryScorecard(f.db, crypto.randomUUID(), f.agent.id, 7, { taskId, policy });
    expect(otherOrg).not.toHaveProperty("economics");
  } finally {
    await f.close();
  }
});

test("native legacy metadata does not fill partial, platform or plan unknowns with zero", () => {
  const base = {
    id: "receipt",
    orgId: "org",
    runId: null,
    kind: "agent" as const,
    purpose: null,
    provider: "fixture",
    model: "exact",
    requestedModel: "alias",
    billedTo: "org",
    partial: false,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costNanoUsd: 5,
  };
  expect(nativeUsageAttempt({ ...base, partial: true }).inputTokens).toBeNull();
  expect(nativeUsageAttempt({ ...base, billedTo: "platform" }).inputTokens).toBeNull();
  expect(nativeUsageAttempt({ ...base, billedTo: "plan" }).inputTokens).toBeNull();
  expect(nativeUsageAttempt(base).usageSource).toBe("unknown");
  expect(nativeUsageAttempt(base).accounting).toBeNull();
  expect(nativeUsageAttempt(base).attribution).toBeUndefined();
});
