import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foundryDockerChildFilter } from "../src/foundry-docker-bootstrap";
import {
  createDockerFoundryRunner,
  type DockerCommandResult,
  type DockerFoundryOptions,
  type FoundryDockerControl,
  FoundryDockerLedger,
  foundryDockerCreateArgs,
  foundryDockerModuleFromBundle,
  foundryDockerSeccompJson,
} from "../src/foundry-docker-runner";
import {
  FOUNDRY_PURE_TOOL_LIMITS,
  type FoundryAdmission,
  type FoundryRunnerExecutionRequest,
  hashFoundryInput,
  hashFoundryRuntimeProfile,
} from "../src/foundry-executor";

// Control-path tests only. Candidate bytes are inert; no process/container is
// started. Actual isolation requires the separate fixed Docker probes.
const IMAGE = `sha256:${"a".repeat(64)}`;
const CONTAINER = "b".repeat(64);
const PLATFORM = {
  daemonId: "simulation-daemon",
  serverVersion: "29.0.0",
  kernelVersion: "6.12-test",
  architecture: "aarch64",
  osType: "linux",
  cgroupVersion: "2",
  cgroupDriver: "cgroupfs",
  securityOptions: ["name=seccomp,profile=builtin"],
};
const directories: string[] = [];
afterEach(() => {
  for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true });
});
function directory(): string {
  const d = mkdtempSync(join(tmpdir(), "foundry-docker-test-"));
  directories.push(d);
  return d;
}
const ok = (stdout = "", exitCode = 0): DockerCommandResult => ({
  stdout,
  stderr: "",
  stdoutBytes: Buffer.byteLength(stdout),
  stderrBytes: 0,
  exitCode,
  exceeded: false,
  timedOut: false,
});
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const CONTENT = {
  manifest: { testFixture: "inert-only" },
  inventory: [{ path: "tool.mjs", sha256: sha("INERT TEST BYTES"), bytes: Buffer.byteLength("INERT TEST BYTES") }],
  files: [{ path: "tool.mjs", base64: Buffer.from("INERT TEST BYTES").toString("base64") }],
};
const PACKAGE_DIGEST = hashFoundryInput({ manifest: CONTENT.manifest, inventory: CONTENT.inventory });
function request(): FoundryRunnerExecutionRequest {
  return {
    orgId: "org",
    digest: PACKAGE_DIGEST,
    inputJson: '{"records":[]}',
    inputDigest: sha('{"records":[]}'),
    invocationId: "invocation-1",
    fencingToken: 1,
    nativeDecisionRef: "approval-1",
    budgetReservationRef: "budget-1",
    abort: new AbortController().signal,
  };
}
async function fixture(
  hook?: FoundryDockerControl["run"],
  authorize: DockerFoundryOptions["authorize"] = async () => true,
) {
  const dir = directory();
  const seccompPath = join(dir, "outer.json");
  writeFileSync(seccompPath, foundryDockerSeccompJson());
  const calls: string[][] = [];
  let platform = structuredClone(PLATFORM);
  const ledger = new FoundryDockerLedger(join(dir, "ledger.sqlite"));
  const docker: FoundryDockerControl = {
    async run(args, options) {
      calls.push([...args]);
      if (args[0] === "info") return ok(JSON.stringify(platform));
      if (hook) return hook(args, options);
      if (args[0] === "image") return ok(IMAGE);
      if (args[0] === "create") return ok(CONTAINER);
      if (args[0] === "start")
        return ok(
          '{"total":0,"counts":{"succeeded":0,"failed":0,"cancelled":0,"unknown":0,"unverified":0},"tokens":0}',
        );
      if (args[0] === "rm") return ok(CONTAINER);
      throw new Error("unexpected command");
    },
  };
  const configuration: DockerFoundryOptions = {
    docker,
    ledger,
    runnerId: "runner",
    profileRef: "profile",
    imageId: IMAGE,
    architecture: "arm64",
    platform: structuredClone(PLATFORM),
    limits: { ...FOUNDRY_PURE_TOOL_LIMITS },
    seccompPath,
    resolvePackage: async (orgId, packageDigest) => foundryDockerModuleFromBundle(orgId, packageDigest, CONTENT),
    authorize,
    evaluatorIdentity: "d".repeat(64),
    evaluator: {
      async evaluate() {
        throw new Error("not a protected evaluator");
      },
      async cancelEvaluation(evaluatorJobRef) {
        return { outcome: "UNKNOWN_OUTCOME", evaluatorJobRef, receiptRef: null, reconciliationRef: evaluatorJobRef };
      },
      async reconcileEvaluation(evaluatorJobRef) {
        return { outcome: "UNKNOWN_OUTCOME", evaluatorJobRef, receiptRef: null, reconciliationRef: evaluatorJobRef };
      },
    },
  };
  const runner = createDockerFoundryRunner(configuration);
  const profile = await runner.currentProfile();
  const admission: FoundryAdmission = {
    runnerId: profile.runnerId,
    profileRef: profile.profileRef,
    runtimeDigest: profile.runtimeDigest,
    configurationDigest: profile.configurationDigest,
    profileDigest: hashFoundryRuntimeProfile(profile),
    attestationRef: "TEST-NOT-QUALIFICATION",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    limits: { ...profile.limits },
  };
  return {
    runner,
    ledger,
    calls,
    admission,
    dir,
    seccompPath,
    configuration,
    changePlatform: (value: typeof PLATFORM) => {
      platform = value;
    },
  };
}

