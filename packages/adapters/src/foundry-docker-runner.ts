import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { FOUNDRY_DOCKER_BOOTSTRAP, FOUNDRY_DOCKER_SECCOMP, foundryDockerChildFilter } from "./foundry-docker-bootstrap";
import {
  FOUNDRY_PURE_TOOL_LIMITS,
  FOUNDRY_REQUIRED_GUARANTEES,
  type FoundryAdmission,
  type FoundryCancellationResult,
  type FoundryExecutionReceipt,
  type FoundryExecutionResult,
  FoundryExecutorError,
  type FoundryLimits,
  type FoundryRunnerExecutionRequest,
  type FoundryRuntimeProfile,
  hashFoundryInput,
  hashFoundryRuntimeProfile,
  type TrustedFoundryRunner,
} from "./foundry-executor";

const SHA = /^[a-f0-9]{64}$/;
const sha = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const unknown = (invocationId: string): FoundryExecutionResult => ({
  outcome: "UNKNOWN_OUTCOME",
  receiptRef: null,
  reconciliationRef: invocationId,
});

export interface DockerCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  exceeded: boolean;
  timedOut: boolean;
}

/** Internal operator/service interface, never a model tool or caller parameter. */
export interface FoundryDockerControl {
  run(
    args: readonly string[],
    options: {
      stdin?: string;
      timeoutMs: number;
      stdoutBytes: number;
      stderrBytes: number;
    },
  ): Promise<DockerCommandResult>;
}

/** Run only in a dedicated trusted runner service. Do not mount the Docker
 * socket into the application or expose this transport to an agent. Candidate
 * text is never passed as a host command, executable, argument or environment. */
export function createFoundryDockerCli(provided: {
  executable: string;
  context: string;
  dockerConfigDirectory: string;
  path: string;
}): FoundryDockerControl {
  const options = Object.freeze({ ...provided });
  if (
    !isAbsolute(options.executable) ||
    !isAbsolute(options.dockerConfigDirectory) ||
    !/^[A-Za-z0-9_.-]{1,128}$/.test(options.context)
  ) {
    throw new Error("Invalid operator-owned Docker transport configuration.");
  }
  return {
    run(args, bounds) {
      if (
        !Number.isSafeInteger(bounds.timeoutMs) ||
        bounds.timeoutMs < 1 ||
        bounds.timeoutMs > 15_000 ||
        ![bounds.stdoutBytes, bounds.stderrBytes].every(
          (n) => Number.isSafeInteger(n) && n >= 0 && n <= 2 * 1024 * 1024,
        )
      ) {
        return Promise.reject(new Error("Invalid bounded control operation."));
      }
      return new Promise((resolve) => {
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let exceeded = false;
        let timedOut = false;
        let done = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (exitCode: number | null): void => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve({
            exitCode,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
            stdoutBytes,
            stderrBytes,
            exceeded,
            timedOut,
          });
        };
        let child: Bun.Subprocess<"pipe", "pipe", "pipe">;
        try {
          child = Bun.spawn([options.executable, "--context", options.context, ...args], {
            env: { PATH: options.path, DOCKER_CONFIG: options.dockerConfigDirectory, LANG: "C" },
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
          });
        } catch {
          finish(null);
          return;
        }
        const capture = async (stream: "stdout" | "stderr"): Promise<void> => {
          try {
            for await (const bytes of child[stream]) {
              if (done || exceeded) break;
              const chunk = Buffer.from(bytes);
              const previous = stream === "stdout" ? stdoutBytes : stderrBytes;
              const limit = bounds[`${stream}Bytes`];
              (stream === "stdout" ? stdout : stderr).push(chunk.subarray(0, Math.max(0, limit - previous)));
              if (stream === "stdout") stdoutBytes = Math.min(limit, previous + chunk.length);
              else stderrBytes = Math.min(limit, previous + chunk.length);
              if (previous + chunk.length > limit) {
                exceeded = true;
                child.kill("SIGKILL");
              }
            }
          } catch {
            child.kill("SIGKILL");
            finish(null);
          }
        };
        timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
          // Killing this client is NOT container termination. Runner must remove
          // the immutable container and obtain a daemon acknowledgement below.
          finish(null);
        }, bounds.timeoutMs);
        void Promise.all([capture("stdout"), capture("stderr"), child.exited]).then(
          ([, , code]) => finish(code),
          () => finish(null),
        );
        try {
          child.stdin.write(bounds.stdin ?? "");
          child.stdin.end();
        } catch {
          child.kill("SIGKILL");
          finish(null);
        }
      });
    },
  };
}

