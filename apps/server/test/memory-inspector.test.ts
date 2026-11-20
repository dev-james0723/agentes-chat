import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { insertContextItem, insertMessage, openDm } from "@agenteschat/engine";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(async () => {
  await t?.close();
});

type View = {
  id: string;
  version: number;
  scope: { type: string; id: string | null };
  trust: string;
  status: string;
  validFrom: string | null;
  validTo: string | null;
  sourceRevision: string | null;
  sourceMessage: { messageId: string; channelId: string; threadId: string | null; at: string } | null;
};
type History = {
  versions: { id: string; version: number; text: string; current: boolean; supersededAt: string | null }[];
  runs: { runId: string; agentId: string; agentName: string | null; channelId: string; channelName: string | null }[];
};

async function userId(email: string) {
  const [row] = await t.db.select().from(schema.users).where(eq(schema.users.email, email));
  if (!row) throw new Error(`Missing ${email}`);
  return row.id;
}

async function run(orgId: string, agentId: string, channelId: string, itemId: string) {
  const trigger = Bun.randomUUIDv7();
  const [row] = await t.db
    .insert(schema.agentRuns)
    .values({
      orgId,
      agentId,
      channelId,
      threadRootId: trigger,
      triggerMessageId: trigger,
      trigger: "mention",
      hop: 1,
      status: "done",
    })
    .returning();
  if (!row) throw new Error("no run");
  await t.db.insert(schema.contextUsage).values({ orgId, runId: row.id, itemId });
  return row.id;
}

/**
 * The owner (admin) and Bia (another admin: reviews memory, reads every channel but no one else's DM) and Caio
 * (a member). One memory saved from #general and edited twice; one saved from the owner's DM with the agent.
 */
async function setup() {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId, channelId } = await seedOrg(owner);
  const bia = await joinByInvitation(t, owner, orgId, "bia@example.com", { role: "admin" });
  const caio = await joinByInvitation(t, owner, orgId, "caio@example.com");
  const ownerId = await userId("owner@example.com");
  const api = (b: typeof owner) => (path: string, init?: Parameters<typeof owner>[1]) =>
    b(`/api/app/organizations/${orgId}${path}`, init);

  const said = await insertMessage(t.db, {
    orgId,
    channelId,
    author: { type: "person", userId: ownerId },
    body: "Orion ships on Fridays.",
  });
  const first = await insertContextItem(t.db, {
    orgId,
    agentId,
    kind: "fact",
    scopeType: "agent",
    scopeId: agentId,
    content: "Orion ships on Fridays.",
    channelIds: [channelId],
    sourceIds: [said.id],
    createdByKind: "agent",
    createdById: agentId,
  });
  await t.db
    .update(schema.contextItems)
    .set({
      validFrom: new Date("2026-01-01T00:00:00Z"),
      validTo: new Date("2027-01-01T00:00:00Z"),
      sourceRevision: "rev-1",
    })
    .where(eq(schema.contextItems.id, first.id));
  const second = (await (
    await api(owner)(`/memories/${first.id}`, {
      method: "PATCH",
      json: { text: "Orion ships on Thursdays." },
    })
  ).json()) as View;
  const current = (await (
    await api(owner)(`/memories/${second.id}`, {
      method: "PATCH",
      json: { text: "Orion ships on Wednesdays.", expectedVersion: second.version },
    })
  ).json()) as View;

  const dm = await openDm(t.db, ownerId, orgId, { agentId });
  const whispered = await insertMessage(t.db, {
    orgId,
    channelId: dm.id,
    author: { type: "person", userId: ownerId },
    body: "Private launch sentinel 4417.",
  });
  const secret = await insertContextItem(t.db, {
    orgId,
    agentId,
    kind: "fact",
    scopeType: "agent",
    scopeId: agentId,
    content: "Private launch sentinel 4417.",
    channelIds: [dm.id],
    sourceIds: [whispered.id],
    createdByKind: "agent",
    createdById: agentId,
  });
  const publicRun = await run(orgId, agentId, channelId, current.id);
  const dmRun = await run(orgId, agentId, dm.id, current.id);
  return {
    orgId,
    agentId,
    channelId,
    dm,
    said,
    first,
    second,
    current,
    secret,
    publicRun,
    dmRun,
    owner: api(owner),
    bia: api(bia),
    caio: api(caio),
  };
}

