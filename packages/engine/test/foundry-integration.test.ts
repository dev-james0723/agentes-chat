import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { createNativeFoundryIntegration } from "../src/foundry/integration";
import { createLifecycleWorld } from "./foundry-lifecycle.fixture";
import { type Fixture, setup } from "./fixtures";
let f: Fixture;
afterEach(async () => { await f?.close(); });
test("turning off Foundry removes new tool access but never removes an enrolled run's restriction", async () => {
 f = await setup(); const w = await createLifecycleWorld(f);
 const pin = { phaseRef: "native-integration-fixture", orgId: f.org.id, taskId: w.task.id, agentId: f.agent.id,
   runIds: [w.ctx.runId], expiresAt: new Date(Date.now() + 60000).toISOString() };
 await f.db.update(schema.agentRuns).set({ foundryPolicy: pin }).where(eq(schema.agentRuns.id, w.ctx.runId));
 const i = createNativeFoundryIntegration({ db: f.db, blobs: f.artifactDeps.blobs, enabled: false, nativeReuse: async () => null });
 expect(await i.source.tools(w.ctx)).toEqual([]);
 expect((await i.builderPolicy.beforeBrain(w.ctx, "claude")).ok).toBe(false);
 expect((await i.builderPolicy.beforeBrain(w.ctx, "model")).ok).toBe(true);
 expect(await i.controls.authorizeExecution!({}, new AbortController().signal)).toBe(false);
 await expect(i.controls.package!({ orgId: f.org.id, digest: "a".repeat(64) }, new AbortController().signal)).rejects.toThrow();
});
test("unpinned ordinary runs remain unchanged while malformed persisted pins fail closed", async () => {
 f = await setup(); const w = await createLifecycleWorld(f);
 const i = createNativeFoundryIntegration({ db: f.db, blobs: f.artifactDeps.blobs, enabled: true, nativeReuse: async () => null });
 expect((await i.builderPolicy.beforeBrain(w.ctx, "claude")).ok).toBe(true);
 expect(await i.source.tools(w.ctx)).toEqual([]);
 await f.db.update(schema.agentRuns).set({ foundryPolicy: { phaseRef: "malformed" } }).where(eq(schema.agentRuns.id, w.ctx.runId));
 expect((await i.builderPolicy.beforeBrain(w.ctx, "claude")).ok).toBe(false);
 expect(await i.source.tools(w.ctx)).toEqual([]);
});
