import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  activeRunsIn,
  addRunStep,
  canTransition,
  executeRun,
  InvalidRunTransitionError,
  RUN_TRANSITIONS,
  type RunStatus,
  storedTranscript,
  transitionRun,
} from "../src";
import { type Fixture, setup } from "./fixtures";

describe("state machine", () => {
  test("allowed transitions", () => {
    const all = Object.keys(RUN_TRANSITIONS) as RunStatus[];
    const edges = all.flatMap((from) => all.filter((to) => canTransition(from, to)).map((to) => `${from}->${to}`));
    expect(edges.sort()).toEqual(
      [
        "queued->running",
        "queued->failed",
        "running->waiting_approval",
        "running->done",
        "running->failed",
        "waiting_approval->running",
        "waiting_approval->failed",
        "running->waiting_input",
        "waiting_input->running",
        "waiting_input->failed",
        "queued->canceled",
        "running->canceled",
        "waiting_approval->canceled",
        "waiting_input->canceled",
      ].sort(),
    );
  });
});

describe("transitionRun", () => {
  let f: Fixture;
  let runId: string;
  beforeEach(async () => {
    f = await setup();
    const [run] = await f.db
      .insert(schema.agentRuns)
      .values({
        orgId: f.org.id,
        agentId: f.agent.id,
        channelId: f.general.id,
        threadRootId: crypto.randomUUID(),
        triggerMessageId: crypto.randomUUID(),
        trigger: "mention",
        hop: 1,
      })
      .returning();
    runId = run?.id ?? "";
  });
  afterEach(() => f.close());

  test("walks the happy path with an approval pause, stamping times", async () => {
    const running = await transitionRun(f.db, runId, "queued", "running");
    expect(running?.startedAt).toBeInstanceOf(Date);
    await transitionRun(f.db, runId, "running", "waiting_approval");
    const resumed = await transitionRun(f.db, runId, "waiting_approval", "running");
    expect(resumed?.startedAt?.getTime()).toBe(running?.startedAt?.getTime() ?? 0);
    const done = await transitionRun(f.db, runId, "running", "done");
    expect(done?.status).toBe("done");
    expect(done?.finishedAt).toBeInstanceOf(Date);
  });

  test("the work it is doing now: a first start counts from its creation, a return to work from that moment", async () => {
    const created = new Date(Date.now() - 120_000);
    await f.db.update(schema.agentRuns).set({ createdAt: created }).where(eq(schema.agentRuns.id, runId));
    const working = async () => (await activeRunsIn(f.db, f.org.id, f.general.id)).find((r) => r.runId === runId);
    // Queued, then started: no moment of its own yet, so the person who wrote to it counts from their message.
    const started = await transitionRun(f.db, runId, "queued", "running");
    expect(started?.workingSince).toBeNull();
    expect((await working())?.workingMs).toBeGreaterThanOrEqual(120_000);
    // Back from a wait (an approval, an answer): it counts from now, and its first start stays where it was.
    await transitionRun(f.db, runId, "running", "waiting_input");
    const resumed = await transitionRun(f.db, runId, "waiting_input", "running");
    expect(resumed?.workingSince).toBeInstanceOf(Date);
    expect(resumed?.startedAt?.getTime()).toBe(started?.startedAt?.getTime() ?? 0);
    const now = await working();
    expect(now?.workingMs).toBeLessThan(60_000);
    expect(now?.startedAt).toBe(started?.startedAt?.toISOString() ?? "");
  });

  test("compare-and-set: a stale `from` changes nothing", async () => {
    await transitionRun(f.db, runId, "queued", "running");
    expect(await transitionRun(f.db, runId, "queued", "running")).toBeNull();
  });

  test("a resume claim atomically refuses a persisted unknown-effect marker", async () => {
    await transitionRun(f.db, runId, "queued", "running");
    await transitionRun(f.db, runId, "running", "waiting_approval", {
      transcript: { effectUncertain: { runId, turn: 1, tools: ["write_file"] } },
    });
    const claimed = await transitionRun(f.db, runId, "waiting_approval", "running", { requireNoUnknownEffect: true });
    expect(claimed).toBeNull();
    const [row] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, runId));
    expect(row?.status).toBe("waiting_approval");
    expect(row?.transcript).toMatchObject({ effectUncertain: { runId } });
    await f.db
      .update(schema.agentRuns)
      .set({ transcript: storedTranscript({ system: [], messages: [] }) })
      .where(eq(schema.agentRuns.id, runId));
    const [afterStaleSave] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, runId));
    expect(afterStaleSave?.transcript).toMatchObject({ effectUncertain: { runId } });
  });

  test("a matching timer still cannot claim a run with an unknown-effect marker", async () => {
    await transitionRun(f.db, runId, "queued", "running");
    await transitionRun(f.db, runId, "running", "waiting_input", {
      transcript: { waitingForBrain: { waitId: "wait-Y" }, effectUncertain: { runId, turn: 1, tools: ["write_file"] } },
    });
    const claimed = await transitionRun(
      f.db,
      runId,
      "waiting_input",
      "running",
      { requireNoUnknownEffect: true },
      { waitId: "wait-Y" },
    );
    expect(claimed).toBeNull();
    const [row] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, runId));
    expect(row?.status).toBe("waiting_input");
    expect(row?.transcript).toMatchObject({ waitingForBrain: { waitId: "wait-Y" }, effectUncertain: { runId } });
  });

  test("a stale wait claim cannot consume a newer wait on the same run", async () => {
    await transitionRun(f.db, runId, "queued", "running");
    await transitionRun(f.db, runId, "running", "waiting_input", {
      transcript: { waitingForBrain: { waitId: "wait-X" } },
    });
    // An old timer read X, but another worker claimed X and parked the run again on Y.
    await transitionRun(f.db, runId, "waiting_input", "running");
    await transitionRun(f.db, runId, "running", "waiting_input", {
      transcript: { waitingForBrain: { waitId: "wait-Y" } },
    });
    expect(await transitionRun(f.db, runId, "waiting_input", "running", {}, { waitId: "wait-X" })).toBeNull();
    const [stillWaiting] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, runId));
    expect(stillWaiting?.status).toBe("waiting_input");
    expect(await transitionRun(f.db, runId, "waiting_input", "running", {}, { waitId: "wait-Y" })).toMatchObject({
      status: "running",
    });
  });

  test("concurrent claims for one wait admit only one worker", async () => {
    await transitionRun(f.db, runId, "queued", "running");
    await transitionRun(f.db, runId, "running", "waiting_input", {
      transcript: { waitingForBrain: { waitId: "same-wait" } },
    });
    const claims = await Promise.all([
      transitionRun(f.db, runId, "waiting_input", "running", {}, { waitId: "same-wait" }),
      transitionRun(f.db, runId, "waiting_input", "running", {}, { waitId: "same-wait" }),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.filter((claim) => claim === null)).toHaveLength(1);
  });

  test("a wait claim matches the outage waitId and preserves brain-wait precedence", async () => {
    await transitionRun(f.db, runId, "queued", "running");
    await transitionRun(f.db, runId, "running", "waiting_input", {
      transcript: { outage: { waitId: "outage-Y" } },
    });
    expect(await transitionRun(f.db, runId, "waiting_input", "running", {}, { waitId: "outage-X" })).toBeNull();
    expect(await transitionRun(f.db, runId, "waiting_input", "running", {}, { waitId: "outage-Y" })).toMatchObject({
      status: "running",
    });
    await transitionRun(f.db, runId, "running", "waiting_input", {
      transcript: { waitingForBrain: { waitId: "brain-Y" }, outage: { waitId: "outage-Y" } },
    });
    expect(await transitionRun(f.db, runId, "waiting_input", "running", {}, { waitId: "outage-Y" })).toBeNull();
    expect(await transitionRun(f.db, runId, "waiting_input", "running", {}, { waitId: "brain-Y" })).toMatchObject({
      status: "running",
    });
  });

  test("executor cannot claim a replacement wait after reading the older timer", async () => {
    await transitionRun(f.db, runId, "queued", "running");
    await transitionRun(f.db, runId, "running", "waiting_input", {
      transcript: { waitingForBrain: { code: "plan_limit", waitId: "wait-X" } },
    });
    let raced = false;
    // Inject the interleaving at the database boundary: the initial SELECT returns X, then another worker has parked Y.
    // Only this selection is intercepted; all actual writes and the claim use the real fixture database.
    const db = new Proxy(f.db, {
      get(target, key) {
        if (key !== "select") {
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (...args: unknown[]) => {
          const select = Reflect.apply(target.select, target, args) as {
            from: (...a: unknown[]) => { where: (...w: unknown[]) => Promise<unknown> };
          };
          const fields = args[0] as Record<string, unknown> | undefined;
          if (!fields || !("waitId" in fields) || !("busyRetries" in fields)) return select;
          const from = select.from.bind(select);
          select.from = (...a: unknown[]) => {
            const builder = from(...a);
            const where = builder.where.bind(builder);
            builder.where = async (...w: unknown[]) => {
              const rows = await where(...w);
              raced = true;
              await f.db
                .update(schema.agentRuns)
                .set({
                  transcript: { waitingForBrain: { code: "plan_limit", waitId: "wait-Y" } },
                })
                .where(eq(schema.agentRuns.id, runId));
              return rows;
            };
            return builder;
          };
          return select;
        };
      },
    });
    let thrown: unknown;
    try {
      await executeRun({ ...f.jobDeps, db }, runId, { finalAttempt: false, wait: "wait-X" });
    } catch (error) {
      thrown = error;
    }
    expect(raced).toBe(true);
    const [row] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, runId));
    expect(row?.status).toBe("waiting_input");
    expect(row?.transcript).toEqual({ waitingForBrain: { code: "plan_limit", waitId: "wait-Y" } });
    expect(thrown).toBeUndefined();
    expect(f.provider.calls).toHaveLength(0);
  });

  test("illegal transitions throw before touching the database", async () => {
    await expect(transitionRun(f.db, runId, "queued", "done")).rejects.toBeInstanceOf(InvalidRunTransitionError);
    await expect(transitionRun(f.db, runId, "done", "running")).rejects.toBeInstanceOf(InvalidRunTransitionError);
    const [row] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, runId));
    expect(row?.status).toBe("queued");
  });

  test("steps are numbered in order", async () => {
    const run = { id: runId, orgId: f.org.id };
    await addRunStep(f.db, run, "context", { a: 1 });
    await addRunStep(f.db, run, "model_call", { b: 2 });
    const steps = await f.db.select().from(schema.agentRunSteps).where(eq(schema.agentRunSteps.runId, runId));
    expect(steps.map((s) => [s.seq, s.kind])).toEqual([
      [1, "context"],
      [2, "model_call"],
    ]);
  });

  test("a step that loses the race for its number takes the next one instead of failing the run", async () => {
    const run = { id: runId, orgId: f.org.id };
    let lost = 0;
    const racing = {
      insert: (table: typeof schema.agentRunSteps) =>
        lost++ === 0
          ? { values: () => ({ onConflictDoNothing: () => ({ returning: async () => [] }) }) }
          : f.db.insert(table),
    } as unknown as typeof f.db;
    await addRunStep(racing, run, "context", {});
    expect(lost).toBe(2);
    const steps = await f.db.select().from(schema.agentRunSteps).where(eq(schema.agentRunSteps.runId, runId));
    expect(steps.map((s) => s.seq)).toEqual([1]);
  });
});