describe("durable Docker execution fencing", () => {
  test("cancel before dispatch survives restart and forbids later claim", () => {
    const dir = directory();
    const filename = join(dir, "journal.sqlite");
    const first = new FoundryDockerLedger(filename);
    first.cancel("job", 1);
    first.close();
    const second = new FoundryDockerLedger(filename);
    expect(second.reserve("job", 1, "identity")).toBe(false);
    expect(second.claim("job", 1, CONTAINER)).toBe(false);
    expect(second.read("job")?.phase).toBe("CANCELLED");
    second.close();
  });
  test("two clients can claim an invocation only once", () => {
    const dir = directory();
    const filename = join(dir, "journal.sqlite");
    const a = new FoundryDockerLedger(filename);
    const b = new FoundryDockerLedger(filename);
    expect(a.reserve("job", 1, "identity")).toBe(true);
    expect(b.reserve("job", 1, "identity")).toBe(false);
    expect(a.claim("job", 1, CONTAINER)).toBe(true);
    expect(b.claim("job", 1, CONTAINER)).toBe(false);
    a.close();
    b.close();
  });
  test("restart does not reclaim a lost dispatch intent", () => {
    const dir = directory();
    const filename = join(dir, "journal.sqlite");
    const a = new FoundryDockerLedger(filename);
    a.reserve("job", 1, "identity");
    a.claim("job", 1, CONTAINER);
    a.close();
    const b = new FoundryDockerLedger(filename);
    expect(b.claim("job", 1, CONTAINER)).toBe(false);
    expect(b.read("job")?.phase).toBe("DISPATCHING");
    b.close();
  });
  test("successful result replays metadata without creating or starting a container again", async () => {
    const f = await fixture();
    const r = request();
    expect((await f.runner.execute(r, f.admission)).outcome).toBe("SUCCEEDED");
    expect((await f.runner.execute(r, f.admission)).outcome).toBe("SUCCEEDED");
    expect(f.calls.filter((c) => c[0] === "create")).toHaveLength(1);
    expect(f.calls.filter((c) => c[0] === "start")).toHaveLength(1);
    f.ledger.close();
  });
  test("changed input under same invocation cannot dispatch", async () => {
    const f = await fixture();
    const r = request();
    await f.runner.execute(r, f.admission);
    const changed = '{"records":[{"status":"unknown","tokens":1}]}';
    expect((await f.runner.execute({ ...r, inputJson: changed, inputDigest: sha(changed) }, f.admission)).outcome).toBe(
      "UNKNOWN_OUTCOME",
    );
    expect(f.calls.filter((c) => c[0] === "start")).toHaveLength(1);
    f.ledger.close();
  });
  test("cancellation while create is in flight prevents start", async () => {
    let release: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let created: (() => void) | undefined;
    const startedCreate = new Promise<void>((resolve) => {
      created = resolve;
    });
    const f = await fixture(async (args) => {
      if (args[0] === "image") return ok(IMAGE);
      if (args[0] === "create") {
        created?.();
        await barrier;
        return ok(CONTAINER);
      }
      if (args[0] === "rm") return ok(CONTAINER);
      throw new Error("must never start");
    });
    const running = f.runner.execute(request(), f.admission);
    await startedCreate;
    expect((await f.runner.cancel("invocation-1", 1)).outcome).toBe("CANCELLED");
    release?.();
    expect((await running).outcome).toBe("UNKNOWN_OUTCOME");
    expect(f.calls.some((c) => c[0] === "start")).toBe(false);
    f.ledger.close();
  });
  test("lost start acknowledgement is unknown and never replayed", async () => {
    const f = await fixture(async (args) => {
      if (args[0] === "image") return ok(IMAGE);
      if (args[0] === "create") return ok(CONTAINER);
      if (args[0] === "start") throw new Error("transport lost");
      if (args[0] === "rm") return { ...ok(), exitCode: null, timedOut: true };
      throw new Error("unexpected");
    });
    expect((await f.runner.execute(request(), f.admission)).outcome).toBe("UNKNOWN_OUTCOME");
    expect((await f.runner.execute(request(), f.admission)).outcome).toBe("UNKNOWN_OUTCOME");
    const before = f.calls.length;
    expect((await f.runner.reconcile("invocation-1")).outcome).toBe("UNKNOWN_OUTCOME");
    expect(f.calls.length).toBe(before);
    expect(f.calls.filter((c) => c[0] === "start")).toHaveLength(1);
    f.ledger.close();
  });
  test("a create whose answer was lost removes the container by its fixed name and never starts it", async () => {
    const options: number[] = [];
    const f = await fixture(async (args, o) => {
      options.push(o.timeoutMs);
      if (args[0] === "image") return ok(IMAGE);
      if (args[0] === "create") return { ...ok(), exitCode: null, timedOut: true };
      if (args[0] === "rm") return ok(args[2]);
      throw new Error("unexpected");
    });
    expect((await f.runner.execute(request(), f.admission)).outcome).toBe("UNKNOWN_OUTCOME");
    const rm = f.calls.filter((c) => c[0] === "rm");
    expect(rm).toHaveLength(1);
    expect(rm[0]![2]).toMatch(/^foundry-[a-f0-9]{48}$/);
    expect(f.calls.filter((c) => c[0] === "start")).toHaveLength(0);
    // Control commands get more than a second on a loaded daemon.
    expect(Math.min(...options)).toBeGreaterThanOrEqual(3000);
    f.ledger.close();
  });
  test("changed seccomp bytes block before container creation", async () => {
    const f = await fixture();
    writeFileSync(f.seccompPath, "{}");
    await expect(f.runner.execute(request(), f.admission)).rejects.toThrow("seccomp");
    expect(f.calls.some((c) => c[0] === "create")).toBe(false);
    f.ledger.close();
  });
  test("constructor snapshots mutable enforcement configuration", async () => {
    const f = await fixture();
    f.configuration.imageId = `sha256:${"e".repeat(64)}`;
    f.configuration.limits.memoryBytes = 128 * 1024 * 1024;
    f.configuration.platform.kernelVersion = "changed";
    expect((await f.runner.execute(request(), f.admission)).outcome).toBe("SUCCEEDED");
    const created = f.calls.find((c) => c[0] === "create")!;
    expect(created).toContain(IMAGE);
    expect(created).toContain(String(FOUNDRY_PURE_TOOL_LIMITS.memoryBytes));
    f.ledger.close();
  });
  test("changed daemon or kernel invalidates the prior runtime profile", async () => {
    const f = await fixture();
    f.changePlatform({ ...PLATFORM, kernelVersion: "other-kernel" });
    await expect(f.runner.execute(request(), f.admission)).rejects.toThrow("platform changed");
    expect(f.calls.some((c) => c[0] === "create")).toBe(false);
    f.ledger.close();
  });
  test("fresh native authority loss after create prevents actual dispatch", async () => {
    let checks = 0;
    const f = await fixture(undefined, async () => ++checks === 1);
    expect((await f.runner.execute(request(), f.admission)).outcome).toBe("UNKNOWN_OUTCOME");
    expect(checks).toBe(2);
    expect(f.calls.some((c) => c[0] === "start")).toBe(false);
    expect(f.ledger.read("invocation-1")?.phase).toBe("CANCELLED");
    f.ledger.close();
  });
});

