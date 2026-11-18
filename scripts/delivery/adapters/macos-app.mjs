// Read-only macOS app observations. Matching JSON is consistency, never authority
// or a trusted release attestation. The caller's evidence layer owns that decision.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

const MAX_METADATA_BYTES = 1024 * 1024;
const PROVENANCE_FILE = "DeliveryProvenance.json";
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const nonempty = (value) => typeof value === "string" && value.length > 0;
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const beneath = (root, path) => {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};
const finalLine = (value) => String(value ?? "").replace(/\r?\n$/, "");
const commandStatus = (result) => result?.status ?? result?.exitCode ?? result?.exit ?? null;

function defaultRun(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    shell: false,
    timeout: 15_000,
    maxBuffer: 2 * MAX_METADATA_BYTES,
    env: { ...process.env, LC_ALL: "C" },
  });
  return { status: result.error ? null : result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

async function digestFile(path) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return `sha256:${hash.digest("hex")}`;
}

async function boundedFile(path) {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > MAX_METADATA_BYTES) throw new Error("metadata_size_invalid");
  const bytes = await readFile(path);
  if (bytes.byteLength > MAX_METADATA_BYTES) throw new Error("metadata_size_invalid");
  return bytes;
}

async function readProvenance(bundlePath, errors) {
  const path = join(bundlePath, "Contents", "Resources", PROVENANCE_FILE);
  try {
    const resolved = await realpath(path);
    if (!beneath(bundlePath, resolved)) {
      errors.push("provenance_path_escape");
      return { status: "invalid", value: null, digest: null };
    }
    const bytes = await boundedFile(resolved);
    const value = JSON.parse(bytes.toString("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_json_object");
    return { status: "present", value, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
  } catch (error) {
    const missing = error.code === "ENOENT";
    errors.push(missing ? "provenance_missing" : "provenance_invalid");
    return { status: missing ? "missing" : "invalid", value: null, digest: null };
  }
}

function textFiles(output, pid) {
  const files = [];
  let processMatches = false,
    file;
  for (const raw of output.split("\0")) {
    const field = raw.replace(/^\n+/, "");
    if (!field) continue;
    const key = field[0],
      value = field.slice(1);
    if (key === "p") {
      processMatches = value === String(pid);
      file = undefined;
    }
    if (!processMatches) continue;
    if (key === "f") {
      file = { descriptor: value };
      files.push(file);
    }
    if (file && key === "i") file.inode = value;
    if (file && key === "n") file.path = value;
  }
  return files;
}

/**
 * Collect one explicitly selected installed bundle and optional PID.
 * `run(command, argv)` may be supplied by a read-only transport; it returns
 * {status, stdout, stderr}. No shell, build, launch, quit, install or writes.
 * The run adapter and returned observation still need external trust validation.
 */
export async function collectMacOSApp({
  bundlePath,
  pid,
  expectedBundleId,
  run = defaultRun,
  platform = process.platform,
} = {}) {
  if (!nonempty(bundlePath) || !isAbsolute(bundlePath) || bundlePath.includes("\0"))
    throw new TypeError("bundlePath must be an absolute path without NUL");
  if (pid !== undefined && (!Number.isSafeInteger(pid) || pid <= 0))
    throw new TypeError("pid must be a positive integer");
  const observation = {
    schema: "delivery-macos-observation/v1",
    collectionStartedAt: new Date().toISOString(),
    observedAt: null,
    platform,
    authorityGranted: false,
    status: "unknown",
    stable: false,
    errors: [],
    installed: {
      bundlePath: null,
      bundleId: null,
      version: null,
      buildVersion: null,
      executablePath: null,
      executableDigest: null,
      signature: { status: "unknown", type: "unknown", teamId: null },
      provenance: { status: "unknown", value: null, digest: null },
    },
    running: {
      status: pid === undefined ? "not_requested" : "unknown",
      pid: pid ?? null,
      executablePath: null,
      processStartIdentity: null,
      stable: false,
      diskIdentityMatches: null,
      executableReplacedAfterStart: null,
    },
  };
  const { errors, installed, running } = observation;
  const finish = () => {
    observation.observedAt = new Date().toISOString();
    if (installed.executableDigest) observation.status = errors.length ? "partial" : "observed";
    return observation;
  };
  if (platform !== "darwin") {
    errors.push("unsupported_platform");
    return finish();
  }
  const call = async (command, args) => {
    try {
      return await run(command, args);
    } catch {
      return { status: null, stdout: "", stderr: "" };
    }
  };
  let firstStat, firstProvenance, firstInfoDigest, infoPath;
  try {
    installed.bundlePath = await realpath(bundlePath);
    infoPath = join(installed.bundlePath, "Contents", "Info.plist");
    if (!beneath(installed.bundlePath, await realpath(infoPath))) {
      errors.push("info_plist_path_escape");
      return finish();
    }
    const infoBytes = await boundedFile(infoPath);
    firstInfoDigest = createHash("sha256").update(infoBytes).digest("hex");
    const parsed = await call("/usr/bin/plutil", ["-convert", "json", "-o", "-", infoPath]);
    if (commandStatus(parsed) !== 0) {
      errors.push("info_plist_unavailable");
      return finish();
    }
    const info = JSON.parse(parsed.stdout);
    installed.bundleId = typeof info.CFBundleIdentifier === "string" ? info.CFBundleIdentifier : null;
    installed.version = typeof info.CFBundleShortVersionString === "string" ? info.CFBundleShortVersionString : null;
    installed.buildVersion = typeof info.CFBundleVersion === "string" ? info.CFBundleVersion : null;
    if (expectedBundleId && installed.bundleId !== expectedBundleId) errors.push("bundle_id_mismatch");
    const name = info.CFBundleExecutable;
    if (!nonempty(name) || name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
      errors.push("invalid_bundle_executable");
      return finish();
    }
    installed.executablePath = await realpath(join(installed.bundlePath, "Contents", "MacOS", name));
    if (!beneath(installed.bundlePath, installed.executablePath)) {
      installed.executablePath = null;
      errors.push("executable_path_escape");
      return finish();
    }
    firstStat = await stat(installed.executablePath);
    if (!firstStat.isFile()) {
      errors.push("executable_not_regular");
      return finish();
    }
    installed.executableDigest = await digestFile(installed.executablePath);
    installed.executableSize = firstStat.size;
    installed.executableInode = String(firstStat.ino);
    installed.executableMtime = firstStat.mtime.toISOString();
    installed.provenance = await readProvenance(installed.bundlePath, errors);
    firstProvenance = installed.provenance.digest;
    const verification = await call("/usr/bin/codesign", ["--verify", "--strict", "--deep", installed.bundlePath]);
    const signature = await call("/usr/bin/codesign", ["-dv", "--verbose=2", installed.bundlePath]);
    installed.signature.status =
      commandStatus(verification) === 0 ? "pass" : commandStatus(verification) === null ? "unknown" : "fail";
    if (commandStatus(signature) === 0) {
      const details = `${signature.stdout ?? ""}\n${signature.stderr ?? ""}`;
      const teamId = /^TeamIdentifier=(.+)$/m.exec(details)?.[1]?.trim();
      installed.signature.teamId = teamId && teamId !== "not set" ? teamId : null;
      installed.signature.type = /^Signature=adhoc$/m.test(details)
        ? "adhoc"
        : /^Authority=/m.test(details)
          ? "identity"
          : "unknown";
    }
    if (installed.signature.status !== "pass") errors.push(`signature_${installed.signature.status}`);
    observation.stable = true;
  } catch {
    errors.push("installed_observation_failed");
    return finish();
  }

  if (pid !== undefined) {
    const startArgs = ["-p", String(pid), "-o", "lstart="];
    const commArgs = ["-ww", "-p", String(pid), "-o", "comm="];
    const firstStart = await call("/bin/ps", startArgs);
    if (commandStatus(firstStart) === 1 && !String(firstStart.stdout ?? "").trim()) running.status = "not_running";
    else if (commandStatus(firstStart) === 0 && String(firstStart.stdout ?? "").trim()) {
      running.processStartIdentity = String(firstStart.stdout).trim();
      const command = await call("/bin/ps", commArgs);
      const path = finalLine(command.stdout);
      if (commandStatus(command) === 0 && isAbsolute(path) && !path.includes("\0")) {
        try {
          running.executablePath = await realpath(path);
        } catch {
          running.executablePath = path;
        }
        const mapped = await call("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "txt", "-F0pfin"]);
        if (commandStatus(mapped) === 0 && String(mapped.stdout).includes("\0")) {
          running.diskIdentityMatches = textFiles(mapped.stdout, pid).some(
            (file) =>
              file.descriptor === "txt" &&
              file.path === installed.executablePath &&
              file.inode === installed.executableInode,
          );
        }
        const afterStart = await call("/bin/ps", startArgs),
          afterCommand = await call("/bin/ps", commArgs);
        running.stable =
          commandStatus(afterStart) === 0 &&
          commandStatus(afterCommand) === 0 &&
          String(afterStart.stdout).trim() === running.processStartIdentity &&
          finalLine(afterCommand.stdout) === path;
        running.status = "observed";
        const startMs = Date.parse(running.processStartIdentity);
        running.executableReplacedAfterStart = Number.isFinite(startMs) ? firstStat.mtimeMs > startMs + 1000 : null;
        if (!running.stable) {
          observation.stable = false;
          errors.push("process_changed_during_observation");
        }
      } else errors.push("process_executable_unavailable");
    } else errors.push("process_observation_failed");
  }

  try {
    const after = await stat(installed.executablePath);
    const afterDigest = await digestFile(installed.executablePath);
    const afterProvenance = await readProvenance(installed.bundlePath, []);
    const afterInfoDigest = createHash("sha256")
      .update(await boundedFile(infoPath))
      .digest("hex");
    const finalSignature = await call("/usr/bin/codesign", ["--verify", "--strict", "--deep", installed.bundlePath]);
    const finalSignatureStatus =
      commandStatus(finalSignature) === 0 ? "pass" : commandStatus(finalSignature) === null ? "unknown" : "fail";
    if (finalSignatureStatus !== installed.signature.status) {
      observation.stable = false;
      errors.push("signature_changed_during_observation");
    }
    installed.signature.status = finalSignatureStatus;
    if (
      after.ino !== firstStat.ino ||
      after.size !== firstStat.size ||
      after.mtimeMs !== firstStat.mtimeMs ||
      afterDigest !== installed.executableDigest ||
      afterProvenance.digest !== firstProvenance ||
      afterInfoDigest !== firstInfoDigest
    ) {
      observation.stable = false;
      errors.push("installed_changed_during_observation");
    }
  } catch {
    observation.stable = false;
    errors.push("installed_changed_during_observation");
  }
  return finish();
}

const stage = () => ({ status: "consistent", reasonCodes: [] });
function mark(part, status, reason) {
  const rank = { consistent: 0, unknown: 1, blocked: 2 };
  if (rank[status] > rank[part.status]) part.status = status;
  if (!part.reasonCodes.includes(reason)) part.reasonCodes.push(reason);
}
function fresh(timestamp, nowMs, maxAgeMs) {
  const captured = Date.parse(timestamp);
  return Number.isFinite(captured) && Number.isFinite(nowMs) && nowMs - captured >= 0 && nowMs - captured <= maxAgeMs;
}

/**
 * Pure consistency comparison, not a release gate. Even all-consistent inputs
 * retain liveVerified=false: raw JSON, expected values and run adapters cannot
 * establish trusted issuers, current authority, locks or accepted release checks.
 */
export function assessMacOSApp(input = {}) {
  let {
    target = {},
    release = {},
    observation = {},
    featureEvidence,
    distributionEvidence,
    now = new Date().toISOString(),
    maxAgeMs = 60_000,
  } = record(input) ? input : {};
  const invalidInput = !record(input) || !record(target) || !record(release) || !record(observation);
  target = record(target) ? target : {};
  release = record(release) ? release : {};
  observation = record(observation) ? observation : {};
  const result = {
    schema: "delivery-macos-assessment/v1",
    authorityGranted: false,
    releaseEligible: false,
    liveVerified: false,
    trust: "not_evaluated",
    requiredTrust: ["build_provenance", "installation_receipt", "runtime_observation", "feature_acceptance"],
    built: stage(),
    installed: stage(),
    running: stage(),
    feature: stage(),
    reasonCodes: [],
    verdict: "unknown",
  };
  const { built, installed, running, feature } = result;
  if (invalidInput)
    for (const part of [built, installed, running, feature]) mark(part, "unknown", "invalid_assessment_input");
  if (observation.schema !== "delivery-macos-observation/v1")
    for (const part of [built, installed, running, feature]) mark(part, "unknown", "observation_schema_unknown");
  const nowMs = now instanceof Date ? now.getTime() : typeof now === "number" ? now : Date.parse(now);
  const observationFresh = Number.isFinite(maxAgeMs) && maxAgeMs > 0 && fresh(observation.observedAt, nowMs, maxAgeMs);
  if (!observationFresh)
    for (const part of [built, installed, running, feature]) mark(part, "unknown", "observation_not_fresh");
  if (Array.isArray(observation.errors) && observation.errors.length)
    for (const part of [built, installed, running, feature]) mark(part, "unknown", "collection_errors_present");
  if (observation.stable !== true)
    for (const part of [built, installed, running, feature]) mark(part, "unknown", "observation_not_stable");
  const app = observation.installed ?? {},
    process = observation.running ?? {},
    provenance = app.provenance ?? {};
  if (provenance.status !== "present" || !provenance.value || typeof provenance.value !== "object") {
    mark(built, provenance.status === "invalid" ? "blocked" : "unknown", "source_provenance_unavailable");
  } else {
    const value = provenance.value;
    if (value.schema !== "delivery-build-provenance/v1") mark(built, "unknown", "provenance_schema_unknown");
    for (const field of [
      "repositoryId",
      "sourceSha",
      "sourceTree",
      "buildId",
      "dependencyLockDigest",
      "toolchain",
      "configuration",
    ]) {
      if (
        value[field] === undefined ||
        release[field] === undefined ||
        value[field] === null ||
        release[field] === null
      )
        mark(built, "unknown", `provenance_${field}_missing`);
      else if (!isDeepStrictEqual(value[field], release[field])) mark(built, "blocked", `provenance_${field}_mismatch`);
    }
    for (const field of ["repositoryId", "buildId", "toolchain", "configuration"]) {
      if (!nonempty(value[field]) || !nonempty(release[field])) mark(built, "unknown", `provenance_${field}_invalid`);
    }
    if (!DIGEST.test(value.dependencyLockDigest ?? "") || !DIGEST.test(release.dependencyLockDigest ?? ""))
      mark(built, "unknown", "dependency_lock_digest_invalid");
    if (!COMMIT.test(release.sourceSha ?? "") || !COMMIT.test(release.sourceTree ?? ""))
      mark(built, "unknown", "release_source_identity_invalid");
    if (value.dirty === true || release.dirty === true) mark(built, "blocked", "dirty_build");
    else if (value.dirty !== false || release.dirty !== false) mark(built, "unknown", "clean_source_not_proven");
    if (!DIGEST.test(release.provenanceDigest ?? "") || !DIGEST.test(provenance.digest ?? ""))
      mark(built, "unknown", "provenance_digest_missing");
    else if (release.provenanceDigest !== provenance.digest) mark(built, "blocked", "provenance_digest_mismatch");
  }

  for (const field of ["bundlePath", "bundleId"]) {
    if (!nonempty(target[field]) || !nonempty(app[field])) mark(installed, "unknown", `${field}_unavailable`);
    else if (target[field] !== app[field]) mark(installed, "blocked", `${field}_mismatch`);
  }
  if (
    !nonempty(app.bundlePath) ||
    !nonempty(target.bundlePath) ||
    !isAbsolute(app.bundlePath) ||
    !isAbsolute(target.bundlePath)
  )
    mark(installed, "unknown", "bundle_path_invalid");
  if (
    nonempty(app.executablePath) &&
    nonempty(app.bundlePath) &&
    !beneath(join(app.bundlePath, "Contents", "MacOS"), app.executablePath)
  )
    mark(installed, "blocked", "installed_executable_path_escape");
  if (!DIGEST.test(release.executableDigest ?? "") || !DIGEST.test(app.executableDigest ?? ""))
    mark(installed, "unknown", "executable_digest_missing");
  else if (release.executableDigest !== app.executableDigest) mark(installed, "blocked", "executable_digest_mismatch");
  if (app.signature?.status === "fail") mark(installed, "blocked", "signature_invalid");
  else if (app.signature?.status !== "pass") mark(installed, "unknown", "signature_unverified");
  const channel = target.distribution;
  if (!["local-development", "external-distribution", "app-store"].includes(channel))
    mark(installed, "unknown", "distribution_policy_unknown");
  if (channel === "local-development" && !["identity", "adhoc"].includes(app.signature?.type))
    mark(installed, "unknown", "signing_identity_unknown");
  if (["external-distribution", "app-store"].includes(channel)) {
    if (app.signature?.type === "adhoc") mark(installed, "blocked", "adhoc_not_distributable");
    else if (app.signature?.type !== "identity" || !nonempty(app.signature.teamId))
      mark(installed, "unknown", "distribution_signer_unverified");
    const kind = channel === "external-distribution" ? "notarization" : "app-store-receipt";
    if (!distributionEvidence || distributionEvidence.kind !== kind || distributionEvidence.status !== "pass")
      mark(installed, distributionEvidence?.status === "fail" ? "blocked" : "unknown", `${kind}_unverified`);
    else if (distributionEvidence.executableDigest !== app.executableDigest)
      mark(installed, "blocked", "distribution_evidence_artifact_mismatch");
    else if (!fresh(distributionEvidence.observedAt, nowMs, maxAgeMs))
      mark(installed, "unknown", "distribution_evidence_not_fresh");
  }
  if (target.teamId && target.teamId !== app.signature?.teamId) mark(installed, "blocked", "signer_team_mismatch");

  if (process.status === "not_running") mark(running, "blocked", "process_not_running");
  else if (process.status !== "observed") mark(running, "unknown", "process_unobserved");
  if (process.stable !== true) mark(running, "unknown", "process_identity_not_stable");
  if (!nonempty(process.executablePath) || !nonempty(app.executablePath))
    mark(running, "unknown", "process_executable_unavailable");
  else if (process.executablePath !== app.executablePath) mark(running, "blocked", "running_path_mismatch");
  if (process.diskIdentityMatches === false) mark(running, "blocked", "process_executable_inode_mismatch");
  else if (process.diskIdentityMatches !== true) mark(running, "unknown", "process_executable_inode_unverified");
  if (process.executableReplacedAfterStart === true) mark(running, "blocked", "executable_replaced_after_start");
  else if (process.executableReplacedAfterStart !== false) mark(running, "unknown", "process_start_comparison_unknown");
  if (!Number.isSafeInteger(process.pid) || process.pid <= 0 || !nonempty(process.processStartIdentity))
    mark(running, "unknown", "process_identity_incomplete");

  if (!featureEvidence) mark(feature, "unknown", "feature_acceptance_missing");
  else {
    if (featureEvidence.status === "fail") mark(feature, "blocked", "feature_acceptance_failed");
    else if (featureEvidence.status !== "pass") mark(feature, "unknown", "feature_acceptance_not_passed");
    if (featureEvidence.featureEnabled === false) mark(feature, "blocked", "feature_disabled");
    else if (featureEvidence.featureEnabled !== true) mark(feature, "unknown", "feature_flag_unknown");
    if (featureEvidence.fixtureIsHarmless === false) mark(feature, "blocked", "unsafe_feature_fixture");
    else if (featureEvidence.fixtureIsHarmless !== true || !nonempty(featureEvidence.fixtureId))
      mark(feature, "unknown", "feature_fixture_missing");
    for (const [field, expected] of [
      ["targetId", target.id],
      ["executableDigest", app.executableDigest],
      ["sourceSha", release.sourceSha],
      ["pid", process.pid],
      ["processStartIdentity", process.processStartIdentity],
    ]) {
      if (
        expected === undefined ||
        expected === null ||
        featureEvidence[field] === undefined ||
        featureEvidence[field] === null
      )
        mark(feature, "unknown", `feature_${field}_unavailable`);
      else if (featureEvidence[field] !== expected) mark(feature, "blocked", `feature_${field}_mismatch`);
    }
    if (!fresh(featureEvidence.observedAt, nowMs, maxAgeMs)) mark(feature, "unknown", "feature_acceptance_not_fresh");
  }
  if (built.status !== "consistent") mark(installed, "unknown", "build_identity_not_consistent");
  if (installed.status !== "consistent") mark(running, "unknown", "installed_identity_not_consistent");
  if (running.status !== "consistent") mark(feature, "unknown", "runtime_identity_not_consistent");
  const stages = [built, installed, running, feature];
  result.reasonCodes = [...new Set(stages.flatMap((part) => part.reasonCodes))];
  result.verdict = stages.some((part) => part.status === "blocked")
    ? "blocked"
    : stages.some((part) => part.status === "unknown")
      ? "unknown"
      : "consistent_unattested";
  return result;
}
