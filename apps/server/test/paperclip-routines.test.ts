import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(async () => {
  await t?.close();
});
const SOURCE = "01930000-0000-7000-8000-000000000002";
const TRIGGER = "01930000-0000-7000-8000-000000000003";
const input = (agentId: string) => ({
  sourceCompanyId: "01930000-0000-7000-8000-000000000001",
  sourceRoutineId: SOURCE,
  sourceRevisionId: null,
  activityGatePolicy: "always",
  activityGateScope: "company",
  catchUpPolicy: "skip_missed",
  sourceActive: true,
  triggers: [{ id: TRIGGER, kind: "api", enabled: true }],
  policy: "always_enqueue",
  agentId,
  sourceAgentId: "01930000-0000-7000-8000-000000000004",
  title: "Read local evidence",
  description: "Report your observations.",
});

test("compatibility defaults off and unauthenticated callers cannot create bindings", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const path = `/api/app/organizations/${orgId}/paperclip-routines`;
  expect((await browser(t)(path, { json: input(agentId) })).status).toBe(401);
  expect((await owner(path, { json: input(agentId) })).status).toBe(403);
  expect(await t.db.select().from(schema.paperclipRoutineMappings)).toHaveLength(0);
  expect(await t.db.select().from(schema.routines)).toHaveLength(0);
});

test("authenticated opt-in API creates paused bindings, requires activation and reconciles keyed receipts", async () => {
  t = await createTestServer({ env: { PAPERCLIP_ROUTINE_COMPATIBILITY: "on" } });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const path = `/api/app/organizations/${orgId}/paperclip-routines`;
  expect((await owner(path, { json: input(agentId), origin: "https://untrusted.example" })).status).toBe(403);
  expect((await owner(path, { json: { ...input(agentId), ignoredOverride: true } })).status).toBe(400);
  const created = await owner(path, { json: input(agentId) });
  expect(created.status).toBe(201);
  const m = (await created.json()) as { id: string; enabled: boolean; configHash: string; routineId: string };
  expect(m.enabled).toBe(false);
  expect((await t.db.select().from(schema.routines).where(eq(schema.routines.id, m.routineId)))[0]).toMatchObject({
    active: false,
    nextRunAt: null,
  });
  expect(await t.db.select().from(schema.routineRuns)).toHaveLength(0);
  const activation = { method: "PUT", json: { expectedConfigHash: m.configHash, enabled: true } };
  expect((await owner(`${path}/${m.id}/activation`, activation)).status).toBe(409);
  expect(
    (
      await owner(`/api/app/organizations/${orgId}/routines/${m.routineId}`, {
        method: "PATCH",
        json: { active: true },
      })
    ).status,
  ).toBe(200);
  expect((await owner(`${path}/${m.id}/activation`, activation)).status).toBe(200);
  const invocation = {
    expectedConfigHash: m.configHash,
    source: "api",
    triggerId: TRIGGER,
    idempotencyKey: "delivery-1",
  };
  const queued = await owner(`${path}/${m.id}/invocations`, { json: invocation });
  expect(queued.status).toBe(202);
  const receipt = (await queued.json()) as { id: string; issueId: string };
  expect(
    await (
      await owner(`${path}/${m.id}/lookup`, {
        json: { source: "api", triggerId: TRIGGER, idempotencyKey: "delivery-1" },
      })
    ).json(),
  ).toMatchObject({ receipt: { id: receipt.id, issueId: receipt.issueId } });
  expect(await (await owner(`${path}/${m.id}/invocations`, { json: invocation })).json()).toMatchObject({
    id: receipt.id,
  });
  expect(await t.db.select().from(schema.issues)).toHaveLength(1);
  expect(await t.db.select().from(schema.routineRuns)).toHaveLength(1);
  expect(await t.db.select().from(schema.agentRuns)).toHaveLength(0);
});

test("candidate fingerprints support disabled adoption without changing or duplicating the native definition", async () => {
  t = await createTestServer({ env: { PAPERCLIP_ROUTINE_COMPATIBILITY: "on" } });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const base = `/api/app/organizations/${orgId}`;
  const created = await owner(`${base}/routines`, {
    json: {
      agentId,
      name: "Imported task",
      prompt: `[PC1:${SOURCE}:${TRIGGER}]\nReport your observations.`,
      target: { type: "dm" },
      trigger: { type: "event", event: "issue.created" },
    },
  });
  expect(created.status).toBe(201);
  const native = (await created.json()) as { id: string };
  expect((await owner(`${base}/routines/${native.id}`, { method: "PATCH", json: { active: false } })).status).toBe(200);
  const before = await t.db.select().from(schema.routines);
  const inspected = await owner(`${base}/paperclip-routine-candidates/${native.id}`);
  expect(inspected.status).toBe(200);
  const candidate = (await inspected.json()) as { configHash: string; paused: boolean };
  expect(candidate.paused).toBe(true);
  const bound = await owner(`${base}/paperclip-routines`, {
    json: { ...input(agentId), adopt: { routineId: native.id, expectedConfigHash: candidate.configHash } },
  });
  expect(bound.status).toBe(201);
  const mapped = (await bound.json()) as { id: string; configHash: string; nativeConfigHash: string };
  expect(mapped).toMatchObject({
    routineId: native.id,
    enabled: false,
    definition: { executionContract: "unverified_import" },
  });
  expect(await t.db.select().from(schema.routines)).toEqual(before);
  const preparation = await owner(`${base}/paperclip-routines/${mapped.id}/prepare`, {
    json: { expectedConfigHash: mapped.configHash, expectedNativeConfigHash: mapped.nativeConfigHash },
  });
  expect(preparation.status).toBe(200);
  expect(await preparation.json()).toMatchObject({
    enabled: false,
    definition: { executionContract: "issue_reference_v1" },
  });
  expect((await t.db.select().from(schema.routines))[0]).toMatchObject({ active: false, event: "paperclip.received" });
  expect(await t.db.select().from(schema.routineRuns)).toHaveLength(0);
});
