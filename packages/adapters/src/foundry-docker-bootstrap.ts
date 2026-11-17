/** Trusted bootstrap text. It is passed to the pinned Bun INSIDE the container.
 * Never evaluate/import this string, or the module bytes it reads, on the host. */
export const FOUNDRY_DOCKER_BOOTSTRAP = String.raw`
const fs = await import("node:fs");
const crypto = await import("node:crypto");
const fail = () => { process.exitCode = 65; throw new Error("invalid bounded foundry request"); };
const maxEnvelope = 3 * 1024 * 1024;
let size = 0;
const chunks = [];
for await (const chunk of process.stdin) {
  size += chunk.length;
  if (size > maxEnvelope) fail();
  chunks.push(chunk);
}
const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8"));
if (envelope.abi !== "receipt-normalizer-json/v1" || typeof envelope.moduleBase64 !== "string" ||
    typeof envelope.inputJson !== "string" || typeof envelope.inputDigest !== "string" ||
    typeof envelope.moduleDigest !== "string" || !Number.isSafeInteger(envelope.resultBytes) ||
    envelope.resultBytes < 1 || envelope.resultBytes > 1048576 ||
    Buffer.byteLength(envelope.inputJson) > 1048576) fail();
const bytes = Buffer.from(envelope.moduleBase64, "base64");
if (bytes.length > 1048576 || bytes.toString("base64") !== envelope.moduleBase64 ||
    crypto.createHash("sha256").update(bytes).digest("hex") !== envelope.moduleDigest ||
    crypto.createHash("sha256").update(envelope.inputJson).digest("hex") !== envelope.inputDigest) fail();
// Read-only stdin and in-memory immutable module bytes; no candidate extraction.
try {
  const module = await import("data:text/javascript;base64," + envelope.moduleBase64);
  if (typeof module.normalizeReceiptJson !== "function") fail();
  const value = await module.normalizeReceiptJson(envelope.inputJson);
  if (typeof value !== "string" || Buffer.byteLength(value) > envelope.resultBytes) fail();
  // The container's stdout is entirely untrusted output. The controller applies
  // its own byte ceiling and parses exactly one JSON value; metadata never comes
  // from this stream. A candidate cannot manufacture a trusted execution receipt.
  JSON.parse(value);
  fs.writeSync(1, value);
} catch (error) {
  // Only a candidate's explicit validation classification is distinguished.
  // Never return its error text/stack (it may contain protected evaluation input).
  // A failing import/crash/other exception must not pass a negative test case.
  const descriptor = error && typeof error === "object" ? Object.getOwnPropertyDescriptor(error,"code") : null;
  process.exitCode = descriptor && "value" in descriptor && descriptor.value === "SCHEMA_INVALID" ? 65 : 70;
}
`;

/** Default-deny outer policy. Trusted timeout/setpriv run before the candidate
 * filter. The additional filter below removes process creation in the candidate.
 * This is an admission candidate, NOT an independently qualified profile. */
