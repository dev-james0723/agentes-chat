import { afterEach, describe, expect, test } from "bun:test";
import { and, asc, eq, schema } from "@agenteschat/db";
import {
  addRunStep,
  ConflictError,
  cancelRun,
  commentIssue,
  createIssue,
  decideApproval,
  drainOutbox,
  ForbiddenError,
  issueRunToolToken,
  postPersonMessage,
  recoverStaleRuns,
  setAgentHold,
  type ToolSource,
} from "../src";
import { admitBridgeEffect, finishBridgeEffect } from "../src/bridge-effect-epoch";
import { heldEffectsOf, reconcileRunEffect } from "../src/effect-reconcile";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";
import { RUNNER } from "./mission-helpers";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const deps = () => ({ db: f.db, pubsub: f.pubsub });
const WHY = "The person asked to send the release note to the team.";

/** An external send whose answer can be lost after it happened (a reset after the provider committed). */
const sent: string[] = [];
let loseAnswer: "after" | "before" | null = null;
const mail: ToolSource = {
  name: "mail",
  tools: async () => [
    {
      name: "send_release_note",
      description: "Send the release note",
      scope: "",
      sensitive: true,
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
      execute: async (input) => {
        if (loseAnswer === "before") throw new Error("ECONNRESET");
        sent.push((input as { text: string }).text);
        if (loseAnswer === "after") throw new Error("ECONNRESET");
        return { content: "sent" };
      },
    },
  ],
};

/** What each model call was given, in order. */
const prompts: string[] = [];

/** A run whose approved send lost its answer: held with an unknown outcome (the executor's `approved_effect_unknown`). */
async function heldApproval(lost: "after" | "before") {
  sent.length = 0;
  prompts.length = 0;
  loseAnswer = lost;
  f = await setup({
    toolSources: [mail],
    reply: (req, call) => {
      prompts.push(JSON.stringify(req));
      if (call === 1)
        return {
          chunks: ["Sending it."],
          toolUses: [{ name: "send_release_note", input: { text: "v2 is out", why: WHY } }],
        };
      return { chunks: ["Done."] };
    },
  });
  await postPersonMessage(deps(), f.owner.id, f.org.id, f.general.id, { body: "@dev send the release note" });
  await drainOutbox(f.db, f.handlers);
  const [approval] = await f.db.select().from(schema.approvals);
  if (!approval) throw new Error("no approval");
  await decideApproval(deps(), f.owner.id, f.org.id, approval.id, { decision: "approve" });
  await drainOutbox(f.db, f.handlers);
  loseAnswer = null;
  const [run] = await f.db.select().from(schema.agentRuns).orderBy(asc(schema.agentRuns.createdAt));
  if (!run) throw new Error("no run");
  return { run, approval };
}

const runRow = async (id: string) => (await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, id)))[0];
const jobsFor = async (runId: string) =>
  (await f.db.select().from(schema.outbox)).filter(
    (j) =>
      j.kind === "agent_run.execute" && (j.payload as { runId?: string }).runId === runId && j.status === "pending",
  );

