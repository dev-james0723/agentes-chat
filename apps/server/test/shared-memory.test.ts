import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { insertMessage, type SharedMemoryActionResult, type SharedMemorySnapshot } from "@agenteschat/engine";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(async () => {
  await t?.close();
});

async function setup(options: Parameters<typeof createTestServer>[0] = {}) {
  t = await createTestServer(options);
  const owner = browser(t);
  await signUp(owner, "memory-owner@example.com");
  const first = await seedOrg(owner);
  expect(
    (await owner(`/api/app/organizations/${first.orgId}/onboarding`, { method: "PATCH", json: { finished: true } }))
      .status,
  ).toBe(200);
  const nextOrg = await owner("/api/app/organizations", { json: { name: "Second workspace" } });
  expect(nextOrg.status).toBe(201);
  const second = { orgId: ((await nextOrg.json()) as { organization: { id: string } }).organization.id };
  expect(second.orgId).not.toBe(first.orgId);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${first.orgId}${path}`, init);
  const created = await api("/context-items", {
    json: {
      kind: "fact",
      title: "Release preference",
      content: "For the fictional Orion project, prefer a concise review.",
    },
  });
  expect(created.status).toBe(201);
  const item = (await created.json()) as { id: string };
  const configure = await api("/shared-memory/actions", {
    json: {
      type: "configure",
      name: "Owner memory",
      destinations: [{ orgId: second.orgId, allowedSensitivity: ["personal", "workspace"] }],
      adopt: [{ itemId: item.id, key: "orion.review", sensitivity: "personal" }],
    },
  });
  expect(configure.status).toBe(200);
  await t.drain();
  const read = () => api("/shared-memory").then((r) => r.json() as Promise<SharedMemorySnapshot>);
  return { owner, first, second, api, read, item };
}

test("shared memory API adopts native data, reconciles another workspace and keeps receipts separate from recall", async () => {
  const { api, read, second } = await setup();
  const response = await api("/shared-memory");
  expect(response.headers.get("cache-control")).toContain("no-store");
  const view = (await response.json()) as SharedMemorySnapshot;
  expect(view.profile?.name).toBe("Owner memory");
  expect(view.entries).toHaveLength(1);
  expect(view.entries[0]?.content).toContain("concise review");
  expect(view.entries[0]?.replicas).toContainEqual(expect.objectContaining({ orgId: second.orgId, state: "current" }));
  expect(view.verification.status).toBe("not_run");
  const once = view.entries[0]?.replicas[0]?.itemId;
  expect((await api("/shared-memory/actions", { json: { type: "reconcile" } })).status).toBe(200);
  await t.drain();
  expect((await read()).entries[0]?.replicas[0]?.itemId).toBe(once);
});

test("corrections are version fenced and exports contain only the current accepted value", async () => {
  const { api, read } = await setup();
  const entry = (await read()).entries[0];
  if (!entry) throw new Error("Missing adopted entry");
  const corrected = await api("/shared-memory/actions", {
    json: {
      type: "correct",
      entryId: entry.id,
      expectedVersion: entry.version,
      content: "Orion reviews now need a short summary followed by source links.",
    },
  });
  expect(corrected.status).toBe(200);
  await t.drain();
  const stale = await api("/shared-memory/actions", {
    json: {
      type: "correct",
      entryId: entry.id,
      expectedVersion: entry.version,
      content: "Stale inference must not replace the correction.",
    },
  });
  expect(stale.status).toBe(409);
  const exported = await api("/shared-memory/export");
  expect(exported.status).toBe(200);
  expect(exported.headers.get("content-disposition")).toContain("shared-memory.md");
  const markdown = await exported.text();
  expect(markdown).toContain("short summary followed by source links");
  expect(markdown).not.toContain("Stale inference");
  expect(markdown).not.toContain("prefer a concise review");
  expect(markdown).toContain("does not prove another AI has loaded it");
});

test("source withdrawal redacts the owner view, fences exports and invalidates a current file receipt", async () => {
  const { api, read, first, item } = await setup();
  const original = await read();
  if (!original.profile) throw new Error("Missing profile");
  const source = await insertMessage(t.db, {
    orgId: first.orgId,
    channelId: first.channelId,
    author: { type: "person", userId: original.profile.ownerUserId },
    body: "Remember: For the fictional Orion project, prefer a concise review.",
  });
  await t.db
    .update(schema.contextItems)
    .set({ sourceIds: [source.id], channelIds: [first.channelId] })
    .where(eq(schema.contextItems.id, item.id));
  const before = await read();
  const entry = before.entries[0];
  if (!entry || !before.profile) throw new Error("Missing source-backed entry");
  expect(entry.readable).toBe(true);
  const [proposal] = await t.db
    .insert(schema.contextProposals)
    .values({
      orgId: first.orgId,
      target: "org_context",
      baseHash: "synthetic-source-backed-proposal",
      proposedText: entry.content,
      diff: `+${entry.content}`,
      rationale: "Synthetic proposal citing the current memory",
      itemIds: [item.id],
      status: "accepted",
    })
    .returning();
  if (!proposal) throw new Error("Missing source-backed proposal");
  expect(await (await api(`/proposals?ids=${proposal.id}`)).text()).toContain(entry.content);
  const consumer = {
    id: "synthetic-file-export",
    name: "Synthetic export",
    kind: "file",
    status: "current",
    revision: before.profile.version,
    availabilityRevision: before.profile.availabilityRevision,
    checkedAt: new Date().toISOString(),
    reason: "Synthetic file verification receipt",
    writable: false,
  };
  expect((await api("/shared-memory/actions", { json: { type: "consumer", consumer } })).status).toBe(200);
  expect((await read()).consumers.find((row) => row.id === consumer.id)?.status).toBe("current");
  await t.db.update(schema.messages).set({ deletedAt: new Date() }).where(eq(schema.messages.id, source.id));
  const withdrawn = await read();
  expect(withdrawn.profile?.version).toBe(before.profile.version);
  expect(withdrawn.profile?.availabilityRevision).not.toBe(before.profile.availabilityRevision);
  const hidden = withdrawn.entries.find((row) => row.id === entry.id);
  expect(hidden?.readable).toBe(false);
  expect(hidden?.itemId).toBeNull();
  expect(hidden?.itemVersion).toBeNull();
  expect(hidden?.history).toEqual([]);
  expect(hidden?.blockedReason).toBeTruthy();
  expect(JSON.stringify(withdrawn)).not.toContain(entry.content);
  expect(JSON.stringify(withdrawn)).not.toContain(entry.title);
  expect(withdrawn.consumers.find((row) => row.id === consumer.id)?.status).toBe("pending");
  const hiddenProposals = await api(`/proposals?ids=${proposal.id}`);
  expect(hiddenProposals.status).toBe(200);
  expect(await hiddenProposals.json()).toEqual({ proposals: [] });
  const exported = await api("/shared-memory/export");
  expect(exported.status).toBe(200);
  const markdown = await exported.text();
  expect(markdown).not.toContain(entry.content);
  expect(markdown).toContain("Unavailable active memories omitted: 1");
  const stale = await api("/shared-memory/actions", { json: { type: "consumer", consumer } });
  expect(stale.status).toBe(200);
  const result = (await stale.json()) as SharedMemoryActionResult;
  expect(result.snapshot.consumers.find((row) => row.id === consumer.id)?.status).toBe("pending");
});

test("shared memory routes require the session and reject cross-origin or forged actions", async () => {
  const { api, first, read } = await setup();
  expect((await t.app.request(`/api/app/organizations/${first.orgId}/shared-memory`)).status).toBe(401);
  expect(
    (await api("/shared-memory/actions", { json: { type: "reconcile" }, origin: "https://unrelated.example" })).status,
  ).toBe(403);
  const entry = (await read()).entries[0];
  expect(
    (
      await api("/shared-memory/actions", {
        json: { type: "correct", entryId: entry?.id, expectedVersion: 0, content: "bad" },
      })
    ).status,
  ).toBe(400);
  expect(
    (await api("/shared-memory/actions", { json: { type: "reconcile", ownerUserId: "forged-owner" } })).status,
  ).toBe(400);
  expect(
    (
      await api("/shared-memory/actions", {
        json: { type: "verify", runId: crypto.randomUUID(), entryIds: [entry?.id] },
      })
    ).status,
  ).not.toBe(200);
});

test("a newly admitted human cannot inspect existing managed private bodies or history through either API", async () => {
  const { owner, first, api, read, item } = await setup();
  const privateBody = (await read()).entries[0]?.content ?? "";
  const [proposal] = await t.db
    .insert(schema.contextProposals)
    .values({
      orgId: first.orgId,
      target: "org_context",
      baseHash: "synthetic-managed-proposal",
      proposedText: privateBody,
      diff: `+${privateBody}`,
      rationale: "Synthetic proposal citing managed personal memory",
      itemIds: [item.id],
      status: "accepted",
    })
    .returning();
  if (!proposal) throw new Error("Missing managed proposal");
  expect(await (await api(`/proposals?ids=${proposal.id}`)).text()).toContain(privateBody);
  const other = await joinByInvitation(t, owner, first.orgId, "memory-reviewer@example.com", { role: "admin" });
  const base = `/api/app/organizations/${first.orgId}`;
  for (const path of [
    "/shared-memory",
    "/shared-memory/export",
    "/context-items?includeArchived=true",
    `/proposals?ids=${proposal.id}`,
  ]) {
    const response = await other(`${base}${path}`);
    expect(await response.text()).not.toContain(privateBody);
  }
  // A managed body remains the owner's even where the native row had no private message source.
  const [native] = await t.db.select().from(schema.contextItems).where(eq(schema.contextItems.id, item.id));
  expect(native).toBeDefined();
  const response = await api("/shared-memory");
  expect(response.status).toBe(200);
});

test("forget carries an outstanding consumer status and does not report remote erasure from local success", async () => {
  const { api, read } = await setup();
  expect(
    (
      await api("/shared-memory/actions", {
        json: {
          type: "consumer",
          consumer: {
            id: "consumer-claude",
            name: "Claude snapshot",
            kind: "claude",
            status: "snapshot",
            revision: 1,
            checkedAt: new Date().toISOString(),
            reason: "One-time imported snapshot; no continuous connector.",
            writable: false,
          },
        },
      })
    ).status,
  ).toBe(200);
  const entry = (await read()).entries[0];
  if (!entry) throw new Error("Missing entry");
  const forgotten = await api("/shared-memory/actions", {
    json: { type: "forget", entryId: entry.id, expectedVersion: entry.version, scope: "profile" },
  });
  expect(forgotten.status).toBe(200);
  await t.drain();
  const result = (await forgotten.json()) as SharedMemoryActionResult;
  const row = result.snapshot.entries.find((e) => e.id === entry.id);
  expect(row?.status).toBe("forgotten");
  expect(row?.externalOutstanding.length).toBeGreaterThan(0);
  expect(await (await api("/shared-memory/export")).text()).not.toContain(entry.content);
  const retry = await api("/shared-memory/actions", {
    json: { type: "configure", adopt: [{ itemId: entry.itemId, key: entry.key }] },
  });
  expect([200, 400, 404, 409]).toContain(retry.status);
  expect((await read()).entries.some((e) => e.key === entry.key && e.status === "active")).toBe(false);
});

test("a consumer receipt cannot turn a native account snapshot into live two-way synchronization", async () => {
  const { api, read } = await setup();
  const request = await api("/shared-memory/actions", {
    json: {
      type: "consumer",
      consumer: {
        id: "consumer-chatgpt",
        name: "ChatGPT",
        kind: "chatgpt",
        status: "current",
        revision: 1,
        checkedAt: new Date().toISOString(),
        reason: "User report only",
        writable: true,
      },
    },
  });
  if (request.status === 200) {
    const receipt = (await read()).consumers.find((c) => c.id === "consumer-chatgpt");
    expect(receipt?.writable).toBe(false);
    expect(receipt?.status).not.toBe("current");
  } else expect(request.status).toBe(400);
});

test("Mem0 without a key reports unavailability and never attempts an outbound request", async () => {
  let requests = 0;
  const { api, read } = await setup({
    env: { MEM0_ENABLED: "true" },
    http: (async () => {
      requests++;
      throw new Error("No provider request expected");
    }) as unknown as typeof fetch,
  });
  const readiness = await api("/shared-memory/mem0");
  expect(readiness.status).toBe(200);
  expect(await readiness.json()).toMatchObject({ readiness: "missing_key", configured: false, canEvaluate: true });
  const evaluation = await api("/shared-memory/mem0/evaluate", { json: {} });
  expect(evaluation.status).toBe(200);
  expect(await evaluation.json()).toMatchObject({
    status: "unavailable",
    evidenceMode: "not_run",
    providerVerified: false,
    privateMemoriesSent: false,
    modelAnswersTested: false,
  });
  expect(requests).toBe(0);
  expect((await read()).consumers.find((c) => c.id === "mem0-synthetic-evaluation")?.status).toBe("blocked");
  expect((await api("/shared-memory/mem0/evaluate", { json: { text: "private data" } })).status).toBe(400);
});

test("a separate profile owner cannot use the installation's Mem0 credential", async () => {
  let requests = 0;
  const secret = "synthetic-mem0-key-never-return-to-client";
  const { owner, first, api } = await setup({
    env: { MEM0_ENABLED: "true", MEM0_API_KEY: secret },
    http: (async () => {
      requests++;
      throw new Error("No provider request expected");
    }) as unknown as typeof fetch,
  });
  const self = await api("/shared-memory/mem0");
  expect(await self.text()).not.toContain(secret);
  const secondOwner = await joinByInvitation(t, owner, first.orgId, "separate-profile@example.com");
  const ownOrg = await seedOrg(secondOwner);
  const base = `/api/app/organizations/${ownOrg.orgId}/shared-memory`;
  expect((await secondOwner(`${base}/actions`, { json: { type: "configure", name: "Separate owner" } })).status).toBe(
    200,
  );
  const available = await secondOwner(`${base}/mem0`);
  expect(available.status).toBe(200);
  expect(await available.json()).toMatchObject({ canEvaluate: false });
  const denied = await secondOwner(`${base}/mem0/evaluate`, { json: {} });
  expect(denied.status).toBe(403);
  expect(await denied.text()).not.toContain(secret);
  expect(requests).toBe(0);
});

test("native context pagination traverses more than 500 rows without silent truncation", async () => {
  const { api, first } = await setup();
  await t.db.insert(schema.contextItems).values(
    Array.from({ length: 502 }, (_, index) => ({
      orgId: first.orgId,
      kind: "fact" as const,
      title: `Synthetic row ${index}`,
      content: `Fixture ${index}`,
      scopeType: "org" as const,
      scopeId: first.orgId,
      createdByKind: "person" as const,
    })),
  );
  const seen = new Set<string>();
  let cursor: string | null = null;
  let pages = 0;
  do {
    const response = await api(`/context-items?paginate=true&limit=500${cursor ? `&cursor=${cursor}` : ""}`);
    expect(response.status).toBe(200);
    const page = (await response.json()) as { items: { id: string }[]; nextCursor: string | null };
    for (const item of page.items) {
      expect(seen.has(item.id)).toBe(false);
      seen.add(item.id);
    }
    cursor = page.nextCursor;
    pages++;
    if (pages > 3) throw new Error("Pagination failed to terminate");
  } while (cursor);
  expect(seen.size).toBe(503);
  expect(pages).toBe(2);
  const legacy = await api("/context-items?limit=500");
  expect(Object.hasOwn((await legacy.json()) as Record<string, unknown>, "nextCursor")).toBe(false);
});
