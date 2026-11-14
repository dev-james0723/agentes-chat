/** Runs inside an isolated pinned-image container: no production mounts, environment or network. */
import { cpSync, mkdirSync, writeFileSync } from "node:fs";

const source = "/work";
for (const dir of [
  "apps/server/runner",
  "apps/server/test/runner",
  "packages/adapters/src",
  "packages/engine/src",
  "packages/engine/test",
]) {
  cpSync(`${source}/${dir}`, `/app/${dir}`, { recursive: true });
}
const phases: Record<string, string[]> = {
  focused: [
    "test",
    "apps/server/test/runner/host-acp-intent.test.ts",
    "apps/server/test/runner/host-acp-runtime.test.ts",
    "apps/server/test/runner/host-acp-mcp.test.ts",
    "apps/server/test/runner/mcp.test.ts",
    "packages/engine/test/bridge.test.ts",
    "packages/engine/test/brain-antigravity.test.ts",
  ],
  regression: [
    "test",
    "apps/server/test/runner/brain-antigravity.test.ts",
    "apps/server/test/runner/access.test.ts",
    "apps/server/test/runner/scope-gate.test.ts",
    "packages/engine/test/machines.test.ts",
    "packages/engine/test/approval-requests.test.ts",
    "packages/engine/test/consultations.test.ts",
    "packages/engine/test/skills.test.ts",
    "packages/engine/test/questions.test.ts",
  ],
  types: ["run", "--filter", "@agenteschat/adapters", "typecheck"],
  "engine-types": ["run", "--filter", "@agenteschat/engine", "typecheck"],
  "server-types": ["run", "--filter", "@agenteschat/server", "typecheck"],
  boundaries: ["run", "check:boundaries"],
  build: [
    "build",
    "apps/server/runner/main.ts",
    "--target=node",
    "--banner=#!/usr/bin/env node",
    "--outfile=/out/agentes-runner.mjs",
  ],
  server: ["run", "--filter", "@agenteschat/server", "build"],
};
const phase = process.argv[2] ?? "focused";
const args = phases[phase];
if (!args) throw new Error("Unknown check phase");
mkdirSync("/out", { recursive: true });
const result = Bun.spawnSync([process.execPath, ...args], {
  cwd: "/app",
  env: { ...process.env, NODE_ENV: "test" },
  stdout: "pipe",
  stderr: "pipe",
});
const log = `${result.stdout.toString()}${result.stderr.toString()}`;
writeFileSync(`/out/${phase}.log`, log);
console.log(log);
writeFileSync(
  `/out/${phase}.json`,
  JSON.stringify(
    {
      phase,
      command: ["bun", ...args],
      exitCode: result.exitCode,
      image: "sha256:b4ee40b7f33b4d147e2ca65af53ebbbef5208c2012551d22c12ab073fe041a1d",
      at: new Date().toISOString(),
    },
    null,
    2,
  ),
);
process.exit(result.exitCode);
