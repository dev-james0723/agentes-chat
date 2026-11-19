// SF-19 for native skills (AT-52, AT-53): a version an agent made is saved to the skills repository and a person told.
import { afterEach, describe, expect, test } from "bun:test";
import type { FoundryCapabilityExport, FoundryCapabilitySyncPort } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import { createSkillSync, queueSkillSync, SKILL_SYNC_JOB } from "../src/skill-sync";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

function fakeRepo() {
  const held = new Map<string, string>();
  const synced: FoundryCapabilityExport[] = [];
  let failNext = false;
  const port: FoundryCapabilitySyncPort = {
    async sync(e) {
      synced.push(e);
      if (failNext) {
        failNext = false;
        throw new Error("push timed out");
      }
      const commit = `${held.size + 1}`.padStart(40, "a");
      held.set(e.digest, commit);
      return { state: "SYNCED", commit, path: `skills/${e.name}`, url: "https://github.com/example/skills" };
    },
    async lookup(q) {
      const commit = held.get(q.digest);
      return commit ? { commit, path: `skills/${q.name}`, url: "https://github.com/example/skills" } : null;
    },
  };
  return {
    port,
    synced,
    held,
    failOnce() {
      failNext = true;
    },
  };
}

async function world(options: { private?: boolean; notify?: string | null } = {}) {
  f = await setup();
  const [skill] = await f.db
    .insert(schema.skills)
    .values({
      orgId: f.org.id,
      slug: "release-checklist",
      name: "release-checklist",
      description: "Check a release before it ships",
      body: "# Release checklist\n1. Run the tests.",
      source: "manual",
      origin: "agent",
      ownerAgentId: f.agent.id,
    })
    .returning();
  await queueSkillSync(f.db, {
    orgId: f.org.id,
    skillId: skill!.id,
    version: skill!.version,
    agentId: f.agent.id,
    notifyUserId: options.notify === undefined ? f.owner.id : options.notify,
    via: "promotion",
    private: options.private,
  });
  const [row] = await f.db.select().from(schema.skillSyncs);
  return { skill: skill!, syncId: row!.id };
}

const sync = (repo: ReturnType<typeof fakeRepo> | null) =>
  createSkillSync({ db: f.db, blobs: f.artifactDeps.blobs, capabilitySync: repo?.port });
const row = async (id: string) => (await f.db.select().from(schema.skillSyncs).where(eq(schema.skillSyncs.id, id)))[0]!;
const reports = async () =>
  (await f.db.select().from(schema.messages).where(eq(schema.messages.authorAgentId, f.agent.id))).filter(
    (m) => (m.meta as Record<string, unknown>)?.skillSync,
  );

describe("SF-19: native skill versions", () => {
  test("queued once per version, with only its reference in the job", async () => {
    const { skill, syncId } = await world();
    await queueSkillSync(f.db, {
      orgId: f.org.id,
      skillId: skill.id,
      version: skill.version,
      agentId: f.agent.id,
      notifyUserId: f.owner.id,
      via: "promotion",
    });
    const jobs = await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, SKILL_SYNC_JOB));
    expect(jobs.map((j) => j.payload)).toEqual([{ syncId }]);
  });

  test("AT-52: saved as SKILL.md with its marker, and the person told once with the commit", async () => {
    const { syncId } = await world();
    const repo = fakeRepo();
    await sync(repo).run(f.org.id, { syncId }, { finalAttempt: false });
    await sync(repo).run(f.org.id, { syncId }, { finalAttempt: false });
    expect(repo.synced).toHaveLength(1);
    const sent = repo.synced[0]!;
    expect(sent).toMatchObject({ kind: "skill", name: "release-checklist" });
    const skillMd = atob(sent.files.find((x) => x.path === "SKILL.md")!.base64);
    expect(skillMd).toStartWith("---\nname: release-checklist\n");
    expect(skillMd).toContain("1. Run the tests.");
    expect(sent.files.map((x) => x.path)).toContain("FOUNDRY-VERSION.json");
    const r = await row(syncId);
    expect([r.state, r.commit]).toEqual(["SYNCED", repo.held.get(sent.digest)!]);
    const [report, ...more] = await reports();
    expect(more).toEqual([]);
    expect(report!.body).toContain("Skill created: release-checklist (version 1)");
    expect(report!.body).toContain("https://github.com/example/skills/tree/main/skills/release-checklist");
    const members = await f.db
      .select()
      .from(schema.channelMembers)
      .where(eq(schema.channelMembers.channelId, report!.channelId));
    expect(members.map((m) => m.userId).filter(Boolean)).toEqual([f.owner.id]);
  });

  test("AT-53: a private publication is never copied out; the person hears it stayed in the workspace", async () => {
    const { syncId } = await world({ private: true });
    const repo = fakeRepo();
    await sync(repo).run(f.org.id, { syncId }, { finalAttempt: false });
    expect(repo.synced).toEqual([]);
    expect((await row(syncId)).state).toBe("PRIVATE");
    const [report] = await reports();
    expect(report!.body).toContain("stays in this workspace's skill library only");
  });

  test("a newer version first: the older one is closed, never saved or reported", async () => {
    const { skill, syncId } = await world();
    await f.db.update(schema.skills).set({ version: 2 }).where(eq(schema.skills.id, skill.id));
    const repo = fakeRepo();
    await sync(repo).run(f.org.id, { syncId }, { finalAttempt: false });
    expect(repo.synced).toEqual([]);
    expect((await row(syncId)).state).toBe("SUPERSEDED");
    expect(await reports()).toEqual([]);
  });

  test("an unknown push is looked up before trying again, never pushed twice", async () => {
    const { syncId } = await world();
    const repo = fakeRepo();
    repo.failOnce();
    await expect(sync(repo).run(f.org.id, { syncId }, { finalAttempt: false })).rejects.toThrow();
    expect((await row(syncId)).state).toBe("UNKNOWN");
    await sync(repo).run(f.org.id, { syncId }, { finalAttempt: false });
    expect((await row(syncId)).state).toBe("SYNCED");
    expect(await reports()).toHaveLength(1);
  });

  test("no repository connected, and nobody named: reported to the agent's owner as not saved", async () => {
    const { syncId } = await world({ notify: null });
    await f.db.update(schema.agents).set({ ownerUserId: f.owner.id }).where(eq(schema.agents.id, f.agent.id));
    await sync(null).run(f.org.id, { syncId }, { finalAttempt: false });
    expect((await row(syncId)).state).toBe("FAILED");
    const [report] = await reports();
    expect(report!.body).toContain("No skills repository is connected");
  });
});
