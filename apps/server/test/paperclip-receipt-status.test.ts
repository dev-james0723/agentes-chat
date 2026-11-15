import { afterEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { eq, schema } from "@agenteschat/db";
import { ensureRoutineHook, receivePaperclipRoutineHook, routineHookView } from "@agenteschat/engine";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(async () => t?.close());
const COMPANY = "01930000-0000-7000-8000-000000000001";
const SOURCE = "01930000-0000-7000-8000-000000000002";
const TRIGGER = "01930000-0000-7000-8000-000000000003";
async function fixture() {
  t = await createTestServer({ env: { PAPERCLIP_ROUTINE_COMPATIBILITY: "on" } });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const base = `/api/app/organizations/${orgId}`;
  const response = await owner(`${base}/paperclip-routines`, {
    json: {
      sourceCompanyId: COMPANY,
      sourceRoutineId: SOURCE,
      sourceRevisionId: "revision-1",
      sourceActive: true,
      activityGatePolicy: "always",
      activityGateScope: "company",
      catchUpPolicy: "skip_missed",
      triggers: [{ id: TRIGGER, kind: "api", enabled: true }],
      policy: "always_enqueue",
      agentId,
      sourceAgentId: "01930000-0000-7000-8000-000000000004",
      title: "Read local evidence",
      description: "Report observations.",
    },
  });
  expect(response.status).toBe(201);
  const m = (await response.json()) as { id: string; routineId: string; configHash: string };
  const hooks = { publicUrl: t.config.PUBLIC_URL, secret: t.config.AGENTES_SECRET };
  await ensureRoutineHook(t.db, hooks, { id: m.routineId, orgId });
  const hook = await routineHookView({ db: t.db, hooks }, { id: m.routineId, orgId, name: "Imported" });
  const url = new URL(hook.url).pathname;
  expect(
    (
      await owner(`${base}/paperclip-routines/${m.id}/hook-ingress`, {
        method: "PUT",
        json: { expectedConfigHash: m.configHash, triggerId: TRIGGER, enabled: true },
      })
    ).status,
  ).toBe(200);
  expect((await owner(`${base}/routines/${m.routineId}`, { method: "PATCH", json: { active: true } })).status).toBe(
    200,
  );
  expect(
    (
      await owner(`${base}/paperclip-routines/${m.id}/activation`, {
        method: "PUT",
        json: { expectedConfigHash: m.configHash, enabled: true },
      })
    ).status,
  ).toBe(200);
  const call = (operation: string, value: unknown, headers: Record<string, string> = {}, method = "POST") =>
    t.app.request(`${url}/paperclip/${operation}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(method === "GET" ? {} : { body: typeof value === "string" ? value : JSON.stringify(value) }),
    });
  const admitted = await call("invocations", { expectedConfigHash: m.configHash, idempotencyKey: "evidence-1" });
  expect(admitted.status).toBe(202);
  const accepted = (await admitted.json()) as { receiptId: string; issueId: string; routineRunId: string };
  const receipt = { receiptId: accepted.receiptId, issueId: accepted.issueId, routineRunId: accepted.routineRunId };
  return { owner, orgId, agentId, base, m, url, call, receipt };
}
async function rows() {
  return {
    receipts: await t.db.select().from(schema.paperclipRoutineReceipts),
    issues: await t.db.select().from(schema.issues),
    jobs: await t.db.select().from(schema.outbox),
    hookCalls: await t.db.select().from(schema.routineHookCalls),
    routineRuns: await t.db.select().from(schema.routineRuns),
    agentRuns: await t.db.select().from(schema.agentRuns),
  };
}

test("receipt status is a versioned read-only observation, while lookup keeps its exact admission shape", async () => {
  const f = await fixture();
  const before = await rows();
  const response = await f.call("status", { idempotencyKey: "evidence-1" });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    contract: "agents_chat_receipt_status_v1",
    backend: "agents_chat",
    execution: {
      ...f.receipt,
      mappingId: f.m.id,
      configHash: f.m.configHash,
      acceptedConfigHash: f.m.configHash,
      currentConfigHash: f.m.configHash,
      admissionConfigStatus: "recorded",
      observation: "linked",
      routineStatus: "queued",
      agentStatus: null,
      issueStatus: "todo",
      scopeQualification: "not_required",
      evidenceQualified: false,
    },
  });
  const lookup = await f.call("lookup", { idempotencyKey: "evidence-1" });
  expect(await lookup.json()).toMatchObject({ backend: "agents_chat", receipt: { ...f.receipt } });
  expect(await rows()).toEqual(before);
  const absent = await f.call("status", { idempotencyKey: "missing" });
  expect(await absent.json()).toEqual({
    contract: "agents_chat_receipt_status_v1",
    backend: "agents_chat",
    execution: null,
  });
  expect(await rows()).toEqual(before);
  // This assertion also proves the response never selected a caller-supplied task.
  expect((await t.db.select().from(schema.issues).where(eq(schema.issues.orgId, f.orgId))).length).toBe(1);
});

test("status reconciles while dispatch is paused or off, but explicit ingress and creator revocation refuse", async () => {
  const f = await fixture();
  expect(
    (
      await f.owner(`${f.base}/paperclip-routines/${f.m.id}/activation`, {
        method: "PUT",
        json: { expectedConfigHash: f.m.configHash, enabled: false },
      })
    ).status,
  ).toBe(200);
  expect(
    (await f.owner(`${f.base}/routines/${f.m.routineId}`, { method: "PATCH", json: { active: false } })).status,
  ).toBe(200);
  t.config.PAPERCLIP_ROUTINE_COMPATIBILITY = "off";
  const before = await rows();
  const response = await f.call("status", { idempotencyKey: "evidence-1" });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    execution: { ...f.receipt, observation: "linked", evidenceQualified: false },
  });
  expect(await rows()).toEqual(before);
  expect(
    (
      await f.owner(`${f.base}/paperclip-routines/${f.m.id}/hook-ingress`, {
        method: "PUT",
        json: { expectedConfigHash: f.m.configHash, triggerId: TRIGGER, enabled: false },
      })
    ).status,
  ).toBe(200);
  expect((await f.call("status", { idempotencyKey: "evidence-1" })).status).toBe(404);
  await t.db
    .update(schema.paperclipRoutineMappings)
    .set({ hookIngress: { enabled: true, configHash: f.m.configHash, triggerId: TRIGGER } });
  await t.db.update(schema.organizationMembers).set({ role: "member" });
  expect((await f.call("status", { idempotencyKey: "evidence-1" })).status).toBe(403);
  await t.db.update(schema.organizationMembers).set({ role: "owner" });
  await t.db.update(schema.organizations).set({ standing: "suspended" });
  expect((await f.call("status", { idempotencyKey: "evidence-1" })).status).toBe(404);
});

test("status accepts only its bound stable key and native hook POST/body/header limits", async () => {
  const f = await fixture(),
    before = await rows(),
    key = { idempotencyKey: "evidence-1" };
  for (const field of [
    "orgId",
    "mappingId",
    "receiptId",
    "routineRunId",
    "agentId",
    "issueId",
    "source",
    "triggerId",
    "configHash",
    "workspace",
    "cwd",
  ])
    expect((await f.call("status", { ...key, [field]: SOURCE })).status).toBe(400);
  expect((await f.call("status", {}, {}, "GET")).status).toBe(405);
  expect((await f.call("status", key, {}, "PUT")).status).toBe(405);
  expect((await f.call("status", "{invalid")).status).toBe(400);
  expect((await f.call("status", key, { "content-type": "text/plain" })).status).toBe(400);
  expect((await f.call("status", key, { "idempotency-key": "other" })).status).toBe(400);
  expect((await f.call("status", { idempotencyKey: " " })).status).toBe(400);
  expect((await f.call("status", "x".repeat(256 * 1024 + 1))).status).toBe(413);
  expect(await rows()).toEqual(before);
  await t.db.update(schema.routineHooks).set({ methods: ["GET"] });
  expect((await f.call("status", key)).status).toBe(405);
});

test("status shares current native signing/address/rate authority, never a session credential", async () => {
  const f = await fixture(),
    key = { idempotencyKey: "evidence-1" };
  const signed = await f.owner(`${f.base}/paperclip-routines/${f.m.id}/hook/secret`, { json: {} });
  expect(signed.status).toBe(200);
  const { secret } = (await signed.json()) as { secret: string };
  expect((await f.call("status", key)).status).toBe(401);
  const body = JSON.stringify(key),
    signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  expect((await f.call("status", body, { "x-agentes-signature": signature })).status).toBe(200);
  expect((await f.call("status", body, { "x-agentes-signature": `sha256=${"0".repeat(64)}` })).status).toBe(401);
  const rotated = await f.owner(`${f.base}/paperclip-routines/${f.m.id}/hook/address`, { json: {} });
  expect(rotated.status).toBe(200);
  const path = new URL(((await rotated.json()) as { url: string }).url).pathname;
  expect((await f.call("status", body, { "x-agentes-signature": signature })).status).toBe(404);
  const atNewAddress = () =>
    t.app.request(`${path}/paperclip/status`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agentes-signature": signature },
      body,
    });
  expect((await atNewAddress()).status).toBe(200);
  for (let n = 0; n < 60; n++)
    await t.adapters.rateLimiter.consume(`routine-hook:${f.m.routineId}`, { limit: 60, windowMs: 60_000 });
  expect((await atNewAddress()).status).toBe(429);
  expect(await t.db.select().from(schema.routineHookCalls)).toHaveLength(0);
});

test("revocation while a status body arrives is rechecked before any receipt state is projected", async () => {
  const f = await fixture(),
    before = await rows();
  const token = f.url.split("/").at(-1);
  if (!token) throw new Error("Missing fixture token");
  const answer = await receivePaperclipRoutineHook(
    {
      db: t.db,
      pubsub: t.adapters.pubsub,
      hooks: { publicUrl: t.config.PUBLIC_URL, secret: t.config.AGENTES_SECRET },
      rateLimiter: t.adapters.rateLimiter,
      keyWrappers: [t.adapters.keyWrapper],
      enabled: true,
    },
    "status",
    {
      token,
      method: "POST",
      headers: new Headers({ "content-type": "application/json" }),
      read: async () => {
        expect(
          (
            await f.owner(`${f.base}/paperclip-routines/${f.m.id}/hook-ingress`, {
              method: "PUT",
              json: { expectedConfigHash: f.m.configHash, triggerId: TRIGGER, enabled: false },
            })
          ).status,
        ).toBe(200);
        return new TextEncoder().encode(JSON.stringify({ idempotencyKey: "evidence-1" }));
      },
    },
  );
  expect(answer).toEqual({ status: 404, code: "not_found" });
  expect(await rows()).toEqual(before);
});
