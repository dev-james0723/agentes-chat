import { afterEach, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION, parseServerFrame } from "@agenteschat/adapters/machine-protocol";
import { eq, schema } from "@agenteschat/db";
import { pairMachine } from "../../../packages/engine/test/machine-fixtures";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(async () => {
  await t?.close();
});
test("workspace binding API requires the owner session, CSRF, opt-in and native proof, and registration starts no work", async () => {
  t = await createTestServer({ env: { PAPERCLIP_ROUTINE_COMPATIBILITY: "on" } });
  const owner = browser(t);
  await signUp(owner, "workspace-owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const [agent] = await t.db.select().from(schema.agents).where(eq(schema.agents.id, agentId));
  const [membership] = await t.db
    .select()
    .from(schema.organizationMembers)
    .where(eq(schema.organizationMembers.orgId, orgId));
  const ownerId = membership!.userId;
  const paired = await pairMachine({ db: t.db }, ownerId, orgId, { os: "darwin", protocol: MACHINE_PROTOCOL_VERSION });
  await t.db
    .update(schema.agents)
    .set({
      ownerUserId: ownerId,
      machineId: paired.machineId,
      brain: "codex",
      brainModel: "gpt-6.1-sol",
      brainFallback: false,
    })
    .where(eq(schema.agents.id, agentId));
  const input = {
    id: crypto.randomUUID(),
    machineId: paired.machineId,
    generation: crypto.randomUUID(),
    sourceCompanyId: crypto.randomUUID(),
    sourceProjectId: crypto.randomUUID(),
    sourceWorkspaceId: crypto.randomUUID(),
    targetCwd: "/fixture/target",
    projectDigest: "a".repeat(64),
    snapshotDigest: "b".repeat(64),
    bindingDigest: "c".repeat(64),
    agentIds: [agentId],
  };
  const path = `/api/app/organizations/${orgId}/paperclip-workspaces`;
  expect((await browser(t)(path, { json: input })).status).toBe(401);
  expect((await owner(path, { json: input, origin: "https://untrusted.example" })).status).toBe(403);
  expect((await owner(path, { json: { ...input, sourcePath: "/unreviewed" } })).status).toBe(400);
  // The normal machine hub authenticates the connection; this test supplies a synthetic native proof.
  const hub = t.engine.machineHub;
  let conn: ReturnType<typeof hub.open>;
  conn = hub.open({
    send(raw: string) {
      const frame = parseServerFrame(raw);
      if (frame?.type !== "request") return;
      const data =
        frame.op === "paperclip.workspace.probe"
          ? { version: 1, connectionId: crypto.randomUUID() }
          : frame.op === "paperclip.workspace.attest"
            ? { ...input, ...frame.proof, bindingId: input.id }
            : null;
      queueMicrotask(() => {
        void hub.message(conn, JSON.stringify({ type: "result", id: frame.id, ok: true, data }));
      });
    },
    close() {},
  });
  await hub.message(
    conn,
    JSON.stringify({
      type: "hello",
      token: paired.token,
      version: "fixture",
      protocol: MACHINE_PROTOCOL_VERSION,
      os: "darwin",
      arch: "arm64",
      hostname: "fixture",
      workspace: "/workspace",
      exec: true,
    }),
  );
  const created = await owner(path, { json: input });
  expect(created.status).toBe(201);
  const binding = (await created.json()) as { id: string; enabled: boolean };
  expect(binding).toMatchObject({ id: input.id, enabled: true });
  expect((await owner(path)).status).toBe(200);
  expect((await owner(`${path}/${input.id}/disable`, { json: {} })).status).toBe(200);
  expect((await t.db.select().from(schema.paperclipWorkspaceBindings))[0]?.enabled).toBe(false);
  expect(await t.db.select().from(schema.routineRuns)).toHaveLength(0);
  expect(agent!.id).toBe(agentId);
  await hub.close(conn);
});
test("workspace native registration is unavailable when compatibility is off", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "workspace-off@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const input = {
    id: crypto.randomUUID(),
    machineId: crypto.randomUUID(),
    generation: crypto.randomUUID(),
    sourceCompanyId: crypto.randomUUID(),
    sourceProjectId: crypto.randomUUID(),
    sourceWorkspaceId: crypto.randomUUID(),
    targetCwd: "/fixture/target",
    projectDigest: "a".repeat(64),
    snapshotDigest: "b".repeat(64),
    bindingDigest: "c".repeat(64),
    agentIds: [agentId],
  };
  expect((await owner(`/api/app/organizations/${orgId}/paperclip-workspaces`, { json: input })).status).toBe(403);
});