export interface DockerLedgerRow {
  invocationId: string;
  fence: number;
  identity: string | null;
  phase: "RESERVED" | "DISPATCHING" | "CANCEL_REQUESTED" | "CANCELLED" | "TERMINAL";
  containerId: string | null;
  result: string | null;
  terminated: number;
}

/** Private durable runner journal, not a replacement for native task/outbox
 * state. FULL synchronous commits preserve the pre-dispatch tombstone. A lost
 * dispatcher is never reclaimed/replayed, including after process restart. */
export class FoundryDockerLedger {
  readonly db: Database;
  constructor(filename: string) {
    this.db = new Database(filename, { create: true, strict: true });
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON; PRAGMA checkpoint_fullfsync=ON; PRAGMA busy_timeout=1000;",
    );
    this.db.exec(`CREATE TABLE IF NOT EXISTS foundry_docker_invocations (
      invocationId TEXT PRIMARY KEY, fence INTEGER NOT NULL, identity TEXT,
      phase TEXT NOT NULL, containerId TEXT, result TEXT, terminated INTEGER NOT NULL DEFAULT 0
    ) STRICT`);
  }
  read(id: string): DockerLedgerRow | null {
    return this.db
      .query<DockerLedgerRow, [string]>("SELECT * FROM foundry_docker_invocations WHERE invocationId=?")
      .get(id);
  }
  reserve(id: string, fence: number, identity: string): boolean {
    return (
      this.db
        .query(
          "INSERT INTO foundry_docker_invocations(invocationId,fence,identity,phase) VALUES(?,?,?,'RESERVED') ON CONFLICT DO NOTHING",
        )
        .run(id, fence, identity).changes === 1
    );
  }
  /** One atomic start intent. No code path returns DISPATCHING to RESERVED. */
  claim(id: string, fence: number, containerId: string): boolean {
    return (
      this.db
        .query(
          "UPDATE foundry_docker_invocations SET phase='DISPATCHING',containerId=? WHERE invocationId=? AND fence=? AND phase='RESERVED'",
        )
        .run(containerId, id, fence).changes === 1
    );
  }
  cancel(id: string, fence: number): DockerLedgerRow {
    return this.db
      .transaction(() => {
        this.db
          .query(
            "INSERT INTO foundry_docker_invocations(invocationId,fence,identity,phase) VALUES(?,?,NULL,'CANCELLED') ON CONFLICT DO NOTHING",
          )
          .run(id, fence);
        const row = this.read(id)!;
        if (row.fence !== fence) return row;
        if (row.phase === "RESERVED") {
          this.db.query("UPDATE foundry_docker_invocations SET phase='CANCELLED' WHERE invocationId=?").run(id);
        } else if (row.phase === "DISPATCHING") {
          this.db.query("UPDATE foundry_docker_invocations SET phase='CANCEL_REQUESTED' WHERE invocationId=?").run(id);
        }
        return this.read(id)!;
      })
      .immediate();
  }
  acknowledgeCancellation(id: string, fence: number): boolean {
    return (
      this.db
        .query(
          "UPDATE foundry_docker_invocations SET phase='CANCELLED' WHERE invocationId=? AND fence=? AND phase='CANCEL_REQUESTED'",
        )
        .run(id, fence).changes === 1
    );
  }
  terminated(containerId: string): void {
    this.db.query("UPDATE foundry_docker_invocations SET terminated=1 WHERE containerId=?").run(containerId);
  }
  finish(id: string, fence: number, result: FoundryExecutionResult): boolean {
    return (
      this.db
        .query(
          "UPDATE foundry_docker_invocations SET phase='TERMINAL',result=? WHERE invocationId=? AND fence=? AND phase='DISPATCHING'",
        )
        .run(JSON.stringify(result), id, fence).changes === 1
    );
  }
  close(): void {
    this.db.close();
  }
}

