import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

let adapter = {};
try {
  adapter = await import("./adapters/macos-app.mjs");
} catch (error) {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
}
const collect = (...args) => {
  assert.equal(typeof adapter.collectMacOSApp, "function", "read-only macOS collector is implemented");
  return adapter.collectMacOSApp(...args);
};
const assess = (...args) => {
  assert.equal(typeof adapter.assessMacOSApp, "function", "macOS evidence comparison is implemented");
  return adapter.assessMacOSApp(...args);
};
const SHA = "a".repeat(40),
  TREE = "b".repeat(40);
const EXE = "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const MANIFEST = `sha256:${"c".repeat(64)}`;
const NOW = "2026-11-16T20:00:00.000Z";
const START = "Mon Nov 16 14:00:00 2026";
const manifest = () => ({
  schema: "delivery-build-provenance/v1",
  repositoryId: "123",
  sourceSha: SHA,
  sourceTree: TREE,
  dirty: false,
  buildId: "build-1",
  dependencyLockDigest: `sha256:${"d".repeat(64)}`,
  toolchain: "Apple Swift 6.2",
  configuration: "Release",
});

async function fixture(t, options = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "guardian-macos-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bundlePath = join(dir, "File Room 樂譜.app");
  const exe = join(bundlePath, "Contents", "MacOS", "Fileroom");
  const resources = join(bundlePath, "Contents", "Resources");
  await mkdir(resources, { recursive: true });
  await mkdir(join(bundlePath, "Contents", "MacOS"), { recursive: true });
  await writeFile(exe, "abc");
  await utimes(exe, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));
  await writeFile(join(bundlePath, "Contents", "Info.plist"), "fixture plist parsed by OS boundary");
  if (options.provenance !== false)
    await writeFile(join(resources, "DeliveryProvenance.json"), JSON.stringify(manifest()));
  const inode = String((await stat(exe)).ino);
  let psReads = 0,
    signatureReads = 0;
  const run = async (command, args) => {
    assert.ok(Array.isArray(args), "commands use argv, never a shell expression");
    if (command === "/usr/bin/plutil") {
      assert.deepEqual(args, ["-convert", "json", "-o", "-", join(bundlePath, "Contents", "Info.plist")]);
      return {
        status: 0,
        stdout: JSON.stringify({
          CFBundleIdentifier: "app.fileroom.Fileroom",
          CFBundleExecutable: options.executableName ?? "Fileroom",
          CFBundleVersion: "1",
          CFBundleShortVersionString: "1.0",
        }),
        stderr: "",
      };
    }
    if (command === "/usr/bin/codesign") {
      if (args[0] === "--verify") {
        signatureReads++;
        assert.deepEqual(args, ["--verify", "--strict", "--deep", bundlePath]);
        if (options.replaceDuringObservation) await writeFile(exe, "changed executable");
        if (options.changePlistDuringObservation)
          await writeFile(join(bundlePath, "Contents", "Info.plist"), "changed plist metadata");
        return {
          status:
            options.signatureFailure || (options.invalidateSignatureAfterFirstCheck && signatureReads > 1) ? 1 : 0,
          stdout: "",
          stderr: "",
        };
      }
      assert.deepEqual(args, ["-dv", "--verbose=2", bundlePath]);
      return {
        status: 0,
        stdout: "",
        stderr: "Identifier=app.fileroom.Fileroom\nSignature=adhoc\nTeamIdentifier=not set\n",
      };
    }
    if (command === "/bin/ps") {
      assert.equal(args[args.indexOf("-p") + 1], "42");
      if (options.processUnavailable) return { status: 1, stdout: "", stderr: "" };
      if (args.at(-1) === "lstart=") {
        psReads++;
        return {
          status: 0,
          stdout: `${options.reusedPid && psReads > 1 ? "Tue Nov 17 15:00:00 2026" : "Tue Nov 17 14:00:00 2026"}\n`,
          stderr: "",
        };
      }
      assert.equal(args.at(-1), "comm=");
      return { status: 0, stdout: `${options.runningPath ?? exe}\n`, stderr: "" };
    }
    if (command === "/usr/sbin/lsof") {
      assert.deepEqual(args, ["-a", "-p", "42", "-d", "txt", "-F0pfin"]);
      return {
        status: 0,
        stdout: `p42\0\nftxt\0i${options.wrongInode ? "1" : inode}\0n${options.runningPath ?? exe}\0\n`,
        stderr: "",
      };
    }
    assert.fail(`Unexpected command: ${command}`);
  };
  return { bundlePath, exe, resources, run };
}

