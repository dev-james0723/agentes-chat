/** Operator process: immutable reviewed runtime control only, never candidate
 * imports on the host. No new jobs, agents, tasks or polling schedules. */
import { lstat, readFile } from "node:fs/promises";
import { createFoundryRuntimeService, type FoundryRuntimeServiceConfig } from "../src/foundry-runtime-service";
const [configFile] = process.argv.slice(2);
if (!configFile) throw new Error("Expected private operator service config");
const stat = await lstat(configFile);
if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size > 65536) throw new Error("Unsafe runtime configuration");
const config = JSON.parse(await readFile(configFile, "utf8")) as FoundryRuntimeServiceConfig & { port: number };
if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) throw new Error("Invalid private runtime port");
const service = createFoundryRuntimeService(config);
const server = Bun.serve({ hostname: "127.0.0.1", port: config.port, idleTimeout: 120, maxRequestBodySize: 20 * 1024 * 1024,
  fetch: service.fetch, error: () => new Response("Private runtime unavailable", { status: 503 }) });
console.log(JSON.stringify({ service: "foundry-protected-runtime", listening: "loopback-only", port: server.port }));
let stopping = false;
async function stop() { if (stopping) return; stopping = true; await server.stop(); await service.close(); process.exit(0); }
process.on("SIGTERM", () => { void stop(); }); process.on("SIGINT", () => { void stop(); });
