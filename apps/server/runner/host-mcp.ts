import { createHash } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import {
  HOST_MCP_LIMITS,
  type HostMcpAccess,
  type HostMcpBinding,
  type HostMcpOutput,
  type HostMcpReply,
  type HostMcpRequest,
  type HostMcpTool,
  hostMcpOutput,
  isHostMcpRequest,
  isHostMcpToolName,
} from "@agenteschat/adapters";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { HostMcpConfig } from "./config";
import { RunnerError } from "./errors";

type Profile = {
  id: string;
  label: string;
  enabled: boolean;
  kind: "general" | "phone";
  command: string;
  args: string[];
  cwd: string;
  commandSha256: string;
  artifacts: { path: string; sha256: string }[];
  envNames: string[];
  agents: Record<string, Record<string, HostMcpAccess>>;
  timeoutMs: number;
};
type Entry = {
  key: string;
  binding: string;
  runId: string;
  callId: string;
  argsHash: string;
  state: "dispatched" | "unknown" | "completed" | "reconciled";
  decision?: string;
};
const sha = (s: Uint8Array | string) => createHash("sha256").update(s).digest("hex");
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const ident = (s: unknown): s is string => typeof s === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(s);
const hash = (s: unknown): s is string => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
const abs = (s: unknown): s is string =>
  typeof s === "string" && path.isAbsolute(s) && s.length <= 4096 && !s.includes("\0");
