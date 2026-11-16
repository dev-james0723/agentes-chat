import { afterEach, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import { decideApproval, setAgentScopes } from "../src";
import { FOUNDRY_ACTIVATE_TOOL, type FoundryLifecycleDependencies, foundryToolName } from "../src/foundry/lifecycle";
import { createFoundryToolSource } from "../src/foundry/tools";
import { createToolGateway } from "../src/tools/gateway";
import type { ToolContext, ToolDefinition } from "../src/tools/types";
import { type Fixture, setup } from "./fixtures";
import { createLifecycleWorld, FRESH_INPUT, FRESH_OUTPUT, type LifecycleWorld } from "./foundry-lifecycle.fixture";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});
const managementNames = [
  "propose_foundry_capability",
  "stage_foundry_package",
  "evaluate_foundry_capability",
  "prepare_foundry_activation",
  "activate_foundry_capability",
  "run_foundry_canary",
  "revoke_foundry_capability",
];
const sourceOf = (world: LifecycleWorld) =>
  createFoundryToolSource({
    db: f.db,
    blobs: f.artifactDeps.blobs,
    executor: world.executor,
    evaluations: world.evaluations,
    now: () => new Date(world.state.now),
    enabled: true,
  });
function named(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw new Error("Missing native tool: " + name);
  return tool;
}
async function ready() {
  f = await setup();
  const world = await createLifecycleWorld(f);
  return { world, source: sourceOf(world) };
}

test("disabled source never consults a DB, blob store, executor or supplied context", async () => {
  const poison = new Proxy(
    {},
    {
      get() {
        throw new Error("Disabled source performed I/O");
      },
    },
  );
  const source = createFoundryToolSource({
    db: poison,
    blobs: poison,
    executor: poison,
    enabled: false,
  } as unknown as FoundryLifecycleDependencies & { enabled: boolean });
  expect(await source.tools(poison as ToolContext)).toEqual([]);
  expect(await source.tools(null as unknown as ToolContext)).toEqual([]);
});

test("management requires a valid native task and the persisted applicable trigger", async () => {
  const { world, source } = await ready();
  const tools = await source.tools(world.ctx);
  expect(tools.map((tool) => tool.name).sort()).toEqual([...managementNames].sort());
  expect(named(tools, "propose_foundry_capability").scope).toBe("skills:read");
  expect(named(tools, "stage_foundry_package").scope).toBe("skills:read");
  for (const name of managementNames.slice(2)) expect(named(tools, name).scope).toBe("sandbox:run");
  expect(named(tools, "activate_foundry_capability").sensitive).toBe(true);
  const negative = await world.session("Explain expense receipts and invoices");
  expect((await source.tools(negative)).map((tool) => tool.name).sort()).toEqual(managementNames.slice(2).sort());
  await f.db.update(schema.agentRuns).set({ status: "canceled" }).where(eq(schema.agentRuns.id, world.ctx.runId));
  expect(await source.tools(world.ctx)).toEqual([]);
});

test("native gateway scope filtering applies to the foundry source", async () => {
  const { world, source } = await ready();
  await setAgentScopes(f.db, f.owner.id, f.org.id, f.agent.id, [{ connectionId: null, scope: "skills:read" }]);
  const tools = await createToolGateway({ sources: [source] }).granted(world.ctx);
  expect(tools.map((tool) => tool.name).sort()).toEqual(["propose_foundry_capability", "stage_foundry_package"]);
});

test("all management arguments reject forged authority and activation exposes only exact scope parameters", async () => {
  const { world, source } = await ready();
  const tools = await source.tools(world.ctx);
  for (const tool of tools) {
    expect(
      await tool.checkCall?.({ approved: true, qualified: true, evaluatorOutcome: "PASS" }, world.ctx),
    ).toMatchObject({ ok: false });
  }
  const activate = named(tools, "activate_foundry_capability");
  expect(activate.inputSchema.additionalProperties).toBe(false);
  expect(activate.inputSchema.required).toEqual([
    "candidateId",
    "candidateRevision",
    "versionDigest",
    "contractDigest",
    "effectsDigest",
    "taskId",
    "agentId",
    "personId",
    "evaluationRef",
    "runtimeDigest",
    "profileDigest",
    "validUntil",
    "maxCalls",
    "previousBindingId",
  ]);
});

