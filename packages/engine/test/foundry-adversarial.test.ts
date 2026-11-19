import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { type FoundryLimits, hashFoundryInput } from "@agenteschat/adapters";
import { and, eq, schema, sql } from "@agenteschat/db";
import { createFoundryLifecycle } from "../src/foundry/lifecycle";
import { type CapabilityManifest, type FrozenPackage, freezePackage } from "../src/foundry/packages";
import { type Fixture, setup } from "./fixtures";
import {
  CANARY_INPUT,
  CANARY_OUTPUT,
  createLifecycleWorld,
  FRESH_INPUT,
  type LifecycleWorld,
} from "./foundry-lifecycle.fixture";

// Independent security regression cases. PGlite, in-memory blobs and simulated
// trusted services only. Candidate files remain inert data and are never run.
// These tests cannot establish real isolation, protected evaluation or live use.
let f: Fixture;
afterEach(async () => {
  mock.restore();
  await f?.close();
});

async function ready() {
  f = await setup();
  return createLifecycleWorld(f);
}

function changedBundle(base: FrozenPackage, version: string, change: (manifest: CapabilityManifest) => void) {
  const manifest = JSON.parse(base.manifestJson) as CapabilityManifest;
  manifest.version = version;
  change(manifest);
  return freezePackage(
    JSON.stringify(manifest),
    base.files.map((file) => ({
      path: file.path,
      kind: "file" as const,
      bytes: new Uint8Array(Buffer.from(file.base64, "base64")),
    })),
  );
}

async function candidate(w: LifecycleWorld) {
  const result = await w.service.propose(w.ctx, { needKey: "receipt-normalizer/v1" });
  if (result.kind !== "draft") throw new Error("Expected native draft fixture.");
  return result.candidate;
}

function narrowSimulationProfile(w: LifecycleWorld, limits: Partial<FoundryLimits> = {}) {
  const qualify = w.executor.qualify.bind(w.executor);
  w.executor.qualify = async () => {
    const result = await qualify();
    return result.qualified ? { ...result, limits: { ...result.limits, maxProcesses: 1, ...limits } } : result;
  };
}

async function binding(id: string) {
  return (
    await f.db
      .select()
      .from(schema.foundryBindings)
      .where(and(eq(schema.foundryBindings.orgId, f.org.id), eq(schema.foundryBindings.id, id)))
  )[0]!;
}

async function bindingInvocations(id: string) {
  return f.db
    .select()
    .from(schema.foundryInvocations)
    .where(and(eq(schema.foundryInvocations.orgId, f.org.id), eq(schema.foundryInvocations.bindingId, id)));
}

async function nativeCounts(taskId: string) {
  const [tasks, runs, routines, activity] = await Promise.all([
    f.db.select({ id: schema.issues.id }).from(schema.issues),
    f.db.select({ id: schema.agentRuns.id }).from(schema.agentRuns),
    f.db.select({ id: schema.routines.id }).from(schema.routines),
    f.db
      .select({ id: schema.issueActivity.id })
      .from(schema.issueActivity)
      .where(eq(schema.issueActivity.issueId, taskId)),
  ]);
  return { tasks: tasks.length, runs: runs.length, routines: routines.length, activity: activity.length };
}

// A test-only database fault after terminal invocation persistence. This uses
// PGlite's own transaction machinery; it never reaches a real database/runner.
async function interruptCanaryTransition() {
  await f.db.execute(sql`
    CREATE FUNCTION foundry_test_interrupt_canary() RETURNS trigger LANGUAGE plpgsql AS $body$
    BEGIN
      RAISE EXCEPTION 'simulated crash after terminal receipt';
      RETURN NEW;
    END;
    $body$
  `);
  await f.db.execute(sql`
    CREATE TRIGGER foundry_test_interrupt_canary
    BEFORE UPDATE OF state ON foundry_bindings
    FOR EACH ROW WHEN (OLD.state = 'CANARY' AND NEW.state <> OLD.state)
    EXECUTE FUNCTION foundry_test_interrupt_canary()
  `);
}

async function resumeCanaryTransitions() {
  await f.db.execute(sql`DROP TRIGGER foundry_test_interrupt_canary ON foundry_bindings`);
  await f.db.execute(sql`DROP FUNCTION foundry_test_interrupt_canary()`);
}

