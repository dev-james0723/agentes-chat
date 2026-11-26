import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  acceptCustomSuggestion,
  artifactFile,
  type CustomDeps,
  connectCustomServer,
  connectorGrantValidator,
  connectorListing,
  createConnectorToolSource,
  createToolGateway,
  decideApproval,
  type McpConnect,
  mcpPreset,
  mcpSessionOver,
  postPersonMessage,
  setAgentAccess,
  setAgentScopes,
  type ToolContext,
} from "../src";
import { TREG_MCP_URL } from "../src/connectors/treg";
import { type Fixture, setup } from "./fixtures";

const KEY = "synthetic-treg-token-not-a-real-secret";
let f: Fixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});
const TOOLS = [
  {
    name: "catalog_search",
    description: "Find tools",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    readOnlyHint: true,
  },
  {
    name: "catalog_get",
    description: "Read price and parameters",
    inputSchema: { type: "object", properties: { endpoint_id: { type: "string" } } },
    readOnlyHint: true,
  },
  // Deliberately wrong remote hint: AC's vendor contract must still classify this as sensitive.
  {
    name: "call",
    description: "Call any endpoint",
    inputSchema: { type: "object", properties: { endpoint_id: { type: "string" }, headers: { type: "object" } } },
    readOnlyHint: true,
  },
  { name: "call_media", description: "Generate media", inputSchema: { type: "object" }, readOnlyHint: false },
  { name: "future_tool", description: "Unknown future behavior", inputSchema: { type: "object" }, readOnlyHint: true },
];

async function connected(options: { artifacts?: boolean } = {}) {
  const current = await setup();
  f = current;
  const state = {
    headers: [] as Record<string, string>[],
    calls: [] as { name: string; args: Record<string, unknown> }[],
    fail: false,
    status: 200,
    upstreamFailed: null as string | null,
    costUsd: 0,
    files: [] as { data: string; mimeType: string }[],
  };
  const connect: McpConnect = async (_connection, headers) => {
    state.headers.push(headers);
    return {
      listTools: async () => TOOLS,
      callTool: async (name, args) => {
        state.calls.push({ name, args });
        if (state.fail) throw new Error("ambiguous transport failure");
        return {
          content: JSON.stringify({ body: { ok: true } }),
          isError: false,
          data: {
            call_id: "treg_call_123",
            cost_usd: state.costUsd,
            status: state.status,
            upstream_failed: state.upstreamFailed,
            replayed: false,
          },
          files: state.files,
        };
      },
      close: async () => {},
    };
  };
  const deps: CustomDeps = {
    db: current.db,
    keyWrappers: [current.keyWrapper],
    publicUrl: "https://chat.example.com",
    resolveHost: async () => ["93.184.216.34"],
    connect,
  };
  const started = await connectCustomServer(deps, current.owner.id, current.org.id, {
    serverUrl: TREG_MCP_URL,
    apiKey: KEY,
  });
  if (started.status !== "connected") throw new Error("Fixture did not connect");
  await acceptCustomSuggestion(deps, current.owner.id, current.org.id, started.server.id);
  const msg = await postPersonMessage(
    { db: current.db, pubsub: current.pubsub },
    current.owner.id,
    current.org.id,
    current.general.id,
    { body: "Use TREG" },
  );
  const [run] = await current.db
    .insert(schema.agentRuns)
    .values({
      orgId: current.org.id,
      agentId: current.agent.id,
      channelId: current.general.id,
      threadRootId: msg.id,
      triggerMessageId: msg.id,
      trigger: "mention",
      hop: 1,
    })
    .returning();
  const ctx: ToolContext = {
    db: current.db,
    orgId: current.org.id,
    agentId: current.agent.id,
    runId: run?.id ?? "",
    channelId: current.general.id,
    threadRootId: msg.id,
    triggerMessageId: msg.id,
    toolUseId: "native-call-1",
  };
  const source = createConnectorToolSource({
    ...deps,
    connect,
    ...(options.artifacts === false ? {} : { artifacts: current.artifactDeps }),
  });
  return {
    f: current,
    deps,
    source,
    state,
    ctx,
    server: started.server,
    gateway: createToolGateway({ sources: [source] }),
  };
}

