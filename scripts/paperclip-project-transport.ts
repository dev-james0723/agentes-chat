/** Explicit isolated integration fixture, never part of the network-free unit suite.
 * server: disposable Linux container, synthetic org/credentials/PGlite only.
 * mac <url>: native owner-local registry + real WS + real child cwd, synthetic brain only.
 */

import { execFile, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type HandlerContext, handleRequest } from "../apps/server/runner/handlers";
import { createPaperclipGateway } from "../apps/server/runner/paperclip-gateway";
import { registerOwnerProject } from "../apps/server/runner/paperclip-register";
import { MACHINE_PROTOCOL_VERSION, parseServerFrame } from "../packages/adapters/src/machine-protocol";
import { eq, schema } from "../packages/db/src";
import { createAgent } from "../packages/engine/src/agents";
import type { Brain } from "../packages/engine/src/brains/types";
import {
  paperclipProjectBrain,
  paperclipProjectHub,
  paperclipProjectRun,
} from "../packages/engine/src/paperclip-project-runtime";
import {
  createPaperclipMapping,
  dispatchPaperclipRoutine,
  setPaperclipMappingEnabled,
} from "../packages/engine/src/paperclip-routines";
import { disablePaperclipWorkspace, registerPaperclipWorkspace } from "../packages/engine/src/paperclip-workspaces";
import { executeRoutineRun, setRoutineActive } from "../packages/engine/src/routines";
import { setup } from "../packages/engine/test/fixtures";
import { pairMachine } from "../packages/engine/test/machine-fixtures";
import { routineDeps } from "../packages/engine/test/routine-fixtures";

const sha = (x: string | Buffer) => createHash("sha256").update(x).digest("hex");
const check = (condition: unknown, reason: string): asserts condition => {
  if (!condition) throw Error(reason);
};
const roles = ["director", "research", "brand", "interaction", "systems", "creative"];
const brains = ["claude_code", "claude_code", "claude_code", "claude_code", "codex", "codex"] as const;
const firingOwners = [0, 1, 2, 3, 4, 5, 0];

