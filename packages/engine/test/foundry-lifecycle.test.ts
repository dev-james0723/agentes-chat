// Pending revised contract and regression suite; status updated in the execution log.
import { afterEach, describe, expect, test } from "bun:test";
import { type FoundryExecutionResult, hashFoundryInput } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import { FOUNDRY_ACTIVATE_TOOL } from "../src/foundry/lifecycle";
import { FoundryError } from "../src/foundry/service";
import { actionHash } from "../src/tools/gateway";
import { type Fixture, setup } from "./fixtures";
import {
  createLifecycleWorld,
  FRESH_INPUT,
  FRESH_OUTPUT,
  type LifecycleWorld,
  TEST_NOW,
} from "./foundry-lifecycle.fixture";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

async function ready() {
  f = await setup();
  return createLifecycleWorld(f);
}
async function active(w: LifecycleWorld, maxCalls = 10) {
  const staged = await w.stage();
  const activated = await w.activate(staged, maxCalls);
  const result = await w.lifecycle.runCanary({ ...w.ctx, toolUseId: "canary-a" }, activated.binding.id);
  expect(result).toMatchObject({ outcome: "PASS" });
  return { staged, ...activated };
}
async function binding(id: string) {
  return (await f.db.select().from(schema.foundryBindings).where(eq(schema.foundryBindings.id, id)))[0]!;
}
async function invocations(bindingId: string) {
  return f.db
    .select()
    .from(schema.foundryInvocations)
    .where(and(eq(schema.foundryInvocations.orgId, f.org.id), eq(schema.foundryInvocations.bindingId, bindingId)));
}

