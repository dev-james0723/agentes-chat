import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { grantScopes, openPersonAgentDm, saveSkill, setAgentSkills } from "@agenteschat/engine";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(async () => {
  await t?.close();
});
const marker = "SYNTHETIC_PRIVATE_HTTP_0191";
test("authenticated native GET previews the whole draft only to its owner; exact POST publishes once", async () => {
  let active = false;
  let phase = 0;
  t = await createTestServer({
    reply: () =>
      !active
        ? { chunks: ["Fixture ready"] }
        : ++phase === 1
          ? { chunks: [], toolUses: [{ name: "load_skill", input: { name: "http-private-method" } }] }
          : phase === 2
            ? {
                chunks: [],
                toolUses: [
                  { name: "update_skill", input: { name: "http-private-method", body: `Exact draft ${marker}` } },
                ],
              }
            : { chunks: ["Phase completed."] },
  });
  const owner = browser(t);
  await signUp(owner, "private-owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const ownerId = ((await (await owner("/api/app/me")).json()) as { user: { id: string } }).user.id;
  const other = await joinByInvitation(t, owner, orgId, "unrelated-admin@example.com", { role: "admin" });
  const skill = await saveSkill(t.engine.artifacts, ownerId, orgId, {
    name: "http-private-method",
    body: "Public base",
    description: "A method",
    source: "manual",
    metadata: {},
  });
  await setAgentSkills(t.db, ownerId, orgId, agentId, [{ skillId: skill.id, enabled: true }]);
  await grantScopes(t.db, orgId, agentId, [{ connectionId: null, scope: "skills:read" }]);
  const dm = await openPersonAgentDm(t.db, orgId, ownerId, agentId);
  const at = `/api/app/organizations/${orgId}`;
  active = true;
  expect(
    (
      await owner(`${at}/channels/${dm.id}/messages`, {
        json: { body: `@dev improve this privately; do not share ${marker} without a separate decision.` },
      })
    ).status,
  ).toBe(201);
  await t.drain();
  const [a] = await t.db.select().from(schema.approvals).where(eq(schema.approvals.orgId, orgId));
  expect(a).toBeDefined();
  const list = await other(`${at}/approvals`);
  expect(await list.json()).toEqual({ approvals: [] });
  expect((await other(`${at}/approvals/${a!.id}`)).status).toBe(404);
  const previewResponse = await owner(`${at}/approvals/${a!.id}`);
  expect(previewResponse.status).toBe(200);
  const preview = (await previewResponse.json()) as {
    publicationRequired: boolean;
    params: unknown;
    publication: { body: string; fingerprint: string; skillName: string; baseVersion: number };
  };
  expect(preview.publicationRequired).toBe(true);
  expect(preview.params).toEqual({});
  expect(preview.publication.body).toBe(`Exact draft ${marker}`);
  expect(preview.publication.skillName).toBe(skill.name);
  expect(preview.publication.baseVersion).toBe(skill.version);
  expect((await owner(`${at}/approvals/${a!.id}/approve`, { json: {} })).status).toBe(403);
  expect(
    (
      await other(`${at}/approvals/${a!.id}/approve`, {
        json: { publicationFingerprint: preview.publication.fingerprint },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await owner(`${at}/approvals/${a!.id}/approve`, {
        json: { publicationFingerprint: preview.publication.fingerprint },
      })
    ).status,
  ).toBe(200);
  await t.drain();
  const result = await other(`${at}/skills/${skill.id}`);
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ body: `Exact draft ${marker}`, version: skill.version + 1 });
});
