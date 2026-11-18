// Deterministic, read-only Agent Chats runtime observations. No shell, Docker
// exec, environment dumps, restarts, builds, leases, credentials or mutations.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const SELECTOR = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const LABEL_KEYS = [
  "org.opencontainers.image.revision",
  "org.opencontainers.image.source",
  "org.opencontainers.image.version",
  "org.opencontainers.image.created",
];
const LABEL_FORMAT = `{${LABEL_KEYS.map((key) => `${JSON.stringify(key)}:{{with .Config.Labels}}{{json (index . ${JSON.stringify(key)})}}{{else}}null{{end}}`).join(",")}}`;
const CONTAINER_FORMAT = `{"id":{{json .Id}},"name":{{json .Name}},"imageId":{{json .Image}},"imageReference":{{json .Config.Image}},"startedAt":{{json .State.StartedAt}},"status":{{json .State.Status}},"running":{{json .State.Running}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}},"labels":${LABEL_FORMAT}}`;
const IMAGE_FORMAT = `{"id":{{json .Id}},"repoDigests":{{json .RepoDigests}},"labels":${LABEL_FORMAT}}`;
const present = (value) => typeof value === "string" && value.length > 0;
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const exitStatus = (result) => result?.status ?? result?.exitCode ?? result?.exit ?? null;
const line = (value) => String(value ?? "").replace(/\r?\n$/, "");
const unknownProvenance = () => ({ status: "unknown", value: null });