describe("reviewable Docker profile", () => {
  test("runner independently rejects changed package inventory and file bytes", () => {
    expect(foundryDockerModuleFromBundle("org", PACKAGE_DIGEST, CONTENT).moduleDigest).toBe(sha("INERT TEST BYTES"));
    expect(() =>
      foundryDockerModuleFromBundle("org", PACKAGE_DIGEST, {
        ...CONTENT,
        files: [{ path: "tool.mjs", base64: Buffer.from("different").toString("base64") }],
      }),
    ).toThrow();
    expect(() =>
      foundryDockerModuleFromBundle("org", PACKAGE_DIGEST, {
        ...CONTENT,
        inventory: [{ ...CONTENT.inventory[0]!, sha256: sha("different") }],
      }),
    ).toThrow();
    expect(() => foundryDockerModuleFromBundle("org", "f".repeat(64), CONTENT)).toThrow();
  });
  test("command never uses shell, mutable image, network, Docker socket, home mount or host user", () => {
    const args = foundryDockerCreateArgs(
      { imageId: IMAGE, limits: { ...FOUNDRY_PURE_TOOL_LIMITS }, seccompPath: "/private/outer.json" },
      `foundry-${"d".repeat(48)}`,
    );
    for (const flag of [
      "--pull=never",
      "--network=none",
      "--read-only",
      "--log-driver=none",
      "--restart=no",
      "--cap-drop=ALL",
      "--reuid=65532",
      "--bounding-set=-all",
      "--no-new-privs",
      "--seccomp-filter=/etc/foundry/child.bpf",
    ])
      expect(args).toContain(flag);
    expect(args).toContain("/usr/bin/timeout");
    expect(args).toContain("--signal=KILL");
    expect(args).toContain(IMAGE);
    expect(args.some((a) => a.includes("docker.sock"))).toBe(false);
    expect(args).not.toContain("--volume");
    expect(args).not.toContain("--mount");
    expect(args).not.toContain("/bin/sh");
  });
  test("immutable image and supported conservative bounds are mandatory", () => {
    expect(() =>
      foundryDockerCreateArgs(
        { imageId: "oven/bun:latest", limits: { ...FOUNDRY_PURE_TOOL_LIMITS }, seccompPath: "/private/policy" },
        `foundry-${"d".repeat(48)}`,
      ),
    ).toThrow();
    expect(() =>
      foundryDockerCreateArgs(
        { imageId: IMAGE, limits: { ...FOUNDRY_PURE_TOOL_LIMITS, cpuTimeMs: 500 }, seccompPath: "/private/policy" },
        `foundry-${"d".repeat(48)}`,
      ),
    ).toThrow();
  });
  test("child filter uses separate architecture identities and stable raw instruction size", () => {
    const a = foundryDockerChildFilter("arm64");
    const x = foundryDockerChildFilter("x64");
    expect(a.length % 8).toBe(0);
    expect(x.length % 8).toBe(0);
    expect(Buffer.from(a).equals(Buffer.from(x))).toBe(false);
    expect(Buffer.from(a).readUInt32LE(12)).toBe(0xc00000b7);
    expect(Buffer.from(x).readUInt32LE(12)).toBe(0xc000003e);
  });
  test("raw BPF denies process creation and wrong ABI while permitting bounded threads", () => {
    // Independent tiny cBPF evaluator for the emitted instruction set. Kernel
    // probes remain mandatory; this catches reversed jump offsets before them.
    const evaluate = (bytes: Uint8Array, architecture: number, syscall: number, flags = 0): number => {
      const b = Buffer.from(bytes);
      let accumulator = 0;
      for (let pc = 0; pc < b.length / 8; pc++) {
        const code = b.readUInt16LE(pc * 8),
          jt = b[pc * 8 + 2]!,
          jf = b[pc * 8 + 3]!,
          k = b.readUInt32LE(pc * 8 + 4);
        if (code === 0x20) accumulator = k === 0 ? syscall : k === 4 ? architecture : flags;
        else if (code === 0x15) pc += accumulator === k ? jt : jf;
        else if (code === 0x45) pc += (accumulator & k) !== 0 ? jt : jf;
        else if (code === 0x06) return k;
        else throw new Error("Unsupported BPF instruction");
      }
      throw new Error("Missing terminal instruction");
    };
    const arm = foundryDockerChildFilter("arm64"),
      x64 = foundryDockerChildFilter("x64");
    expect(evaluate(arm, 0xc00000b7, 220, 17)).toBe(0x00050001);
    expect(evaluate(arm, 0xc00000b7, 220, 65536)).toBe(0x7fff0000);
    expect(evaluate(arm, 0xc00000b7, 435)).toBe(0x00050026);
    expect(evaluate(arm, 0xc000003e, 0)).toBe(0x80000000);
    expect(evaluate(x64, 0xc000003e, 57)).toBe(0x00050001);
    expect(evaluate(x64, 0xc000003e, 58)).toBe(0x00050001);
    expect(evaluate(x64, 0xc000003e, 56, 17)).toBe(0x00050001);
    expect(evaluate(x64, 0xc000003e, 56, 65536)).toBe(0x7fff0000);
    expect(evaluate(x64, 0xc000003e, 0x40000038, 65536)).toBe(0x80000000);
  });
});

test("changing the independent scorer identity invalidates the previously qualified runtime profile", async () => {
  const f = await fixture();
  const another = createDockerFoundryRunner({ ...f.configuration, evaluatorIdentity: "e".repeat(64) });
  expect(hashFoundryRuntimeProfile(await another.currentProfile())).not.toBe(f.admission.profileDigest);
  f.ledger.close();
});