/** Supplied by the existing engine blob/package verifier. The runner additionally
 * hashes the exact entrypoint bytes before any Docker dispatch. No host paths. */
export interface FoundryDockerModule {
  orgId: string;
  packageDigest: string;
  entrypoint: "tool.mjs";
  abi: "receipt-normalizer-json/v1";
  moduleBase64: string;
  moduleDigest: string;
  /** Complete inert frozen content required for independent runner rehashing. */
  packageContent: FoundryDockerPackageContent;
}

export interface FoundryDockerPackageContent {
  readonly manifest: unknown;
  readonly inventory: readonly { readonly path: string; readonly sha256: string; readonly bytes: number }[];
  readonly files: readonly { readonly path: string; readonly base64: string }[];
}

/** Independent byte identity check at the worker boundary. Engine admission
 * still performs the richer manifest/path/license/contract validation. This
 * generic verifier has no dependency on engine code, host paths or loaders. */
export function foundryDockerModuleFromBundle(
  orgId: string,
  packageDigest: string,
  content: FoundryDockerPackageContent,
): FoundryDockerModule {
  const bad = (): never => {
    throw new FoundryExecutorError("SCHEMA_INVALID", "Frozen package identity or bytes differ.");
  };
  if (
    !SHA.test(packageDigest) ||
    !content ||
    !Array.isArray(content.inventory) ||
    !Array.isArray(content.files) ||
    content.inventory.length < 1 ||
    content.inventory.length > 100 ||
    content.files.length !== content.inventory.length
  )
    bad();
  // The bounded manifest (64 KiB) + inventory (100 bounded paths) fits the
  // existing 1 MiB canonical JSON hash helper, even when package bytes do not.
  if (hashFoundryInput({ manifest: content.manifest, inventory: content.inventory }) !== packageDigest) bad();
  const seen = new Set<string>();
  let total = 0;
  let entrypoint: { path: string; base64: string; sha256: string } | undefined;
  for (let i = 0; i < content.inventory.length; i++) {
    const item = content.inventory[i]!;
    const file = content.files[i]!;
    if (!item || !file || typeof item !== "object" || typeof file !== "object") bad();
    if (
      typeof item.path !== "string" ||
      Buffer.byteLength(item.path) > 512 ||
      item.path.length === 0 ||
      seen.has(item.path) ||
      item.path !== file.path ||
      !SHA.test(item.sha256) ||
      !Number.isSafeInteger(item.bytes) ||
      item.bytes < 0 ||
      item.bytes > 1048576 ||
      typeof file.base64 !== "string" ||
      file.base64.length > Math.ceil(1048576 / 3) * 4
    )
      bad();
    seen.add(item.path);
    const bytes = Buffer.from(file.base64, "base64");
    total += bytes.length;
    if (
      bytes.toString("base64") !== file.base64 ||
      bytes.length !== item.bytes ||
      sha(bytes) !== item.sha256 ||
      total > 8 * 1048576
    )
      bad();
    if (item.path === "tool.mjs") entrypoint = { path: item.path, base64: file.base64, sha256: item.sha256 };
  }
  if (!entrypoint) throw new FoundryExecutorError("SCHEMA_INVALID", "Frozen package entrypoint is missing.");
  // Snapshot prevents a mutable callback/cache object changing during create.
  const packageContent = JSON.parse(JSON.stringify(content)) as FoundryDockerPackageContent;
  return {
    orgId,
    packageDigest,
    entrypoint: "tool.mjs",
    abi: "receipt-normalizer-json/v1",
    moduleBase64: entrypoint.base64,
    moduleDigest: entrypoint.sha256,
    packageContent,
  };
}

