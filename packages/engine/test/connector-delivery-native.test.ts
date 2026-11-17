import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  connectorGrantValidator,
  createApiKeyConnection,
  createConnectorToolSource,
  createToolGateway,
  decideApproval,
  type McpConnect,
  postPersonMessage,
  setAgentScopes,
  type ToolContext,
} from "../src";
import {
  createNativeDeliveryGuard,
  type DeliveryRequest,
  type NativeDeliveryProof,
} from "../src/connectors/delivery-guard";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(() => f?.close());
const head = "a".repeat(40);

async function world(options: { adapter?: boolean; readiness?: boolean; handoff?: boolean } = {}) {
  f = await setup();
  const calls: { tool: string; input: Record<string, unknown> }[] = [];
  const phases: string[] = [];
  const requests: DeliveryRequest[] = [];
  let expectedApprovalId: string | null = null;
  const state = {
    revoked: false,
    failExecute: false,
    schemaChanged: false,
    timeout: false,
    errorReply: false,
    withdrawAfterClaim: false,
  };
  const deps = { db: f.db, keyWrappers: [f.keyWrapper], publicUrl: "https://chat.example.com" };
  const c = await createApiKeyConnection(deps, f.owner.id, f.org.id, {
    connector: "github",
    apiKey: "ghp_secret_123456",
  });
  const connect: McpConnect = async () => ({
    async listTools() {
      const properties = {
        owner: { type: "string" },
        repo: { type: "string" },
        pullNumber: { type: "integer" },
        ...(state.schemaChanged ? {} : { sha: { type: "string" } }),
        commit_message: { type: "string" },
      };
      return [
        {
          name: "merge_pull_request",
          description: "Merge with the expected head",
          inputSchema: { type: "object", properties, required: ["owner", "repo", "pullNumber", "sha"] },
        },
        { name: "pull_request_read", description: "Read PR", inputSchema: { type: "object" } },
        { name: "actions_run_trigger", description: "Workflow action", inputSchema: { type: "object" } },
      ];
    },
    async callTool(tool, input) {
      calls.push({ tool, input });
      if (tool === "merge_pull_request" && input.sha !== head) return { content: "Head mismatch", isError: true };
      if (state.timeout) throw new Error("private-provider-timeout");
      if (state.errorReply) return { content: "Provider timeout; outcome unknown", isError: true };
      return { content: tool === "merge_pull_request" ? "Merged expected PR" : "Read only", isError: false };
    },
    async close() {},
  });
  const verify = async (r: DeliveryRequest): Promise<NativeDeliveryProof> => {
    phases.push(r.phase);
    requests.push(r);
    if (state.revoked || (state.failExecute && r.phase === "execute"))
      return { decision: "blocked", reasonCodes: ["authority_revoked"] };
    if (options.handoff && (expectedApprovalId || r.phase === "execute")) {
      const reference = r.approval;
      if (!reference || reference.id !== expectedApprovalId)
        return { decision: "blocked", reasonCodes: ["native_approval_handoff_missing"] };
      if (state.withdrawAfterClaim && reference.stage === "claimed") {
        state.withdrawAfterClaim = false;
        await f.db.update(schema.approvals).set({ status: "canceled" }).where(eq(schema.approvals.id, reference.id));
      }
      const [row] = await f.db.select().from(schema.approvals).where(eq(schema.approvals.id, reference.id));
      if (
        !row ||
        row.status !== "approved" ||
        row.orgId !== r.ctx.orgId ||
        row.agentId !== r.ctx.agentId ||
        row.runId !== r.ctx.runId ||
        row.toolUseId !== r.ctx.toolUseId ||
        row.tool !== reference.tool ||
        row.scope !== reference.scope ||
        row.actionHash !== reference.actionHash ||
        row.connectionId !== r.connectionId ||
        row.expiresAt.getTime() <= Date.now() ||
        (reference.stage === "checking"
          ? row.executedAt !== null || reference.executedAt !== null
          : row.executedAt?.toISOString() !== reference.executedAt) ||
        (r.phase === "execute" && reference.stage !== "claimed")
      )
        return { decision: "blocked", reasonCodes: ["native_approval_handoff_invalid"] };
    }
    const now = Date.now();
    const ready = {
      decision: "ready" as const,
      requestKey: r.requestKey,
      orgId: r.ctx.orgId,
      agentId: r.ctx.agentId,
      runId: r.ctx.runId,
      connectionId: r.connectionId,
      taskId: "fixture-task",
      repositoryId: "12345",
      repository: "acme/app",
      sourceHead: head,
      targetId: "fixture-target",
      policyVersion: "fixture-policy",
      evidenceIds: ["fixture-provider-check", "fixture-review"],
      observedAt: now,
      expiresAt: now + 10_000,
    };
    if (options.readiness && r.phase === "preflight") return ready;
    return {
      ...ready,
      decision: "eligible",
      operationId: "fixture-operation",
      authorityRef: "fixture-native-authority",
      leaseRef: "fixture-native-lease",
      fencingToken: "17",
    };
  };
  const source = createConnectorToolSource({
    ...deps,
    connect,
    ...(options.adapter === false ? {} : { deliveryGuard: createNativeDeliveryGuard({ verify }) }),
  });
  const gateway = createToolGateway({ sources: [source] });
  await setAgentScopes(
    f.db,
    f.owner.id,
    f.org.id,
    f.agent.id,
    [
      { connectionId: c.id, scope: "github:pr.read" },
      { connectionId: c.id, scope: "github:pr.merge" },
      { connectionId: c.id, scope: "github:actions.run" },
    ],
    connectorGrantValidator,
  );
  const msg = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "delivery fixture",
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
    })
    .returning();
  const ctx: ToolContext = {
    db: f.db,
    orgId: f.org.id,
    agentId: f.agent.id,
    runId: run?.id ?? "",
    channelId: f.general.id,
    threadRootId: msg.id,
    triggerMessageId: msg.id,
  };
  const input = { owner: "acme", repo: "app", pullNumber: 21, sha: head };
  const ask = async (extra: Record<string, unknown> = {}) => {
    const asked = await gateway.invoke(ctx, {
      toolUseId: "merge-fixture",
      name: "github_merge_pull_request",
      input: {
        ...input,
        ...extra,
        why: "The exact candidate has native fixture checks and review; merge finishes the requested fixture.",
      },
    });
    if (asked.type !== "approval") throw new Error(`Expected approval: ${JSON.stringify(asked)}`);
    await decideApproval({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, asked.approval.id, {
      decision: "approve",
    });
    const [approval] = await f.db.select().from(schema.approvals).where(eq(schema.approvals.id, asked.approval.id));
    if (!approval) throw new Error("Missing native approval row");
    expectedApprovalId = approval.id;
    return approval;
  };
  return { source, gateway, ctx, input, calls, phases, requests, state, ask, connectionId: c.id };
}

