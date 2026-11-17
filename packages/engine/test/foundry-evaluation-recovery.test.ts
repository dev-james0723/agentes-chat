import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
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
  if (!("pause" in begun) || !begun.pause) throw new Error("expected native evaluation wait");
  return { w, staged, waitId: begun.pause.id, claim: await w.claimEvaluation(begun.pause.id) };
}
async function runRow(id: string) {
  return (await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, id)))[0]!;
}
async function versionRow(id: string) {
  return (await f.db.select().from(schema.foundryVersions).where(eq(schema.foundryVersions.id, id)))[0]!;
}
async function wakes(runId: string) {
  return (
    await f.db
      .select()
      .from(schema.outbox)
      .where(and(eq(schema.outbox.kind, "agent_run.execute"), eq(schema.outbox.orgId, f.org.id)))
  ).filter((r) => r.payload.runId === runId);
}

describe("durable Foundry evaluation through native checkpoints (simulated isolated service)", () => {
  test("submission queues inert metadata and cannot run ahead of the native checkpoint", async () => {
    const { w, staged, claim, waitId } = await ready();
    expect(w.state.evaluations).toBe(0);
    expect((await versionRow(staged.version.id)).state).toBe("EVALUATING");
    await expect(w.rawLifecycle.reconcileEvaluation(claim)).rejects.toThrow("CHECKPOINT_NOT_READY");
    expect(w.state.evaluations).toBe(0);
    const again = await w.rawLifecycle.evaluate(w.ctx, { candidateId: staged.candidateId, digest: staged.digest });
    expect(again).toMatchObject({ pause: { id: waitId } });
    expect(await f.db.select().from(schema.outbox).where(eq(schema.outbox.dedupeKey, waitId))).toHaveLength(1);
  });
  test("terminal version, tool result and one parent wake commit once", async () => {
    const { w, staged, claim, waitId } = await ready();
    await w.checkpointEvaluation(w.ctx, waitId);
    await w.rawLifecycle.reconcileEvaluation(claim);
    await w.rawLifecycle.reconcileEvaluation(claim);
    expect(w.state.evaluations).toBe(1);
    expect((await versionRow(staged.version.id)).state).toBe("REVIEW_READY");
    expect((await runRow(w.ctx.runId)).transcript).toMatchObject({
      pending: {
        calls: [
          {
            waitId,
            toolUseId: w.ctx.toolUseId,
            result: { isError: false },
          },
        ],
      },
    });
    expect(await wakes(w.ctx.runId)).toHaveLength(1);
  });
  test("lost submission acknowledgement reconciles the same job without executing again", async () => {
    const { w, staged, claim, waitId } = await ready();
    await w.checkpointEvaluation(w.ctx, waitId);
    const evaluate = w.executor.evaluate;
    let saved: Awaited<ReturnType<typeof evaluate>> | undefined;
    w.executor.evaluate = async (...args) => {
      saved = await evaluate(...args);
      throw new Error("transport lost");
    };
    w.executor.reconcileEvaluation = async (id) => {
      expect(id).toBe(waitId);
      if (!saved) throw new Error("no durable service receipt");
      return saved;
    };
    await expect(w.rawLifecycle.reconcileEvaluation(claim)).rejects.toThrow("EVALUATION_PENDING_RECONCILIATION");
    expect((await versionRow(staged.version.id)).state).toBe("EVALUATING");
    await w.rawLifecycle.reconcileEvaluation(claim);
    expect(w.state.evaluations).toBe(1);
    expect((await versionRow(staged.version.id)).state).toBe("REVIEW_READY");
    expect(await wakes(w.ctx.runId)).toHaveLength(1);
  });
  test("a worker losing its native outbox claim cannot publish a late PASS", async () => {
    const { w, staged, claim, waitId } = await ready();
    await w.checkpointEvaluation(w.ctx, waitId);
    const evaluate = w.executor.evaluate;
    w.executor.evaluate = async (...args) => {
      const receipt = await evaluate(...args);
      await f.db
        .update(schema.outbox)
        .set({ attempts: claim.attempts + 1, lockedBy: "new-worker" })
        .where(eq(schema.outbox.id, claim.id));
      return receipt;
    };
    await expect(w.rawLifecycle.reconcileEvaluation(claim)).rejects.toThrow("STALE_FENCE");
    expect((await versionRow(staged.version.id)).state).toBe("EVALUATING");
    expect(await wakes(w.ctx.runId)).toHaveLength(0);
  });
  test("cancelled parent stays cancelled and receives no new run or wake", async () => {
    const { w, staged, claim, waitId } = await ready();
    await w.checkpointEvaluation(w.ctx, waitId);
    await f.db.update(schema.agentRuns).set({ status: "canceled" }).where(eq(schema.agentRuns.id, w.ctx.runId));
    await w.rawLifecycle.reconcileEvaluation(claim);
    expect(w.state.evaluations).toBe(0);
    expect((await versionRow(staged.version.id)).state).toBe("BLOCKED");
    expect((await runRow(w.ctx.runId)).status).toBe("canceled");
    expect(await wakes(w.ctx.runId)).toHaveLength(0);
  });
  test("a different checkpoint cannot consume the old result", async () => {
    const { w, staged, claim, waitId } = await ready();
    await w.checkpointEvaluation({ ...w.ctx, toolUseId: "different-call" }, waitId);
    await w.rawLifecycle.reconcileEvaluation(claim);
    expect(w.state.evaluations).toBe(0);
    expect((await versionRow(staged.version.id)).evaluationJob).toMatchObject({
      delivered: false,
      reasonCode: "AUTHORITY_CHANGED",
    });
    expect(await wakes(w.ctx.runId)).toHaveLength(0);
  });
  test("an independently failed evaluation resumes the original call as an error", async () => {
    const { w, staged, claim, waitId } = await ready();
    await w.checkpointEvaluation(w.ctx, waitId);
    const evaluate = w.executor.evaluate;
    w.executor.evaluate = async (...args) => ({ ...(await evaluate(...args)), outcome: "FAIL" });
    await w.rawLifecycle.reconcileEvaluation(claim);
    expect((await versionRow(staged.version.id)).state).toBe("BLOCKED");
    expect((await runRow(w.ctx.runId)).transcript).toMatchObject({
      pending: { calls: [{ result: { isError: true } }] },
    });
    expect(await wakes(w.ctx.runId)).toHaveLength(1);
  });
  test("unknown final outcome does not activate and wakes the parent with an explicit blocker", async () => {
    const { w, staged, claim, waitId } = await ready();
    await w.checkpointEvaluation(w.ctx, waitId);
    w.executor.evaluate = async () => {
      throw new Error("unknown transport outcome");
    };
    await w.rawLifecycle.reconcileEvaluation(claim, true);
    expect((await versionRow(staged.version.id)).evaluationJob).toMatchObject({
      reasonCode: "UNKNOWN_OUTCOME",
      delivered: true,
    });
    expect(await f.db.select().from(schema.foundryBindings)).toHaveLength(0);
    expect(await wakes(w.ctx.runId)).toHaveLength(1);
  });
});
