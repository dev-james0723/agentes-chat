import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  connectorGrantValidator,
  createAgent,
  createApiKeyConnection,
  grantedScopeKeys,
  setAgentAccess,
  setAgentScopes,
  storeCustomConnection,
  toolAccess,
  updateOrgSettings,
} from "../src";
import { giveApps } from "../src/agent-proposals";
import { syncGitHubAppConnection } from "../src/connectors/connections";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(() => f?.close());
const deps = () => ({ db: f.db, keyWrappers: [f.keyWrapper], publicUrl: "https://chat.example.com" });
const grants = (connectionId: string) =>
  f.db.select().from(schema.agentScopes).where(eq(schema.agentScopes.connectionId, connectionId));

test("a first API-key connection grants no agent access; explicit grants survive reconnection", async () => {
  f = await setup();
  const [other] = await f.db
    .insert(schema.agents)
    .values({ orgId: f.org.id, name: "Ops", handle: "ops", model: "claude-sonnet-5-5" })
    .returning();
  const first = await createApiKeyConnection(deps(), f.owner.id, f.org.id, {
    connector: "github",
    apiKey: "test-key-12345678",
  });
  expect(await grants(first.id)).toEqual([]);
  await setAgentScopes(
    f.db,
    f.owner.id,
    f.org.id,
    f.agent.id,
    [{ connectionId: first.id, scope: "github:pr.read" }],
    connectorGrantValidator,
  );
  const second = await createApiKeyConnection(deps(), f.owner.id, f.org.id, {
    connector: "github",
    apiKey: "test-key-87654321",
  });
  expect((await grants(second.id)).map((g) => [g.agentId, g.scope])).toEqual([[f.agent.id, "github:pr.read"]]);
  expect((await grants(second.id)).some((g) => g.agentId === other?.id)).toBe(false);
});

test("a new custom MCP account grants no access and records that policy in its audit", async () => {
  f = await setup();
  const { connection } = await storeCustomConnection(deps(), {
    orgId: f.org.id,
    actorId: f.owner.id,
    serverUrl: "https://mcp.example.com",
    label: "Tools",
    authType: "none",
    secret: null,
  });
  expect(await grants(connection.id)).toEqual([]);
  const audit = await f.db
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.action, "connector.custom_connected"));
  expect(audit[0]?.details.everyAgent).toBe(false);
});

test("a new Composio account and a second account both grant no access", async () => {
  f = await setup();
  for (const account of ["first", "second"]) {
    const { connection } = await storeCustomConnection(deps(), {
      orgId: f.org.id,
      actorId: f.owner.id,
      serverUrl: "https://mcp.example.com",
      label: "Drive",
      authType: "oauth",
      secret: null,
      composio: { accountId: `ca_${account}`, name: `${account}@example.com` },
    });
    expect(await grants(connection.id)).toEqual([]);
  }
});

test("a GitHub App installation creates its connection without granting agent access", async () => {
  f = await setup();
  await f.db.insert(schema.githubAppInstallations).values({
    orgId: f.org.id,
    installationId: 123,
    accountLogin: "owner",
    accountType: "User",
    createdByUserId: f.owner.id,
  });
  await f.db.transaction((tx) => syncGitHubAppConnection(tx, f.org.id, { type: "person", id: f.owner.id }));
  const [connection] = await f.db
    .select()
    .from(schema.connectorConnections)
    .where(eq(schema.connectorConnections.orgId, f.org.id));
  if (!connection) throw new Error("GitHub App connection was not created");
  expect(connection.authType).toBe("github_app");
  expect(await grants(connection.id)).toEqual([]);
});

test("new personal-workspace agents do not inherit existing connector accounts", async () => {
  f = await setup();
  const connection = await createApiKeyConnection(deps(), f.owner.id, f.org.id, {
    connector: "github",
    apiKey: "test-key-12345678",
  });
  await updateOrgSettings(f.db, f.owner.id, f.org.id, { mode: "personal" });
  const agent = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "New", handle: "new" },
    { model: "claude-sonnet-5-5" },
  );
  expect((await grants(connection.id)).filter((g) => g.agentId === agent.id)).toEqual([]);
});

test("an approved agent draft does not grant access to apps absent from its access list", async () => {
  f = await setup();
  const connection = await createApiKeyConnection(deps(), f.owner.id, f.org.id, {
    connector: "github",
    apiKey: "test-key-12345678",
  });
  const result = await giveApps(f.db, f.owner.id, f.org.id, f.agent.id, []);
  expect(result).toEqual({ given: [], opened: [] });
  expect(await grants(connection.id)).toEqual([]);
});

test("connecting preserves explicit All tools access without adding connection grants", async () => {
  f = await setup();
  await setAgentAccess(f.db, f.owner.id, f.org.id, f.agent.id, {
    all: true,
    connectors: {},
    scopes: [],
    tools: { allow: [], deny: [] },
  });
  const connection = await createApiKeyConnection(deps(), f.owner.id, f.org.id, {
    connector: "github",
    apiKey: "test-key-12345678",
  });
  expect(await grants(connection.id)).toEqual([]);
  const keys = await grantedScopeKeys(f.db, f.org.id, f.agent.id);
  expect(
    toolAccess(keys, { name: "github_pull_request_read", scope: "github:pr.read", connectionId: connection.id }),
  ).toBe("inherited");
});
