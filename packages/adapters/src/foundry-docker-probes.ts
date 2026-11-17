import { createHash } from "node:crypto";
import { FOUNDRY_DOCKER_BOOTSTRAP } from "./foundry-docker-bootstrap";
import { foundryDockerCreateArgs, type DockerFoundryOptions, type FoundryDockerControl } from "./foundry-docker-runner";

/** Operator-authored infrastructure probes only. These are not candidate
 * development tests, protected holdouts, or a qualification authority. */
export const FOUNDRY_DOCKER_PROBE_PROGRAMS = {
  abi: FOUNDRY_DOCKER_BOOTSTRAP,
  identity: String.raw`
    const fs = await import("node:fs");
    const read = p => { try { return fs.readFileSync(p,"utf8").slice(0,16384); } catch(e) { return {error:e.code}; } };
    const status=read("/proc/self/status");
    const keys=["Uid:","Gid:","CapInh:","CapPrm:","CapEff:","CapBnd:","CapAmb:","NoNewPrivs:","Seccomp:","Seccomp_filters:"];
    process.stdout.write(JSON.stringify({
      runtime:Bun.version,arch:process.arch,uid:process.getuid(),gid:process.getgid(),
      status:status.split("\n").filter(s=>keys.some(k=>s.startsWith(k))),
      limits:read("/proc/self/limits"),env:process.env,
      memoryMax:read("/sys/fs/cgroup/memory.max"),swapMax:read("/sys/fs/cgroup/memory.swap.max"),
      pidsMax:read("/sys/fs/cgroup/pids.max"),cpuMax:read("/sys/fs/cgroup/cpu.max"),
      mounts:read("/proc/self/mountinfo"),childFilter:Buffer.from(fs.readFileSync("/etc/foundry/child.bpf")).toString("base64")
    }));
  `,
  isolation: String.raw`
    const fs=await import("node:fs"); const net=await import("node:net"); const dns=await import("node:dns/promises");
    const out={};
    const attempt=(name,fn)=>{try{fn();out[name]="UNEXPECTED_SUCCESS";}catch(e){out[name]=e.code??e.message;}};
    attempt("rootWrite",()=>fs.writeFileSync("/etc/foundry-write-probe","x"));
    attempt("dockerSocket",()=>fs.openSync("/var/run/docker.sock","r"));
    attempt("hostHome",()=>fs.readdirSync("/host"));
    attempt("rootCredentials",()=>fs.readdirSync("/root/.ssh"));
    attempt("watchdogMemory",()=>fs.openSync("/proc/1/mem","r+"));
    attempt("watchdogSignal",()=>process.kill(1,"SIGSTOP"));
    try{const p=Bun.spawnSync(["/bin/true"]);out.fork=p.exitCode===0?"UNEXPECTED_SUCCESS":(p.error?.code??"REFUSED");}catch(e){out.fork=e.code??e.message;}
    try{await new Promise(resolve=>{const s=net.createConnection({host:"1.1.1.1",port:443});s.on("error",e=>{out.network=e.code;resolve();});s.on("connect",()=>{out.network="UNEXPECTED_SUCCESS";s.destroy();resolve();});setTimeout(()=>{s.destroy();out.network??="TIMEOUT";resolve();},500);});}catch(e){out.network=e.code??e.message;}
    try{await Promise.race([dns.lookup("example.com"),new Promise((_,reject)=>setTimeout(()=>reject(new Error("TIMEOUT")),500))]);out.dns="UNEXPECTED_SUCCESS";}catch(e){out.dns=e.code??e.message;}
    try{await fetch("http://169.254.169.254/",{signal:AbortSignal.timeout(500)});out.metadata="UNEXPECTED_SUCCESS";}catch(e){out.metadata=e.code??e.message;}
    process.stdout.write(JSON.stringify(out));
  `,
  scratchWrite: String.raw`
    const fs=await import("node:fs"); fs.writeFileSync("/tmp/foundry-tenant-marker","tenant-a");
    const block=Buffer.alloc(1048576); let bytes=0,code=null;
    const fd=fs.openSync("/tmp/foundry-space-probe","w");
    try{for(let n=0;n<64;n++){bytes+=fs.writeSync(fd,block);}}catch(e){code=e.code;}finally{fs.closeSync(fd);}
    process.stdout.write(JSON.stringify({bytes,code}));
  `,
  scratchFresh: String.raw`
    const fs=await import("node:fs"); process.stdout.write(JSON.stringify({markerPresent:fs.existsSync("/tmp/foundry-tenant-marker"),scratch:fs.readdirSync("/tmp")}));
  `,
  wall: "setInterval(()=>{}, 1000);",
  watchdogAfterClientLoss: "setInterval(()=>{}, 1000);",
  cpu: "for (;;) {}",
  output: 'for(;;)process.stdout.write("x".repeat(8192));',
  stderrOutput: 'for(;;)process.stderr.write("x".repeat(8192));',
  memory: "const a=[];for(;;){const b=Buffer.alloc(8*1024*1024,42);a.push(b);}",
} as const;