test("stage stores canonical supplied bytes without interpreting a path or executing content", async () => {
  const { world, source } = await ready();
  const staged = await world.stage();
  const proposal = await world.service.propose(world.ctx, { needKey: "receipt-normalizer/v1" });
  if (proposal.kind !== "draft") throw new Error("expected draft");
  const stage = named(await source.tools(world.ctx), "stage_foundry_package");
  const input = {
    candidateId: staged.candidateId,
    revision: proposal.candidate.revision,
    manifestJson: JSON.stringify({ ...staged.bundle.manifest, version: "1.0.1" }),
    files: [{ path: "candidate.txt", base64: Buffer.from("INERT supplied bytes; never executed.").toString("base64") }],
  };
  expect(await stage.checkCall?.(input, world.ctx)).toMatchObject({ ok: true });
  const result = await stage.execute(input, world.ctx);
  expect(result.isError).not.toBe(true);
  const version = JSON.parse(result.content);
  expect(version.candidateId).toBe(staged.candidateId);
  expect(version.digest).not.toBe(staged.digest);
  expect(world.state.executions).toHaveLength(0);
  expect(world.state.evaluations).toBe(0);
});

test("stage rejects alternate base64 encodings, paths and metadata before adding a version", async () => {
  const { world, source } = await ready();
  const staged = await world.stage();
  const proposal = await world.service.propose(world.ctx, { needKey: "receipt-normalizer/v1" });
  if (proposal.kind !== "draft") throw new Error("expected draft");
  const stage = named(await source.tools(world.ctx), "stage_foundry_package");
  const base = {
    candidateId: staged.candidateId,
    revision: proposal.candidate.revision,
    manifestJson: staged.bundle.manifestJson,
    files: [{ path: "candidate.txt", base64: "eA==" }],
  };
  const invalid = [
    { ...base, approved: true },
    { ...base, files: [{ path: "candidate.txt", base64: "eA" }] },
    { ...base, files: [{ path: "candidate.txt", base64: "eA==\n" }] },
    { ...base, files: [{ path: "../outside.txt", base64: "eA==" }] },
    { ...base, files: [{ path: "/etc/passwd", base64: "eA==" }] },
    { ...base, files: [{ path: "candidate.txt", base64: "eA==", kind: "symlink" }] },
    { ...base, files: [{ path: "candidate.txt", base64: "A".repeat(1398108) }] },
  ];
  const before = (await f.db.select().from(schema.foundryVersions)).length;
  for (const input of invalid) {
    expect(await stage.checkCall?.(input, world.ctx)).toMatchObject({ ok: false });
    expect((await stage.execute(input, world.ctx)).isError).toBe(true);
  }
  expect((await f.db.select().from(schema.foundryVersions)).length).toBe(before);
  expect(world.state.executions).toHaveLength(0);
});

test("cached management definition checks the current native trigger before a draft mutation", async () => {
  const { world, source } = await ready();
  const propose = named(await source.tools(world.ctx), "propose_foundry_capability");
  await f.db
    .update(schema.messages)
    .set({ body: "Explain expense receipts" })
    .where(eq(schema.messages.id, world.ctx.triggerMessageId));
  expect(await propose.checkCall?.({ needKey: "receipt-normalizer/v1" }, world.ctx)).toMatchObject({ ok: false });
  expect((await propose.execute({ needKey: "receipt-normalizer/v1" }, world.ctx)).isError).toBe(true);
  expect(await world.service.list(world.ctx)).toEqual([]);
});

test("fresh-session pure tool pins the binding and cached discovery cannot survive revocation", async () => {
  const { world, source } = await ready();
  const staged = await world.stage();
  const active = await world.activate(staged);
  expect(await world.lifecycle.runCanary({ ...world.ctx, toolUseId: "tools-canary" }, active.binding.id)).toMatchObject(
    { outcome: "PASS" },
  );
  const fresh = await world.session();
  const name = foundryToolName(staged.candidateId, staged.digest);
  const pure = named(await source.tools(fresh), name);
  expect(pure.scope).toBe("sandbox:run");
  expect(pure.external).toBe(true);
  expect(pure.description).not.toContain("INERT");
  expect(await pure.checkCall?.(FRESH_INPUT, fresh)).toMatchObject({ ok: true });
  const result = await pure.execute(FRESH_INPUT, { ...fresh, toolUseId: "tools-fresh-use" });
  expect(JSON.parse(result.content)).toMatchObject({ outcome: "SUCCEEDED", output: FRESH_OUTPUT });
  const executions = world.state.executions.length;
  await world.lifecycle.revoke(fresh, active.binding.id);
  expect(await pure.checkCall?.(FRESH_INPUT, fresh)).toMatchObject({ ok: false });
  expect((await pure.execute(FRESH_INPUT, { ...fresh, toolUseId: "tools-stale-use" })).isError).toBe(true);
  expect(world.state.executions).toHaveLength(executions);
  expect((await sourceOf(world).tools(await world.session())).some((tool) => tool.name === name)).toBe(false);
});

