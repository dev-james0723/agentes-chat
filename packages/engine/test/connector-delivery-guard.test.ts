import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  checkConnectorDelivery,
  createDeliveryApprovalHandoff,
  createNativeDeliveryGuard,
  type DeliveryRequest,
  type NativeDeliveryProof,
  runConnectorDelivery,
} from "../src/connectors/delivery-guard";
import type { ToolContext } from "../src/tools/types";

const approvalHash = (input: ReturnType<typeof call>["input"]) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        connectionId: "connection-1",
        params: { owner: input.owner, pullNumber: input.pullNumber, repo: input.repo, sha: input.sha },
        scope: "github:pr.merge",
        tool: "github_merge_pull_request",
      }),
    )
    .digest("hex");

function handoff(c = call()) {
  const held = createDeliveryApprovalHandoff(
    c.ctx,
    {
      name: "github_merge_pull_request",
      scope: "github:pr.merge",
      connectionId: c.connectionId,
      connector: { key: "github", via: "mcp", tool: c.tool },
    },
    {
      id: "approval-1",
      orgId: c.ctx.orgId,
      agentId: c.ctx.agentId,
      runId: c.ctx.runId,
      toolUseId: c.ctx.toolUseId ?? "",
      tool: "github_merge_pull_request",
      scope: "github:pr.merge",
      connectionId: c.connectionId,
      params: c.input,
      actionHash: approvalHash(c.input),
    },
  );
  assert.ok(held);
  return held;
}

const head = "a".repeat(40);
const now = 1_800_000_000_000;
function call() {
  return {
    tool: "merge_pull_request",
    scope: "pr.merge",
    connectionId: "connection-1",
    input: { owner: "example", repo: "app", pullNumber: 21, sha: head },
    inputSchema: { type: "object", properties: { sha: { type: "string" } } },
    ctx: {
      orgId: "org-1",
      agentId: "publisher-1",
      runId: "run-1",
      channelId: "channel-1",
      threadRootId: "thread-1",
      triggerMessageId: "message-1",
      toolUseId: "call-1",
      db: {},
    } as ToolContext,
  };
}
function proof(request: DeliveryRequest): Extract<NativeDeliveryProof, { decision: "eligible" }> {
  return {
    decision: "eligible",
    requestKey: request.requestKey,
    orgId: request.ctx.orgId,
    agentId: request.ctx.agentId,
    runId: request.ctx.runId,
    connectionId: request.connectionId,
    taskId: "task-1",
    operationId: "operation-1",
    repositoryId: "12345",
    repository: "example/app",
    sourceHead: head,
    targetId: "target-1",
    authorityRef: "native-authority-1",
    leaseRef: "native-lease-1",
    fencingToken: "17",
    policyVersion: "delivery-policy-1",
    evidenceIds: ["native-check-1", "native-review-1"],
    observedAt: now,
    expiresAt: now + 10_000,
  };
}
const guard = (verify: (request: DeliveryRequest) => Promise<NativeDeliveryProof> = async (r) => proof(r)) =>
  createNativeDeliveryGuard({ verify, now: () => now });

function readiness(request: DeliveryRequest) {
  const p = proof(request);
  return {
    decision: "ready" as const,
    requestKey: p.requestKey,
    orgId: p.orgId,
    agentId: p.agentId,
    runId: p.runId,
    connectionId: p.connectionId,
    taskId: p.taskId,
    repositoryId: p.repositoryId,
    repository: p.repository,
    sourceHead: p.sourceHead,
    targetId: p.targetId,
    policyVersion: p.policyVersion,
    evidenceIds: p.evidenceIds,
    observedAt: p.observedAt,
    expiresAt: p.expiresAt,
  };
}

test("readiness permits preflight without claiming an operation, authority or lease", async () => {
  const result = await checkConnectorDelivery(
    guard(async (r) => readiness(r)),
    call(),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.data?.deliveryGuardian, {
    status: "ready_for_approval",
    phase: "preflight",
    taskId: "task-1",
    targetId: "target-1",
    repositoryId: "12345",
    sourceHead: head,
    policyVersion: "delivery-policy-1",
    evidenceIds: ["native-check-1", "native-review-1"],
    isAuthorizationGrant: false,
  });
});