describe("TREG in the shared connector runtime", () => {
  test("the catalog offers the official team endpoint through existing OAuth/key flows", () => {
    expect(mcpPreset("treg")).toMatchObject({ serverUrl: TREG_MCP_URL, label: "TREG", icon: "plug" });
    expect(connectorListing({ oauthApps: {} }).find((x) => x.id === "treg")).toMatchObject({
      available: true,
      soon: false,
      kind: "remote_mcp",
      auth: ["oauth", "api_key"],
      iconUrl: "/connectors/plug.svg",
    });
  });

  test("credentials stay encrypted and account discovery does not silently grant every agent", async () => {
    const { f, state, server, ctx, gateway } = await connected();
    const [stored] = await f.db
      .select()
      .from(schema.connectorConnections)
      .where(eq(schema.connectorConnections.id, server.id));
    expect(stored?.secretCiphertext).toBeTruthy();
    expect(JSON.stringify(stored)).not.toContain(KEY);
    expect(JSON.stringify(server)).not.toContain(KEY);
    const none = { all: false, connectors: {}, scopes: [], tools: { allow: [], deny: [] } };
    await setAgentAccess(f.db, f.owner.id, f.org.id, f.agent.id, none);
    expect(await gateway.list(ctx)).toEqual([]);
    await setAgentScopes(
      f.db,
      f.owner.id,
      f.org.id,
      f.agent.id,
      [{ connectionId: server.id, scope: "custom:" + server.id + ":read" }],
      connectorGrantValidator,
    );
    expect((await gateway.list(ctx)).map((x) => x.name).sort()).toEqual(["treg_catalog_get", "treg_catalog_search"]);
    expect(state.headers[0]).toEqual({ authorization: "Bearer " + KEY });
    expect(
      await createConnectorToolSource({
        db: f.db,
        keyWrappers: [f.keyWrapper],
        publicUrl: "https://chat.example.com",
      }).tools({ ...ctx, orgId: crypto.randomUUID() }),
    ).toEqual([]);
  });

  test("dynamic and unknown tools keep write scopes and sensitivity despite permissive remote hints", async () => {
    const { source, ctx, server } = await connected();
    const tools = await source.tools(ctx);
    for (const name of ["treg_call", "treg_call_media", "treg_future_tool"]) {
      expect(tools.find((x) => x.name === name)).toMatchObject({
        sensitive: true,
        scope: "custom:" + server.id + ":write",
      });
    }
    expect(tools.find((x) => x.name === "treg_call")).toMatchObject({ ahead: false });
    expect(tools.find((x) => x.name === "treg_call_media")).toMatchObject({ ahead: false });
    expect(tools.find((x) => x.name === "treg_call")?.rememberTarget?.({ endpoint_id: "x" })).toBeNull();
  });

  test("interactive and routine contexts both get backend tags, argument caps and native receipts", async () => {
    const { source, ctx, state } = await connected();
    const tools = await source.tools(ctx);
    const tool = tools.find((x) => x.name === "treg_call");
    if (!tool) throw new Error("TREG call missing");
    for (const background of [false, true]) {
      const output = await tool.execute(
        { endpoint_id: "lever.postings.list", headers: { "X-Treg-Meta": "agent=forged" } },
        { ...ctx, background },
      );
      expect(output.isError).toBe(false);
      expect(output.data?.treg).toMatchObject({ callId: "treg_call_123", reportedCostMicro: 0, capUsd: 0 });
      expect(state.calls.at(-1)?.args.headers).toEqual({ "X-Treg-Route-Max-Cost": "0" });
      expect(state.headers.at(-1)?.["X-Treg-Meta"]).toContain("agent=" + ctx.agentId);
      expect(state.headers.at(-1)?.authorization).toBe("Bearer " + KEY);
      expect(JSON.stringify(output)).not.toContain(KEY);
    }
    expect(state.calls[0]?.args.idempotency_key).toBe(state.calls[1]?.args.idempotency_key);
  });

  test("positive ceilings cannot dispatch without native approval; unknown outcomes dispatch once", async () => {
    const { source, ctx, state } = await connected();
    const tool = (await source.tools(ctx)).find((x) => x.name === "treg_call");
    if (!tool) throw new Error("TREG call missing");
    const input = { endpoint_id: "paid.tool", headers: { "X-Treg-Route-Max-Cost": "0.01" } };
    await expect(tool.execute(input, ctx)).rejects.toThrow("approved");
    expect(state.calls).toHaveLength(0);
    state.fail = true;
    const output = await tool.execute(input, { ...ctx, approved: true });
    expect(output).toMatchObject({ isError: true, data: { treg: { executionStatus: "unknown" } } });
    expect(output.content).toContain("not retried");
    expect(state.calls).toHaveLength(1);
  });

  test("native approval binds the positive ceiling and resumes the exact call once", async () => {
    const { f, gateway, ctx, state, server } = await connected();
    await setAgentScopes(
      f.db,
      f.owner.id,
      f.org.id,
      f.agent.id,
      [{ connectionId: server.id, scope: "custom:" + server.id + ":write" }],
      connectorGrantValidator,
    );
    const input = { endpoint_id: "paid.tool", headers: { "X-Treg-Route-Max-Cost": "0.01" } };
    const asked = await gateway.invoke(ctx, {
      toolUseId: "paid-native",
      name: "treg_call",
      input: { ...input, why: "The owner approved this specific fixture request with a one cent ceiling." },
    });
    if (asked.type !== "approval") throw new Error("Expected native approval: " + JSON.stringify(asked));
    expect(asked.approval.params).toEqual(input);
    expect(asked.approval.detail).toContain("0.01");
    expect(asked.approval.approveAlways).toBeNull();
    expect(state.calls).toHaveLength(0);
    await decideApproval({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, asked.approval.id, {
      decision: "approve",
    });
    const [approved] = await f.db.select().from(schema.approvals).where(eq(schema.approvals.id, asked.approval.id));
    if (!approved) throw new Error("Stored approval missing");
    const output = await gateway.executeApproved(ctx, approved);
    expect(output.isError).not.toBe(true);
    expect(output.data?.treg).toMatchObject({ capUsd: 0.01, callId: "treg_call_123" });
    expect(state.calls.at(-1)?.args.headers).toEqual({ "X-Treg-Route-Max-Cost": "0.01" });
    await gateway.executeApproved(ctx, approved);
    expect(state.calls).toHaveLength(1);
  });

  test("declined upstream calls are failures even when the MCP envelope is successful", async () => {
    const { source, ctx, state } = await connected();
    state.status = 402;
    const tool = (await source.tools(ctx)).find((x) => x.name === "treg_call");
    if (!tool) throw new Error("TREG call missing");
    const output = await tool.execute({ endpoint_id: "paid.tool" }, ctx);
    expect(output.isError).toBe(true);
    expect(output.data?.treg).toMatchObject({ status: 402, reportedCostMicro: 0 });
    state.status = 200;
    state.upstreamFailed = "provider_success_rule";
    state.costUsd = 0.001;
    const billed = await tool.execute({ endpoint_id: "paid.tool" }, { ...ctx, toolUseId: "billed-failure" });
    expect(billed.isError).toBe(true);
    expect(billed.data?.treg).toMatchObject({ status: 200, reportedCostMicro: 1000 });
    expect(state.calls).toHaveLength(2);
  });

  test("inline audio is retained as a native untrusted file with its original bytes", async () => {
    const { f, source, ctx, state } = await connected();
    const bytes = Buffer.from("RIFF synthetic audio fixture");
    state.files = [{ data: bytes.toString("base64"), mimeType: "audio/wav" }];
    const tool = (await source.tools(ctx)).find((x) => x.name === "treg_call_media");
    if (!tool) throw new Error("TREG media call missing");
    const output = await tool.execute({ endpoint_id: "audio.fixture", body: {} }, ctx);
    expect(output.isError).toBe(false);
    const [saved] = await f.db.select().from(schema.artifacts).where(eq(schema.artifacts.kind, "file"));
    expect(saved).toMatchObject({ orgId: f.org.id, untrusted: true });
    expect(output.content).toContain("file " + saved?.id);
    expect(JSON.stringify(output)).not.toContain(bytes.toString("base64"));
    const file = await artifactFile(f.artifactDeps, f.owner.id, f.org.id, saved?.id ?? "");
    expect(Buffer.from(file.body)).toEqual(bytes);
  });

  test("media needs file storage before dispatch and malformed returned media is not a success", async () => {
    const { source, ctx, state, deps, f } = await connected({ artifacts: false });
    const tool = (await source.tools(ctx)).find((x) => x.name === "treg_call_media");
    if (!tool) throw new Error("TREG media call missing");
    await expect(tool.execute({ endpoint_id: "audio.fixture", body: {} }, ctx)).rejects.toThrow("file storage");
    expect(state.calls).toHaveLength(0);
    state.files = [{ data: "not base64!", mimeType: "audio/wav" }];
    const withStorage = createConnectorToolSource({ ...deps, artifacts: f.artifactDeps });
    const working = (await withStorage.tools(ctx)).find((x) => x.name === "treg_call_media");
    if (!working) throw new Error("TREG media call missing");
    const result = await working.execute({ endpoint_id: "audio.fixture", body: {} }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not retried");
    expect(state.calls).toHaveLength(1);
  });

  test("the real MCP SDK retains structured metadata alongside human-readable text", async () => {
    const server = new McpServer({ name: "treg-fixture", version: "1" });
    server.registerTool("catalog_get", { inputSchema: {} }, async () => ({
      content: [
        { type: "text", text: "human-readable" },
        { type: "audio", data: "UklGRg==", mimeType: "audio/wav" },
      ],
      structuredContent: { call_id: "metadata-id", cost_usd: 0.001 },
    }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const session = await mcpSessionOver(clientTransport, TREG_MCP_URL);
    try {
      expect(await session.callTool("catalog_get", {})).toMatchObject({
        content: "human-readable\n[audio]",
        files: [{ data: "UklGRg==", mimeType: "audio/wav" }],
        data: { call_id: "metadata-id", cost_usd: 0.001 },
      });
    } finally {
      await session.close();
      await server.close();
    }
  });
});
