import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import { createQuotaCliQualifier } from "../src/quota-qualifier";
import { type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

setDefaultTimeout(60_000);
let f: Fixture | null = null;
afterEach(async () => {
  await f?.close();
  f = null;
});

async function scene() {
  f = await setup();
  const db = f.db;
  const orgId = f.org.id;
  const ownerId = f.owner.id;
  const agentId = f.agent.id;
  const { machineId } = await pairMachine({ db, pubsub: f.pubsub }, ownerId, orgId, {
    name: "Mac",
    os: "darwin",
    arch: "arm64",
    protocol: MACHINE_PROTOCOL_VERSION,
    exec: true,
  });
  await db.update(schema.agents).set({ machineId, brain: "codex" }).where(eq(schema.agents.id, agentId));
  const add = async (over: Partial<typeof schema.machineAccounts.$inferInsert>) => {
    const id = crypto.randomUUID();
    await db.insert(schema.machineAccounts).values({
      id,
      orgId,
      machineId,
      kind: "claude_code",
      label: "Test subscription",
      status: "active",
      createdBy: ownerId,
      shared: true,
      authMethod: "cli_login",
      ...over,
    });
    return id;
  };
  const machines = {
    status: async (id: string) => ({
      id,
      orgId,
      name: "Mac",
      online: true,
      pairedByUserId: ownerId,
      execAllowed: true,
      os: "darwin",
      protocol: MACHINE_PROTOCOL_VERSION,
      executors: {
        detectedAt: new Date().toISOString(),
        codex: { version: "0.163.0" },
        claude: { version: "2.1.300", loggedIn: false, authMethod: "api_key" },
      },
    }),
  };
  const qualifier = createQuotaCliQualifier({ db, machines, models: { claude_code: "claude-fable-5-2" } });
  const request = {
    orgId,
    agentId,
    machineId,
    runId: crypto.randomUUID(),
    channelId: crypto.randomUUID(),
    goalMessageId: crypto.randomUUID(),
    sourceKind: "codex" as const,
    sourceAccountId: null,
    targetKind: "claude_code" as const,
    requiredTools: [],
    context: { system: [], messages: [] },
  };
  return { db, orgId, agentId, machineId, add, qualifier, request };
}

test("subscriber routing rejects unshared, billed API, signed-out, and key-backed accounts", async () => {
  const x = await scene();
  await x.add({ shared: false });
  await x.add({ authMethod: "api_key" });
  await x.add({ status: "signed_out" });
  await x.add({ provider: "opencode" });
  await x.add({ keyHint: "1234" });
  expect(await x.qualifier.qualify(x.request)).toBeNull();
  const allowed = await x.add({});
  expect(await x.qualifier.qualify(x.request)).toMatchObject({
    accountId: allowed,
    targetPool: `claude_code:${x.machineId}:${allowed}`,
    noPaidExtraUsage: true,
    noCredentialsInContext: true,
  });
  await x.db.update(schema.machineAccounts).set({ shared: false }).where(eq(schema.machineAccounts.id, allowed));
  expect(await x.qualifier.qualify(x.request)).toBeNull();
});

test("routing picks subscription with verified headroom, ignores full quota and unknown usage when fresh room exists", async () => {
  const x = await scene();
  const usage = (usedPercent: number) => ({
    source: "probe" as const,
    at: new Date().toISOString(),
    windows: [{ kind: "five_hour" as const, usedPercent, resetsAt: new Date(Date.now() + 3600_000).toISOString() }],
  });
  await x.add({ usage: usage(100) });
  const good = await x.add({ usage: usage(19) });
  await x.add({ usage: usage(82) });
  await x.add({});
  expect(await x.qualifier.qualify(x.request)).toMatchObject({ accountId: good });
});

test("same login pool cannot be its own fallback; secret-bearing context cannot be transferred", async () => {
  const x = await scene();
  const id = await x.add({});
  expect(await x.qualifier.qualify({ ...x.request, sourceKind: "claude_code", sourceAccountId: id })).toBeNull();
  const compromised = {
    ...x.request,
    context: { system: [], messages: [{ role: "user" as const, content: `sk-ant-${"x".repeat(32)}` }] },
  };
  expect(await x.qualifier.qualify(compromised)).toBeNull();
});
