import { afterEach, expect, setSystemTime, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION } from "@agenteschat/adapters";
import { eq, schema, sql } from "@agenteschat/db";
import {
  type Brain,
  type BrainTurn,
  clearPlanLimits,
  createJobHandlers,
  createRoutine,
  drainOutbox,
  listRoutines,
  postPersonMessage,
  RESUME_AFTER_MS,
  RESUME_GAP_MS,
  runRoutineNow,
  usageQueue,
} from "../src";
import { executeRun } from "../src/executor";
import {
  consumeQuotaContinuity,
  quotaContinuityTranscript,
  quotaContinuityValue,
  readQuotaContinuity,
} from "../src/quota-continuity";
import { storedTranscript } from "../src/run-tools";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

let f: Fixture;
afterEach(async () => {
  setSystemTime();
  clearPlanLimits();
  await f?.close();
});

async function paused(
  options: {
    uncertain?: boolean;
    background?: boolean;
    resets?: boolean;
    seed?: boolean;
    malformedMetadata?: unknown;
    faultCapture?: boolean;
    concurrentCapture?: boolean;
    nullCapture?: boolean;
  } = {},
) {
  f = await setup({
    reply: () => {
      throw new Error("no inference allowed to create checkpoint");
    },
  });
  const machine = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, {
    name: "MacBook",
    hostname: "mac",
    os: "darwin",
    arch: "arm64",
    version: "0.8.0",
    protocol: MACHINE_PROTOCOL_VERSION,
    workspace: "/Users/w/agentes",
    exec: true,
  });
  await f.db
    .update(schema.agents)
    .set({ machineId: machine.machineId, brain: "claude_code" })
    .where(eq(schema.agents.id, f.agent.id));
  const now = Date.now();
  setSystemTime(new Date(now));
  const resetsAt = options.resets ? new Date(now + 150).toISOString() : undefined;
  const seen: BrainTurn[] = [];
  const publicationCapture = { version: 2, source: "trusted-synthetic", marker: "PRIVATE_PUBLICATION_SENTINEL" };
  const brain: Brain = {
    kind: "claude_code",
    async *run(turn) {
      seen.push(turn);
      if (seen.length === 1) {
        if (options.seed)
          await f.db
            .update(schema.agentRuns)
            .set({
              transcript: sql`jsonb_set(jsonb_set(${schema.agentRuns.transcript}, '{publicationCapture}', ${JSON.stringify(publicationCapture)}::jsonb), '{metadata}', '{"otherTrusted":{"version":7,"private":"KEEP"}}'::jsonb)`,
            })
            .where(eq(schema.agentRuns.id, turn.runId));
        if (options.nullCapture)
          await f.db
            .update(schema.agentRuns)
            .set({ transcript: sql`jsonb_set(${schema.agentRuns.transcript}, '{publicationCapture}', 'null'::jsonb)` })
            .where(eq(schema.agentRuns.id, turn.runId));
        if (Object.hasOwn(options, "malformedMetadata"))
          await f.db
            .update(schema.agentRuns)
            .set({
              transcript: sql`jsonb_set(${schema.agentRuns.transcript}, '{metadata}', ${JSON.stringify(options.malformedMetadata)}::jsonb)`,
            })
            .where(eq(schema.agentRuns.id, turn.runId));
        // The steps the bridge records for the two calls below: each call, then its result, named and marked
        // successful (a result with no recorded call, or not known to succeed, is no proof the call completed: the cut
        // would hold it as an unknown effect).
        const one = { command: "synthetic no actual command" };
        const two = { command: "synthetic second no actual command" };
        await f.db.insert(schema.agentRunSteps).values([
          {
            orgId: f.org.id,
            runId: turn.runId,
            seq: 28,
            kind: "tool_call",
            data: { toolUseId: "one", name: "Bash", input: one },
          },
          {
            orgId: f.org.id,
            runId: turn.runId,
            seq: 29,
            kind: "tool_call",
            data: { toolUseId: "two", name: "Bash", input: two },
          },
          {
            orgId: f.org.id,
            runId: turn.runId,
            seq: 30,
            kind: "tool_result",
            data: { toolUseId: "one", name: "Bash", content: "PRIVATE_TOOL_OUTPUT_SENTINEL", isError: false },
          },
          {
            orgId: f.org.id,
            runId: turn.runId,
            seq: 31,
            kind: "tool_result",
            data: { toolUseId: "two", name: "Bash", isError: false },
          },
        ]);
        yield { type: "usage", source: "plan", input: 1200, output: 80 };
        yield {
          type: "tool_call",
          id: "one",
          name: "Bash",
          input: { command: "synthetic no actual command" },
          executed: { content: "PRIVATE_TOOL_OUTPUT_SENTINEL" },
        };
        yield {
          type: "tool_call",
          id: "two",
          name: "Bash",
          input: { command: "synthetic second no actual command" },
          executed: { content: "returned" },
        };
        if (options.uncertain)
          await f.db.insert(schema.agentRunSteps).values({
            orgId: f.org.id,
            runId: turn.runId,
            seq: 90,
            kind: "tool_call",
            data: { toolUseId: "unknown_delivery" },
          });

        yield { type: "limit", ...(resetsAt ? { resetsAt } : {}) };
        yield { type: "error", code: "plan_limit", message: "synthetic plan limit", worked: true };
      } else {
        if (options.concurrentCapture)
          await f.db
            .update(schema.agentRuns)
            .set({
              transcript: sql`jsonb_set(jsonb_set(${schema.agentRuns.transcript}, '{publicationCapture}', '{"version":2,"revision":"CURRENT_FRESH"}'::jsonb), '{metadata,otherTrusted}', '{"revision":"CURRENT_FRESH"}'::jsonb)`,
            })
            .where(eq(schema.agentRuns.id, turn.runId));
        yield { type: "done", text: "synthetic resumed, no tools repeated" };
      }
    },
  };
  let captureFaults = 0;
  const db = options.faultCapture
    ? new Proxy(f.db, {
        get(target, key, receiver) {
          if (key === "select")
            return (fields: Parameters<typeof f.db.select>[0]) => {
              if (fields && "toolUseId" in fields && "error" in fields) {
                captureFaults++;
                return target.select({
                  seq: sql<number>`(select 1 / 0)`,
                  kind: schema.agentRunSteps.kind,
                  toolUseId: sql<string>`null`,
                  error: sql<boolean>`false`,
                });
              }
              return Reflect.get(target, key, receiver).call(target, fields);
            };
          return Reflect.get(target, key, receiver);
        },
      })
    : f.db;
  const deps = () => ({
    ...f.jobDeps,
    db,
    brains: { claude_code: () => brain },
    machines: {
      status: async (id: string) => ({
        id,
        orgId: f.org.id,
        name: "MacBook",
        online: true,
        execAllowed: true,
        os: "darwin",
        protocol: MACHINE_PROTOCOL_VERSION,
        executors: { claude: { version: "2.1.300", loggedIn: true }, detectedAt: new Date().toISOString() },
      }),
    },
    planLimitGraceMs: 50,
  });
  const handlers = () => createJobHandlers(deps());
  if (options.background) {
    const rd = { db: f.db, pubsub: f.pubsub, context: f.context };
    const routine = await createRoutine(rd, f.owner.id, f.org.id, {
      name: "Synthetic checkpoint",
      agentId: f.agent.id,
      prompt: "Synthetic bounded check.",
      target: { type: "channel", channelId: f.general.id },
      trigger: { type: "schedule", phrase: "todo dia às 8h" },
    });
    await runRoutineNow(rd, f.owner.id, f.org.id, routine.id);
  } else
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev synthetic bounded work",
    });
  await drainOutbox(f.db, handlers());
  const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.agentId, f.agent.id));
  if (!run) throw new Error("no run");
  return { run, now, seen, handlers, deps, publicationCapture, captureFaults: () => captureFaults };
}