test("readiness-only host proof reaches the existing native approval without a provider mutation", async () => {
  const w = await world({ readiness: true });
  const result = await w.gateway.invoke(w.ctx, {
    toolUseId: "readiness-fixture",
    name: "github_merge_pull_request",
    input: {
      ...w.input,
      why: "The candidate is ready for the existing native approval; this fixture must not execute a provider mutation.",
    },
  });
  expect(result.type).toBe("approval");
  const rows = await f.db.select().from(schema.approvals);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ status: "pending", executedAt: null, toolUseId: "readiness-fixture" });
  expect(w.calls).toEqual([]);
});

test("approved resume supplies the exact native approval before and after its one-shot claim", async () => {
  const w = await world({ handoff: true });
  const approval = await w.ask();
  const result = await w.gateway.executeApproved(w.ctx, approval);
  expect(result.isError).not.toBe(true);
  expect(w.calls).toHaveLength(1);
  const checking = w.requests.find((request) => request.approval?.stage === "checking");
  const executing = w.requests.find((request) => request.phase === "execute");
  expect(checking?.approval).toMatchObject({ id: approval.id, stage: "checking", executedAt: null });
  const [row] = await f.db.select().from(schema.approvals).where(eq(schema.approvals.id, approval.id));
  expect(executing?.approval).toMatchObject({
    id: approval.id,
    stage: "claimed",
    executedAt: row?.executedAt?.toISOString(),
    tool: approval.tool,
    scope: approval.scope,
    actionHash: approval.actionHash,
  });
  expect(executing?.ctx.deliveryApproval).toBeDefined();
  expect(Object.keys(executing?.ctx.deliveryApproval ?? {})).toEqual([]);
  expect(w.requests.every((request) => request.approval?.id === undefined || request.approval.id === approval.id)).toBe(
    true,
  );
  if (!row) throw new Error("Missing approval result");
  await w.gateway.executeApproved(w.ctx, row);
  expect(w.calls).toHaveLength(1);
});

test("readiness proceeds through the existing decision and executes with a separately verified claimed approval", async () => {
  const w = await world({ readiness: true, handoff: true });
  const approval = await w.ask({ commit_message: "Exact reviewed candidate" });
  const result = await w.gateway.executeApproved(w.ctx, approval);
  expect(result.isError).not.toBe(true);
  expect(result.outcome).toBeUndefined();
  expect(w.calls).toHaveLength(1);
  expect(w.calls[0]?.input.sha).toBe(head);
  expect(w.calls[0]?.input.commit_message).toContain("Co-authored-by:");
  expect(await f.db.select().from(schema.approvals)).toHaveLength(1);
});