export const FOUNDRY_DOCKER_SECCOMP = Object.freeze({
  defaultAction: "SCMP_ACT_ERRNO",
  defaultErrnoRet: 1,
  syscalls: [
    {
      names: [
        "access",
        "alarm",
        "arch_prctl",
        "brk",
        "capget",
        "capset",
        "chdir",
        "chmod",
        "clock_getres",
        "clock_gettime",
        "clock_nanosleep",
        "close",
        "close_range",
        "dup",
        "dup2",
        "dup3",
        "epoll_create",
        "epoll_create1",
        "epoll_ctl",
        "epoll_pwait",
        "epoll_pwait2",
        "epoll_wait",
        "eventfd",
        "eventfd2",
        "execve",
        "execveat",
        "exit",
        "exit_group",
        "faccessat",
        "faccessat2",
        "fchmod",
        "fchmodat",
        "fcntl",
        "fdatasync",
        "flock",
        "fork",
        "fstat",
        "fstatfs",
        "fsync",
        "ftruncate",
        "futex",
        "futex_time64",
        "getcwd",
        "getdents",
        "getdents64",
        "getegid",
        "geteuid",
        "getgid",
        "getgroups",
        "getitimer",
        "getpeername",
        "getpgid",
        "getpgrp",
        "getpid",
        "getppid",
        "getrandom",
        "getresgid",
        "getresuid",
        "getrlimit",
        "getrusage",
        "getsid",
        "gettid",
        "gettimeofday",
        "getuid",
        "ioctl",
        "kill",
        "lseek",
        "lstat",
        "madvise",
        "membarrier",
        "mincore",
        "mkdir",
        "mkdirat",
        "mmap",
        "mprotect",
        "mremap",
        "munmap",
        "nanosleep",
        "newfstatat",
        "open",
        "openat",
        "openat2",
        "pipe",
        "pipe2",
        "poll",
        "ppoll",
        "prctl",
        "pread64",
        "preadv",
        "preadv2",
        "prlimit64",
        "pselect6",
        "pwrite64",
        "pwritev",
        "pwritev2",
        "read",
        "readlink",
        "readlinkat",
        "readv",
        "rename",
        "renameat",
        "renameat2",
        "restart_syscall",
        "rmdir",
        "rseq",
        "rt_sigaction",
        "rt_sigpending",
        "rt_sigprocmask",
        "rt_sigqueueinfo",
        "rt_sigreturn",
        "rt_sigsuspend",
        "rt_sigtimedwait",
        "rt_tgsigqueueinfo",
        "sched_getaffinity",
        "sched_getparam",
        "sched_getscheduler",
        "sched_yield",
        "seccomp",
        "select",
        "set_robust_list",
        "set_tid_address",
        "setgid",
        "setgroups",
        "setitimer",
        "setpgid",
        "setregid",
        "setresgid",
        "setresuid",
        "setreuid",
        "setrlimit",
        "setsid",
        "setuid",
        "sigaltstack",
        "stat",
        "statfs",
        "statx",
        "sysinfo",
        "tgkill",
        "timer_create",
        "timer_delete",
        "timer_getoverrun",
        "timer_gettime",
        "timer_settime",
        "times",
        "tkill",
        "truncate",
        "umask",
        "uname",
        "unlink",
        "unlinkat",
        "utimensat",
        "vfork",
        "wait4",
        "waitid",
        "write",
        "writev",
      ],
      action: "SCMP_ACT_ALLOW",
    },
    {
      names: ["clone"],
      action: "SCMP_ACT_ALLOW",
      // No new namespace flags. The child filter additionally requires CLONE_THREAD.
      args: [{ index: 0, value: 2114060288, valueTwo: 0, op: "SCMP_CMP_MASKED_EQ" }],
    },
    // Modern glibc probes clone3 and falls back to clone only on ENOSYS. Its
    // struct pointer cannot be safely filtered by ordinary seccomp BPF.
    { names: ["clone3"], action: "SCMP_ACT_ERRNO", errnoRet: 38 },
  ],
});

/** Raw Linux sock_filter bytecode for setpriv --seccomp-filter. This is an
 * additional filter, intersected with the immutable outer default-deny policy.
 * No generated source is compiled or executed to construct these bytes. */
export function foundryDockerChildFilter(architecture: "arm64" | "x64"): Uint8Array {
  const arch = architecture === "arm64" ? 0xc00000b7 : 0xc000003e;
  const clone = architecture === "arm64" ? 220 : 56;
  const instructions: [number, number, number, number][] = [
    [0x20, 0, 0, 4], // Load seccomp_data.arch.
    [0x15, 1, 0, arch],
    [0x06, 0, 0, 0x80000000], // Wrong ABI: KILL_PROCESS (also denies x32).
    [0x20, 0, 0, 0], // Load syscall number.
    [0x15, 0, 1, 435], // clone3 cannot filter its pointed struct.
    [0x06, 0, 0, 0x00050026], // ERRNO(ENOSYS) for pthread fallback.
  ];
  if (architecture === "x64") {
    for (const number of [57, 58]) {
      // fork, vfork.
      instructions.push([0x15, 0, 1, number], [0x06, 0, 0, 0x00050001]);
    }
    // x32 uses the same audit architecture with a syscall high bit.
    instructions.push([0x45, 0, 1, 0x40000000], [0x06, 0, 0, 0x80000000]);
  }
  instructions.push(
    [0x15, 1, 0, clone],
    [0x06, 0, 0, 0x7fff0000], // Others retain the outer Docker allowlist.
    [0x20, 0, 0, 16], // Low 32 bits of args[0] (clone flags).
    [0x45, 1, 0, 65536], // CLONE_THREAD is mandatory.
    [0x06, 0, 0, 0x00050001],
    [0x06, 0, 0, 0x7fff0000],
  );
  const bytes = Buffer.alloc(instructions.length * 8);
  for (let i = 0; i < instructions.length; i++) {
    const [code, jt, jf, k] = instructions[i]!;
    bytes.writeUInt16LE(code, i * 8);
    bytes.writeUInt8(jt, i * 8 + 2);
    bytes.writeUInt8(jf, i * 8 + 3);
    bytes.writeUInt32LE(k, i * 8 + 4);
  }
  return bytes;
}
