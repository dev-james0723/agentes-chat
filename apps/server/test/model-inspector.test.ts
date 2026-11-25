import { afterEach, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import { createApp } from "../src/app";
import { browser, createTestServer, signUp, type TestServer } from "./harness";

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

async function fixture() {
  const server = await createTestServer({ env: { ALLOW_SIGNUP: "true" } });
  t = server;
  const enabled = new Set<string>();
  const reads: string[] = [];
  server.app = createApp({
    edition: "selfhost",
    version: "test",
    modules: [],
    pingDatabase: async () => {},
    services: {
      db: server.db,
      auth: server.auth,
      config: server.config,
      adapters: server.adapters,
      extras: {
        modelInspector: {
          enabled: (orgId) => enabled.has(orgId),
          report: async (orgId) => {
            reads.push(orgId);
            return null;
          },
        },
      },
    },
  });
  const owner = browser(server);
  await signUp(owner, "inspector-owner@example.com");
  const created = await owner("/api/app/organizations", { json: { name: "Model Inspection" } });
  const { organization } = (await created.json()) as { organization: { id: string } };
  enabled.add(organization.id);
  const path = `/api/app/organizations/${organization.id}/model-inspector`;
  return { ...server, owner, orgId: organization.id, path, enabled, reads };
}

test("status requires a session and membership; an absent report remains explicit", async () => {
  const f = await fixture();
  expect((await browser(f)(f.path)).status).toBe(401);
  const stranger = browser(f);
  await signUp(stranger, "inspector-stranger@example.com");
  expect((await stranger(f.path)).status).toBe(403);
  expect(f.reads).toEqual([]);
  const response = await f.owner(f.path);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    enabled: true,
    report: null,
    credits: { enabled: false, state: "disabled" },
  });
  expect(f.reads).toEqual([f.orgId]);
});

test("disabled status is explicit and reading it does not refresh usage or ask the inspector", async () => {
  const f = await fixture();
  f.enabled.clear();
  expect(await (await f.owner(f.path)).json()).toMatchObject({
    enabled: false,
    report: null,
    credits: { enabled: false, state: "disabled" },
  });
  expect(f.reads).toEqual([]);
});

test("workspace roles need both agent management and usage access, checked on every read", async () => {
  const f = await fixture();
  const member = browser(f);
  const signedUp = await signUp(member, "inspector-member@example.com");
  const { user } = (await signedUp.json()) as { user: { id: string } };
  await f.db.insert(schema.organizationMembers).values({ orgId: f.orgId, userId: user.id, role: "member" });
  const setPermissions = (permissions: string[]) =>
    f.db
      .update(schema.orgRoles)
      .set({ permissions })
      .where(and(eq(schema.orgRoles.orgId, f.orgId), eq(schema.orgRoles.kind, "everyone")));
  await setPermissions(["view_usage"]);
  expect((await member(f.path)).status).toBe(403);
  await setPermissions(["manage_agents"]);
  expect((await member(f.path)).status).toBe(403);
  expect(f.reads).toEqual([]);
  await setPermissions(["manage_agents", "view_usage"]);
  expect((await member(f.path)).status).toBe(200);
  await setPermissions(["manage_agents"]);
  expect((await member(f.path)).status).toBe(403);
  expect(f.reads).toEqual([f.orgId]);
});