test("a memory shows its scope, trust, status, validity and the source message its viewer reads", async () => {
  const s = await setup();
  const list = (await (await s.owner(`/agents/${s.agentId}/memories`)).json()) as { memories: View[] };
  const current = list.memories.find((m) => m.id === s.current.id);
  expect(current).toMatchObject({
    scope: { type: "agent", id: s.agentId },
    trust: "high",
    status: "active",
    sourceMessage: { messageId: s.said.id, channelId: s.channelId },
  });
  // A person's edit keeps the source message; the first version's validity window is not carried over.
  expect(current?.validFrom).toBeNull();
  const secret = list.memories.find((m) => m.id === s.secret.id);
  expect(secret?.sourceMessage?.channelId).toBe(s.dm.id);

  await t.db
    .update(schema.contextItems)
    .set({ validFrom: new Date("2026-03-01T00:00:00Z"), sourceRevision: "rev-3" })
    .where(eq(schema.contextItems.id, s.current.id));
  const again = (await (await s.owner(`/agents/${s.agentId}/memories`)).json()) as { memories: View[] };
  expect(again.memories.find((m) => m.id === s.current.id)).toMatchObject({
    validFrom: "2026-03-01T00:00:00.000Z",
    validTo: null,
    sourceRevision: "rev-3",
  });

  // Bia reads #general, not the owner's DM: the DM memory and its message never reach her.
  const hers = await (await s.bia(`/agents/${s.agentId}/memories`)).text();
  expect(hers).not.toContain("Private launch sentinel 4417.");
  expect(hers).not.toContain(s.dm.id);
  const view = (JSON.parse(hers) as { memories: View[] }).memories.find((m) => m.id === s.current.id);
  expect(view?.sourceMessage?.messageId).toBe(s.said.id);
});

test("history lists the version chain and the runs that used it, as far as the viewer reads", async () => {
  const s = await setup();
  const res = await s.owner(`/memories/${s.second.id}/history`);
  expect(res.status).toBe(200);
  const history = (await res.json()) as History;
  expect(history.versions.map((v) => v.id)).toEqual([s.first.id, s.second.id, s.current.id]);
  expect(history.versions.map((v) => v.current)).toEqual([false, true, false]);
  expect(history.versions[0]?.text).toBe("Orion ships on Fridays.");
  expect(history.versions[0]?.supersededAt).not.toBeNull();
  // The runs belong to the version they used.
  expect(history.runs).toEqual([]);

  const owned = (await (await s.owner(`/memories/${s.current.id}/history`)).json()) as History;
  expect(owned.runs.map((r) => r.runId).sort()).toEqual([s.publicRun, s.dmRun].sort());
  expect(owned.runs.find((r) => r.runId === s.publicRun)).toMatchObject({
    agentId: s.agentId,
    agentName: "Dev",
    channelId: s.channelId,
    channelName: "general",
  });

  // Bia may change it, but the run in the owner's DM stays out.
  const biaRes = await s.bia(`/memories/${s.current.id}/history`);
  expect(biaRes.status).toBe(200);
  const body = await biaRes.text();
  expect(body).not.toContain(s.dmRun);
  expect(body).not.toContain(s.dm.id);
  expect((JSON.parse(body) as History).runs.map((r) => r.runId)).toEqual([s.publicRun]);
});

test("history is for who may change the memory, and a memory the viewer can't read is not found", async () => {
  const s = await setup();
  expect((await s.caio(`/memories/${s.current.id}/history`)).status).toBe(403);
  const hidden = await s.bia(`/memories/${s.secret.id}/history`);
  expect(hidden.status).toBe(404);
  expect(await hidden.text()).not.toContain("Private launch sentinel 4417.");
  expect((await s.owner(`/memories/${s.secret.id}/history`)).status).toBe(200);
  expect((await s.owner(`/memories/${crypto.randomUUID()}/history`)).status).toBe(404);
});
