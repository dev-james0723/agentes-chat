import { afterEach, expect, test } from "bun:test";
import { HOST_MCP_PROTOCOL } from "@agenteschat/adapters";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(async () => await t?.close());
test("host MCP HTTP routes require session, admin permission, exact identity and ordinary custom guard", async () => {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" } });
  const owner = browser(t);
  await signUp(owner, "host-owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const machineId = crypto.randomUUID(),
    revision = "1".repeat(64);
  let calls = 0;
  let protocol = HOST_MCP_PROTOCOL;
  t.engine.machineHub.status = async (id) => ({
    id,
    orgId,
    name: "fixture",
    online: true,
    execAllowed: false,
    os: "macos",
    protocol,
    executors: {},
  });
  t.engine.machineHub.call = async (_id, req) => {
    calls++;
    if (req.op !== "host_mcp") throw new Error("wrong transport");
    return (
      "request" in req && req.request.action === "profiles"
        ? { profiles: [{ id: "fixture", label: "Fixture", revision, enabled: false, kind: "general" }] }
        : { tools: [] }
    ) as never;
  };
  const profiles = `/api/app/organizations/${orgId}/connectors/host-mcp/${machineId}/profiles`;
  expect((await t.app.request(profiles)).status).toBe(401);
  expect(calls).toBe(0);
  const outsider = browser(t);
  await signUp(outsider, "host-outsider@example.com");
  expect((await outsider(profiles)).status).toBe(403);
  expect(calls).toBe(0);
  for (protocol of [57, 63, 65, 66]) {
    expect((await owner(profiles)).status).toBe(400);
    expect(calls).toBe(0);
  }
  protocol = HOST_MCP_PROTOCOL;
  const got = await owner(profiles);
  expect(got.status).toBe(200);
  expect(((await got.json()) as { profiles: { enabled: boolean }[] }).profiles[0]?.enabled).toBe(false);
  const path = `/api/app/organizations/${orgId}/connectors/host-mcp`;
  const bind = { machineId, profileId: "fixture", revision, agentId };
  expect((await owner(path, { json: bind })).status).toBe(400);
  const deniedOrigin = await owner(path, { json: bind, origin: "https://untrusted.invalid" });
  expect(deniedOrigin.status).toBe(403);
  const before = calls;
  expect((await owner(path, { json: { ...bind, command: "/bin/sh" } })).status).toBe(400);
  expect(calls).toBe(before);
  expect(
    (
      await owner(`/api/app/organizations/${orgId}/connectors/custom`, {
        json: { serverUrl: `machine-mcp://${machineId}/fixture/${revision}` },
      })
    ).status,
  ).toBe(400);
});
