import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { addRunStep, commentIssue, createIssue, issueRunToolToken, postPersonMessage } from "../src";
import { admitBridgeEffect, closeBridgeEffectEpoch, finishBridgeEffect } from "../src/bridge-effect-epoch";
import { type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";
import { RUNNER } from "./mission-helpers";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

const deps = () => ({ db: f.db, pubsub: f.pubsub });

/** A running run with an open bridge epoch, as a computer turn has. */
async function heldTurn() {
  const machine = await pairMachine(deps(), f.owner.id, f.org.id, { name: "Box", ...RUNNER, exec: true });
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
    })
    .returning();
  if (!run) throw new Error("no run");
  const epoch = Bun.randomUUIDv7();
  await issueRunToolToken(f.db, {
    orgId: f.org.id,
    agentId: f.agent.id,
    machineId: machine.machineId,
    runId: run.id,
    tokenId: epoch,
  });
  const issue = await createIssue(deps(), { type: "person", userId: f.owner.id }, f.org.id, { title: "Login" });
  const agent = { type: "agent" as const, agentId: f.agent.id, channelId: f.general.id, runId: run.id };
  /** A bridged call the server answered with an error it can't vouch for (`finishBridgeEffect(…, true)`). */
  const call = async (
    callId: string,
    name: string,
    input: Record<string, unknown>,
    effect?: () => Promise<unknown>,
  ) => {
    expect(await admitBridgeEffect(f.db, run.id, epoch, callId)).toBe(true);
    await addRunStep(f.db, run, "tool_call", { name, input, toolUseId: callId });
    await effect?.();
    await finishBridgeEffect(f.db, epoch, callId, true);
  };
  const epochRow = async () =>
    (await f.db.select().from(schema.runToolTokens).where(eq(schema.runToolTokens.id, epoch)))[0];
  const held = async () =>
    (
      (await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run.id)))[0]?.transcript as {
        effectUncertain?: unknown;
      } | null
    )?.effectUncertain ?? null;
  return { run, epoch, issue, agent, call, epochRow, held };
}

describe("unknown bridge effects read back before they hold the run", () => {
  test("comment_issue whose comment exists: done, the run is not held", async () => {
    f = await setup({ machines: true });
    const t = await heldTurn();
    const text = "Tests pass on main.";
    await t.call("c1", "comment_issue", { issue: `#${t.issue.number}`, text }, () =>
      commentIssue(deps(), t.agent, f.org.id, t.issue.id, text),
    );
    expect(await closeBridgeEffectEpoch(f.db, t.run.id, t.epoch, 1)).toBeNull();
    const row = await t.epochRow();
    expect(row?.effectEpochState).toBe("closed");
    expect(row?.effectCalls).toMatchObject({ c1: { state: "completed", reconciled: "done" } });
    expect(await t.held()).toBeNull();
  });

  test("comment_issue whose comment never landed: not done, safe to retry", async () => {
    f = await setup({ machines: true });
    const t = await heldTurn();
    await t.call("c1", "comment_issue", { issue: String(t.issue.number), text: "Lost" });
    expect(await closeBridgeEffectEpoch(f.db, t.run.id, t.epoch, 1)).toBeNull();
    expect((await t.epochRow())?.effectCalls).toMatchObject({ c1: { state: "completed", reconciled: "not_done" } });
  });

  test("create_issue: done when its task exists, not done when the agent made none", async () => {
    f = await setup({ machines: true });
    const t = await heldTurn();
    await t.call("made", "create_issue", { title: "Write the release notes" }, () =>
      createIssue(deps(), t.agent, f.org.id, { title: "Write the release notes" }),
    );
    await t.call("lost", "create_issue", { title: "Never made" });
    // One made and one not: the first proves the agent wrote a task this turn, so the second can't be told apart.
    expect(await closeBridgeEffectEpoch(f.db, t.run.id, t.epoch, 1)).toMatchObject({
      tools: ["unresolved bridge effect"],
    });
    expect((await t.epochRow())?.effectCalls).toMatchObject({
      made: { state: "completed", reconciled: "done" },
      lost: { state: "unknown" },
    });

    const u = await heldTurn();
    await u.call("lost", "create_issue", { title: "Never made" });
    expect(await closeBridgeEffectEpoch(f.db, u.run.id, u.epoch, 1)).toBeNull();
    expect((await u.epochRow())?.effectCalls).toMatchObject({ lost: { state: "completed", reconciled: "not_done" } });
  });

  test("ambiguous evidence, a tool with no read-back or a call never finished: still held", async () => {
    f = await setup({ machines: true });
    const t = await heldTurn();
    // The run commented something else on that task: this call's comment can't be told apart from it.
    await t.call("c1", "comment_issue", { issue: `#${t.issue.number}`, text: "Mine" }, () =>
      commentIssue(deps(), t.agent, f.org.id, t.issue.id, "Something else"),
    );
    expect(await closeBridgeEffectEpoch(f.db, t.run.id, t.epoch, 1)).toMatchObject({
      tools: ["unresolved bridge effect"],
    });
    expect((await t.epochRow())?.effectEpochState).toBe("closed_unknown");
    expect((await t.epochRow())?.effectCalls).toMatchObject({ c1: { state: "unknown" } });

    const u = await heldTurn();
    await u.call("b1", "browser_fill", { field: "email" });
    expect(await closeBridgeEffectEpoch(f.db, u.run.id, u.epoch, 1)).toMatchObject({
      tools: ["unresolved bridge effect"],
    });

    // Still in flight (no receipt): the effect could land after any read, so it is never read back.
    const v = await heldTurn();
    expect(await admitBridgeEffect(f.db, v.run.id, v.epoch, "c1")).toBe(true);
    await addRunStep(f.db, v.run, "tool_call", {
      name: "comment_issue",
      input: { issue: "1", text: "x" },
      toolUseId: "c1",
    });
    expect(await closeBridgeEffectEpoch(f.db, v.run.id, v.epoch, 1)).toMatchObject({
      tools: ["unresolved bridge effect"],
    });
    expect((await v.epochRow())?.effectCalls).toMatchObject({ c1: { state: "in_flight" } });
  });
});
