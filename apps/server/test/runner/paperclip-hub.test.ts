import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MACHINE_PROTOCOL_VERSION, parseServerFrame } from "@agenteschat/adapters/machine-protocol";
import { runOwnerBoundProjectTurn } from "../../../../packages/engine/src/paperclip-workspace-client";
import { setup } from "../../../../packages/engine/test/fixtures";
import { pairMachine } from "../../../../packages/engine/test/machine-fixtures";
import { type HandlerContext, handleRequest } from "../../runner/handlers";
import { createPaperclipGateway } from "../../runner/paperclip-gateway";
import { registerOwnerProject } from "../../runner/paperclip-register";

const sha = (x: string | Buffer) => createHash("sha256").update(x).digest("hex");

test("authenticated machine hub frames carry a registered owner proof and one guarded synthetic turn", async () => {
  const f = await setup({ machines: true });
  const root = realpathSync(mkdtempSync(join(tmpdir(), "paperclip-hub-")));
  try {
    const hub = f.machineHub!;
    const paired = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, {
      name: "fixture",
      hostname: "fixture",
      os: "darwin",
      arch: "arm64",
      version: "test",
      protocol: MACHINE_PROTOCOL_VERSION,
      workspace: "/workspace",
      exec: true,
    });
    const home = join(root, "home"),
      source = join(root, "source"),
      target = join(root, "target"),
      workspace = join(root, "workspace");
    for (const p of [home, source, target, workspace]) mkdirSync(p, { mode: 0o700 });
    writeFileSync(join(source, "a"), "hello");
    writeFileSync(join(target, "a"), "hello");
    const git = (cwd: string, ...args: string[]) => {
      const p = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_AUTHOR_NAME: "Fixture",
          GIT_AUTHOR_EMAIL: "fixture@example.test",
          GIT_COMMITTER_NAME: "Fixture",
          GIT_COMMITTER_EMAIL: "fixture@example.test",
        },
      });
      if (p.status !== 0) throw Error("git fixture failed");
      return p.stdout.trim();
    };
    git(source, "init", "-q");
    git(source, "add", "a");
    git(source, "commit", "-q", "-m", "fixture");
    git(target, "init", "-q");
    const head = git(source, "rev-parse", "HEAD"),
      bundleFile = join(root, "bundle");
    git(source, "bundle", "create", bundleFile, "--all");
    chmodSync(bundleFile, 0o600);
    git(target, "fetch", "-q", bundleFile, "HEAD");
    git(target, "update-ref", "HEAD", head);
    const bundle = readFileSync(bundleFile);
    const companyId = randomUUID(),
      projectId = randomUUID(),
      workspaceId = randomUUID(),
      project = JSON.stringify({
        id: projectId,
        companyId,
        workspaces: [{ id: workspaceId, cwd: source, isPrimary: true }],
      }),
      snapshot = JSON.stringify({
        source,
        target,
        sourceHead: head,
        historyBundleSha256: sha(bundle),
        sourceAndTargetMatch: true,
        files: { a: { bytes: 5, sha256: sha("hello") } },
      });
    const projectFile = join(root, "project"),
      snapshotFile = join(root, "snapshot");
    writeFileSync(projectFile, project, { mode: 0o600 });
    writeFileSync(snapshotFile, snapshot, { mode: 0o600 });
    const access = {
      tools: { commands: true, claude: true, codex: true },
      folders: [{ path: target, agents: [f.agent.id] }],
    };
    const config = { orgId: f.org.id, machineId: paired.machineId, workspace, access } as any;
    const binding = registerOwnerProject(home, config, {
      ownerId: f.owner.id,
      agentIds: [f.agent.id],
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
      orgId: f.org.id,
      machineId: paired.machineId,
      access: () => access as any,
    });
    let turns = 0;
    const context = {
      workspaceReal: workspace,
      exec: true,
      token: "test",
      access: () => access,
      paperclip: gateway,
      brains: {
        turn: async (_req: any, ctx: any) => {
          await ctx.beforeLaunch(target);
          turns++;
          return { type: "done", text: "ok" };
        },
      },
    } as unknown as HandlerContext;
    const seen: string[] = [];
    let conn: any;
    const socket = {
      send(raw: string) {
        const frame = parseServerFrame(raw);
        if (frame?.type !== "request") return;
        seen.push(frame.op);
        const { id, type: _type, ...req } = frame;
        queueMicrotask(async () => {
          try {
            const data = await handleRequest(context, req, { signal: new AbortController().signal, output: () => {} });
            await hub.message(conn, JSON.stringify({ type: "result", id, ok: true, data }));
          } catch {
            await hub.message(
              conn,
              JSON.stringify({ type: "result", id, ok: false, error: { code: "not_allowed", message: "refused" } }),
            );
          }
        });
      },
      close() {},
    };
    conn = hub.open(socket);
    await hub.message(
      conn,
      JSON.stringify({
        type: "hello",
        token: paired.token,
        version: "test",
        protocol: MACHINE_PROTOCOL_VERSION,
        os: "darwin",
        arch: "arm64",
        hostname: "fixture",
        workspace,
        exec: true,
        access,
      }),
    );
    const input = {
      orgId: f.org.id,
      machineId: paired.machineId,
      ownerId: f.owner.id,
      agent: { id: f.agent.id, handle: f.agent.handle },
      bindingId: binding.bindingId,
      generation: binding.generation,
      bindingDigest: binding.bindingDigest,
      targetCwd: target,
      turn: {
        kind: "claude_code",
        runId: randomUUID(),
        session: { id: randomUUID(), resume: false },
        cwd: target,
        keepAlive: false,
        system: "",
        prompt: "test",
        mcp: { token: "synthetic" },
      },
    } as const;
    const out = await runOwnerBoundProjectTurn(
      {
        hub,
        assertAuthorized: async (x) =>
          x.ownerId === f.owner.id && x.orgId === f.org.id && x.machineId === paired.machineId,
      },
      input as any,
    );
    expect(out.runId).toBe(input.turn.runId);
    expect(turns).toBe(1);
    expect(seen).toEqual(["paperclip.workspace.probe", "paperclip.workspace.attest", "paperclip.brain.turn"]);
    await hub.close(conn);
  } finally {
    await f.machineHub?.stop();
    await f.close();
    rmSync(root, { recursive: true, force: true });
  }
});
