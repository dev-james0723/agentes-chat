import { expect, test } from "bun:test";
import { redactConfig, testConfig } from "./index";

test("Mem0 is optional, default-off, and its key is redacted", () => {
  const config = testConfig();
  expect(config.MEM0_ENABLED).toBe(false);
  expect(config.MEM0_API_KEY).toBeUndefined();
  expect(config.MEM0_REQUEST_TIMEOUT_MS).toBe(5_000);
  const enabled = testConfig({ MEM0_ENABLED: "true", MEM0_API_KEY: "synthetic-only-key" });
  expect(enabled.MEM0_ENABLED).toBe(true);
  expect(redactConfig(enabled).MEM0_API_KEY).toBe("********");
  expect(JSON.stringify(redactConfig(enabled))).not.toContain("synthetic-only-key");
});

test("Mem0 request duration and key headers are bounded", () => {
  for (const timeout of ["0", "99", "30001", "NaN"]) {
    expect(() => testConfig({ MEM0_REQUEST_TIMEOUT_MS: timeout })).toThrow(/MEM0_REQUEST_TIMEOUT_MS/);
  }
  expect(() => testConfig({ MEM0_API_KEY: "test\r\ninjected-header" })).toThrow(/MEM0_API_KEY/);
  expect(testConfig({ MEM0_ENABLED: "true" }).MEM0_API_KEY).toBeUndefined();
});
