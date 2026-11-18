/**
 * Real-environment memory check: `bun apps/server/scripts/memory-live-check.ts` (reads the process env, as the
 * server does). Never part of `bun test`, and no model call: a throwaway user, org, agent and channels on the real
 * database, the native memory reads a run makes, then the throwaway org and users deleted.
 *
 * Checks: a remembered decision reaches a run with its source; a private channel's memory stays out of a public
 * one; a correction replaces the old item for today and keeps it for an earlier known-time view; a person's own
 * preference reaches their run and not someone else's; one producer event applies once.
 */
import { createMemoryPubSub, createPostgresSearchResolver } from "@agenteschat/adapters";
import { loadConfig } from "@agenteschat/config";
import { createDatabase, eq, inArray, schema } from "@agenteschat/db";
import {
  addChannelMember,
  consolidateItem,
  createAgent,
  createChannel,
  createOrganization,
  insertContextItem,
  memoryViewAt,
  openDm,
  postPersonMessage,
  retrieveForRun,
} from "@agenteschat/engine";
import { supersede } from "../../../packages/engine/src/context/items";

const config = loadConfig();
const database = createDatabase({ url: config.DATABASE_URL, poolMax: 4 });
const db = database.db;
const pubsub = createMemoryPubSub();
const tag = crypto.randomUUID().slice(0, 8);
const ownerId = `memcheck_${tag}_a`;
const otherId = `memcheck_${tag}_b`;
let orgId: string | undefined;
const results: { check: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  results.push({ check: name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

try {
  await db.insert(schema.users).values([
    { id: ownerId, name: "Memcheck Owner", email: `${ownerId}@memcheck.invalid` },
    { id: otherId, name: "Memcheck Other", email: `${otherId}@memcheck.invalid` },
  ]);
  const { organization, general } = await createOrganization(db, ownerId, {
    name: `memcheck ${new Date().toISOString()}`,
    context: "Automated memory check of agentes.chat.",
  });
  orgId = organization.id;
  await db.insert(schema.organizationMembers).values({ orgId, userId: otherId, role: "member" });
  await addChannelMember(db, ownerId, orgId, general.id, { userId: otherId });
  const agent = await createAgent(
    db,
    ownerId,
    orgId,
    { name: "Memcheck", handle: "memcheck", instructions: "Reply briefly.", model: "claude-haiku-5-5" },
    { model: "claude-haiku-5-5" },
  );
  await addChannelMember(db, ownerId, orgId, general.id, { agentId: agent.id });
  const secret = await createChannel(db, ownerId, orgId, { name: `memcheck-secret-${tag}`, visibility: "private" });
  await addChannelMember(db, ownerId, orgId, secret.id, { agentId: agent.id });
  const context = {
    db,
    search: createPostgresSearchResolver(db),
    // No model call: the query embedding fails, so search uses the words, as when a provider fails or is slow.
    gateway: { embed: () => Promise.reject(new Error("no model in this check")) } as never,
    summaryModel: "unused",
  };
  const read = (channelId: string, text: string, personIds = [ownerId]) =>
    retrieveForRun(context, { orgId: orgId as string, agentId: agent.id, channelId, text, personIds });
  const human = () => [{ type: "human" as const, ref: ownerId, at: new Date().toISOString() }];
  // A new item is indexed by the server's worker (`search.index`), as for any run: wait for it, at most 60 s.
  const indexed = async (...ids: string[]) => {
    for (let i = 0; i < 120; i++) {
      const rows = await db
        .select({ id: schema.searchDocuments.sourceId })
        .from(schema.searchDocuments)
        .where(inArray(schema.searchDocuments.sourceId, ids));
      if (rows.length >= ids.length) return;
      await Bun.sleep(500);
    }
    throw new Error(`not indexed within 60 s: ${ids.join(", ")}`);
  };

  // 1. A decision said in #general reaches a run there, with its source.
  const said = await postPersonMessage({ db, pubsub }, ownerId, orgId, general.id, {
    body: "Decision: Orion ships from the Frankfurt region.",
  });
  const decision = await insertContextItem(db, {
    orgId,
    kind: "decision",
    scopeType: "agent",
    scopeId: agent.id,
    agentId: agent.id,
    subject: "Orion release region",
    content: "Orion ships from the Frankfurt region.",
    sourceIds: [said.id],
    channelIds: [general.id],
    trust: "high",
    createdByKind: "person",
    createdById: ownerId,
    evidence: human(),
  });
  await indexed(decision.id);
  const inGeneral = await read(general.id, "Which region does Orion ship from?");
  check(
    "decision reaches a run in its channel, with its source",
    inGeneral.itemIds.includes(decision.id) && /Frankfurt/.test(inGeneral.text + (inGeneral.requiredText ?? "")),
    `items=${inGeneral.itemIds.length} pack=${inGeneral.pack?.tokenCount ?? "-"}/${inGeneral.pack?.limit ?? "-"} (${inGeneral.pack?.countKind ?? "-"})`,
  );

  // 2. A private channel's memory stays out of #general, and reaches a run in that channel.
  const secretSaid = await postPersonMessage({ db, pubsub }, ownerId, orgId, secret.id, {
    body: "Orion's acquisition price is 4.2 million.",
  });
  const hidden = await insertContextItem(db, {
    orgId,
    kind: "fact",
    scopeType: "agent",
    scopeId: agent.id,
    agentId: agent.id,
    subject: "Orion acquisition price",
    content: "Orion's acquisition price is 4.2 million.",
    sourceIds: [secretSaid.id],
    channelIds: [secret.id],
    trust: "high",
    createdByKind: "person",
    createdById: ownerId,
    evidence: human(),
  });
  await indexed(hidden.id);
  const publicRead = await read(general.id, "What is Orion's acquisition price?");
  check(
    "private channel memory stays out of a public channel",
    !publicRead.itemIds.includes(hidden.id) && !/4\.2 million/.test(publicRead.text + (publicRead.requiredText ?? "")),
  );
  const privateRead = await read(secret.id, "What is Orion's acquisition price?");
  check("private channel memory reaches a run in that channel", privateRead.itemIds.includes(hidden.id));

  // 3. A correction replaces the decision now; an earlier known-time view still shows what was believed then.
  await Bun.sleep(20);
  const knownBefore = new Date();
  await Bun.sleep(20);
  const corrected = await db.transaction((tx) =>
    supersede(tx, decision, {
      orgId: orgId as string,
      kind: "decision",
      scopeType: "agent",
      scopeId: agent.id,
      agentId: agent.id,
      subject: "Orion release region",
      content: "Orion ships from the Dublin region.",
      sourceIds: [said.id],
      channelIds: [general.id],
      trust: "high",
      createdByKind: "person",
      createdById: ownerId,
      evidence: human(),
    }),
  );
  await indexed(corrected.id);
  const afterFix = await read(general.id, "Which region does Orion ship from?");
  const afterText = afterFix.text + (afterFix.requiredText ?? "");
  check(
    "a correction replaces the old memory in a run",
    afterFix.itemIds.includes(corrected.id) && !afterFix.itemIds.includes(decision.id) && !/Frankfurt/.test(afterText),
  );
  const rows = await db.select().from(schema.contextItems).where(eq(schema.contextItems.orgId, orgId));
  const then = memoryViewAt(rows, { knownAt: knownBefore }).map((r) => r.id);
  const now = memoryViewAt(rows, { knownAt: new Date() }).map((r) => r.id);
  check(
    "earlier known-time view keeps the old decision; today's shows the correction",
    then.includes(decision.id) &&
      !then.includes(corrected.id) &&
      now.includes(corrected.id) &&
      !now.includes(decision.id),
  );

  // 4. A person's own preference, from their own words in their DM, reaches their run and nobody else's.
  const dm = await openDm(db, ownerId, orgId, { agentId: agent.id });
  const pref = await postPersonMessage({ db, pubsub }, ownerId, orgId, dm.id, {
    body: "Keep my October trip between us.",
  });
  const own = await insertContextItem(db, {
    orgId,
    kind: "preference",
    scopeType: "person",
    scopeId: ownerId,
    agentId: agent.id,
    content: "Keep the October trip private; never mention it to the team.",
    sourceIds: [pref.id],
    channelIds: [],
    trust: "high",
    createdByKind: "agent",
    createdById: agent.id,
  });
  const forOwner = await read(general.id, "October trip", [ownerId]);
  const forOther = await read(general.id, "October trip", [otherId]);
  check(
    "a person's own preference reaches their run",
    forOwner.itemIds.includes(own.id) || /October trip/.test(forOwner.requiredText ?? ""),
  );
  check(
    "a person's own preference stays out of someone else's run",
    !forOther.itemIds.includes(own.id) && !/October trip/.test(forOther.text + (forOther.requiredText ?? "")),
  );

  // 5. One producer event applies once on the real database.
  const event = {
    orgId,
    kind: "fact" as const,
    scopeType: "agent" as const,
    scopeId: agent.id,
    agentId: agent.id,
    subject: "Orion owner",
    content: "Orion's owner is Mason.",
    sourceIds: [said.id],
    channelIds: [general.id],
    createdByKind: "person" as const,
    createdById: ownerId,
    evidence: human(),
    eventKey: `memcheck:${tag}:1`,
  };
  const [a, b] = await Promise.all([consolidateItem(db, event), consolidateItem(db, event)]);
  const owners = (await db.select().from(schema.contextItems).where(eq(schema.contextItems.orgId, orgId))).filter(
    (r) => r.content === "Orion's owner is Mason.",
  );
  check(
    "one producer event delivered twice applies once",
    a.item.id === b.item.id && owners.length === 1 && [a, b].filter((r) => r.replayed).length === 1,
  );
} catch (error) {
  check("run", false, error instanceof Error ? (error.stack ?? error.message) : String(error));
} finally {
  try {
    if (orgId) await db.delete(schema.organizations).where(eq(schema.organizations.id, orgId));
    await db.delete(schema.users).where(eq(schema.users.id, ownerId));
    await db.delete(schema.users).where(eq(schema.users.id, otherId));
    console.log("cleanup: throwaway org and users deleted");
  } catch (error) {
    console.error("cleanup failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
  await database.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`memory live check: ${results.length - failed} pass, ${failed} fail`);
if (failed) process.exitCode = 1;