export interface FoundryDockerProbeEvidence {
  probe: keyof typeof FOUNDRY_DOCKER_PROBE_PROGRAMS;
  observedAt: string;
  elapsedMs: number;
  created: boolean;
  containerId: string | null;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  captureExceeded: boolean;
  clientTimedOut: boolean;
  removed: boolean;
  /** No PASS label: an independent authority interprets and signs the evidence. */
  status: "OBSERVED" | "CONTROL_UNAVAILABLE";
  stateAfterClientLoss?: string;
  stateAfterDeadline?: string;
}

/** Explicit operator-only probe route for establishing real evidence before
 * production admission. Only fixed infrastructure programs above can run. */
export async function probeFoundryDockerRuntime(
  docker: FoundryDockerControl,
  options: Pick<DockerFoundryOptions, "imageId" | "limits" | "seccompPath">,
  probe: keyof typeof FOUNDRY_DOCKER_PROBE_PROGRAMS,
): Promise<FoundryDockerProbeEvidence> {
  const program = FOUNDRY_DOCKER_PROBE_PROGRAMS[probe];
  if (!program) throw new Error("Unknown fixed infrastructure probe.");
  const started = Date.now();
  const key = createHash("sha256").update(`${probe}:${started}:${crypto.randomUUID()}`).digest("hex").slice(0, 48);
  const args = foundryDockerCreateArgs(options, `foundry-${key}`);
  if (args.at(-1) !== FOUNDRY_DOCKER_BOOTSTRAP) throw new Error("Unexpected reviewed command shape.");
  args[args.length - 1] = program;
  const created = await docker.run(args, { timeoutMs: 3000, stdoutBytes: 1024, stderrBytes: 4096 });
  const id = created.stdout.trim();
  if (created.exitCode !== 0 || !/^[a-f0-9]{64}$/.test(id)) {
    return { probe, observedAt: new Date(started).toISOString(), elapsedMs: Date.now() - started, created: false,
      containerId: null, exitCode: created.exitCode, stdout: created.stdout, stderr: created.stderr,
      captureExceeded: created.exceeded, clientTimedOut: created.timedOut, removed: false, status: "CONTROL_UNAVAILABLE" };
  }
  const result = await docker.run(["start", "--attach", "--interactive", id], {
    stdin: probe === "abi" ? JSON.stringify({
      abi: "receipt-normalizer-json/v1",
      moduleBase64: Buffer.from('export const normalizeReceiptJson = input => JSON.stringify({echo: JSON.parse(input).probe});').toString("base64"),
      moduleDigest: createHash("sha256").update('export const normalizeReceiptJson = input => JSON.stringify({echo: JSON.parse(input).probe});').digest("hex"),
      inputJson: '{"probe":"fixed-infrastructure-abi"}',
      inputDigest: createHash("sha256").update('{"probe":"fixed-infrastructure-abi"}').digest("hex"),
      resultBytes: 1024,
    }) : undefined,
    timeoutMs: probe === "watchdogAfterClientLoss" ? 300 : Math.min(15000, options.limits.wallTimeMs + 2000),
    stdoutBytes: options.limits.stdoutBytes, stderrBytes: options.limits.stderrBytes,
  });
  let stateAfterClientLoss: string | undefined;
  let stateAfterDeadline: string | undefined;
  if (probe === "watchdogAfterClientLoss") {
    const format = '{"running":{{json .State.Running}},"exitCode":{{json .State.ExitCode}},"pid":{{json .State.Pid}},"oomKilled":{{json .State.OOMKilled}}}';
    const first = await docker.run(["inspect", "--format", format, id], { timeoutMs: 1000, stdoutBytes: 2048, stderrBytes: 1024 });
    stateAfterClientLoss = first.exitCode === 0 ? first.stdout : "CONTROL_UNAVAILABLE";
    // No runner/CLI remains attached during this interval. The trusted utility
    // in the container must enforce its own earlier wall deadline.
    await new Promise(resolve => setTimeout(resolve, options.limits.wallTimeMs - 1500));
    const last = await docker.run(["inspect", "--format", format, id], { timeoutMs: 1000, stdoutBytes: 2048, stderrBytes: 1024 });
    stateAfterDeadline = last.exitCode === 0 ? last.stdout : "CONTROL_UNAVAILABLE";
  }
  const removed = await docker.run(["rm", "--force", id], { timeoutMs: 3000, stdoutBytes: 1024, stderrBytes: 4096 });
  return { probe, observedAt: new Date(started).toISOString(), elapsedMs: Date.now() - started, created: true,
    containerId: id, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr,
    captureExceeded: result.exceeded, clientTimedOut: result.timedOut,
    removed: removed.exitCode === 0 && removed.stdout.trim() === id, status: "OBSERVED", stateAfterClientLoss, stateAfterDeadline };
}
