import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { nativeSkillSourceFacts, readNativeSkillSourceProof } from "../src/contextual-skill-native-read-proof";
import { nativePublishedReadFixture } from "./contextual-skill-native-read.fixture";

let fixture: Awaited<ReturnType<typeof nativePublishedReadFixture>>;
afterEach(async () => {
  await fixture?.f.close();
});

test("genuine executed native owner sharing decision and action uniquely prove this body version without making its source public", async () => {
  fixture = await nativePublishedReadFixture();
  const { f, ctx, selected, body } = fixture;
  const before = (await f.db.select().from(schema.skills).where(eq(schema.skills.id, selected.skillId)))[0]!.useCount;
  const result = await readNativeSkillSourceProof(f.db, ctx, selected);
  expect(result.status).toBe("verified");
  if (result.status !== "verified") throw new Error(result.reason);
  const facts = nativeSkillSourceFacts(result.proof);
  expect(facts).toMatchObject({
    kind: "native_executed_org_publication",
    originalSourcePrivacy: "private",
    approvedReadAudience: "org_skill_library",
    skillId: selected.skillId,
    skillVersion: 2,
    sourceOwnerId: f.owner.id,
    readerPersonId: f.owner.id,
  });
  expect(JSON.stringify(facts)).not.toContain(body);
  expect(nativeSkillSourceFacts({})).toBeNull();
  expect(nativeSkillSourceFacts({ ...result.proof })).toBeNull();
  expect((await f.db.select().from(schema.skills).where(eq(schema.skills.id, selected.skillId)))[0]!.useCount).toBe(
    before,
  );
});

test.each([
  "legacy-link",
  "wrong-action",
  "wrong-body",
  "source-edit",
  "approval-refused",
  "reader-assignment",
  "reader-terminal",
  "resource-added",
] as const)("native proof refuses %s without returning body", async (mode) => {
  fixture = await nativePublishedReadFixture();
  const { f, ctx, selected, approval, body } = fixture;
  if (mode === "legacy-link")
    await f.db
      .update(schema.approvals)
      .set({ result: { content: "published", data: { version: 2 } } })
      .where(eq(schema.approvals.id, approval.id));
  if (mode === "wrong-action") {
    const data = (approval.result as { data?: Record<string, unknown> } | null)?.data ?? {};
    await f.db
      .update(schema.approvals)
      .set({
        result: {
          data: {
            ...data,
            nativePublicationExecution: {
              ...(data.nativePublicationExecution as object),
              actionId: crypto.randomUUID(),
            },
          },
        },
      })
      .where(eq(schema.approvals.id, approval.id));
  }
  if (mode === "wrong-body")
    await f.db
      .update(schema.skills)
      .set({ body: "Different same-version body" })
      .where(eq(schema.skills.id, selected.skillId));
  if (mode === "source-edit")
    await f.db
      .update(schema.messages)
      .set({ body: "Changed original source" })
      .where(
        eq(
          schema.messages.id,
          (approval.params as { publication: { triggerMessageId: string } }).publication.triggerMessageId,
        ),
      );
  if (mode === "approval-refused")
    await f.db.update(schema.approvals).set({ status: "refused" }).where(eq(schema.approvals.id, approval.id));
  if (mode === "reader-assignment")
    await f.db
      .update(schema.agentSkills)
      .set({ enabled: false })
      .where(eq(schema.agentSkills.skillId, selected.skillId));
  if (mode === "reader-terminal")
    await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, ctx.runId));
  if (mode === "resource-added")
    await f.db.insert(schema.skillFiles).values({
      orgId: f.org.id,
      skillId: selected.skillId,
      version: 2,
      path: "unexpected.txt",
      mime: "text/plain",
      size: 4,
      status: "stored",
    });
  const result = await readNativeSkillSourceProof(f.db, ctx, selected);
  expect(result.status).toBe("unqualified");
  expect(JSON.stringify(result)).not.toContain(body);
});

test("native writer preserves unrelated result fields and keeps the bidirectional execution link out of public action params", async () => {
  fixture = await nativePublishedReadFixture({
    publicationResult: {
      content: "Existing protected receipt",
      data: { kept: "unrelated", nested: { v: 1 } },
      custom: { keep: true },
    },
  });
  const { f, approval } = fixture;
  expect(approval.result).toMatchObject({
    content: "Existing protected receipt",
    data: { kept: "unrelated", nested: { v: 1 }, version: 2 },
    custom: { keep: true },
  });
  const [action] = await f.db.select().from(schema.agentActions).where(eq(schema.agentActions.runId, approval.runId!));
  expect(action?.state.nativePublicationExecution).toEqual(
    (approval.result?.data as Record<string, unknown> | undefined)?.nativePublicationExecution,
  );
  expect(JSON.stringify(action?.params)).not.toContain(approval.id);
  expect((await readNativeSkillSourceProof(f.db, fixture.ctx, fixture.selected)).status).toBe("verified");
});
test.each([{ nativePublicationExecution: null }, { nativePublicationExecution: { foreign: true } }, { version: 999 }])(
  "native writer refuses foreign preexisting link/version and rolls back skill/action/executed marker",
  async (data) => {
    fixture = await nativePublishedReadFixture({
      publicationResult: { content: "Preserve original", data },
      publicationExpected: false,
    });
    const { f, approval, published } = fixture;
    expect(published.version).toBe(1);
    expect(approval.executedAt).toBeNull();
    expect(approval.result).toEqual({ content: "Preserve original", data });
    expect(
      await f.db.select().from(schema.agentActions).where(eq(schema.agentActions.runId, approval.runId!)),
    ).toHaveLength(0);
  },
);