async function server() {
  const f = await setup({ machines: true });
  const hub = f.machineHub!;
  const paired = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, {
    name: "Disposable fixture Mac",
    os: "darwin",
    protocol: MACHINE_PROTOCOL_VERSION,
  });
  const agents = [];
  for (let i = 0; i < roles.length; i++) {
    const a =
      i === 0
        ? f.agent
        : await createAgent(
            f.db,
            f.owner.id,
            f.org.id,
            { name: roles[i]!, handle: `fixture-${roles[i]}`, instructions: "Fixture only." },
            { model: "claude-sonnet-5-5" },
          );
    const model = brains[i] === "codex" ? "gpt-6.1-sol" : "opus";
    await f.db
      .update(schema.agents)
      .set({
        ownerUserId: f.owner.id,
        machineId: paired.machineId,
        brain: brains[i],
        brainModel: model,
        brainFallback: false,
      })
      .where(eq(schema.agents.id, a.id));
    agents.push({ id: a.id, handle: a.handle, brain: brains[i]!, model });
  }
  const deps = { db: f.db, hub, enabled: true };
  let registration: Parameters<typeof registerPaperclipWorkspace>[3] | undefined;
  let running = false;
  const service = Bun.serve<{ connection?: ReturnType<typeof hub.open> }>({
    port: 8080,
    hostname: "0.0.0.0",
    async fetch(req, s) {
      try {
        const path = new URL(req.url).pathname;
        if (path === "/machine" && s.upgrade(req, { data: {} })) return undefined;
        if (path === "/bootstrap")
          return Response.json({
            orgId: f.org.id,
            ownerId: f.owner.id,
            machineId: paired.machineId,
            token: paired.token,
            agents,
          });
        if (path === "/register" && req.method === "POST") {
          registration = await req.json();
          return Response.json(await registerPaperclipWorkspace(deps, f.owner.id, f.org.id, registration));
        }
        if (path === "/run" && req.method === "POST") {
          check(registration && !running, "fixture can run only once");
          running = true;
          const b = registration as Awaited<ReturnType<typeof registerPaperclipWorkspace>>;
          const proxy = paperclipProjectHub(deps),
            results = [];
          for (let i = 0; i < firingOwners.length; i++) {
            const a = agents[firingOwners[i]!]!;
            const rd = { ...routineDeps(f), enabled: true };
            const mapping = await createPaperclipMapping(rd, f.owner.id, f.org.id, {
              sourceCompanyId: b.sourceCompanyId,
              sourceRoutineId: randomUUID(),
              sourceRevisionId: null,
              sourceActive: true,
              activityGatePolicy: "always",
              activityGateScope: "project",
              catchUpPolicy: "skip_missed",
              triggers: [],
              policy: "always_enqueue",
              agentId: a.id,
              sourceAgentId: randomUUID(),
              title: `Synthetic Studio E0${i + 1}`,
              description: "Return only the child process cwd.",
              projectId: b.sourceProjectId,
              projectWorkspaceId: b.sourceWorkspaceId,
              workspaceBindingId: b.id,
            });
            await setRoutineActive(routineDeps(f), f.owner.id, f.org.id, mapping.routineId, true);
            await setPaperclipMappingEnabled(rd, f.owner.id, f.org.id, mapping.id, mapping.configHash, true);
            const receipt = await dispatchPaperclipRoutine(rd, f.owner.id, f.org.id, mapping.id, {
              expectedConfigHash: mapping.configHash,
              idempotencyKey: `transport-${i}`,
            });
            await executeRoutineRun({ ...routineDeps(f), paperclipCompatibilityEnabled: true }, receipt.routineRunId!);
            const [firing] = await f.db
              .select()
              .from(schema.routineRuns)
              .where(eq(schema.routineRuns.id, receipt.routineRunId!));
            check(firing?.agentRunId, "native routine start failed");
            const runId = firing.agentRunId;
            await f.db.update(schema.agentRuns).set({ status: "running" }).where(eq(schema.agentRuns.id, runId));
            const brain: Brain = {
              kind: a.brain,
              async *run(turn, io) {
                const out = await proxy.call(
                  paired.machineId,
                  {
                    op: "brain.turn",
                    runId,
                    agent: { id: a.id, handle: a.handle },
                    kind: a.brain,
                    model: a.model,
                    session: turn.session!,
                    cwd: (await turn.code)!.cwd,
                    keepAlive: false,
                    system: "",
                    prompt: "fixture",
                    mcp: { token: "synthetic-transport-token" },
                  },
                  { signal: io.signal },
                );
                yield out.final as { type: "done"; text: string };
              },
            };
            const events = await Array.fromAsync(
              paperclipProjectBrain(deps, brain).run(
                {
                  runId,
                  orgId: f.org.id,
                  agentId: a.id,
                  channelId: randomUUID(),
                  threadRootId: null,
                  system: "",
                  messages: [],
                  tools: [],
                  model: a.model,
                  trigger: "fixture",
                  session: { id: randomUUID(), resume: true, cwd: "/wrong", machineId: paired.machineId },
                },
                { signal: new AbortController().signal, executeTool: async () => ({ content: "unused" }) },
              ),
            );
            const done = events.find((e) => e.type === "done");
            check(done?.type === "done", `native turn failed: ${JSON.stringify(events)}`);
            const native = JSON.parse(done.text) as {
              cwd: string;
              pid: number;
              resume: boolean;
              keepAlive: boolean;
              platform: string;
            };
            check(
              native.cwd === b.targetCwd &&
                native.resume === false &&
                native.keepAlive === false &&
                native.platform === "darwin" &&
                native.pid > 0,
              "native launch evidence mismatched",
            );
            results.push({ routine: `E0${i + 1}`, brain: a.brain, role: roles[firingOwners[i]!], runId, ...native });
            await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, runId));
          }
          await disablePaperclipWorkspace(deps, f.owner.id, f.org.id, b.id);
          await f.db
            .update(schema.agentRuns)
            .set({ status: "running" })
            .where(eq(schema.agentRuns.id, results.at(-1)!.runId));
          let revoked = false;
          try {
            await paperclipProjectRun(deps, f.org.id, results.at(-1)!.runId);
          } catch {
            revoked = true;
          }
          check(revoked, "revocation did not refuse the persisted project run");
          return Response.json({
            serverPlatform: process.platform,
            transport: "real-websocket",
            syntheticBrain: true,
            results,
            revoked,
          });
        }
        if (path === "/stop" && req.method === "POST") {
          setTimeout(async () => {
            await hub.stop();
            await f.close();
            service.stop(true);
          }, 50);
          return Response.json({ stopping: true });
        }
        return new Response("fixture route unavailable", { status: 404 });
      } catch (e) {
        return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
      }
    },
    websocket: {
      open(ws) {
        ws.data.connection = hub.open(ws);
      },
      message(ws, raw) {
        if (ws.data.connection) void hub.message(ws.data.connection, raw);
      },
      close(ws) {
        if (ws.data.connection) void hub.close(ws.data.connection);
      },
    },
  });
  console.log(JSON.stringify({ fixture: "ready", port: service.port, synthetic: true }));
}

