import { expect, setDefaultTimeout, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { createIssue } from "@agenteschat/engine";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp } from "./harness";

setDefaultTimeout(180_000);

test("existing memory-scorecard gates native economics by exact rollout scope and task visibility", async () => {
  const t = await createTestServer();
  try {
    const owner = browser(t);
    await signUp(owner, "owner@example.com");
    const f = await seedOrg(owner);
    const [person] = await t.db.select().from(schema.users).where(eq(schema.users.email, "owner@example.com"));
    if (!person) throw new Error("owner missing");
    const task = await createIssue(
      { db: t.db, pubsub: t.adapters.pubsub },
      { type: "person", userId: person.id },
      f.orgId,
      { title: "Scoped economics" },
    );
    const path = `/api/app/organizations/${f.orgId}/agents/${f.agentId}/memory-scorecard`;
    const get = (taskId?: string) => owner(path + (taskId ? `?taskId=${taskId}` : ""));
    expect((await t.app.request(path)).status).toBe(401);
    expect(await (await get(task.id)).json()).not.toHaveProperty("economics");

    t.config.COMMUNICATION_ENABLED = true;
    t.config.COMMUNICATION_ORG_IDS = [f.orgId];
    t.config.COMMUNICATION_TASK_IDS = [task.id];
    t.config.COMMUNICATION_FEATURES = ["economics"];
    expect(await (await get()).json()).not.toHaveProperty("economics");
    expect(await (await get(crypto.randomUUID())).json()).not.toHaveProperty("economics");
    const admitted = await get(task.id);
    expect(admitted.status).toBe(200);
    const body = (await admitted.json()) as {
      economics: {
        report: { verifiedSuccessfulTasks: number; tokensPerVerifiedOutcome: number | null; savingsClaim: string };
        source: { taskId: string; independentOutcomes: string };
      };
    };
    expect(body.economics.source.taskId).toBe(task.id);
    expect(body.economics.source.independentOutcomes).toBe("unavailable");
    expect(body.economics.report.verifiedSuccessfulTasks).toBe(0);
    expect(body.economics.report.tokensPerVerifiedOutcome).toBeNull();
    expect(body.economics.report.savingsClaim).toBe("not_evaluated");

    // Native audience rules, not rollout admission, decide whether a person can see a task.
    await t.db
      .update(schema.issues)
      .set({ restricted: true, audienceUserIds: [] })
      .where(eq(schema.issues.id, task.id));
    // Native administrators can see restricted tasks. Check denial for a non-admin agent owner.
    const member = await joinByInvitation(t, owner, f.orgId, "reader@example.com");
    const [reader] = await t.db.select().from(schema.users).where(eq(schema.users.email, "reader@example.com"));
    if (!reader) throw new Error("reader missing");
    await t.db.update(schema.agents).set({ ownerUserId: reader.id }).where(eq(schema.agents.id, f.agentId));
    expect((await member(path)).status).toBe(200);
    expect((await get(task.id)).status).toBe(200);
    const hidden = await member(`${path}?taskId=${task.id}`);
    expect([403, 404]).toContain(hidden.status);
    const hiddenBody = await hidden.text();
    expect(hiddenBody).not.toContain("Scoped economics");
    expect(hiddenBody).not.toContain("native_usage_records");
  } finally {
    await t.close();
  }
});