test("S1-T01 native pause captures bounded receipt references without summary/JEV and merges current private metadata", async () => {
  const { run, publicationCapture } = await paused({ seed: true });
  expect(run.status).toBe("waiting_input");
  const t = run.transcript as Record<string, unknown>;
  const metadata = t.metadata as Record<string, unknown>;
  expect(metadata?.quotaContinuity).toMatchObject({
    version: 1,
    state: "captured",
    goal: { messageId: run.triggerMessageId, version: null },
    task: { issueId: null, version: null },
    nextSafeAction: "RESUME_SAME_HARNESS",
  });
  expect((metadata.quotaContinuity as { completedReceipts: unknown[] }).completedReceipts).toHaveLength(2);
  expect(metadata.otherTrusted).toEqual({ version: 7, private: "KEEP" });
  expect(t.publicationCapture).toEqual(publicationCapture);
  expect(JSON.stringify(metadata.quotaContinuity)).not.toContain("PRIVATE_TOOL_OUTPUT_SENTINEL");
  expect(JSON.stringify(metadata.quotaContinuity)).not.toContain("PRIVATE_PUBLICATION_SENTINEL");
  expect(f.provider.calls).toHaveLength(0);
});

test("S1-T02 missing native receipt projects reconciliation, without replaying any tool", async () => {
  const { run, seen } = await paused({ uncertain: true });
  const queue = await usageQueue(f.db, f.owner.id, f.org.id, f.agent.id);
  expect(queue.rows[0]).toHaveProperty("quotaContinuity");
  expect((queue.rows[0] as unknown as { quotaContinuity: unknown }).quotaContinuity).toMatchObject({
    nextSafeAction: "RECONCILE_EFFECT",
    unresolvedEffects: 1,
  });
  expect(seen).toHaveLength(1);
  expect(run.status).toBe("waiting_input");
});

