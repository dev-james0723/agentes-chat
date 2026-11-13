import { afterEach, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import { ensureRoutineHook, routineHookView } from "@agenteschat/engine";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(async () => t?.close());
function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected fixture value");
  return value;
}
const uid = () => crypto.randomUUID();

test("HTTP owner review and native hook bind only an explicitly selected reviewed workspace", async () => {
  t = await createTestServer({ env: { PAPERCLIP_ROUTINE_COMPATIBILITY: "on" } });
  const owner = browser(t);
  await signUp(owner, "scope-owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const [member] = await t.db
    .select()
    .from(schema.organizationMembers)
    .where(and(eq(schema.organizationMembers.orgId, orgId), eq(schema.organizationMembers.role, "owner")));
  const ownerId = present(member).userId,
    machineId = uid(),
    companyId = uid(),
    projectId = uid(),
    workspaceId = uid(),
    bindingId = uid(),
    triggerId = uid();
  await t.db
    .insert(schema.machines)
    .values({ id: machineId, orgId, name: "Fixture Mac", os: "darwin", pairedByUserId: ownerId, protocol: 66 });
  await t.db
    .update(schema.agents)
    .set({ ownerUserId: ownerId, machineId, brain: "codex", brainModel: "fixture-model", brainFallback: false })
    .where(eq(schema.agents.id, agentId));
  await t.db.insert(schema.paperclipWorkspaceBindings).values({
    id: bindingId,
    orgId,
    ownerId,
    machineId,
    generation: uid(),
    sourceCompanyId: companyId,
    sourceProjectId: projectId,
    sourceWorkspaceId: workspaceId,
    projectDigest: "a".repeat(64),
    snapshotDigest: "b".repeat(64),
    bindingDigest: "c".repeat(64),
    targetCwd: "/fixture/native-target",
    agents: [{ id: agentId, ownerId, brain: "codex", model: "fixture-model", accountId: null }],
  });
  const base = `/api/app/organizations/${orgId}`,
    path = `${base}/paperclip-routines`;
  const created = await owner(path, {
    json: {
      sourceCompanyId: companyId,
      sourceRoutineId: uid(),
      sourceRevisionId: "fixture-revision",
      sourceActive: true,
      activityGatePolicy: "always",
      activityGateScope: "company",
      catchUpPolicy: "skip_missed",
      triggers: [{ id: triggerId, kind: "api", enabled: true }],
      policy: "always_enqueue",
      agentId,
      sourceAgentId: uid(),
      title: "Selected workspace review",
      description: "Read only selected target evidence.",
    },
  });
  expect(created.status).toBe(201);
  const m = (await created.json()) as { id: string; routineId: string; configHash: string };
  const scopePath = `${path}/${m.id}/workspace-scope`;
  const review = { expectedConfigHash: m.configHash, bindingIds: [bindingId] };
  expect((await browser(t)(scopePath, { method: "PUT", json: review })).status).toBe(401);
  expect((await owner(scopePath, { method: "PUT", json: review, origin: "https://untrusted.example" })).status).toBe(
    403,
  );
  expect((await owner(scopePath, { method: "PUT", json: { ...review, cwd: "/untrusted" } })).status).toBe(400);
  const configured = await owner(scopePath, { method: "PUT", json: review });
  expect(configured.status).toBe(200);
  const scoped = (await configured.json()) as { configHash: string; enabled: boolean };
  expect(scoped.enabled).toBe(false);
  expect(scoped.configHash).not.toBe(m.configHash);
  expect((await owner(scopePath, { method: "PUT", json: review })).status).toBe(409);
  expect(await t.db.select().from(schema.paperclipRoutineReceipts)).toHaveLength(0);
  expect((await owner(`${base}/routines/${m.routineId}`, { method: "PATCH", json: { active: true } })).status).toBe(
    200,
  );
  expect(
    (
      await owner(`${path}/${m.id}/activation`, {
        method: "PUT",
        json: { expectedConfigHash: scoped.configHash, enabled: true },
      })
    ).status,
  ).toBe(200);
  const hooks = { publicUrl: t.config.PUBLIC_URL, secret: t.config.AGENTES_SECRET };
  await ensureRoutineHook(t.db, hooks, { id: m.routineId, orgId });
  expect(
    (
      await owner(`${path}/${m.id}/hook-ingress`, {
        method: "PUT",
        json: { expectedConfigHash: scoped.configHash, triggerId, enabled: true },
      })
    ).status,
  ).toBe(200);
  const hook = await routineHookView({ db: t.db, hooks }, { id: m.routineId, orgId, name: "Fixture hook" });
  const hookPath = new URL(hook.url).pathname;
  const invoke = {
    expectedConfigHash: scoped.configHash,
    idempotencyKey: "hook-delivery",
    workspace: { bindingId, projectId, projectWorkspaceId: workspaceId },
  };
  const call = (suffix: string, body: unknown) =>
    t.app.request(`${hookPath}/paperclip/${suffix}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  expect((await call("invocations", { ...invoke, workspace: { ...invoke.workspace, cwd: "/untrusted" } })).status).toBe(
    400,
  );
  expect((await call("invocations", { ...invoke, workspace: undefined })).status).toBe(400);
  const accepted = await call("invocations", invoke);
  expect(accepted.status).toBe(202);
  const receipt = (await accepted.json()) as { receiptId: string; workspace: { bindingId: string; projectId: string } };
  expect(receipt.workspace).toMatchObject({ bindingId, projectId });
  expect(JSON.stringify(receipt)).not.toContain("/fixture/");
  expect((await call("invocations", invoke)).status).toBe(202);
  expect(await t.db.select().from(schema.paperclipRoutineReceipts)).toHaveLength(1);
  expect(await t.db.select().from(schema.issues)).toHaveLength(1);
  expect(
    (
      await owner(`${path}/${m.id}/activation`, {
        method: "PUT",
        json: { expectedConfigHash: scoped.configHash, enabled: false },
      })
    ).status,
  ).toBe(200);
  expect((await call("invocations", invoke)).status).toBe(409);
  const lookup = await call("lookup", { idempotencyKey: invoke.idempotencyKey });
  expect(lookup.status).toBe(200);
  expect(await lookup.json()).toMatchObject({ backend: "agents_chat", receipt });
});