describe("a run held on an approved action whose answer was lost", () => {
  test("it is held, and lists the approval as its one unknown effect", async () => {
    const { run, approval } = await heldApproval("after");
    expect(sent).toEqual(["v2 is out"]);
    expect((await runRow(run.id))?.status).toBe("waiting_input");
    const held = await heldEffectsOf(f.db, f.org.id, run.id);
    expect(held.open).toBe(false);
    expect(held.effects).toEqual([
      expect.objectContaining({ id: `approval:${approval.id}`, kind: "approval", tools: ["send_release_note"] }),
    ]);
  });

  test("marked done by the owner: the run goes on with the send counted once, never sent again", async () => {
    const { run, approval } = await heldApproval("after");
    const out = await reconcileRunEffect(deps(), f.owner.id, f.org.id, run.id, {
      effectId: `approval:${approval.id}`,
      verdict: "done",
      note: "The team got it in Slack.",
    });
    expect(out).toMatchObject({ released: true, remaining: [] });
    await drainOutbox(f.db, f.handlers);
    // The lost answer never makes a second send.
    expect(sent).toEqual(["v2 is out"]);
    expect((await runRow(run.id))?.status).toBe("done");
    expect(prompts.at(-1)).toContain("did happen");
    // The decision is on the record: who, what, and the verdict.
    const audit = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "run.effect_reconciled"));
    expect(audit).toEqual([
      expect.objectContaining({
        actorType: "person",
        actorId: f.owner.id,
        targetId: run.id,
        details: expect.objectContaining({ effectId: `approval:${approval.id}`, verdict: "done" }),
      }),
    ]);
    const steps = await f.db.select().from(schema.agentRunSteps).where(eq(schema.agentRunSteps.runId, run.id));
    expect(steps.some((s) => s.data.reason === "effect_reconciled" && s.data.verdict === "done")).toBe(true);
  });

  test("marked not done: the run goes on told so, and the platform does not send it again by itself", async () => {
    const { run, approval } = await heldApproval("before");
    expect(sent).toEqual([]);
    await reconcileRunEffect(deps(), f.owner.id, f.org.id, run.id, {
      effectId: `approval:${approval.id}`,
      verdict: "not_done",
    });
    await drainOutbox(f.db, f.handlers);
    expect(sent).toEqual([]);
    expect((await runRow(run.id))?.status).toBe("done");
    expect(prompts.at(-1)).toContain("did not happen");
  });

  test("someone without the right to decide it is refused, and the run stays held", async () => {
    const { run, approval } = await heldApproval("after");
    const member = await addMember(f.db, f.org.id, "member", "Rui");
    await expect(
      reconcileRunEffect(deps(), member.id, f.org.id, run.id, {
        effectId: `approval:${approval.id}`,
        verdict: "done",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect((await heldEffectsOf(f.db, f.org.id, run.id)).effects).toHaveLength(1);
    expect(await jobsFor(run.id)).toEqual([]);
  });

  test("restored with a grant revoked since: the decision is refused and nothing is dispatched", async () => {
    const { run, approval } = await heldApproval("after");
    // An admin who could decide it when the run was held, demoted since (the restored checkpoint still shows them).
    const admin = await addMember(f.db, f.org.id, "admin", "Ana");
    await f.db
      .delete(schema.organizationMemberRoles)
      .where(
        and(eq(schema.organizationMemberRoles.orgId, f.org.id), eq(schema.organizationMemberRoles.userId, admin.id)),
      );
    await expect(
      reconcileRunEffect(deps(), admin.id, f.org.id, run.id, { effectId: `approval:${approval.id}`, verdict: "done" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // The approval itself withdrawn since: even its owner can't release the run on it.
    await f.db.update(schema.approvals).set({ status: "canceled" }).where(eq(schema.approvals.id, approval.id));
    await expect(
      reconcileRunEffect(deps(), f.owner.id, f.org.id, run.id, {
        effectId: `approval:${approval.id}`,
        verdict: "done",
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    await drainOutbox(f.db, f.handlers);
    expect(sent).toEqual(["v2 is out"]);
    expect((await runRow(run.id))?.status).toBe("waiting_input");
    expect((await heldEffectsOf(f.db, f.org.id, run.id)).effects).toHaveLength(1);
  });

  test("an agent held by the operator: nothing is released", async () => {
    const { run, approval } = await heldApproval("after");
    await setAgentHold(f.db, f.org.id, f.agent.id, { held: true, reason: "review" });
    await expect(
      reconcileRunEffect(deps(), f.owner.id, f.org.id, run.id, {
        effectId: `approval:${approval.id}`,
        verdict: "done",
      }),
    ).rejects.toThrow();
    expect((await runRow(run.id))?.status).toBe("waiting_input");
    expect(await jobsFor(run.id)).toEqual([]);
  });

  test("a cancelled run stays cancelled: no decision or sweep revives it", async () => {
    const { run, approval } = await heldApproval("after");
    await cancelRun(deps(), f.owner.id, f.org.id, run.id);
    expect((await runRow(run.id))?.status).toBe("canceled");
    await expect(
      reconcileRunEffect(deps(), f.owner.id, f.org.id, run.id, {
        effectId: `approval:${approval.id}`,
        verdict: "done",
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    await recoverStaleRuns(deps(), { now: new Date(Date.now() + 3600_000) });
    await drainOutbox(f.db, f.handlers);
    expect((await runRow(run.id))?.status).toBe("canceled");
    expect(sent).toEqual(["v2 is out"]);
  });

  test("an unknown effect id is refused", async () => {
    const { run } = await heldApproval("after");
    await expect(
      reconcileRunEffect(deps(), f.owner.id, f.org.id, run.id, { effectId: "approval:nope", verdict: "done" }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

/** A computer turn's run whose worker died mid-turn: its bridge epoch is still open, its beat old. */
async function crashedTurn() {
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
      brain: "claude_code",
      startedAt: new Date(),
      transcript: { system: [], messages: [] },
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
  const call = async (callId: string, name: string, input: Record<string, unknown>, answered: boolean) => {
    expect(await admitBridgeEffect(f.db, run.id, epoch, callId)).toBe(true);
    await addRunStep(f.db, run, "tool_call", { name, input, toolUseId: callId });
    if (name === "comment_issue" && input.landed)
      await commentIssue(deps(), agent, f.org.id, issue.id, String(input.text));
    // Answered without proof (the server's `unknown`), or never answered (still `in_flight`: the worker died).
    if (answered) await finishBridgeEffect(f.db, epoch, callId, true);
  };
  // The worker beat last long ago.
  const old = new Date(Date.now() - 3600_000);
  const age = () =>
    f.db.update(schema.agentRuns).set({ heartbeatAt: old, startedAt: old }).where(eq(schema.agentRuns.id, run.id));
  return { run, epoch, issue, call, age };
}

describe("a run whose worker died with a bridge epoch open", () => {
  test("the sweep fences the epoch and reads back what it can; the computer's own part waits for a person", async () => {
    f = await setup({ machines: true });
    const t = await crashedTurn();
    await t.call("c1", "comment_issue", { issue: `#${t.issue.number}`, text: "Tests pass.", landed: true }, true);
    await t.age();
    await recoverStaleRuns(deps());
    const [epoch] = await f.db.select().from(schema.runToolTokens).where(eq(schema.runToolTokens.id, t.epoch));
    expect(epoch?.revokedAt).not.toBeNull();
    expect(epoch?.effectCalls).toMatchObject({ c1: { state: "completed", reconciled: "done" } });
    // The bridge call is settled; what the computer ran on its own is not known to the server.
    const held = await heldEffectsOf(f.db, f.org.id, t.run.id);
    expect(held.effects).toEqual([
      expect.objectContaining({ id: "marker", kind: "marker", tools: ["interrupted computer turn"] }),
    ]);
    expect((await runRow(t.run.id))?.status).toBe("running");
    const out = await reconcileRunEffect(deps(), f.owner.id, f.org.id, t.run.id, {
      effectId: "marker",
      verdict: "not_done",
    });
    expect(out.released).toBe(true);
    expect(
      (await f.db.select().from(schema.runToolTokens).where(eq(schema.runToolTokens.id, t.epoch)))[0]?.effectEpochState,
    ).toBe("closed");
    // Released to the existing rules: a call was cut in this turn, so it ends with the notice rather than replaying.
    await recoverStaleRuns(deps());
    const row = await runRow(t.run.id);
    expect(row?.status).toBe("failed");
    expect((row?.transcript as { effectUncertain?: unknown } | undefined)?.effectUncertain).toBeUndefined();
  });

  test("a call never answered is not read back: it waits for a person, who settles it", async () => {
    f = await setup({ machines: true });
    const t = await crashedTurn();
    await t.call("c1", "comment_issue", { issue: `#${t.issue.number}`, text: "Tests pass.", landed: true }, false);
    await t.age();
    await recoverStaleRuns(deps());
    await recoverStaleRuns(deps());
    const [epoch] = await f.db.select().from(schema.runToolTokens).where(eq(schema.runToolTokens.id, t.epoch));
    expect(epoch?.effectEpochState).toBe("closed_unknown");
    const held = await heldEffectsOf(f.db, f.org.id, t.run.id);
    expect(held.effects).toEqual([
      expect.objectContaining({ id: `call:${t.epoch}:c1`, kind: "bridge_call", tools: ["comment_issue"] }),
      expect.objectContaining({ id: "marker" }),
    ]);
    expect((await runRow(t.run.id))?.status).toBe("running");
    // A member who is neither the agent's owner nor an approver can't say what happened.
    const member = await addMember(f.db, f.org.id, "member", "Rui");
    await expect(
      reconcileRunEffect(deps(), member.id, f.org.id, t.run.id, { effectId: `call:${t.epoch}:c1`, verdict: "done" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const out = await reconcileRunEffect(deps(), f.owner.id, f.org.id, t.run.id, {
      effectId: `call:${t.epoch}:c1`,
      verdict: "done",
    });
    expect(out.released).toBe(false);
    expect(out.remaining.map((e) => e.id)).toEqual(["marker"]);
    await reconcileRunEffect(deps(), f.owner.id, f.org.id, t.run.id, { effectId: "marker", verdict: "done" });
    await recoverStaleRuns(deps());
    expect((await runRow(t.run.id))?.status).toBe("failed");
    // The comment is there once: nothing was called again.
    const comments = await f.db
      .select()
      .from(schema.messages)
      .where(and(eq(schema.messages.agentRunId, t.run.id), eq(schema.messages.body, "Tests pass.")));
    expect(comments).toHaveLength(1);
  });

  test("a live turn (epoch open, recent beat) is never fenced nor reconciled", async () => {
    f = await setup({ machines: true });
    const t = await crashedTurn();
    await t.call("c1", "comment_issue", { issue: `#${t.issue.number}`, text: "x" }, false);
    await recoverStaleRuns(deps());
    const [epoch] = await f.db.select().from(schema.runToolTokens).where(eq(schema.runToolTokens.id, t.epoch));
    expect(epoch?.effectEpochState).toBe("open");
    expect((await heldEffectsOf(f.db, f.org.id, t.run.id)).open).toBe(true);
    await expect(
      reconcileRunEffect(deps(), f.owner.id, f.org.id, t.run.id, { effectId: `call:${t.epoch}:c1`, verdict: "done" }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});
