import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema, sql } from "@agenteschat/db";
import {
  createIssue,
  NO_AI,
  outcomesForThread,
  postPersonMessage,
  recordOutcome,
  setCriterion,
  transitionRun,
  updateIssue,
} from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

const deps = () => ({ db: f.db, pubsub: f.pubsub });
const owner = () => ({ type: "person" as const, userId: f.owner.id });

async function runningRun(transcript?: Record<string, unknown>) {
  const msg = await postPersonMessage(deps(), f.owner.id, f.org.id, f.general.id, { body: "hi" });
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: msg.id,
      triggerMessageId: msg.id,
      trigger: "mention",
      hop: 1,
      status: "running",
      startedAt: new Date(),
      ...(transcript ? { transcript } : {}),
    })
    .returning();
  if (!run) throw new Error("no run");
  return run;
}

const outcomesOf = (runId: string) =>
  f.db
    .select()
    .from(schema.outcomes)
    .where(and(eq(schema.outcomes.orgId, f.org.id), eq(schema.outcomes.runId, runId)));

describe("a terminal outcome for every run, from what the platform knows", () => {
  test("done, failed (with its code), canceled and a failure on an unknown tool effect", async () => {
    f = await setup();
    const done = await runningRun();
    await transitionRun(f.db, done.id, "running", "done", {});
    expect(await outcomesOf(done.id)).toMatchObject([
      { kind: "run_done", polarity: "positive", source: "run", agentId: f.agent.id, channelId: f.general.id },
    ]);

    const failed = await runningRun();
    await transitionRun(f.db, failed.id, "running", "failed", {
      error: "budget_exceeded",
      failure: { code: "budget", cause: "limit" },
    });
    expect(await outcomesOf(failed.id)).toMatchObject([
      {
        kind: "run_failed",
        polarity: "negative",
        source: "run",
        summary: "budget_exceeded",
        details: { code: "budget", cause: "limit" },
      },
    ]);

    const canceled = await runningRun();
    await transitionRun(f.db, canceled.id, "running", "canceled", { error: "canceled_by:someone" });
    expect(await outcomesOf(canceled.id)).toMatchObject([{ kind: "run_canceled", polarity: "negative" }]);

    const hold = { runId: "x", turn: 1, tools: ["comment_issue"] };
    const held = await runningRun({ system: [], messages: [], effectUncertain: hold });
    await transitionRun(f.db, held.id, "running", "failed", {
      error: "brain_interrupted: tool outcome unknown; reconcile before retrying",
    });
    expect(await outcomesOf(held.id)).toMatchObject([
      { kind: "run_effect_unknown", polarity: "negative", details: { tools: ["comment_issue"] } },
    ]);
  });

  test("a move that is not terminal, or a lost compare-and-set, records nothing", async () => {
    f = await setup();
    const run = await runningRun();
    await transitionRun(f.db, run.id, "running", "waiting_input", {});
    expect(await transitionRun(f.db, run.id, "running", "done", {})).toBeNull();
    expect(await outcomesOf(run.id)).toEqual([]);
  });

  test("reflection still sees the informative outcomes, not every finished run", async () => {
    f = await setup();
    const done = await runningRun();
    await transitionRun(f.db, done.id, "running", "done", {});
    await recordOutcome(f.db, {
      orgId: f.org.id,
      kind: "approval_refused",
      agentId: f.agent.id,
      runId: done.id,
      threadRootId: done.threadRootId,
      source: "approval",
    });
    const rows = await outcomesForThread(f.db, f.org.id, {
      threadRootId: done.threadRootId,
      agentIds: [f.agent.id],
      since: new Date(0),
    });
    expect(rows.map((r) => r.kind)).toEqual(["approval_refused"]);
  });

  test("reflection leaves out cancels and failures of the infrastructure, not failures of the work", async () => {
    f = await setup();
    const thread = (await runningRun()).threadRootId;
    const runIn = async () => {
      const msg = await postPersonMessage(deps(), f.owner.id, f.org.id, f.general.id, {
        body: "again",
        threadId: thread,
      });
      const [run] = await f.db
        .insert(schema.agentRuns)
        .values({
          orgId: f.org.id,
          agentId: f.agent.id,
          channelId: f.general.id,
          threadRootId: thread,
          triggerMessageId: msg.id,
          trigger: "mention",
          hop: 1,
          status: "running",
          startedAt: new Date(),
        })
        .returning();
      if (!run) throw new Error("no run");
      return run;
    };
    await transitionRun(f.db, (await runIn()).id, "running", "failed", { error: "too_many_tool_calls" });
    await transitionRun(f.db, (await runIn()).id, "running", "failed", { error: "x", failure: { code: "plan_limit" } });
    await transitionRun(f.db, (await runIn()).id, "running", "failed", { error: "gave_up: overloaded" });
    await transitionRun(f.db, (await runIn()).id, "running", "failed", { error: NO_AI });
    await transitionRun(f.db, (await runIn()).id, "running", "canceled", { error: "canceled_by:someone" });
    const rows = await outcomesForThread(f.db, f.org.id, {
      threadRootId: thread,
      channelId: f.general.id,
      agentIds: [f.agent.id],
      since: new Date(0),
    });
    expect(rows.map((r) => [r.kind, r.summary])).toEqual([["run_failed", "too_many_tool_calls"]]);
  });

  test("a run's outcome from a private conversation never reaches another conversation's reflection", async () => {
    f = await setup();
    const [dm] = await f.db
      .insert(schema.channels)
      .values({ orgId: f.org.id, name: "dm-private", kind: "dm", visibility: "private" })
      .returning();
    if (!dm) throw new Error("dm");
    const msg = await postPersonMessage(deps(), f.owner.id, f.org.id, f.general.id, { body: "public" });
    const [run] = await f.db
      .insert(schema.agentRuns)
      .values({
        orgId: f.org.id,
        agentId: f.agent.id,
        channelId: dm.id,
        threadRootId: crypto.randomUUID(),
        triggerMessageId: msg.id,
        trigger: "mention",
        hop: 1,
        status: "running",
        startedAt: new Date(),
      })
      .returning();
    if (!run) throw new Error("run");
    await transitionRun(f.db, run.id, "running", "failed", { error: "salary of Ana is late: too_many_tool_calls" });
    const rows = await outcomesForThread(f.db, f.org.id, {
      threadRootId: msg.id,
      channelId: f.general.id,
      agentIds: [f.agent.id],
      since: new Date(0),
    });
    expect(rows).toEqual([]);
  });

  test("an outcome that can't be written never fails the run's end, alone or in the caller's transaction", async () => {
    f = await setup();
    await f.db.execute(sql`create function refuse_outcome() returns trigger language plpgsql as $$
      begin raise exception 'outcomes are down'; end $$`);
    await f.db.execute(sql`create trigger refuse_outcome before insert on outcomes
      for each row execute function refuse_outcome()`);
    const alone = await runningRun();
    expect(await transitionRun(f.db, alone.id, "running", "done", {})).toMatchObject({ status: "done" });
    const inside = await runningRun();
    await f.db.transaction((tx) => transitionRun(tx, inside.id, "running", "failed", { error: "too_many_tool_calls" }));
    const [row] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, inside.id));
    expect(row?.status).toBe("failed");
    expect(await outcomesOf(alone.id)).toEqual([]);
  });
});

