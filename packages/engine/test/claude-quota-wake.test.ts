import { afterEach, expect, test } from "bun:test";
import type { PlanUsage } from "@agenteschat/adapters";
import { and, eq, schema, sql } from "@agenteschat/db";
import { clearPlanLimits, notePlanLimit, planLimitOf } from "../src/brains/select";
import { usageWaitKey, wakeOnRoom } from "../src/usage-pause";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  clearPlanLimits();
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});
const reading = (at: number): PlanUsage => ({
  windows: [
    { kind: "seven_day", usedPercent: 81, resetsAt: new Date(at + 3 * 86_400_000).toISOString() },
    { kind: "other", label: "Fable", usedPercent: 100, resetsAt: new Date(at + 4 * 86_400_000).toISOString() },
  ],
  source: "probe",
  at: new Date(at).toISOString(),
});

test.each([false, true])(
  "Claude quota wakes eligible waits beyond a full page of Fable waits and keeps safety fences: microseconds %s",
  async (microseconds) => {
    f = await setup();
    const machineId = crypto.randomUUID();
    const key = usageWaitKey({ code: "plan_limit", machineId, kind: "claude_code" });
    const now = Date.now();
    await f.db
      .update(schema.agents)
      .set({ brain: "claude_code", brainModel: "sonnet" })
      .where(eq(schema.agents.id, f.agent.id));
    const parked = (
      model: string | null,
      order: number,
      over: {
        hold?: boolean;
        scope?: string;
        steady?: boolean;
        parkedAt?: number;
        key?: string;
        done?: boolean;
      } = {},
    ) => {
      const trigger = crypto.randomUUID();
      return {
        orgId: f.org.id,
        agentId: f.agent.id,
        channelId: f.general.id,
        threadRootId: trigger,
        triggerMessageId: trigger,
        trigger: "mention" as const,
        hop: 1,
        status: over.done ? ("done" as const) : ("waiting_input" as const),
        createdAt:
          microseconds && model === "claude-fable-5"
            ? sql`'2026-11-19T18:00:00.123456Z'::timestamptz`
            : new Date(now - 7200_000 + order),
        transcript: {
          waitingForBrain: {
            kind: "claude_code",
            machineId,
            code: "plan_limit",
            model,
            waitId: crypto.randomUUID(),
            waitKey: over.key ?? key,
            until: new Date(now + 86_400_000).toISOString(),
            ...(over.scope ? { scope: over.scope } : {}),
            ...(over.steady ? { steady: true } : {}),
          },
          usageWait: { since: now - 3600_000 + order, step: 0, parkedAt: over.parkedAt ?? now - 60_000 },
          ...(over.hold ? { continuityCheckpoint: { dispatch: "hold" } } : {}),
        } as never,
      };
    };
    await f.db
      .insert(schema.agentRuns)
      .values(Array.from({ length: microseconds ? 99 : 101 }, (_, i) => parked("claude-fable-5", i)));
    await f.db
      .insert(schema.agentRuns)
      .values([
        parked("sonnet", 110, { hold: true }),
        ...["model", "region", "off", "inactive"].map((scope, i) => parked("sonnet", 111 + i, { scope })),
        parked("sonnet", 116, { parkedAt: now }),
        parked("sonnet", 117, { steady: true }),
        parked("sonnet", 118, { key: "another-sign-in" }),
        parked("sonnet", 119, { done: true }),
      ]);
    const eligible = await f.db
      .insert(schema.agentRuns)
      .values([
        ...(microseconds
          ? [{ ...parked("sonnet", 120), createdAt: sql`'2026-11-19T18:00:00.123456Z'::timestamptz` }]
          : []),
        parked("sonnet", 120),
        parked(null, 121),
      ])
      .returning({ id: schema.agentRuns.id });
    const expected = eligible.map((r) => r.id);
    expect(await wakeOnRoom(f.db, f.org.id, machineId, "claude_code", undefined, reading(now), now)).toEqual(expected);
    const jobs = await f.db
      .select()
      .from(schema.outbox)
      .where(and(eq(schema.outbox.kind, "agent_run.execute"), eq(schema.outbox.status, "pending")))
      .orderBy(schema.outbox.nextAttemptAt);
    expect(jobs.map((j) => j.payload.runId)).toEqual(expected);
    expect(Number(jobs[1]?.nextAttemptAt) - Number(jobs[0]?.nextAttemptAt)).toBe(60_000);
    await wakeOnRoom(f.db, f.org.id, machineId, "claude_code", undefined, reading(now), now);
    expect(await f.db.select().from(schema.outbox)).toHaveLength(expected.length);
  },
  5000,
);

test("Claude quota clears an actual account refusal only with a strictly newer applicable room reading", async () => {
  f = await setup();
  const machineId = crypto.randomUUID();
  const now = Date.now();
  const seen = now - 1000;
  const reset = new Date(now + 3600_000).toISOString();
  for (const [delta, held] of [
    [-1, true],
    [0, true],
    [1, false],
  ] as const) {
    clearPlanLimits();
    notePlanLimit(machineId, "claude_code", reset, seen);
    await wakeOnRoom(f.db, f.org.id, machineId, "claude_code", undefined, reading(seen + delta), now);
    expect(Boolean(planLimitOf(machineId, "claude_code", undefined, undefined, now, "sonnet"))).toBe(held);
  }
  const fresh = reading(now);
  for (const blocked of [
    { ...fresh, limited: true },
    { ...fresh, windows: [{ kind: "seven_day" as const, usedPercent: 100, resetsAt: reset }] },
    { ...fresh, at: "invalid" },
  ]) {
    notePlanLimit(machineId, "claude_code", reset, seen);
    await wakeOnRoom(f.db, f.org.id, machineId, "claude_code", undefined, blocked, now);
    expect(planLimitOf(machineId, "claude_code", undefined, undefined, now, "sonnet")).not.toBeNull();
  }
  clearPlanLimits();
  notePlanLimit(machineId, "claude_code", reset, seen);
  await wakeOnRoom(f.db, f.org.id, machineId, "claude_code", "another-account", fresh, now);
  expect(planLimitOf(machineId, "claude_code", undefined, undefined, now, "sonnet")).not.toBeNull();
  await wakeOnRoom(f.db, f.org.id, machineId, "claude_code", undefined, fresh, now);
  expect(planLimitOf(machineId, "claude_code", undefined, fresh, now, "sonnet")).toBeNull();
  expect(planLimitOf(machineId, "claude_code", undefined, fresh, now, "claude-fable-5")).not.toBeNull();
});