test("readiness alone never executes even with caller approved flags", async () => {
  const c = call();
  c.ctx.approved = true;
  let calls = 0;
  const result = await runConnectorDelivery(
    guard(async (r) => readiness(r)),
    c,
    async () => ++calls,
  );
  assert.equal(result.ok, false);
  assert.equal(calls, 0);
  assert.ok(JSON.stringify(result.data).includes("native_execution_proof_required"));
});

for (const [name, change] of Object.entries({
  "wrong subject": { agentId: "foreign" },
  "wrong head": { sourceHead: "b".repeat(40) },
  "missing target": { targetId: "" },
  "missing policy": { policyVersion: "" },
  "missing evidence": { evidenceIds: [] },
  "expired observation": { expiresAt: now },
})) {
  test(`readiness with ${name} cannot open an approval`, async () => {
    const result = await checkConnectorDelivery(
      guard(async (r) => ({ ...readiness(r), ...change })),
      call(),
    );
    assert.equal(result.ok, false);
  });
}

test("opaque approval handoff exposes a host reference, retires checking and permits one dispatch", async () => {
  const c = call();
  const h = handoff(c);
  c.ctx.deliveryApproval = h.checking;
  const seen: DeliveryRequest[] = [];
  const g = guard(async (r) => {
    seen.push(r);
    return proof(r);
  });
  assert.equal((await checkConnectorDelivery(g, c)).ok, true);
  assert.deepEqual(seen[0]?.approval, {
    id: "approval-1",
    tool: "github_merge_pull_request",
    scope: "github:pr.merge",
    actionHash: approvalHash(c.input),
    stage: "checking",
    executedAt: null,
  });
  const checking = h.checking;
  const claimed = h.claim(new Date(now));
  assert.equal((await checkConnectorDelivery(g, c)).ok, false);
  c.ctx.deliveryApproval = claimed;
  let calls = 0;
  assert.equal((await runConnectorDelivery(g, c, async () => ++calls)).ok, true);
  assert.equal((await runConnectorDelivery(g, c, async () => ++calls)).ok, false);
  assert.equal(calls, 1);
  assert.notEqual(checking, claimed);
  assert.deepEqual(Object.keys(claimed), []);
  assert.equal(Object.isFrozen(claimed), true);
  h.close();
  assert.equal((await checkConnectorDelivery(g, c)).ok, false);
});

test("a checking reference and a retired reference cannot execute even with an eligible host proof", async () => {
  const c = call();
  const h = handoff(c);
  c.ctx.deliveryApproval = h.checking;
  let calls = 0;
  assert.equal((await runConnectorDelivery(guard(), c, async () => ++calls)).ok, false);
  const claimed = h.claim(new Date(now));
  h.close();
  c.ctx.deliveryApproval = claimed;
  assert.equal((await runConnectorDelivery(guard(), c, async () => ++calls)).ok, false);
  assert.equal(calls, 0);
});

test("serialized or look-alike approval locators are refused before the host verifier", async () => {
  const c = call();
  const h = handoff(c);
  let verifies = 0;
  const g = guard(async (r) => {
    verifies++;
    return proof(r);
  });
  for (const fake of [{ id: "approval-1", stage: "claimed" }, JSON.parse(JSON.stringify(h.checking))]) {
    c.ctx.deliveryApproval = fake as never;
    assert.equal((await checkConnectorDelivery(g, c)).ok, false);
  }
  assert.equal(verifies, 0);
  h.close();
});

test("caller-authored approval properties never become a native request reference", async () => {
  const c = Object.assign(call(), {
    approval: { id: "forged", stage: "claimed", executedAt: new Date(now).toISOString() },
  });
  const result = await checkConnectorDelivery(
    guard(async (request) => {
      assert.equal(request.approval, undefined);
      return readiness(request);
    }),
    c,
  );
  assert.equal(result.ok, true);
});

for (const key of [
  "orgId",
  "agentId",
  "runId",
  "toolUseId",
  "channelId",
  "threadRootId",
  "triggerMessageId",
] as const) {
  test(`approval locator cannot move to another ${key}`, async () => {
    const c = call();
    const h = handoff(c);
    c.ctx.deliveryApproval = h.claim(new Date(now));
    c.ctx[key] = "foreign";
    let calls = 0;
    assert.equal((await runConnectorDelivery(guard(), c, async () => ++calls)).ok, false);
    assert.equal(calls, 0);
    h.close();
  });
}

