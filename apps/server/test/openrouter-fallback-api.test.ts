import { afterEach, expect, test } from "bun:test";
import { createCredential } from "@agenteschat/engine";
import { browser, createTestServer, joinByInvitation, signUp, type TestServer } from "./harness";

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});
async function fixture(enabled: boolean) {
  const server = await createTestServer({
    env: { ALLOW_SIGNUP: "true", OPENROUTER_FALLBACK_ENABLED: String(enabled) },
  });
  t = server;
  const owner = browser(server);
  const { user } = (await (await signUp(owner, "or-owner@example.com")).json()) as { user: { id: string } };
  const { organization } = (await (
    await owner("/api/app/organizations", { json: { name: "Router fixture" } })
  ).json()) as { organization: { id: string } };
  const key = await createCredential(
    server.db,
    server.adapters.keyWrapper,
    user.id,
    organization.id,
    { provider: "openrouter", label: "Synthetic dedicated key", apiKey: `sk-or-v1-${"c".repeat(64)}` },
    { fetch: (async () => Response.json({ data: { is_management_key: false } })) as unknown as typeof fetch },
  );
  const policy = {
    allowedModels: ["openai/gpt-6-luna"],
    monthlyCapUsd: 50,
    costTier: "medium",
    maxPromptUsdPerMillion: 4,
    maxCompletionUsdPerMillion: 20,
  };
  return {
    ...server,
    owner,
    orgId: organization.id,
    path: `/api/app/organizations/${organization.id}/openrouter-fallback`,
    change: { enabled: true, credentialId: key.id, policy },
  };
}
test("owner can configure only the approved limit, and disable without losing accounting", async () => {
  const f = await fixture(true);
  const initial = await f.owner(f.path);
  expect(initial.status).toBe(200);
  expect(await initial.json()).toMatchObject({ enabled: false, monthlyCapNanoUsd: 50e9, spentNanoUsd: 0 });
  const enabled = await f.owner(f.path, { method: "PATCH", json: f.change });
  expect(enabled.status).toBe(200);
  const value = await enabled.json();
  expect(value).toMatchObject({ enabled: true, monthlyCapNanoUsd: 50e9 });
  expect(JSON.stringify(value)).not.toContain("sk-or-v1");
  expect(
    (
      await f.owner(f.path, {
        method: "PATCH",
        json: { ...f.change, policy: { ...f.change.policy, monthlyCapUsd: 51 } },
      })
    ).status,
  ).toBe(400);
  const admin = await joinByInvitation(f, f.owner, f.orgId, "or-admin@example.com", { role: "admin" });
  expect((await admin(f.path)).status).toBe(403);
  expect((await admin(f.path, { method: "PATCH", json: { enabled: false } })).status).toBe(403);
  const off = await f.owner(f.path, { method: "PATCH", json: { enabled: false } });
  expect(off.status).toBe(200);
  expect(await off.json()).toMatchObject({ enabled: false, monthlyCapNanoUsd: 50e9 });
}, 60_000);
test("server kill switch rejects enable", async () => {
  const f = await fixture(false);
  const res = await f.owner(f.path, { method: "PATCH", json: f.change });
  expect(res.status).toBe(409);
}, 60_000);
