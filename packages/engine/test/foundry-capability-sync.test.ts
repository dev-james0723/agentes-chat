// SF-19: an ACTIVE capability is saved to the skills repository and James is told, by its creating agent.
import { afterEach, describe, expect, test } from "bun:test";
import type {
  FoundryCapabilityExport,
  FoundryCapabilitySyncPort,
  FoundryCapabilitySyncResult,
} from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import { createFoundryCapabilitySync, FOUNDRY_SYNC_JOB } from "../src/foundry/sync";
import { type Fixture, setup } from "./fixtures";
import { createLifecycleWorld, type LifecycleWorld } from "./foundry-lifecycle.fixture";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

/** A fake repository: what it holds, what the next sync answers, and every call. */
function fakeRepo() {
  const held = new Map<string, { commit: string; path: string }>();
  const calls: { sync: FoundryCapabilityExport[]; lookup: string[] } = { sync: [], lookup: [] };
  let next: "ok" | "refuse" | "unknown-but-pushed" | "unknown-not-pushed" = "ok";
  const port: FoundryCapabilitySyncPort = {
    async sync(e): Promise<FoundryCapabilitySyncResult> {
      calls.sync.push(e);
      const path = `${e.kind === "skill" ? "skills" : "tools"}/${e.name}`;
      if (next === "refuse") return { state: "REFUSED", reason: "something that looks like a secret in: ./tool.mjs" };
      if (next === "unknown-not-pushed") throw new Error("push timed out");
      const commit = `c${held.size + 1}`.padEnd(40, "0");
      held.set(e.digest, { commit, path });
      if (next === "unknown-but-pushed") throw new Error("push timed out");
      return { state: "SYNCED", commit, path, url: "https://github.com/example/skills" };
    },
    async lookup(q) {
      calls.lookup.push(q.digest);
      const h = held.get(q.digest);
      return h ? { ...h, url: "https://github.com/example/skills" } : null;
    },
  };
  return {
    port,
    calls,
    held,
    set(mode: typeof next) {
      next = mode;
    },
  };
}

async function activeWorld(): Promise<{ w: LifecycleWorld; bindingId: string; versionId: string }> {
  f = await setup();
  const w = await createLifecycleWorld(f);
  const staged = await w.stage();
  const activated = await w.activate(staged);
  expect(await w.lifecycle.runCanary({ ...w.ctx, toolUseId: "canary-sync" }, activated.binding.id)).toMatchObject({
    outcome: "PASS",
  });
  const [version] = await f.db
    .select()
    .from(schema.foundryVersions)
    .where(and(eq(schema.foundryVersions.orgId, f.org.id), eq(schema.foundryVersions.digest, staged.digest)));
  return { w, bindingId: activated.binding.id, versionId: version!.id };
}

const syncJobs = async () =>
  (await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, FOUNDRY_SYNC_JOB))).map((j) => j.payload);

const version = async (id: string) =>
  (await f.db.select().from(schema.foundryVersions).where(eq(schema.foundryVersions.id, id)))[0]!;

/** Messages the creating agent posted to the approver's DM. */
async function reports() {
  return (await f.db.select().from(schema.messages).where(eq(schema.messages.authorAgentId, f.agent.id))).filter(
    (m) => (m.meta as Record<string, unknown>)?.foundrySync,
  );
}

function syncer(repo: ReturnType<typeof fakeRepo> | null) {
  return createFoundryCapabilitySync({
    db: f.db,
    blobs: f.artifactDeps.blobs,
    capabilitySync: repo?.port,
  });
}