export interface DockerFoundryOptions {
  docker: FoundryDockerControl;
  ledger: FoundryDockerLedger;
  runnerId: string;
  profileRef: string;
  /** Full immutable local Docker image ID, not a tag or a truncated prefix. */
  imageId: string;
  /** Must match the pinned image; raw child filter is architecture-specific. */
  architecture: "arm64" | "x64";
  /** Fresh read-only Docker daemon/VM identity, captured by the operator before
   * independent qualification; currentProfile checks for drift on every call. */
  platform: FoundryDockerPlatform;
  limits: FoundryLimits;
  /** Operator-owned read-only file containing EXACTLY seccompJson() bytes. */
  seccompPath: string;
  resolvePackage(orgId: string, packageDigest: string): Promise<FoundryDockerModule>;
  /** Fresh native authorization callback from the operator service. It is
   * checked again at the actual dispatch boundary, never supplied by a model. */
  authorize(request: Readonly<FoundryRunnerExecutionRequest>, admission: Readonly<FoundryAdmission>): Promise<boolean>;
  /** A genuinely separate protected evaluator principal; never this runner. */
  /** Digest of the protected scorer program, UID and bounded protocol. */
  evaluatorIdentity: string;
  evaluator: Pick<TrustedFoundryRunner, "evaluate" | "cancelEvaluation" | "reconcileEvaluation">;
  now?: () => number;
}

export interface FoundryDockerPlatform {
  daemonId: string;
  serverVersion: string;
  kernelVersion: string;
  architecture: string;
  osType: string;
  cgroupVersion: string;
  cgroupDriver: string;
  securityOptions: string[];
}

export async function readFoundryDockerPlatform(docker: FoundryDockerControl): Promise<FoundryDockerPlatform> {
  const format =
    '{"daemonId":{{json .ID}},"serverVersion":{{json .ServerVersion}},"kernelVersion":{{json .KernelVersion}},"architecture":{{json .Architecture}},"osType":{{json .OSType}},"cgroupVersion":{{json .CgroupVersion}},"cgroupDriver":{{json .CgroupDriver}},"securityOptions":{{json .SecurityOptions}}}';
  const result = await docker.run(["info", "--format", format], {
    timeoutMs: 1000,
    stdoutBytes: 8192,
    stderrBytes: 4096,
  });
  if (result.exitCode !== 0 || result.timedOut || result.exceeded)
    throw new FoundryExecutorError("BLOCKED_SANDBOX", "Docker platform identity is unavailable.");
  const value = JSON.parse(result.stdout) as FoundryDockerPlatform;
  if (
    ![value.daemonId, value.serverVersion, value.kernelVersion, value.architecture, value.cgroupDriver].every(
      (v) => typeof v === "string" && v.length > 0 && v.length <= 512,
    ) ||
    value.osType !== "linux" ||
    value.cgroupVersion !== "2" ||
    !Array.isArray(value.securityOptions) ||
    !value.securityOptions.every((v) => typeof v === "string" && v.length <= 512) ||
    !value.securityOptions.some((v) => v.includes("name=seccomp"))
  ) {
    throw new FoundryExecutorError("BLOCKED_SANDBOX", "Unsupported or unconfined Docker platform.");
  }
  return value;
}

export function foundryDockerSeccompJson(): string {
  return JSON.stringify(FOUNDRY_DOCKER_SECCOMP);
}

function checkLimits(limits: FoundryLimits): void {
  if (
    !Object.keys(FOUNDRY_PURE_TOOL_LIMITS).every((key) => {
      const k = key as keyof FoundryLimits;
      return Number.isSafeInteger(limits[k]) && limits[k] > 0 && limits[k] <= FOUNDRY_PURE_TOOL_LIMITS[k];
    }) ||
    limits.cpuTimeMs < 1000 ||
    limits.memoryBytes < 6 * 1024 * 1024 ||
    limits.wallTimeMs <= 2000
  ) {
    throw new Error("Unsupported bounded Docker profile; do not round a request upwards.");
  }
}

