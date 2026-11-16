import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

let adapter = {};
try {
  adapter = await import("./adapters/agent-chats.mjs");
} catch (error) {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
}
const collect = (...args) => {
  assert.equal(typeof adapter.collectAgentChats, "function", "Agent Chats collector is implemented");
  return adapter.collectAgentChats(...args);
};
const assess = (...args) => {
  assert.equal(typeof adapter.assessAgentChats, "function", "Agent Chats assessment is implemented");
  return adapter.assessAgentChats(...args);
};
const digest = (letter) => `sha256:${letter.repeat(64)}`;
const NOW = "2026-11-16T20:00:00Z",
  START = "2026-11-16T18:00:00Z";

async function runtime(t, options = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "guardian-agent-chats-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runnerPath = join(dir, "runner with spaces.js");
  await writeFile(runnerPath, options.runnerContent ?? "var MACHINE_PROTOCOL_VERSION = 57;\n");
  await utimes(runnerPath, new Date("2020-01-01"), new Date("2020-01-01"));
  const inode = String((await stat(runnerPath)).ino);
  let containers = 0;
  const run = async (command, args) => {
    if (command === "docker") {
      assert.deepEqual(args.slice(0, 2), ["--context", "agentes-chat-local"]);
      assert.equal(args[3], "inspect");
      assert.equal(args[5], "--format");
      assert.ok(!args[6].includes(".Config.Env"), "Docker never requests environment values");
      assert.ok(!args[6].includes("json .Config.Labels"), "only a fixed label allowlist is requested");
      if (args[2] === "container") {
        assert.equal(args[4], "agentes");
        containers++;
        return {
          status: 0,
          stdout: JSON.stringify({
            id: "container-1",
            name: "/agentes",
            imageId: options.restarted && containers > 1 ? digest("b") : digest("a"),
            imageReference: "agentes-chat-local:looks-like-new-sha",
            running: true,
            status: "running",
            health: "healthy",
            startedAt: START,
            labels: {
              "org.opencontainers.image.revision": "a".repeat(40),
              "org.opencontainers.image.source": "https://github.com/example/app",
              SECRET_LABEL: "do-not-leak",
            },
            Config: { Env: ["SECRET_KEY=do-not-leak"] },
          }),
          stderr: "",
        };
      }
      assert.equal(args[2], "image");
      assert.equal(args[4], digest("a"));
      return {
        status: 0,
        stdout: JSON.stringify({
          id: digest("a"),
          repoDigests: [`registry.example/app@${digest("a")}`],
          labels: { "org.opencontainers.image.revision": "a".repeat(40) },
        }),
        stderr: "",
      };
    }
    if (command === "/bin/ps") {
      assert.equal(args[args.indexOf("-p") + 1], "42");
      const field = args.at(-1);
      return {
        status: 0,
        stdout:
          field === "lstart="
            ? "Mon Nov 16 14:00:00 2026\n"
            : field === "comm="
              ? "/opt/homebrew/bin/bun\n"
              : `/opt/homebrew/bin/bun '${runnerPath}' --private-token do-not-leak\n`,
        stderr: "",
      };
    }
    if (command === "/usr/sbin/lsof") {
      assert.deepEqual(args, ["-a", "-p", "42", "-F0pfin"]);
      return {
        status: 0,
        stdout: `p42\0\nftxt\0i${options.oldInode ? "1" : inode}\0n${options.unbound ? "/other/runner.js" : runnerPath}\0\n`,
        stderr: "",
      };
    }
    assert.fail(`unexpected command ${command}`);
  };
  return {
    dockerContext: "agentes-chat-local",
    containerName: "agentes",
    runnerPath,
    runnerPids: [42],
    platform: "darwin",
    run,
  };
}

function healthy() {
  const component = (letter, sourceLetter) => ({
    artifactDigest: digest(letter),
    sourceSha: sourceLetter.repeat(40),
    sourceTree: "e".repeat(40),
    buildId: `build-${letter}`,
    dirty: false,
  });
  const server = component("a", "a"),
    runner = { ...component("b", "b"), protocol: 57 };
  const target = {
    id: "agent-chats-local",
    dockerContext: "agentes-chat-local",
    containerName: "agentes",
    runnerPath: "/runner/host.js",
    requiredComponents: ["server", "runner"],
  };
  const release = {
    components: { server, runner },
    compatibility: {
      serverArtifactDigest: server.artifactDigest,
      runnerArtifactDigest: runner.artifactDigest,
      acceptedRunnerProtocols: [57],
      schemaId: "schema-7",
      rollbackCompatible: true,
    },
  };
  const observation = {
    schema: "delivery-agent-chats-observation/v1",
    observedAt: NOW,
    stable: true,
    errors: [],
    components: {
      server: {
        artifactDigest: server.artifactDigest,
        dockerContext: target.dockerContext,
        containerName: target.containerName,
        containerId: "container-1",
        startedAt: START,
        running: true,
        state: "running",
        health: "healthy",
        provenance: { status: "present", value: server },
      },
      runner: {
        artifactDigest: runner.artifactDigest,
        path: target.runnerPath,
        protocol: 57,
        stable: true,
        processes: [
          {
            pid: 42,
            processStartIdentity: "runner-start",
            stable: true,
            bundleIdentityMatches: true,
            replacedAfterStart: false,
          },
        ],
        provenance: { status: "present", value: runner },
      },
    },
    databaseSchema: { id: "schema-7", compatible: true, rollbackCompatible: true },
  };
  const featureEvidence = {
    status: "pass",
    targetId: target.id,
    scenarioId: "native-guardian-view",
    observedAt: NOW,
    artifacts: { server: server.artifactDigest, runner: runner.artifactDigest },
    containerId: "container-1",
    serverStartedAt: START,
    runnerIdentities: [{ pid: 42, processStartIdentity: "runner-start" }],
    featureEnabled: true,
    configurationReady: true,
    permissionVerified: true,
  };
  return { target, release, observation, featureEvidence, now: NOW };
}