test("S1-T03/T07 recreated native handlers consume the matching same-harness checkpoint and keep completed work", async () => {
  const { run, now, seen, handlers } = await paused({ resets: true });
  const before = (run.transcript?.metadata as Record<string, unknown> | undefined)?.quotaContinuity;
  expect(before).toHaveProperty("waitId");
  setSystemTime(new Date(now + 200));
  await drainOutbox(f.db, handlers(), { now: new Date(Date.now() + RESUME_AFTER_MS + RESUME_GAP_MS) });
  const [done] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run.id));
  expect(done?.status).toBe("done");
  expect((done?.transcript?.metadata as Record<string, unknown> | undefined)?.quotaContinuity).toMatchObject({
    state: "consumed",
    nextSafeAction: "RESUME_SAME_HARNESS",
  });
  expect(seen).toHaveLength(2);
  expect(seen[1]?.session?.id).toBe(seen[0]?.session?.id);
  expect(f.provider.calls).toHaveLength(0);
});

test("S1-T04 existing stale wait/cancel fences are inert; changed owner/harness never consumes checkpoint", async () => {
  const { run, seen, deps } = await paused();
  const cp = readQuotaContinuity(quotaContinuityValue(run.transcript));
  expect(cp).not.toBeNull();
  await executeRun(deps(), run.id, { finalAttempt: true, wait: crypto.randomUUID() });
  expect(seen).toHaveLength(1);
  const [agent] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, f.agent.id));
  if (!agent || !cp) throw new Error("fixture missing native records");
  const running = { ...run, status: "running" as const };
  const plan = {
    kind: "claude_code" as const,
    model: cp.route.model ?? undefined,
    session: { id: cp.route.sessionId ?? "", machineId: cp.route.machineId ?? "", cwd: "/synthetic", resume: true },
  };
  expect(consumeQuotaContinuity(cp, running, { ...agent, ownerUserId: "another-owner" }, plan, cp.waitId)).toBeNull();
  expect(consumeQuotaContinuity(cp, running, agent, { kind: "model" }, cp.waitId)).toBeNull();
  await f.db.update(schema.agentRuns).set({ status: "canceled" }).where(eq(schema.agentRuns.id, run.id));
  await executeRun(deps(), run.id, { finalAttempt: true, wait: cp.waitId });
  expect(seen).toHaveLength(1);
  expect((await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run.id)))[0]?.status).toBe(
    "canceled",
  );
});