/** Pure construction for independent review/probes. The JSON seccomp file is
 * read by the Docker CLIENT; it is not mounted into the candidate container. */
export function foundryDockerCreateArgs(
  options: Pick<DockerFoundryOptions, "imageId" | "limits" | "seccompPath">,
  name: string,
): string[] {
  checkLimits(options.limits);
  if (
    !/^sha256:[a-f0-9]{64}$/.test(options.imageId) ||
    !isAbsolute(options.seccompPath) ||
    !/^foundry-[a-f0-9]{48}$/.test(name)
  )
    throw new Error("Invalid immutable Docker identity.");
  const l = options.limits;
  const cpuSeconds = Math.floor(l.cpuTimeMs / 1000);
  return [
    "create",
    "--pull=never",
    "--name",
    name,
    "--interactive",
    "--network=none",
    "--read-only",
    // Only the reviewed watchdog/setup utilities run as root. setpriv drops
    // every candidate capability, group and UID before it executes Bun.
    "--user=0:0",
    "--cap-drop=ALL",
    "--cap-add=KILL",
    "--cap-add=SETUID",
    "--cap-add=SETGID",
    "--cap-add=SETPCAP",
    "--security-opt=no-new-privileges:true",
    `--security-opt=seccomp=${options.seccompPath}`,
    "--cgroupns=private",
    "--ipc=none",
    "--restart=no",
    "--no-healthcheck",
    "--log-driver=none",
    "--pids-limit",
    String(l.maxProcesses),
    "--memory",
    String(l.memoryBytes),
    "--memory-swap",
    String(l.memoryBytes),
    "--cpus=1",
    "--ulimit",
    `cpu=${cpuSeconds}:${cpuSeconds}`,
    "--ulimit",
    "core=0:0",
    "--ulimit",
    "nofile=128:128",
    "--tmpfs",
    `/tmp:rw,noexec,nosuid,nodev,size=${l.scratchBytes},mode=1777`,
    "--workdir=/tmp",
    "--hostname=foundry",
    "--entrypoint=/usr/bin/env",
    options.imageId,
    "-i",
    "PATH=/usr/local/bin:/usr/bin:/bin",
    "HOME=/nonexistent",
    "LANG=C",
    "TMPDIR=/tmp",
    "BUN_INSTALL_CACHE_DIR=/nonexistent",
    // PID 1 watchdog remains alive after an application/runner transport crash.
    // --foreground prevents group manipulation; candidate cannot fork anyway.
    "/usr/bin/timeout",
    "--signal=KILL",
    "--foreground",
    `${(l.wallTimeMs - 2000) / 1000}s`,
    "/usr/bin/setpriv",
    "--reuid=65532",
    "--regid=65532",
    "--clear-groups",
    "--bounding-set=-all",
    "--inh-caps=-all",
    "--ambient-caps=-all",
    "--no-new-privs",
    "--pdeathsig=KILL",
    "--seccomp-filter=/etc/foundry/child.bpf",
    "/usr/bin/prlimit",
    `--cpu=${cpuSeconds}:${cpuSeconds}`,
    "--",
    "/usr/local/bin/bun",
    "--no-env-file",
    "--eval",
    FOUNDRY_DOCKER_BOOTSTRAP,
  ];
}

