import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { canonicalJson } from "../src/foundry/packages";
import { type Fixture, setup } from "./fixtures";
import { createLifecycleWorld, FRESH_INPUT } from "./foundry-lifecycle.fixture";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});
test("the runner independently checks native invocation, approval, input, fence and current run before dispatch", async () => {
  f = await setup();
  const w = await createLifecycleWorld(f);
  const s = await w.stage();
  const a = await w.activate(s);
  await w.lifecycle.runCanary({ ...a.ctx, toolUseId: crypto.randomUUID() }, a.binding.id);
  const q = await w.executor.qualify();
  if (!q.qualified) throw new Error("fixture");
  let checked = false;
  w.state.beforeExecute = async (request) => {
    const r = { ...request, inputJson: canonicalJson(request.input) };
    expect(await w.rawLifecycle.authorizeRunnerExecution(r, q)).toBe(true);
    expect(await w.rawLifecycle.authorizeRunnerExecution({ ...r, inputDigest: "0".repeat(64) }, q)).toBe(false);
    expect(await w.rawLifecycle.authorizeRunnerExecution({ ...r, fencingToken: r.fencingToken + 1 }, q)).toBe(false);
    expect(await w.rawLifecycle.authorizeRunnerExecution({ ...r, nativeDecisionRef: crypto.randomUUID() }, q)).toBe(
      false,
    );
    expect(await w.rawLifecycle.authorizeRunnerExecution({ ...r, orgId: crypto.randomUUID() }, q)).toBe(false);
    await f.db.update(schema.agentRuns).set({ status: "canceled" }).where(eq(schema.agentRuns.id, w.ctx.runId));
    expect(await w.rawLifecycle.authorizeRunnerExecution(r, q)).toBe(false);
    checked = true;
  };
  await w.lifecycle.execute(
    { ...w.ctx, toolUseId: crypto.randomUUID() },
    { bindingId: a.binding.id, digest: s.digest, input: FRESH_INPUT },
  );
  expect(checked).toBe(true);
});
test("evaluation dispatch requires the original current native worker claim and builder protection", async () => {
  f = await setup();
  const w = await createLifecycleWorld(f);
  const s = await w.stage();
  const original = w.executor.evaluate.bind(w.executor);
  let checked = false;
  w.executor.evaluate = async (version, job) => {
    const q = await w.executor.qualify();
    if (!q.qualified) throw new Error("fixture");
    expect(await w.rawLifecycle.authorizeRunnerEvaluation(version, job, q)).toMatchObject({
      runId: w.ctx.runId,
      orgId: f.org.id,
    });
    expect(
      await w.rawLifecycle.authorizeRunnerEvaluation({ ...version, dispatchAuthority: undefined }, job, q),
    ).toBeNull();
    expect(
      await w.rawLifecycle.authorizeRunnerEvaluation(
        { ...version, dispatchAuthority: { ...version.dispatchAuthority!, lockedBy: "wrong-worker" } },
        job,
        q,
      ),
    ).toBeNull();
    expect(
      await w.rawLifecycle.authorizeRunnerEvaluation(version, job, { ...q, profileDigest: "0".repeat(64) }),
    ).toBeNull();
    checked = true;
    return original(version, job);
  };
  expect(await w.lifecycle.evaluate(w.ctx, s)).toMatchObject({ state: "REVIEW_READY" });
  expect(checked).toBe(true);
});