function healthy() {
  const bundlePath = "/Applications/Fileroom.app";
  const target = {
    id: "fileroom-local",
    bundlePath,
    bundleId: "app.fileroom.Fileroom",
    distribution: "local-development",
  };
  const release = { ...manifest(), executableDigest: EXE, provenanceDigest: MANIFEST };
  const observation = {
    schema: "delivery-macos-observation/v1",
    observedAt: NOW,
    status: "observed",
    stable: true,
    authorityGranted: false,
    errors: [],
    installed: {
      bundlePath,
      bundleId: target.bundleId,
      executablePath: `${bundlePath}/Contents/MacOS/Fileroom`,
      executableDigest: EXE,
      signature: { status: "pass", type: "adhoc", teamId: null },
      provenance: { status: "present", digest: MANIFEST, value: manifest() },
    },
    running: {
      status: "observed",
      pid: 42,
      executablePath: `${bundlePath}/Contents/MacOS/Fileroom`,
      processStartIdentity: START,
      stable: true,
      diskIdentityMatches: true,
      executableReplacedAfterStart: false,
    },
  };
  const featureEvidence = {
    status: "pass",
    targetId: target.id,
    fixtureId: "synthetic-programme.pdf",
    fixtureIsHarmless: true,
    executableDigest: EXE,
    sourceSha: SHA,
    pid: 42,
    processStartIdentity: START,
    observedAt: NOW,
    featureEnabled: true,
  };
  return { target, release, observation, featureEvidence, now: NOW };
}

test("collector reports unsupported hosts without executing commands", async () => {
  const result = await collect({
    bundlePath: "/Applications/Fileroom.app",
    platform: "linux",
    run: () => assert.fail("no command"),
  });
  assert.equal(result.status, "unknown");
  assert.ok(result.errors.includes("unsupported_platform"));
  assert.equal(result.authorityGranted, false);
});

test("collector rejects relative paths and injectable PID values before observation", async () => {
  await assert.rejects(() => collect({ bundlePath: "Fileroom.app", platform: "darwin" }), /absolute/i);
  await assert.rejects(
    () => collect({ bundlePath: "/Applications/Fileroom.app", pid: "42; touch stolen", platform: "darwin" }),
    /pid/i,
  );
});

test("collector hashes real executable bytes and reads metadata through read-only argv tools", async (t) => {
  const f = await fixture(t);
  const result = await collect({ ...f, pid: 42, expectedBundleId: "app.fileroom.Fileroom", platform: "darwin" });
  assert.equal(result.status, "observed");
  assert.equal(result.installed.executableDigest, EXE);
  assert.equal(result.installed.provenance.value.sourceSha, SHA);
  assert.equal(result.installed.signature.type, "adhoc");
  assert.equal(result.running.diskIdentityMatches, true);
  assert.equal(result.authorityGranted, false);
  assert.equal(await readFile(f.exe, "utf8"), "abc");
});

test("collector never derives a source commit from build version or file timestamp", async (t) => {
  const f = await fixture(t, { provenance: false });
  const result = await collect({ ...f, pid: 42, platform: "darwin" });
  assert.equal(result.installed.provenance.status, "missing");
  assert.equal(result.installed.provenance.value, null);
  assert.equal(result.installed.buildVersion, "1");
  assert.ok(result.errors.includes("provenance_missing"));
});

test("collector keeps signature failure distinct from an absent provenance file", async (t) => {
  const f = await fixture(t, { signatureFailure: true });
  const result = await collect({ ...f, pid: 42, platform: "darwin" });
  assert.equal(result.installed.signature.status, "fail");
  assert.equal(result.installed.provenance.status, "present");
});

test("collector rejects an executable path escaping the app bundle", async (t) => {
  const f = await fixture(t, { executableName: "../../outside" });
  const result = await collect({ ...f, platform: "darwin" });
  assert.ok(result.errors.includes("invalid_bundle_executable"));
  assert.equal(result.installed.executableDigest, null);
});

test("collector refuses a provenance symlink that reads outside the app", async (t) => {
  const f = await fixture(t, { provenance: false });
  const external = join(f.bundlePath, "..", "outside.json");
  await writeFile(external, JSON.stringify(manifest()));
  await symlink(external, join(f.resources, "DeliveryProvenance.json"));
  const result = await collect({ ...f, platform: "darwin" });
  assert.equal(result.installed.provenance.status, "invalid");
  assert.ok(result.errors.includes("provenance_path_escape"));
});

test("collector detects an old mapped executable inode at the same path", async (t) => {
  const f = await fixture(t, { wrongInode: true });
  const result = await collect({ ...f, pid: 42, platform: "darwin" });
  assert.equal(result.running.diskIdentityMatches, false);
});