test("the native Gateway invokes the scoped pure version and frames output as external data", async () => {
  const { world, source } = await ready();
  const staged = await world.stage();
  const active = await world.activate(staged);
  expect(
    await world.lifecycle.runCanary({ ...world.ctx, toolUseId: "gateway-canary" }, active.binding.id),
  ).toMatchObject({ outcome: "PASS" });
  const fresh = await world.session();
  const gateway = createToolGateway({ sources: [source] });
  const name = foundryToolName(staged.candidateId, staged.digest);
  expect(name.length).toBeLessThanOrEqual(64);
  const before = world.state.executions.length;
  const result = await gateway.invoke(fresh, { name, input: FRESH_INPUT, toolUseId: "gateway-pure-use" });
  expect(result.type).toBe("result");
  if (result.type !== "result") throw new Error("Native Gateway did not return the scoped pure result.");
  expect(result.output.isError).not.toBe(true);
  expect(result.output.content).toContain("<external_data");
  expect(result.output.content).toContain('"tokens":10');
  expect(world.state.executions).toHaveLength(before + 1);
});

test("a fresh recovery request can revoke while drafting and pure invocation stay inapplicable", async () => {
  const { world, source } = await ready();
  const staged = await world.stage();
  const active = await world.activate(staged);
  const recovery = await world.session("Revoke receipt normalizer");
  const tools = await source.tools(recovery);
  expect(tools.map((tool) => tool.name).sort()).toEqual(managementNames.slice(2).sort());
  const revoke = named(tools, "revoke_foundry_capability");
  expect(await revoke.checkCall?.({ bindingId: active.binding.id }, recovery)).toMatchObject({ ok: true });
  expect((await revoke.execute({ bindingId: active.binding.id }, recovery)).isError).not.toBe(true);
  const [binding] = await f.db
    .select()
    .from(schema.foundryBindings)
    .where(eq(schema.foundryBindings.id, active.binding.id));
  expect(binding?.state).toBe("REVOKED");
});

test("a pending model tool name cannot silently invoke a replacement version after Gateway refresh", async () => {
  const { world, source } = await ready();
  const first = await world.stage("1.0.0");
  const activeFirst = await world.activate(first);
  expect(
    await world.lifecycle.runCanary({ ...world.ctx, toolUseId: "gateway-first-canary" }, activeFirst.binding.id),
  ).toMatchObject({ outcome: "PASS" });
  const fresh = await world.session();
  const gateway = createToolGateway({ sources: [source] });
  const oldName = foundryToolName(first.candidateId, first.digest);
  expect((await gateway.granted(fresh)).some((tool) => tool.name === oldName)).toBe(true);

  const second = await world.stage("1.0.1");
  const activeSecond = await world.activate(second);
  expect(
    await world.lifecycle.runCanary({ ...world.ctx, toolUseId: "gateway-second-canary" }, activeSecond.binding.id),
  ).toMatchObject({ outcome: "PASS" });
  const before = world.state.executions.length;
  const result = await gateway.invoke(fresh, {
    name: oldName,
    input: FRESH_INPUT,
    toolUseId: "gateway-delayed-old-name",
  });
  expect(world.state.executions).toHaveLength(before);
  expect(result.type).toBe("result");
  if (result.type !== "result") throw new Error("Old version name must produce a native refusal.");
  expect(result.output.isError).toBe(true);
  const newName = foundryToolName(second.candidateId, second.digest);
  expect(newName).not.toBe(oldName);
  expect((await gateway.granted(fresh)).some((tool) => tool.name === newName)).toBe(true);
});