function fail(s: string): never {
  throw new RunnerError("not_allowed", `Host MCP ${s}`);
}
const inside = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
};
/** A registry pins reviewed installed code, never an interpreter's search in an agent's working directory. */
async function launchArgs(p: Profile, command: Uint8Array): Promise<string[]> {
  const pinned = (file: string | undefined): file is string =>
    !!file && abs(file) && p.artifacts.some((a) => a.path === file) && !inside(p.cwd, file);
  if (inside(p.cwd, p.command)) fail("launch contract: command must be outside cwd");
  const name = path
    .basename(p.command)
    .toLowerCase()
    .replace(/\.exe$/, "");
  if (/^(?:node|nodejs|bun)(?:\d+(?:\.\d+)*)?$/.test(name)) {
    if (!pinned(p.args[0])) fail("launch contract: absolute pinned entrypoint outside cwd required");
    // Bun otherwise discovers executable preloads, macros, tsconfig paths and .env in cwd.
    return name.startsWith("bun")
      ? [
          "--no-env-file",
          "--no-install",
          "--no-macros",
          "--config=/dev/null",
          "--tsconfig-override=/dev/null",
          ...p.args,
        ]
      : p.args;
  }
  if (/^(?:python|pypy)(?:\d+(?:\.\d+)*)?$/.test(name)) {
    if (p.args[0] !== "-I" || !pinned(p.args[1]))
      fail("launch contract: Python requires -I and an absolute pinned entrypoint outside cwd");
    return p.args;
  }
  const head = Buffer.from(command.subarray(0, 512)).toString("utf8");
  if (head.startsWith("#!")) {
    const interpreter = /^#!\s*(\/[^\s]+)\s*\r?\n/.exec(head)?.[1];
    if (p.args.length || !interpreter || !p.artifacts.some((a) => a.path === interpreter))
      fail("launch contract: fixed wrapper requires no args and a pinned absolute shebang interpreter");
    return [];
  }
  if (
    /^(?:[a-z]*sh|env|npm|npx|pnpm|yarn|uv|uvx|deno|ruby|perl|php|java|lua|rscript|pwsh|powershell|dotnet|tsx|ts-node)$/.test(
      name,
    )
  )
    fail("launch contract: unsupported dynamic launcher; use a fixed reviewed wrapper");
  const magic = Buffer.from(command.subarray(0, 4)).toString("hex");
  if (
    !["7f454c46", "feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca"].includes(magic) &&
    !(command[0] === 0x4d && command[1] === 0x5a)
  )
    fail("launch contract: unsupported executable format");
  // A renamed interpreter is still a native executable. No loader flags, paths or cwd files may select its code.
  if (p.args.some((arg) => !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(arg)) || (await readdir(p.cwd)).length)
    fail("launch contract: native application words require an empty cwd; use a fixed reviewed wrapper otherwise");
  // Standalone MCP binaries retain simple application arguments, for example the `mcp` subcommand.
  return p.args;
}
export const profileRevision = (p: unknown) => sha(JSON.stringify(p));
function profiles(raw: unknown): Profile[] {
  if (
    !object(raw) ||
    raw.version !== 1 ||
    Object.keys(raw).some((k) => !["version", "profiles"].includes(k)) ||
    !Array.isArray(raw.profiles) ||
    raw.profiles.length > 100
  )
    fail("registry invalid");
  const out: Profile[] = [];
  const ids = new Set<string>();
  for (const p of raw.profiles) {
    if (
      !object(p) ||
      Object.keys(p).some(
        (k) =>
          ![
            "id",
            "label",
            "enabled",
            "kind",
            "command",
            "args",
            "cwd",
            "commandSha256",
            "artifacts",
            "envNames",
            "agents",
            "timeoutMs",
          ].includes(k),
      ) ||
      !ident(p.id) ||
      ids.has(p.id) ||
      typeof p.label !== "string" ||
      p.label.length > 100 ||
      typeof p.enabled !== "boolean" ||
      !["general", "phone"].includes(String(p.kind)) ||
      !abs(p.command) ||
      !abs(p.cwd) ||
      !hash(p.commandSha256) ||
      !Array.isArray(p.args) ||
      p.args.length > 64 ||
      !p.args.every((a) => typeof a === "string" && a.length < 4096 && !a.includes("\0")) ||
      !Array.isArray(p.artifacts) ||
      p.artifacts.length > 100 ||
      !p.artifacts.every((a) => object(a) && Object.keys(a).length === 2 && abs(a.path) && hash(a.sha256)) ||
      !Array.isArray(p.envNames) ||
      !p.envNames.every(
        (n) =>
          typeof n === "string" &&
          /^[A-Z_][A-Z0-9_]{0,99}$/.test(n) &&
          !/^(?:NODE_OPTIONS$|NODE_PATH$|PYTHONPATH$|PYTHONHOME$|LD_|DYLD_|BUN_OPTIONS$|BASH_ENV$|ENV$|ZDOTDIR$|RUBYOPT$|PERL5OPT$|GCONV_PATH$)/.test(
            n,
          ),
      ) ||
      !object(p.agents) ||
      !Number.isInteger(p.timeoutMs) ||
      Number(p.timeoutMs) < 100 ||
      Number(p.timeoutMs) > 120000
    )
      fail("registry profile invalid");
    for (const [agent, tools] of Object.entries(p.agents))
      if (
        !ident(agent) ||
        !object(tools) ||
        Object.entries(tools).some(
          ([t, a]) => !isHostMcpToolName(t) || !["read", "approval", "off"].includes(String(a)),
        )
      )
        fail("registry tool policy invalid");
    // Absolute script/config arguments must also be immutable reviewed artifacts. No shell expansion occurs.
    for (const arg of p.args as string[])
      if (path.isAbsolute(arg) && !(p.artifacts as { path: string }[]).some((a) => a.path === arg))
        fail("argument artifact is not pinned");
    ids.add(p.id);
    out.push(p as Profile);
  }
  return out;
}
interface Session {
  client: Client;
  transport: StdioClientTransport;
  busy: boolean;
}
export class HostMcpManager {
  private sessions = new Map<string, Promise<Session>>();
  private cache = new Map<string, HostMcpOutput>();
  private entries: Entry[] = [];
  private initialized = false;
  private closed = false;
  private lock = false;
  private serial: Promise<unknown> = Promise.resolve();
  private closing?: Promise<void>;
  private disconnecting?: Promise<void>;
  private pending = new Set<Promise<HostMcpReply>>();
  private generation = 0;
  private generationAbort = new AbortController();
  private journalFailed = false;
  constructor(
    private o: {
      home: string;
      machineId: string;
      orgId?: string;
      phonesDisabled?: boolean;
      systemMode?: boolean;
      config?: HostMcpConfig;
    },
  ) {}
  private async privateFile(file: string) {
    const s = await lstat(file);
    if (!s.isFile() || s.isSymbolicLink() || (s.mode & 0o077) !== 0 || (process.getuid && s.uid !== process.getuid()))
      fail("registry/journal must be a private owner file");
  }
  private async registry() {
    if (this.closed) fail("manager closed");
    if (!this.o.config?.enabled) fail("disabled");
    if (this.o.systemMode) fail("unsupported in system mode");
    await this.privateFile(this.o.config.registry);
    if ((await lstat(this.o.config.registry)).size > 1024 * 1024) fail("registry size limit");
    const raw = await readFile(this.o.config.registry);
    if (sha(raw) !== this.o.config.sha256) fail("registry revision changed");
    return profiles(JSON.parse(raw.toString()));
  }
  private async init() {
    if (this.initialized) return;
    const dir = path.join(this.o.home, "host-mcp");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const s = await lstat(dir);
    if (
      s.isSymbolicLink() ||
      !s.isDirectory() ||
      (s.mode & 0o077) !== 0 ||
      (process.getuid && s.uid !== process.getuid())
    )
      fail("journal directory must be private");
    try {
      const h = await open(path.join(dir, "lock"), "wx", 0o600);
      await h.writeFile(String(process.pid));
      await h.sync();
      await h.close();
      this.lock = true;
    } catch {
      fail("journal locked; owner reconciliation required");
    }
    try {
      const f = path.join(dir, "journal.json");
      await this.privateFile(f);
      if ((await lstat(f)).size > 10 * 1024 * 1024) fail("journal size limit");
      const j = JSON.parse(await readFile(f, "utf8"));
      if (
        !Array.isArray(j) ||
        j.length > 10000 ||
        j.some(
          (e) =>
            !object(e) ||
            !hash(e.key) ||
            !hash(e.binding) ||
            !hash(e.argsHash) ||
            !ident(e.runId) ||
            !ident(e.callId) ||
            !["dispatched", "unknown", "completed", "reconciled"].includes(String(e.state)),
        )
      )
        fail("journal invalid");
      this.entries = j.map((e: Entry) => ({ ...e, state: e.state === "dispatched" ? "unknown" : e.state }));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    this.initialized = true;
    await this.save();
  }
  private async save() {
    try {
      const dir = path.join(this.o.home, "host-mcp");
      const tmp = path.join(dir, `journal-${crypto.randomUUID()}.tmp`);
      const h = await open(tmp, "wx", 0o600);
      try {
        await h.writeFile(JSON.stringify(this.entries));
        await h.sync();
      } finally {
        await h.close();
      }
      await rename(tmp, path.join(dir, "journal.json"));
      const d = await open(dir, "r");
      try {
        await d.sync();
      } finally {
        await d.close();
      }
    } catch {
      if (!this.journalFailed) {
        this.journalFailed = true;
        this.generation++;
        this.generationAbort.abort();
      }
      fail("journal persistence failed; owner attention required");
    }
  }
  private transaction<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.serial.then(fn, fn);
    this.serial = next.catch(() => {});
    return next;
  }
  private binding(r: HostMcpBinding) {
    return sha(JSON.stringify([r.orgId, r.machineId, r.profileId, r.agentId]));
  }
  private async pinned(p: Profile) {
    if ((await realpath(p.cwd)) !== p.cwd) fail("cwd identity changed");
    for (const a of [{ path: p.command, sha256: p.commandSha256 }, ...p.artifacts]) {
      const s = await lstat(a.path);
      if (
        s.isSymbolicLink() ||
        !s.isFile() ||
        (await realpath(a.path)) !== a.path ||
        sha(await readFile(a.path)) !== a.sha256
      )
        fail("artifact identity changed");
    }
    return launchArgs(p, await readFile(p.command));
  }
  private async session(p: Profile, key: string, generation: number, signal: AbortSignal): Promise<Session> {
    if (signal.aborted || generation !== this.generation) fail("session disconnected before dispatch");
    let hit = this.sessions.get(key);
    if (hit) return hit;
    hit = (async () => {
      const args = await this.pinned(p);
      if (generation !== this.generation) fail("session disconnected before dispatch");
      const env: Record<string, string> = {};
      for (const n of p.envNames) {
        const value = process.env[n];
        if (value !== undefined) env[n] = value;
      }
      const transport = new StdioClientTransport({ command: p.command, args, cwd: p.cwd, env, stderr: "pipe" });
      transport.stderr?.on("data", () => {});
      const client = new Client(
        { name: "agentes-host-mcp", version: "1" },
        {
          jsonSchemaValidator: {
            getValidator: () => (input) => ({ valid: true, data: input as never, errorMessage: undefined }),
          },
        },
      );
      try {
        await client.connect(transport, { timeout: p.timeoutMs, signal });
        if (generation !== this.generation) {
          await client.close();
          fail("session disconnected before dispatch");
        }
        transport.stderr?.on("data", () => {});
        return { client, transport, busy: false };
      } catch {
        await transport.close().catch(() => {});
        fail("server initialization failed");
      }
    })();
    this.sessions.set(key, hit);
    try {
      return await hit;
    } catch (e) {
      this.sessions.delete(key);
      throw e;
    }
  }
  private async drop(key: string) {
    const s = this.sessions.get(key);
    this.sessions.delete(key);
    if (s) await s.then((x) => x.client.close()).catch(() => {});
  }
  request(raw: unknown, signal?: AbortSignal): Promise<HostMcpReply> {
    if (this.closed) return Promise.reject(new RunnerError("not_allowed", "Host MCP manager closed"));
    const generation = this.generation;
    const reconnecting = this.disconnecting;
    const operationSignal = signal
      ? AbortSignal.any([signal, this.generationAbort.signal])
      : this.generationAbort.signal;
    const task = (async () => {
      await reconnecting;
      try {
        return await this.runRequest(raw, operationSignal, generation);
      } catch (error) {
        if (this.journalFailed) {
          await Promise.all([...this.sessions.keys()].map((k) => this.drop(k)));
          fail("journal persistence failed; owner attention required");
        }
        if (error instanceof RunnerError) throw error;
        throw new RunnerError("not_allowed", "Host MCP request failed; inspect owner configuration or provider state");
      }
    })();
    this.pending.add(task);
    void task.then(
      () => this.pending.delete(task),
      () => this.pending.delete(task),
    );
    return task;
  }
  private async runRequest(raw: unknown, signal: AbortSignal, generation: number): Promise<HostMcpReply> {
    if (!isHostMcpRequest(raw)) fail("bad request");
    const r: HostMcpRequest = raw;
    if (r.machineId !== this.o.machineId || r.orgId !== this.o.orgId) fail("binding mismatch");
    const list = await this.registry();
    if (r.action === "profiles")
      return {
        profiles: list.map((p) => ({
          id: p.id,
          label: p.label,
          enabled: p.enabled && p.kind !== "phone",
          kind: p.kind,
          revision: profileRevision(p),
        })),
      };
    const p = list.find((p) => p.id === r.profileId);
    if (!p?.enabled) fail("profile disabled");
    if (profileRevision(p) !== r.revision) fail("profile revision mismatch");
    if (p.kind === "phone")
      fail(
        this.o.phonesDisabled
          ? "phonesDisabled: phone profile is off"
          : "native phone policy requires a separately qualified opt-in migration",
      );
    if (!p.agents[r.agentId]) fail("agent denied");
    const binding = this.binding(r);
    const sessionKey = `${binding}:${r.revision}`;
    if (r.action === "close") {
      await Promise.all([...this.sessions.keys()].filter((k) => k.startsWith(`${binding}:`)).map((k) => this.drop(k)));
      return { closed: true };
    }
    if (r.action === "reconcile")
      return this.transaction(async () => {
        await this.init();
        const e = this.entries.find((e) => e.binding === binding && e.runId === r.runId && e.callId === r.callId);
        if (!e || !["unknown", "dispatched"].includes(e.state)) fail("no unknown call");
        if ([...this.sessions.keys()].some((k) => k.startsWith(`${binding}:`)))
          fail("close the session before reconciliation");
        e.state = "reconciled";
        e.decision = r.decision;
        await this.save();
        return { reconciled: true };
      });
    if (this.journalFailed) fail("journal persistence failed; owner attention required");
    await this.transaction(() => this.init());
    await this.pinned(p);
    if (signal?.aborted) fail("canceled before dispatch");
    if (generation !== this.generation) fail("session disconnected before dispatch");
    if (r.action === "catalog") {
      const s = await this.session(p, sessionKey, generation, signal);
      if (signal.aborted || generation !== this.generation) fail("session disconnected before dispatch");
      const tools: HostMcpTool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        if (signal.aborted || generation !== this.generation) fail("session disconnected before dispatch");
        const listed = await s.client.listTools(cursor ? { cursor } : undefined, { signal, timeout: p.timeoutMs });
        for (const t of listed.tools) {
          if (!isHostMcpToolName(t.name) || !object(t.inputSchema)) fail("catalog invalid");
          tools.push({
            name: t.name,
            description: t.description ?? t.name,
            inputSchema: t.inputSchema,
            access: p.agents[r.agentId]?.[t.name] ?? "off",
          });
        }
        if (tools.length > HOST_MCP_LIMITS.tools) fail("catalog limit exceeded");
        cursor = listed.nextCursor;
        if (!cursor) break;
      }
      if (cursor) fail("catalog incomplete");
      if (Buffer.byteLength(JSON.stringify(tools)) > HOST_MCP_LIMITS.resultBytes) fail("catalog size limit");
      return { tools };
    }
    const access = p.agents[r.agentId]?.[r.tool] ?? "off";
    if (access === "off") fail("tool denied");
    if (access === "approval" && r.approved !== true) fail("tool requires approval");
    const argsHash = sha(JSON.stringify([r.revision, r.tool, r.args]));
    const key = sha(JSON.stringify([binding, r.runId, r.callId]));
    const cached = await this.transaction(async () => {
      await this.init();
      const old = this.entries.find((e) => e.key === key);
      if (old) {
        if (old.argsHash !== argsHash) fail("call identity changed");
        const result = this.cache.get(key);
        if (result) return result;
        if (old.state === "unknown" || old.state === "dispatched") fail("unknown call requires reconciliation");
        fail("completed result unavailable; never replay");
      }
      if (this.entries.some((e) => e.binding === binding && (e.state === "unknown" || e.state === "dispatched")))
        fail("unknown call requires reconciliation");
      if (this.entries.length >= 10000) fail("journal capacity requires owner archive");
      this.entries.push({ key, binding, runId: r.runId, callId: r.callId, argsHash, state: "dispatched" });
      await this.save();
      return null;
    });
    if (cached) return cached;
    try {
      const s = await this.session(p, sessionKey, generation, signal);
      if (signal.aborted || generation !== this.generation) fail("session disconnected before dispatch");
      if (s.busy) throw new Error("busy");
      s.busy = true;
      let result: unknown;
      try {
        result = await s.client.callTool({ name: r.tool, arguments: r.args }, undefined, {
          signal,
          timeout: p.timeoutMs,
        });
      } finally {
        s.busy = false;
      }
      let out: HostMcpOutput;
      try {
        out = hostMcpOutput(result);
      } catch {
        out = {
          content:
            "Host MCP completed-output-rejected: unsupported, invalid or oversized content. Do not repeat the action to recover its output.",
          isError: true,
        };
      }
      await this.transaction(async () => {
        const e = this.entries.find((e) => e.key === key);
        if (!e) fail("journal call missing");
        e.state = "completed";
        await this.save();
        this.cache.set(key, out);
        while (
          [...this.cache.values()].reduce((n, r) => n + Buffer.byteLength(JSON.stringify(r)), 0) > 16 * 1024 * 1024 ||
          this.cache.size > 100
        ) {
          const first = this.cache.keys().next().value;
          if (first === undefined) break;
          this.cache.delete(first);
        }
      });
      return out;
    } catch {
      try {
        await this.transaction(async () => {
          const e = this.entries.find((e) => e.key === key);
          if (!e) fail("journal call missing");
          e.state = "unknown";
          await this.save();
        });
      } finally {
        await this.drop(sessionKey);
      }
      fail("unknown delivery; owner reconciliation required, do not replay");
    }
  }
  /** Network loss closes only owned stdio clients, never a shared provider daemon. Active calls become unknown. */
  disconnect(): Promise<void> {
    if (this.disconnecting) return this.disconnecting;
    this.generation++;
    this.generationAbort.abort();
    this.generationAbort = new AbortController();
    const active = [...this.pending];
    const work = (async () => {
      try {
        await this.transaction(async () => {
          if (this.initialized) {
            for (const e of this.entries) if (e.state === "dispatched") e.state = "unknown";
            await this.save();
          }
        });
      } finally {
        await Promise.all([...this.sessions.keys()].map((k) => this.drop(k)));
        await Promise.allSettled(active);
      }
    })();
    this.disconnecting = work;
    void work.then(
      () => {
        this.disconnecting = undefined;
      },
      () => {
        this.disconnecting = undefined;
      },
    );
    return work;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = this.finishClose();
    return this.closing;
  }
  private async finishClose() {
    this.closed = true;
    try {
      await this.disconnect();
    } finally {
      this.cache.clear();
      if (this.lock && !this.journalFailed) {
        await unlink(path.join(this.o.home, "host-mcp", "lock"));
        this.lock = false;
      }
    }
  }
}
