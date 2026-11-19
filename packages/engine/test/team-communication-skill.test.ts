import { afterEach, describe, expect, test } from "bun:test";
import { orgTopic } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import {
  createAgent,
  enabledSkills,
  ForbiddenError,
  installTeamCommunicationSkill,
  parseSkillMarkdown,
  RIGHT_HAND,
  setAgentSkills,
  TEAM_COMMUNICATION_SKILL,
  TEAM_COMMUNICATION_SKILL_MD,
  updateSkill,
  validateSkill,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const MODEL = { model: "claude-sonnet-5-5" };
const names = async (agentId: string) => (await enabledSkills(f.db, f.org.id, agentId)).map((s) => s.name);

describe("the team communication skill (ADR 0199)", () => {
  test("its SKILL.md parses, passes the skill limits and covers the six habits", () => {
    const parsed = parseSkillMarkdown(TEAM_COMMUNICATION_SKILL_MD);
    expect(parsed.name).toBe(TEAM_COMMUNICATION_SKILL);
    expect(() => validateSkill(parsed)).not.toThrow();
    // The description is what makes an agent load it: it names the moments it is for.
    for (const moment of ["tell_agent", "ask_agent", "@mention", "status", "blocked", "comes back"])
      expect(parsed.description).toContain(moment);
    for (const heading of [
      "## 1. Hand off: done, left, evidence",
      "## 2. Ask for help when blocked",
      "## 3. Short status updates",
      "## 4. Mention the right teammate",
      "## 5. Say what is not verified",
      "## 6. Close the loop when a hand-off comes back",
    ])
      expect(parsed.body).toContain(heading);
    // Every file is public: no workspace's own people or agents are named in it.
    expect(TEAM_COMMUNICATION_SKILL_MD).not.toMatch(/\b(Max|Ryan|Theodore|Lucas|Felix|Gabriel|Adrian|Ben|Charlie)\b/);
  });

  test("installs once, on for every active agent (the right hand too) and for agents made after", async () => {
    f = await setup({ rightHand: true });
    const told: string[] = [];
    f.pubsub.subscribe(orgTopic(f.org.id), (e) => {
      if (e.type === "org.broadcast") told.push((e.event as { type: string }).type);
    });
    const archived = await createAgent(f.db, f.owner.id, f.org.id, { name: "Old", handle: "old" }, MODEL);
    await f.db.update(schema.agents).set({ archivedAt: new Date() }).where(eq(schema.agents.id, archived.id));
    const [lodi] = await f.db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(and(eq(schema.agents.orgId, f.org.id), eq(schema.agents.builtin, RIGHT_HAND)));
    if (!lodi) throw new Error("the workspace has no right hand");

    const first = await installTeamCommunicationSkill({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id);
    expect(first.installed).toBe(true);
    // An open agent page hears of it and reads its list again.
    expect(told).toEqual(["agents.changed"]);
    expect(first.enabledFor.sort()).toEqual([f.agent.id, lodi.id].sort());
    expect(await names(f.agent.id)).toEqual([TEAM_COMMUNICATION_SKILL]);
    expect(await names(lodi.id)).toEqual([TEAM_COMMUNICATION_SKILL]);
    expect(await names(archived.id)).toEqual([]);

    const [row] = await f.db
      .select()
      .from(schema.skills)
      .where(and(eq(schema.skills.orgId, f.org.id), eq(schema.skills.slug, TEAM_COMMUNICATION_SKILL)));
    expect(row).toMatchObject({ source: "manual", defaultForNewAgents: true, version: 1, createdByUserId: f.owner.id });
    expect(row?.body).toBe(parseSkillMarkdown(TEAM_COMMUNICATION_SKILL_MD).body);

    // An agent made later gets it through "default for new agents".
    const later = await createAgent(f.db, f.owner.id, f.org.id, { name: "Nova", handle: "nova" }, MODEL);
    expect(await names(later.id)).toEqual([TEAM_COMMUNICATION_SKILL]);

    const audit = await f.db
      .select({ action: schema.auditLog.action, details: schema.auditLog.details })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.orgId, f.org.id), eq(schema.auditLog.targetId, first.skillId)));
    expect(audit.map((a) => a.action).sort()).toEqual(["skill.installed", "skill.turned_on"]);
  });

  test("running it again keeps the skill's text, and an agent someone turned it off for stays off", async () => {
    f = await setup();
    const first = await installTeamCommunicationSkill({ db: f.db }, f.owner.id, f.org.id);
    // People (or agents, ADR 0120) improved it; someone turned it off for one agent.
    await updateSkill({ db: f.db, blobs: f.artifactDeps.blobs }, f.owner.id, f.org.id, first.skillId, {
      body: "# Our own way\n\nShorter.",
    });
    await setAgentSkills(f.db, f.owner.id, f.org.id, f.agent.id, [{ skillId: first.skillId, enabled: false }]);
    const other = await createAgent(f.db, f.owner.id, f.org.id, { name: "Bea", handle: "bea" }, MODEL);
    await f.db.delete(schema.agentSkills).where(eq(schema.agentSkills.agentId, other.id));

    const again = await installTeamCommunicationSkill({ db: f.db }, f.owner.id, f.org.id);
    expect(again).toMatchObject({ installed: false, skillId: first.skillId, enabledFor: [other.id] });
    const [row] = await f.db.select().from(schema.skills).where(eq(schema.skills.id, first.skillId));
    expect(row?.body).toBe("# Our own way\n\nShorter.");
    expect(await names(f.agent.id)).toEqual([]);
    expect(await names(other.id)).toEqual([TEAM_COMMUNICATION_SKILL]);
  });

  test("only who manages agents installs it", async () => {
    f = await setup();
    const member = await addMember(f.db, f.org.id, "member");
    await expect(installTeamCommunicationSkill({ db: f.db }, member.id, f.org.id)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(await names(f.agent.id)).toEqual([]);
  });
});
