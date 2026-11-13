import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPaperclipGateway } from "../../runner/paperclip-gateway";
import { registerOwnerProject } from "../../runner/paperclip-register";
import { readOwnerBinding, removeOwnerBinding } from "../../runner/paperclip-registry";

const sha = (x: string | Buffer) => createHash("sha256").update(x).digest("hex");
test("owner local registration verifies artifacts and grants, and native gateway checks the one-shot run proof", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "paperclip-register-"))),
    home = join(root, "runner");
  mkdirSync(home, { mode: 0o700 });
  try {
    const source = join(root, "src"),
      target = join(root, "dest");
    mkdirSync(source);
    mkdirSync(target);
    writeFileSync(join(source, "a"), "hello");
    writeFileSync(join(target, "a"), "hello");
    const companyId = randomUUID(),
      projectId = randomUUID(),
      workspaceId = randomUUID(),
      agentId = randomUUID(),
      orgId = randomUUID(),
      machineId = randomUUID(),
      ownerId = randomUUID();
    const git = (dir: string, ...argv: string[]) => {
      const out = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...argv], {
        cwd: dir,
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
      if (out.status !== 0) throw Error("fixture git failed");
      return out.stdout.trim();
    };
    git(source, "init", "-q");
    git(source, "add", "a");
    git(source, "commit", "-q", "-m", "fixture");
    git(target, "init", "-q");
    const head = git(source, "rev-parse", "HEAD");
    const b = join(home, "bundle");
    git(source, "bundle", "create", b, "--all");
    chmodSync(b, 0o600);
    git(target, "fetch", "-q", b, "HEAD");
    git(target, "update-ref", "HEAD", head);
    const bundle = readFileSync(b);
    const project = JSON.stringify({
      id: projectId,
      companyId,
      workspaces: [{ id: workspaceId, cwd: source, isPrimary: true }],
    });
    const snapshot = JSON.stringify({
      source,
      target,
      sourceHead: head,
      historyBundleSha256: sha(bundle),
      sourceAndTargetMatch: true,
      files: { a: { bytes: 5, sha256: sha("hello") } },
    });
    const p = join(home, "project"),
      s = join(home, "snapshot");
    writeFileSync(p, project, { mode: 0o600 });
    writeFileSync(s, snapshot, { mode: 0o600 });
    const workspace = join(root, "agent-work");
    mkdirSync(workspace);
    const config = {
      orgId,
      machineId,
      workspace,
      access: { tools: { commands: true }, folders: [{ path: target, agents: [agentId] }] },
    } as any;
    const args = {
      ownerId,
      agentIds: [agentId],
      sourceCompanyId: companyId,
      sourceProjectId: projectId,
      sourceWorkspaceId: workspaceId,
      projectFile: p,
      snapshotFile: s,
      bundleFile: b,
      projectDigest: sha(project),
      snapshotDigest: sha(snapshot),
    };
    const result = registerOwnerProject(home, config, args);
    expect(result.bindingId).toBeString();
    expect((readOwnerBinding(home, result.bindingId) as any).sourceProjectId).toBe(projectId);
    expect(config.access.folders).toHaveLength(1);
    expect(() => registerOwnerProject(home, { ...config, workspace: source }, args)).toThrow();
    const gateway = createPaperclipGateway({
      runnerHome: home,
      workspaceReal: workspace,
      orgId,
      machineId,
      access: () => config.access,
    });
    const connectionId = gateway.probe().connectionId,
      runId = randomUUID();
    const proof = {
      bindingId: result.bindingId,
      generation: result.generation,
      orgId,
      machineId,
      ownerId,
      agentId,
      runId,
      connectionId,
      nonce: randomBytes(32).toString("base64url"),
      expiresAt: Date.now() + 10000,
    };
    const agent = { id: agentId, handle: "worker" };
    const attested = await gateway.attest({ op: "paperclip.workspace.attest", agent, proof });
    expect(attested.targetCwd).toBe(target);
    const turn = {
      op: "paperclip.brain.turn",
      agent,
      runId,
      cwd: target,
      paperclipProof: proof,
      kind: "codex",
      keepAlive: false,
      session: { id: randomUUID(), resume: false },
    } as any;
    await gateway.consume(turn);
    await expect(gateway.consume(turn)).rejects.toThrow();
    const next = { ...proof, runId: randomUUID(), nonce: randomBytes(32).toString("base64url") };
    await gateway.attest({ op: "paperclip.workspace.attest", agent, proof: next });
    removeOwnerBinding(home, result.bindingId);
    await expect(gateway.consume({ ...turn, runId: next.runId, paperclipProof: next })).rejects.toThrow();
    const wrong = JSON.stringify({ ...JSON.parse(snapshot), sourceHead: "c".repeat(40) });
    writeFileSync(s, wrong, { mode: 0o600 });
    expect(() => registerOwnerProject(home, config, { ...args, snapshotDigest: sha(wrong) })).toThrow();
    writeFileSync(s, snapshot, { mode: 0o600 });
    expect(() => registerOwnerProject(home, { ...config, access: { ...config.access, folders: [] } }, args)).toThrow();
    chmodSync(p, 0o644);
    expect(() => registerOwnerProject(home, config, args)).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
