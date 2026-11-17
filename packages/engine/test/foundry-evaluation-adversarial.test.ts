// Native recovery/authorization races with SIMULATED evaluator receipts only.
// No candidate bytes are loaded, imported or executed by these tests.
import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import { FoundryError } from "../src/foundry/service";
import { type Fixture, setup } from "./fixtures";
import { createLifecycleWorld } from "./foundry-lifecycle.fixture";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

async function ready() {
  f = await setup();
  const w = await createLifecycleWorld(f);
  const staged = await w.stage();
  const begun = await w.rawLifecycle.evaluate(w.ctx, { candidateId: staged.candidateId, digest: staged.digest });
  if (!("pause" in begun) || !begun.pause) throw new Error("expected native evaluation checkpoint");
  const waitId = begun.pause.id;
  await w.checkpointEvaluation(w.ctx, waitId);
  return { w, staged, waitId, claim: await w.claimEvaluation(waitId) };
}

async function versionRow(id: string) {
  return (await f.db.select().from(schema.foundryVersions).where(eq(schema.foundryVersions.id, id)))[0]!;
}
async function pendingResult(runId: string) {
  const [row] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, runId));
  const t = row?.transcript as { pending?: { calls?: { result?: { content: string; isError?: boolean } }[] } } | null;
  return t?.pending?.calls?.[0]?.result;
}
async function wakes(runId: string) {
  return (
    await f.db
      .select()
      .from(schema.outbox)
      .where(and(eq(schema.outbox.kind, "agent_run.execute"), eq(schema.outbox.orgId, f.org.id)))
  ).filter((r) => r.payload.runId === runId);
}
/** A preserved terminal guard may return or explicitly refuse; unrelated crashes fail the test. */
async function completeOrRefuse(operation: Promise<void>) {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(FoundryError);
    expect([
      "STALE_VERSION",
      "STALE_FENCE",
      "AUTHORITY_DENIED",
      "AUTHORITY_CHANGED",
      "EVALUATION_UNVERIFIED",
    ]).toContain((error as FoundryError).code);
  }
}
async function noPublishedSuccess(runId: string, versionId: string) {
  expect((await versionRow(versionId)).state).not.toBe("REVIEW_READY");
  expect((await versionRow(versionId)).evaluationRef).toBeNull();
  const result = await pendingResult(runId);
  if (result) expect(result.isError).toBe(true);
  expect(await f.db.select().from(schema.foundryBindings)).toHaveLength(0);
}

