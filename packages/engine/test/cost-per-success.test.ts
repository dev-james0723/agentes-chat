import { afterEach, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import { contractHash, contractOf, costPerSuccess, OUTCOME_KINDS, type OutcomeKind } from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

/**
 * Cost per independently verified successful task (ADR 0207), measurement only: a success is a task an independent
 * verifier confirmed against its completion contract (`task_verified`, ADR 0211) and that nobody reopened or rejected
 * since. Every finished run counts toward cost; unknown cost stays unknown, never 0.
 */

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const NANO = 1_000_000_000;
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

async function run(
  opts: { issueId?: string; status?: "done" | "failed" | "canceled" | "running"; brain?: string; at?: Date } = {},
) {
  const [message] = await f.db
    .insert(schema.messages)
    .values({ orgId: f.org.id, channelId: f.general.id, authorType: "person", authorUserId: f.owner.id, body: "go" })
    .returning();
  if (!message) throw new Error("no message");
  const [row] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: message.id,
      triggerMessageId: message.id,
      trigger: "mention",
      hop: 1,
      status: opts.status ?? "done",
      issueId: opts.issueId ?? null,
      brain: opts.brain ?? null,
      createdAt: opts.at ?? minutesAgo(30),
    })
    .returning();
  if (!row) throw new Error("no run");
  return row.id;
}

async function usage(runId: string, opts: { usd?: number; billedTo?: string; model?: string; tokens?: number } = {}) {
  await f.db.insert(schema.usageRecords).values({
    orgId: f.org.id,
    agentId: f.agent.id,
    runId,
    provider: "anthropic",
    model: opts.model ?? "claude-sonnet-5-5",
    requestedModel: opts.model ?? "claude-sonnet-5-5",
    inputTokens: opts.tokens ?? 100,
    outputTokens: 0,
    costNanoUsd: Math.round((opts.usd ?? 0) * NANO),
    billedTo: opts.billedTo ?? "org",
  });
}

/** A task with no row and no contract: the default contract over no criteria, as `costPerSuccess` reads it. */
const DEFAULT_HASH = contractHash(contractOf(null), []);

async function outcome(
  kind: Extract<OutcomeKind, "task_verified" | "task_rejected" | "criteria_met" | "issue_reopened" | "issue_closed">,
  issueId: string,
  at: Date,
  extra: Record<string, unknown> = {},
) {
  await f.db.insert(schema.outcomes).values({
    orgId: f.org.id,
    agentId: f.agent.id,
    kind,
    polarity: OUTCOME_KINDS[kind],
    subject: "issue#1",
    details: {
      issueId,
      by: { type: "person", id: "verifier" },
      contractHash: DEFAULT_HASH,
      checkedBy: [{ type: "person", id: "x" }],
      ...extra,
    },
    source: "issue",
    createdAt: at,
  });
}

const report = () => costPerSuccess(f.db, f.owner.id, f.org.id, { from: minutesAgo(24 * 60), to: new Date() });
const only = async () => {
  const r = await report();
  expect(r.groups).toHaveLength(1);
  return r.groups[0]!;
};

test("a person-verified task is a success; its cost is every finished run on it, retries included", async () => {
  f = await setup();
  const task = crypto.randomUUID();
  const first = await run({ issueId: task, status: "failed", at: minutesAgo(50) });
  await usage(first, { usd: 0.4 });
  const second = await run({ issueId: task, at: minutesAgo(40) });
  await usage(second, { usd: 0.6, tokens: 300 });
  await outcome("task_verified", task, minutesAgo(10));

  const g = await only();
  expect(g).toMatchObject({
    agentId: f.agent.id,
    brain: "api",
    model: "claude-sonnet-5-5",
    runs: 2,
    failedRuns: 1,
    retries: 1,
    verifiedSuccesses: 1,
    tokens: 400,
    costUsd: 1,
    unknownCostRuns: 0,
    costPerSuccessUsd: 1,
    missing: null,
  });
  expect(g.text).toContain("US$1.00");
});

test("negative control: a task marked done, or ticked by people, with no independent verifier is no success", async () => {
  f = await setup();
  const task = crypto.randomUUID();
  await usage(await run({ issueId: task }), { usd: 0.5 });
  await outcome("issue_closed", task, minutesAgo(6), { by: { type: "agent", id: f.agent.id }, claim: true });
  // People ticking every criterion is evidence, not the verifier's verdict (ADR 0211).
  const other = crypto.randomUUID();
  await usage(await run({ issueId: other }), { usd: 0.5 });
  await outcome("criteria_met", other, minutesAgo(5));

  const g = await only();
  expect(g.verifiedSuccesses).toBe(0);
  expect(g.costUsd).toBe(1);
  expect(g.costPerSuccessUsd).toBeNull();
  expect(g.missing).toBe("no_success");
});

