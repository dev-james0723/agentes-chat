import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFoundryDockerCli } from "../src/foundry-docker-runner";
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function transport() {
  const d = mkdtempSync(join(tmpdir(), "foundry-control-test-")); dirs.push(d);
  const script = join(d, "trusted-fixture");
  // Reviewed fixed control fixture, not generated candidate code or Docker.
  writeFileSync(script, '#!/bin/sh\ncase "$3" in\necho) exec /bin/cat;;\noverflow) exec /usr/bin/yes x;;\nwait) exec /bin/sleep 5;;\nenv) exec /usr/bin/env;;\nesac\n'.replaceAll("\\n", "\n"));
  chmodSync(script, 0o700);
  return createFoundryDockerCli({ executable: script, context: "test", dockerConfigDirectory: d, path: "/usr/bin:/bin" });
}
test("bounded trusted control transports stdin as data, without a shell or inherited secrets", async () => {
  const d = transport(); const input = "not a command: $(touch /tmp/never-execute-this)";
  const r = await d.run(["echo"], { stdin: input, timeoutMs: 1000, stdoutBytes: 1024, stderrBytes: 1024 });
  expect(r).toMatchObject({ exitCode: 0, stdout: input, exceeded: false, timedOut: false });
  const env = await d.run(["env"], { timeoutMs: 1000, stdoutBytes: 8192, stderrBytes: 1024 });
  expect(env.stdout).not.toContain("OPENAI_API_KEY"); expect(env.stdout).not.toContain("AGENTES_SECRET");
});
test("output capture terminates an excessive trusted client and remains bounded", async () => {
  const r = await transport().run(["overflow"], { timeoutMs: 1000, stdoutBytes: 128, stderrBytes: 128 });
  expect(r.exceeded).toBe(true); expect(Buffer.byteLength(r.stdout)).toBeLessThanOrEqual(128);
});
test("a control deadline is a client timeout, never an invented container kill acknowledgement", async () => {
  const r = await transport().run(["wait"], { timeoutMs: 30, stdoutBytes: 128, stderrBytes: 128 });
  expect(r.timedOut).toBe(true); expect(r.exitCode).toBeNull();
});