describe("task outcomes", () => {
  const issueOutcomes = (number: number) =>
    f.db
      .select()
      .from(schema.outcomes)
      .where(and(eq(schema.outcomes.orgId, f.org.id), eq(schema.outcomes.subject, `issue#${number}`)));

  test("criteria_met only when people checked every acceptance criterion: an agent's own tick is no outcome", async () => {
    f = await setup();
    const issue = await createIssue(deps(), owner(), f.org.id, {
      title: "Ship it",
      criteria: ["tests pass", "docs"],
      assignee: { type: "agent", id: f.agent.id },
    });
    const [a, b] = issue.criteria;
    if (!a || !b) throw new Error("criteria");
    const agent = { type: "agent" as const, agentId: f.agent.id, channelId: f.general.id };
    await setCriterion(deps(), agent, f.org.id, issue.id, a.id, true);
    await setCriterion(deps(), owner(), f.org.id, issue.id, b.id, true);
    // All checked, but the agent ticked one itself.
    expect(await issueOutcomes(issue.number)).toEqual([]);
    // A person checks that one too: now people vouch for every criterion.
    await setCriterion(deps(), owner(), f.org.id, issue.id, a.id, false);
    await setCriterion(deps(), owner(), f.org.id, issue.id, a.id, true);
    expect(await issueOutcomes(issue.number)).toMatchObject([
      {
        kind: "criteria_met",
        polarity: "positive",
        source: "issue",
        agentId: f.agent.id,
        details: {
          issueId: issue.id,
          checkedBy: [
            { type: "person", id: f.owner.id },
            { type: "person", id: f.owner.id },
          ],
        },
      },
    ]);
  });

  test("a task moved back from done records issue_reopened against its agent", async () => {
    f = await setup();
    const issue = await createIssue(deps(), owner(), f.org.id, {
      title: "Fix login",
      assignee: { type: "agent", id: f.agent.id },
    });
    await updateIssue(deps(), owner(), f.org.id, issue.id, { status: "done" });
    expect(await issueOutcomes(issue.number)).toEqual([]);
    await updateIssue(deps(), owner(), f.org.id, issue.id, { status: "in_progress" });
    expect(await issueOutcomes(issue.number)).toMatchObject([
      {
        kind: "issue_reopened",
        polarity: "negative",
        source: "issue",
        agentId: f.agent.id,
        details: { issueId: issue.id, from: "done", to: "in_progress", by: { type: "person", id: f.owner.id } },
      },
    ]);
    // Canceling a done task is not a reopen.
    await updateIssue(deps(), owner(), f.org.id, issue.id, { status: "done" });
    await updateIssue(deps(), owner(), f.org.id, issue.id, { status: "canceled" });
    expect((await issueOutcomes(issue.number)).length).toBe(1);
  });
});

test("a task shared with chosen people keeps its title out of outcomes and out of every thread's reflection", async () => {
  f = await setup();
  const issue = await createIssue(deps(), owner(), f.org.id, {
    title: "Ana's salary review",
    assignee: { type: "agent", id: f.agent.id },
  });
  await f.db
    .update(schema.issues)
    .set({ restricted: true, audienceUserIds: [f.owner.id], channelId: null })
    .where(eq(schema.issues.id, issue.id));
  await updateIssue(deps(), owner(), f.org.id, issue.id, { status: "done" });
  await updateIssue(deps(), owner(), f.org.id, issue.id, { status: "in_progress" });
  const [row] = await f.db.select().from(schema.outcomes).where(eq(schema.outcomes.kind, "issue_reopened"));
  expect(row).toMatchObject({ channelId: null, summary: "" });
  const msg = await postPersonMessage(deps(), f.owner.id, f.org.id, f.general.id, { body: "public" });
  const rows = await outcomesForThread(f.db, f.org.id, {
    threadRootId: msg.id,
    channelId: f.general.id,
    agentIds: [f.agent.id],
    since: new Date(0),
  });
  expect(rows).toEqual([]);
});