async function mac(url: string) {
  check(process.platform === "darwin", "native half of the fixture must run on macOS");
  const bootstrap = (await (await fetch(`${url}/bootstrap`)).json()) as {
    orgId: string;
    ownerId: string;
    machineId: string;
    token: string;
    agents: { id: string; handle: string }[];
  };
  const root = realpathSync(mkdtempSync(join(tmpdir(), "paperclip-transport-")));
  const home = join(root, "home"),
    source = join(root, "source"),
    target = join(root, "target"),
    workspace = join(root, "workspace");
  for (const dir of [home, source, target, workspace]) mkdirSync(dir, { mode: 0o700 });
  const git = (cwd: string, ...args: string[]) => {
    const out = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.test",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.test",
      },
    });
    check(out.status === 0, "fixture Git failed");
    return out.stdout.trim();
  };
  let ws: WebSocket | undefined;
  const previousPath = process.env.PATH;
  try {
    const syntheticBin = join(home, "synthetic-bin");
    mkdirSync(syntheticBin, { mode: 0o700 });
    const syntheticCodex = join(syntheticBin, "codex");
    writeFileSync(
      syntheticCodex,
      `#!${process.execPath}\n` +
        `const args = process.argv.slice(2);\n` +
        `if (args.includes("--version")) console.log("codex-cli 0.166.0");\n` +
        `else {\n` +
        `  const text = JSON.stringify({cwd:process.cwd(),pid:process.pid,platform:process.platform,resume:args.includes("resume"),keepAlive:false});\n` +
        `  console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text}}));\n` +
        `  console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:0,output_tokens:0}}));\n` +
        `}\n`,
      { mode: 0o700 },
    );
    process.env.PATH = `${syntheticBin}:${previousPath ?? ""}`;
    const files: Record<string, { bytes: number; sha256: string }> = {};
    for (let i = 0; i < 64; i++) {
      const name = `fixture-${i}.md`,
        content = `Synthetic fixture ${i}\n`;
      writeFileSync(join(source, name), content);
      copyFileSync(join(source, name), join(target, name));
      files[name] = { bytes: Buffer.byteLength(content), sha256: sha(content) };
    }
    git(source, "init", "-q");
    git(source, "add", ".");
    git(source, "commit", "-q", "-m", "fixture");
    git(target, "init", "-q");
    const bundleFile = join(home, "history.bundle");
    git(source, "bundle", "create", bundleFile, "--all");
    chmodSync(bundleFile, 0o600);
    git(target, "fetch", "-q", bundleFile, "HEAD");
    git(target, "update-ref", "HEAD", git(source, "rev-parse", "HEAD"));
    const companyId = randomUUID(),
      projectId = randomUUID(),
      workspaceId = randomUUID();
    const project = JSON.stringify({
      id: projectId,
      companyId,
      workspaces: [{ id: workspaceId, cwd: source, isPrimary: true }],
    });
    const snapshot = JSON.stringify({
      source,
      target,
      sourceHead: git(source, "rev-parse", "HEAD"),
      historyBundleSha256: sha(readFileSync(bundleFile)),
      sourceAndTargetMatch: true,
      files,
    });
    const projectFile = join(home, "project.json"),
      snapshotFile = join(home, "snapshot.json");
    writeFileSync(projectFile, project, { mode: 0o600 });
    writeFileSync(snapshotFile, snapshot, { mode: 0o600 });
    const access = {
      tools: { commands: true, claude: true, codex: true },
      folders: [{ path: target, agents: bootstrap.agents.map((a) => a.id) }],
    };
    const registration = registerOwnerProject(home, { ...bootstrap, workspace, access } as any, {
      ownerId: bootstrap.ownerId,
      agentIds: bootstrap.agents.map((a) => a.id),
      sourceCompanyId: companyId,
      sourceProjectId: projectId,
      sourceWorkspaceId: workspaceId,
      projectFile,
      snapshotFile,
      bundleFile,
      projectDigest: sha(project),
      snapshotDigest: sha(snapshot),
    });
    const gateway = createPaperclipGateway({
      runnerHome: home,
      workspaceReal: workspace,
      orgId: bootstrap.orgId,
      machineId: bootstrap.machineId,
      access: () => access as any,
    });
    const context = {
      workspaceReal: workspace,
      exec: true,
      token: "synthetic",
      access: () => access,
      paperclip: gateway,
      codex: {
        runnerHome: home,
        runs: new Map(),
        spawn: (_file: string, args: readonly string[], options: Parameters<typeof spawn>[2]) => {
          check(!args.includes("resume") && options?.cwd === target, "synthetic Codex launch escaped its fresh target");
          // Exercise the native Codex event parser with a real child, without inheriting sign-in variables.
          return spawn(process.execPath, [syntheticCodex, ...args], { ...options, env: { PATH: process.env.PATH } });
        },
      },
      brains: {
        turn: async (req: any, ctx: any) => {
          await ctx.beforeLaunch(req.cwd);
          // Real native process, synthetic brain: no installed model account, source code or user data is read.
          const child = execFile(
            process.execPath,
            [
              "-e",
              "process.stdout.write(JSON.stringify({cwd:process.cwd(),pid:process.pid,platform:process.platform}))",
            ],
            { cwd: req.cwd, timeout: 10000 },
          );
          const [code, stdout] = await new Promise<[number, string]>((resolve, reject) => {
            let text = "";
            child.stdout?.on("data", (d) => {
              text += String(d);
            });
            child.once("error", reject);
            child.once("close", (status) => resolve([status ?? -1, text]));
          });
          check(code === 0, "native fixture child failed");
          return {
            type: "done",
            text: JSON.stringify({ ...JSON.parse(stdout), resume: req.session.resume, keepAlive: req.keepAlive }),
          };
        },
      },
    } as unknown as HandlerContext;
    ws = new WebSocket(`${url.replace(/^http/, "ws")}/machine`);
    const socket = ws;
    const ready = new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => {
        socket.send(
          JSON.stringify({
            type: "hello",
            token: bootstrap.token,
            version: "fixture",
            protocol: MACHINE_PROTOCOL_VERSION,
            os: "darwin",
            arch: process.arch,
            hostname: "synthetic",
            workspace,
            exec: true,
            access,
          }),
        );
      });
      socket.addEventListener("message", (e) => {
        let value: { type?: string };
        try {
          value = JSON.parse(String(e.data));
        } catch {
          return;
        }
        if (value.type === "welcome") resolve();
      });
      socket.addEventListener("error", () => reject(Error("fixture WebSocket failed")));
      setTimeout(() => reject(Error("fixture hello timeout")), 10000).unref();
    });
    socket.addEventListener("message", async (e) => {
      const frame = parseServerFrame(String(e.data));
      if (frame?.type !== "request") return;
      const { id, type: _, ...req } = frame;
      try {
        const data = await handleRequest(context, req, { signal: new AbortController().signal, output: () => {} });
        socket.send(JSON.stringify({ type: "result", id, ok: true, data }));
      } catch (e) {
        socket.send(
          JSON.stringify({
            type: "result",
            id,
            ok: false,
            error: { code: "not_allowed", message: e instanceof Error ? e.message : "fixture refused" },
          }),
        );
      }
    });
    await ready;
    const registered = await fetch(`${url}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(registration.registration),
    });
    check(registered.ok, `registration failed: ${await registered.text()}`);
    const result = await fetch(`${url}/run`, { method: "POST" });
    const receipt = await result.json();
    check(result.ok, JSON.stringify(receipt));
    console.log(JSON.stringify({ ...receipt, fixtureFiles: 64, macPlatform: process.platform }));
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    ws?.close();
    await fetch(`${url}/stop`, { method: "POST" }).catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}
const [mode, url] = process.argv.slice(2);
if (mode === "server") await server();
else if (mode === "mac" && url && /^http:\/\/127\.0\.0\.1:\d+$/.test(url)) await mac(url);
else throw Error("Use server in a disposable container; mac http://127.0.0.1:<published-port> on the owner Mac");