describe("native Foundry lifecycle with PGlite and SIMULATED external adapters", () => {
  test("default unavailable executor blocks evaluation with zero executable dispatch", async () => {
    const w = await ready();
    const staged = await w.stage();
    const unavailable = w.makeLifecycle({ unavailable: true });
    expect(await unavailable.evaluate(w.ctx, { candidateId: staged.candidateId, digest: staged.digest })).toMatchObject(
      { code: "BLOCKED_SANDBOX" },
    );
    expect(w.state.executions).toHaveLength(0);
    expect(w.state.evaluations).toBe(0);
    expect(await unavailable.discover(w.ctx)).toEqual([]);
    expect(await f.db.select().from(schema.foundryBindings)).toHaveLength(0);
  });

  test.each(["missing", "builder-readable", "expired"] as const)(
    "a simulated evaluator PASS is insufficient when independent evidence is %s",
    async (condition) => {
      const w = await ready();
      const staged = await w.stage();
      const key = `${f.org.id}:simulation-evaluation/${staged.digest}`;
      const evidence = w.state.evidence.get(key)!;
      if (condition === "missing") w.state.evidence.delete(key);
      if (condition === "builder-readable") Object.assign(evidence, { builderReadable: true });
      if (condition === "expired") evidence.expiresAt = new Date(TEST_NOW.getTime() - 1).toISOString();
      const result = await w.lifecycle.evaluate(w.ctx, { candidateId: staged.candidateId, digest: staged.digest });
      expect(result.state).not.toBe("REVIEW_READY");
      expect(w.state.executions).toHaveLength(0);
      expect(await w.lifecycle.discover(w.ctx)).toEqual([]);
      expect(await f.db.select().from(schema.foundryBindings)).toHaveLength(0);
    },
  );

  test("a forged ctx.approved flag without an exact native approval never activates", async () => {
    const w = await ready();
    const staged = await w.stage();
    const prepared = await w.prepare(staged);
    await expect(w.lifecycle.activate(prepared.ctx, prepared.params)).rejects.toBeInstanceOf(FoundryError);
    expect(await f.db.select().from(schema.foundryBindings)).toHaveLength(0);
    expect(w.state.executions).toHaveLength(0);
  });

  test("current native approval status, expiry, scope, hash and exact params are rechecked", async () => {
    const w = await ready();
    const staged = await w.stage();
    const prepared = await w.prepare(staged);
    const approved = await w.approval(prepared.ctx, prepared.params);
    const valid = {
      status: approved.status,
      expiresAt: approved.expiresAt,
      scope: approved.scope,
      actionHash: approved.actionHash,
      params: approved.params,
    };
    const wrongParams = { ...prepared.params, maxCalls: prepared.params.maxCalls + 1 };
    const mutations = [
      { status: "canceled" as const },
      { status: "pending" as const },
      { expiresAt: new Date(TEST_NOW.getTime() - 1) },
      { actionHash: "0".repeat(64) },
      { params: wrongParams },
      {
        scope: "skills:read",
        actionHash: actionHash({
          tool: FOUNDRY_ACTIVATE_TOOL,
          scope: "skills:read",
          connectionId: null,
          params: { ...prepared.params },
        }),
      },
    ];
    for (const mutation of mutations) {
      await f.db
        .update(schema.approvals)
        .set({ ...valid, ...mutation })
        .where(eq(schema.approvals.id, approved.id));
      await expect(w.lifecycle.activate(prepared.ctx, prepared.params)).rejects.toBeInstanceOf(FoundryError);
      expect(await f.db.select().from(schema.foundryBindings)).toHaveLength(0);
    }
    expect(w.state.executions).toHaveLength(0);
  });

  test("an approved DB row without the native Gateway handoff flag does not activate", async () => {
    const w = await ready();
    const staged = await w.stage();
    const prepared = await w.prepare(staged);
    await w.approval(prepared.ctx, prepared.params);
    await expect(w.lifecycle.activate({ ...prepared.ctx, approved: false }, prepared.params)).rejects.toBeInstanceOf(
      FoundryError,
    );
    expect(await f.db.select().from(schema.foundryBindings)).toHaveLength(0);
  });

  test("exact consumed native approval activates one canary, then a fresh service and native session reuse it", async () => {
    const w = await ready();
    const staged = await w.stage();
    expect(await w.lifecycle.evaluate(w.ctx, { candidateId: staged.candidateId, digest: staged.digest })).toMatchObject(
      { state: "REVIEW_READY" },
    );
    const activated = await w.activate(staged);
    expect(activated.approved.executedAt).not.toBeNull();
    expect(await binding(activated.binding.id)).toMatchObject({
      state: "CANARY",
      taskId: w.task.id,
      agentId: f.agent.id,
      personId: f.owner.id,
    });
    expect(await w.lifecycle.discover(w.ctx)).toEqual([]);
    expect(await w.lifecycle.runCanary({ ...w.ctx, toolUseId: "canary-a" }, activated.binding.id)).toMatchObject({
      outcome: "PASS",
      restoredBindingId: null,
    });
    const freshCtx = await w.session();
    expect(freshCtx.runId).not.toBe(w.ctx.runId);
    const freshService = w.makeLifecycle();
    expect((await freshService.discover(freshCtx)).map(({ bindingId, digest }) => ({ bindingId, digest }))).toEqual([
      { bindingId: activated.binding.id, digest: staged.digest },
    ]);
    expect(
      await freshService.execute(
        { ...freshCtx, toolUseId: "fresh-reuse" },
        {
          bindingId: activated.binding.id,
          digest: staged.digest,
          input: FRESH_INPUT,
        },
      ),
    ).toMatchObject({ outcome: "SUCCEEDED", output: FRESH_OUTPUT });
    expect(w.state.executions).toHaveLength(2);
    expect((await binding(activated.binding.id)).reservedCalls).toBe(2);
    expect((await invocations(activated.binding.id)).map((row) => row.state)).toEqual(["SUCCEEDED", "SUCCEEDED"]);
  });

  test("expense explanations and a different native task do not discover the active capability", async () => {
    const w = await ready();
    await active(w);
    const unrelated = await w.session("Explain expense receipts");
    expect(await w.makeLifecycle().discover(unrelated)).toEqual([]);
    const [otherTask] = await f.db
      .insert(schema.issues)
      .values({
        orgId: f.org.id,
        number: 9102,
        title: "Normalize synthetic task receipts",
        createdByType: "person",
        createdById: f.owner.id,
        assigneeType: "agent",
        assigneeId: f.agent.id,
        restricted: true,
        audienceUserIds: [f.owner.id],
      })
      .returning();
    const other = await w.session("Normalize synthetic task receipts", otherTask!.id);
    expect(await w.makeLifecycle().discover(other)).toEqual([]);
    expect(w.state.executions).toHaveLength(1);
  });

  test("revocation blocks a cached binding without consuming a second call or dispatching", async () => {
    const w = await ready();
    const a = await active(w);
    const cached = (await w.lifecycle.discover(w.ctx))[0]!;
    await w.lifecycle.revoke({ ...w.ctx, toolUseId: "revoke-a" }, a.binding.id);
    expect(await w.makeLifecycle().discover(await w.session())).toEqual([]);
    await expect(
      w.lifecycle.execute(
        { ...w.ctx, toolUseId: "cached-after-revoke" },
        {
          bindingId: cached.bindingId,
          digest: cached.digest,
          input: FRESH_INPUT,
        },
      ),
    ).rejects.toBeInstanceOf(FoundryError);
    expect(w.state.executions).toHaveLength(1);
    expect((await binding(a.binding.id)).reservedCalls).toBe(1);
  });

  test("failed B canary restores only the previous authorized and verified A", async () => {
    const w = await ready();
    const a = await active(w);
    const stagedB = await w.stage("1.0.1");
    const b = await w.activate(stagedB);
    expect(b.params.previousBindingId).toBe(a.binding.id);
    w.state.mode = "wrong-output";
    expect(await w.lifecycle.runCanary({ ...w.ctx, toolUseId: "canary-b" }, b.binding.id)).toMatchObject({
      outcome: "FAIL",
      restoredBindingId: a.binding.id,
    });
    expect((await binding(b.binding.id)).state).toBe("QUARANTINED");
    expect((await binding(a.binding.id)).state).toBe("ACTIVE");
    expect(
      (await w.makeLifecycle().discover(await w.session())).map(({ bindingId, digest }) => ({ bindingId, digest })),
    ).toEqual([{ bindingId: a.binding.id, digest: a.staged.digest }]);
    w.state.mode = "normal";
    expect(
      await w.makeLifecycle().execute(
        { ...(await w.session()), toolUseId: "after-rollback" },
        {
          bindingId: a.binding.id,
          digest: a.staged.digest,
          input: FRESH_INPUT,
        },
      ),
    ).toMatchObject({ outcome: "SUCCEEDED", output: FRESH_OUTPUT });
  });

  test("failed B never restores A once A has been revoked", async () => {
    const w = await ready();
    const a = await active(w);
    const b = await w.activate(await w.stage("1.0.1"));
    await w.lifecycle.revoke({ ...w.ctx, toolUseId: "revoke-previous-a" }, a.binding.id);
    w.state.mode = "wrong-output";
    expect(await w.lifecycle.runCanary({ ...w.ctx, toolUseId: "canary-b" }, b.binding.id)).toMatchObject({
      outcome: "FAIL",
      restoredBindingId: null,
    });
    expect(await w.makeLifecycle().discover(await w.session())).toEqual([]);
    expect((await binding(a.binding.id)).revokedAt).not.toBeNull();
  });

  test("duplicate native toolUseId reserves and dispatches once, preserving the remaining budget", async () => {
    const w = await ready();
    const a = await active(w, 2);
    const ctx = { ...(await w.session()), toolUseId: "same-native-call" };
    const input = { bindingId: a.binding.id, digest: a.staged.digest, input: FRESH_INPUT };
    const first = await w.lifecycle.execute(ctx, input);
    const replay = await w.makeLifecycle().execute(ctx, input);
    expect(replay).toMatchObject({ outcome: "ALREADY_ATTEMPTED", invocationId: first.invocationId });
    expect(replay).not.toHaveProperty("output");
    expect(w.state.executions).toHaveLength(2);
    expect(await invocations(a.binding.id)).toHaveLength(2);
    expect((await binding(a.binding.id)).reservedCalls).toBe(2);
    await expect(w.lifecycle.execute({ ...ctx, toolUseId: "over-budget" }, input)).rejects.toBeInstanceOf(FoundryError);
    expect(w.state.executions).toHaveLength(2);
  });

  test("an old toolUseId cannot authorize different input bytes", async () => {
    const w = await ready();
    const a = await active(w);
    const ctx = { ...(await w.session()), toolUseId: "same-native-call" };
    await w.lifecycle.execute(ctx, { bindingId: a.binding.id, digest: a.staged.digest, input: FRESH_INPUT });
    await expect(
      w.lifecycle.execute(ctx, {
        bindingId: a.binding.id,
        digest: a.staged.digest,
        input: { records: [{ status: "succeeded", tokens: 999 }] },
      }),
    ).rejects.toBeInstanceOf(FoundryError);
    expect(w.state.executions).toHaveLength(2);
    expect((await binding(a.binding.id)).reservedCalls).toBe(2);
  });

  test("unknown outcome remains reserved across a new service and is never blindly replayed", async () => {
    const w = await ready();
    const a = await active(w);
    w.state.mode = "unknown";
    w.state.reconciliation = null;
    const ctx = { ...(await w.session()), toolUseId: "lost-transport" };
    const input = { bindingId: a.binding.id, digest: a.staged.digest, input: FRESH_INPUT };
    const first = await w.lifecycle.execute(ctx, input);
    expect(first.outcome).toBe("UNKNOWN_OUTCOME");
    const restarted = w.makeLifecycle();
    expect(await restarted.execute(ctx, input)).toMatchObject({
      outcome: "UNKNOWN_OUTCOME",
      invocationId: first.invocationId,
    });
    w.state.now = new Date(w.state.now.getTime() + 31_000);
    await restarted.reconcile(f.org.id, first.invocationId);
    const [row] = await f.db
      .select()
      .from(schema.foundryInvocations)
      .where(eq(schema.foundryInvocations.id, first.invocationId));
    expect(row?.state).toBe("UNKNOWN_OUTCOME");
    expect((await binding(a.binding.id)).reservedCalls).toBe(2);
    expect(w.state.executions).toHaveLength(2);
    expect(w.state.reconciliations).toBe(1);
  });

  test("profile ineligibility invalidates cached discovery before dispatch", async () => {
    const w = await ready();
    const a = await active(w);
    const freshCtx = await w.session();
    const cached = await w.lifecycle.discover(freshCtx);
    expect(cached).toHaveLength(1);
    w.state.qualified = false;
    expect(await w.makeLifecycle().discover(freshCtx)).toEqual([]);
    await expect(
      w.lifecycle.execute(
        { ...freshCtx, toolUseId: "stale-runtime" },
        {
          bindingId: a.binding.id,
          digest: a.staged.digest,
          input: FRESH_INPUT,
        },
      ),
    ).rejects.toBeInstanceOf(FoundryError);
    expect(w.state.executions).toHaveLength(1);
  });

  test("changed blob bytes under an approved digest are rejected before dispatch", async () => {
    const w = await ready();
    const a = await active(w);
    const version = a.staged.version;
    const store = await f.artifactDeps.blobs.forConfig(f.org.id, version.storageConfigId);
    const object = await store.get(version.blobKey);
    const bundle = JSON.parse(new TextDecoder().decode(object!.body));
    const before: string = bundle.files[0].base64;
    bundle.files[0].base64 = (before[0] === "A" ? "B" : "A") + before.slice(1);
    await store.put(version.blobKey, new TextEncoder().encode(JSON.stringify(bundle)), {
      contentType: "application/json",
    });
    await expect(
      w.lifecycle.execute(
        { ...w.ctx, toolUseId: "tampered-version" },
        {
          bindingId: a.binding.id,
          digest: a.staged.digest,
          input: FRESH_INPUT,
        },
      ),
    ).rejects.toMatchObject({ code: "STALE_VERSION" });
    expect(w.state.executions).toHaveLength(1);
  });

  test("parent cancellation blocks a new reservation and executable dispatch", async () => {
    const w = await ready();
    const a = await active(w);
    const controller = new AbortController();
    controller.abort();
    await expect(
      w.lifecycle.execute(
        { ...w.ctx, toolUseId: "cancelled-parent", signal: controller.signal },
        {
          bindingId: a.binding.id,
          digest: a.staged.digest,
          input: FRESH_INPUT,
        },
      ),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(w.state.executions).toHaveLength(1);
    expect((await binding(a.binding.id)).reservedCalls).toBe(1);
  });
});

describe("native Foundry recovery races (SIMULATED runner transport)", () => {
  test("a concurrent duplicate canary remains pending without quarantining the in-flight first attempt", async () => {
    const w = await ready();
    const staged = await w.stage();
    const a = await w.activate(staged);
    let started!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    w.state.beforeExecute = async () => {
      started();
      await held;
    };
    const ctx = { ...w.ctx, toolUseId: "same-inflight-canary" };
    const first = w.lifecycle.runCanary(ctx, a.binding.id);
    let completed: unknown;
    try {
      await entered;
      expect(await w.makeLifecycle().runCanary(ctx, a.binding.id)).toMatchObject({
        outcome: "PENDING",
        restoredBindingId: null,
      });
      expect((await binding(a.binding.id)).state).toBe("CANARY");
      expect((await binding(a.binding.id)).reservedCalls).toBe(1);
      expect(await invocations(a.binding.id)).toHaveLength(1);
      expect(w.state.executions).toHaveLength(1);
    } finally {
      release();
      completed = await first.catch((error: unknown) => ({ outcome: "ERROR", error }));
    }
    expect(completed).toMatchObject({ outcome: "PASS" });
    expect((await binding(a.binding.id)).state).toBe("ACTIVE");
    expect(w.state.executions).toHaveLength(1);
  });

  test("reconciliation rejects mismatched pinned identities and accepts only the original exact receipt", async () => {
    const w = await ready();
    const a = await active(w);
    const canary = w.state.reconciliation;
    if (canary?.outcome !== "SUCCEEDED") throw new Error("missing simulated canary receipt");
    w.state.mode = "unknown";
    const ctx = { ...(await w.session()), toolUseId: "unknown-exact-receipt" };
    const lost = await w.lifecycle.execute(ctx, {
      bindingId: a.binding.id,
      digest: a.staged.digest,
      input: FRESH_INPUT,
    });
    expect(lost.outcome).toBe("UNKNOWN_OUTCOME");
    const dispatched = w.state.executions.at(-1)!;
    const receiptRef = `simulation-recovered/${lost.invocationId}`;
    const matching: Extract<FoundryExecutionResult, { outcome: "SUCCEEDED" }> = {
      outcome: "SUCCEEDED",
      output: FRESH_OUTPUT,
      receiptRef,
      receipt: {
        ...canary.receipt,
        receiptRef,
        orgId: f.org.id,
        invocationId: lost.invocationId,
        digest: dispatched.digest,
        inputDigest: dispatched.inputDigest,
        fencingToken: dispatched.fencingToken,
      },
    };
    const mutations: [string, unknown][] = [
      ["orgId", crypto.randomUUID()],
      ["invocationId", crypto.randomUUID()],
      ["digest", "e".repeat(64)],
      ["inputDigest", "f".repeat(64)],
      ["fencingToken", dispatched.fencingToken + 1],
      ["runnerId", "another-simulation-runner"],
      ["runtimeDigest", "a".repeat(64)],
      ["profileDigest", "d".repeat(64)],
      ["qualificationRef", "another-attestation"],
      ["processTreeTerminated", false],
    ];
    const restarted = w.makeLifecycle();
    for (const [key, value] of mutations) {
      const tampered = structuredClone(matching);
      Object.assign(tampered.receipt, { [key]: value });
      w.state.reconciliation = tampered;
      w.state.now = new Date(w.state.now.getTime() + 31_000);
      expect(await restarted.reconcile(f.org.id, lost.invocationId)).toMatchObject({ outcome: "UNKNOWN_OUTCOME" });
      const [row] = await f.db
        .select()
        .from(schema.foundryInvocations)
        .where(eq(schema.foundryInvocations.id, lost.invocationId));
      expect(row).toMatchObject({ state: "UNKNOWN_OUTCOME", reasonCode: "RECEIPT_MISMATCH" });
      expect(w.state.executions).toHaveLength(2);
      expect((await binding(a.binding.id)).reservedCalls).toBe(2);
    }
    w.state.reconciliation = matching;
    w.state.now = new Date(w.state.now.getTime() + 31_000);
    const reconciled = await restarted.reconcile(f.org.id, lost.invocationId);
    expect(reconciled).toMatchObject({ outcome: "SUCCEEDED" });
    expect(reconciled).not.toHaveProperty("output");
    const [row] = await f.db
      .select()
      .from(schema.foundryInvocations)
      .where(eq(schema.foundryInvocations.id, lost.invocationId));
    expect(row).toMatchObject({ state: "SUCCEEDED", resultDigest: hashFoundryInput(FRESH_OUTPUT) });
    expect(row?.receipt).not.toHaveProperty("output");
    expect(w.state.executions).toHaveLength(2);
    expect(w.state.reconciliations).toBe(mutations.length + 1);
  });
});

describe("a busy runtime refuses before anything starts (SIMULATED runner transport)", () => {
  test("the call is not spent, not UNKNOWN, and a new call runs once the runtime has room", async () => {
    const w = await ready();
    const a = await active(w);
    const before = (await binding(a.binding.id)).reservedCalls;
    w.state.beforeExecute = async () => {
      throw Object.assign(new Error("Runtime capacity unavailable"), { code: "RUNTIME_BUSY" });
    };
    expect(
      await w.lifecycle.execute(
        { ...w.ctx, toolUseId: "busy-call" },
        { bindingId: a.binding.id, digest: a.staged.digest, input: FRESH_INPUT },
      ),
    ).toMatchObject({ outcome: "CANCELLED", code: "RUNTIME_BUSY" });
    const busy = (await invocations(a.binding.id)).find((r) => r.toolUseId === "busy-call")!;
    expect(busy).toMatchObject({ state: "CANCELLED", reasonCode: "RUNTIME_BUSY" });
    expect((await binding(a.binding.id)).reservedCalls).toBe(before);
    w.state.beforeExecute = null;
    expect(
      await w.lifecycle.execute(
        { ...w.ctx, toolUseId: "after-busy" },
        { bindingId: a.binding.id, digest: a.staged.digest, input: FRESH_INPUT },
      ),
    ).toMatchObject({ output: FRESH_OUTPUT });
    expect((await binding(a.binding.id)).reservedCalls).toBe(before + 1);
  });

  test("a busy canary is not a failed canary: nothing is quarantined, and the canary can run again", async () => {
    const w = await ready();
    const staged = await w.stage();
    const a = await w.activate(staged);
    w.state.beforeExecute = async () => {
      throw Object.assign(new Error("Runtime capacity unavailable"), { code: "RUNTIME_BUSY" });
    };
    expect(await w.lifecycle.runCanary({ ...w.ctx, toolUseId: "busy-canary" }, a.binding.id)).toMatchObject({
      outcome: "BUSY",
      code: "RUNTIME_BUSY",
      restoredBindingId: null,
    });
    expect(await binding(a.binding.id)).toMatchObject({ state: "CANARY", reservedCalls: 0 });
    w.state.beforeExecute = null;
    expect(await w.lifecycle.runCanary({ ...w.ctx, toolUseId: "canary-again" }, a.binding.id)).toMatchObject({
      outcome: "PASS",
    });
    expect((await binding(a.binding.id)).state).toBe("ACTIVE");
  });
});
