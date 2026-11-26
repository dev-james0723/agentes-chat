import { expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { screenExercise } from "../../../packages/engine/src/screen/app-exercise";
import type { PlanReport } from "../../../packages/engine/src/screen/plan";
import { callTool, connectApp } from "./ai-apps";
import { browser, createTestServer, seedOrg, signUp } from "./harness";

test("same-grant original task yields only its checked native action, machine and result hashes", async () => {
  const t = await createTestServer();
  try {
    const b = browser(t);
    await signUp(b, "owner@example.com");
    const { orgId, agentId, channelId } = await seedOrg(b);
    const ownerId = ((await (await b("/api/app/me")).json()) as { user: { id: string } }).user.id;
    const mode = { name: "Exercise", access: "manage" as const, scope: "read write manage" };
    const app = await connectApp(t, b, orgId, mode);
    const [grant] = await t.db.select().from(schema.appGrants).where(eq(schema.appGrants.orgId, orgId));
    const [machine] = await t.db.insert(schema.machines).values({ orgId, name: "Exercise Mac" }).returning();
    const [trigger] = await t.db
      .insert(schema.messages)
      .values({ orgId, channelId, authorType: "person", authorUserId: ownerId, body: "Check output" })
      .returning();
    if (!grant || !machine || !trigger) throw Error("fixture");
    await t.db
      .insert(schema.appSends)
      .values({ orgId, grantId: grant.id, userId: ownerId, agentId, channelId, messageId: trigger.id });
    const [run] = await t.db
      .insert(schema.agentRuns)
      .values({
        orgId,
        agentId,
        channelId,
        triggerMessageId: trigger.id,
        threadRootId: trigger.id,
        trigger: "mention",
        hop: 1,
        status: "done",
        finishedAt: new Date(),
      })
      .returning();
    if (!run) throw Error("run");
    const [reply] = await t.db
      .insert(schema.messages)
      .values({
        orgId,
        channelId,
        authorType: "agent",
        authorAgentId: agentId,
        agentRunId: run.id,
        body: "Observed the result.",
      })
      .returning();
    if (!reply) throw Error("reply");
    await t.db.update(schema.agentRuns).set({ replyMessageId: reply.id }).where(eq(schema.agentRuns.id, run.id));
    const output = "Subtotal 5739";
    const before = { url: "https://ledger.example/input", elements: [], lines: ["private screen"], at: 123 };
    const after = { ...before, url: "https://ledger.example/result", lines: ["private screen", output], at: 130 };
    const plan: PlanReport = {
      steps: [
        { step: { do: "click", expect: output }, status: "done", ran: true, expected: { met: true, p: 1 }, ms: 1 },
      ],
      before,
      after,
      changes: null,
      ms: 1,
    };
    const stamp = screenExercise(machine.id, "browser", plan);
    if (!stamp.appExercise) throw Error("missing native witness");
    expect(screenExercise(machine.id, "browser", { ...plan, before: after })).toEqual({});
    expect(
      screenExercise(machine.id, "browser", { ...plan, before: { ...before, url: "https://other.example/" } }),
    ).toEqual({});
    expect(screenExercise(machine.id, "browser", { ...plan, after: { ...after, lines: ["something else"] } })).toEqual(
      {},
    );
    const only = plan.steps[0];
    if (!only) throw Error("missing test step");
    expect(screenExercise(machine.id, "browser", { ...plan, steps: [{ ...only, ran: false }] })).toEqual({});
    await t.db.insert(schema.agentRunSteps).values(
      [false, true].map((external, i) => ({
        orgId,
        runId: run.id,
        seq: i + 1,
        kind: "tool_result" as const,
        data: { name: "browser_do", isError: false, external, data: stamp },
      })),
    );
    const args = {
      task_id: trigger.id,
      run_id: run.id,
      reply_id: reply.id,
      agent_id: agentId,
      machine: machine.name,
      target: "https://ledger.example",
      output_sha256: stamp.appExercise.outputHash,
    };
    const call = (extra: Record<string, unknown> = {}, token = app.access) =>
      callTool(t, token, "read_app_exercise", { ...args, ...extra });
    const first = await call();
    expect(first.isError, JSON.stringify(first.content)).not.toBe(true);
    expect(first.structuredContent?.observations).toHaveLength(1);
    expect(first.structuredContent).toMatchObject({
      direct_reply: { task_id: trigger.id, run_id: run.id, reply_id: reply.id, agent_id: agentId },
      observations: [
        {
          surface: "browser",
          machine_id: machine.id,
          operation: "click",
          snapshot_sha256: stamp.appExercise.snapshotHash,
        },
      ],
    });
    expect(JSON.stringify(first)).not.toContain("private screen");
    expect((await call({ machine: "Other machine" })).structuredContent?.observations).toEqual([]);
    expect((await call({ output_sha256: "0".repeat(64) })).structuredContent?.observations).toEqual([]);
    const other = await connectApp(t, b, orgId, { ...mode, name: "Other" });
    expect((await call({}, other.access)).isError).toBe(true);
    await t.db.update(schema.messages).set({ editedAt: new Date() }).where(eq(schema.messages.id, reply.id));
    expect((await call()).isError).toBe(true);
  } finally {
    await t.close();
  }
});
