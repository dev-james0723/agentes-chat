import { describe, expect, test } from "bun:test";
import { communicationFeatureEnabled, communicationPolicyFromConfig } from "../src/communication-policy";

const org = "11111111-1111-4111-8111-111111111111";
const task = "22222222-2222-4222-8222-222222222222";
const cfg = {
  COMMUNICATION_ENABLED: true,
  COMMUNICATION_ORG_IDS: [org],
  COMMUNICATION_TASK_IDS: [task],
  COMMUNICATION_FEATURES: ["founderUpdates", "handoffs"] as const,
};

describe("scoped communication rollout", () => {
  test("old configuration defaults off", () => {
    const policy = communicationPolicyFromConfig({});
    expect(policy).toEqual({ enabled: false, orgIds: [], taskIds: [], features: [] });
    expect(communicationFeatureEnabled(policy, "founderUpdates", { orgId: org, taskId: task })).toBe(false);
  });
  test("requires exact organization, task and feature together", () => {
    const policy = communicationPolicyFromConfig(cfg);
    expect(communicationFeatureEnabled(policy, "founderUpdates", { orgId: org, taskId: task })).toBe(true);
    expect(communicationFeatureEnabled(policy, "handoffs", { orgId: org, taskId: task })).toBe(true);
    expect(communicationFeatureEnabled(policy, "verifiedLearning", { orgId: org, taskId: task })).toBe(false);
    expect(communicationFeatureEnabled(policy, "founderUpdates", { orgId: task, taskId: task })).toBe(false);
    expect(communicationFeatureEnabled(policy, "founderUpdates", { orgId: org, taskId: org })).toBe(false);
    expect(communicationFeatureEnabled(policy, "founderUpdates", { orgId: org, taskId: null })).toBe(false);
  });
  test("empty scopes and wildcard strings do not expand admission", () => {
    for (const field of ["COMMUNICATION_ORG_IDS", "COMMUNICATION_TASK_IDS"] as const) {
      for (const value of [[], ["*"]]) {
        const policy = communicationPolicyFromConfig({ ...cfg, [field]: value });
        expect(communicationFeatureEnabled(policy, "founderUpdates", { orgId: org, taskId: task })).toBe(false);
      }
    }
  });
  test("disable takes effect without changing grants or task state", () => {
    const enabled = communicationPolicyFromConfig(cfg);
    const disabled = communicationPolicyFromConfig({ ...cfg, COMMUNICATION_ENABLED: false });
    expect(communicationFeatureEnabled(disabled, "handoffs", { orgId: org, taskId: task })).toBe(false);
    expect(disabled.orgIds).toEqual(enabled.orgIds);
    expect(disabled.taskIds).toEqual(enabled.taskIds);
    expect(disabled).not.toHaveProperty("grants");
  });
});
