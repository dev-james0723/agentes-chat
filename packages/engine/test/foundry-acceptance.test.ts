// Foundry acceptance (docs/adr/native-capability-foundry.md, SF-05/07/19): one candidate from proposal to a failed evaluation, a bounded
// repair, a passing evaluation, an approved binding, an invocation and a recorded sync. Native DB, blobs, approvals
// and outbox are real (PGlite); the isolated runtime, protected scorer and skills repository are SIMULATED here.
// packages/adapters/test/foundry-receipt-conformance.test.ts runs the real scorer against the public contract.
import { afterEach, expect, test } from "bun:test";
import type { FoundryCapabilitySyncPort } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import { createFoundryCapabilitySync, FOUNDRY_SYNC_JOB } from "../src/foundry/sync";
import { type Fixture, setup } from "./fixtures";
import { createLifecycleWorld, FRESH_INPUT, FRESH_OUTPUT } from "./foundry-lifecycle.fixture";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

const candidate = async (id: string) =>
  (await f.db.select().from(schema.foundryCandidates).where(eq(schema.foundryCandidates.id, id)))[0]!;
const versionOf = async (digest: string) =>
  (
    await f.db
      .select()
      .from(schema.foundryVersions)
      .where(and(eq(schema.foundryVersions.orgId, f.org.id), eq(schema.foundryVersions.digest, digest)))
  )[0]!;

test("a candidate fails, is repaired once, passes, binds, runs and is synced", async () => {
  f = await setup();
  const w = await createLifecycleWorld(f);

  // 1. Proposed and staged; the protected scorer fails the first version.
  const first = await w.stage("1.0.0");
  const evaluate = w.executor.evaluate;
  w.executor.evaluate = async (version, ...rest) => {
    const receipt = await evaluate(version, ...rest);
    return version.digest === first.digest ? { ...receipt, outcome: "FAIL" } : receipt;
  };
  const failed = (await w.lifecycle.evaluate(w.ctx, { candidateId: first.candidateId, digest: first.digest })) as {
    state: string;
    code?: string;
    versionsLeft?: number;
    next?: string;
  };
  expect(failed).toMatchObject({ state: "BLOCKED", code: "EVAL_FAILED", versionsLeft: 3 });
  expect(failed.next).toContain("stage_foundry_package");
  expect((await candidate(first.candidateId)).state).toBe("BLOCKED");

  // 2. The same digest is never re-run: asking again reports the final outcome without a second evaluation.
  const evaluations = w.state.evaluations;
  expect(
    await w.lifecycle.evaluate(
      { ...w.ctx, toolUseId: "ask-again" },
      { candidateId: first.candidateId, digest: first.digest },
    ),
  ).toMatchObject({ state: "BLOCKED", code: "EVAL_FAILED" });
  expect(w.state.evaluations).toBe(evaluations);

  // 3. A corrected version of the SAME candidate is staged, evaluated and passes.
  const second = await w.stage("1.0.1");
  expect(second.candidateId).toBe(first.candidateId);
  expect(second.digest).not.toBe(first.digest);
  expect(await w.lifecycle.evaluate(w.ctx, { candidateId: second.candidateId, digest: second.digest })).toMatchObject({
    state: "REVIEW_READY",
  });
  expect((await versionOf(second.digest)).state).toBe("REVIEW_READY");
  expect((await versionOf(first.digest)).state).toBe("BLOCKED");

  // 4. An exact approval binds it; the canary passes and the binding is ACTIVE.
  const activated = await w.activate(second);
  expect(await w.lifecycle.runCanary({ ...w.ctx, toolUseId: "canary-accept" }, activated.binding.id)).toMatchObject({
    outcome: "PASS",
  });
  const [binding] = await f.db
    .select()
    .from(schema.foundryBindings)
    .where(eq(schema.foundryBindings.id, activated.binding.id));
  expect(binding).toMatchObject({ state: "ACTIVE", candidateId: second.candidateId });

  // 5. A real invocation through the binding records an invocation row.
  expect(
    await w.lifecycle.execute(
      { ...w.ctx, toolUseId: "invoke-accept" },
      { bindingId: activated.binding.id, digest: second.digest, input: FRESH_INPUT },
    ),
  ).toMatchObject({ outcome: "SUCCEEDED", output: FRESH_OUTPUT });
  const invocations = await f.db
    .select()
    .from(schema.foundryInvocations)
    .where(eq(schema.foundryInvocations.bindingId, activated.binding.id));
  expect(invocations.map((row) => row.state)).toEqual(["SUCCEEDED", "SUCCEEDED"]);

  // 6. ACTIVE queued exactly one sync; it records the commit on the version and reports once.
  const passed = await versionOf(second.digest);
  const jobs = await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, FOUNDRY_SYNC_JOB));
  expect(jobs.map((job) => job.payload)).toEqual([{ versionId: passed.id }]);
  const commit = "a".repeat(40);
  const port: FoundryCapabilitySyncPort = {
    async sync(e) {
      return { state: "SYNCED", commit, path: `tools/${e.name}`, url: "https://github.com/example/skills" };
    },
    async lookup() {
      return null;
    },
  };
  await createFoundryCapabilitySync({ db: f.db, blobs: f.artifactDeps.blobs, capabilitySync: port }).run(
    f.org.id,
    { versionId: passed.id },
    { finalAttempt: false },
  );
  expect(await versionOf(second.digest)).toMatchObject({ syncState: "SYNCED", syncCommit: commit });
  expect((await versionOf(second.digest)).syncReportedAt).not.toBeNull();
  // The failed version never became ACTIVE, so it was never synced.
  expect((await versionOf(first.digest)).syncState).not.toBe("SYNCED");
});
