import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Keep engine imports safe regardless of whether the full suite happened to preload wiki/search first.
test("a standalone backend test can import the engine without registry initialization errors", () => {
  const result = spawnSync(
    process.execPath,
    [
      "test",
      "--test-name-pattern",
      "delegation uses the calibrated workspace Jev judge",
      "packages/engine/test/delegation-choice.test.ts",
    ],
    {
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    },
  );
  expect(result.error).toBeUndefined();
  if (result.status !== 0) {
    throw new Error(`Standalone backend bootstrap failed: ${String(result.stderr).slice(-1600)}`);
  }
  expect(result.status).toBe(0);
}, 15_000);
