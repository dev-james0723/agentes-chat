import { afterEach, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import { createFoundryService } from "../src/foundry/service";
import type { ToolContext } from "../src/tools/types";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

async function ready() {
  f = await setup();
  const [task] = await f.db
    .insert(schema.issues)
    .values({
      orgId: f.org.id,
      number: 9001,
      title: "Normalize synthetic task receipts",
      createdByType: "person",
      createdById: f.owner.id,
      assigneeType: "agent",
      assigneeId: f.agent.id,
      restricted: true,
      audienceUserIds: [f.owner.id],
    })
    .returning();
  const [message] = await f.db
    .insert(schema.messages)
    .values({
      orgId: f.org.id,
      channelId: f.general.id,
      authorType: "person",
      authorUserId: f.owner.id,
      body: "Normalize synthetic task receipts using receipt-normalizer/v1.",
    })
    .returning();
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: message!.id,
      triggerMessageId: message!.id,
      trigger: "mention",
      hop: 1,
      status: "running",
      issueId: task!.id,
    })
    .returning();
  const ctx: ToolContext = {
    db: f.db,
    orgId: f.org.id,
    agentId: f.agent.id,
    runId: run!.id,
    channelId: f.general.id,
    threadRootId: message!.id,
    triggerMessageId: message!.id,
    toolUseId: "foundry-test-intake",
  };
  const service = createFoundryService({ db: f.db, blobs: f.artifactDeps.blobs });
  return { task: task!, message: message!, run: run!, ctx, service };
}

test("intake binds the existing native task and does not create an agent, task or schedule", async () => {
  const { service, ctx, task } = await ready();
  const before = await Promise.all([
    f.db.select().from(schema.issues),
    f.db.select().from(schema.agents),
    f.db.select().from(schema.routines),
  ]);
  const result = await service.propose(ctx, { needKey: "receipt-normalizer/v1" });
  expect(result.kind).toBe("draft");
  expect(result.candidate).toMatchObject({ taskId: task.id, needKey: "receipt-normalizer/v1" });
  expect((await f.db.select().from(schema.issues)).length).toBe(before[0].length);
  expect((await f.db.select().from(schema.agents)).length).toBe(before[1].length);
  expect((await f.db.select().from(schema.routines)).length).toBe(before[2].length);
});

test("concurrent equal needs deduplicate in the database and survive a fresh service instance", async () => {
  const { service, ctx } = await ready();
  const results = await Promise.all(
    Array.from({ length: 8 }, () => service.propose(ctx, { needKey: "receipt-normalizer/v1" })),
  );
  expect(results.every((r) => r.kind === "draft")).toBe(true);
  expect(new Set(results.map((r) => (r.kind === "draft" ? r.candidate.id : "unexpected-reuse"))).size).toBe(1);
  const fresh = createFoundryService({ db: f.db, blobs: f.artifactDeps.blobs });
  const first = results[0];
  if (!first || first.kind !== "draft") throw new Error("Expected a native draft");
  expect((await fresh.list(ctx)).map((r) => r.id)).toEqual([first.candidate.id]);
});

test("a forged task argument, stopped run, unattended run and withdrawn membership cannot start a draft", async () => {
  const { service, ctx, run } = await ready();
  await expect(
    service.propose(ctx, { needKey: "receipt-normalizer/v1", taskId: crypto.randomUUID() } as never),
  ).rejects.toMatchObject({ code: "SCHEMA_INVALID" });
  await f.db.update(schema.agentRuns).set({ status: "canceled" }).where(eq(schema.agentRuns.id, run.id));
  await expect(service.propose(ctx, { needKey: "receipt-normalizer/v1" })).rejects.toMatchObject({
    code: "AUTHORITY_DENIED",
  });
  await f.db
    .update(schema.agentRuns)
    .set({ status: "running", background: true })
    .where(eq(schema.agentRuns.id, run.id));
  await expect(service.propose(ctx, { needKey: "receipt-normalizer/v1" })).rejects.toMatchObject({
    code: "AUTHORITY_DENIED",
  });
  await f.db.update(schema.agentRuns).set({ background: false }).where(eq(schema.agentRuns.id, run.id));
  await f.db
    .delete(schema.organizationMembers)
    .where(and(eq(schema.organizationMembers.orgId, f.org.id), eq(schema.organizationMembers.userId, f.owner.id)));
  await expect(service.propose(ctx, { needKey: "receipt-normalizer/v1" })).rejects.toMatchObject({
    code: "AUTHORITY_DENIED",
  });
});

test("private candidates are filtered before their identifiers or names reach another task reader", async () => {
  const { service, ctx, message } = await ready();
  await service.propose(ctx, { needKey: "receipt-normalizer/v1" });
  const other = await addMember(f.db, f.org.id, "member", "other");
  await f.db.update(schema.messages).set({ authorUserId: other.id }).where(eq(schema.messages.id, message.id));
  expect(await service.list(ctx)).toEqual([]);
});

test("an existing enabled native skill wins before candidate creation", async () => {
  const { service, ctx } = await ready();
  const [skill] = await f.db
    .insert(schema.skills)
    .values({
      orgId: f.org.id,
      slug: "receipt-normalizer",
      name: "Receipt normalizer",
      description: "Normalize synthetic task receipts",
      body: "Use the existing verified workflow.",
      metadata: { foundryContract: "receipt-normalizer/v1" },
      source: "manual",
      createdByUserId: f.owner.id,
    })
    .returning();
  await f.db
    .insert(schema.agentSkills)
    .values({ orgId: f.org.id, agentId: f.agent.id, skillId: skill!.id, enabled: true });
  const result = await service.propose(ctx, { needKey: "receipt-normalizer/v1" });
  expect(result).toMatchObject({ kind: "reuse", existing: { kind: "skill", id: skill!.id, version: 1 } });
  expect(await service.list(ctx)).toEqual([]);
});
