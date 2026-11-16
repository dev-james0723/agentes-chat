import { expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp } from "./harness";

test("founder detail projection is default off, scoped, viewer-specific and never trusts raw task metadata", async () => {
  const t = await createTestServer();
  try {
    const owner = browser(t);
    await signUp(owner, "founder-owner@example.com");
    const { orgId } = await seedOrg(owner);
    const base = `/api/app/organizations/${orgId}/issues`;
    const created = await owner(base, { json: { title: "Review the outcome", criteria: ["Run verification"] } });
    expect(created.status).toBe(201);
    const issue = (await created.json()) as { id: string; number: number };
    const disabled = (await (await owner(`${base}/${issue.id}`)).json()) as Record<string, unknown>;
    expect(disabled.founderUpdate).toBeUndefined();

    const [person] = await t.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, "founder-owner@example.com"));
    if (!person) throw new Error("Fixture member missing");
    await t.db.update(schema.users).set({ locale: "zh-HK" }).where(eq(schema.users.id, person.id));
    await t.db
      .update(schema.organizationMembers)
      .set({ agentStyle: "technical" })
      .where(and(eq(schema.organizationMembers.orgId, orgId), eq(schema.organizationMembers.userId, person.id)));
    await t.db
      .update(schema.issues)
      .set({
        communication: {
          deliveryStage: "LIVE_VERIFIED",
          availability: "production",
          checks: { passed: 500, failed: 0, notRun: 0 },
        },
      })
      .where(eq(schema.issues.id, issue.id));
    t.config.COMMUNICATION_ENABLED = true;
    t.config.COMMUNICATION_ORG_IDS = [orgId];
    t.config.COMMUNICATION_TASK_IDS = [issue.id];
    t.config.COMMUNICATION_FEATURES = ["founderUpdates"];
    for (const path of [`${base}/${issue.id}`, `${base}/by-number/${issue.number}`]) {
      const response = await owner(path);
      expect(response.status).toBe(200);
      const detail = (await response.json()) as {
        founderUpdate: {
          taskId: string;
          taskRevision: number;
          locale: string;
          style: string;
          deliveryStage: unknown;
          availability: string;
          checks: unknown;
          evidence: unknown[];
          contract: unknown;
        };
      };
      expect(detail.founderUpdate).toMatchObject({
        taskId: issue.id,
        locale: "zh-HK",
        style: "technical",
        deliveryStage: null,
        availability: "unknown",
        checks: null,
        evidence: [],
        contract: null,
      });
      expect(detail.founderUpdate.taskRevision).toBeGreaterThanOrEqual(0);
    }
    const other = (await (await owner(base, { json: { title: "Outside the canary" } })).json()) as { id: string };
    expect(
      ((await (await owner(`${base}/${other.id}`)).json()) as Record<string, unknown>).founderUpdate,
    ).toBeUndefined();
    const secondOrg = await seedOrg(owner);
    const outsider = await joinByInvitation(t, owner, secondOrg.orgId, "founder-outsider@example.com");
    const [outsiderRecord] = await t.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, "founder-outsider@example.com"));
    if (!outsiderRecord) throw new Error("Fixture outsider missing");
    // Signup may seed existing workspace memberships. Establish this synthetic outsider explicitly.
    await t.db
      .delete(schema.organizationMembers)
      .where(
        and(eq(schema.organizationMembers.orgId, orgId), eq(schema.organizationMembers.userId, outsiderRecord.id)),
      );
    const originalMembership = await t.db
      .select({ userId: schema.organizationMembers.userId })
      .from(schema.organizationMembers)
      .where(
        and(eq(schema.organizationMembers.orgId, orgId), eq(schema.organizationMembers.userId, outsiderRecord.id)),
      );
    expect(originalMembership).toHaveLength(0);
    const outsiderMe = (await (await outsider("/api/app/me")).json()) as { user: { email: string } };
    expect(outsiderMe.user.email).toBe("founder-outsider@example.com");
    expect([403, 404]).toContain((await outsider(`${base}/${issue.id}`)).status);
    t.config.COMMUNICATION_ENABLED = false;
    expect(
      ((await (await owner(`${base}/${issue.id}`)).json()) as Record<string, unknown>).founderUpdate,
    ).toBeUndefined();
  } finally {
    await t.close();
  }
});
