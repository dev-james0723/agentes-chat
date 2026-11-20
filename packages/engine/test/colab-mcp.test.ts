import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq, schema } from "@agenteschat/db";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  type ConnectorDeps,
  completeOAuth,
  connectCustomServer,
  connectionHeaders,
  connectorGrantValidator,
  connectorListing,
  createApiKeyConnection,
  createConnectorToolSource,
  createToolGateway,
  mcpSessionOver,
  setAgentScopes,
  startOAuth,
} from "../src";
import { COLAB_MCP_URL, COLAB_SCOPE } from "../src/connectors/colab";
import { type Fixture, setup } from "./fixtures";

let fixture: Fixture | undefined;
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

const app = { clientId: "colab-test-client", clientSecret: "colab-test-secret" };
const depsOf = (f: Fixture, extra: Partial<ConnectorDeps> = {}): ConnectorDeps => ({
  db: f.db,
  keyWrappers: [f.keyWrapper],
  publicUrl: "https://chat.example.com",
  oauthApps: { colab: app },
  ...extra,
});

async function fresh() {
  fixture = await setup();
  return fixture;
}

function googleTokens() {
  const seen: URLSearchParams[] = [];
  let challenge = "";
  const http = (async (url: string, init?: RequestInit) => {
    expect(String(url)).toBe("https://oauth2.googleapis.com/token");
    const form = new URLSearchParams(String(init?.body));
    seen.push(form);
    expect(form.get("client_id")).toBe(app.clientId);
    expect(form.get("client_secret")).toBe(app.clientSecret);
    if (form.get("grant_type") === "authorization_code") {
      expect(
        createHash("sha256")
          .update(form.get("code_verifier") ?? "")
          .digest("base64url"),
      ).toBe(challenge);
    }
    return Response.json({
      access_token: `colab-access-${seen.length}`,
      ...(seen.length === 1 ? { refresh_token: "colab-refresh" } : {}),
      scope: COLAB_SCOPE,
      expires_in: 3600,
    });
  }) as unknown as typeof fetch;
  return {
    http,
    seen,
    challenge: (value: string) => {
      challenge = value;
    },
  };
}

async function signIn(f: Fixture) {
  const provider = googleTokens();
  const deps = depsOf(f, { http: provider.http });
  const started = await startOAuth(deps, f.owner.id, f.org.id, "colab");
  provider.challenge(new URL(started.authorizeUrl).searchParams.get("code_challenge") ?? "");
  const { connection } = await completeOAuth(deps, { id: f.owner.id }, { state: started.state, code: "test-code" });
  return { provider, deps, connection };
}