test("native approval decision and Gateway resume create the exact CANARY binding only once", async () => {
  const { world, source } = await ready();
  // The native Gateway's approval expiry uses the real clock. Only the external
  // executor/evaluator adapters are simulated; no approval row is fabricated.
  world.state.now = new Date();
  const staged = await world.stage();
  expect(
    await world.lifecycle.evaluate(world.ctx, {
      candidateId: staged.candidateId,
      digest: staged.digest,
    }),
  ).toMatchObject({ state: "REVIEW_READY" });
  const params = await world.lifecycle.activationParameters(world.ctx, {
    candidateId: staged.candidateId,
    digest: staged.digest,
    maxCalls: 2,
    validUntil: new Date(world.state.now.getTime() + 60_000).toISOString(),
  });
  const gateway = createToolGateway({ sources: [source] });
  const requested = await gateway.invoke(world.ctx, {
    toolUseId: "native-foundry-activation-approval",
    name: FOUNDRY_ACTIVATE_TOOL,
    input: {
      ...params,
      why: "Approve exactly this evaluated synthetic receipt version for this task and its bounded canary.",
    },
  });
  expect(requested.type).toBe("approval");
  if (requested.type !== "approval") throw new Error("The native Gateway must request an activation approval.");
  expect(requested.approval).toMatchObject({
    status: "pending",
    tool: FOUNDRY_ACTIVATE_TOOL,
    scope: "sandbox:run",
    params,
  });
  expect(requested.approval.params).toEqual(params);
  const bindingsForApproval = () =>
    f.db
      .select()
      .from(schema.foundryBindings)
      .where(
        and(eq(schema.foundryBindings.orgId, f.org.id), eq(schema.foundryBindings.approvalId, requested.approval.id)),
      );
  expect(await bindingsForApproval()).toHaveLength(0);
  expect(world.state.executions).toHaveLength(0);

  await decideApproval(
    {
      db: f.db,
      pubsub: f.pubsub,
      now: () => new Date(world.state.now.getTime()),
    },
    f.owner.id,
    f.org.id,
    requested.approval.id,
    { decision: "approve" },
  );
  const [approved] = await f.db
    .select()
    .from(schema.approvals)
    .where(and(eq(schema.approvals.orgId, f.org.id), eq(schema.approvals.id, requested.approval.id)));
  if (!approved) throw new Error("Native approval decision was not persisted.");
  expect(approved.status).toBe("approved");
  expect(approved.decidedByUserId).toBe(f.owner.id);
  expect(approved.executedAt).toBeNull();
  // Even a genuine decision plus a forged approved flag lacks the Gateway's
  // execution claim. Positive activation below only uses executeApproved.
  await expect(
    world.lifecycle.activate(
      {
        ...world.ctx,
        approved: true,
        toolUseId: approved.toolUseId,
      },
      params,
    ),
  ).rejects.toMatchObject({ code: "NEEDS_APPROVAL" });
  expect(await bindingsForApproval()).toHaveLength(0);

  const result = await gateway.executeApproved(world.ctx, approved);
  expect(result.isError).not.toBe(true);
  expect(JSON.parse(result.content)).toMatchObject({ state: "CANARY", approvalId: approved.id });
  const rows = await bindingsForApproval();
  expect(rows).toHaveLength(1);
  const binding = rows[0]!;
  expect(binding).toMatchObject({
    orgId: f.org.id,
    taskId: world.task.id,
    agentId: f.agent.id,
    personId: f.owner.id,
    candidateId: staged.candidateId,
    versionId: staged.version.id,
    approvalId: approved.id,
    approvalHash: approved.actionHash,
    state: "CANARY",
    maxCalls: params.maxCalls,
    reservedCalls: 0,
  });
  expect(binding.expiresAt.toISOString()).toBe(params.validUntil);
  const [executed] = await f.db.select().from(schema.approvals).where(eq(schema.approvals.id, approved.id));
  expect(executed?.executedAt).not.toBeNull();
  const [candidate] = await f.db
    .select()
    .from(schema.foundryCandidates)
    .where(eq(schema.foundryCandidates.id, staged.candidateId));
  expect(candidate).toMatchObject({ state: "CANARY", revision: params.candidateRevision + 1 });
  expect(await world.lifecycle.discover(world.ctx)).toEqual([]);
  expect(world.state.executions).toHaveLength(0);

  // Retry with the same pre-execution snapshot: native claim/replay must reload
  // durable state and return its saved result without another activation.
  const replay = await gateway.executeApproved(world.ctx, approved);
  expect(replay.isError).not.toBe(true);
  expect(replay.content).toBe(result.content);
  expect(await bindingsForApproval()).toHaveLength(1);
  const [afterReplay] = await f.db
    .select()
    .from(schema.foundryCandidates)
    .where(eq(schema.foundryCandidates.id, staged.candidateId));
  expect(afterReplay?.revision).toBe(candidate?.revision);
  expect(world.state.executions).toHaveLength(0);
});