export function createDockerFoundryRunner(provided: DockerFoundryOptions): TrustedFoundryRunner {
  // Every enforced primitive is captured before the first await. Mutating an
  // application configuration object must not change an attested runner.
  const options = Object.freeze({
    ...provided,
    limits: Object.freeze({ ...provided.limits }),
    platform: structuredClone(provided.platform),
    evaluator: Object.freeze({
      evaluate: provided.evaluator.evaluate.bind(provided.evaluator),
      cancelEvaluation: provided.evaluator.cancelEvaluation.bind(provided.evaluator),
      reconcileEvaluation: provided.evaluator.reconcileEvaluation.bind(provided.evaluator),
    }),
  });
  const { docker, ledger } = options;
  const now = options.now ?? Date.now;
  checkLimits(options.limits);
  if (!SHA.test(options.evaluatorIdentity))
    throw new FoundryExecutorError("BLOCKED_SANDBOX", "Independent scorer identity is not pinned.");
  if (!/^sha256:[a-f0-9]{64}$/.test(options.imageId)) throw new Error("An immutable image ID is required.");
  const configuration = {
    imageId: options.imageId,
    args: foundryDockerCreateArgs(options, `foundry-${"0".repeat(48)}`).map((arg) =>
      arg.startsWith("--security-opt=seccomp=")
        ? `--security-opt=seccomp-sha256:${sha(foundryDockerSeccompJson())}`
        : arg,
    ),
    bootstrapDigest: sha(FOUNDRY_DOCKER_BOOTSTRAP),
    seccompDigest: sha(foundryDockerSeccompJson()),
    childFilterDigest: sha(foundryDockerChildFilter(options.architecture)),
    architecture: options.architecture,
    platformDigest: hashFoundryInput(options.platform),
    evaluatorIdentity: options.evaluatorIdentity,
    captureLimits: options.limits,
  };
  const profile: FoundryRuntimeProfile = {
    runnerId: options.runnerId,
    profileRef: options.profileRef,
    runtimeDigest: options.imageId.slice(7),
    configurationDigest: sha(JSON.stringify(configuration)),
    limits: { ...options.limits },
    // Describes the configured enforcement. Only external independent probes in
    // TrustedFoundryQualificationStore can admit it; these flags are not proof.
    guarantees: Object.fromEntries(
      FOUNDRY_REQUIRED_GUARANTEES.map((k) => [k, true]),
    ) as FoundryRuntimeProfile["guarantees"],
  };
  const profileDigest = hashFoundryRuntimeProfile(profile);
  const control = (args: string[]) => docker.run(args, { timeoutMs: 1000, stdoutBytes: 8192, stderrBytes: 4096 });
  const remove = async (id: string): Promise<boolean> => {
    if (!SHA.test(id)) return false;
    const removed = await control(["rm", "--force", id]);
    // A daemon removal ACK fences even an already-sent, late docker start for
    // this immutable container ID. Never remove by a caller-controlled name.
    const acknowledged = removed.exitCode === 0 && !removed.timedOut && removed.stdout.trim() === id;
    if (acknowledged) ledger.terminated(id);
    return acknowledged;
  };
  const currentProfile = async (): Promise<FoundryRuntimeProfile> => {
    if (hashFoundryInput(await readFoundryDockerPlatform(docker)) !== configuration.platformDigest) {
      throw new FoundryExecutorError("BLOCKED_SANDBOX", "Docker daemon, kernel or enforcement platform changed.");
    }
    if (sha(await readFile(options.seccompPath)) !== sha(foundryDockerSeccompJson())) {
      throw new FoundryExecutorError("BLOCKED_SANDBOX", "Pinned seccomp policy changed.");
    }
    const image = await control(["image", "inspect", "--format", "{{.Id}}", options.imageId]);
    if (image.exitCode !== 0 || image.stdout.trim() !== options.imageId) {
      throw new FoundryExecutorError("BLOCKED_SANDBOX", "Pinned local runtime image is unavailable.");
    }
    return structuredClone(profile);
  };
  const cancelled = (id: string, fence: number): FoundryCancellationResult => ({
    outcome: "CANCELLED",
    invocationId: id,
    fencingToken: fence,
    receiptRef: `foundry-docker/cancel/${sha(id)}/${fence}`,
    processTreeTerminated: true,
  });
  const cancel = async (id: string, fence: number): Promise<FoundryCancellationResult> => {
    const row = ledger.cancel(id, fence);
    if (row.fence === fence) {
      if (row.phase === "CANCELLED" || row.phase === "TERMINAL") return cancelled(id, fence);
      if (row.phase === "CANCEL_REQUESTED" && row.terminated === 1) {
        ledger.acknowledgeCancellation(id, fence);
        return cancelled(id, fence);
      }
      if (row.phase === "CANCEL_REQUESTED" && row.containerId && (await remove(row.containerId))) {
        ledger.acknowledgeCancellation(id, fence);
        return cancelled(id, fence);
      }
    }
    return {
      outcome: "UNKNOWN_OUTCOME",
      invocationId: id,
      fencingToken: fence,
      receiptRef: null,
      reconciliationRef: id,
    };
  };
  return {
    currentProfile,
    async execute(providedRequest, providedAdmission) {
      const request = Object.freeze({ ...providedRequest });
      const admission = Object.freeze({ ...providedAdmission, limits: Object.freeze({ ...providedAdmission.limits }) });
      if (
        !Number.isSafeInteger(request.fencingToken) ||
        request.fencingToken < 1 ||
        ![request.orgId, request.invocationId, request.nativeDecisionRef, request.budgetReservationRef].every(
          (v) => typeof v === "string" && v.length > 0 && v.length <= 512,
        ) ||
        !SHA.test(request.digest) ||
        !SHA.test(request.inputDigest) ||
        !Number.isFinite(Date.parse(admission.expiresAt))
      ) {
        throw new FoundryExecutorError("SCHEMA_INVALID", "Invalid pinned dispatch identity.");
      }
      await currentProfile();
      if (
        admission.runnerId !== profile.runnerId ||
        admission.runtimeDigest !== profile.runtimeDigest ||
        admission.profileDigest !== profileDigest ||
        admission.configurationDigest !== profile.configurationDigest ||
        admission.profileRef !== profile.profileRef ||
        Date.parse(admission.expiresAt) <= now() ||
        !Object.keys(profile.limits).every(
          (key) => admission.limits[key as keyof FoundryLimits] === profile.limits[key as keyof FoundryLimits],
        )
      ) {
        throw new FoundryExecutorError("BLOCKED_SANDBOX", "Admission no longer pins this enforced profile.");
      }
      if (
        sha(request.inputJson) !== request.inputDigest ||
        Buffer.byteLength(request.inputJson) > profile.limits.inputBytes
      ) {
        throw new FoundryExecutorError("SCHEMA_INVALID", "Input identity or size differs.");
      }
      const supplied = await options.resolvePackage(request.orgId, request.digest);
      const module = foundryDockerModuleFromBundle(request.orgId, request.digest, supplied.packageContent);
      if (
        supplied.orgId !== module.orgId ||
        supplied.packageDigest !== module.packageDigest ||
        supplied.entrypoint !== module.entrypoint ||
        supplied.abi !== module.abi ||
        supplied.moduleBase64 !== module.moduleBase64 ||
        supplied.moduleDigest !== module.moduleDigest
      ) {
        throw new FoundryExecutorError("SCHEMA_INVALID", "Verified package resolution differs.");
      }
      const identity = sha(
        JSON.stringify({
          orgId: request.orgId,
          digest: request.digest,
          inputDigest: request.inputDigest,
          fence: request.fencingToken,
          profileDigest,
          attestationRef: admission.attestationRef,
          decision: request.nativeDecisionRef,
          reservation: request.budgetReservationRef,
        }),
      );
      if (!(await options.authorize(request, admission))) {
        throw new FoundryExecutorError("BLOCKED_SANDBOX", "Current native dispatch authorization is unavailable.");
      }
      if (request.abort.aborted) {
        await cancel(request.invocationId, request.fencingToken);
        return unknown(request.invocationId);
      }
      if (!ledger.reserve(request.invocationId, request.fencingToken, identity)) {
        const row = ledger.read(request.invocationId)!;
        return row.identity === identity && row.result
          ? (JSON.parse(row.result) as FoundryExecutionResult)
          : unknown(request.invocationId);
      }
      let containerId: string | null = null;
      const onAbort = (): void => {
        void cancel(request.invocationId, request.fencingToken).catch(() => undefined);
      };
      request.abort.addEventListener("abort", onAbort, { once: true });
      try {
        const name = `foundry-${sha(`${profile.runnerId}:${request.invocationId}`).slice(0, 48)}`;
        const created = await control(foundryDockerCreateArgs(options, name));
        if (created.exitCode !== 0 || !SHA.test(created.stdout.trim())) return unknown(request.invocationId);
        containerId = created.stdout.trim();
        const authorized = await options.authorize(request, admission);
        if (
          !authorized ||
          request.abort.aborted ||
          Date.parse(admission.expiresAt) <= now() ||
          !ledger.claim(request.invocationId, request.fencingToken, containerId)
        ) {
          await remove(containerId);
          await cancel(request.invocationId, request.fencingToken);
          return unknown(request.invocationId);
        }
        const envelope = JSON.stringify({
          abi: module.abi,
          moduleBase64: module.moduleBase64,
          moduleDigest: module.moduleDigest,
          inputJson: request.inputJson,
          inputDigest: request.inputDigest,
          resultBytes: Math.min(profile.limits.resultBytes, profile.limits.stdoutBytes),
        });
        const output = await docker.run(["start", "--attach", "--interactive", containerId], {
          stdin: envelope,
          timeoutMs: profile.limits.wallTimeMs - 2000,
          stdoutBytes: Math.min(profile.limits.stdoutBytes, profile.limits.resultBytes),
          stderrBytes: profile.limits.stderrBytes,
        });
        if (!(await remove(containerId))) return unknown(request.invocationId);
        const receiptRef = `foundry-docker/receipt/${sha(request.invocationId)}/${request.fencingToken}`;
        const receipt: FoundryExecutionReceipt = {
          receiptRef,
          orgId: request.orgId,
          digest: request.digest,
          inputDigest: request.inputDigest,
          invocationId: request.invocationId,
          fencingToken: request.fencingToken,
          runnerId: admission.runnerId,
          runtimeDigest: admission.runtimeDigest,
          profileDigest: admission.profileDigest,
          qualificationRef: admission.attestationRef,
          effectiveLimits: { ...profile.limits },
          stdoutBytes: output.stdoutBytes,
          stderrBytes: output.stderrBytes,
          processTreeTerminated: true,
        };
        let result: FoundryExecutionResult;
        if (output.timedOut || output.exceeded) {
          result = { outcome: "FAILED", code: "LIMIT_EXCEEDED", receiptRef, receipt };
        } else if (output.exitCode === 65 && output.stdoutBytes === 0) {
          result = { outcome: "FAILED", code: "SCHEMA_INVALID", receiptRef, receipt };
        } else if (output.exitCode !== 0) {
          result = { outcome: "FAILED", code: "EVAL_FAILED", receiptRef, receipt };
        } else {
          try {
            result = { outcome: "SUCCEEDED", output: JSON.parse(output.stdout), receiptRef, receipt };
          } catch {
            result = { outcome: "FAILED", code: "SCHEMA_INVALID", receiptRef, receipt };
          }
        }
        if (!ledger.finish(request.invocationId, request.fencingToken, result)) return unknown(request.invocationId);
        return result;
      } catch {
        // If create/start acknowledgement was lost, never issue another start.
        // Native recovery can request cancellation; absence of a receipt is UNKNOWN.
        if (containerId) await cancel(request.invocationId, request.fencingToken).catch(() => undefined);
        return unknown(request.invocationId);
      } finally {
        request.abort.removeEventListener("abort", onAbort);
      }
    },
    cancel,
    async reconcile(invocationId) {
      // Strictly read-only: no docker create/start and no automatic replay.
      const row = ledger.read(invocationId);
      return row?.result ? (JSON.parse(row.result) as FoundryExecutionResult) : unknown(invocationId);
    },
    evaluate: (...args) => options.evaluator.evaluate(...args),
    cancelEvaluation: (...args) => options.evaluator.cancelEvaluation(...args),
    reconcileEvaluation: (...args) => options.evaluator.reconcileEvaluation(...args),
  };
}
