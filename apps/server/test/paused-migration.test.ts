import { afterEach, beforeEach, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer();
});
afterEach(() => t.close());
test("routine can be created atomically paused without a next run", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId, agentId } = await seedOrg(owner);
  const created = await owner(`/api/app/organizations/${orgId}/routines`, {
    json: {
      agentId,
      prompt: "Test",
      target: { type: "channel", channelId },
      trigger: { type: "schedule", phrase: "dias úteis às 9h" },
      paused: true,
    },
  });
  expect(created.status).toBe(201);
  const body = (await created.json()) as { id: string; active: boolean; nextRunAt: string | null };
  expect(body).toMatchObject({ active: false, nextRunAt: null });
  const stored = (await t.db.select().from(schema.routines)).find((r) => r.id === body.id);
  expect(stored).toMatchObject({ active: false, nextRunAt: null });
  await t.drain();
  expect((await t.db.select().from(schema.routineRuns)).filter((r) => r.routineId === body.id)).toHaveLength(0);
});
test("webhook routine is created paused and cannot deliver or run", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId, agentId } = await seedOrg(owner);
  const created = await owner(`/api/app/organizations/${orgId}/routines`, {
    json: {
      agentId,
      prompt: "Test",
      target: { type: "channel", channelId },
      trigger: { type: "webhook" },
      paused: true,
    },
  });
  expect(created.status).toBe(201);
  const routine = (await created.json()) as {
    id: string;
    active: boolean;
    nextRunAt: string | null;
    trigger: { type: string; url: string };
  };
  expect(routine).toMatchObject({ active: false, nextRunAt: null, trigger: { type: "webhook" } });
  const stored = (await t.db.select().from(schema.routines)).find((r) => r.id === routine.id);
  expect(stored).toMatchObject({ active: false, nextRunAt: null });
  expect((await t.db.select().from(schema.routineHooks)).filter((r) => r.routineId === routine.id)).toHaveLength(1);
  const internal = await owner(`/api/app/organizations/${orgId}/routines/${routine.id}/hook/test`, { json: {} });
  expect(internal.status).toBe(409);
  const publicCall = await t.app.request(new URL(routine.trigger.url).pathname, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  expect(publicCall.status).toBe(404);
  await t.drain();
  expect((await t.db.select().from(schema.routineRuns)).filter((r) => r.routineId === routine.id)).toHaveLength(0);
  expect((await t.db.select().from(schema.routineHookCalls)).filter((r) => r.routineId === routine.id)).toHaveLength(0);
});
test("other event types still cannot be created paused", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId, agentId } = await seedOrg(owner);
  const created = await owner(`/api/app/organizations/${orgId}/routines`, {
    json: {
      agentId,
      prompt: "Test",
      target: { type: "channel", channelId },
      trigger: { type: "email", accountId: crypto.randomUUID() },
      paused: true,
    },
  });
  expect(created.status).toBe(400);
  expect(await t.db.select().from(schema.routines)).toHaveLength(0);
  expect(await t.db.select().from(schema.routineHooks)).toHaveLength(0);
});
