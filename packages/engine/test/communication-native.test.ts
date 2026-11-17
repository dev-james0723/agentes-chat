import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { and, eq, rowsOf, schema, sql } from "@agenteschat/db";
import { createIssue, getIssueDetail, updateIssue } from "../src/issues";
import { type Fixture, setup } from "./fixtures";

// Cold PGlite migration on a busy shared host exceeds the normal first-file limit.
setDefaultTimeout(120_000);

let fixture: Fixture | undefined;
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

describe("native task evidence revision", () => {
  test("existing writers advance a database-owned revision", async () => {
    const f = await setup();
    fixture = f;
    const deps = { db: f.db, pubsub: f.pubsub };
    const actor = { type: "person" as const, userId: f.owner.id };
    const issue = await createIssue(deps, actor, f.org.id, { title: "A versioned task" });
    const first = await f.db.select().from(schema.issues).where(eq(schema.issues.id, issue.id));
    expect(first[0]?.revision).toBe(1);
    await updateIssue(deps, actor, f.org.id, issue.id, { title: "A changed task" });
    const changed = await getIssueDetail(f.db, actor, f.org.id, { id: issue.id });
    expect(changed.revision).toBe(2);
    const updated = await f.db
      .update(schema.issues)
      .set({ revision: 9000 })
      .where(eq(schema.issues.id, issue.id))
      .returning();
    expect(updated[0]?.revision).toBe(3);
    expect(updated[0]?.communication).toBeNull();
  });

  test("stale compare-and-swap cannot mutate a current task", async () => {
    const f = await setup();
    fixture = f;
    const actor = { type: "person" as const, userId: f.owner.id };
    const issue = await createIssue({ db: f.db, pubsub: f.pubsub }, actor, f.org.id, { title: "Original" });
    const mutate = (title: string) =>
      f.db
        .update(schema.issues)
        .set({ title })
        .where(and(eq(schema.issues.orgId, f.org.id), eq(schema.issues.id, issue.id), eq(schema.issues.revision, 1)))
        .returning({ revision: schema.issues.revision, title: schema.issues.title });
    const accepted = await mutate("First writer");
    const stale = await mutate("Stale writer");
    expect(accepted).toEqual([{ revision: 2, title: "First writer" }]);
    expect(stale).toEqual([]);
    expect((await getIssueDetail(f.db, actor, f.org.id, { id: issue.id })).title).toBe("First writer");
  });

  test("legacy rows remain readable and metadata is not evidence", async () => {
    const f = await setup();
    fixture = f;
    const actor = { type: "person" as const, userId: f.owner.id };
    const issue = await createIssue({ db: f.db, pubsub: f.pubsub }, actor, f.org.id, { title: "Legacy" });
    await f.db
      .update(schema.issues)
      .set({ communication: { schemaVersion: "future", status: "LIVE_VERIFIED", granted: true } })
      .where(eq(schema.issues.id, issue.id));
    const visible = await getIssueDetail(f.db, actor, f.org.id, { id: issue.id });
    expect(visible.title).toBe("Legacy");
    expect(visible).not.toHaveProperty("communication");
    expect(visible).not.toHaveProperty("deliveryStage");
    const row = rowsOf<{ count: number }>(
      await f.db.execute(sql`select count(*)::int as count from context_items where lesson_verification is not null`),
    )[0];
    expect(row?.count).toBe(0);
  });

  test("native handoff admission key is durable and does not constrain ordinary comments", async () => {
    const f = await setup();
    fixture = f;
    const actor = { type: "person" as const, userId: f.owner.id };
    const issue = await createIssue({ db: f.db, pubsub: f.pubsub }, actor, f.org.id, { title: "Handoff" });
    const row = {
      orgId: f.org.id,
      issueId: issue.id,
      kind: "event",
      authorType: "person",
      authorId: f.owner.id,
      text: "",
      event: "communication_handoff_admitted",
      data: { schemaVersion: "1.0", idempotencyKey: "same-operation", consultationId: "receipt" },
    };
    await f.db.insert(schema.issueActivity).values(row);
    await expect(Promise.resolve(f.db.insert(schema.issueActivity).values(row))).rejects.toThrow();
    await f.db.insert(schema.issueActivity).values({ ...row, event: "comment" });
    await f.db.insert(schema.issueActivity).values({ ...row, event: "comment" });
    const another = await createIssue({ db: f.db, pubsub: f.pubsub }, actor, f.org.id, { title: "Other task" });
    await f.db.insert(schema.issueActivity).values({ ...row, issueId: another.id });
    const rows = await f.db
      .select()
      .from(schema.issueActivity)
      .where(
        and(
          eq(schema.issueActivity.issueId, issue.id),
          eq(schema.issueActivity.event, "communication_handoff_admitted"),
        ),
      );
    expect(rows).toHaveLength(1);
  });
});
