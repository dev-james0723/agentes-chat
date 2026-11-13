import { afterEach, expect, test } from "bun:test";
import { eq, schema, tracingLogger } from "@agenteschat/db";
import { createJobHandlers, drainOutbox, enableCaches, postPersonMessage } from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
const originalLog = tracingLogger.logQuery;
afterEach(async () => {
  tracingLogger.logQuery = originalLog;
  enableCaches(false);
  await f?.close();
});

async function projectedRun(
  options: {
    meta?: Record<string, unknown>;
    background?: boolean;
    enabled?: boolean;
    mappedWithoutReceipt?: boolean;
  } = {},
) {
  let agentRequests = 0;
  f = await setup({
    reply: (request) => {
      if (!request.outputSchema) agentRequests++;
      return { chunks: ["ordinary fixture answer"] };
    },
  });
  let projectLookups = 0;
  tracingLogger.logQuery = (query?: string) => {
    if (query?.includes('inner join "routine_runs"') && query.includes('left join "paperclip_routine_mappings"'))
      projectLookups++;
    originalLog();
  };
  const message = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev answer this fixture",
  });
  if (options.meta)
    await f.db.update(schema.messages).set({ meta: options.meta }).where(eq(schema.messages.id, message.id));
  if (options.background !== undefined) {
    const runs = await f.db
      .update(schema.agentRuns)
      .set({ background: options.background })
      .where(eq(schema.agentRuns.triggerMessageId, message.id))
      .returning();
    expect(runs).toHaveLength(1);
  }
  if (options.mappedWithoutReceipt) {
    const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, message.id));
    const [routine] = await f.db
      .insert(schema.routines)
      .values({
        orgId: f.org.id,
        agentId: f.agent.id,
        name: "Project fixture",
        prompt: "Fixture task",
        target: { type: "dm" },
        triggerType: "event",
        event: "paperclip.received",
        createdByUserId: f.owner.id,
      })
      .returning();
    if (!run || !routine) throw new Error("Missing synthetic fixture run or routine");
    await f.db.insert(schema.paperclipRoutineMappings).values({
      orgId: f.org.id,
      sourceCompanyId: crypto.randomUUID(),
      sourceRoutineId: crypto.randomUUID(),
      configHash: "a".repeat(64),
      nativeConfigHash: "b".repeat(64),
      agentId: f.agent.id,
      sourceActive: true,
      triggers: [],
      policy: "always_enqueue",
      routineId: routine.id,
      enabled: true,
      definition: {
        title: "Fixture",
        description: "Fixture",
        priority: "low",
        sourceAgentId: crypto.randomUUID(),
        projectId: crypto.randomUUID(),
        projectWorkspaceId: crypto.randomUUID(),
        workspaceBindingId: crypto.randomUUID(),
        goalId: null,
        parentIssueId: null,
        variables: [],
        envFingerprint: "c".repeat(64),
        activityGatePolicy: "always",
        activityGateScope: "project",
        catchUpPolicy: "skip_missed",
        executionContract: "issue_reference_v1",
      },
    });
    await f.db.insert(schema.routineRuns).values({
      orgId: f.org.id,
      routineId: routine.id,
      agentRunId: run.id,
      at: new Date(),
      trigger: "event",
      status: "started",
      event: { type: "paperclip.received" },
    });
  }
  await drainOutbox(f.db, createJobHandlers({ ...f.jobDeps, paperclipCompatibilityEnabled: options.enabled }));
  const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, message.id));
  expect(run).toBeDefined();
  return { run, projectLookups, agentRequests };
}

test("ordinary foreground projection does not query the persisted project-routine join", async () => {
  const { run, projectLookups, agentRequests } = await projectedRun();
  expect(run).toMatchObject({ background: false, status: "done" });
  expect(projectLookups).toBe(0);
  expect(agentRequests).toBeGreaterThan(0);
});

test("background projection still queries project authority when compatibility is off", async () => {
  const { projectLookups } = await projectedRun({ background: true, enabled: false });
  expect(projectLookups).toBeGreaterThan(0);
});

for (const meta of [{ routineBrief: {} }, { routine: null }, { viaRoutine: false }, { background: false }]) {
  test(`foreground projection with raw ${Object.keys(meta)[0]} marker retains the project lookup`, async () => {
    const { projectLookups } = await projectedRun({ meta, enabled: false });
    expect(projectLookups).toBeGreaterThan(0);
  });
}

for (const scenario of [
  { name: "feature disabled after admission", background: true, enabled: false },
  { name: "missing receipt", background: true, enabled: true },
  { name: "forged foreground flag with routine marker", background: false, enabled: true },
]) {
  test(`project projection refuses ${scenario.name} before an agent request`, async () => {
    const { run, projectLookups, agentRequests } = await projectedRun({
      ...scenario,
      mappedWithoutReceipt: true,
      meta: { routineBrief: {} },
    });
    expect(projectLookups).toBeGreaterThan(0);
    expect(agentRequests).toBe(0);
    expect(run?.status).toBe("failed");
  });
}