describe("SF-19: saved to the skills repository and reported to James", () => {
  test("AT-46: becoming ACTIVE queues exactly one sync, and the sync records the commit", async () => {
    const { versionId } = await activeWorld();
    expect(await syncJobs()).toEqual([{ versionId }]);
    expect((await version(versionId)).syncState).toBe("PENDING");

    const repo = fakeRepo();
    await syncer(repo).run(f.org.id, { versionId }, { finalAttempt: false });
    const v = await version(versionId);
    expect(v.syncState).toBe("SYNCED");
    expect(v.syncCommit).toBe(repo.held.get(v.digest)!.commit);
    expect(repo.calls.sync).toHaveLength(1);
    const sent = repo.calls.sync[0]!;
    expect(sent).toMatchObject({ kind: "tool", digest: v.digest, name: expect.any(String) });
    const paths = sent.files.map((file) => file.path).sort();
    expect(paths).toContain("FOUNDRY-VERSION.json");
    expect(paths).toContain("manifest.json");
    expect(JSON.parse(atob(sent.files.find((file) => file.path === "FOUNDRY-VERSION.json")!.base64)).digest).toBe(
      v.digest,
    );
  });

  test("AT-47: James hears it once, from the creating agent, only after the commit exists", async () => {
    const { versionId } = await activeWorld();
    expect(await reports()).toEqual([]);
    const repo = fakeRepo();
    await syncer(repo).run(f.org.id, { versionId }, { finalAttempt: false });
    const [report, ...more] = await reports();
    expect(more).toEqual([]);
    expect(report!.authorType).toBe("agent");
    const commit = (await version(versionId)).syncCommit!;
    expect(report!.body).toContain(commit.slice(0, 12));
    expect(report!.body).toContain("Made by:");
    expect(report!.body).toContain("Why:");
    expect(report!.body).toContain("How it will be used from now on:");
    expect(report!.body).toContain("https://github.com/example/skills/tree/main/tools/");
    const [dm] = await f.db.select().from(schema.channels).where(eq(schema.channels.id, report!.channelId));
    expect(dm!.kind).toBe("dm");
    const members = await f.db
      .select()
      .from(schema.channelMembers)
      .where(eq(schema.channelMembers.channelId, report!.channelId));
    expect(members.map((m) => m.userId).filter(Boolean)).toEqual([f.owner.id]);
    expect((await version(versionId)).syncReportedAt).not.toBeNull();
  });

  test("AT-48: nothing is queued or reported before ACTIVE, nor after a failed canary", async () => {
    f = await setup();
    const w = await createLifecycleWorld(f);
    const staged = await w.stage();
    const activated = await w.activate(staged);
    expect(await syncJobs()).toEqual([]);
    w.state.mode = "wrong-output";
    expect(await w.lifecycle.runCanary({ ...w.ctx, toolUseId: "canary-bad" }, activated.binding.id)).toMatchObject({
      outcome: "FAIL",
    });
    expect(await syncJobs()).toEqual([]);
    expect(await reports()).toEqual([]);
  });

  test("AT-49: a job run twice makes one commit and one report", async () => {
    const { versionId } = await activeWorld();
    const repo = fakeRepo();
    await syncer(repo).run(f.org.id, { versionId }, { finalAttempt: false });
    await syncer(repo).run(f.org.id, { versionId }, { finalAttempt: false });
    expect(repo.calls.sync).toHaveLength(1);
    expect(await reports()).toHaveLength(1);
  });

  test("AT-49: a push that timed out after the remote took it is found, not pushed again", async () => {
    const { versionId } = await activeWorld();
    const repo = fakeRepo();
    repo.set("unknown-but-pushed");
    await expect(syncer(repo).run(f.org.id, { versionId }, { finalAttempt: false })).rejects.toThrow();
    expect((await version(versionId)).syncState).toBe("UNKNOWN");
    expect(await reports()).toEqual([]);
    repo.set("ok");
    await syncer(repo).run(f.org.id, { versionId }, { finalAttempt: false });
    expect(repo.calls.sync).toHaveLength(1);
    expect(repo.calls.lookup.length).toBeGreaterThanOrEqual(2);
    expect((await version(versionId)).syncState).toBe("SYNCED");
    expect(await reports()).toHaveLength(1);
  });

  test("AT-49: an unknown push on the last attempt is reported as failed, the tool still active", async () => {
    const { versionId, bindingId } = await activeWorld();
    const repo = fakeRepo();
    repo.set("unknown-not-pushed");
    await syncer(repo).run(f.org.id, { versionId }, { finalAttempt: true });
    expect((await version(versionId)).syncState).toBe("FAILED");
    const [report] = await reports();
    expect(report!.body).toContain("Could not save it to the skills repository");
    const [binding] = await f.db.select().from(schema.foundryBindings).where(eq(schema.foundryBindings.id, bindingId));
    expect(binding!.state).toBe("ACTIVE");
  });

  test("AT-50: refused content is not pushed, the report says why, the tool stays ACTIVE", async () => {
    const { versionId, bindingId } = await activeWorld();
    const repo = fakeRepo();
    repo.set("refuse");
    await syncer(repo).run(f.org.id, { versionId }, { finalAttempt: false });
    const v = await version(versionId);
    expect(v.syncState).toBe("REFUSED");
    expect(v.syncCommit).toBeNull();
    expect(repo.held.size).toBe(0);
    const [report] = await reports();
    expect(report!.body).toContain("Not saved to the skills repository");
    expect(report!.body).toContain("looks like a secret");
    const [binding] = await f.db.select().from(schema.foundryBindings).where(eq(schema.foundryBindings.id, bindingId));
    expect(binding!.state).toBe("ACTIVE");
  });

  test("no repository connected: reported as not saved, never silently dropped", async () => {
    const { versionId } = await activeWorld();
    await syncer(null).run(f.org.id, { versionId }, { finalAttempt: false });
    expect((await version(versionId)).syncState).toBe("FAILED");
    const [report] = await reports();
    expect(report!.body).toContain("No skills repository is connected");
  });

  test("files that can't be read: retried, then on the last attempt reported as not saved", async () => {
    const { versionId } = await activeWorld();
    const repo = fakeRepo();
    const unreadable = createFoundryCapabilitySync({
      db: f.db,
      blobs: { forConfig: async () => ({ get: async () => null }) } as unknown as typeof f.artifactDeps.blobs,
      capabilitySync: repo.port,
    });
    await expect(unreadable.run(f.org.id, { versionId }, { finalAttempt: false })).rejects.toThrow();
    expect(await reports()).toEqual([]);
    await unreadable.run(f.org.id, { versionId }, { finalAttempt: true });
    expect((await version(versionId)).syncState).toBe("FAILED");
    expect(repo.calls.sync).toEqual([]);
    const [report] = await reports();
    expect(report!.body).toContain("its stored files could not be read");
  });

  test("AT-51: the queued job and the report carry no credential, only the version reference", async () => {
    const { versionId } = await activeWorld();
    const [job] = await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, FOUNDRY_SYNC_JOB));
    expect(Object.keys(job!.payload)).toEqual(["versionId"]);
    const repo = fakeRepo();
    await syncer(repo).run(f.org.id, { versionId }, { finalAttempt: false });
    const [report] = await reports();
    expect(report!.body).not.toMatch(/token|ghp_|gho_|github_pat_|Authorization/i);
  });
});
