import { and, type Database, eq, schema, sql } from "@agenteschat/db";
import {
  decideApproval,
  drainOutbox,
  getApproval,
  grantScopes,
  openPersonAgentDm,
  postPersonMessage,
  saveSkill,
  setAgentSkills,
} from "../src";
import { sha256 } from "../src/crypto";
import type { ToolContext } from "../src/tools/types";
import { setup } from "./fixtures";

/**
 * On a real server (`TEST_DATABASE_URL`) SQL-stamped jobs carry the server clock while a claim compares them with
 * this process's clock; a few ms of skew made one immediate drain claim nothing. A fresh small lead per batch keeps
 * jobs the run itself enqueues mid-drain claimable; delayed jobs (seconds out) still wait.
 */
async function drainNow(f: Awaited<ReturnType<typeof setup>>) {
  for (let i = 0; i < 100; i++)
    if ((await drainOutbox(f.db, f.handlers, { now: new Date(Date.now() + 250), maxBatches: 1 })) === 0) return;
}

/** Real native executor -> private preview -> exact owner decision -> transactional native publication. Fake inference only. */
export async function nativePublishedReadFixture(
  options: { publicationResult?: Record<string, unknown>; publicationExpected?: boolean } = {},
) {
  const name = "b2-native-publication-fixture";
  const body = "SYNTHETIC_PRIVATE_B2_APPROVED_BODY";
  const f = await setup({
    skillTools: true,
    contextTools: true,
    reply: (_req, n) =>
      n === 1
        ? { chunks: [], toolUses: [{ name: "load_skill", input: { name } }] }
        : n === 2
          ? { chunks: [], toolUses: [{ name: "update_skill", input: { name, body } }] }
          : { chunks: ["Finished the requested phase."] },
  });
  try {
    await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: null, scope: "skills:read" }]);
    const skill = await saveSkill({ db: f.db, blobs: f.artifactDeps.blobs }, f.owner.id, f.org.id, {
      name,
      body: "Original public method",
      description: "Synthetic method",
      source: "manual",
      metadata: {},
    });
    await setAgentSkills(f.db, f.owner.id, f.org.id, f.agent.id, [{ skillId: skill.id, enabled: true }]);
    const dm = await openPersonAgentDm(f.db, f.org.id, f.owner.id, f.agent.id);
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, dm.id, {
      body: "@dev improve privately. Do not publish without my separate sharing decision.",
    });
    await drainNow(f);
    const [approval] = await f.db.select().from(schema.approvals);
    if (!approval) throw new Error("Native private approval was not issued");
    if (options.publicationResult !== undefined)
      await f.db
        .update(schema.approvals)
        .set({ result: options.publicationResult })
        .where(eq(schema.approvals.id, approval.id));
    const preview = await getApproval(f.db, f.owner.id, f.org.id, approval.id);
    await decideApproval({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, approval.id, {
      decision: "approve",
      publicationFingerprint: preview.publication!.fingerprint,
    });
    await drainNow(f);
    const [published] = await f.db.select().from(schema.skills).where(eq(schema.skills.id, skill.id));
    const [executed] = await f.db.select().from(schema.approvals).where(eq(schema.approvals.id, approval.id));
    if (!published || !executed) throw new Error("Native publication rows disappeared");
    if (options.publicationExpected !== false && (published.version !== 2 || !executed.executedAt))
      throw new Error("Native publication did not complete");
    if (options.publicationExpected === false && (published.version !== 1 || executed.executedAt !== null))
      throw new Error("Unsafe native publication did not roll back");
    // Genuine person-created request and server run row; no untrusted profile or routine-owner substitution.
    const message = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev read the now owner-approved shared method",
    });
    const [reader] = await f.db
      .update(schema.agentRuns)
      .set({ status: "running" })
      .where(and(eq(schema.agentRuns.triggerMessageId, message.id), eq(schema.agentRuns.agentId, f.agent.id)))
      .returning();
    if (!reader) throw new Error("No native reader run");
    const ctx: ToolContext = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: reader.id,
      channelId: f.general.id,
      threadRootId: reader.threadRootId,
      triggerMessageId: reader.triggerMessageId,
      toolUseId: "native-b2-read",
    };
    const selected = {
      orgId: f.org.id,
      skillId: skill.id,
      version: published.version,
      operation: "load_skill" as const,
      path: null,
      rawSelectedBytesHash: sha256(published.body),
    };
    return { f, ctx, selected, published, approval: executed, body, name, dm, reader };
  } catch (error) {
    await f.close();
    throw error;
  }
}

/** TEST ONLY: isolated PGlite DDL. Never called by native runtime; schema owner holds MIG0269. */
export async function installNativeSkillReadTestSchema(db: Database) {
  const { NATIVE_SKILL_READ_ACTIVATIONS_DRAFT_SQL } = await import("../src/contextual-skill-native-read-store");
  await db.execute(sql.raw(NATIVE_SKILL_READ_ACTIVATIONS_DRAFT_SQL));
}
