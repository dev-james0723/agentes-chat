/** Operator-only CLI. Pass a private JSON configuration path. This utility runs
 * fixed infrastructure probes and prints raw observations; it never qualifies
 * a runtime, imports a candidate, evaluates holdouts, or activates a binding. */
import { readFile } from "node:fs/promises";
import { FOUNDRY_DOCKER_PROBE_PROGRAMS, probeFoundryDockerRuntime } from "../src/foundry-docker-probes";
import { createFoundryDockerCli } from "../src/foundry-docker-runner";
import { FOUNDRY_PURE_TOOL_LIMITS } from "../src/foundry-executor";

const [configurationPath, ...requested] = process.argv.slice(2);
if (!configurationPath || requested.length === 0)
  throw new Error("Expected operator configuration path and fixed probe names.");
const config = JSON.parse(await readFile(configurationPath, "utf8"));
const docker = createFoundryDockerCli(config.transport);
for (const name of requested) {
  if (!(name in FOUNDRY_DOCKER_PROBE_PROGRAMS)) throw new Error("Unknown fixed infrastructure probe.");
  const observation = await probeFoundryDockerRuntime(
    docker,
    {
      imageId: config.imageId,
      seccompPath: config.seccompPath,
      limits: { ...FOUNDRY_PURE_TOOL_LIMITS, ...config.limits },
    },
    name as keyof typeof FOUNDRY_DOCKER_PROBE_PROGRAMS,
  );
  process.stdout.write(`${JSON.stringify(observation)}\n`);
}
