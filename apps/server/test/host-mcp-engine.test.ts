import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HOST_MCP_PROTOCOL } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import {
  bindHostMcp,
  createConnectorToolSource,
  createHostMcpToolSource,
  createToolGateway,
  customScope,
  hostMcpAddress,
  invokeToolForRun,
  listHostMcpProfiles,
  type MachineCaller,
  postPersonMessage,
} from "@agenteschat/engine";
import { type Fixture, setup } from "../../../packages/engine/test/fixtures";
import { handleRequest } from "../runner/handlers";
import { HostMcpManager, profileRevision } from "../runner/host-mcp";

let f: Fixture;
let manager: HostMcpManager;
let home: string;
afterEach(async () => {
  await manager?.close();
  await f?.close();
  if (home) await rm(home, { recursive: true, force: true });
});
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
test("host MCP owning handler + engine gateway: admin bind creates zero grants, exact agent/run policy and PNG survive", async () => {
  f = await setup();
  home = await mkdtemp(path.join(os.tmpdir(), "ac-host-engine-"));
  await chmod(home, 0o700);
  const machineId = crypto.randomUUID();
  const command = await realpath(process.execPath),
    script = await realpath(path.resolve("apps/server/test/fixtures/host-mcp-server.mjs"));
  const p = {
    id: "fixture",
    label: "Fixture host",
    enabled: true,
    kind: "general",
    command,
    args: [script],
    cwd: await realpath(process.cwd()),
    commandSha256: sha(await readFile(command)),
    artifacts: [{ path: script, sha256: sha(await readFile(script)) }],
    envNames: [],
    agents: { [f.agent.id]: { tool_0: "read", tool_1: "approval" } },
    timeoutMs: 2000,
  };
  const raw = JSON.stringify({ version: 1, profiles: [p] }),
    registry = path.join(home, "registry.json");
  await writeFile(registry, raw, { mode: 0o600 });
  manager = new HostMcpManager({
    home,
    machineId,
    orgId: f.org.id,
    phonesDisabled: true,
    config: { enabled: true, registry, sha256: sha(raw) },
  });
  let calls = 0;
  const hub: MachineCaller = {
    status: async (id) => ({
      id,
      orgId: f.org.id,
      name: "fixture",
      online: true,
      execAllowed: false,
      os: "macos",
      protocol: HOST_MCP_PROTOCOL,
      executors: {},
    }),
    call: async (_id, req, options) => {
      calls++;
      return (await handleRequest(
        { workspaceReal: home, exec: false, token: "synthetic-fixture-token", hostMcp: manager },
        req,
        { signal: options?.signal ?? new AbortController().signal, output: () => {} },
      )) as never;
    },
  };
  const deps = { db: f.db, hub };
  await expect(listHostMcpProfiles(deps, "nonmember", f.org.id, machineId)).rejects.toThrow();
  expect(calls).toBe(0);
  const bound = await bindHostMcp(deps, f.owner.id, f.org.id, {
    machineId,
    agentId: f.agent.id,
    profileId: p.id,
    revision: profileRevision(p),
  });
  expect(bound).toMatchObject({ tools: 70, grantsCreated: 0 });
  expect(
    await f.db.select().from(schema.agentScopes).where(eq(schema.agentScopes.connectionId, bound.id)),
  ).toHaveLength(0);
  const msg = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "inspect fixture",
  });
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: msg.id,
      triggerMessageId: msg.id,
      trigger: "mention",
      hop: 1,
      status: "running",
    })
    .returning();
  const ctx = {
    db: f.db,
    orgId: f.org.id,
    agentId: f.agent.id,
    runId: run!.id,
    channelId: f.general.id,
    threadRootId: msg.id,
    triggerMessageId: msg.id,
  };
  const source = createHostMcpToolSource(deps);
  expect(await source.tools(ctx)).toEqual([]);
  // A normal connector source never tries to fetch the machine identity as HTTPS.
  const ordinary = createConnectorToolSource({
    db: f.db,
    keyWrappers: [f.keyWrapper],
    publicUrl: "https://fixture.invalid",
    connect: async () => {
      throw new Error("must not be called");
    },
  });
  expect((await ordinary.tools(ctx)).filter((t) => t.connectionId === bound.id)).toEqual([]);
  await f.db.insert(schema.agentScopes).values({
    orgId: f.org.id,
    agentId: f.agent.id,
    connectionId: bound.id,
    scope: `${customScope(bound.id, "read")}:tool_0`,
  });
  expect(await source.tools(ctx)).toEqual([]); // Unknown grant strings never manufacture a base connector grant.
  await f.db.delete(schema.agentScopes).where(eq(schema.agentScopes.connectionId, bound.id));
  await f.db.insert(schema.agentScopes).values([
    { orgId: f.org.id, agentId: f.agent.id, connectionId: bound.id, scope: customScope(bound.id, "read") },
    { orgId: f.org.id, agentId: f.agent.id, connectionId: bound.id, scope: customScope(bound.id, "approval") },
  ]);
  const listed = await source.tools(ctx);
  expect(listed).toHaveLength(2);
  const read = listed.find((t) => t.name.endsWith("tool_0"))!,
    ask = listed.find((t) => t.name.endsWith("tool_1"))!;
  const gateway = createToolGateway({ sources: [source] });
  const result = await gateway.invoke(ctx, { toolUseId: "read-one", name: read.name, input: {} });
  expect(result.type).toBe("result");
  if (result.type !== "result") throw new Error("expected pixels");
  expect(result.output.images?.[0]?.data).toContain("iVBOR");
  const step = await f.db.select().from(schema.agentRunSteps).where(eq(schema.agentRunSteps.runId, run!.id));
  expect(JSON.stringify(step)).not.toContain("iVBOR");
  const approved = await gateway.invoke(ctx, {
    toolUseId: "ask-one",
    name: ask.name,
    input: { why: "This synthetic fixture verifies the approval gate before any provider tool action." },
  });
  expect(approved).toMatchObject({ type: "approval" });
  if (approved.type === "approval") {
    const [a] = await f.db
      .update(schema.approvals)
      .set({ status: "approved" })
      .where(eq(schema.approvals.id, approved.approval.id))
      .returning();
    const done = await gateway.executeApproved(ctx, a!);
    expect(done.isError).not.toBe(true);
    expect(done.images?.[0]?.data).toContain("iVBOR");
  }
  const readRow = and(eq(schema.customTools.connectionId, bound.id), eq(schema.customTools.name, "tool_0"));
  await f.db.update(schema.customTools).set({ access: "off", sensitive: true }).where(readRow);
  await expect(read.execute({}, { ...ctx, toolUseId: "stale-off" })).rejects.toThrow("policy");
  await bindHostMcp(deps, f.owner.id, f.org.id, {
    machineId,
    agentId: f.agent.id,
    profileId: p.id,
    revision: profileRevision(p),
  });
  const [preserved] = await f.db.select().from(schema.customTools).where(readRow);
  expect(preserved).toMatchObject({ access: "off", sensitive: true });
  expect((await source.tools(ctx)).some((t) => t.name === read.name)).toBe(false);
  await f.db.update(schema.customTools).set({ access: "read" }).where(readRow);
  await expect(read.execute({}, { ...ctx, toolUseId: "stale-sensitive" })).rejects.toThrow("policy");
  expect((await source.tools(ctx)).find((t) => t.name === read.name)?.sensitive).toBe(true);
  await f.db.update(schema.customTools).set({ sensitive: false }).where(readRow);
  const bridged = await invokeToolForRun(
    { db: f.db, tools: gateway },
    { orgId: f.org.id, agentId: f.agent.id, runId: run!.id, machineId },
    { id: "bridge-one", name: read.name, input: {} },
  );
  expect(bridged.result.images?.[0]?.data).toBe(result.output.images?.[0]?.data);
  await expect(read.execute({}, { ...ctx, orgId: crypto.randomUUID(), toolUseId: "wrong-org" })).rejects.toThrow(
    "binding",
  );
  await f.db.update(schema.agentRuns).set({ status: "canceled" }).where(eq(schema.agentRuns.id, run!.id));
  await expect(read.execute({}, { ...ctx, toolUseId: "canceled" })).rejects.toThrow("inactive");
  await f.db.update(schema.agentRuns).set({ status: "running" }).where(eq(schema.agentRuns.id, run!.id));
  await f.db.delete(schema.agentScopes).where(eq(schema.agentScopes.connectionId, bound.id));
  await expect(read.execute({}, { ...ctx, toolUseId: "revoked" })).rejects.toThrow("revoked");
  expect(hostMcpAddress(machineId, p.id, profileRevision(p))).toStartWith("machine-mcp://");
});
