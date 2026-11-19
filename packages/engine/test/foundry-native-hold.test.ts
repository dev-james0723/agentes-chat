import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import { type Fixture, setup } from "./fixtures";
import { createLifecycleWorld, FRESH_INPUT } from "./foundry-lifecycle.fixture";

// Native operator-hold regression. PGlite and simulated trusted services only;
// the candidate package is inert data and no generated program is executed.
let f: Fixture;
afterEach(async () => {
  await f?.close();
});

describe("native operator hold fences Foundry work (SIMULATION)", () => {
  test("a currently held agent cannot create a new capability proposal", async () => {
    f = await setup();
    const w = await createLifecycleWorld(f);
    await f.db
      .update(schema.agents)
      .set({ operatorHoldAt: w.state.now })
      .where(and(eq(schema.agents.orgId, f.org.id), eq(schema.agents.id, f.agent.id)));
    await expect(w.service.propose(w.ctx, { needKey: "receipt-normalizer/v1" })).rejects.toMatchObject({
      code: "AUTHORITY_DENIED",
    });
    expect(await f.db.select().from(schema.foundryCandidates)).toHaveLength(0);
    expect(w.state.evaluations).toBe(0);
    expect(w.state.executions).toHaveLength(0);
  });

  test("a hold withdraws current discovery and prevents dispatch through a previously cached binding", async () => {
    f = await setup();
    const w = await createLifecycleWorld(f);
    const staged = await w.stage();
    const active = await w.activate(staged);
    expect(
      await w.lifecycle.runCanary({ ...w.ctx, toolUseId: "before-operator-hold" }, active.binding.id),
    ).toMatchObject({ outcome: "PASS" });
    const fresh = await w.session();
    const cached = await w.makeLifecycle().discover(fresh);
    expect(cached).toHaveLength(1);
    const binding = cached[0]!;
    const before = w.state.executions.length;
    await f.db
      .update(schema.agents)
      .set({ operatorHoldAt: w.state.now })
      .where(and(eq(schema.agents.orgId, f.org.id), eq(schema.agents.id, f.agent.id)));
    const held = w.makeLifecycle();
    expect(await held.discover(fresh)).toEqual([]);
    await expect(
      held.execute(
        { ...fresh, toolUseId: "cached-after-operator-hold" },
        {
          bindingId: binding.bindingId,
          digest: binding.digest,
          input: FRESH_INPUT,
        },
      ),
    ).rejects.toMatchObject({ code: "AUTHORITY_DENIED" });
    expect(w.state.executions).toHaveLength(before);
    expect(await f.db.select().from(schema.foundryInvocations)).toHaveLength(1);
    const [uncharged] = await f.db
      .select()
      .from(schema.foundryBindings)
      .where(eq(schema.foundryBindings.id, active.binding.id));
    expect(uncharged?.reservedCalls).toBe(1);
  });
});
