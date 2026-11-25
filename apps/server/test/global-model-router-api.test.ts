import { afterEach, expect, test } from "bun:test";
import { createCredential, reserveGlobalRouterAttempt, settleGlobalRouterAttempt } from "@agenteschat/engine";
import { browser, createTestServer, joinByInvitation, signUp, type TestServer } from "./harness";

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const synthKey = (parts: string[]) => parts.join("-");

async function createRouterFixture(serverEnabled = true) {
  const mockHttp = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("openrouter.ai/api/v1/models")) {
      return Response.json({
        data: [
          {
            id: "nvidia/nemotron-3.5-super-vl:free",
            name: "Nemotron Free",
            context_length: 131072,
            pricing: { prompt: "0", completion: "0", request: "0" },
            supported_parameters: ["tools", "structured_outputs"],
          },
          {
            id: "deepseek/deepseek-v4.1-flash-1017",
            name: "DeepSeek V4.1 Flash",
            context_length: 163840,
            pricing: { prompt: "0.00000003", completion: "0.0000002", request: "0" },
            supported_parameters: ["tools", "structured_outputs"],
          },
        ],
      });
    }
    if (url.includes("opencode.ai")) {
      return Response.json({ data: [] });
    }
    return Response.json({ data: { is_management_key: false } });
  }) as unknown as typeof fetch;

  const server = await createTestServer({
    env: {
      ALLOW_SIGNUP: "true",
      GLOBAL_MODEL_ROUTER_ENABLED: String(serverEnabled),
      OPENROUTER_FALLBACK_ENABLED: "true",
    },
    http: mockHttp,
  });
  t = server;
  const owner = browser(server);
  const { user } = (await (await signUp(owner, "gmr-owner@example.com")).json()) as { user: { id: string } };
  const { organization } = (await (
    await owner("/api/app/organizations", { json: { name: "Global Router Workspace" } })
  ).json()) as { organization: { id: string } };

  const orSecret = synthKey(["sk", "or", "v1", "e".repeat(64)]);
  const orKey = await createCredential(
    server.db,
    server.adapters.keyWrapper,
    user.id,
    organization.id,
    { provider: "openrouter", label: "Dedicated Router OR Key", apiKey: orSecret },
    { fetch: mockHttp },
  );
  const cfKey = await createCredential(
    server.db,
    server.adapters.keyWrapper,
    user.id,
    organization.id,
    {
      provider: "cloudflare",
      label: "Workers AI Key",
      apiKey: `cfut_${"c".repeat(36)}`,
      workspaceId: "0123456789abcdef0123456789abcdef",
    },
    { fetch: mockHttp },
  );

  return {
    ...server,
    owner,
    ownerId: user.id,
    orgId: organization.id,
    basePath: `/api/app/organizations/${organization.id}/global-model-router`,
    inspectorPath: `/api/app/organizations/${organization.id}/model-inspector`,
    orKeyId: orKey.id,
    orSecret,
    cfKeyId: cfKey.id,
  };
}

