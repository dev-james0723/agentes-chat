import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  ConflictError,
  claimIssue,
  createAgent,
  createIssue,
  grantScopes,
  NEW_AGENT_DEFAULTS,
  OWNER_EPOCH_STALE,
  OWNER_HANDOFF_GRACE_MS,
  type ToolContext,
  updateIssue,
} from "../src";
import { type Fixture, setup } from "./fixtures";
import { runContext } from "./mail-fixtures";

// The issue owner epoch and its fence at the Tool Gateway (ADR 0202).

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const person = (userId: string) => ({ type: "person" as const, userId });
const ISSUES = ["issues:read", "issues:write"].map((scope) => ({ connectionId: null, scope }));

async function world() {
  f = await setup({ issueTools: true, reply: () => ({ chunks: ["ok"] }) });
  await grantScopes(f.db, f.org.id, f.agent.id, ISSUES);
  const other = await createAgent(f.db, f.owner.id, f.org.id, { name: "Bia", handle: "bia" }, NEW_AGENT_DEFAULTS);
  await grantScopes(f.db, f.org.id, other.id, ISSUES);
  const deps = { db: f.db, pubsub: f.pubsub };
  /** A fresh run of `agentId` in #general. */
  const runOf = async (agentId: string): Promise<ToolContext> => {
    const ctx = await runContext(f);
    await f.db.update(schema.agentRuns).set({ agentId }).where(eq(schema.agentRuns.id, ctx.runId));
    return { ...ctx, agentId };
  };
  const call = (ctx: ToolContext, name: string, input: Record<string, unknown>) =>
    f.tools?.invoke(ctx, { toolUseId: crypto.randomUUID(), name, input });
  const epochOf = async (id: string) =>
    (await f.db.select({ e: schema.issues.ownerEpoch }).from(schema.issues).where(eq(schema.issues.id, id)))[0]?.e;
  const runEpoch = async (runId: string) =>
    (
      await f.db
        .select({ issueId: schema.agentRuns.issueId, epoch: schema.agentRuns.issueEpoch })
        .from(schema.agentRuns)
        .where(eq(schema.agentRuns.id, runId))
    )[0];
  /** The handoff's grace for the old run is over (ADR 0202 §6): its moment moved back past the window. */
  const expireGrace = (id: string) =>
    f.db
      .update(schema.issues)
      .set({ ownerHandoffAt: new Date(Date.now() - OWNER_HANDOFF_GRACE_MS - 1000) })
      .where(eq(schema.issues.id, id));
  return { deps, other, runOf, call, epochOf, runEpoch, expireGrace };
}

const refused = { type: "result", output: { isError: true, data: { code: OWNER_EPOCH_STALE } } };