test("collector detects PID reuse during its observation", async (t) => {
  const f = await fixture(t, { reusedPid: true });
  const result = await collect({ ...f, pid: 42, platform: "darwin" });
  assert.equal(result.running.stable, false);
  assert.equal(result.stable, false);
});

test("collector records a disappeared process as not running", async (t) => {
  const f = await fixture(t, { processUnavailable: true });
  const result = await collect({ ...f, pid: 42, platform: "darwin" });
  assert.equal(result.running.status, "not_running");
});

test("collector detects executable replacement while signatures are checked", async (t) => {
  const f = await fixture(t, { replaceDuringObservation: true });
  const result = await collect({ ...f, pid: 42, platform: "darwin" });
  assert.equal(result.stable, false);
  assert.ok(result.errors.includes("installed_changed_during_observation"));
});

test("collector detects Info.plist changes during observation", async (t) => {
  const f = await fixture(t, { changePlistDuringObservation: true });
  const result = await collect({ ...f, pid: 42, platform: "darwin" });
  assert.equal(result.stable, false);
  assert.ok(result.errors.includes("installed_changed_during_observation"));
});

test("collector rechecks signature validity after observing runtime", async (t) => {
  const f = await fixture(t, { invalidateSignatureAfterFirstCheck: true });
  const result = await collect({ ...f, pid: 42, platform: "darwin" });
  assert.equal(result.installed.signature.status, "fail");
  assert.equal(result.stable, false);
});

test("matching local-development observations are consistent but never grant release authority", () => {
  const result = assess(healthy());
  assert.equal(result.verdict, "consistent_unattested");
  for (const stage of ["built", "installed", "running", "feature"]) assert.equal(result[stage].status, "consistent");
  assert.equal(result.authorityGranted, false);
  assert.equal(result.liveVerified, false);
  assert.equal(result.releaseEligible, false);
  assert.ok(result.requiredTrust.includes("build_provenance"));
});

test("self-declared trusted flags cannot elevate a matching JSON manifest", () => {
  const f = healthy();
  f.release.trusted = true;
  f.observation.trusted = true;
  f.featureEvidence.trusted = true;
  const result = assess(f);
  assert.equal(result.verdict, "consistent_unattested");
  assert.equal(result.liveVerified, false);
  assert.equal(result.authorityGranted, false);
});

test("missing source provenance remains unknown even with matching version and executable", () => {
  const f = healthy();
  f.observation.installed.provenance = { status: "missing", value: null };
  const result = assess(f);
  assert.equal(result.built.status, "unknown");
  assert.equal(result.verdict, "unknown");
});

test("an edited manifest is blocked when its content digest differs from the release", () => {
  const f = healthy();
  f.observation.installed.provenance.digest = `sha256:${"e".repeat(64)}`;
  const result = assess(f);
  assert.equal(result.built.status, "blocked");
  assert.ok(result.reasonCodes.includes("provenance_digest_mismatch"));
});

for (const field of [
  "sourceSha",
  "sourceTree",
  "repositoryId",
  "buildId",
  "dependencyLockDigest",
  "toolchain",
  "configuration",
]) {
  test(`different ${field} cannot be treated as the intended build`, () => {
    const f = healthy();
    f.observation.installed.provenance.value[field] = "different";
    const result = assess(f);
    assert.equal(result.built.status, "blocked");
    assert.ok(result.reasonCodes.includes(`provenance_${field}_mismatch`));
  });
}

test("a dirty build cannot satisfy the release identity", () => {
  const f = healthy();
  f.observation.installed.provenance.value.dirty = true;
  assert.equal(assess(f).built.status, "blocked");
});

test("empty metadata fields and malformed lock digests never qualify as a known build", () => {
  for (const [field, value] of [
    ["repositoryId", ""],
    ["buildId", ""],
    ["toolchain", ""],
    ["configuration", ""],
    ["dependencyLockDigest", "same-nondigest"],
  ]) {
    const f = healthy();
    f.release[field] = value;
    f.observation.installed.provenance.value[field] = value;
    assert.equal(assess(f).built.status, "unknown", field);
  }
});

test("a matching process outside the bundle cannot satisfy an installed app identity", () => {
  const f = healthy();
  f.observation.installed.executablePath = "/tmp/outside";
  f.observation.running.executablePath = "/tmp/outside";
  assert.equal(assess(f).installed.status, "blocked");
});

test("stale or future runtime observations never yield a current consistent verdict", () => {
  for (const timestamp of ["2026-11-16T19:58:59Z", "2026-11-16T20:00:30Z", "bad-date"]) {
    const f = healthy();
    f.observation.observedAt = timestamp;
    assert.equal(assess(f).verdict, "unknown");
  }
});