describe("Google Colab OAuth", () => {
  test("the catalog is available only with this deployment's OAuth application", () => {
    const entry = (oauthApps: ConnectorDeps["oauthApps"]) =>
      connectorListing({ oauthApps: oauthApps ?? {} }).find((c) => c.id === "colab");
    expect(entry({})).toMatchObject({ available: false, oauthConfigured: false, auth: ["oauth"] });
    expect(entry({ colab: app })).toMatchObject({
      available: true,
      oauthConfigured: true,
      serverUrl: COLAB_MCP_URL,
    });
  });

  test("Google consent uses offline access, state and PKCE; sealed tokens refresh without losing the refresh token", async () => {
    const f = await fresh();
    const provider = googleTokens();
    const deps = depsOf(f, { http: provider.http });
    const { authorizeUrl, state } = await startOAuth(deps, f.owner.id, f.org.id, "colab", {
      returnTo: "/settings/connectors",
    });
    const url = new URL(authorizeUrl);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: app.clientId,
      redirect_uri: "https://chat.example.com/api/app/connectors/oauth/callback",
      response_type: "code",
      access_type: "offline",
      prompt: "consent",
      scope: COLAB_SCOPE,
      code_challenge_method: "S256",
      state,
    });
    expect(authorizeUrl).not.toContain(app.clientSecret);
    provider.challenge(url.searchParams.get("code_challenge") ?? "");
    const { connection, returnTo } = await completeOAuth(deps, { id: f.owner.id }, { state, code: "test-code" });
    expect(returnTo).toBe("/settings/connectors");
    expect(connection).toMatchObject({ connector: "colab", authType: "oauth", oauthScopes: COLAB_SCOPE });
    expect(await connectionHeaders(deps, connection)).toEqual({ authorization: "Bearer colab-access-1" });
    expect(
      await f.db.select().from(schema.agentScopes).where(eq(schema.agentScopes.connectionId, connection.id)),
    ).toHaveLength(0);
    expect(JSON.stringify(await f.db.select().from(schema.connectorConnections))).not.toContain("colab-access-1");

    const later = new Date((connection.tokenExpiresAt?.getTime() ?? 0) - 30_000);
    expect(await connectionHeaders({ ...deps, now: () => later }, connection)).toEqual({
      authorization: "Bearer colab-access-2",
    });
    expect(provider.seen[1]?.get("grant_type")).toBe("refresh_token");
    expect(provider.seen[1]?.get("refresh_token")).toBe("colab-refresh");
    const [updated] = await f.db
      .select()
      .from(schema.connectorConnections)
      .where(eq(schema.connectorConnections.id, connection.id));
    if (!updated?.tokenExpiresAt) throw new Error("missing refreshed connection");
    const nextRefreshAt = new Date(updated.tokenExpiresAt.getTime() - 30_000);
    await connectionHeaders({ ...deps, now: () => nextRefreshAt }, updated);
    expect(provider.seen[2]?.get("refresh_token")).toBe("colab-refresh");
  }, 15_000);

  test("missing offline access or denied Colab scope stores no connection", async () => {
    const f = await fresh();
    for (const [response, code] of [
      [{ access_token: "short-lived", scope: COLAB_SCOPE }, "connector.colab_refresh_required"],
      [{ access_token: "wrong-scope", refresh_token: "refresh", scope: "openid" }, "connector.colab_scope_required"],
    ] as const) {
      const http = (async () => Response.json({ ...response, expires_in: 3600 })) as unknown as typeof fetch;
      const deps = depsOf(f, { http });
      const { state } = await startOAuth(deps, f.owner.id, f.org.id, "colab");
      await expect(completeOAuth(deps, { id: f.owner.id }, { state, code: "test-code" })).rejects.toMatchObject({
        code,
      });
    }
    expect(await f.db.select().from(schema.connectorConnections)).toHaveLength(0);
  });

  test("pasting the public MCP URL starts real Google OAuth instead of storing an unauthenticated connection", async () => {
    const f = await fresh();
    const deps = {
      ...depsOf(f),
      resolveHost: async () => ["93.184.216.34"],
      http: (async () => {
        throw new Error("public MCP discovery must not authenticate Colab");
      }) as unknown as typeof fetch,
      connect: async () => {
        throw new Error("must not list tools before Google sign-in");
      },
    };
    const started = await connectCustomServer(deps, f.owner.id, f.org.id, { serverUrl: COLAB_MCP_URL });
    expect(started.status).toBe("oauth");
    if (started.status !== "oauth") throw new Error("missing OAuth");
    expect(new URL(started.authorizeUrl).searchParams.get("client_id")).toBe(app.clientId);
    expect(await f.db.select().from(schema.connectorConnections)).toHaveLength(0);
    await expect(
      connectCustomServer({ ...deps, oauthApps: {} }, f.owner.id, f.org.id, {
        serverUrl: COLAB_MCP_URL,
      }),
    ).rejects.toThrow("not configured");
  });

  test("static tokens and unauthenticated catalog connects cannot masquerade as a lasting Colab connection", async () => {
    const f = await fresh();
    const deps = depsOf(f);
    for (const apiKey of [undefined, "short-lived-access-token"]) {
      await expect(
        createApiKeyConnection(deps, f.owner.id, f.org.id, { connector: "colab", apiKey }),
      ).rejects.toMatchObject({ code: "connector.oauth_only" });
    }
    const custom = {
      ...deps,
      resolveHost: async () => ["93.184.216.34"],
      connect: async () => {
        throw new Error("unexpected");
      },
    };
    for (const input of [
      { serverUrl: COLAB_MCP_URL, apiKey: "short-lived-access-token" },
      { serverUrl: `${COLAB_MCP_URL}?key=not-a-login` },
      { serverUrl: COLAB_MCP_URL, connectionId: crypto.randomUUID() },
    ]) {
      await expect(connectCustomServer(custom, f.owner.id, f.org.id, input)).rejects.toMatchObject({
        code: "connector.colab_oauth_required",
      });
    }
    expect(await f.db.select().from(schema.connectorConnections)).toHaveLength(0);
  });

  test("read grants expose only reads; runtime deletion is separate; long-job guidance reaches the agent", async () => {
    const f = await fresh();
    const { deps, connection } = await signIn(f);
    const source = createConnectorToolSource({
      ...deps,
      connect: async () => ({
        listTools: async () =>
          [
            "get_subscription",
            "list_runtime_specs",
            "get_runtime",
            "list_runtimes",
            "execute_code",
            "create_runtime",
            "delete_runtime",
          ].map((name) => ({
            name,
            inputSchema: { type: "object" },
            description: "Vendor description. ".repeat(100),
          })),
        callTool: async () => ({ content: "ok", isError: false }),
        close: async () => {},
      }),
    });
    const ctx = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: crypto.randomUUID(),
      channelId: f.general.id,
      threadRootId: crypto.randomUUID(),
      triggerMessageId: crypto.randomUUID(),
    };
    const tools = await source.tools(ctx);
    expect(tools.find((t) => t.name === "colab_delete_runtime")).toMatchObject({
      scope: "colab:delete",
      sensitive: true,
    });
    const execution = tools.find((t) => t.name === "colab_execute_code");
    expect(execution?.scope).toBe("colab:run");
    for (const name of ["colab_get_runtime", "colab_list_runtimes"]) {
      expect(tools.find((t) => t.name === name)?.scope).toBe("colab:run");
    }
    expect(execution?.description).toContain("identical request to reattach");
    expect(execution?.description).toContain("executionId");
    expect(execution?.description).toContain("Once a result returned");
    expect(execution?.description.length).toBeLessThanOrEqual(1024);
    expect(tools.find((t) => t.name === "colab_get_subscription")?.description).toContain(
      "not remaining compute units",
    );

    const gateway = createToolGateway({ sources: [source] });
    expect(await gateway.list(ctx)).toHaveLength(0);
    await setAgentScopes(
      f.db,
      f.owner.id,
      f.org.id,
      f.agent.id,
      [{ connectionId: connection.id, scope: "colab:read" }],
      connectorGrantValidator,
    );
    expect((await gateway.list(ctx)).map((t) => t.name).sort()).toEqual([
      "colab_get_subscription",
      "colab_list_runtime_specs",
    ]);
  });
});

