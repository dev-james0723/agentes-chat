import { afterEach, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import {
  createFoundryService,
  FOUNDRY_NATIVE_CONTRACT,
  foundryContext,
  ownedCandidate,
} from "../src/foundry/service";
import { RECEIPT_INPUT_SCHEMA } from "../src/foundry/receipt-contract";
import { type Approval, createToolGateway } from "../src/tools/gateway";
import { toolDenyScope } from "../src/tools/scopes";
import type { NativeToolContract, NativeToolReuse, ToolContext, ToolDefinition, ToolExecutionPolicy } from "../src/tools/types";
import { type Fixture, setup } from "./fixtures";

// Native inventory/checkpoint integration only. No candidate code, sandbox or protected evaluator is simulated here.
let f: Fixture;
afterEach(async () => {
  await f?.close();
});

const VERSION = "a".repeat(64);
const DIFFERENT = "b".repeat(64);
const NEED = { needKey: "receipt-normalizer/v1" };
type NativeReuse = (ctx: ToolContext, contract: NativeToolContract) => Promise<NativeToolReuse | null>;
const searchedEmpty: NativeReuse = async () => null;

async function ready() {
  f = await setup();
  const [task] = await f.db.insert(schema.issues).values({
    orgId: f.org.id,
    number: 9301,
    title: "Normalize synthetic task receipts",
    createdByType: "person",
    createdById: f.owner.id,
    assigneeType: "agent",
    assigneeId: f.agent.id,
    restricted: true,
    audienceUserIds: [f.owner.id],
  }).returning();
  const [message] = await f.db.insert(schema.messages).values({
    orgId: f.org.id,
    channelId: f.general.id,
    authorType: "person",
    authorUserId: f.owner.id,
    body: "Normalize synthetic task receipts using receipt-normalizer/v1.",
  }).returning();
  const [run] = await f.db.insert(schema.agentRuns).values({
    orgId: f.org.id,
    agentId: f.agent.id,
    channelId: f.general.id,
    threadRootId: message!.id,
    triggerMessageId: message!.id,
    trigger: "mention",
    hop: 1,
    status: "running",
    issueId: task!.id,
  }).returning();
  const ctx: ToolContext = {
    db: f.db,
    orgId: f.org.id,
    agentId: f.agent.id,
    runId: run!.id,
    channelId: f.general.id,
    threadRootId: message!.id,
    triggerMessageId: message!.id,
    toolUseId: "native-foundry-intake",
  };
  const service = (nativeReuse?: NativeReuse) => createFoundryService({
    db: f.db,
    blobs: f.artifactDeps.blobs,
    ...(nativeReuse ? { nativeReuse } : {}),
  });
  return { ctx, task: task!, run: run!, service };
}

function reviewedTool(name = "native_receipt_normalizer"): ToolDefinition {
  return {
    name,
    description: "Aggregate synthetic task receipts.",
    inputSchema: RECEIPT_INPUT_SCHEMA,
    scope: "skills:read",
    reviewedCapability: { ...FOUNDRY_NATIVE_CONTRACT, versionDigest: VERSION },
    async execute() {
      throw new Error("Reuse discovery must never execute an existing or candidate tool");
    },
  };
}

test("native Gateway inventory returns the exact immutable permitted version without creating a candidate", async () => {
  const w = await ready();
  const gateway = createToolGateway({ sources: [{ name: "existing-native", tools: async () => [reviewedTool()] }] });
  const result = await w.service((ctx, contract) => gateway.findCapability(ctx, contract)).propose(w.ctx, NEED);
  expect(result).toEqual({ kind: "reuse", candidate: null, existing: {
    kind: "tool", id: "native_receipt_normalizer", version: VERSION,
  } });
  expect(await f.db.select().from(schema.foundryCandidates)).toEqual([]);
});

test("name, description and matching input schema without reviewed semantics do not establish reuse", async () => {
  const w = await ready();
  const tool = reviewedTool();
  delete tool.reviewedCapability;
  const gateway = createToolGateway({ sources: [{ name: "unreviewed-native", tools: async () => [tool] }] });
  expect(await gateway.findCapability(w.ctx, FOUNDRY_NATIVE_CONTRACT)).toBeNull();
  const result = await w.service((ctx, contract) => gateway.findCapability(ctx, contract)).propose(w.ctx, NEED);
  expect(result.kind).toBe("draft");
});

test("every semantic digest and implementation version must match before native reuse", async () => {
  const w = await ready();
  let tool = reviewedTool();
  const gateway = createToolGateway({ sources: [{ name: "changing-native", tools: async () => [tool] }] });
  for (const field of ["inputDigest", "outputDigest", "effectsDigest"] as const) {
    tool = { ...reviewedTool(), reviewedCapability: { ...FOUNDRY_NATIVE_CONTRACT, versionDigest: VERSION, [field]: DIFFERENT } };
    expect(await gateway.findCapability(w.ctx, FOUNDRY_NATIVE_CONTRACT)).toBeNull();
  }
  tool = { ...reviewedTool(), reviewedCapability: { ...FOUNDRY_NATIVE_CONTRACT, versionDigest: "latest" } };
  expect(await gateway.findCapability(w.ctx, FOUNDRY_NATIVE_CONTRACT)).toBeNull();
  tool = { ...reviewedTool(), inputSchema: { type: "object", properties: {} } };
  expect(await gateway.findCapability(w.ctx, FOUNDRY_NATIVE_CONTRACT)).toBeNull();
});

test("inventory ignores connector-supplied capability claims and unmet native prerequisites", async () => {
  const w = await ready();
  let tool: ToolDefinition = { ...reviewedTool(), connectionId: crypto.randomUUID() };
  const gateway = createToolGateway({ sources: [{ name: "untrusted-claim", tools: async () => [tool] }] });
  expect(await gateway.findCapability(w.ctx, FOUNDRY_NATIVE_CONTRACT)).toBeNull();
  tool = { ...reviewedTool(), needs: { name: "run_code", scope: "sandbox:run" } };
  expect(await gateway.findCapability(w.ctx, FOUNDRY_NATIVE_CONTRACT)).toBeNull();
});

test("fresh deny wins over an already cached native listing", async () => {
  const w = await ready();
  const tool = reviewedTool();
  const gateway = createToolGateway({ sources: [{ name: "existing-native", tools: async () => [tool] }] });
  expect((await gateway.granted(w.ctx)).map((t) => t.name)).toContain(tool.name);
  // Deliberately bypass the grant helper's cache invalidation: capability discovery must use fresh grants.
  await f.db.insert(schema.agentScopes).values({
    orgId: f.org.id, agentId: f.agent.id, connectionId: null, scope: toolDenyScope(tool.name),
  });
  expect(await gateway.findCapability(w.ctx, FOUNDRY_NATIVE_CONTRACT)).toBeNull();
});

test("native reuse is deterministic and compares the raw schema before approval listing adds why", async () => {
  const w = await ready();
  const source = {
    name: "existing-native",
    tools: async () => [reviewedTool("z_receipts"), { ...reviewedTool("a_receipts"), sensitive: true }],
  };
  const gateway = createToolGateway({ sources: [source] });
  const listed = (await gateway.granted(w.ctx)).find((t) => t.name === "a_receipts")!;
  expect(listed.inputSchema).not.toEqual(RECEIPT_INPUT_SCHEMA);
  expect(await gateway.findCapability(w.ctx, FOUNDRY_NATIVE_CONTRACT)).toEqual({
    kind: "tool", id: "a_receipts", version: VERSION,
  });
});

test("an absent, failed or malformed native inventory never creates a new draft", async () => {
  const w = await ready();
  const unavailable: (NativeReuse | undefined)[] = [
    undefined,
    async () => { throw new Error("native inventory unavailable"); },
    async () => undefined as never,
    async () => ({ kind: "tool", id: "claimed_tool", version: "latest" }),
  ];
  for (const search of unavailable) {
    await expect(w.service(search).propose(w.ctx, NEED)).rejects.toMatchObject({ code: "NATIVE_INVENTORY_UNAVAILABLE" });
  }
  expect(await f.db.select().from(schema.foundryCandidates)).toEqual([]);
});

test("native Skill reuse remains available without a tool inventory adapter", async () => {
  const w = await ready();
  const [skill] = await f.db.insert(schema.skills).values({
    orgId: f.org.id,
    slug: "existing-receipt-workflow",
    name: "Existing receipt workflow",
    description: "Native instruction reuse",
    body: "Use the existing native receipt workflow.",
    metadata: { foundryContract: NEED.needKey },
    source: "manual",
    createdByUserId: f.owner.id,
  }).returning();
  await f.db.insert(schema.agentSkills).values({ orgId: f.org.id, agentId: f.agent.id, skillId: skill!.id, enabled: true });
  expect(await w.service().propose(w.ctx, NEED)).toMatchObject({
    kind: "reuse", existing: { kind: "skill", id: skill!.id, version: 1 },
  });
  expect(await f.db.select().from(schema.foundryCandidates)).toEqual([]);
});

test("an existing draft can be recovered during an inventory outage without admitting new generation", async () => {
  const w = await ready();
  const initial = await w.service(searchedEmpty).propose(w.ctx, NEED);
  expect(initial.kind).toBe("draft");
  expect(await w.service().propose(w.ctx, NEED)).toEqual(initial);
  expect((await f.db.select().from(schema.foundryCandidates)).length).toBe(1);
});

test("task changes while inventory loads invalidate the old proposal context", async () => {
  const w = await ready();
  const service = w.service(async () => {
    await f.db.update(schema.issues).set({ title: "A different authorized task purpose" }).where(eq(schema.issues.id, w.task.id));
    return null;
  });
  await expect(service.propose(w.ctx, NEED)).rejects.toMatchObject({ code: "STALE_CONTEXT" });
  expect(await f.db.select().from(schema.foundryCandidates)).toEqual([]);
});

test("only the exact server-supplied unresolved evaluation checkpoint admits a waiting parent", async () => {
  const w = await ready();
  const checkpoint = { waitId: "foundry-evaluation:exact", toolUseId: "evaluate-exact" };
  const call = { ...checkpoint, name: "evaluate_foundry_capability" };
  await f.db.update(schema.agentRuns).set({
    status: "waiting_input", transcript: { pending: { calls: [call] } },
  }).where(eq(schema.agentRuns.id, w.run.id));
  expect((await foundryContext(f.db, w.ctx, checkpoint)).task.id).toBe(w.task.id);
  await expect(foundryContext(f.db, w.ctx)).rejects.toMatchObject({ code: "AUTHORITY_DENIED" });
  await expect(foundryContext(f.db, { ...w.ctx, checkpoint } as ToolContext)).rejects.toMatchObject({ code: "AUTHORITY_DENIED" });
  const deniedCalls = [
    [{ ...call, waitId: "another-wait" }],
    [{ ...call, toolUseId: "another-tool-use" }],
    [{ ...call, name: "activate_foundry_capability" }],
    [{ ...call, result: { content: "already delivered", isError: false } }],
    [call, call],
  ];
  for (const calls of deniedCalls) {
    await f.db.update(schema.agentRuns).set({ transcript: { pending: { calls } } }).where(eq(schema.agentRuns.id, w.run.id));
    await expect(foundryContext(f.db, w.ctx, checkpoint)).rejects.toMatchObject({ code: "AUTHORITY_DENIED" });
  }
});

test("checkpoint validation preserves current ownership and never widens ordinary tool admission", async () => {
  const w = await ready();
  const draft = await w.service(searchedEmpty).propose(w.ctx, NEED);
  if (draft.kind !== "draft") throw new Error("Expected draft");
  const checkpoint = { waitId: "foundry-evaluation:exact", toolUseId: "evaluate-exact" };
  const transcript = { pending: { calls: [{ ...checkpoint, name: "evaluate_foundry_capability" }] } };
  await expect(foundryContext(f.db, w.ctx, checkpoint)).rejects.toMatchObject({ code: "AUTHORITY_DENIED" });
  await f.db.update(schema.agentRuns).set({ status: "waiting_approval", transcript }).where(eq(schema.agentRuns.id, w.run.id));
  expect((await ownedCandidate(f.db, w.ctx, draft.candidate.id, checkpoint)).candidate.id).toBe(draft.candidate.id);
  await f.db.update(schema.issues).set({ title: "Changed purpose" }).where(eq(schema.issues.id, w.task.id));
  await expect(ownedCandidate(f.db, w.ctx, draft.candidate.id, checkpoint)).rejects.toMatchObject({ code: "STALE_CONTEXT" });
  await f.db.delete(schema.organizationMembers).where(and(
    eq(schema.organizationMembers.orgId, f.org.id), eq(schema.organizationMembers.userId, f.owner.id),
  ));
  await expect(foundryContext(f.db, w.ctx, checkpoint)).rejects.toMatchObject({ code: "AUTHORITY_DENIED" });
});

function restrictedPolicy(allowed: () => boolean = () => true): ToolExecutionPolicy {
  return {
    async sourceAllowed(_ctx, source) { return source === "reviewed-native"; },
    async check(_ctx, tool, source) {
      return allowed() && source === "reviewed-native" && tool.name === "reviewed_receipt"
        ? { ok: true }
        : { ok: false, message: "This enrolled run only admits its reviewed native receipt tool." };
    },
  };
}

function plainTool(execute: ToolDefinition["execute"]): ToolDefinition {
  return {
    name: "reviewed_receipt", description: "Reviewed pure synthetic test operation.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    scope: "skills:read", execute,
  };
}

test("restricted sources are excluded before discovery and same-source peers remain denied", async () => {
  const w = await ready();
  let sourceReads = 0;
  let executions = 0;
  const tool = plainTool(async () => { executions++; return { content: "ok" }; });
  const gateway = createToolGateway({
    executionPolicy: restrictedPolicy(),
    sources: [
      { name: "unrestricted-host", async tools() { sourceReads++; throw new Error("must not discover host tools"); } },
      { name: "reviewed-native", async tools() { return [tool, { ...tool, name: "update_skill" }]; } },
    ],
  });
  expect((await gateway.granted(w.ctx)).map((t) => t.name)).toEqual([tool.name]);
  const denied = await gateway.invoke(w.ctx, { toolUseId: "restricted-write", name: "update_skill", input: {} });
  expect(denied.type).toBe("result");
  if (denied.type === "result") expect(denied.output).toMatchObject({ isError: true, data: { code: "tool.execution_policy" } });
  expect(sourceReads).toBe(0);
  expect(executions).toBe(0);
});

test("a matching tool name from an unreviewed source cannot satisfy the native policy", async () => {
  const w = await ready();
  let executions = 0;
  const tool = plainTool(async () => { executions++; return { content: "untrusted" }; });
  const policy = restrictedPolicy();
  const gateway = createToolGateway({
    executionPolicy: { ...policy, sourceAllowed: async () => true },
    sources: [{ name: "untrusted-source", tools: async () => [tool] }],
  });
  expect(await gateway.granted(w.ctx)).toEqual([]);
  const result = await gateway.invoke(w.ctx, { toolUseId: "spoofed-name", name: tool.name, input: {} });
  expect(result.type).toBe("result");
  if (result.type === "result") expect(result.output.isError).toBe(true);
  expect(executions).toBe(0);
});

test("policy lookup failures are unavailable inventory, never a completed empty search", async () => {
  const w = await ready();
  const unavailable = async (): Promise<never> => { throw new Error("policy database unavailable"); };
  for (const executionPolicy of [
    { sourceAllowed: unavailable, check: async () => ({ ok: true as const }) },
    { sourceAllowed: async () => true, check: unavailable },
  ]) {
    const gateway = createToolGateway({
      executionPolicy,
      sources: [{ name: "reviewed-native", tools: async () => [reviewedTool()] }],
    });
    await expect(w.service((ctx, contract) => gateway.findCapability(ctx, contract)).propose(w.ctx, NEED))
      .rejects.toMatchObject({ code: "NATIVE_INVENTORY_UNAVAILABLE" });
  }
  expect(await f.db.select().from(schema.foundryCandidates)).toEqual([]);
});

test("an approved cached result cannot bypass the current restricted execution policy", async () => {
  const w = await ready();
  const gateway = createToolGateway({
    executionPolicy: restrictedPolicy(),
    sources: [{ name: "reviewed-native", tools: async () => [{ ...reviewedTool(), name: "disallowed_host_read" }] }],
  });
  // The early replay branch used to return this saved output before checking any current tool policy.
  const approval = {
    tool: "disallowed_host_read", status: "approved", executedAt: new Date(),
    result: { content: "protected cached result", isError: false },
  } as unknown as Approval;
  const output = await gateway.executeApproved(w.ctx, approval);
  expect(output).toMatchObject({ isError: true, data: { code: "tool.execution_policy" } });
  expect(output.content).not.toContain("protected cached result");
});

test("policy revocation during a native argument check prevents executable dispatch", async () => {
  const w = await ready();
  let allowed = true;
  let executions = 0;
  const tool: ToolDefinition = {
    ...plainTool(async () => { executions++; return { content: "must not execute" }; }),
    async checkCall() { allowed = false; return { ok: true }; },
  };
  const gateway = createToolGateway({
    executionPolicy: restrictedPolicy(() => allowed),
    sources: [{ name: "reviewed-native", tools: async () => [tool] }],
  });
  const result = await gateway.invoke(w.ctx, { toolUseId: "revoke-before-dispatch", name: tool.name, input: {} });
  expect(result.type).toBe("result");
  if (result.type === "result") expect(result.output).toMatchObject({ isError: true, data: { code: "tool.execution_policy" } });
  expect(executions).toBe(0);
});

test("a late tool result is withheld when the enrolled run loses authorization", async () => {
  const w = await ready();
  let allowed = true;
  let executions = 0;
  const tool = plainTool(async () => {
    executions++;
    allowed = false;
    return { content: "protected late result" };
  });
  const gateway = createToolGateway({
    executionPolicy: restrictedPolicy(() => allowed),
    sources: [{ name: "reviewed-native", tools: async () => [tool] }],
  });
  const result = await gateway.invoke(w.ctx, { toolUseId: "revoke-before-release", name: tool.name, input: {} });
  expect(result.type).toBe("result");
  if (result.type === "result") {
    expect(result.output).toMatchObject({ isError: true, data: { code: "tool.execution_policy" } });
    expect(result.output.content).not.toContain("protected late result");
  }
  expect(executions).toBe(1);
});

test("native per-call definition changes preserve source provenance without widening grants", async () => {
  const w = await ready();
  let executions = 0;
  const tool: ToolDefinition = {
    ...plainTool(async () => { executions++; return { content: "ok" }; }),
    sensitive: true,
    asksNobody: () => true,
  };
  const gateway = createToolGateway({
    executionPolicy: restrictedPolicy(),
    sources: [{ name: "reviewed-native", tools: async () => [tool] }],
  });
  const permitted = await gateway.invoke(w.ctx, { toolUseId: "derived-definition", name: tool.name, input: {} });
  expect(permitted.type).toBe("result");
  if (permitted.type === "result") expect(permitted.output.isError).not.toBe(true);
  expect(executions).toBe(1);
  tool.scope = "sandbox:run";
  expect(await gateway.granted(w.ctx)).toEqual([]);
  const denied = await gateway.invoke(w.ctx, { toolUseId: "missing-native-grant", name: tool.name, input: {} });
  expect(denied.type).toBe("result");
  if (denied.type === "result") expect(denied.output.isError).toBe(true);
  expect(executions).toBe(1);
});