test("S1-T05 queue checkpoint projection stays behind current native conversation ACL", async () => {
  await paused();
  const outsider = await addMember(f.db, f.org.id, "member", "outsider");
  const allowed = await usageQueue(f.db, f.owner.id, f.org.id, f.agent.id);
  expect(allowed.rows[0]).toHaveProperty("quotaContinuity");
  const denied = await usageQueue(f.db, outsider.id, f.org.id, f.agent.id);
  expect(denied).toMatchObject({ rows: [], hidden: 1 });
  expect(JSON.stringify(denied)).not.toContain("quotaContinuity");
  expect(JSON.stringify(allowed.rows[0]?.quotaContinuity)).not.toContain("sessionId");
  expect(JSON.stringify(allowed.rows[0]?.quotaContinuity)).not.toContain("PRIVATE");
});

test("S1-T06 missing quota telemetry stays unknown, not a percentage/reset entitlement", async () => {
  const { run } = await paused();
  const cp = readQuotaContinuity(quotaContinuityValue(run.transcript));
  expect(cp?.quota).toEqual({ usedPercent: null, resetsAt: null });
  expect(cp?.constraints).toBeNull();
  expect(cp?.reviewers).toBeNull();
  expect(cp?.dependencies).toBeNull();
  expect(cp?.code).toBe("plan_limit");
  expect(cp?.goal).toEqual({ messageId: run.triggerMessageId, version: null });
});

test("S1-T08 real background routine pause creates checkpoint without fallback or summary", async () => {
  const { run } = await paused({ background: true });
  expect(run.background).toBe(true);
  expect(run.status).toBe("waiting_input");
  expect(readQuotaContinuity(quotaContinuityValue(run.transcript))?.state).toBe("captured");
  expect(f.provider.calls).toHaveLength(0);
  expect((await listRoutines(f.db, f.owner.id, f.org.id))[0]?.state).toBe("usage_paused");
  expect(
    await f.db.select().from(schema.notifications).where(eq(schema.notifications.kind, "routine_waiting_plan")),
  ).toHaveLength(1);
});

test("S1-T09 legacy waits project null and retain existing safe same-session resume", async () => {
  const { run, now, handlers, seen } = await paused({ resets: true });
  await f.db
    .update(schema.agentRuns)
    .set({ transcript: sql`${schema.agentRuns.transcript} #- '{metadata,quotaContinuity}'` })
    .where(eq(schema.agentRuns.id, run.id));
  expect((await usageQueue(f.db, f.owner.id, f.org.id, f.agent.id)).rows[0]?.quotaContinuity).toBeNull();
  setSystemTime(new Date(now + 200));
  await drainOutbox(f.db, handlers(), { now: new Date(Date.now() + RESUME_AFTER_MS + RESUME_GAP_MS) });
  const [done] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run.id));
  expect(done?.status).toBe("done");
  expect(quotaContinuityValue(done?.transcript)).toBeUndefined();
  expect(seen[1]?.session?.id).toBe(seen[0]?.session?.id);
});

test("S1-T10 actual evidence SQL failure leaves the original wait/timer intact and no false checkpoint", async () => {
  const { run, captureFaults } = await paused({ faultCapture: true });
  expect(captureFaults()).toBe(1);
  expect(run.status).toBe("waiting_input");
  expect(readQuotaContinuity(quotaContinuityValue(run.transcript))).toBeNull();
  const wait = run.transcript?.waitingForBrain as { waitId: string };
  const jobs = await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, "agent_run.execute"));
  expect(jobs.filter((j) => j.payload.runId === run.id && j.payload.wait === wait.waitId)).toHaveLength(1);
  expect((await usageQueue(f.db, f.owner.id, f.org.id, f.agent.id)).rows[0]?.quotaContinuity).toBeNull();
});

