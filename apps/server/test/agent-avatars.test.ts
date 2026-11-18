import { afterEach, beforeEach, expect, test } from "bun:test";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ reply: () => ({ chunks: ["ok"] }), env: { ALLOW_SIGNUP: "true" } });
});
afterEach(() => t.close());

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
const image = { data: PNG, contentType: "image/png" };

test("agent portrait API persists, returns it on list/detail, gates reads and restores the pixel fallback", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const look = { color: "violet", eyes: "sleepy", accessory: "crown" };
  await api(`/agents/${agentId}`, { method: "PATCH", json: { appearance: look } });
  const before = (await (await api(`/agents/${agentId}`)).json()) as Record<string, unknown>;
  const put = await api(`/agents/${agentId}/avatar`, { method: "PUT", json: image });
  expect(put.status).toBe(200);
  const { avatarUrl } = (await put.json()) as { avatarUrl: string };
  const served = await owner(avatarUrl);
  expect(served.status).toBe(200);
  expect(served.headers.get("content-type")).toBe("image/png");
  expect(served.headers.get("cache-control")).toContain("private");
  expect(served.headers.get("x-content-type-options")).toBe("nosniff");
  expect(Buffer.from(await served.arrayBuffer()).toString("base64")).toBe(PNG);
  expect((await t.app.request(avatarUrl)).status).toBe(401);
  const stranger = browser(t);
  await signUp(stranger, "stranger@example.com");
  expect((await stranger(avatarUrl)).status).toBe(404);
  expect(
    (await stranger(`/api/app/organizations/${orgId}/agents/${agentId}/avatar`, { method: "PUT", json: image })).status,
  ).toBe(403);
  expect(
    (await stranger(`/api/app/organizations/${orgId}/agents/${agentId}/avatar`, { method: "DELETE" })).status,
  ).toBe(403);
  const listed = (await (await api("/agents")).json()) as { agents: { id: string; avatarUrl: string | null }[] };
  expect(listed.agents.find((agent) => agent.id === agentId)?.avatarUrl).toBe(avatarUrl);
  const after = await (await api(`/agents/${agentId}`)).json();
  expect(after).toMatchObject({ ...before, avatarUrl, appearance: look });
  expect((await api(`/agents/${agentId}/avatar`, { method: "DELETE" })).status).toBe(204);
  expect((await owner(avatarUrl)).status).toBe(404);
  expect(await (await api(`/agents/${agentId}`)).json()).toMatchObject({ avatarUrl: null, appearance: look });
});

test("bad portrait content and unsupported MIME types do not create a persistent URL", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const route = `/api/app/organizations/${orgId}/agents/${agentId}`;
  for (const bad of [
    { data: "https://example.com/portrait.png", contentType: "image/png" },
    { data: Buffer.from("<svg/>").toString("base64"), contentType: "image/png" },
    { data: PNG, contentType: "image/gif" },
    { data: PNG, contentType: "image/jpeg" },
  ])
    expect((await owner(`${route}/avatar`, { method: "PUT", json: bad })).status).toBe(400);
  expect(await (await owner(route)).json()).toMatchObject({ avatarUrl: null });
});

test("twelve distinct agent uploads are not blocked by a shared ten-photo user limit", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const root = `/api/app/organizations/${orgId}/agents`;
  const ids = [agentId];
  for (let i = 1; i < 12; i++) {
    const made = await owner(root, { json: { name: `Member ${i}`, handle: `member-${i}` } });
    expect(made.status).toBe(201);
    ids.push(((await made.json()) as { id: string }).id);
  }
  for (const id of ids) expect((await owner(`${root}/${id}/avatar`, { method: "PUT", json: image })).status).toBe(200);
});
