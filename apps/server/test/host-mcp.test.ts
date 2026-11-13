import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeStored } from "../runner/config";
import { HostMcpManager, profileRevision } from "../runner/host-mcp";

const roots: string[] = [];
const managers: HostMcpManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.close()));
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
async function fixture(kind = "general") {
  const home = await mkdtemp(path.join(os.tmpdir(), "ac-host-mcp-"));
  roots.push(home);
  await chmod(home, 0o700);
  const command = await realpath(process.execPath);
  const script = await realpath(path.resolve("apps/server/test/fixtures/host-mcp-server.mjs"));
  const p = {
    id: "fixture",
    label: "Fixture",
    enabled: true,
    kind,
    command,
    args: [script],
    cwd: await realpath(home),
    commandSha256: sha(await readFile(command)),
    artifacts: [{ path: script, sha256: sha(await readFile(script)) }],
    envNames: [],
    agents: { agent: { tool_0: "read", tool_1: "approval" }, peer: { tool_0: "read" } },
    timeoutMs: 2000,
  };
  const file = path.join(home, "registry.json");
  const raw = JSON.stringify({ version: 1, profiles: [p] });
  await writeFile(file, raw, { mode: 0o600 });
  const options = {
    home,
    machineId: "machine",
    orgId: "org",
    phonesDisabled: true,
    config: { enabled: true as const, registry: file, sha256: sha(raw) },
  };
  const manager = new HostMcpManager(options);
  managers.push(manager);
  const bound = {
    orgId: "org",
    machineId: "machine",
    agentId: "agent",
    profileId: "fixture",
    revision: profileRevision(p),
  };
  return { manager, options, bound, file, p };
}
test("host MCP is off by default, config survives normalization, private registry is pinned", async () => {
  const m = new HostMcpManager({ home: "/unused", machineId: "machine", orgId: "org", phonesDisabled: true });
  managers.push(m);
  await expect(m.request({ action: "profiles", orgId: "org", machineId: "machine", actorId: "human" })).rejects.toThrow(
    "disabled",
  );
  const f = await fixture();
  expect(normalizeStored({ hostMcp: f.options.config }).hostMcp).toEqual(f.options.config);
  await chmod(f.file, 0o644);
  await expect(
    f.manager.request({ action: "profiles", orgId: "org", machineId: "machine", actorId: "human" }),
  ).rejects.toThrow("private");
});
test("real SDK stdio returns the complete 70-tool catalog and exact PNG bytes; policy is per agent/tool", async () => {
  const { manager, bound } = await fixture();
  const list = await manager.request({ ...bound, action: "catalog" });
  expect(list.tools).toHaveLength(70);
  const out = await manager.request({
    ...bound,
    action: "call",
    runId: "run",
    callId: "one",
    tool: "tool_0",
    args: {},
  });
  expect(out.content).toBe("pixels from real stdio");
  expect(out.images?.[0]?.data).toContain("iVBOR");
  expect(out.images?.[0]?.mediaType).toBe("image/png");
  expect(
    await manager.request({ ...bound, action: "call", runId: "run", callId: "one", tool: "tool_0", args: {} }),
  ).toEqual(out);
  await expect(
    manager.request({ ...bound, action: "call", runId: "run", callId: "two", tool: "tool_2", args: {} }),
  ).rejects.toThrow("denied");
  await expect(
    manager.request({ ...bound, action: "call", runId: "run", callId: "three", tool: "tool_1", args: {} }),
  ).rejects.toThrow("approval");
  await expect(manager.request({ ...bound, agentId: "other", action: "catalog" })).rejects.toThrow("denied");
  await expect(manager.request({ ...bound, orgId: "foreign", action: "catalog" })).rejects.toThrow("binding");
  await expect(manager.request({ ...bound, revision: "0".repeat(64), action: "catalog" })).rejects.toThrow("revision");
});
test("unknown dispatch fences new IDs durably, no replay after restart, human reconciliation is explicit", async () => {
  const f = await fixture();
  await expect(
    f.manager.request({
      ...f.bound,
      action: "call",
      runId: "run",
      callId: "unknown",
      tool: "tool_0",
      args: { exit: true },
    }),
  ).rejects.toThrow("unknown");
  await f.manager.close();
  const m = new HostMcpManager(f.options);
  managers.push(m);
  await expect(
    m.request({ ...f.bound, action: "call", runId: "run", callId: "again", tool: "tool_0", args: {} }),
  ).rejects.toThrow("reconciliation");
  const receipt = await m.request({
    ...f.bound,
    action: "reconcile",
    actorId: "human",
    callId: "unknown",
    runId: "run",
    decision: "observed_completed",
  });
  expect(receipt.reconciled).toBe(true);
  await expect(
    m.request({ ...f.bound, action: "call", runId: "run", callId: "unknown", tool: "tool_0", args: { exit: true } }),
  ).rejects.toThrow("unavailable");
  const state = await readFile(path.join(f.options.home, "host-mcp", "journal.json"), "utf8");
  expect(state).not.toContain("exit");
  expect(state).not.toContain("iVBOR");
});
test("phonesDisabled and system mode refuse profiles before spawning; changed artifact pins refuse", async () => {
  const f = await fixture("phone");
  await expect(f.manager.request({ ...f.bound, action: "catalog" })).rejects.toThrow("phonesDisabled");
  const g = await fixture();
  const m = new HostMcpManager({ ...g.options, systemMode: true });
  managers.push(m);
  await expect(m.request({ ...g.bound, action: "catalog" })).rejects.toThrow("system");
  const raw = JSON.stringify({ version: 1, profiles: [{ ...g.p, commandSha256: "0".repeat(64) }] });
  await writeFile(g.file, raw);
  const bad = new HostMcpManager({ ...g.options, config: { ...g.options.config, sha256: sha(raw) } });
  managers.push(bad);
  await expect(
    bad.request({
      ...g.bound,
      revision: profileRevision({ ...g.p, commandSha256: "0".repeat(64) }),
      action: "catalog",
    }),
  ).rejects.toThrow("artifact");
});
test("interpreter launch refuses relative scripts and dynamic code selection before spawning", async () => {
  for (const args of [
    ["apps/server/test/fixtures/host-mcp-server.mjs"],
    ["--preload", path.resolve("apps/server/test/fixtures/host-mcp-server.mjs")],
    ["--eval", "throw new Error('must not execute')"],
    ["run", path.resolve("apps/server/test/fixtures/host-mcp-server.mjs")],
  ]) {
    const f = await fixture();
    await f.manager.close();
    const p = { ...f.p, args };
    const raw = JSON.stringify({ version: 1, profiles: [p] });
    await writeFile(f.file, raw);
    const m = new HostMcpManager({ ...f.options, config: { ...f.options.config, sha256: sha(raw) } });
    managers.push(m);
    await expect(m.request({ ...f.bound, revision: profileRevision(p), action: "catalog" })).rejects.toThrow(
      "launch contract",
    );
  }
});
test("Bun cwd preloads, environment and tsconfig cannot replace the pinned installed entrypoint", async () => {
  const f = await fixture();
  await writeFile(path.join(f.p.cwd, "bunfig.toml"), 'preload = ["./unreviewed.mjs"]\n');
  await writeFile(path.join(f.p.cwd, "unreviewed.mjs"), "throw new Error('cwd preload executed')\n");
  await writeFile(path.join(f.p.cwd, ".env"), "NODE_OPTIONS=--require=./unreviewed.mjs\n");
  await writeFile(path.join(f.p.cwd, "tsconfig.json"), '{"compilerOptions":{"paths":{"*": ["./unreviewed.mjs"]}}}');
  expect((await f.manager.request({ ...f.bound, action: "catalog" })).tools).toHaveLength(70);
});
test("fixed reviewed wrappers remain supported, but env shebangs and wrapper arguments refuse", async () => {
  const f = await fixture();
  await f.manager.close();
  const wrapper = path.join(await realpath(f.options.home), "fixed.sh");
  const cwd = path.join(await realpath(f.options.home), "empty-cwd");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(cwd);
  const shell = await realpath("/bin/sh");
  await writeFile(
    wrapper,
    `#!${shell}\nexec '${f.p.command}' --no-env-file --no-install --no-macros --config=/dev/null --tsconfig-override=/dev/null '${f.p.args[0]}'\n`,
    { mode: 0o700 },
  );
  const artifacts = [
    ...f.p.artifacts,
    { path: shell, sha256: sha(await readFile(shell)) },
    { path: f.p.command, sha256: f.p.commandSha256 },
  ];
  for (const [source, args, allowed] of [
    [await readFile(wrapper, "utf8"), [], true],
    [await readFile(wrapper, "utf8"), ["unreviewed"], false],
    ["#!/usr/bin/env sh\nexit 1\n", [], false],
  ] as const) {
    await writeFile(wrapper, source);
    const p = { ...f.p, command: wrapper, commandSha256: sha(source), artifacts, cwd, args: [...args] };
    const raw = JSON.stringify({ version: 1, profiles: [p] });
    await writeFile(f.file, raw);
    const m = new HostMcpManager({ ...f.options, config: { ...f.options.config, sha256: sha(raw) } });
    managers.push(m);
    const request = m.request({ ...f.bound, revision: profileRevision(p), action: "catalog" });
    if (allowed) expect((await request).tools).toHaveLength(70);
    else await expect(request).rejects.toThrow("launch contract");
    await m.close();
  }
});
test.skipIf(!Bun.which("python3"))(
  "Python module dispatch and nonisolated scripts refuse before spawning",
  async () => {
    const python = Bun.which("python3");
    if (!python) throw new Error("Python fixture runtime unavailable");
    const command = await realpath(python);
    for (const args of [["-m", "unreviewed"], [path.resolve("apps/server/test/fixtures/host-mcp-server.mjs")]]) {
      const f = await fixture();
      await f.manager.close();
      const p = { ...f.p, command, commandSha256: sha(await readFile(command)), args };
      const raw = JSON.stringify({ version: 1, profiles: [p] });
      await writeFile(f.file, raw);
      const m = new HostMcpManager({ ...f.options, config: { ...f.options.config, sha256: sha(raw) } });
      managers.push(m);
      await expect(m.request({ ...f.bound, revision: profileRevision(p), action: "catalog" })).rejects.toThrow(
        "launch contract",
      );
    }
  },
);
test("a renamed interpreter cannot use the generic native launch contract to preload cwd code", async () => {
  const { link, mkdir } = await import("node:fs/promises");
  const f = await fixture();
  await f.manager.close();
  const home = await realpath(f.options.home);
  const command = path.join(home, "native-alias");
  const cwd = path.join(home, "native-cwd");
  await link(f.p.command, command);
  await mkdir(cwd);
  await writeFile(path.join(cwd, "unreviewed.mjs"), "globalThis.unreviewed = true;\n");
  const p = { ...f.p, command, cwd, args: ["--preload=./unreviewed.mjs", ...f.p.args] };
  const raw = JSON.stringify({ version: 1, profiles: [p] });
  await writeFile(f.file, raw);
  const m = new HostMcpManager({ ...f.options, config: { ...f.options.config, sha256: sha(raw) } });
  managers.push(m);
  await expect(m.request({ ...f.bound, revision: profileRevision(p), action: "catalog" })).rejects.toThrow(
    "launch contract",
  );
});
test("completed calls never reexecute after restart; abort and disconnect fence the agent while another session survives", async () => {
  const f = await fixture();
  const call = { ...f.bound, action: "call" as const, runId: "run", callId: "done", tool: "tool_0", args: {} };
  await f.manager.request(call);
  await f.manager.close();
  const fresh = new HostMcpManager(f.options);
  managers.push(fresh);
  await expect(fresh.request(call)).rejects.toThrow("unavailable");
  await fresh.request({ ...f.bound, agentId: "peer", action: "catalog" });
  const controller = new AbortController();
  const pending = fresh.request({ ...call, callId: "cancel", args: { hang: true } }, controller.signal);
  const observed = pending.then(
    (value) => ({ value, error: undefined }),
    (error) => ({ value: undefined, error }),
  );
  let claimed = false;
  for (let i = 0; i < 200; i++) {
    const journal = JSON.parse(await readFile(path.join(f.options.home, "host-mcp", "journal.json"), "utf8"));
    if (journal.some((e: { callId: string }) => e.callId === "cancel")) {
      claimed = true;
      break;
    }
    await Bun.sleep(5);
  }
  expect(claimed).toBe(true);
  controller.abort();
  expect((await observed).error?.message).toContain("unknown");
  expect((await fresh.request({ ...call, agentId: "peer", callId: "peer-read" })).images?.[0]?.mediaType).toBe(
    "image/png",
  );
  await expect(fresh.request({ ...call, callId: "new" })).rejects.toThrow("reconciliation");
  await fresh.disconnect();
  await expect(fresh.request({ ...call, callId: "still-new" })).rejects.toThrow("reconciliation");
});
test("strict wire rejects command injection and changed arguments; disabled profiles never start", async () => {
  const f = await fixture();
  await expect(f.manager.request({ ...f.bound, action: "catalog", command: "/bin/sh" })).rejects.toThrow("bad request");
  const c = { ...f.bound, action: "call" as const, runId: "run", callId: "id", tool: "tool_0", args: {} };
  await f.manager.request(c);
  await expect(f.manager.request({ ...c, args: { different: true } })).rejects.toThrow("identity changed");
  const disabled = { ...f.p, enabled: false };
  const raw = JSON.stringify({ version: 1, profiles: [disabled] });
  await writeFile(f.file, raw);
  const m = new HostMcpManager({ ...f.options, config: { ...f.options.config, sha256: sha(raw) } });
  managers.push(m);
  await expect(m.request({ ...f.bound, revision: profileRevision(disabled), action: "catalog" })).rejects.toThrow(
    "disabled",
  );
});
test("provider catalog failures never expose their private error body", async () => {
  const f = await fixture();
  await f.manager.close();
  const p = { ...f.p, args: [...f.p.args, "catalog-secret-error"] };
  const raw = JSON.stringify({ version: 1, profiles: [p] });
  await writeFile(f.file, raw);
  const m = new HostMcpManager({ ...f.options, config: { ...f.options.config, sha256: sha(raw) } });
  managers.push(m);
  try {
    await m.request({ ...f.bound, revision: profileRevision(p), action: "catalog" });
    throw new Error("expected refusal");
  } catch (e) {
    expect((e as Error).message).not.toContain("synthetic-provider-key");
    expect((e as Error).message).toContain("request failed");
  }
});
test("a request admitted just before disconnect cannot spawn afterward; new catalog after reconnect works", async () => {
  const f = await fixture();
  const request = f.manager.request({ ...f.bound, action: "catalog" });
  const cleanup = f.manager.disconnect();
  await expect(request).rejects.toThrow("before dispatch");
  await cleanup;
  expect((await f.manager.request({ ...f.bound, action: "catalog" })).tools).toHaveLength(70);
});

