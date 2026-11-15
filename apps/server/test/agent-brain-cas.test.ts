import { afterEach, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION } from "@agenteschat/adapters";
import { browser, createTestServer, pairComputer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(async () => {
  await t?.close();
});
async function world() {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" }, reply: () => ({ chunks: ["ok"] }) });
  const owner = browser(t);
  await signUp(owner, "owner-cas@example.com");
  const seeded = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${seeded.orgId}${path}`, init);
  const computer = await pairComputer(
    t,
    api,
    {
      hostname: "cas-mac",
      os: "darwin",
      arch: "arm64",
      version: "0.5.0",
      protocol: MACHINE_PROTOCOL_VERSION,
      workspace: "/tmp/synthetic-cas",
      exec: true,
    },
    { name: "cas-mac" },
  );
  expect(
    (await api(`/agents/${seeded.agentId}/computer/target`, { method: "PUT", json: { machineId: computer.machineId } }))
      .status,
  ).toBe(200);
  const path = `/agents/${seeded.agentId}/brain`;
  return { api, path };
}

test("served GET token drives PUT CAS; rememberSetup false preserves a non-null original default", async () => {
  const { api, path } = await world();
  const defaults = await (await api("/agent-setup")).json();
  const before = (await (await api(path)).json()) as { configHash: string };
  expect(before.configHash).toMatch(/^[a-f0-9]{64}$/);
  const response = await api(path, {
    method: "PUT",
    json: { expectedConfigHash: before.configHash, fallback: false, rememberSetup: false },
  });
  expect(response.status).toBe(200);
  const after = (await response.json()) as { configHash: string; fallback: boolean };
  expect(after.fallback).toBe(false);
  expect(after.configHash).not.toBe(before.configHash);
  expect(await (await api("/agent-setup")).json()).toEqual(defaults);
  const stale = await api(path, {
    method: "PUT",
    json: { expectedConfigHash: before.configHash, fallback: false, rememberSetup: false },
  });
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ error: { code: "brain.config_changed" } });
});

test("OpenAPI advertises optional guarded fields; malformed token fails and omitted path remains legacy", async () => {
  const { api, path } = await world();
  const doc = (await (await t.app.request("http://localhost/api/openapi.json")).json()) as {
    paths: Record<
      string,
      {
        put?: {
          requestBody?: { content: Record<string, { schema: { properties: Record<string, { type?: string }> } }> };
        };
      }
    >;
  };
  const route = Object.entries(doc.paths).find(([p]) => p.endsWith("/agents/{agentId}/brain"));
  expect(route?.[1].put?.requestBody?.content["application/json"]?.schema.properties.expectedConfigHash?.type).toBe(
    "string",
  );
  expect(route?.[1].put?.requestBody?.content["application/json"]?.schema.properties.rememberSetup?.type).toBe(
    "boolean",
  );
  expect((await api(path, { method: "PUT", json: { expectedConfigHash: "not-a-hash", fallback: false } })).status).toBe(
    400,
  );
  expect((await api(path, { method: "PUT", json: { fallback: false, rememberSetup: false } })).status).toBe(200);
});
