import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { createLifecycleWorld } from "./foundry-lifecycle.fixture";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => { await f?.close(); });

test("builder protection reads the enclosing transaction without a second connection or stale committed state", async () => {
  f = await setup();
  const world = await createLifecycleWorld(f);
  const initial = await world.builderPolicy.protection(world.ctx);
  expect(initial).not.toBeNull();
  await f.db.transaction(async (tx) => {
    await tx.update(schema.agentRuns).set({ status: "waiting_input" })
      .where(eq(schema.agentRuns.id, world.ctx.runId));
    const waiting = await world.builderPolicy.protection(world.ctx, "active", tx);
    expect(waiting?.policyDigest).toBe(initial?.policyDigest);
    await tx.update(schema.agentRuns).set({ status: "canceled" })
      .where(eq(schema.agentRuns.id, world.ctx.runId));
    expect(await world.builderPolicy.protection(world.ctx, "active", tx)).toBeNull();
  });
});