for (const field of ["input", "connection", "tool", "scope", "db", "bridge"] as const) {
  test(`approval locator refuses changed ${field} before provider dispatch`, async () => {
    const c = call();
    const h = handoff(c);
    c.ctx.deliveryApproval = h.claim(new Date(now));
    if (field === "input") c.input.sha = "b".repeat(40);
    if (field === "connection") c.connectionId = "foreign";
    if (field === "tool") c.tool = "foreign";
    if (field === "scope") c.scope = "foreign";
    if (field === "db") c.ctx.db = {} as ToolContext["db"];
    if (field === "bridge") c.ctx.bridge = { machineId: "foreign" };
    let calls = 0;
    assert.equal((await runConnectorDelivery(guard(), c, async () => ++calls)).ok, false);
    assert.equal(calls, 0);
    h.close();
  });
}

test("missing native adapter blocks preflight and direct execute without touching provider", async () => {
  const c = call();
  assert.equal((await checkConnectorDelivery(undefined, c)).ok, false);
  let calls = 0;
  const result = await runConnectorDelivery(undefined, c, async () => {
    calls++;
    return "merged";
  });
  assert.equal(result.ok, false);
  assert.equal(calls, 0);
});

test("caller pass flags and an approved context do not replace a native adapter", async () => {
  const c = call();
  c.ctx.approved = true;
  Object.assign(c.input, { authorized: true, trustedChecks: true, exclusiveLease: true });
  assert.equal((await checkConnectorDelivery(undefined, c)).ok, false);
});

test("plain objects and serialized native adapters cannot grant permission", async () => {
  const fake = { verify: async (r: DeliveryRequest) => proof(r), ok: true };
  for (const value of [fake, JSON.parse(JSON.stringify(guard()))]) {
    let calls = 0;
    const result = await runConnectorDelivery(value as never, call(), async () => ++calls);
    assert.equal(result.ok, false);
    assert.equal(calls, 0);
  }
});

test("native preflight is an assessment and execute obtains another current proof", async () => {
  const phases: string[] = [];
  const g = guard(async (r) => {
    phases.push(r.phase);
    return proof(r);
  });
  const c = call();
  assert.equal((await checkConnectorDelivery(g, c)).ok, true);
  let calls = 0;
  const result = await runConnectorDelivery(g, c, async () => ++calls);
  assert.equal(result.ok, true);
  assert.equal(calls, 1);
  assert.deepEqual(phases, ["preflight", "execute"]);
});

test("revocation after preflight blocks execution without another approval overriding it", async () => {
  const g = guard(async (r) =>
    r.phase === "execute" ? { decision: "blocked", reasonCodes: ["authority_revoked"] } : proof(r),
  );
  const c = call();
  assert.equal((await checkConnectorDelivery(g, c)).ok, true);
  c.ctx.approved = true;
  let calls = 0;
  const result = await runConnectorDelivery(g, c, async () => ++calls);
  assert.equal(result.ok, false);
  assert.equal(calls, 0);
});

for (const [name, change] of Object.entries({
  "wrong organization": { orgId: "foreign" },
  "wrong actor": { agentId: "foreign" },
  "wrong run": { runId: "foreign" },
  "changed connection": { connectionId: "foreign" },
  "wrong action": { requestKey: "forged" },
  "wrong repository": { repository: "example/foreign" },
  "wrong head": { sourceHead: "b".repeat(40) },
  "missing immutable repository": { repositoryId: "" },
  "missing target": { targetId: "" },
  "missing task": { taskId: "" },
  "missing operation": { operationId: "" },
  "missing authority": { authorityRef: "" },
  "missing lease": { leaseRef: "" },
  "missing fencing": { fencingToken: "" },
  "missing evidence": { evidenceIds: [] },
  "stale observation": { observedAt: now - 10_001 },
  "future observation": { observedAt: now + 1 },
  "expired proof": { expiresAt: now },
  "unbounded expiry": { expiresAt: now + 10_001 },
})) {
  test(`${name} blocks the provider`, async () => {
    const g = guard(async (r) => ({ ...proof(r), ...change }) as NativeDeliveryProof);
    let calls = 0;
    assert.equal((await runConnectorDelivery(g, call(), async () => ++calls)).ok, false);
    assert.equal(calls, 0);
  });
}

test("the provider must explicitly expose the expected-head precondition", async () => {
  const c = call();
  c.inputSchema = { type: "object", properties: {} } as typeof c.inputSchema;
  let calls = 0;
  assert.equal((await runConnectorDelivery(guard(), c, async () => ++calls)).ok, false);
  assert.equal(calls, 0);
});

