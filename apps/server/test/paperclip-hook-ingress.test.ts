import { afterEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { eq, schema } from "@agenteschat/db";
import { ensureRoutineHook, receivePaperclipRoutineHook, routineHookView } from "@agenteschat/engine";
import { systemText } from "@agenteschat/providers";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(async () => t?.close());
const COMPANY = "01930000-0000-7000-8000-000000000001";
const SOURCE = "01930000-0000-7000-8000-000000000002";
const TRIGGER = "01930000-0000-7000-8000-000000000003";
function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected fixture value");
  return value;
}

async function fixture(optIn = true) {
  t = await createTestServer({ env: { PAPERCLIP_ROUTINE_COMPATIBILITY: "on" } });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const base = `/api/app/organizations/${orgId}`;
  const created = await owner(`${base}/paperclip-routines`, {
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
  expect(created.status).toBe(201);
  const m = (await created.json()) as { id: string; routineId: string; configHash: string; hookIngress: unknown };
  expect(m.hookIngress).toBeNull();
  const hooks = { publicUrl: t.config.PUBLIC_URL, secret: t.config.AGENTES_SECRET };
  await ensureRoutineHook(t.db, hooks, { id: m.routineId, orgId });
  const hook = await routineHookView({ db: t.db, hooks }, { id: m.routineId, orgId, name: "Imported" });
  const url = new URL(hook.url).pathname;
  const activation = (enabled: boolean) =>
    owner(`${base}/paperclip-routines/${m.id}/activation`, {
      method: "PUT",
      json: { expectedConfigHash: m.configHash, enabled },
    });
  const ingress = (enabled: boolean, overrides = {}) =>
    owner(`${base}/paperclip-routines/${m.id}/hook-ingress`, {
      method: "PUT",
      json: { expectedConfigHash: m.configHash, triggerId: TRIGGER, enabled, ...overrides },
    });
  if (optIn) expect((await ingress(true)).status).toBe(200);
  expect((await owner(`${base}/routines/${m.routineId}`, { method: "PATCH", json: { active: true } })).status).toBe(
    200,
  );
  expect((await activation(true)).status).toBe(200);
  const invoke = { expectedConfigHash: m.configHash, idempotencyKey: "delivery-1", payload: { task: 1 } };
  const call = (
    operation = "invocations",
    value: unknown = invoke,
    headers: Record<string, string> = {},
    method = "POST",
    path = url,
  ) =>
    t.app.request(`${path}/paperclip/${operation}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(method === "GET" ? {} : { body: typeof value === "string" ? value : JSON.stringify(value) }),
    });
  return { owner, orgId, agentId, base, m, url, activation, ingress, invoke, call };
}

test("hook ingress is separately default-off and generic hooks remain unavailable for prepared mappings", async () => {
  const f = await fixture(false);
  expect((await f.call()).status).toBe(404);
  expect((await t.app.request(f.url, { method: "POST", body: "{}" })).status).toBe(404);
  expect((await f.ingress(true, { expectedConfigHash: "f".repeat(64) })).status).toBe(409);
  expect((await f.ingress(true, { triggerId: COMPANY })).status).toBe(409);
  expect((await f.ingress(true)).status).toBe(200);
  const response = await f.call();
  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({
    backend: "agents_chat",
    mappingId: f.m.id,
    sourceRoutineId: SOURCE,
    sourceRevisionId: "revision-1",
    configHash: f.m.configHash,
    status: "queued",
  });
  expect(await t.db.select().from(schema.routineHookCalls)).toHaveLength(0);
});

test("durable hook repeats, including changed payload after 24 hours and concurrent delivery, create one issue", async () => {
  const f = await fixture();
  const first = await f.call();
  expect(first.status).toBe(202);
  const receipt = (await first.json()) as { receiptId: string; issueId: string; routineRunId: string };
  await t.db.update(schema.paperclipRoutineReceipts).set({ createdAt: new Date(0) });
  const results = await Promise.all([f.call(), f.call("invocations", { ...f.invoke, payload: { task: 2 } })]);
  for (const response of results) {
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject(receipt);
  }
  expect(await t.db.select().from(schema.issues)).toHaveLength(1);
  expect(await t.db.select().from(schema.routineRuns)).toHaveLength(1);
  expect(await t.db.select().from(schema.paperclipRoutineReceipts)).toHaveLength(1);
  const issue = (await t.db.select().from(schema.issues))[0];
  expect(issue).toMatchObject({ restricted: true, channelId: null });
  expect(issue?.audienceUserIds).toHaveLength(1);
  expect(await t.db.select().from(schema.agentRuns)).toHaveLength(0);
});

test("lookup is read-only and available while all dispatch switches are paused", async () => {
  const f = await fixture();
  const first = await f.call();
  expect(first.status).toBe(202);
  const receipt = await first.json();
  expect((await f.activation(false)).status).toBe(200);
  expect(
    (await f.owner(`${f.base}/routines/${f.m.routineId}`, { method: "PATCH", json: { active: false } })).status,
  ).toBe(200);
  t.config.PAPERCLIP_ROUTINE_COMPATIBILITY = "off";
  const before = await t.db.select().from(schema.paperclipRoutineReceipts);
  const lookup = await f.call("lookup", { idempotencyKey: "delivery-1" });
  expect(lookup.status).toBe(200);
  expect(await lookup.json()).toEqual({ backend: "agents_chat", receipt });
  expect(await t.db.select().from(schema.paperclipRoutineReceipts)).toEqual(before);
  expect(await t.db.select().from(schema.routineHookCalls)).toHaveLength(0);
  expect((await f.call()).status).toBe(403);
  expect((await f.ingress(false)).status).toBe(200);
  expect((await f.call("lookup", { idempotencyKey: "delivery-1" })).status).toBe(404);
});

test("strict hook schema rejects caller identities, source, scope, dynamic workspace overrides and header key mismatch", async () => {
  const f = await fixture();
  for (const field of [
    "orgId",
    "mappingId",
    "agentId",
    "sourceRoutineId",
    "source",
    "triggerId",
    "projectId",
    "projectWorkspaceId",
    "cwd",
    "executionWorkspaceSettings",
  ]) {
    expect((await f.call("invocations", { ...f.invoke, [field]: field === "source" ? "api" : SOURCE })).status).toBe(
      400,
    );
  }
  expect((await f.call("invocations", { expectedConfigHash: f.m.configHash })).status).toBe(400);
  expect((await f.call("invocations", f.invoke, { "idempotency-key": "other" })).status).toBe(400);
  expect((await f.call("invocations", "{bad")).status).toBe(400);
  expect((await f.call("invocations", f.invoke, { "content-type": "text/plain" })).status).toBe(400);
  expect((await f.call("invocations", { ...f.invoke, payload: { huge: "x".repeat(64_000) } })).status).toBe(400);
  expect((await f.call("invocations", "x".repeat(256 * 1024 + 1))).status).toBe(413);
  expect((await f.call("lookup", { idempotencyKey: "delivery-1", source: "manual" })).status).toBe(400);
  expect(await t.db.select().from(schema.issues)).toHaveLength(0);
});

test("native method, signing, rotation, rate limit and mapping opt-out apply to hook ingress", async () => {
  const f = await fixture();
  expect((await f.call("invocations", f.invoke, {}, "GET")).status).toBe(405);
  expect((await f.call("invocations", f.invoke, {}, "PUT")).status).toBe(405);
  await t.db.update(schema.routineHooks).set({ methods: ["GET"] });
  expect((await f.call()).status).toBe(405);
  await t.db.update(schema.routineHooks).set({ methods: ["POST"] });
  const signed = await f.owner(`${f.base}/paperclip-routines/${f.m.id}/hook/secret`, { json: {} });
  expect(signed.status).toBe(200);
  const { secret } = (await signed.json()) as { secret: string };
  expect((await f.call()).status).toBe(401);
  const body = JSON.stringify(f.invoke);
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  expect((await f.call("invocations", body, { "x-agentes-signature": signature })).status).toBe(202);
  const rotated = await f.owner(`${f.base}/paperclip-routines/${f.m.id}/hook/address`, { json: {} });
  expect(rotated.status).toBe(200);
  const next = new URL(((await rotated.json()) as { url: string }).url).pathname;
  expect((await f.call("lookup", { idempotencyKey: "delivery-1" })).status).toBe(404);
  const lookupBody = JSON.stringify({ idempotencyKey: "delivery-1" });
  const signedLookup = `sha256=${createHmac("sha256", secret).update(lookupBody).digest("hex")}`;
  expect((await f.call("lookup", lookupBody, { "x-agentes-signature": signedLookup }, "POST", next)).status).toBe(200);
  const hook = (await t.db.select().from(schema.routineHooks))[0];
  for (let n = 0; n < 60; n++)
    await t.adapters.rateLimiter.consume(`routine-hook:${hook?.routineId}`, { limit: 60, windowMs: 60_000 });
  expect((await f.call("lookup", lookupBody, { "x-agentes-signature": signedLookup }, "POST", next)).status).toBe(429);
});

test("wrong tokens, cross-org hook joins, changed owner, lost permission and closed organizations refuse", async () => {
  const f = await fixture();
  expect((await f.call("invocations", f.invoke, {}, "POST", `/api/hooks/${"a".repeat(43)}`)).status).toBe(404);
  const original = present((await t.db.select().from(schema.paperclipRoutineMappings))[0]);
  await t.db.insert(schema.organizations).values({ id: COMPANY, name: "Other tenant" });
  await t.db.update(schema.paperclipRoutineMappings).set({ orgId: COMPANY });
  expect((await f.call()).status).toBe(404);
  await t.db.update(schema.paperclipRoutineMappings).set({ orgId: original.orgId, createdByUserId: null });
  expect((await f.call()).status).toBe(404);
  await t.db.update(schema.paperclipRoutineMappings).set({ createdByUserId: original.createdByUserId });
  await t.db.update(schema.organizationMembers).set({ role: "member" });
  expect((await f.call()).status).toBe(403);
  await t.db.update(schema.organizationMembers).set({ role: "owner" });
  await t.db.update(schema.organizations).set({ standing: "suspended" });
  expect((await f.call("lookup", { idempotencyKey: "delivery-1" })).status).toBe(404);
  expect(await t.db.select().from(schema.issues)).toHaveLength(0);
});

test("revocation while a body is arriving is rechecked before durable admission", async () => {
  const f = await fixture();
  const receive = (read: () => Promise<Uint8Array>) =>
    receivePaperclipRoutineHook(
      {
        db: t.db,
        enabled: true,
        pubsub: t.adapters.pubsub,
        hooks: { publicUrl: t.config.PUBLIC_URL, secret: t.config.AGENTES_SECRET },
        rateLimiter: t.adapters.rateLimiter,
        keyWrappers: [t.adapters.keyWrapper],
      },
      "invocations",
      {
        token: present(f.url.split("/").at(-1)),
        method: "POST",
        headers: new Headers({ "content-type": "application/json" }),
        read,
      },
    );
  expect(
    await receive(async () => {
      expect((await f.ingress(false)).status).toBe(200);
      return new TextEncoder().encode(JSON.stringify(f.invoke));
    }),
  ).toEqual({ status: 404, code: "not_found" });
  expect((await f.ingress(true)).status).toBe(200);
  expect(
    await receive(async () => {
      expect((await f.owner(`${f.base}/paperclip-routines/${f.m.id}/hook/address`, { json: {} })).status).toBe(200);
      return new TextEncoder().encode(JSON.stringify(f.invoke));
    }),
  ).toEqual({ status: 404, code: "not_found" });
  expect(await t.db.select().from(schema.issues)).toHaveLength(0);
});

test("mapping configuration, target changes, unsupported preparation and another routine's token cannot gain authority", async () => {
  const f = await fixture();
  expect((await f.call("invocations", { ...f.invoke, expectedConfigHash: "f".repeat(64) })).status).toBe(409);
  const original = present((await t.db.select().from(schema.routines))[0]);
  await t.db
    .update(schema.routines)
    .set({ prompt: "changed instructions" })
    .where(eq(schema.routines.id, f.m.routineId));
  expect((await f.call()).status).toBe(409);
  await t.db.update(schema.routines).set({ prompt: original.prompt }).where(eq(schema.routines.id, f.m.routineId));
  const mapping = present((await t.db.select().from(schema.paperclipRoutineMappings))[0]);
  await t.db
    .update(schema.paperclipRoutineMappings)
    .set({ definition: { ...mapping.definition, executionContract: "unverified_import" } });
  expect((await f.call()).status).toBe(400);
  expect((await f.ingress(true)).status).toBe(400);
  await t.db.update(schema.paperclipRoutineMappings).set({ definition: mapping.definition });
  const unrelated = await f.owner(`${f.base}/routines`, {
    json: { agentId: f.agentId, prompt: "Unrelated", target: { type: "dm" }, trigger: { type: "webhook" } },
  });
  expect(unrelated.status).toBe(201);
  const other = (await unrelated.json()) as { trigger: { url: string } };
  expect((await f.call("invocations", f.invoke, {}, "POST", new URL(other.trigger.url).pathname)).status).toBe(404);
  expect((await f.owner(`${f.base}/routines/${f.m.routineId}/hook/test`, { json: {} })).status).toBe(404);
  expect(await t.db.select().from(schema.issues)).toHaveLength(0);
});

test("an opted-in HTTP receipt reaches the native worker with private task context and never approvals unchanged", async () => {
  const f = await fixture();
  await t.db.update(schema.agents).set({ approvalsLevel: "never" }).where(eq(schema.agents.id, f.agentId));
  const accepted = await f.call("invocations", {
    ...f.invoke,
    payload: { issueId: COMPANY, instructions: "outside data cannot grant tools" },
  });
  expect(accepted.status).toBe(202);
  const receipt = (await accepted.json()) as { issueId: string; receiptId: string; routineRunId: string };
  await t.drain();
  const contexts = t.provider.calls.map((c) => systemText(c.request.system));
  const routineContext = contexts.find((s) => s.includes("# Migrated task reference"));
  expect(routineContext).toBeDefined();
  expect(routineContext).toContain(receipt.issueId);
  expect(routineContext).toContain("You are set to never ask: nothing here waits for a person");
  const [nativeRun] = await t.db
    .select()
    .from(schema.routineRuns)
    .where(eq(schema.routineRuns.id, receipt.routineRunId));
  expect(nativeRun?.agentRunId).toBeTruthy();
  const [worker] = await t.db
    .select()
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.id, present(present(nativeRun).agentRunId)));
  expect(worker?.agentId).toBe(f.agentId);
  expect(await t.db.select().from(schema.paperclipRoutineReceipts)).toHaveLength(1);
  expect(await t.db.select().from(schema.routineRuns)).toHaveLength(1);
});