test("only Colab's long operations get the longer SDK timeout; an uncertain execution is dispatched once", async () => {
  const call = spyOn(Client.prototype, "callTool");
  try {
    for (const endpoint of [
      COLAB_MCP_URL,
      `${COLAB_MCP_URL}/`,
      "https://example.com/mcp",
      `${COLAB_MCP_URL}?key=other`,
    ]) {
      const server = new McpServer({ name: "colab-test", version: "1" });
      let executions = 0;
      server.registerTool(
        "execute_code",
        {
          inputSchema: { session: z.string(), executionId: z.string(), code: z.string() },
        },
        async () => {
          executions++;
          return { content: [{ type: "text", text: "DEADLINE_EXCEEDED" }], isError: true };
        },
      );
      for (const name of ["create_runtime", "get_subscription"]) {
        server.registerTool(name, {}, async () => ({ content: [{ type: "text", text: "ok" }] }));
      }
      const [client, transport] = InMemoryTransport.createLinkedPair();
      await server.connect(transport);
      const session = await mcpSessionOver(client, endpoint);
      try {
        const args = { session: "runtimes/test/sessions/task", executionId: crypto.randomUUID(), code: "print(1 + 1)" };
        expect((await session.callTool("execute_code", args)).isError).toBe(true);
        expect(executions).toBe(1);
        const expected =
          endpoint === COLAB_MCP_URL || endpoint === `${COLAB_MCP_URL}/` ? { timeout: 660_000 } : undefined;
        expect(call.mock.calls.at(-1)?.[2]).toEqual(expected);
        expect(call.mock.calls.at(-1)?.[0]).toEqual({ name: "execute_code", arguments: args });
        await session.callTool("create_runtime", {});
        expect(call.mock.calls.at(-1)?.[2]).toEqual(expected);
        await session.callTool("get_subscription", {});
        expect(call.mock.calls.at(-1)?.[2]).toBeUndefined();
      } finally {
        await session.close();
        await server.close();
      }
    }
  } finally {
    call.mockRestore();
  }
});