test("the same bundle ID installed at another path is blocked", () => {
  const f = healthy();
  f.observation.installed.bundlePath = "/tmp/old/Fileroom.app";
  assert.equal(assess(f).installed.status, "blocked");
});

test("an old process path cannot stand in for the current installed app", () => {
  const f = healthy();
  f.observation.running.executablePath = "/tmp/old/Fileroom.app/Contents/MacOS/Fileroom";
  assert.equal(assess(f).running.status, "blocked");
});

test("a process retaining the previous executable inode is blocked", () => {
  const f = healthy();
  f.observation.running.diskIdentityMatches = false;
  assert.equal(assess(f).running.status, "blocked");
});

test("a disk executable replaced after process startup is blocked", () => {
  const f = healthy();
  f.observation.running.executableReplacedAfterStart = true;
  assert.equal(assess(f).running.status, "blocked");
});

test("a disabled feature cannot pass even on the expected executable", () => {
  const f = healthy();
  f.featureEvidence.featureEnabled = false;
  assert.equal(assess(f).feature.status, "blocked");
});

test("a missing fixture acceptance remains unknown", () => {
  const f = healthy();
  delete f.featureEvidence;
  assert.equal(assess(f).feature.status, "unknown");
});

test("an unsafe fixture is blocked", () => {
  const f = healthy();
  f.featureEvidence.fixtureIsHarmless = false;
  assert.equal(assess(f).feature.status, "blocked");
});

for (const [field, value] of [
  ["pid", 43],
  ["processStartIdentity", "another process"],
  ["executableDigest", `sha256:${"f".repeat(64)}`],
  ["sourceSha", "c".repeat(40)],
  ["targetId", "other-target"],
]) {
  test(`feature acceptance bound to a different ${field} is blocked`, () => {
    const f = healthy();
    f.featureEvidence[field] = value;
    assert.equal(assess(f).feature.status, "blocked");
  });
}

test("expired feature acceptance is not reused as fresh live evidence", () => {
  const f = healthy();
  f.featureEvidence.observedAt = "2026-11-16T19:58:00Z";
  assert.equal(assess(f).feature.status, "unknown");
});

test("ad-hoc local signing cannot satisfy external distribution policy", () => {
  const f = healthy();
  f.target.distribution = "external-distribution";
  assert.equal(assess(f).installed.status, "blocked");
});

test("external distribution with identity signing still requires notarization evidence", () => {
  const f = healthy();
  f.target.distribution = "external-distribution";
  f.observation.installed.signature = { status: "pass", type: "identity", teamId: "TEAM" };
  assert.equal(assess(f).installed.status, "unknown");
});

test("App Store distribution requires receipt evidence bound to this executable", () => {
  const f = healthy();
  f.target.distribution = "app-store";
  f.observation.installed.signature = { status: "pass", type: "identity", teamId: "TEAM" };
  assert.equal(assess(f).installed.status, "unknown");
});

test("failed signature verification blocks an otherwise matching app", () => {
  const f = healthy();
  f.observation.installed.signature.status = "fail";
  assert.equal(assess(f).installed.status, "blocked");
});

test("pure assessment does not alter either the observation or release inputs", () => {
  const f = healthy(),
    before = structuredClone(f);
  assess(f);
  assert.deepEqual(f, before);
});

test("macOS collector errors prevent otherwise matching JSON from looking consistent", () => {
  const f = healthy();
  f.observation.errors = ["process_observation_failed"];
  assert.equal(assess(f).verdict, "unknown");
});

test("an unknown macOS observation schema remains unknown", () => {
  const f = healthy();
  f.observation.schema = "unexpected/v9";
  assert.equal(assess(f).verdict, "unknown");
});

test("a one-millisecond future macOS observation or fixture is not current evidence", () => {
  for (const subject of ["observation", "featureEvidence"]) {
    const f = healthy();
    f[subject].observedAt = "2026-11-16T20:00:00.001Z";
    assert.equal(assess(f).verdict, "unknown", subject);
  }
});

test("null macOS assessment objects return unknown instead of interrupting reconciliation", () => {
  for (const subject of ["target", "release", "observation"]) {
    const f = healthy();
    f[subject] = null;
    assert.equal(assess(f).verdict, "unknown", subject);
  }
  assert.equal(assess(null).verdict, "unknown");
});

test("non-string nested macOS paths remain unknown without a path-library exception", () => {
  for (const subject of ["target", "installed"])
    for (const value of [123, {}, []]) {
      const f = healthy();
      (subject === "target" ? f.target : f.observation.installed).bundlePath = value;
      assert.equal(assess(f).verdict, "unknown");
    }
});
