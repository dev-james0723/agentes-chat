import { afterEach, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import {
  type Mem0SyntheticCheckpoint,
  type Mem0SyntheticEvaluationReport,
  recordAudit,
  type SharedMemorySnapshot,
} from "@agenteschat/engine";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(async () => {
  await t?.close();
});

const SYNTHETIC_KEY = "synthetic-mem0-audit-test-key";
const MEMORY_ID = "00000000-0000-4000-8000-000000000101";
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

async function setup(withKey = true) {
  let requests = 0;
  let row: Record<string, unknown> | null = null;
  const http = (async (input: string | URL | Request, init?: RequestInit) => {
    requests++;
    const url = new URL(String(input));
    expect(url.origin).toBe("https://api.mem0.ai");
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Token ${SYNTHETIC_KEY}`);
    if (url.pathname === "/v3/memories/add/") {
      const journal = await t.db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.action, "shared_memory.mem0.checkpoint"));
      expect(journal.some((entry) => (entry.details.checkpoint as Mem0SyntheticCheckpoint).phase === "started")).toBe(
        true,
      );
      const body = JSON.parse(String(init?.body));
      row = { id: MEMORY_ID, memory: body.messages[0].content, user_id: body.user_id, metadata: body.metadata };
      return response({ results: [{ id: MEMORY_ID, event: "ADD" }] });
    }
    if (url.pathname === "/v3/memories/search/") return response({ message: "Synthetic unavailable search" }, 401);
    if (init?.method === "DELETE") return response({ message: "Synthetic unavailable cleanup" }, 503);
    return response(row);
  }) as unknown as typeof fetch;
  t = await createTestServer({
    env: { MEM0_ENABLED: "true", ...(withKey ? { MEM0_API_KEY: SYNTHETIC_KEY } : {}) },
    http,
  });
  const owner = browser(t);
  await signUp(owner, "mem0-audit-owner@example.com");
  const org = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${org.orgId}/shared-memory${path}`, init);
  expect((await api("/actions", { json: { type: "configure", name: "Synthetic evaluation owner" } })).status).toBe(200);
  const snapshot = (await (await api("")).json()) as SharedMemorySnapshot;
  const profile = snapshot.profile;
  if (!profile) throw new Error("Missing synthetic profile");
  const latest = () =>
    api("/mem0/evaluations/latest").then(
      (result) =>
        result.json() as Promise<{
          report: Mem0SyntheticEvaluationReport | null;
          checkpoint: Mem0SyntheticCheckpoint | null;
        }>,
    );
  return { api, owner, org, profile, latest, requests: () => requests };
}

test("Mem0 audit receipts retain cleanup IDs even when the original response is discarded", async () => {
  const f = await setup();
  expect(await f.latest()).toEqual({ report: null, checkpoint: null });
  const result = await f.api("/mem0/evaluate", { json: {} });
  expect(result.status).toBe(200);
  // The next GET reads the durable audit data; it does not depend on consuming the evaluation response.
  await result.body?.cancel();
  const latest = await f.latest();
  expect(latest.report).toMatchObject({
    status: "partial",
    providerVerified: false,
    evidenceMode: "injected_transport",
  });
  expect(latest.report?.cleanup.remainingIds).toEqual([MEMORY_ID]);
  expect(latest.report?.cleanup.status).toBe("incomplete");
  expect(latest.checkpoint?.runId ?? null).toBe(latest.report?.runId ?? null);
  expect(latest.checkpoint?.ownedMemoryIds).toContain(MEMORY_ID);
  expect(latest.checkpoint?.providerVerified).toBe(false);
  expect(f.requests()).toBe(5);
  const journal = await t.db
    .select({ details: schema.auditLog.details })
    .from(schema.auditLog)
    .where(eq(schema.auditLog.targetType, "shared_memory_mem0_evaluation"));
  expect(JSON.stringify(journal)).not.toContain(SYNTHETIC_KEY);
  expect(JSON.stringify(journal)).not.toContain("Synthetic evaluation only:");
  expect((await f.api("/mem0/evaluations/latest")).headers.get("cache-control")).toContain("no-store");
});

test("unfinished attempts stay distinct from a previous report and late checkpoints cannot rewind progress", async () => {
  const f = await setup();
  await f.api("/mem0/evaluate", { json: {} });
  const previous = await f.latest();
  const evaluationId = Bun.randomUUIDv7();
  const checkpoint: Mem0SyntheticCheckpoint = {
    provider: "mem0",
    suite: "synthetic_projection_v1",
    runId: `agentes-synthetic-${crypto.randomUUID()}`,
    observedAt: new Date().toISOString(),
    sequence: 2,
    evidenceMode: "injected_transport",
    phase: "running",
    providerVerified: false,
    privateMemoriesSent: false,
    modelAnswersTested: false,
    requests: 1,
    completedCases: 0,
    ownedMemoryIds: [],
    eventIds: [],
    unresolvedOperations: ["preferred-name:name:1"],
    cleanupDeleted: 0,
  };
  const checkpointAudit = (value: Mem0SyntheticCheckpoint, profileId = f.profile.id, targetId = evaluationId) =>
    recordAudit(t.db, {
      orgId: f.profile.canonicalOrgId,
      actor: { type: "person", id: f.profile.ownerUserId },
      action: "shared_memory.mem0.checkpoint",
      target: { type: "shared_memory_mem0_evaluation", id: targetId },
      details: { profileId, checkpoint: value },
      outcome: "pending",
    });
  await checkpointAudit(checkpoint);
  await checkpointAudit({ ...checkpoint, sequence: 1, phase: "started", requests: 0, unresolvedOperations: [] });
  await checkpointAudit(
    { ...checkpoint, unresolvedOperations: ["foreign-profile-must-not-surface"] },
    crypto.randomUUID(),
    Bun.randomUUIDv7(),
  );
  const latest = await f.latest();
  expect(latest.report?.runId).toBe(previous.report?.runId);
  expect(latest.checkpoint).toEqual(checkpoint);
  expect(latest.checkpoint?.runId).not.toBe(latest.report?.runId);
  expect(latest.checkpoint?.providerVerified).toBe(false);
  expect(JSON.stringify(latest)).not.toContain("foreign-profile-must-not-surface");
  expect(f.requests()).toBe(5);
});

test("another human cannot read the installation owner's synthetic audit receipts", async () => {
  const f = await setup();
  await f.api("/mem0/evaluate", { json: {} });
  const path = `/api/app/organizations/${f.org.orgId}/shared-memory/mem0/evaluations/latest`;
  expect((await t.app.request(path)).status).toBe(401);
  const other = await joinByInvitation(t, f.owner, f.org.orgId, "mem0-audit-other@example.com");
  expect((await other(path)).status).toBe(403);
  expect(f.requests()).toBe(5);
});

test("manual evaluations keep the two-per-hour bound and persist no-key outcomes without a provider request", async () => {
  const f = await setup(false);
  expect((await f.api("/mem0/evaluate", { json: {} })).status).toBe(200);
  expect((await f.api("/mem0/evaluate", { json: {} })).status).toBe(200);
  expect((await f.api("/mem0/evaluate", { json: {} })).status).toBe(429);
  const latest = await f.latest();
  expect(latest.report).toMatchObject({
    status: "unavailable",
    evidenceMode: "not_run",
    runId: null,
    providerVerified: false,
  });
  expect(latest.checkpoint).toBeNull();
  expect(f.requests()).toBe(0);
  const receipts = await t.db
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.action, "shared_memory.mem0.completed"), eq(schema.auditLog.orgId, f.org.orgId)));
  expect(receipts).toHaveLength(2);
});

test("an evaluation reserves its owner while the asynchronous rate check is pending", async () => {
  const f = await setup(false);
  const entered = Promise.withResolvers<void>();
  const overlap = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const consume = t.adapters.rateLimiter.consume.bind(t.adapters.rateLimiter);
  let evaluations = 0;
  t.adapters.rateLimiter.consume = async (key, limit) => {
    if (key.startsWith("shared-memory-mem0:")) {
      evaluations++;
      if (evaluations === 1) entered.resolve();
      else overlap.resolve();
      await release.promise;
    }
    return consume(key, limit);
  };
  const first = f.api("/mem0/evaluate", { json: {} });
  await entered.promise;
  const second = f.api("/mem0/evaluate", { json: {} });
  const result = await Promise.race([
    second.then((response) => response.status),
    overlap.promise.then(() => "overlapping_rate_checks"),
  ]);
  release.resolve();
  const responses = await Promise.all([first, second]);
  expect(result).toBe(409);
  expect(responses.map((response) => response.status)).toEqual([200, 409]);
  expect(evaluations).toBe(1);
  expect((await f.api("/mem0/evaluate", { json: {} })).status).toBe(200);
  expect(f.requests()).toBe(0);
});
