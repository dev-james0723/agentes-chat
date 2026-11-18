import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { insertContextItem, insertMessage, openDm } from "@agenteschat/engine";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(async () => {
  await t?.close();
});
async function setup() {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const response = await api("/context-items", {
    json: { kind: "fact", agentId, content: "Orion releases require review." },
  });
  expect(response.status).toBe(201);
  const item = (await response.json()) as { id: string; version: number };
  return { api, item, agentId, orgId, owner };
}
test("the actual memory endpoint rejects a stale version before changing text", async () => {
  const { api, item } = await setup();
  const rejected = await api(`/memories/${item.id}`, {
    method: "PATCH",
    json: { text: "Orion bypasses review.", expectedVersion: 999 },
  });
  expect(rejected.status).toBe(409);
  const rows = await t.db.select().from(schema.contextItems);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.content).toBe("Orion releases require review.");
});
test("memory views and metadata mutations carry the same native version fence", async () => {
  const { api, item, agentId } = await setup();
  const list = (await (await api(`/agents/${agentId}/memories`)).json()) as {
    memories: { id: string; version: number }[];
  };
  expect(list.memories.find((m) => m.id === item.id)?.version).toBe(item.version);
  const pinned = await api(`/memories/${item.id}`, {
    method: "PATCH",
    json: { pinned: true, expectedVersion: item.version },
  });
  expect(pinned.status).toBe(200);
  const latest = (await pinned.json()) as { version: number };
  expect(latest.version).toBe(item.version + 1);
  expect(
    (await api(`/memories/${item.id}`, { method: "PATCH", json: { archived: true, expectedVersion: item.version } }))
      .status,
  ).toBe(409);
  const changed = await api(`/memories/${item.id}`, {
    method: "PATCH",
    json: { text: "Orion requires two reviews.", expectedVersion: latest.version },
  });
  expect(changed.status).toBe(200);
  const next = (await changed.json()) as { id: string; version: number };
  expect(next.id).not.toBe(item.id);
  expect(next.version).toBe(latest.version + 1);
  expect(
    (await api(`/memories/${next.id}`, { method: "PATCH", json: { pinned: false, expectedVersion: 0 } })).status,
  ).toBe(400);
});

test("a readable memory's previous-text preview cannot expose another person's private source", async () => {
  const { api, item, agentId, orgId, owner } = await setup();
  await joinByInvitation(t, owner, orgId, "private-person@example.com");
  const [other] = await t.db.select().from(schema.users).where(eq(schema.users.email, "private-person@example.com"));
  if (!other) throw new Error("Missing private member");
  const dm = await openDm(t.db, other.id, orgId, { agentId });
  const message = await insertMessage(t.db, {
    orgId,
    channelId: dm.id,
    author: { type: "person", userId: other.id },
    body: "Private predecessor sentinel 764.",
  });
  const previous = await insertContextItem(t.db, {
    orgId,
    agentId,
    kind: "fact",
    scopeType: "agent",
    scopeId: agentId,
    content: message.body,
    channelIds: [],
    sourceIds: [message.id],
    createdByKind: "person",
    createdById: other.id,
  });
  await t.db
    .update(schema.contextItems)
    .set({ status: "archived", supersededBy: item.id })
    .where(eq(schema.contextItems.id, previous.id));
  const response = await api(`/agents/${agentId}/memories`);
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).toContain("Orion releases require review.");
  expect(body).not.toContain("Private predecessor sentinel 764.");
  const current = JSON.parse(body).memories.find((m: { id: string }) => m.id === item.id);
  expect(current.supersedes).toBeNull();
});

test("a forged predecessor link from another organization never appears in memory history", async () => {
  const { api, item, agentId } = await setup();
  const foreignOrg = crypto.randomUUID();
  await t.db.insert(schema.organizations).values({ id: foreignOrg, name: "Foreign fixture" });
  const previous = await insertContextItem(t.db, {
    orgId: foreignOrg,
    kind: "fact",
    scopeType: "org",
    scopeId: foreignOrg,
    content: "Foreign predecessor sentinel 975.",
    channelIds: [],
  });
  await t.db
    .update(schema.contextItems)
    .set({ status: "archived", supersededBy: item.id })
    .where(eq(schema.contextItems.id, previous.id));
  const response = await api(`/agents/${agentId}/memories`);
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).toContain("Orion releases require review.");
  expect(body).not.toContain("Foreign predecessor sentinel 975.");
});
