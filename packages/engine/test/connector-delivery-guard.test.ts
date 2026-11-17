import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkConnectorDelivery,
  createNativeDeliveryGuard,
  type DeliveryRequest,
  type NativeDeliveryProof,
  runConnectorDelivery,
} from "../src/connectors/delivery-guard";
import type { ToolContext } from "../src/tools/types";

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
function proof(request: DeliveryRequest): NativeDeliveryProof {
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
