import { describe, expect, test } from "bun:test";
import { testConfig } from "./index";

const org = "11111111-1111-4111-8111-111111111111";
const task = "22222222-2222-4222-8222-222222222222";
const cfg = {
  COMMUNICATION_ENABLED: "true",
  COMMUNICATION_ORG_IDS: org,
  COMMUNICATION_TASK_IDS: task,
  COMMUNICATION_FEATURES: "founderUpdates,handoffs",
};

describe("communication pilot configuration", () => {
  test("new behavior starts off with no admitted scope", () => {
    const config = testConfig();
    expect(config.COMMUNICATION_ENABLED).toBe(false);
    expect(config.COMMUNICATION_ORG_IDS).toEqual([]);
    expect(config.COMMUNICATION_TASK_IDS).toEqual([]);
    expect(config.COMMUNICATION_FEATURES).toEqual([]);
  });
  test("only declared features and exact UUIDs are accepted", () => {
    const config = testConfig(cfg);
    expect(config.COMMUNICATION_ORG_IDS).toEqual([org]);
    expect(config.COMMUNICATION_TASK_IDS).toEqual([task]);
    expect(config.COMMUNICATION_FEATURES).toEqual(["founderUpdates", "handoffs"]);
    for (const field of ["COMMUNICATION_ORG_IDS", "COMMUNICATION_TASK_IDS"]) {
      expect(() => testConfig({ ...cfg, [field]: "*" })).toThrow();
    }
    expect(() => testConfig({ ...cfg, COMMUNICATION_FEATURES: "everything" })).toThrow();
  });
});
