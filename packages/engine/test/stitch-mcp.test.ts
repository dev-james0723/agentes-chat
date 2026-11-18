import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  type CustomDeps,
  connectCustomServer,
  connectionHeaders,
  connectorListing,
  mcpPreset,
  storeCustomConnection,
} from "../src";
import { allowPrivateOutbound } from "../src/net-guard";
import { type Fixture, setup } from "./fixtures";

const STITCH = "https://stitch.googleapis.com/mcp";
const KEY = "synthetic-stitch-key-not-a-real-secret";
let f: Fixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});
const currentFixture = () => {
  if (!f) throw new Error("Fixture not initialized");
  return f;
};
const deps = (): CustomDeps => ({
  db: currentFixture().db,
  keyWrappers: [currentFixture().keyWrapper],
  publicUrl: "https://chat.example.com",
  resolveHost: async () => ["93.184.216.34"],
});
const keyConnection = async (serverUrl: string) =>
  (
    await storeCustomConnection(deps(), {
      orgId: currentFixture().org.id,
      actorId: currentFixture().owner.id,
      serverUrl,
      label: "Test provider",
      authType: "api_key",
      secret: { apiKey: KEY },
    })
  ).connection;
describe("Stitch official API-key MCP", () => {
  test("catalog offers API key only, with the generic connector glyph as its icon", () => {
    expect(mcpPreset("stitch")).toMatchObject({ serverUrl: STITCH });
    expect(connectorListing({ oauthApps: {} }).find((x) => x.id === "stitch")).toMatchObject({
      serverUrl: STITCH,
      kind: "remote_mcp",
      available: true,
      soon: false,
      auth: ["api_key"],
      oauthConfigured: false,
      // Every catalog entry has an icon (apps/web/public/connectors/README.md): Stitch has no mark of its own here.
      iconUrl: "/connectors/plug.svg",
    });
  });
  test("a first Stitch key uses its vendor header, stays sealed and grants no agent access", async () => {
    f = await setup();
    const seen: Record<string, string>[] = [];
    const d = {
      ...deps(),
      connect: async (_c: unknown, headers: Record<string, string>) => {
        seen.push(headers);
        return {
          listTools: async () => [],
          callTool: async () => ({ content: "", isError: false }),
          close: async () => {},
        };
      },
    };
    const result = await connectCustomServer(d, f.owner.id, f.org.id, { serverUrl: STITCH, apiKey: KEY });
    if (result.status !== "connected") throw new Error("Expected connected fixture");
    expect(seen).toEqual([{ "x-goog-api-key": KEY }]);
    const [row] = await f.db
      .select()
      .from(schema.connectorConnections)
      .where(eq(schema.connectorConnections.id, result.server.id));
    expect(row?.secretCiphertext).toBeTruthy();
    expect(row?.secretCiphertext).not.toContain(KEY);
    expect(
      await f.db.select().from(schema.agentScopes).where(eq(schema.agentScopes.connectionId, result.server.id)),
    ).toEqual([]);
    const audit = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.targetId, result.server.id));
    expect(JSON.stringify(audit)).not.toContain(KEY);
  });
  test("only the exact official endpoint receives the header; other Bearer and scheme behavior is preserved", async () => {
    f = await setup();
    const semrush = mcpPreset("semrush");
    if (!semrush) throw new Error("Semrush preset missing");
    const cases = [
      [STITCH, { "x-goog-api-key": KEY }],
      [STITCH + "/other", { authorization: "Bearer " + KEY }],
      [STITCH + "?other=1", { authorization: "Bearer " + KEY }],
      ["https://stitch.googleapis.com.attacker.example/mcp", { authorization: "Bearer " + KEY }],
      ["https://tickets.example.com/mcp", { authorization: "Bearer " + KEY }],
      [semrush.serverUrl, { authorization: "Apikey " + KEY }],
    ] as const;
    for (const [url, headers] of cases)
      expect(await connectionHeaders(deps(), await keyConnection(url))).toEqual(headers);
  });
  test("without a key there is no OAuth registration or stored connection", async () => {
    f = await setup();
    let requests = 0;
    const d = {
      ...deps(),
      http: (async () => {
        requests++;
        throw new Error("Unexpected network");
      }) as unknown as typeof fetch,
    };
    expect(await connectCustomServer(d, f.owner.id, f.org.id, { serverUrl: STITCH })).toEqual({ status: "needs_key" });
    expect(requests).toBe(0);
    expect(
      await f.db.select().from(schema.connectorConnections).where(eq(schema.connectorConnections.serverUrl, STITCH)),
    ).toEqual([]);
  });
  test("malformed fixed-header keys are rejected before storage with a generic error", async () => {
    f = await setup();
    const badKey = "synthetic-key\nnot-a-header";
    let calls = 0;
    const d = {
      ...deps(),
      connect: async () => {
        calls++;
        return {
          listTools: async () => [],
          callTool: async () => ({ content: "", isError: false }),
          close: async () => {},
        };
      },
    };
    let message = "";
    try {
      await connectCustomServer(d, f.owner.id, f.org.id, { serverUrl: STITCH, apiKey: badKey });
    } catch (error) {
      message = error instanceof Error ? error.message : "unknown";
    }
    expect(message).toBe("The API key contains invalid characters");
    expect(message).not.toContain(badKey);
    expect(calls).toBe(0);
    expect(
      await f.db.select().from(schema.connectorConnections).where(eq(schema.connectorConnections.serverUrl, STITCH)),
    ).toEqual([]);
  });
  test("fixed fetch refuses a changed endpoint before dispatch and forces redirect error", async () => {
    const { fixedEndpointMcpFetch } = await import("../src/connectors/mcp");
    const seen: { url: string; redirect: RequestInit["redirect"] }[] = [];
    const base: FetchLike = async (url, init) => {
      seen.push({ url: String(url), redirect: init?.redirect });
      return new Response(null, { status: 204 });
    };
    const guarded = fixedEndpointMcpFetch(STITCH, base);
    await guarded(STITCH, { headers: { "x-goog-api-key": KEY }, redirect: "follow" });
    expect(seen).toEqual([{ url: STITCH, redirect: "error" }]);
    await expect(guarded("https://attacker.example/mcp", { headers: { "x-goog-api-key": KEY } })).rejects.toThrow(
      "MCP endpoint changed",
    );
    await expect(guarded(STITCH + "/other")).rejects.toThrow("MCP endpoint changed");
    expect(seen).toHaveLength(1);
  });
  test("the real SDK HTTP connector uses the fixed endpoint policy on all request methods", async () => {
    const { connectOverHttp } = await import("../src/connectors/mcp");
    const original = globalThis.fetch;
    const seen: { url: string; redirect: RequestInit["redirect"]; key: string | null }[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), redirect: init?.redirect, key: new Headers(init?.headers).get("x-goog-api-key") });
      if (init?.method !== "POST") return new Response(null, { status: 405 });
      const msg = JSON.parse(String(init?.body));
      if (msg.id === undefined) return new Response(null, { status: 202 });
      const result =
        msg.method === "initialize"
          ? {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "stitch-test", version: "1" },
            }
          : { tools: [] };
      return Response.json({ jsonrpc: "2.0", id: msg.id, result });
    }) as typeof fetch;
    let session: Awaited<ReturnType<typeof connectOverHttp>> | undefined;
    try {
      allowPrivateOutbound(); // Authored fake HTTP transport only; production keeps the public-address guard.
      session = await connectOverHttp({ serverUrl: STITCH }, { "x-goog-api-key": KEY });
      expect(await session.listTools()).toEqual([]);
      await session.close();
      session = undefined;
      expect(seen.length).toBeGreaterThan(1);
      expect(seen.every((x) => x.url === STITCH && x.redirect === "error" && x.key === KEY)).toBe(true);
    } finally {
      await session?.close();
      allowPrivateOutbound(false);
      globalThis.fetch = original;
    }
  });
  test("a real cross-origin redirect cannot deliver the key to its destination", async () => {
    const { fixedEndpointMcpFetch } = await import("../src/connectors/mcp");
    let targetCalls = 0,
      sourceCalls = 0;
    const target = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        targetCalls++;
        return new Response("unexpected");
      },
    });
    const source = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (r) => {
        sourceCalls++;
        expect(r.headers.get("x-goog-api-key")).toBe(KEY);
        return Response.redirect(target.url.href + "steal", 302);
      },
    });
    try {
      await expect(
        fixedEndpointMcpFetch(source.url.href + "mcp")(source.url.href + "mcp", { headers: { "x-goog-api-key": KEY } }),
      ).rejects.toThrow();
      expect(sourceCalls).toBe(1);
      expect(targetCalls).toBe(0);
    } finally {
      source.stop(true);
      target.stop(true);
    }
  });
});