test("collector requests only exact container/image fields and strips unexpected private fields", async (t) => {
  const result = await collect(await runtime(t));
  assert.equal(result.components.server.artifactDigest, digest("a"));
  assert.equal(result.components.runner.protocol, 57);
  assert.ok(/^sha256:[a-f0-9]{64}$/.test(result.components.runner.artifactDigest));
  assert.equal(result.components.runner.processes[0].bundleIdentityMatches, true);
  assert.ok(!JSON.stringify(result).includes("do-not-leak"));
  assert.equal(result.authorityGranted, false);
});

test("a tag or OCI revision label never becomes source provenance", async (t) => {
  const result = await collect(await runtime(t));
  assert.equal(result.components.server.provenance.status, "unknown");
  assert.equal(result.components.server.provenance.value, null);
  assert.equal(result.components.runner.provenance.value, null);
});

test("collector detects a container restart during its observation", async (t) => {
  const result = await collect(await runtime(t, { restarted: true }));
  assert.equal(result.stable, false);
  assert.ok(result.errors.includes("container_changed_during_observation"));
});

test("collector reads the machine protocol declaration despite unrelated protocol constants", async (t) => {
  const result = await collect(
    await runtime(t, {
      runnerContent:
        "var MACHINE_PROTOCOL_VERSION = 57;\nconst PROTOCOL_VERSION = 1;\nconst unrelated = { protocolVersion: 1 };\n",
    }),
  );
  assert.equal(result.components.runner.protocol, 57);
  assert.equal(result.components.runner.protocolSource, "unique_static_literal_hint");
});

test("generic protocol constants alone do not identify the machine protocol", async (t) => {
  const result = await collect(
    await runtime(t, {
      runnerContent: "const PROTOCOL_VERSION = 1;\nconst protocolVersion = 1;\n",
    }),
  );
  assert.equal(result.components.runner.protocol, null);
});

test("collector treats contradictory machine protocol declarations as unknown", async (t) => {
  const result = await collect(
    await runtime(t, {
      runnerContent: "var MACHINE_PROTOCOL_VERSION = 57;\nvar MACHINE_PROTOCOL_VERSION = 67;\n",
    }),
  );
  assert.equal(result.components.runner.protocol, null);
});

test("non-declaration machine fields and computed expressions are not static protocol literals", async (t) => {
  const result = await collect(
    await runtime(t, {
      runnerContent:
        "const metadata = { MACHINE_PROTOCOL_VERSION: 57 };\nmetadata.MACHINE_PROTOCOL_VERSION = 57;\nconst MACHINE_PROTOCOL_VERSION = 57 + 1;\n",
    }),
  );
  assert.equal(result.components.runner.protocol, null);
});

test("a command-line path hint alone does not prove the runner bundle is mapped", async (t) => {
  const result = await collect(await runtime(t, { unbound: true }));
  assert.equal(result.components.runner.processes[0].bundleIdentityMatches, null);
});

test("collector rejects shell-like selectors and PID injection without dispatching", async () => {
  await assert.rejects(
    () => collect({ dockerContext: "ctx;rm", containerName: "agentes", runnerPath: "/runner.js", platform: "darwin" }),
    /context/i,
  );
  await assert.rejects(
    () => collect({ dockerContext: "ctx", containerName: "--all", runnerPath: "/runner.js", platform: "darwin" }),
    /container/i,
  );
  await assert.rejects(
    () =>
      collect({
        dockerContext: "ctx",
        containerName: "agentes",
        runnerPath: "/runner.js",
        runnerPids: ["42;bad"],
        platform: "darwin",
      }),
    /pid/i,
  );
});

test("distinct component commits are consistent with explicit artifact-bound compatibility", () => {
  const result = assess(healthy());
  assert.equal(result.verdict, "consistent_unattested");
  for (const stage of ["built", "deployed", "running", "feature"]) assert.equal(result[stage].status, "consistent");
  assert.equal(result.authorityGranted, false);
  assert.equal(result.liveVerified, false);
  assert.equal(result.releaseEligible, false);
});

