import { afterEach, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import { startFoundryTaskRun } from "../src/foundry/enrollment";
import { createLifecycleWorld } from "./foundry-lifecycle.fixture";
import { type Fixture, setup } from "./fixtures";
let f: Fixture;
afterEach(async () => { await f?.close(); });
async function ready() {
 f = await setup(); const w = await createLifecycleWorld(f);
 await f.db.update(schema.agents).set({ brain: "model" }).where(eq(schema.agents.id, f.agent.id));
 await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, w.ctx.runId));
 return w;
}
test("owner enrollment atomically pins the existing native task run and reuses the native outbox", async () => {
 const w = await ready(); const requestId = crypto.randomUUID();
 const deps = { db: f.db, pubsub: f.pubsub, qualify: () => w.executor.qualify() };
 const start = await startFoundryTaskRun(deps, f.owner.id, f.org.id, w.task.id, { requestId });
 const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, start.runId));
 expect(run).toMatchObject({ status: "queued", issueId: w.task.id, agentId: f.agent.id, brain: "model" });
 expect(run?.foundryPolicy).toMatchObject({ orgId: f.org.id, taskId: w.task.id, runIds: [start.runId] });
 const jobs = await f.db.select().from(schema.outbox).where(and(eq(schema.outbox.orgId, f.org.id), eq(schema.outbox.dedupeKey, `agent_run.execute:${start.runId}`)));
 expect(jobs).toHaveLength(1);
 expect(await startFoundryTaskRun(deps, f.owner.id, f.org.id, w.task.id, { requestId })).toEqual(start);
 expect(await f.db.select().from(schema.issues).where(eq(schema.issues.orgId, f.org.id))).toHaveLength(1);
});
test("a busy task is not duplicated and a non-owner cannot enroll or replace its policy", async () => {
 const w = await ready(); const deps = { db: f.db, pubsub: f.pubsub, qualify: () => w.executor.qualify() };
 await expect(startFoundryTaskRun(deps, "not-the-owner", f.org.id, w.task.id, { requestId: crypto.randomUUID() })).rejects.toThrow();
 await f.db.update(schema.agentRuns).set({ status: "running" }).where(eq(schema.agentRuns.id, w.ctx.runId));
 await expect(startFoundryTaskRun(deps, f.owner.id, f.org.id, w.task.id, { requestId: crypto.randomUUID() })).rejects.toThrow();
 expect(await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.orgId, f.org.id))).toHaveLength(1);
});
test("fresh session keeps the evaluated phase while expiry never silently renews its permission", async () => {
 const w = await ready(); const deps = { db: f.db, pubsub: f.pubsub, qualify: () => w.executor.qualify() };
 const first = await startFoundryTaskRun(deps, f.owner.id, f.org.id, w.task.id, { requestId: crypto.randomUUID() });
 await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, first.runId));
 const second = await startFoundryTaskRun(deps, f.owner.id, f.org.id, w.task.id, { requestId: crypto.randomUUID(), phaseFromRunId: first.runId });
 expect(second.phaseRef).toBe(first.phaseRef); expect(second.expiresAt).toBe(first.expiresAt); expect(second.runId).not.toBe(first.runId);
 await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, second.runId));
 const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, first.runId));
 await f.db.update(schema.agentRuns).set({ foundryPolicy: { ...run!.foundryPolicy, expiresAt: new Date(0).toISOString() } }).where(eq(schema.agentRuns.id, first.runId));
 await expect(startFoundryTaskRun(deps, f.owner.id, f.org.id, w.task.id, { requestId: crypto.randomUUID(), phaseFromRunId: first.runId })).rejects.toThrow();
});