type DebugManager = {
  save(): Promise<void>;
  sessions: Map<
    string,
    Promise<{ client: { callTool(...args: unknown[]): Promise<unknown> }; transport: { pid: number | null } }>
  >;
};
const gone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
};
test("journal persistence failure on disconnect still closes the real owned stdio child and faults new work", async () => {
  const f = await fixture();
  await f.manager.request({ ...f.bound, action: "catalog" });
  const debug = f.manager as unknown as DebugManager;
  const session = await [...debug.sessions.values()][0]!;
  const pid = session.transport.pid;
  if (!pid) throw new Error("no owned child pid");
  const dir = path.join(f.options.home, "host-mcp");
  try {
    await chmod(dir, 0o500);
    await expect(f.manager.disconnect()).rejects.toThrow("owner attention");
    expect(debug.sessions.size).toBe(0);
    expect(gone(pid)).toBe(true);
    await expect(f.manager.request({ ...f.bound, action: "catalog" })).rejects.toThrow("owner attention");
  } finally {
    await chmod(dir, 0o700);
  }
});
test("unknown journal-write failure closes owned child in finally and preserves no-replay owner attention", async () => {
  const f = await fixture();
  await f.manager.request({ ...f.bound, action: "catalog" });
  const debug = f.manager as unknown as DebugManager;
  const session = await [...debug.sessions.values()][0]!;
  const pid = session.transport.pid;
  if (!pid) throw new Error("no owned child pid");
  const dir = path.join(f.options.home, "host-mcp");
  session.client.callTool = async () => {
    await chmod(dir, 0o500);
    throw new Error("synthetic call failure");
  };
  try {
    await expect(
      f.manager.request({ ...f.bound, action: "call", runId: "run", callId: "fault", tool: "tool_0", args: {} }),
    ).rejects.toThrow("owner attention");
    expect(debug.sessions.size).toBe(0);
    expect(gone(pid)).toBe(true);
    await expect(
      f.manager.request({ ...f.bound, action: "call", runId: "run", callId: "new", tool: "tool_0", args: {} }),
    ).rejects.toThrow("owner attention");
  } finally {
    await chmod(dir, 0o700);
  }
});
test("a cached session cannot dispatch during a disconnect queued behind the durable claim", async () => {
  const f = await fixture();
  await f.manager.request({ ...f.bound, action: "catalog" });
  const debug = f.manager as unknown as DebugManager;
  const session = await [...debug.sessions.values()][0]!;
  let dispatches = 0;
  const realCall = session.client.callTool.bind(session.client);
  session.client.callTool = (...args) => {
    dispatches++;
    return realCall(...args);
  };
  const save = debug.save.bind(debug);
  let count = 0,
    claimStarted = false,
    unknownStarted = false;
  let releaseClaim = () => {},
    releaseUnknown = () => {};
  const claimGate = new Promise<void>((r) => {
      releaseClaim = r;
    }),
    unknownGate = new Promise<void>((r) => {
      releaseUnknown = r;
    });
  debug.save = async () => {
    count++;
    if (count === 1) {
      claimStarted = true;
      await claimGate;
    } else if (count === 2) {
      unknownStarted = true;
      await unknownGate;
    }
    await save();
  };
  const result = f.manager
    .request({ ...f.bound, action: "call", runId: "run", callId: "racing", tool: "tool_0", args: {} })
    .then(
      (value) => ({ value, error: undefined }),
      (error) => ({ value: undefined, error }),
    );
  for (let i = 0; i < 200 && !claimStarted; i++) await Bun.sleep(1);
  if (!claimStarted) throw new Error("claim not reached");
  const cleanup = f.manager.disconnect();
  releaseClaim();
  for (let i = 0; i < 200 && !unknownStarted; i++) await Bun.sleep(1);
  await Bun.sleep(5);
  const duringBlockedSave = dispatches;
  releaseUnknown();
  const out = await result;
  await cleanup;
  expect(duringBlockedSave).toBe(0);
  expect(dispatches).toBe(0);
  expect(out.error?.message).toContain("unknown");
});