test("negative control: a reopened task loses its success; verified again, it counts again", async () => {
  f = await setup();
  const task = crypto.randomUUID();
  await usage(await run({ issueId: task, at: minutesAgo(60) }), { usd: 0.3 });
  await outcome("task_verified", task, minutesAgo(20));
  await outcome("issue_reopened", task, minutesAgo(15));
  expect((await only()).verifiedSuccesses).toBe(0);

  await outcome("task_verified", task, minutesAgo(1));
  expect((await only()).verifiedSuccesses).toBe(1);
});

test("negative control: unknown cost stays unknown, never 0", async () => {
  f = await setup();
  const task = crypto.randomUUID();
  // A plan turn records no price; a finished run with no usage row has no known cost either.
  await usage(await run({ issueId: task, brain: "claude_code" }), { billedTo: "plan", usd: 0 });
  await run({ issueId: task, brain: "claude_code" });
  await outcome("task_verified", task, minutesAgo(1));

  const r = await report();
  expect(r.groups).toHaveLength(2);
  expect(r.groups.every((g) => g.costUsd === null)).toBe(true);
  const g = r.total;
  expect(g.verifiedSuccesses).toBe(1);
  expect(g.unknownCostRuns).toBe(2);
  expect(g.costUsd).toBeNull();
  expect(g.costPerSuccessUsd).toBeNull();
  expect(g.missing).toBe("unknown_cost");
  expect(g.text).toContain("未知");
});

test("no division by zero: no runs, no successes", async () => {
  f = await setup();
  const empty = await report();
  expect(empty.groups).toEqual([]);
  expect(empty.total.costPerSuccessUsd).toBeNull();
  expect(Number.isFinite(empty.total.runs)).toBe(true);

  await usage(await run(), { usd: 0 });
  const g = await only();
  expect(g.costUsd).toBe(0);
  expect(g.costPerSuccessUsd).toBeNull();
});

test("groups by brain and model; unfinished runs and runs outside the window are left out", async () => {
  f = await setup();
  await usage(await run(), { usd: 0.1, model: "claude-haiku-5-5" });
  await usage(await run({ brain: "codex" }), { usd: 0.2, model: "gpt-x" });
  await usage(await run({ status: "running" }), { usd: 9 });
  await usage(await run({ at: minutesAgo(3 * 24 * 60) }), { usd: 9 });

  const r = await report();
  expect(r.groups.map((g) => [g.brain, g.model, g.runs]).sort()).toEqual([
    ["api", "claude-haiku-5-5", 1],
    ["codex", "gpt-x", 1],
  ]);
  expect(r.total.runs).toBe(2);
  expect(r.total.costUsd).toBeCloseTo(0.3);
});

test("money is for those who may see usage", async () => {
  f = await setup();
  const member = await addMember(f.db, f.org.id, "member", "Bia");
  await expect(costPerSuccess(f.db, member.id, f.org.id, {})).rejects.toThrow();
});

test("negative control: a verdict against another contract, or rejected after it, is no success", async () => {
  f = await setup();
  const stale = crypto.randomUUID();
  await usage(await run({ issueId: stale }), { usd: 0.1 });
  await outcome("task_verified", stale, minutesAgo(5), { contractHash: "sha256:other" });
  const rejected = crypto.randomUUID();
  await usage(await run({ issueId: rejected }), { usd: 0.1 });
  await outcome("task_verified", rejected, minutesAgo(5));
  await outcome("task_rejected", rejected, minutesAgo(2), { reasons: ["Save does nothing"] });
  expect((await only()).verifiedSuccesses).toBe(0);
});

test("false-pass counts: claimed done, verified, rejected after a claim (ADR 0211)", async () => {
  f = await setup();
  const agentClaim = { by: { type: "agent", id: f.agent.id }, claim: true };
  const ok = crypto.randomUUID();
  await outcome("issue_closed", ok, minutesAgo(30), agentClaim);
  await outcome("task_verified", ok, minutesAgo(20));
  const bad = crypto.randomUUID();
  await outcome("issue_closed", bad, minutesAgo(30), agentClaim);
  await outcome("task_rejected", bad, minutesAgo(20), { reasons: ["Old build still serving"] });
  const open = crypto.randomUUID();
  await outcome("issue_closed", open, minutesAgo(30), agentClaim);
  // A rejection with no claim before it isn't a false pass.
  const early = crypto.randomUUID();
  await outcome("task_rejected", early, minutesAgo(30), { reasons: ["Not done"] });
  await outcome("issue_closed", early, minutesAgo(10), agentClaim);

  const { claims } = await report();
  expect(claims).toMatchObject({
    claimedDone: 4,
    verified: 1,
    rejectedAfterClaim: 1,
    unverified: 2,
    falseClaimRate: 0.25,
  });
  expect(claims.text).toContain("4");
});