for (const refusal of ["withdrawn", "expired"] as const) {
  test(`${refusal} native approval is refused before claiming and preserves the structured delivery reason`, async () => {
    const w = await world({ handoff: true });
    const approval = await w.ask();
    await f.db
      .update(schema.approvals)
      .set(refusal === "withdrawn" ? { status: "canceled" } : { expiresAt: new Date(Date.now() - 1) })
      .where(eq(schema.approvals.id, approval.id));
    const result = await w.gateway.executeApproved(w.ctx, approval);
    expect(result).toMatchObject({
      isError: true,
      data: {
        deliveryGuardian: {
          status: "blocked",
          reasonCodes: ["native_approval_handoff_invalid"],
        },
      },
    });
    expect(w.calls).toEqual([]);
    const [row] = await f.db.select().from(schema.approvals).where(eq(schema.approvals.id, approval.id));
    expect(row?.executedAt).toBeNull();
  });
}

test("post-CAS withdrawal makes no provider call and retains the attempted one-shot claim", async () => {
  const w = await world({ handoff: true });
  const approval = await w.ask();
  w.state.withdrawAfterClaim = true;
  expect(await w.gateway.executeApproved(w.ctx, approval)).toMatchObject({
    isError: true,
    data: { deliveryGuardian: { reasonCodes: ["native_approval_handoff_invalid"] } },
  });
  const [row] = await f.db.select().from(schema.approvals).where(eq(schema.approvals.id, approval.id));
  expect(row?.executedAt).not.toBeNull();
  expect(row?.status).toBe("canceled");
  expect(w.calls).toEqual([]);
  if (!row) throw new Error("Missing claimed refusal");
  await w.gateway.executeApproved(w.ctx, row);
  expect(w.calls).toEqual([]);
});

for (const policy of ["never", "mergeRepos"] as const) {
  test(`${policy} policy is not replaced with a fabricated approval when native execution proof is missing`, async () => {
    const w = await world({ readiness: true, handoff: true });
    await f.db
      .update(schema.agents)
      .set(policy === "never" ? { approvalsLevel: "never" } : { mergeRepos: ["acme/app"] })
      .where(eq(schema.agents.id, f.agent.id));
    const result = await w.gateway.invoke(w.ctx, {
      toolUseId: "automatic-fixture",
      name: "github_merge_pull_request",
      input: {
        ...w.input,
        why: "Existing automatic policy must remain unchanged while native release execution stays denied without proof.",
      },
    });
    expect(result).toMatchObject({ type: "result", output: { isError: true } });
    expect(await f.db.select().from(schema.approvals)).toEqual([]);
    expect(w.calls).toEqual([]);
    expect(w.requests.every((request) => request.approval === undefined)).toBe(true);
  });
}

test("the Gateway retires an invocation locator after recording an unknown provider outcome", async () => {
  const w = await world({ handoff: true });
  const approval = await w.ask();
  w.state.errorReply = true;
  const result = await w.gateway.executeApproved(w.ctx, approval);
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.data)).toContain("outcome_unknown");
  const attempted = w.requests.find((request) => request.phase === "execute");
  if (!attempted) throw new Error("Missing claimed request");
  const tool = (await w.source.tools(w.ctx)).find((candidate) => candidate.name === "github_merge_pull_request");
  if (!tool) throw new Error("Missing merge tool");
  expect(await tool.execute(w.input, attempted.ctx)).toMatchObject({
    isError: true,
    data: { deliveryGuardian: { reasonCodes: ["native_approval_handoff_invalid"] } },
  });
  expect(w.calls).toHaveLength(1);
});

test("missing native adapter refuses merge and workflow through the real Gateway while reads work", async () => {
  const w = await world({ adapter: false });
  for (const name of ["github_merge_pull_request", "github_actions_run_trigger"]) {
    const out = await w.gateway.invoke(w.ctx, {
      toolUseId: name,
      name,
      input: {
        ...w.input,
        authorized: true,
        trustedChecks: true,
        why: "Verify that the native delivery boundary refuses this exact fixture release even when caller flags claim approval.",
      },
    });
    expect(out).toMatchObject({
      type: "result",
      output: {
        isError: true,
        data: {
          deliveryGuardian: {
            status: "blocked",
            reasonCodes: ["native_delivery_adapter_unavailable"],
            isAuthorizationGrant: false,
          },
        },
      },
    });
  }
  expect(w.calls).toEqual([]);
  expect(await f.db.select().from(schema.approvals)).toEqual([]);
  expect(
    await w.gateway.invoke(w.ctx, { toolUseId: "read", name: "github_pull_request_read", input: w.input }),
  ).toMatchObject({ type: "result" });
  expect(w.calls.map((c) => c.tool)).toEqual(["pull_request_read"]);
});

