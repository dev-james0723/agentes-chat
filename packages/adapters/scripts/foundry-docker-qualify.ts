/** Explicit operator-only qualification. Runs fixed reviewed infrastructure
 * probes, not applicant programs. It never mutates native grants/tasks or
 * activates a tool. Every required attestation maps to checked observations. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDockerFoundryRunner, createFoundryDockerCli, FoundryDockerLedger,
  foundryDockerModuleFromBundle, readFoundryDockerPlatform, type FoundryDockerModule,
  type FoundryDockerControl } from "../src/foundry-docker-runner";
import { probeFoundryDockerRuntime, type FoundryDockerProbeEvidence } from "../src/foundry-docker-probes";
import { protectedFoundryEvaluatorIdentity } from "../src/foundry-protected-evaluator";
import { FOUNDRY_PURE_TOOL_LIMITS, FOUNDRY_REQUIRED_PROBES, hashFoundryInput,
  hashFoundryRuntimeProfile, type FoundryAdmission, type FoundryRunnerExecutionRequest,
  type FoundryProbeAttestation, type TrustedFoundryRunner } from "../src/foundry-executor";

const [configurationPath, destination] = process.argv.slice(2);
if (!configurationPath || !destination) throw new Error("Expected operator config and NEW private output directory");
await mkdir(destination, { mode: 0o700 });
await chmod(destination, 0o700);
const config = JSON.parse(await readFile(configurationPath, "utf8"));
const raw = createFoundryDockerCli(config.transport);
const limits = { ...FOUNDRY_PURE_TOOL_LIMITS, ...config.limits };
const platform = await readFoundryDockerPlatform(raw);
const architecture = ["aarch64", "arm64"].includes(platform.architecture) ? "arm64" : "x64";
const controlEvents: { command: string; container?: string }[] = [];
const docker: FoundryDockerControl = { async run(args, bounds) {
  controlEvents.push({ command: args[0]!, ...(args[0] === "start" ? { container: args.at(-1)! } : {}) });
  return raw.run(args, bounds);
} };
const observations: FoundryDockerProbeEvidence[] = [];
const names = ["identity", "isolation", "abi", "scratchWrite", "scratchFresh", "cpu", "wall", "memory", "output", "stderrOutput", "watchdogAfterClientLoss"] as const;
for (const name of names) {
  const observed = await probeFoundryDockerRuntime(docker, { imageId: config.imageId, seccompPath: config.seccompPath, limits }, name);
  observations.push(observed);
  await writeFile(join(destination, "observations.json"), JSON.stringify(observations, null, 2), { mode: 0o600 });
  assert.equal(observed.status, "OBSERVED", name); assert(observed.created && observed.removed, `${name}: container termination not verified`);
  console.log(JSON.stringify({ probe: name, observed: true, exitCode: observed.exitCode, terminated: observed.removed }));
}
const byName = Object.fromEntries(observations.map(x => [x.probe, x]));
const identity = JSON.parse(byName.identity!.stdout);
assert.equal(identity.uid, 65532); assert.equal(identity.gid, 65532); assert.equal(identity.arch, architecture);
for (const name of ["CapEff:", "CapPrm:", "CapBnd:", "CapAmb:"]) assert(identity.status.some((s: string) => new RegExp(`^${name}\\s+0+$`).test(s)));
assert(identity.status.some((s: string) => /^NoNewPrivs:\s+1$/.test(s)));
assert(identity.status.some((s: string) => /^Seccomp:\s+2$/.test(s)));
assert.equal(Number(identity.memoryMax), limits.memoryBytes); assert.equal(Number(identity.swapMax), 0);
assert.equal(Number(identity.pidsMax), limits.maxProcesses); assert.equal(identity.cpuMax.trim(), "100000 100000");
assert(identity.limits.includes(`Max cpu time`));
assert.deepEqual(Object.keys(identity.env).sort(), ["BUN_INSTALL_CACHE_DIR", "HOME", "LANG", "PATH", "TMPDIR"].sort());
assert(!/docker\.sock|\/host\/|\/Users\//.test(identity.mounts));
const isolation = JSON.parse(byName.isolation!.stdout);
for (const name of ["rootWrite", "dockerSocket", "hostHome", "rootCredentials", "watchdogMemory", "watchdogSignal", "fork", "network", "dns", "metadata"])
  assert(isolation[name] && !["UNEXPECTED_SUCCESS", "TIMEOUT"].includes(isolation[name]), `${name}: not denied`);
assert.equal(JSON.parse(byName.abi!.stdout).echo, "fixed-infrastructure-abi");
const scratch = JSON.parse(byName.scratchWrite!.stdout);
assert.equal(scratch.code, "ENOSPC"); assert(scratch.bytes <= limits.scratchBytes);
assert.equal(JSON.parse(byName.scratchFresh!.stdout).markerPresent, false);
assert(byName.cpu!.exitCode !== 0 && byName.cpu!.elapsedMs <= limits.wallTimeMs);
assert(byName.wall!.exitCode !== 0 && byName.wall!.elapsedMs <= limits.wallTimeMs + 3000);
assert(byName.memory!.exitCode !== 0);
assert(byName.output!.captureExceeded && Buffer.byteLength(byName.output!.stdout) <= limits.stdoutBytes);
assert(byName.stderrOutput!.captureExceeded && Buffer.byteLength(byName.stderrOutput!.stderr) <= limits.stderrBytes);
assert.equal(JSON.parse(byName.watchdogAfterClientLoss!.stateAfterClientLoss!).running, true);
assert.equal(JSON.parse(byName.watchdogAfterClientLoss!.stateAfterDeadline!).running, false);

// Fixed infrastructure ABI fixtures. These are never received from a builder.
const modules = new Map<string, FoundryDockerModule>();
function fixedModule(code: string) {
  const content = { manifest: { fixedInfrastructureProbe: true },
    inventory: [{ path: "tool.mjs", sha256: createHash("sha256").update(code).digest("hex"), bytes: Buffer.byteLength(code) }],
    files: [{ path: "tool.mjs", base64: Buffer.from(code).toString("base64") }] };
  const digest = hashFoundryInput({ manifest: content.manifest, inventory: content.inventory });
  const m = foundryDockerModuleFromBundle("operator-probe-a", digest, content); modules.set(digest, m); return m;
}
const echo = fixedModule('export const normalizeReceiptJson = input => JSON.stringify(JSON.parse(input));');
const waiting = fixedModule('export async function normalizeReceiptJson(input) { await new Promise(() => {}); }');
const admitted = new Set<string>();
const evaluator: Pick<TrustedFoundryRunner, "evaluate" | "cancelEvaluation" | "reconcileEvaluation"> = {
  async evaluate() { throw new Error("Infrastructure probes cannot evaluate applicants"); },
  async cancelEvaluation(job) { return { outcome: "UNKNOWN_OUTCOME", evaluatorJobRef: job, receiptRef: null, reconciliationRef: job }; },
  async reconcileEvaluation(job) { return { outcome: "UNKNOWN_OUTCOME", evaluatorJobRef: job, receiptRef: null, reconciliationRef: job }; },
};
const filename = join(destination, "probe-ledger.sqlite"); let ledger = new FoundryDockerLedger(filename);
const settings = { docker, runnerId: "foundry-docker-pure-v1", profileRef: "pure-offline-v1", imageId: config.imageId,
  architecture, platform, limits, seccompPath: config.seccompPath, evaluator, evaluatorIdentity: protectedFoundryEvaluatorIdentity(),
  resolvePackage: async (org: string, digest: string) => {
    assert.equal(org, "operator-probe-a"); const m = modules.get(digest); assert(m); return m;
  },
  authorize: async (r: FoundryRunnerExecutionRequest) => r.orgId === "operator-probe-a" && admitted.has(r.invocationId)
    && r.nativeDecisionRef === "fixed-operator-probe" && r.budgetReservationRef === r.invocationId,
} as const;
let runner = createDockerFoundryRunner({ ...settings, ledger });
const profile = await runner.currentProfile();
const pin: FoundryAdmission = { runnerId: profile.runnerId, profileRef: profile.profileRef,
  runtimeDigest: profile.runtimeDigest, configurationDigest: profile.configurationDigest,
  profileDigest: hashFoundryRuntimeProfile(profile), attestationRef: "OPERATOR-INFRA-PROBE-ONLY-NOT-ACTIVATION",
  expiresAt: new Date(Date.now() + 600000).toISOString(), limits };
function request(id: string, m = echo): FoundryRunnerExecutionRequest {
  admitted.add(id); const inputJson = '{"records":[]}';
  return { orgId: "operator-probe-a", digest: m.packageDigest, inputJson, inputDigest: hashFoundryInput(JSON.parse(inputJson)),
    invocationId: id, fencingToken: 1, nativeDecisionRef: "fixed-operator-probe", budgetReservationRef: id, abort: new AbortController().signal };
}
const first = await runner.execute(request("echo"), pin); assert.equal(first.outcome, "SUCCEEDED");
assert.equal((await runner.cancel("before-dispatch", 1)).outcome, "CANCELLED");
ledger.close(); ledger = new FoundryDockerLedger(filename); runner = createDockerFoundryRunner({ ...settings, ledger });
let creates = controlEvents.filter(x => x.command === "create").length;
assert.notEqual((await runner.execute(request("before-dispatch"), pin)).outcome, "SUCCEEDED");
assert.equal(controlEvents.filter(x => x.command === "create").length, creates);
const running = runner.execute(request("in-flight", waiting), pin);
let observedRunning = false;
for (let i = 0; i < 30 && !observedRunning; i++) {
  const id = ledger.read("in-flight")?.containerId;
  if (id) {
    const s = await docker.run(["inspect", "--format", "{{.State.Running}}", id], { timeoutMs: 1000, stdoutBytes: 128, stderrBytes: 1024 });
    observedRunning = s.exitCode === 0 && s.stdout.trim() === "true";
  }
  if (!observedRunning) await new Promise(resolve => setTimeout(resolve, 50));
}
assert(observedRunning, "No live candidate tree observed before cancellation");
const cancellation = await runner.cancel("in-flight", 1);
assert.equal(cancellation.outcome, "CANCELLED"); assert.equal(cancellation.processTreeTerminated, true);
await running;
creates = controlEvents.filter(x => x.command === "create").length;
for (const r of [{ ...request("foreign"), orgId: "operator-probe-b" },
  { ...request("bad-input"), inputDigest: "0".repeat(64) },
  { ...request("too-large"), inputJson: JSON.stringify({ text: "x".repeat(limits.inputBytes) }) }]) {
  await runner.execute(r, pin).catch(() => undefined);
}
assert.equal(controlEvents.filter(x => x.command === "create").length, creates);
ledger.close();
const rawEvidence = { schema: "foundry-operator-observations/1", observedAt: new Date().toISOString(), profile,
  observations, additional: { cancelBeforeDispatchAfterRestart: true, observedLiveTreeCancelled: true,
    foreignTenantAndChangedOrOversizedInputCreatedZeroContainers: true, controlEvents } };
const evidenceDigest = hashFoundryInput({ profile, observations: observations.map(x => ({ probe: x.probe, containerId: x.containerId,
  digest: createHash("sha256").update(JSON.stringify(x)).digest("hex") })), additional: rawEvidence.additional });
await writeFile(join(destination, "verified-observations.json"), JSON.stringify(rawEvidence, null, 2), { mode: 0o600 });
const testedAt = new Date().toISOString();
const attestation: FoundryProbeAttestation = { attestationRef: `foundry-operator/${evidenceDigest}`, authorityId: "foundry-operator-probes/v1",
  runnerId: profile.runnerId, runtimeDigest: profile.runtimeDigest, profileDigest: pin.profileDigest, testedAt,
  expiresAt: new Date(Date.now() + 4 * 3600000).toISOString(), revoked: false,
  probes: FOUNDRY_REQUIRED_PROBES.map(name => ({ name, outcome: "PASS", evidenceRef: `foundry-observations/${evidenceDigest}#${name}` })) };
const proofFile = join(destination, "qualification.json");
await writeFile(proofFile, JSON.stringify({ schema: "foundry-qualification/1", attestation }, null, 2), { mode: 0o600, flag: "wx" });
const runtime = { ...config, limits, platform, architecture, runnerId: profile.runnerId, profileRef: profile.profileRef,
  evaluatorIdentity: protectedFoundryEvaluatorIdentity(), authorityId: attestation.authorityId, qualificationFile: proofFile };
await writeFile(join(destination, "runtime-config.json"), JSON.stringify(runtime, null, 2), { mode: 0o600, flag: "wx" });
console.log(JSON.stringify({ qualifiedByOperatorProbes: true, profileDigest: pin.profileDigest, evidenceDigest,
  expiresAt: attestation.expiresAt, runtimeConfig: join(destination, "runtime-config.json") }));