describe("issue owner epoch", () => {
  test("a run carries the epoch it started under; a stale writer is refused at the gateway", async () => {
    const { deps, other, runOf, call, epochOf, runEpoch, expireGrace } = await world();
    const task = await createIssue(deps, person(f.owner.id), f.org.id, {
      title: "Fix login",
      assignee: { type: "agent", id: f.agent.id },
    });
    // Created with its first owner: epoch 1.
    expect(await epochOf(task.id)).toBe(1);
    const old = await runOf(f.agent.id);
    expect(await call(old, "comment_issue", { issue: task.id, text: "Starting." })).toMatchObject({
      output: { content: `Commented on #${task.number}.` },
    });
    expect(await runEpoch(old.runId)).toEqual({ issueId: task.id, epoch: 1 });

    // A person gives it to another agent: the epoch moves on.
    await updateIssue(deps, person(f.owner.id), f.org.id, task.id, { assignee: { type: "agent", id: other.id } });
    expect(await epochOf(task.id)).toBe(2);
    await expireGrace(task.id);

    // Refused by the gateway before the tool ran (its text, not the tool's "Failed: …").
    expect(await call(old, "update_issue", { issue: task.id, status: "done" })).toMatchObject({
      ...refused,
      output: { ...refused.output, content: expect.stringMatching(/^Task #\d+ changed hands/) },
    });
    expect(await call(old, "comment_issue", { issue: task.id, text: "Done!" })).toMatchObject(refused);
    const [row] = await f.db.select().from(schema.issues).where(eq(schema.issues.id, task.id));
    expect(row?.status).not.toBe("done");
    // The refusal is recorded as one in the audit log.
    const audit = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "tool.call"));
    expect(audit.some((a) => a.outcome === "refused")).toBe(true);

    // The new owner's run, started now, writes.
    const fresh = await runOf(other.id);
    expect(await call(fresh, "update_issue", { issue: task.id, status: "in_progress" })).toMatchObject({
      output: { content: expect.stringContaining("Updated #") },
    });
    expect(await runEpoch(fresh.runId)).toEqual({ issueId: task.id, epoch: 2 });
  });

  test("the fence holds at the write itself, past the gateway", async () => {
    const { deps, other, runOf, call, expireGrace } = await world();
    const task = await createIssue(deps, person(f.owner.id), f.org.id, {
      title: "Fix login",
      assignee: { type: "agent", id: f.agent.id },
    });
    const old = await runOf(f.agent.id);
    await call(old, "comment_issue", { issue: task.id, text: "Starting." });
    await updateIssue(deps, person(f.owner.id), f.org.id, task.id, { assignee: { type: "agent", id: other.id } });
    await expireGrace(task.id);
    const agent = { type: "agent" as const, agentId: f.agent.id, channelId: old.channelId, runId: old.runId };
    const error = await updateIssue(deps, agent, f.org.id, task.id, { status: "done" }).catch((e) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.code).toBe(OWNER_EPOCH_STALE);
  });

  test("two agents claiming at once: one owner", async () => {
    const { deps, other, runOf, epochOf } = await world();
    const task = await createIssue(deps, person(f.owner.id), f.org.id, { title: "Up for grabs" });
    expect(await epochOf(task.id)).toBe(0);
    const [a, b] = await Promise.all([runOf(f.agent.id), runOf(other.id)]);
    const results = await Promise.allSettled([
      claimIssue(
        deps,
        { type: "agent", agentId: a.agentId, channelId: a.channelId, runId: a.runId },
        f.org.id,
        task.id,
        0,
      ),
      claimIssue(
        deps,
        { type: "agent", agentId: b.agentId, channelId: b.channelId, runId: b.runId },
        f.org.id,
        task.id,
        0,
      ),
    ]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError);
    expect(await epochOf(task.id)).toBe(1);
    const [row] = await f.db.select().from(schema.issues).where(eq(schema.issues.id, task.id));
    const winner = (
      won[0] as PromiseFulfilledResult<{ ownerEpoch: number; issue: { assignee: { id: string } | null } }>
    ).value;
    expect(winner.ownerEpoch).toBe(1);
    expect(row?.assigneeId).toBe(winner.issue.assignee?.id ?? "");
    // A claim with an epoch already passed loses too: no retry overwrites the owner.
    await expect(
      claimIssue(
        deps,
        { type: "agent", agentId: a.agentId, channelId: a.channelId, runId: a.runId },
        f.org.id,
        task.id,
        0,
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  test("an agent handing off loses its own write; cancellation bumps the epoch", async () => {
    const { deps, runOf, call, epochOf, expireGrace } = await world();
    const task = await createIssue(deps, person(f.owner.id), f.org.id, {
      title: "Write the report",
      assignee: { type: "agent", id: f.agent.id },
    });
    const mine = await runOf(f.agent.id);
    await call(mine, "comment_issue", { issue: task.id, text: "On it." });
    expect(await call(mine, "update_issue", { issue: task.id, assignee: "@bia" })).toMatchObject({
      output: { content: expect.stringContaining("Updated #") },
    });
    expect(await epochOf(task.id)).toBe(2);
    await expireGrace(task.id);
    expect(await call(mine, "comment_issue", { issue: task.id, text: "Still mine?" })).toMatchObject(refused);

    // An unlinked run that hands off is not left holding the new epoch either.
    const second = await createIssue(deps, person(f.owner.id), f.org.id, {
      title: "Second",
      assignee: { type: "agent", id: f.agent.id },
    });
    const passer = await runOf(f.agent.id);
    await call(passer, "update_issue", { issue: second.id, assignee: "@bia" });
    await expireGrace(second.id);
    expect(await call(passer, "comment_issue", { issue: second.id, text: "x" })).toMatchObject(refused);

    // Canceled: whoever worked on it can't write it back.
    const third = await createIssue(deps, person(f.owner.id), f.org.id, {
      title: "Third",
      assignee: { type: "agent", id: f.agent.id },
    });
    const worker = await runOf(f.agent.id);
    await call(worker, "comment_issue", { issue: third.id, text: "Working." });
    await updateIssue(deps, person(f.owner.id), f.org.id, third.id, { status: "canceled" });
    expect(await epochOf(third.id)).toBe(2);
    expect(await call(worker, "update_issue", { issue: third.id, status: "in_progress" })).toMatchObject(refused);
  });

  test("unrelated issues and child tasks are not serialized by another's epoch", async () => {
    const { deps, other, runOf, call, epochOf } = await world();
    const parent = await createIssue(deps, person(f.owner.id), f.org.id, {
      title: "Parent",
      assignee: { type: "agent", id: f.agent.id },
    });
    const child = await createIssue(deps, person(f.owner.id), f.org.id, {
      title: "Child",
      parentIssueId: parent.id,
      assignee: { type: "agent", id: other.id },
    });
    const unrelated = await createIssue(deps, person(f.owner.id), f.org.id, {
      title: "Unrelated",
      assignee: { type: "agent", id: other.id },
    });
    const onChild = await runOf(other.id);
    await call(onChild, "comment_issue", { issue: child.id, text: "Child work." });
    const onUnrelated = await runOf(other.id);
    await call(onUnrelated, "comment_issue", { issue: unrelated.id, text: "Other work." });

    // The parent changes hands twice: its children keep their own epoch.
    await updateIssue(deps, person(f.owner.id), f.org.id, parent.id, { assignee: { type: "agent", id: other.id } });
    await updateIssue(deps, person(f.owner.id), f.org.id, parent.id, { assignee: null });
    expect(await epochOf(parent.id)).toBe(3);
    expect(await epochOf(child.id)).toBe(1);

    expect(await call(onChild, "update_issue", { issue: child.id, status: "in_progress" })).toMatchObject({
      output: { content: expect.stringContaining("Updated #") },
    });
    expect(await call(onUnrelated, "comment_issue", { issue: unrelated.id, text: "Still fine." })).toMatchObject({
      output: { content: `Commented on #${unrelated.number}.` },
    });
    // A run linked to one task is not fenced on another it was never linked to.
    expect(await call(onUnrelated, "comment_issue", { issue: child.id, text: "A note." })).toMatchObject({
      output: { content: `Commented on #${child.number}.` },
    });
    // Edits that don't change the owner don't move the epoch.
    await updateIssue(deps, person(f.owner.id), f.org.id, unrelated.id, { title: "Renamed", priority: "high" });
    expect(await epochOf(unrelated.id)).toBe(1);
  });
  test("a handoff mid-run leaves the old run a short grace to close; then it is refused", async () => {
    const { deps, other, runOf, call, epochOf, expireGrace } = await world();
    const task = await createIssue(deps, person(f.owner.id), f.org.id, {
      title: "Ship the fix",
      assignee: { type: "agent", id: f.agent.id },
    });
    const old = await runOf(f.agent.id);
    await call(old, "comment_issue", { issue: task.id, text: "Working." });
    await updateIssue(deps, person(f.owner.id), f.org.id, task.id, { assignee: { type: "agent", id: other.id } });
    expect(await epochOf(task.id)).toBe(2);

    // Within the grace, the old run posts its closing comment and status.
    expect(await call(old, "comment_issue", { issue: task.id, text: "Handing over: PR #7 is up." })).toMatchObject({
      output: { content: `Commented on #${task.number}.` },
    });
    expect(await call(old, "update_issue", { issue: task.id, status: "in_review" })).toMatchObject({
      output: { content: expect.stringContaining("Updated #") },
    });
    // The grace closes a turn; it never lets the old run change who owns the task.
    const regrab = await call(old, "update_issue", { issue: task.id, assignee: "me" });
    expect(regrab).toMatchObject(refused);
    const [row] = await f.db.select().from(schema.issues).where(eq(schema.issues.id, task.id));
    expect(row?.assigneeId).toBe(other.id);
    expect(row?.status).toBe("in_review");

    // After the grace: refused, as before.
    await expireGrace(task.id);
    expect(await call(old, "comment_issue", { issue: task.id, text: "One more thing." })).toMatchObject(refused);
  });

  test("no grace for a cancellation, a run that already ended, or a second handoff", async () => {
    const { deps, other, runOf, call } = await world();
    const make = (title: string) =>
      createIssue(deps, person(f.owner.id), f.org.id, { title, assignee: { type: "agent", id: f.agent.id } });

    const canceled = await make("Canceled");
    const a = await runOf(f.agent.id);
    await call(a, "comment_issue", { issue: canceled.id, text: "Working." });
    await updateIssue(deps, person(f.owner.id), f.org.id, canceled.id, { status: "canceled" });
    expect(await call(a, "comment_issue", { issue: canceled.id, text: "Closing." })).toMatchObject(refused);

    const ended = await make("Ended");
    const b = await runOf(f.agent.id);
    await call(b, "comment_issue", { issue: ended.id, text: "Working." });
    await f.db.update(schema.agentRuns).set({ finishedAt: new Date() }).where(eq(schema.agentRuns.id, b.runId));
    await updateIssue(deps, person(f.owner.id), f.org.id, ended.id, { assignee: { type: "agent", id: other.id } });
    const agent = { type: "agent" as const, agentId: f.agent.id, channelId: b.channelId, runId: b.runId };
    const error = await updateIssue(deps, agent, f.org.id, ended.id, { status: "done" }).catch((e) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.code).toBe(OWNER_EPOCH_STALE);

    const twice = await make("Twice");
    const c = await runOf(f.agent.id);
    await call(c, "comment_issue", { issue: twice.id, text: "Working." });
    await updateIssue(deps, person(f.owner.id), f.org.id, twice.id, { assignee: { type: "agent", id: other.id } });
    await updateIssue(deps, person(f.owner.id), f.org.id, twice.id, { assignee: null });
    expect(await call(c, "comment_issue", { issue: twice.id, text: "Closing." })).toMatchObject(refused);
  });
});