// Interleave one independent writer after a pending-invocation SELECT completes
// but before the revoker consumes that selected snapshot. The actual DB row is
// changed through ordinary SQL; this does not mutate the returned stale object.
function afterInvocationRead(hook: (rows: unknown) => Promise<void>): typeof f.db {
  const wrap = (builder: object, invocationQuery = false): object =>
    new Proxy(builder, {
      get(target, property) {
        const member = Reflect.get(target, property, target) as unknown;
        if (typeof member !== "function") return member;
        if (property === "from")
          return (...args: unknown[]) =>
            wrap(Reflect.apply(member, target, args) as object, args[0] === schema.foundryInvocations);
        if (property === "where")
          return (...args: unknown[]) => wrap(Reflect.apply(member, target, args) as object, invocationQuery);
        if (property === "then" && invocationQuery) {
          return (onValue?: (value: unknown) => unknown, onError?: (error: unknown) => unknown) =>
            Promise.resolve(Reflect.apply(member, target, [(value: unknown) => value]) as PromiseLike<unknown>)
              .then(async (rows) => {
                await hook(rows);
                return rows;
              })
              .then(onValue, onError);
        }
        return member.bind(target);
      },
    });
  return new Proxy(f.db, {
    get(target, property) {
      const member = Reflect.get(target, property, target) as unknown;
      if (property === "select" && typeof member === "function")
        return (...args: unknown[]) => wrap(Reflect.apply(member, target, args) as object);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
}

describe("independent native Foundry adversarial regressions (SIMULATED external services)", () => {
  test("stale stage revision is rejected before any blob upload", async () => {
    const w = await ready();
    const seeded = await w.stage();
    const current = await candidate(w);
    const bundle = changedBundle(seeded.bundle, "2.0.0", () => undefined);
    const put = spyOn(f.platformBlobs, "put");
    await expect(
      w.service.stage(w.ctx, {
        candidateId: current.id,
        revision: current.revision - 1,
        bundle,
      }),
    ).rejects.toMatchObject({ code: "STALE_VERSION" });
    expect(put).not.toHaveBeenCalled();
    expect(await f.db.select().from(schema.foundryVersions)).toHaveLength(1);
  });

  test("exhausted repair budget rejects a new digest before any blob upload", async () => {
    const w = await ready();
    const seeded = await w.stage("1.0.0");
    await w.stage("1.0.1");
    await w.stage("1.0.2");
    await w.stage("1.0.3");
    const current = await candidate(w);
    const bundle = changedBundle(seeded.bundle, "1.0.4", () => undefined);
    const put = spyOn(f.platformBlobs, "put");
    await expect(
      w.service.stage(w.ctx, {
        candidateId: current.id,
        revision: current.revision,
        bundle,
      }),
    ).rejects.toMatchObject({ code: "REPAIR_LIMIT" });
    expect(put).not.toHaveBeenCalled();
    expect(await f.db.select().from(schema.foundryVersions)).toHaveLength(4);
  });

  test.each(["input", "output"] as const)(
    "a receipt-named package with a different %s contract is rejected before upload",
    async (side) => {
      const w = await ready();
      const seeded = await w.stage();
      const current = await candidate(w);
      const bundle = changedBundle(seeded.bundle, "2.0.0", (manifest) => {
        manifest.contracts[side] = { type: "string" };
      });
      const put = spyOn(f.platformBlobs, "put");
      let failure: unknown;
      try {
        await w.service.stage(w.ctx, { candidateId: current.id, revision: current.revision, bundle });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(typeof (failure as { code?: unknown } | undefined)?.code).toBe("string");
      expect(put).not.toHaveBeenCalled();
      expect(await f.db.select().from(schema.foundryVersions)).toHaveLength(1);
    },
  );

  test("task visibility alone does not authorize a non-assignee to propose", async () => {
    const w = await ready();
    await f.db
      .update(schema.issues)
      .set({
        assigneeType: "agent",
        assigneeId: crypto.randomUUID(),
      })
      .where(eq(schema.issues.id, w.task.id));
    await expect(w.service.propose(w.ctx, { needKey: "receipt-normalizer/v1" })).rejects.toMatchObject({
      code: "AUTHORITY_DENIED",
    });
    expect(await f.db.select().from(schema.foundryCandidates)).toHaveLength(0);
    expect(w.state.executions).toHaveLength(0);
    expect(w.state.evaluations).toBe(0);
  });

  test("a profile meeting the manifest ceilings still reaches simulated evaluation", async () => {
    const w = await ready();
    narrowSimulationProfile(w);
    const staged = await w.stage();
    expect(await w.lifecycle.evaluate(w.ctx, { candidateId: staged.candidateId, digest: staged.digest })).toMatchObject(
      { state: "REVIEW_READY" },
    );
    expect(w.state.evaluations).toBe(1);
    expect(w.state.executions).toHaveLength(0);
  });

  const limits = [
    { name: "wall time", field: "wallTimeMs", value: 1000, profile: {} },
    { name: "memory", field: "memoryMiB", value: 128, profile: {} },
    { name: "scratch disk", field: "scratchMiB", value: 16, profile: {} },
    { name: "process count", field: "processes", value: 1, profile: { maxProcesses: 2 } },
    { name: "log stream", field: "logBytesPerStream", value: 32768, profile: {} },
    { name: "serialized input", field: "inputBytes", value: 524288, profile: {} },
    { name: "serialized output", field: "resultBytes", value: 524288, profile: {} },
  ] as const;
  for (const limit of limits) {
    test(`a looser effective ${limit.name} profile cannot evaluate a stricter manifest`, async () => {
      const w = await ready();
      narrowSimulationProfile(w, limit.profile);
      const seeded = await w.stage();
      const current = await candidate(w);
      const bundle = changedBundle(seeded.bundle, "2.0.0", (manifest) => {
        if (!manifest.runtimeRequest) throw new Error("Expected a bounded pure-tool manifest.");
        manifest.runtimeRequest[limit.field] = limit.value;
      });
      const staged = await w.service.stage(w.ctx, {
        candidateId: current.id,
        revision: current.revision,
        bundle,
      });
      const oldRef = `simulation-evaluation/${seeded.digest}`;
      const receiptRef = `simulation-evaluation/${staged.digest}`;
      const previous = w.state.evidence.get(`${f.org.id}:${oldRef}`);
      if (!previous) throw new Error("Expected simulated protected evidence fixture.");
      w.state.evidence.set(`${f.org.id}:${receiptRef}`, {
        ...structuredClone(previous),
        receiptRef,
        digest: staged.digest,
      });
      const result = await w.lifecycle
        .evaluate(w.ctx, { candidateId: current.id, digest: staged.digest })
        .catch((error: unknown) => {
          expect(error).toBeInstanceOf(Error);
          expect(typeof (error as { code?: unknown }).code).toBe("string");
          return { state: "BLOCKED" };
        });
      expect(result.state).not.toBe("REVIEW_READY");
      expect(w.state.evaluations).toBe(0);
      expect(w.state.executions).toHaveLength(0);
      expect(await f.db.select().from(schema.foundryBindings)).toHaveLength(0);
    });
  }

  test("a persisted correct canary survives a crash before promotion and completes exactly once", async () => {
    const w = await ready();
    narrowSimulationProfile(w);
    const staged = await w.stage();
    const active = await w.activate(staged);
    await interruptCanaryTransition();
    await w.lifecycle
      .runCanary({ ...w.ctx, toolUseId: "crash-before-promotion" }, active.binding.id)
      .catch(() => undefined);
    const [terminal] = await bindingInvocations(active.binding.id);
    expect(terminal).toMatchObject({
      state: "SUCCEEDED",
      inputDigest: hashFoundryInput(CANARY_INPUT),
      resultDigest: hashFoundryInput(CANARY_OUTPUT),
    });
    expect((await binding(active.binding.id)).state).toBe("CANARY");
    expect(w.state.executions).toHaveLength(1);
    await resumeCanaryTransitions();
    const before = await nativeCounts(w.task.id);
    w.state.now = new Date(w.state.now.getTime() + 31_000);
    const restarted = w.makeLifecycle();
    await restarted.reconcile(f.org.id, terminal!.id);
    await restarted.reconcile(f.org.id, terminal!.id);
    expect((await binding(active.binding.id)).state).toBe("ACTIVE");
    expect(await bindingInvocations(active.binding.id)).toHaveLength(1);
    expect(w.state.executions).toHaveLength(1);
    expect(w.state.evaluations).toBe(1);
    expect(await nativeCounts(w.task.id)).toEqual({ ...before, activity: before.activity + 1 });
  }, 20_000);

  test("crash recovery does not promote a terminal canary after its exact native grant is canceled", async () => {
    const w = await ready();
    narrowSimulationProfile(w);
    const staged = await w.stage();
    const active = await w.activate(staged);
    await interruptCanaryTransition();
    await w.lifecycle
      .runCanary({ ...w.ctx, toolUseId: "crash-then-cancel-grant" }, active.binding.id)
      .catch(() => undefined);
    const [terminal] = await bindingInvocations(active.binding.id);
    expect(terminal?.state).toBe("SUCCEEDED");
    await resumeCanaryTransitions();
    await f.db.update(schema.approvals).set({ status: "canceled" }).where(eq(schema.approvals.id, active.approved.id));
    w.state.now = new Date(w.state.now.getTime() + 31_000);
    await w
      .makeLifecycle()
      .reconcile(f.org.id, terminal!.id)
      .catch(() => undefined);
    expect((await binding(active.binding.id)).state).not.toBe("ACTIVE");
    expect(await w.makeLifecycle().discover(w.ctx)).toEqual([]);
    expect(w.state.executions).toHaveLength(1);
  }, 20_000);

  test("a persisted incorrect B canary recovers rollback to authorized A once without reexecution", async () => {
    const w = await ready();
    narrowSimulationProfile(w);
    const a = await w.activate(await w.stage("1.0.0"));
    expect(await w.lifecycle.runCanary({ ...w.ctx, toolUseId: "verified-baseline-a" }, a.binding.id)).toMatchObject({
      outcome: "PASS",
    });
    const b = await w.activate(await w.stage("1.0.1"));
    w.state.mode = "wrong-output";
    await interruptCanaryTransition();
    await w.lifecycle
      .runCanary({ ...w.ctx, toolUseId: "crash-before-rollback-b" }, b.binding.id)
      .catch(() => undefined);
    const [terminal] = await bindingInvocations(b.binding.id);
    expect(terminal?.state).toBe("SUCCEEDED");
    expect(terminal?.inputDigest).toBe(hashFoundryInput(CANARY_INPUT));
    expect(terminal?.resultDigest).not.toBe(hashFoundryInput(CANARY_OUTPUT));
    expect((await binding(b.binding.id)).state).toBe("CANARY");
    expect((await binding(a.binding.id)).state).toBe("SUPERSEDED");
    await resumeCanaryTransitions();
    const before = await nativeCounts(w.task.id);
    w.state.now = new Date(w.state.now.getTime() + 31_000);
    const restarted = w.makeLifecycle();
    await restarted.reconcile(f.org.id, terminal!.id);
    await restarted.reconcile(f.org.id, terminal!.id);
    expect((await binding(b.binding.id)).state).toBe("QUARANTINED");
    expect((await binding(a.binding.id)).state).toBe("ACTIVE");
    expect(w.state.executions).toHaveLength(2);
    expect(w.state.evaluations).toBe(2);
    expect(await nativeCounts(w.task.id)).toEqual({ ...before, activity: before.activity + 1 });
  }, 20_000);

  test("a recovery worker losing its lease cannot quarantine B or restore A from a terminal canary", async () => {
    const w = await ready();
    narrowSimulationProfile(w);
    const a = await w.activate(await w.stage("1.0.0"));
    expect(await w.lifecycle.runCanary({ ...w.ctx, toolUseId: "lease-baseline-a" }, a.binding.id)).toMatchObject({
      outcome: "PASS",
    });
    const b = await w.activate(await w.stage("1.0.1"));
    w.state.mode = "wrong-output";
    await interruptCanaryTransition();
    await w.lifecycle
      .runCanary({ ...w.ctx, toolUseId: "lease-crash-before-rollback-b" }, b.binding.id)
      .catch(() => undefined);
    const [terminal] = await bindingInvocations(b.binding.id);
    expect(terminal?.state).toBe("SUCCEEDED");
    expect(terminal?.resultDigest).not.toBe(hashFoundryInput(CANARY_OUTPUT));
    expect((await binding(b.binding.id)).state).toBe("CANARY");
    expect((await binding(a.binding.id)).state).toBe("SUPERSEDED");
    await resumeCanaryTransitions();
    const before = await nativeCounts(w.task.id);
    w.state.now = new Date(w.state.now.getTime() + 31_000);
    let ownershipChecks = 0;
    await w.makeLifecycle().reconcile(f.org.id, terminal!.id, async () => {
      ownershipChecks++;
      // The worker owns the outbox claim and its initial canary check, then
      // loses the lease before the rollback transaction may change state.
      return ownershipChecks <= 2;
    });
    expect((await binding(b.binding.id)).state).toBe("CANARY");
    expect((await binding(a.binding.id)).state).toBe("SUPERSEDED");
    expect(await nativeCounts(w.task.id)).toEqual(before);
    expect(ownershipChecks).toBeGreaterThanOrEqual(3);
    expect((await bindingInvocations(b.binding.id)).map((row) => row.id)).toEqual([terminal!.id]);
    expect(w.state.executions).toHaveLength(2);
    expect(w.state.evaluations).toBe(2);
  }, 20_000);

  test("a stale RESERVED snapshot cannot claim cancellation after another writer dispatched", async () => {
    const w = await ready();
    narrowSimulationProfile(w);
    const staged = await w.stage();
    const active = await w.activate(staged);
    expect(
      await w.lifecycle.runCanary({ ...w.ctx, toolUseId: "baseline-before-revoke-race" }, active.binding.id),
    ).toMatchObject({ outcome: "PASS" });
    const current = await binding(active.binding.id);
    const [reservation] = await f.db
      .insert(schema.foundryInvocations)
      .values({
        orgId: f.org.id,
        bindingId: current.id,
        runId: w.ctx.runId,
        toolUseId: "reserved-revoke-interleaving",
        digest: staged.digest,
        inputDigest: hashFoundryInput(FRESH_INPUT),
        state: "RESERVED",
        fencingToken: 1,
        bindingGeneration: current.generation,
        leaseUntil: new Date(w.state.now.getTime() + 30_000),
      })
      .returning();
    if (!reservation) throw new Error("Expected native reservation fixture.");
    await f.db
      .update(schema.foundryBindings)
      .set({ reservedCalls: current.reservedCalls + 1 })
      .where(eq(schema.foundryBindings.id, current.id));
    let interleaved = false;
    const db = afterInvocationRead(async (rows) => {
      if (
        interleaved ||
        !Array.isArray(rows) ||
        !rows.some((row: unknown) => {
          if (!row || typeof row !== "object") return false;
          const selected = row as Record<string, unknown>;
          return selected.id === reservation.id && selected.state === "RESERVED";
        })
      )
        return;
      const changed = await f.db
        .update(schema.foundryInvocations)
        .set({ state: "DISPATCHED" })
        .where(and(eq(schema.foundryInvocations.id, reservation.id), eq(schema.foundryInvocations.state, "RESERVED")))
        .returning({ id: schema.foundryInvocations.id });
      interleaved = changed.length === 1;
    });
    const cancellations = w.state.cancellations;
    w.executor.cancel = async (invocationId, fencingToken) => {
      w.state.cancellations++;
      return {
        outcome: "UNKNOWN_OUTCOME",
        invocationId,
        fencingToken,
        receiptRef: null,
        reconciliationRef: invocationId,
      };
    };
    const revoker = createFoundryLifecycle({
      db,
      blobs: f.artifactDeps.blobs,
      executor: w.executor,
      evaluations: w.evaluations,
      now: () => new Date(w.state.now.getTime()),
    });
    await revoker.revoke({ ...w.ctx, toolUseId: "revoke-with-concurrent-dispatch" }, current.id);
    const [after] = await f.db
      .select()
      .from(schema.foundryInvocations)
      .where(eq(schema.foundryInvocations.id, reservation.id));
    if (interleaved) {
      expect(w.state.cancellations).toBe(cancellations + 1);
      expect(after?.state).toBe("UNKNOWN_OUTCOME");
    } else {
      // An implementation which atomically cancels before exposing the old
      // snapshot closes this schedule entirely, which is also safe.
      expect(after?.state).toBe("CANCELLED");
    }
    expect(w.state.executions).toHaveLength(1);
  }, 20_000);
});