test("workflow dispatch remains blocked until a real target precondition adapter exists", async () => {
  const c = { ...call(), tool: "actions_run_trigger", scope: "actions.run" };
  let calls = 0;
  assert.equal((await runConnectorDelivery(guard(), c, async () => ++calls)).ok, false);
  assert.equal(calls, 0);
});

test("headless merge input is not silently filled with a later head", async () => {
  const c = call();
  delete (c.input as Record<string, unknown>).sha;
  assert.equal((await checkConnectorDelivery(guard(), c)).ok, false);
});

test("mutating caller input while native verification awaits is refused", async () => {
  const c = call();
  const g = guard(async (r) => {
    c.input.sha = "b".repeat(40);
    return proof(r);
  });
  let calls = 0;
  assert.equal((await runConnectorDelivery(g, c, async () => ++calls)).ok, false);
  assert.equal(calls, 0);
});

test("actual signed wire arguments may not silently change the expected head", async () => {
  const c = { ...call(), wireInput: { ...call().input, sha: "b".repeat(40) } };
  let calls = 0;
  assert.equal((await runConnectorDelivery(guard(), c, async () => ++calls)).ok, false);
  assert.equal(calls, 0);
});

test("abort during native verification is checked before the provider mutation", async () => {
  const ac = new AbortController();
  const c = call();
  c.ctx.signal = ac.signal;
  const g = guard(async (r) => {
    ac.abort();
    return proof(r);
  });
  let calls = 0;
  assert.equal((await runConnectorDelivery(g, c, async () => ++calls)).ok, false);
  assert.equal(calls, 0);
});

test("native verifier errors do not expose raw private material", async () => {
  const g = guard(async () => {
    throw new Error("private-secret-and-path");
  });
  const r = await checkConnectorDelivery(g, call());
  assert.equal(r.ok, false);
  assert.ok(!JSON.stringify(r).includes("private-secret-and-path"));
});

test("a provider timeout is an unknown outcome and is never retried by the boundary", async () => {
  let calls = 0;
  const r = await runConnectorDelivery(guard(), call(), async () => {
    calls++;
    throw new Error("private-transport");
  });
  assert.equal(r.ok, false);
  assert.equal(calls, 1);
  assert.ok(JSON.stringify(r).includes("outcome_unknown"));
  assert.ok(!JSON.stringify(r).includes("private-transport"));
});

test("a provider error reply is also an unknown outcome, never eligible success", async () => {
  let calls = 0;
  const r = await runConnectorDelivery(guard(), call(), async () => {
    calls++;
    return { content: "timeout", isError: true };
  });
  assert.equal(r.ok, false);
  assert.equal(calls, 1);
  assert.ok(JSON.stringify(r).includes("outcome_unknown"));
});

test("a successful provider reply stays unverified without native readback", async () => {
  const r = await runConnectorDelivery(guard(), call(), async () => ({ content: "merged", isError: false }));
  assert.equal(r.ok, true);
  assert.ok(JSON.stringify(r.data).includes("submitted_unverified"));
  assert.ok(!JSON.stringify(r.data).includes('"status":"eligible"'));
});

test("a hung verifier is bounded and cannot send the mutation after its deadline", async () => {
  const g = createNativeDeliveryGuard({ verify: async () => new Promise(() => {}), verificationTimeoutMs: 5 });
  let calls = 0;
  const r = await runConnectorDelivery(g, call(), async () => ++calls);
  assert.equal(r.ok, false);
  assert.equal(calls, 0);
  assert.ok(JSON.stringify(r).includes("native_verification_timeout"));
});

test("an abort stops waiting for a hung verifier and leaves the provider untouched", async () => {
  const ac = new AbortController();
  const c = call();
  c.ctx.signal = ac.signal;
  const g = createNativeDeliveryGuard({ verify: async () => new Promise(() => {}), verificationTimeoutMs: 100 });
  const timer = setTimeout(() => ac.abort(), 5);
  let calls = 0;
  try {
    const r = await runConnectorDelivery(g, c, async () => ++calls);
    assert.equal(r.ok, false);
    assert.equal(calls, 0);
    assert.ok(JSON.stringify(r).includes("delivery_call_aborted"));
  } finally {
    clearTimeout(timer);
  }
});