test("matching tag names cannot hide a different image digest", () => {
  const f = healthy();
  f.observation.components.server.artifactDigest = digest("f");
  f.observation.components.server.imageReference = "same-tag";
  assert.equal(assess(f).deployed.status, "blocked");
});

test("missing server provenance leaves source-to-runtime status unknown", () => {
  const f = healthy();
  f.observation.components.server.provenance = { status: "unknown", value: null };
  assert.equal(assess(f).built.status, "unknown");
});

test("incompatible runner protocol blocks the combined runtime", () => {
  const f = healthy();
  f.release.compatibility.acceptedRunnerProtocols = [67];
  assert.equal(assess(f).running.status, "blocked");
});

test("an old compatibility receipt for another artifact cannot authorize this combination", () => {
  const f = healthy();
  f.release.compatibility.runnerArtifactDigest = digest("f");
  assert.equal(assess(f).running.status, "blocked");
});

test("missing compatibility proof does not assume matching or different versions work", () => {
  const f = healthy();
  delete f.release.compatibility;
  assert.equal(assess(f).running.status, "unknown");
});

for (const component of ["webAssets", "desktopShell"]) {
  test(`a required but unobserved ${component} keeps the release unknown`, () => {
    const f = healthy();
    f.target.requiredComponents.push(component);
    assert.equal(assess(f).verdict, "unknown");
  });
}

test("HTTP 200 health does not stand in for native feature acceptance", () => {
  const f = healthy();
  f.featureEvidence = { httpStatus: 200 };
  assert.equal(assess(f).feature.status, "unknown");
});

for (const field of ["featureEnabled", "configurationReady", "permissionVerified"]) {
  test(`missing ${field} prevents live feature consistency`, () => {
    const f = healthy();
    delete f.featureEvidence[field];
    assert.equal(assess(f).feature.status, "unknown");
  });
  test(`false ${field} blocks the feature despite healthy HTTP`, () => {
    const f = healthy();
    f.featureEvidence[field] = false;
    assert.equal(assess(f).feature.status, "blocked");
  });
}

test("database schema incompatible with rollback blocks release consistency", () => {
  const f = healthy();
  f.observation.databaseSchema.rollbackCompatible = false;
  assert.equal(assess(f).running.status, "blocked");
});

test("a stale process retaining an older runner bundle is blocked", () => {
  const f = healthy();
  f.observation.components.runner.processes[0].replacedAfterStart = true;
  assert.equal(assess(f).running.status, "blocked");
});

test("feature evidence for a previous server process is blocked", () => {
  const f = healthy();
  f.featureEvidence.serverStartedAt = "2026-11-16T17:00:00Z";
  assert.equal(assess(f).feature.status, "blocked");
});

test("feature evidence for another runner process is blocked", () => {
  const f = healthy();
  f.featureEvidence.runnerIdentities[0].pid = 99;
  assert.equal(assess(f).feature.status, "blocked");
});

test("stale observations are unknown even when every digest matches", () => {
  const f = healthy();
  f.observation.observedAt = "2026-11-16T19:58:00Z";
  assert.equal(assess(f).verdict, "unknown");
});

test("paused containers cannot count as a usable server even when Docker says Running=true", () => {
  const f = healthy();
  f.observation.components.server.state = "paused";
  assert.equal(assess(f).running.status, "blocked");
});

test("collector failures cannot be hidden by filling in otherwise matching JSON", () => {
  const f = healthy();
  f.observation.errors = ["image_identity_unverified"];
  assert.equal(assess(f).verdict, "unknown");
});

test("malformed process evidence remains unknown without throwing", () => {
  const f = healthy();
  f.observation.components.runner.processes = [null];
  f.featureEvidence.runnerIdentities = [null];
  assert.equal(assess(f).verdict, "unknown");
});

test("assessments never mutate input data or turn trusted booleans into authority", () => {
  const f = healthy();
  f.release.trusted = true;
  f.featureEvidence.trusted = true;
  const before = structuredClone(f),
    result = assess(f);
  assert.deepEqual(f, before);
  assert.equal(result.authorityGranted, false);
  assert.equal(result.liveVerified, false);
});

test("unknown Agent Chats observation schemas remain unknown", () => {
  const f = healthy();
  f.observation.schema = "unexpected/v9";
  assert.equal(assess(f).verdict, "unknown");
});

test("a one-millisecond future server observation or native feature is not current evidence", () => {
  for (const subject of ["observation", "featureEvidence"]) {
    const f = healthy();
    f[subject].observedAt = "2026-11-16T20:00:00.001Z";
    assert.equal(assess(f).verdict, "unknown", subject);
  }
});

test("null Agent Chats assessment objects return unknown without interrupting other products", () => {
  for (const subject of ["target", "release", "observation"]) {
    const f = healthy();
    f[subject] = null;
    assert.equal(assess(f).verdict, "unknown", subject);
  }
  assert.equal(assess(null).verdict, "unknown");
});
