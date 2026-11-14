/** Local validation entry point; no network or production control operations. */
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const out = process.argv[3];
if (!out || !path.isAbsolute(out)) throw new Error("Pass an absolute evidence directory");
mkdirSync(out, { recursive: true });
const changed = [
  "apps/server/runner/brain-antigravity.ts",
  "apps/server/runner/host-acp-runtime.ts",
  "apps/server/runner/host-acp-intent.ts",
  "apps/server/runner/host-acp-mcp.ts",
  "apps/server/runner/mcp.ts",
  "packages/adapters/src/machine-protocol.ts",
  "packages/engine/src/machine-hub.ts",
  "packages/engine/src/mission-mcp.ts",
  "packages/engine/src/run-tools.ts",
  "packages/engine/src/executor.ts",
  "packages/engine/src/brains/types.ts",
  "packages/engine/src/brains/codex.ts",
  "apps/server/test/runner/host-acp-intent.test.ts",
  "apps/server/test/runner/host-acp-runtime.test.ts",
  "apps/server/test/runner/host-acp-mcp.test.ts",
  "packages/engine/test/brain-antigravity.test.ts",
  "packages/engine/test/bridge.test.ts",
  "packages/engine/test/machines.test.ts",
  "packages/engine/test/host-acp-evidence.test.ts",
  "scripts/argon-contract-check.ts",
  "scripts/argon-native-check.ts",
];
const bun = process.execPath;
const phases: Record<string, string[]> = {
  sockets: [bun, "test", "apps/server/test/runner/mcp.test.ts", "apps/server/test/runner/host-acp-mcp.test.ts"],
  review: [
    bun,
    "test",
    "apps/server/test/runner/host-acp-runtime.test.ts",
    "apps/server/test/runner/host-acp-intent.test.ts",
    "packages/engine/test/host-acp-evidence.test.ts",
    "packages/engine/test/brain-antigravity.test.ts",
  ],
  affected: [
    bun,
    "test",
    "apps/server/test/runner/host-acp-intent.test.ts",
    "apps/server/test/runner/host-acp-mcp.test.ts",
    "apps/server/test/runner/mcp.test.ts",
    "packages/engine/test/bridge.test.ts",
    "packages/engine/test/brain-antigravity.test.ts",
    "packages/engine/test/brains.test.ts",
    "packages/engine/test/engine-brains.test.ts",
    "packages/engine/test/questions.test.ts",
  ],
  "adapters-types": [bun, "run", "--filter", "@agenteschat/adapters", "typecheck"],
  "engine-types": [bun, "run", "--filter", "@agenteschat/engine", "typecheck"],
  "server-types": [bun, "run", "--filter", "@agenteschat/server", "typecheck"],
  lint: [path.join(root, "node_modules/.bin/biome"), "check", ...changed],
  format: [path.join(root, "node_modules/.bin/biome"), "check", "--write", ...changed],
  boundaries: [bun, "run", "check:boundaries"],
  licenses: [bun, "run", "check:licenses"],
  runner: [
    bun,
    "build",
    "apps/server/runner/main.ts",
    "--target=node",
    "--banner=#!/usr/bin/env node",
    `--outfile=${out}/agentes-runner.mjs`,
  ],
  server: [bun, "run", "--filter", "@agenteschat/server", "build"],
};
const phase = process.argv[2] ?? "";
const command = phases[phase];
if (!command) throw new Error("Unknown native check phase");
const at = new Date().toISOString();
const lockBefore = Bun.CryptoHasher.hash("sha256", readFileSync(path.join(root, "bun.lock")), "hex");
const result = Bun.spawnSync(command, {
  cwd: root,
  env: {
    ...process.env,
    PATH: `${path.dirname(bun)}:${process.env.PATH ?? ""}`,
    NODE_OPTIONS: "--max-old-space-size=8192",
    NODE_ENV: "test",
    TEST_DATABASE_URL: "",
  },
  stdout: "pipe",
  stderr: "pipe",
});
const log = `${result.stdout.toString()}${result.stderr.toString()}`;
writeFileSync(path.join(out, `native-${phase}.log`), log);
writeFileSync(
  path.join(out, `native-${phase}.json`),
  JSON.stringify(
    {
      at,
      phase,
      command,
      exitCode: result.exitCode,
      lockBefore,
      lockAfter: Bun.CryptoHasher.hash("sha256", readFileSync(path.join(root, "bun.lock")), "hex"),
      outputBytes: Buffer.byteLength(log),
    },
    null,
    2,
  ),
);
console.log(`Native ${phase}: exit ${result.exitCode}; full log in ${out}/native-${phase}.log`);
console.log(log.length > 12000 ? `[bounded output tail]\n${log.slice(-12000)}` : log);
if (phase === "server" && result.exitCode === 0)
  cpSync(path.join(root, "apps/server/dist"), path.join(out, "server-dist"), { recursive: true });
process.exit(result.exitCode);