describe("Foundry evaluation authority and late-result fences", () => {
  test.each(["QUARANTINED", "BLOCKED"])(
    "a version changed to %s while the evaluator runs is not resurrected by its late PASS",
    async (state) => {
      const { w, staged, claim } = await ready();
      const evaluate = w.executor.evaluate;
      w.executor.evaluate = async (...args) => {
        const receipt = await evaluate(...args);
        await f.db
          .update(schema.foundryVersions)
          .set({ state })
          .where(eq(schema.foundryVersions.id, staged.version.id));
        return receipt;
      };
      await completeOrRefuse(w.rawLifecycle.reconcileEvaluation(claim));
      expect((await versionRow(staged.version.id)).state).toBe(state);
      await noPublishedSuccess(w.ctx.runId, staged.version.id);
      expect(await pendingResult(w.ctx.runId)).toBeUndefined();
      expect(await wakes(w.ctx.runId)).toHaveLength(0);
    },
  );

  test("retiring an evaluating version prevents late promotion and checkpoint consumption", async () => {
    const { w, staged, claim } = await ready();
    const retiredAt = new Date(w.state.now.getTime());
    const evaluate = w.executor.evaluate;
    w.executor.evaluate = async (...args) => {
      const receipt = await evaluate(...args);
      await f.db
        .update(schema.foundryVersions)
        .set({ retiredAt })
        .where(eq(schema.foundryVersions.id, staged.version.id));
      return receipt;
    };
    await completeOrRefuse(w.rawLifecycle.reconcileEvaluation(claim));
    expect((await versionRow(staged.version.id)).retiredAt?.getTime()).toBe(retiredAt.getTime());
    await noPublishedSuccess(w.ctx.runId, staged.version.id);
    expect(await pendingResult(w.ctx.runId)).toBeUndefined();
    expect(await wakes(w.ctx.runId)).toHaveLength(0);
  });

  test("qualification revoked after evaluation cannot produce a REVIEW_READY version", async () => {
    const { w, staged, claim } = await ready();
    const evaluate = w.executor.evaluate;
    w.executor.evaluate = async (...args) => {
      const receipt = await evaluate(...args);
      w.state.qualified = false;
      return receipt;
    };
    await w.rawLifecycle.reconcileEvaluation(claim);
    await noPublishedSuccess(w.ctx.runId, staged.version.id);
    expect((await versionRow(staged.version.id)).state).toBe("BLOCKED");
    expect((await pendingResult(w.ctx.runId))?.isError).toBe(true);
    expect(await wakes(w.ctx.runId)).toHaveLength(1);
  });

  test("runtime profile drift after evaluation invalidates the otherwise correct receipt", async () => {
    const { w, staged, claim } = await ready();
    let drifted = false;
    const qualify = w.executor.qualify;
    const evaluate = w.executor.evaluate;
    w.executor.qualify = async () => {
      const q = await qualify();
      return q.qualified && drifted ? { ...q, profileDigest: "f".repeat(64) } : q;
    };
    w.executor.evaluate = async (...args) => {
      const receipt = await evaluate(...args);
      drifted = true;
      return receipt;
    };
    await w.rawLifecycle.reconcileEvaluation(claim);
    await noPublishedSuccess(w.ctx.runId, staged.version.id);
    expect((await pendingResult(w.ctx.runId))?.isError).toBe(true);
  });

  test("qualification revoked during protected evidence resolution is rechecked before delivery", async () => {
    const { w, staged, claim } = await ready();
    const resolve = w.evaluations.resolve;
    w.evaluations.resolve = async (...args) => {
      const evidence = await resolve(...args);
      w.state.qualified = false;
      return evidence;
    };
    await w.rawLifecycle.reconcileEvaluation(claim);
    await noPublishedSuccess(w.ctx.runId, staged.version.id);
    expect((await pendingResult(w.ctx.runId))?.isError).toBe(true);
  });

  test("an already expired outbox lease submits nothing", async () => {
    const { w, staged, claim } = await ready();
    await f.db
      .update(schema.outbox)
      .set({ lockedUntil: new Date(w.state.now.getTime() - 1) })
      .where(eq(schema.outbox.id, claim.id));
    await expect(w.rawLifecycle.reconcileEvaluation(claim)).rejects.toThrow("STALE_FENCE");
    expect(w.state.evaluations).toBe(0);
    expect((await versionRow(staged.version.id)).evaluationJob).toMatchObject({ state: "QUEUED" });
    expect(await wakes(w.ctx.runId)).toHaveLength(0);
  });

  test("a lease expiring during qualification cannot reach evaluator submission", async () => {
    const { w, staged, claim } = await ready();
    const qualify = w.executor.qualify;
    w.executor.qualify = async () => {
      const q = await qualify();
      w.state.now = new Date(w.state.now.getTime() + 121_000);
      return q;
    };
    await expect(w.rawLifecycle.reconcileEvaluation(claim)).rejects.toThrow("STALE_FENCE");
    expect(w.state.evaluations).toBe(0);
    expect((await versionRow(staged.version.id)).evaluationJob).toMatchObject({ state: "QUEUED" });
    expect(await wakes(w.ctx.runId)).toHaveLength(0);
  });

  test("an expired worker cannot cancel a job merely because the parent was canceled", async () => {
    const { w, staged, claim } = await ready();
    let cancellations = 0;
    const cancel = w.executor.cancelEvaluation;
    w.executor.cancelEvaluation = async (...args) => {
      cancellations++;
      return cancel(...args);
    };
    await f.db.update(schema.agentRuns).set({ status: "canceled" }).where(eq(schema.agentRuns.id, w.ctx.runId));
    await f.db
      .update(schema.outbox)
      .set({ lockedUntil: new Date(w.state.now.getTime() - 1) })
      .where(eq(schema.outbox.id, claim.id));
    await expect(w.rawLifecycle.reconcileEvaluation(claim)).rejects.toThrow("STALE_FENCE");
    expect(cancellations).toBe(0);
    expect(w.state.evaluations).toBe(0);
    expect((await versionRow(staged.version.id)).evaluationJob).toMatchObject({ state: "QUEUED" });
    expect(await wakes(w.ctx.runId)).toHaveLength(0);
  });

  test("qualification failure after lease expiry does not permit an unfenced cancel", async () => {
    const { w, staged, claim } = await ready();
    let cancellations = 0;
    const cancel = w.executor.cancelEvaluation;
    w.executor.cancelEvaluation = async (...args) => {
      cancellations++;
      return cancel(...args);
    };
    w.executor.qualify = async () => {
      w.state.now = new Date(w.state.now.getTime() + 121_000);
      return { qualified: false, code: "BLOCKED_SANDBOX", reason: "simulated qualification revoked" };
    };
    await expect(w.rawLifecycle.reconcileEvaluation(claim)).rejects.toThrow("STALE_FENCE");
    expect(cancellations).toBe(0);
    expect((await versionRow(staged.version.id)).evaluationJob).toMatchObject({ state: "QUEUED" });
    expect(await wakes(w.ctx.runId)).toHaveLength(0);
  });

  test("a receipt returned after lease expiry cannot mutate the version or wake its parent", async () => {
    const { w, staged, claim } = await ready();
    const evaluate = w.executor.evaluate;
    w.executor.evaluate = async (...args) => {
      const receipt = await evaluate(...args);
      w.state.now = new Date(w.state.now.getTime() + 121_000);
      return receipt;
    };
    await expect(w.rawLifecycle.reconcileEvaluation(claim)).rejects.toThrow("STALE_FENCE");
    expect((await versionRow(staged.version.id)).state).toBe("EVALUATING");
    expect((await versionRow(staged.version.id)).evaluationRef).toBeNull();
    expect(await pendingResult(w.ctx.runId)).toBeUndefined();
    expect(await wakes(w.ctx.runId)).toHaveLength(0);
  });

  test("task ownership lost during protected evidence resolution prevents the parent wake", async () => {
    const { w, staged, claim } = await ready();
    const resolve = w.evaluations.resolve;
    w.evaluations.resolve = async (...args) => {
      const evidence = await resolve(...args);
      await f.db
        .update(schema.issues)
        .set({ assigneeType: "person", assigneeId: f.owner.id })
        .where(eq(schema.issues.id, w.task!.id));
      return evidence;
    };
    await w.rawLifecycle.reconcileEvaluation(claim);
    await noPublishedSuccess(w.ctx.runId, staged.version.id);
    expect((await versionRow(staged.version.id)).evaluationJob).toMatchObject({
      delivered: false,
      reasonCode: "AUTHORITY_CHANGED",
    });
    expect(await pendingResult(w.ctx.runId)).toBeUndefined();
    expect(await wakes(w.ctx.runId)).toHaveLength(0);
  });

  test("an operator hold added before finish prevents success delivery", async () => {
    const { w, staged, claim } = await ready();
    const resolve = w.evaluations.resolve;
    w.evaluations.resolve = async (...args) => {
      const evidence = await resolve(...args);
      await f.db.update(schema.agents).set({ operatorHoldAt: w.state.now }).where(eq(schema.agents.id, f.agent.id));
      return evidence;
    };
    await w.rawLifecycle.reconcileEvaluation(claim);
    await noPublishedSuccess(w.ctx.runId, staged.version.id);
    expect(await pendingResult(w.ctx.runId)).toBeUndefined();
    expect(await wakes(w.ctx.runId)).toHaveLength(0);
  });

  test.each(["waitId", "toolUseId", "runtimeDigest", "profileDigest"])(
    "a same-revision job whose %s changed cannot consume the original checkpoint",
    async (field) => {
      const { w, staged, claim } = await ready();
      const evaluate = w.executor.evaluate;
      w.executor.evaluate = async (...args) => {
        const receipt = await evaluate(...args);
        const row = await versionRow(staged.version.id);
        const value = field.endsWith("Digest") ? "e".repeat(64) : "different-native-binding";
        await f.db
          .update(schema.foundryVersions)
          .set({ evaluationJob: { ...row.evaluationJob, [field]: value } })
          .where(eq(schema.foundryVersions.id, staged.version.id));
        return receipt;
      };
      await completeOrRefuse(w.rawLifecycle.reconcileEvaluation(claim));
      await noPublishedSuccess(w.ctx.runId, staged.version.id);
      expect(await pendingResult(w.ctx.runId)).toBeUndefined();
      expect(await wakes(w.ctx.runId)).toHaveLength(0);
    },
  );
});