test("approval resumes through current native verification and sends exact head once", async () => {
  const w = await world();
  const approval = await w.ask({ commit_message: "Fixture delivery" });
  const result = await w.gateway.executeApproved(w.ctx, approval);
  expect(result.isError).not.toBe(true);
  expect(result.outcome).toBeUndefined();
  expect(JSON.stringify(result.data)).toContain("submitted_unverified");
  expect(w.calls).toHaveLength(1);
  expect(w.calls[0]?.input.sha).toBe(head);
  expect(w.calls[0]?.input.commit_message).toContain("Co-authored-by:");
  expect(w.phases.filter((p) => p === "preflight").length).toBeGreaterThanOrEqual(2);
  expect(w.phases.at(-1)).toBe("execute");
  const [row] = await f.db.select().from(schema.approvals).where(eq(schema.approvals.id, approval.id));
  expect(row?.executedAt).not.toBeNull();
  if (!row) throw new Error("Missing approval result");
  await w.gateway.executeApproved(w.ctx, row);
  expect(w.calls).toHaveLength(1);
});

test("revoked native authority after approval prevents the provider call", async () => {
  const w = await world();
  const approval = await w.ask();
  w.state.revoked = true;
  expect((await w.gateway.executeApproved(w.ctx, approval)).isError).toBe(true);
  expect(w.calls).toEqual([]);
  const [row] = await f.db.select().from(schema.approvals).where(eq(schema.approvals.id, approval.id));
  expect(row?.executedAt).toBeNull();
});

test("fresh scope revocation remains a Gateway refusal even with a valid host verifier", async () => {
  const w = await world();
  const approval = await w.ask();
  await setAgentScopes(
    f.db,
    f.owner.id,
    f.org.id,
    f.agent.id,
    [{ connectionId: w.connectionId, scope: "github:pr.read" }],
    connectorGrantValidator,
  );
  expect((await w.gateway.executeApproved(w.ctx, approval)).isError).toBe(true);
  expect(w.calls).toEqual([]);
});

test("direct ToolDefinition execution still checks immediately before provider mutation", async () => {
  const w = await world();
  const merge = (await w.source.tools(w.ctx)).find((t) => t.name === "github_merge_pull_request");
  if (!merge) throw new Error("Missing merge tool");
  w.state.failExecute = true;
  expect((await merge.execute(w.input, { ...w.ctx, approved: true })).isError).toBe(true);
  expect(w.phases).toEqual(["preflight", "execute"]);
  expect(w.calls).toEqual([]);
});

test("a provider schema change after listing prevents the actual mutation", async () => {
  const w = await world();
  const merge = (await w.source.tools(w.ctx)).find((t) => t.name === "github_merge_pull_request");
  if (!merge) throw new Error("Missing merge tool");
  w.state.schemaChanged = true;
  const result = await merge.execute(w.input, w.ctx);
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.data)).toContain("delivery_tool_changed");
  expect(w.calls).toEqual([]);
});

test("an uncertain provider result is recorded once, without an automatic retry", async () => {
  const w = await world();
  const approval = await w.ask();
  w.state.timeout = true;
  const result = await w.gateway.executeApproved(w.ctx, approval);
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.data)).toContain("outcome_unknown");
  expect(w.calls).toHaveLength(1);
  const [row] = await f.db.select().from(schema.approvals).where(eq(schema.approvals.id, approval.id));
  if (!row) throw new Error("Missing approval result");
  await w.gateway.executeApproved(w.ctx, row);
  expect(w.calls).toHaveLength(1);
});

test("a provider error reply preserves unknown outcome and never emits pr_merged", async () => {
  const w = await world();
  const approval = await w.ask();
  w.state.errorReply = true;
  const result = await w.gateway.executeApproved(w.ctx, approval);
  expect(result.isError).toBe(true);
  expect(result.outcome).toBeUndefined();
  expect(JSON.stringify(result.data)).toContain("outcome_unknown");
  expect(w.calls).toHaveLength(1);
});

test("approved native revocation preserves structured reason without consuming approval", async () => {
  const w = await world();
  const approval = await w.ask();
  w.state.revoked = true;
  const result = await w.gateway.executeApproved(w.ctx, approval);
  expect(result).toMatchObject({
    isError: true,
    data: {
      deliveryGuardian: {
        status: "blocked",
        phase: "preflight",
        reasonCodes: ["authority_revoked"],
        isAuthorizationGrant: false,
      },
    },
  });
  expect(w.calls).toEqual([]);
  const [row] = await f.db.select().from(schema.approvals).where(eq(schema.approvals.id, approval.id));
  expect(row?.status).toBe("approved");
  expect(row?.executedAt).toBeNull();
});