test("owner configures policy, lanes, live catalog sync, and hold reconciliation while redacting secrets and enforcing RBAC", async () => {
  const f = await createRouterFixture(true);

  // Initial status is disabled and never exposes secrets
  const initRes = await f.owner(f.basePath);
  expect(initRes.status).toBe(200);
  expect(await initRes.json()).toMatchObject({
    serverEnabled: true,
    canManagePolicy: true,
    policy: { enabled: false },
  });

  // Enable workspace policy
  const polRes = await f.owner(`${f.basePath}/policy`, {
    method: "PATCH",
    json: { enabled: true, maxEscalations: 2, maxRetriesPerRoute: 1, optOutAgentIds: ["agent-strict"] },
  });
  expect(polRes.status).toBe(200);

  // Reject OpenRouter cap > $50
  const overCap = await f.owner(`${f.basePath}/accounts`, {
    method: "PUT",
    json: {
      provider: "openrouter",
      lane: "paid_low_cost",
      entitlement: "paid_capped",
      credentialId: f.orKeyId,
      enabled: true,
      monthlyCapUsd: 51,
      allowedModels: ["deepseek/deepseek-v4.1-flash-1017"],
    },
  });
  expect(overCap.status).toBe(400);

  // Reject Qwen/Ollama model in allowedModels
  const qwenAttempt = await f.owner(`${f.basePath}/accounts`, {
    method: "PUT",
    json: {
      provider: "openrouter",
      lane: "free_api",
      entitlement: "free_only",
      credentialId: f.orKeyId,
      enabled: true,
      monthlyCapUsd: 0,
      allowedModels: ["qwen/qwen3-coder:free"],
    },
  });
  expect(qwenAttempt.status).toBe(400);

  // Configure valid OpenRouter paid_low_cost ($50 cap) and Cloudflare free_only ($0 cap + 32-hex Account ID)
  const orPut = await f.owner(`${f.basePath}/accounts`, {
    method: "PUT",
    json: {
      provider: "openrouter",
      lane: "paid_low_cost",
      entitlement: "paid_capped",
      credentialId: f.orKeyId,
      enabled: true,
      monthlyCapUsd: 50,
      allowedModels: ["deepseek/deepseek-v4.1-flash-1017"],
    },
  });
  expect(orPut.status).toBe(200);

  const cfPut = await f.owner(`${f.basePath}/accounts`, {
    method: "PUT",
    json: {
      provider: "cloudflare",
      lane: "free_api",
      entitlement: "free_only",
      credentialId: f.cfKeyId,
      workspaceAccountRef: "0123456789abcdef0123456789abcdef",
      enabled: true,
      monthlyCapUsd: 0,
      allowedModels: ["@cf/openai/gpt-oss-120b"],
    },
  });
  expect(cfPut.status).toBe(200);
  const bodyAfterAccounts = await cfPut.json();
  expect(JSON.stringify(bodyAfterAccounts)).not.toContain(f.orSecret);
  expect(JSON.stringify(bodyAfterAccounts)).not.toContain("credentialFingerprint");

  // Trigger catalog sync
  const syncRes = await f.owner(`${f.basePath}/sync-catalog`, {
    method: "POST",
    json: { sources: ["openrouter", "direct"] },
  });
  expect(syncRes.status).toBe(200);
  const syncBody = (await syncRes.json()) as { sync: { stored: number } };
  expect(syncBody.sync.stored).toBeGreaterThan(5);

  // Admin can read status & model-inspector (manage_agents + view_usage) with canManagePolicy=false, but gets 403 on mutations
  const admin = await joinByInvitation(f, f.owner, f.orgId, "gmr-admin@example.com", { role: "admin" });
  const adminRead = await admin(f.basePath);
  expect(adminRead.status).toBe(200);
  expect(await adminRead.json()).toMatchObject({ canManagePolicy: false });
  expect((await admin(`${f.basePath}/policy`, { method: "PATCH", json: { enabled: false } })).status).toBe(403);
  expect((await admin(`${f.basePath}/sync-catalog`, { method: "POST", json: {} })).status).toBe(403);

  const inspRes = await admin(f.inspectorPath);
  expect(inspRes.status).toBe(200);
  expect(await inspRes.json()).toMatchObject({
    globalRouter: { policy: { enabled: true } },
  });

  // Create an ambiguous hold and reconcile via POST /reconcile
  const statusData = (await (await f.owner(f.basePath)).json()) as { accounts: { id: string; provider: string }[] };
  const orAcctId = statusData.accounts.find((a) => a.provider === "openrouter")!.id;
  const held = await reserveGlobalRouterAttempt(f.db, {
    orgId: f.orgId,
    accountId: orAcctId,
    runId: crypto.randomUUID(),
    agentId: crypto.randomUUID(),
    turn: 1,
    idempotencyKey: "api-hold-1",
    requestedModel: "deepseek/deepseek-v4.1-flash-1017",
    boundNanoUsd: 2_000_000,
    estimatedPromptTokens: 500,
    maxOutputTokens: 256,
  });
  await expect(
    settleGlobalRouterAttempt(f.db, f.orgId, held.attemptId, {
      kind: "unknown",
      reason: "simulated_network_cut",
    }),
  ).rejects.toMatchObject({ reason: "reconciliation_required" });

  expect(
    (
      await admin(`${f.basePath}/reconcile`, {
        method: "POST",
        json: { attemptId: held.attemptId, kind: "proven_no_send", note: "admin cannot reconcile" },
      })
    ).status,
  ).toBe(403);

  const recRes = await f.owner(`${f.basePath}/reconcile`, {
    method: "POST",
    json: { attemptId: held.attemptId, kind: "proven_no_send", note: "Owner verified zero upstream tokens" },
  });
  expect(recRes.status).toBe(200);
}, 60_000);

test("server-level GLOBAL_MODEL_ROUTER_ENABLED=false blocks enabling workspace policy with 409", async () => {
  const f = await createRouterFixture(false);
  const res = await f.owner(`${f.basePath}/policy`, {
    method: "PATCH",
    json: { enabled: true },
  });
  expect(res.status).toBe(409);
}, 60_000);