test("S1-T10b namespace SQL abort rolls back metadata and publicationCapture; bounded reader rejects bad records", async () => {
  const { run } = await paused();
  const cp = readQuotaContinuity(quotaContinuityValue(run.transcript));
  if (!cp) throw new Error("no checkpoint");
  await f.db
    .update(schema.agentRuns)
    .set({
      transcript: sql`jsonb_set(jsonb_set(${schema.agentRuns.transcript}, '{publicationCapture}', '{"version":2,"revision":"ROLLBACK_KEEP"}'::jsonb), '{metadata,otherTrusted}', '{"revision":"ROLLBACK_KEEP"}'::jsonb)`,
    })
    .where(eq(schema.agentRuns.id, run.id));
  const [seeded] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run.id));
  const before = JSON.stringify(seeded?.transcript);
  await expect(
    f.db.transaction(async (tx) => {
      await tx
        .update(schema.agentRuns)
        .set({ transcript: quotaContinuityTranscript(storedTranscript({}), { ...cp, state: "consumed" }) })
        .where(eq(schema.agentRuns.id, run.id));
      await tx.execute(sql`select 1 / 0`);
    }),
  ).rejects.toThrow();
  const [after] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run.id));
  expect(JSON.stringify(after?.transcript)).toBe(before);
  expect(after?.transcript?.publicationCapture).toEqual({ version: 2, revision: "ROLLBACK_KEEP" });
  expect(readQuotaContinuity({ ...cp, version: 2 })).toBeNull();
  expect(readQuotaContinuity({ ...cp, untrustedHuge: "測".repeat(6000) })).toBeNull();
});

test("namespace SQL merges CURRENT unrelated keys and present-null capture instead of stale copies", async () => {
  const { run } = await paused();
  const cp = readQuotaContinuity(quotaContinuityValue(run.transcript));
  if (!cp) throw new Error("no checkpoint");
  await f.db
    .update(schema.agentRuns)
    .set({
      transcript: sql`jsonb_set(jsonb_set(${schema.agentRuns.transcript}, '{publicationCapture}', 'null'::jsonb), '{metadata,otherTrusted}', '{"revision":"CURRENT"}'::jsonb)`,
    })
    .where(eq(schema.agentRuns.id, run.id));
  const stale = {
    ...run.transcript,
    metadata: { otherTrusted: { revision: "STALE" } },
    publicationCapture: { version: 2, revision: "STALE" },
  };
  await f.db
    .update(schema.agentRuns)
    .set({ transcript: quotaContinuityTranscript(storedTranscript(stale), cp) })
    .where(eq(schema.agentRuns.id, run.id));
  const [current] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run.id));
  expect(current?.transcript).toHaveProperty("publicationCapture", null);
  expect((current?.transcript?.metadata as Record<string, unknown>)?.otherTrusted).toEqual({ revision: "CURRENT" });
  expect(readQuotaContinuity(quotaContinuityValue(current?.transcript))?.waitId).toBe(cp.waitId);
});

test.each([null, "UNKNOWN_METADATA", ["unknown"]])(
  "metadata present but unsupported (%j) is preserved with unknown projection",
  async (metadata) => {
    const { run } = await paused({ malformedMetadata: metadata });
    expect(run.status).toBe("waiting_input");
    expect(run.transcript?.metadata).toEqual(metadata);
    expect((await usageQueue(f.db, f.owner.id, f.org.id, f.agent.id)).rows[0]?.quotaContinuity).toBeNull();
  },
);

test("publicationCapture CURRENT fresh revision and unrelated metadata survive pause/resume ordinary saves", async () => {
  const { run, now, handlers } = await paused({ seed: true, resets: true, concurrentCapture: true });
  setSystemTime(new Date(now + 200));
  await drainOutbox(f.db, handlers(), { now: new Date(Date.now() + RESUME_AFTER_MS + RESUME_GAP_MS) });
  const [done] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run.id));
  expect(done?.transcript?.publicationCapture).toEqual({ version: 2, revision: "CURRENT_FRESH" });
  expect((done?.transcript?.metadata as Record<string, unknown>)?.otherTrusted).toEqual({ revision: "CURRENT_FRESH" });
});

test("CURRENT publicationCapture null key survives native ordinary pause and resume saves", async () => {
  const { run, now, handlers } = await paused({ nullCapture: true, resets: true });
  expect(run.transcript).toHaveProperty("publicationCapture", null);
  setSystemTime(new Date(now + 200));
  await drainOutbox(f.db, handlers(), { now: new Date(Date.now() + RESUME_AFTER_MS + RESUME_GAP_MS) });
  const [done] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run.id));
  expect(done?.transcript).toHaveProperty("publicationCapture", null);
});