function defaultRun(command, args) {
  const result = spawnSync(command, args, {
    shell: false,
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, LC_ALL: "C" },
  });
  return { status: result.error ? null : result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
function objectFrom(result) {
  if (exitStatus(result) !== 0 || typeof result.stdout !== "string" || result.stdout.length > 1024 * 1024) return null;
  try {
    const object = JSON.parse(result.stdout);
    return object && typeof object === "object" && !Array.isArray(object) ? object : null;
  } catch {
    return null;
  }
}
function labelsFrom(input) {
  const labels = {};
  for (const key of LABEL_KEYS) {
    let value = input?.[key];
    if (typeof value !== "string" || value.length > 512) continue;
    if (key.endsWith(".revision") && !COMMIT.test(value)) continue;
    if (key.endsWith(".source")) {
      try {
        const url = new URL(value);
        value = `${url.origin}${url.pathname}`;
      } catch {
        continue;
      }
    }
    labels[key] = value;
  }
  return labels;
}
function serverFrom(raw, dockerContext, containerName) {
  return {
    status: "observed",
    dockerContext,
    containerName,
    containerId: typeof raw.id === "string" ? raw.id : null,
    observedName: typeof raw.name === "string" ? raw.name.replace(/^\//, "") : null,
    artifactDigest: DIGEST.test(raw.imageId ?? "") ? raw.imageId : null,
    imageReference: typeof raw.imageReference === "string" ? raw.imageReference.slice(0, 512) : null,
    startedAt: typeof raw.startedAt === "string" ? raw.startedAt : null,
    running: typeof raw.running === "boolean" ? raw.running : null,
    state: ["created", "running", "paused", "restarting", "removing", "exited", "dead"].includes(raw.status)
      ? raw.status
      : "unknown",
    health: ["healthy", "unhealthy", "starting"].includes(raw.health) ? raw.health : null,
    labels: labelsFrom(raw.labels),
    provenance: unknownProvenance(),
  };
}
async function runnerBytes(path) {
  const hash = createHash("sha256"),
    chunks = [];
  let size = 0;
  for await (const bytes of createReadStream(path)) {
    hash.update(bytes);
    size += bytes.length;
    if (size <= 16 * 1024 * 1024) chunks.push(bytes);
  }
  const text = size <= 16 * 1024 * 1024 ? Buffer.concat(chunks).toString("utf8") : "";
  // The actual machine bundle declares this name. Generic protocol constants
  // belong to unrelated embedded libraries. This remains a static hint only;
  // it cannot replace the runner's authenticated wire handshake.
  const values = new Set(
    [...text.matchAll(/\b(?:var|const|let)\s+MACHINE_PROTOCOL_VERSION\s*=\s*(\d+)\s*;/g)]
      .map((match) => Number(match[1]))
      .filter(Number.isSafeInteger),
  );
  return { artifactDigest: `sha256:${hash.digest("hex")}`, protocol: values.size === 1 ? [...values][0] : null };
}
function mappedBundle(output, pid, path, inode) {
  let processMatches = false,
    file;
  const files = [];
  for (const raw of output.split("\0")) {
    const field = raw.replace(/^\n+/, "");
    if (!field) continue;
    const key = field[0],
      value = field.slice(1);
    if (key === "p") {
      processMatches = value === String(pid);
      file = null;
    }
    if (!processMatches) continue;
    if (key === "f") {
      file = { descriptor: value };
      files.push(file);
    }
    if (file && key === "i") file.inode = value;
    if (file && key === "n") file.path = value;
  }
  const matching = files.filter((entry) => entry.descriptor === "txt" && entry.path === path);
  return matching.length ? matching.some((entry) => entry.inode === inode) : null;
}

/** The returned protocol is a static-bundle hint, not a successful handshake. */
export async function collectAgentChats({
  dockerContext,
  containerName,
  runnerPath,
  runnerPids = [],
  run = defaultRun,
  platform = process.platform,
} = {}) {
  if (!SELECTOR.test(dockerContext ?? "")) throw new TypeError("Invalid Docker context");
  if (!SELECTOR.test(containerName ?? "")) throw new TypeError("Invalid container name");
  if (!present(runnerPath) || !isAbsolute(runnerPath) || runnerPath.includes("\0"))
    throw new TypeError("runnerPath must be absolute");
  if (
    !Array.isArray(runnerPids) ||
    runnerPids.length > 16 ||
    runnerPids.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)
  )
    throw new TypeError("runnerPids must contain at most 16 positive PID integers");
  const result = {
    schema: "delivery-agent-chats-observation/v1",
    collectionStartedAt: new Date().toISOString(),
    observedAt: null,
    status: "unknown",
    stable: true,
    authorityGranted: false,
    errors: [],
    components: {
      server: { status: "unknown", provenance: unknownProvenance() },
      runner: {
        status: "unknown",
        path: runnerPath,
        artifactDigest: null,
        protocol: null,
        protocolSource: "unique_static_literal_hint",
        provenance: unknownProvenance(),
        processes: [],
        stable: false,
      },
    },
  };
  const finish = () => {
    result.observedAt = new Date().toISOString();
    result.status = result.errors.length ? "partial" : "observed";
    return result;
  };
  if (platform !== "darwin") {
    result.errors.push("unsupported_platform");
    result.stable = false;
    return finish();
  }
  const call = async (command, args) => {
    try {
      return await run(command, args);
    } catch {
      return { status: null, stdout: "" };
    }
  };
  const containerArgs = [
    "--context",
    dockerContext,
    "container",
    "inspect",
    containerName,
    "--format",
    CONTAINER_FORMAT,
  ];
  const firstContainer = objectFrom(await call("docker", containerArgs));
  if (firstContainer) {
    result.components.server = serverFrom(firstContainer, dockerContext, containerName);
    const server = result.components.server;
    if (server.observedName !== containerName) result.errors.push("container_name_mismatch");
    if (!server.artifactDigest) result.errors.push("image_digest_unavailable");
    else {
      const image = objectFrom(
        await call("docker", [
          "--context",
          dockerContext,
          "image",
          "inspect",
          server.artifactDigest,
          "--format",
          IMAGE_FORMAT,
        ]),
      );
      if (!image || image.id !== server.artifactDigest) result.errors.push("image_identity_unverified");
      else server.imageLabels = labelsFrom(image.labels);
    }
  } else {
    result.errors.push("container_observation_unavailable");
    result.stable = false;
  }

  const runner = result.components.runner;
  try {
    runner.path = await realpath(runnerPath);
    const firstStat = await stat(runner.path);
    if (!firstStat.isFile()) throw new Error("not a file");
    Object.assign(runner, await runnerBytes(runner.path), { status: "observed", stable: true });
    for (const pid of [...new Set(runnerPids)]) {
      const process = {
        pid,
        processStartIdentity: null,
        executablePath: null,
        stable: false,
        bundleIdentityMatches: null,
        replacedAfterStart: null,
      };
      const startArgs = ["-p", String(pid), "-o", "lstart="],
        commandArgs = ["-ww", "-p", String(pid), "-o", "comm="];
      const start = await call("/bin/ps", startArgs),
        command = await call("/bin/ps", commandArgs);
      if (exitStatus(start) === 0 && exitStatus(command) === 0 && present(String(start.stdout ?? "").trim())) {
        process.processStartIdentity = String(start.stdout).trim();
        const commandPath = line(command.stdout);
        process.executablePath = isAbsolute(commandPath) && !commandPath.includes("\0") ? commandPath : null;
        const files = await call("/usr/sbin/lsof", ["-a", "-p", String(pid), "-F0pfin"]);
        if (exitStatus(files) === 0 && String(files.stdout).includes("\0"))
          process.bundleIdentityMatches = mappedBundle(files.stdout, pid, runner.path, String(firstStat.ino));
        const afterStart = await call("/bin/ps", startArgs),
          afterCommand = await call("/bin/ps", commandArgs);
        process.stable =
          exitStatus(afterStart) === 0 &&
          exitStatus(afterCommand) === 0 &&
          String(afterStart.stdout).trim() === process.processStartIdentity &&
          line(afterCommand.stdout) === commandPath;
        const startMs = Date.parse(process.processStartIdentity);
        process.replacedAfterStart = Number.isFinite(startMs) ? firstStat.mtimeMs > startMs + 1000 : null;
      }
      if (!process.stable) {
        runner.stable = false;
        result.stable = false;
        result.errors.push("runner_process_changed_or_unavailable");
      }
      runner.processes.push(process);
    }
    const afterStat = await stat(runner.path),
      afterBytes = await runnerBytes(runner.path);
    if (
      firstStat.ino !== afterStat.ino ||
      firstStat.mtimeMs !== afterStat.mtimeMs ||
      runner.artifactDigest !== afterBytes.artifactDigest ||
      runner.protocol !== afterBytes.protocol
    ) {
      runner.stable = false;
      result.stable = false;
      result.errors.push("runner_bundle_changed_during_observation");
    }
  } catch {
    result.errors.push("runner_bundle_unavailable");
    runner.stable = false;
    result.stable = false;
  }

  const lastContainer = objectFrom(await call("docker", containerArgs));
  if (
    !firstContainer ||
    !lastContainer ||
    !isDeepStrictEqual(
      serverFrom(firstContainer, dockerContext, containerName),
      serverFrom(lastContainer, dockerContext, containerName),
    )
  ) {
    result.stable = false;
    result.errors.push("container_changed_during_observation");
  }
  return finish();
}

const newStage = () => ({ status: "consistent", reasonCodes: [] });
function mark(stage, status, reason) {
  const rank = { consistent: 0, unknown: 1, blocked: 2 };
  if (rank[status] > rank[stage.status]) stage.status = status;
  if (!stage.reasonCodes.includes(reason)) stage.reasonCodes.push(reason);
}
function fresh(at, now, maxAgeMs) {
  const value = Date.parse(at);
  return (
    Number.isFinite(value) &&
    Number.isFinite(now) &&
    Number.isFinite(maxAgeMs) &&
    maxAgeMs > 0 &&
    now - value >= 0 &&
    now - value <= maxAgeMs
  );
}

/** Raw input objects are never trusted attestations, even if they say trusted:true. */
export function assessAgentChats(input = {}) {
  let {
    target = {},
    release = {},
    observation = {},
    featureEvidence,
    now = new Date().toISOString(),
    maxAgeMs = 60_000,
  } = record(input) ? input : {};
  const invalidInput = !record(input) || !record(target) || !record(release) || !record(observation);
  target = record(target) ? target : {};
  release = record(release) ? release : {};
  observation = record(observation) ? observation : {};
  const result = {
    schema: "delivery-agent-chats-assessment/v1",
    authorityGranted: false,
    releaseEligible: false,
    liveVerified: false,
    trust: "not_evaluated",
    requiredTrust: [
      "component_build_provenance",
      "deployment_receipt",
      "compatibility_evidence",
      "runtime_observation",
      "feature_acceptance",
    ],
    built: newStage(),
    deployed: newStage(),
    running: newStage(),
    feature: newStage(),
    verdict: "unknown",
    reasonCodes: [],
  };
  const { built, deployed, running, feature } = result,
    stages = [built, deployed, running, feature];
  if (invalidInput) for (const stage of stages) mark(stage, "unknown", "invalid_assessment_input");
  if (observation.schema !== "delivery-agent-chats-observation/v1")
    for (const stage of stages) mark(stage, "unknown", "observation_schema_unknown");
  const nowMs = now instanceof Date ? now.getTime() : typeof now === "number" ? now : Date.parse(now);
  if (!fresh(observation.observedAt, nowMs, maxAgeMs))
    for (const stage of stages) mark(stage, "unknown", "observation_not_fresh");
  if (Array.isArray(observation.errors) && observation.errors.length)
    for (const stage of stages) mark(stage, "unknown", "collection_errors_present");
  if (observation.stable !== true) for (const stage of stages) mark(stage, "unknown", "observation_not_stable");
  const required =
    Array.isArray(target.requiredComponents) && target.requiredComponents.length <= 16
      ? [...new Set(target.requiredComponents)]
      : ["server", "runner", "webAssets", "desktopShell"];
  if (!required.includes("server") || !required.includes("runner"))
    mark(built, "unknown", "required_components_incomplete");
  for (const name of required) {
    const expected = release.components?.[name],
      component = observation.components?.[name];
    if (!expected || !component) {
      mark(built, "unknown", `${name}_unobserved`);
      mark(deployed, "unknown", `${name}_unobserved`);
      continue;
    }
    if (!DIGEST.test(expected.artifactDigest ?? "") || !DIGEST.test(component.artifactDigest ?? ""))
      mark(deployed, "unknown", `${name}_artifact_unknown`);
    else if (expected.artifactDigest !== component.artifactDigest)
      mark(deployed, "blocked", `${name}_artifact_mismatch`);
    const provenance = component.provenance?.value;
    if (component.provenance?.status !== "present" || !provenance)
      mark(built, "unknown", `${name}_source_provenance_unknown`);
    else {
      for (const field of ["sourceSha", "sourceTree", "buildId", "artifactDigest"]) {
        if (!present(expected[field]) || !present(provenance[field]))
          mark(built, "unknown", `${name}_${field}_unknown`);
        else if (expected[field] !== provenance[field]) mark(built, "blocked", `${name}_${field}_mismatch`);
      }
      if (!COMMIT.test(expected.sourceSha ?? "") || !COMMIT.test(expected.sourceTree ?? ""))
        mark(built, "unknown", `${name}_source_identity_invalid`);
      if (expected.dirty === true || provenance.dirty === true) mark(built, "blocked", `${name}_dirty_build`);
      else if (expected.dirty !== false || provenance.dirty !== false)
        mark(built, "unknown", `${name}_clean_source_unknown`);
    }
    if (["webAssets", "desktopShell"].includes(name) && component.runtimeMatch !== true)
      mark(running, "unknown", `${name}_runtime_unverified`);
  }
  const server = observation.components?.server ?? {},
    runner = observation.components?.runner ?? {};
  for (const field of ["dockerContext", "containerName"]) {
    if (!present(target[field]) || !present(server[field])) mark(deployed, "unknown", `${field}_unknown`);
    else if (target[field] !== server[field]) mark(deployed, "blocked", `${field}_mismatch`);
  }
  if (!present(target.runnerPath) || !present(runner.path)) mark(deployed, "unknown", "runner_path_unknown");
  else if (target.runnerPath !== runner.path) mark(deployed, "blocked", "runner_path_mismatch");
  if (
    server.running === false ||
    server.health === "unhealthy" ||
    ["created", "paused", "restarting", "removing", "exited", "dead"].includes(server.state)
  )
    mark(running, "blocked", "server_not_healthy_running");
  else if (server.running !== true) mark(running, "unknown", "server_running_unknown");
  if (server.state !== "running") mark(running, "unknown", "server_state_unverified");
  if (!present(server.containerId) || !present(server.startedAt))
    mark(running, "unknown", "server_process_identity_unknown");
  if (runner.stable !== true) mark(running, "unknown", "runner_observation_unstable");
  const validProcess = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const rawProcesses = Array.isArray(runner.processes) ? runner.processes : [];
  const processes = rawProcesses.filter(validProcess);
  if (processes.length !== rawProcesses.length) mark(running, "unknown", "malformed_runner_process_evidence");
  if (!processes.length) mark(running, "unknown", "runner_process_unobserved");
  for (const process of processes) {
    if (
      !Number.isSafeInteger(process.pid) ||
      process.pid <= 0 ||
      !present(process.processStartIdentity) ||
      process.stable !== true
    )
      mark(running, "unknown", "runner_process_identity_unknown");
    if (process.bundleIdentityMatches === false || process.replacedAfterStart === true)
      mark(running, "blocked", "runner_process_bundle_mismatch");
    else if (process.bundleIdentityMatches !== true || process.replacedAfterStart !== false)
      mark(running, "unknown", "runner_process_bundle_unverified");
  }
  const compatibility = release.compatibility;
  if (!compatibility) mark(running, "unknown", "compatibility_unverified");
  else {
    for (const [field, expected] of [
      ["serverArtifactDigest", server.artifactDigest],
      ["runnerArtifactDigest", runner.artifactDigest],
    ]) {
      if (!DIGEST.test(compatibility[field] ?? "") || !DIGEST.test(expected ?? ""))
        mark(running, "unknown", "compatibility_artifact_unknown");
      else if (compatibility[field] !== expected) mark(running, "blocked", "compatibility_artifact_mismatch");
    }
    if (!Number.isSafeInteger(runner.protocol) || !Array.isArray(compatibility.acceptedRunnerProtocols))
      mark(running, "unknown", "runner_protocol_compatibility_unknown");
    else if (!compatibility.acceptedRunnerProtocols.includes(runner.protocol))
      mark(running, "blocked", "runner_protocol_incompatible");
    const database = observation.databaseSchema ?? {};
    if (!present(database.id) || !present(compatibility.schemaId)) mark(running, "unknown", "database_schema_unknown");
    else if (database.id !== compatibility.schemaId) mark(running, "blocked", "database_schema_mismatch");
    if (
      database.compatible === false ||
      database.rollbackCompatible === false ||
      compatibility.rollbackCompatible === false
    )
      mark(running, "blocked", "database_rollback_or_runtime_incompatible");
    else if (
      database.compatible !== true ||
      database.rollbackCompatible !== true ||
      compatibility.rollbackCompatible !== true
    )
      mark(running, "unknown", "database_compatibility_unverified");
  }
  if (!featureEvidence) mark(feature, "unknown", "feature_acceptance_missing");
  else {
    if (featureEvidence.status === "fail") mark(feature, "blocked", "feature_acceptance_failed");
    else if (featureEvidence.status !== "pass" || !present(featureEvidence.scenarioId))
      mark(feature, "unknown", "feature_acceptance_unknown");
    for (const field of ["featureEnabled", "configurationReady", "permissionVerified"]) {
      if (featureEvidence[field] === false) mark(feature, "blocked", `feature_${field}_false`);
      else if (featureEvidence[field] !== true) mark(feature, "unknown", `feature_${field}_unknown`);
    }
    for (const [field, expected] of [
      ["targetId", target.id],
      ["containerId", server.containerId],
      ["serverStartedAt", server.startedAt],
    ]) {
      if (!present(expected) || !present(featureEvidence[field])) mark(feature, "unknown", `feature_${field}_unknown`);
      else if (featureEvidence[field] !== expected) mark(feature, "blocked", `feature_${field}_mismatch`);
    }
    for (const name of required) {
      const digest = observation.components?.[name]?.artifactDigest;
      if (!DIGEST.test(digest ?? "") || !DIGEST.test(featureEvidence.artifacts?.[name] ?? ""))
        mark(feature, "unknown", `feature_${name}_artifact_unknown`);
      else if (featureEvidence.artifacts[name] !== digest)
        mark(feature, "blocked", `feature_${name}_artifact_mismatch`);
    }
    const identities = processes
      .map((process) => ({ pid: process.pid, processStartIdentity: process.processStartIdentity }))
      .sort((a, b) => a.pid - b.pid);
    if (!processes.length || !Array.isArray(featureEvidence.runnerIdentities))
      mark(feature, "unknown", "feature_runner_identity_unknown");
    else if (featureEvidence.runnerIdentities.some((value) => !validProcess(value)))
      mark(feature, "unknown", "malformed_feature_runner_evidence");
    else {
      const supplied = featureEvidence.runnerIdentities
        .map((process) => ({ pid: process.pid, processStartIdentity: process.processStartIdentity }))
        .sort((a, b) => a.pid - b.pid);
      if (!isDeepStrictEqual(supplied, identities)) mark(feature, "blocked", "feature_runner_identity_mismatch");
    }
    if (!fresh(featureEvidence.observedAt, nowMs, maxAgeMs)) mark(feature, "unknown", "feature_acceptance_not_fresh");
  }
  if (built.status !== "consistent") mark(deployed, "unknown", "build_identity_not_consistent");
  if (deployed.status !== "consistent") mark(running, "unknown", "deployed_identity_not_consistent");
  if (running.status !== "consistent") mark(feature, "unknown", "runtime_identity_not_consistent");
  result.reasonCodes = [...new Set(stages.flatMap((stage) => stage.reasonCodes))];
  result.verdict = stages.some((stage) => stage.status === "blocked")
    ? "blocked"
    : stages.some((stage) => stage.status === "unknown")
      ? "unknown"
      : "consistent_unattested";
  return result;
}
