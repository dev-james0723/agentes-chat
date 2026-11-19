import { and, type Database, eq, inArray, isNull, not, schema } from "@agenteschat/db";
import { agentsDmReads, readerOfRun } from "../agents-dm-reads";
import { agentIdsSeen, isPlaybook } from "../audience";
import { peopleAllIn, readsOrMayJoin } from "../channels";
import { consultationOrigin } from "../consultations";
import { isAgentOnlyDm } from "../dms";
import { can, requirePermission } from "../organizations";
import { privatePublicationSql } from "../private-skill-publication";
import { isRoutineRoomKey } from "../routine-brief";
import { routineReportChannel } from "../search";
import { sharedMemoryVisibleIds } from "../shared-memory-store";
import type { ContextItem } from "./items";

type MemoryReader = {
  orgId: string;
  agentId: string;
  channelId: string;
  runId?: string;
  personIds?: string[];
  /** Set only by the native right-hand private-session check. */
  personReader?: string | null;
};

/**
 * Narrow native read capability to the actual output audience, using fresh channel/membership rows.
 * Public channels have a potential organization-wide audience, even before a second person joins.
 * An internal room without a verified destination never imports another private conversation.
 */
export async function memoryOutputChannels(db: Database, input: MemoryReader, candidates: readonly string[]) {
  const { channels, channelMembers } = schema;
  const ids = [...new Set([input.channelId, ...candidates])];
  const rows = await db
    .select()
    .from(channels)
    .where(
      and(
        eq(channels.orgId, input.orgId),
        inArray(channels.id, ids),
        isNull(channels.deletedAt),
        isNull(channels.archivedAt),
      ),
    );
  const here = rows.find((row) => row.id === input.channelId);
  if (!here) return [];
  const members = await db
    .select({ id: channelMembers.channelId })
    .from(channelMembers)
    .where(
      and(
        eq(channelMembers.orgId, input.orgId),
        eq(channelMembers.agentId, input.agentId),
        inArray(channelMembers.channelId, ids),
      ),
    );
  const memberIds = new Set(members.map((row) => row.id));
  const personReads = input.personReader ? await readsOrMayJoin(db, input.orgId, input.personReader, candidates) : null;
  let destination: typeof here | undefined = here;
  let report: string | null = null;
  if (isRoutineRoomKey(here.dmKey)) {
    report = here.dmKey ? await routineReportChannel(db, input.orgId, input.agentId, here.dmKey) : null;
    destination = report
      ? (
          await db
            .select()
            .from(channels)
            .where(
              and(
                eq(channels.orgId, input.orgId),
                eq(channels.id, report),
                isNull(channels.deletedAt),
                isNull(channels.archivedAt),
              ),
            )
        )[0]
      : undefined;
  } else if (isAgentOnlyDm(here)) {
    const origin = input.runId ? await consultationOrigin(db, input.orgId, input.runId) : null;
    destination = origin
      ? (
          await db
            .select()
            .from(channels)
            .where(
              and(
                eq(channels.orgId, input.orgId),
                eq(channels.id, origin.channelId),
                isNull(channels.deletedAt),
                isNull(channels.archivedAt),
              ),
            )
        )[0]
      : undefined;
  }
  const kept: string[] = [];
  for (const source of rows) {
    if (!candidates.includes(source.id)) continue;
    if (!(personReads?.has(source.id) || memberIds.has(source.id) || (source.id === report && memberIds.has(here.id))))
      continue;
    if (source.kind === "channel" && source.visibility === "public") {
      kept.push(source.id);
      continue;
    }
    if (source.id === destination?.id || (!destination && source.id === here.id)) {
      kept.push(source.id);
      continue;
    }
    if (
      !destination ||
      (destination.kind === "channel" && destination.visibility === "public") ||
      isAgentOnlyDm(destination) ||
      isRoutineRoomKey(destination.dmKey)
    )
      continue;
    if (await peopleAllIn(db, input.orgId, destination.id, source.id)) kept.push(source.id);
  }
  return kept;
}

/**
 * Recheck native source IDs rather than trusting an item's copied channelIds. This is a bounded read guard,
 * not another store or ingestion path. Legacy source-less items retain their existing behavior; this guard
 * does not certify their claims. Missing/withdrawn sources and cycles fail closed.
 */
export async function memorySourceVisibility(
  db: Database,
  input: MemoryReader,
  allowed: readonly string[],
  items: readonly ContextItem[],
): Promise<Set<string>> {
  const managed = await sharedMemoryVisibleIds(
    db,
    input.orgId,
    items.map((i) => i.id),
    input.personIds?.[0],
    { agent: true },
  );
  return sourceVisibility(
    db,
    input,
    allowed,
    items.filter((i) => managed.has(i.id)),
    (item) =>
      item.orgId === input.orgId &&
      item.channelIds.every((id) => allowed.includes(id)) &&
      (!item.agentId || item.agentId === input.agentId) &&
      Boolean(item.scopeType !== "person" || input.personIds?.includes(item.scopeId ?? "")),
  );
}

/**
 * A person's own "everywhere" preference (ADR 0120): kept for them under no channel, high trust, every source a live
 * message that same person wrote. It follows the runs they are behind wherever those runs answer: the output-audience
 * source check would otherwise hide "keep the October trip from the team" from the very public-channel run that must
 * obey it. Someone else's runs never get it (`people` is whom the run acts for), nor does anything an agent or a
 * page wrote, nor an item whose source was deleted.
 */
export async function personsOwnWords(
  db: Database,
  orgId: string,
  people: readonly string[],
  items: readonly ContextItem[],
): Promise<Set<string>> {
  const own = items.filter(
    (i) =>
      i.orgId === orgId &&
      i.scopeType === "person" &&
      i.scopeId !== null &&
      people.includes(i.scopeId) &&
      i.channelIds.length === 0 &&
      i.trust === "high" &&
      i.status === "active" &&
      !i.supersededBy &&
      i.sourceIds.length > 0,
  );
  if (!own.length) return new Set();
  const managed = await sharedMemoryVisibleIds(
    db,
    orgId,
    own.map((i) => i.id),
    people[0],
    { agent: true },
  );
  const { messages } = schema;
  const rows = await db
    .select({
      id: messages.id,
      authorType: messages.authorType,
      authorUserId: messages.authorUserId,
      deletedAt: messages.deletedAt,
    })
    .from(messages)
    .where(and(eq(messages.orgId, orgId), inArray(messages.id, [...new Set(own.flatMap((i) => i.sourceIds))])));
  const byId = new Map(rows.map((row) => [row.id, row]));
  return new Set(
    own
      .filter(
        (i) =>
          managed.has(i.id) &&
          i.sourceIds.every((id) => {
            const m = byId.get(id);
            return Boolean(m && !m.deletedAt && m.authorType === "person" && m.authorUserId === i.scopeId);
          }),
      )
      .map((i) => i.id),
  );
}

/** Human inspector/search uses the same source closure, but native human/agent-detail permissions. */
export async function memorySourceVisibilityForUser(
  db: Database,
  orgId: string,
  userId: string,
  visible: readonly string[],
  items: readonly ContextItem[],
): Promise<Set<string>> {
  const managed = await sharedMemoryVisibleIds(
    db,
    orgId,
    items.map((i) => i.id),
    userId,
  );
  return memorySourceProvenanceForUser(
    db,
    orgId,
    userId,
    visible,
    items.filter((i) => managed.has(i.id)),
  );
}

/** Source-closure proof only, never permission to return these root bodies. Nested native sources retain their guards. */
export async function memorySourceProvenanceForUser(
  db: Database,
  orgId: string,
  userId: string,
  visible: readonly string[],
  items: readonly ContextItem[],
): Promise<Set<string>> {
  const membership = await requirePermission(db, userId, orgId, "read");
  const [seen, reach] = await Promise.all([
    agentIdsSeen(db, userId, orgId),
    readsOrMayJoin(db, orgId, userId, [...visible]),
  ]);
  const channels = reach.size
    ? await db
        .select({ id: schema.channels.id })
        .from(schema.channels)
        .where(
          and(
            eq(schema.channels.orgId, orgId),
            inArray(schema.channels.id, [...reach]),
            isNull(schema.channels.archivedAt),
            isNull(schema.channels.deletedAt),
          ),
        )
    : [];
  const allowed = channels.map((row) => row.id);
  const reviews = can(membership, "review_memory");
  const scopeAllows = (item: ContextItem) =>
    item.orgId === orgId &&
    item.channelIds.every((id) => allowed.includes(id)) &&
    (!item.agentId || seen.details.has(item.agentId)) &&
    (!isPlaybook(item) || seen.playbook.has(item.agentId ?? "")) &&
    (item.scopeType !== "person" || item.scopeId === userId || reviews);
  const input = { orgId, agentId: "", channelId: "", personIds: [userId] };
  const kept = new Set<string>();
  const check = async (batch: readonly ContextItem[]): Promise<void> => {
    const budget = { exceeded: false };
    const result = await sourceVisibility(db, input, allowed, batch, scopeAllows, budget);
    if (budget.exceeded && batch.length > 1) {
      const mid = Math.floor(batch.length / 2);
      await check(batch.slice(0, mid));
      await check(batch.slice(mid));
    } else for (const id of result) kept.add(id);
  };
  for (let i = 0; i < items.length; i += 16) await check(items.slice(i, i + 16));
  return kept;
}

async function sourceVisibility(
  db: Database,
  input: MemoryReader,
  allowed: readonly string[],
  items: readonly ContextItem[],
  scopeAllows: (item: ContextItem) => boolean,
  budget?: { exceeded: boolean },
): Promise<Set<string>> {
  const { messages, outcomes, contextItems, agentRuns, approvals } = schema;
  const sourceMessages = new Map<string, typeof messages.$inferSelect>();
  const sourceOutcomes = new Map<string, typeof outcomes.$inferSelect>();
  const sourceItems = new Map<string, ContextItem>();
  const sourceRuns = new Map<string, Pick<typeof agentRuns.$inferSelect, "id" | "channelId" | "triggerMessageId">>();
  const sourceApprovals = new Map<
    string,
    Pick<typeof approvals.$inferSelect, "id" | "channelId" | "runId" | "threadRootId">
  >();
  const loaded = new Set<string>();
  let pending = [...new Set(items.flatMap((item) => item.sourceIds))];
  for (let depth = 0; pending.length && depth < 8; depth++) {
    const ids = pending.filter((id) => !loaded.has(id));
    if (loaded.size + ids.length > 256) {
      if (budget) budget.exceeded = true;
      return new Set();
    }
    if (!ids.length) {
      pending = [];
      break;
    }
    for (const id of ids) loaded.add(id);
    const [ms, os, cs, rs, aps] = await Promise.all([
      db
        .select()
        .from(messages)
        .where(and(eq(messages.orgId, input.orgId), inArray(messages.id, ids))),
      db
        .select()
        .from(outcomes)
        .where(and(eq(outcomes.orgId, input.orgId), inArray(outcomes.id, ids))),
      db
        .select()
        .from(contextItems)
        .where(and(eq(contextItems.orgId, input.orgId), inArray(contextItems.id, ids))),
      db
        .select({ id: agentRuns.id, channelId: agentRuns.channelId, triggerMessageId: agentRuns.triggerMessageId })
        .from(agentRuns)
        .where(and(eq(agentRuns.orgId, input.orgId), inArray(agentRuns.id, ids))),
      db
        .select({
          id: approvals.id,
          channelId: approvals.channelId,
          runId: approvals.runId,
          threadRootId: approvals.threadRootId,
        })
        .from(approvals)
        .where(and(eq(approvals.orgId, input.orgId), inArray(approvals.id, ids), not(privatePublicationSql()))),
    ]);
    for (const row of ms) sourceMessages.set(row.id, row);
    for (const row of os) sourceOutcomes.set(row.id, row);
    const managed = await sharedMemoryVisibleIds(
      db,
      input.orgId,
      cs.map((row) => row.id),
      input.personIds?.[0],
      { agent: Boolean(input.agentId), provenanceOnly: true },
    );
    for (const row of cs) if (managed.has(row.id)) sourceItems.set(row.id, row);
    for (const row of rs) sourceRuns.set(row.id, row);
    for (const row of aps) sourceApprovals.set(row.id, row);
    pending = [
      ...new Set([
        ...cs.flatMap((row) => row.sourceIds),
        ...rs.map((row) => row.triggerMessageId),
        ...aps.map((row) => row.threadRootId),
        ...os.flatMap((row) =>
          [row.threadRootId, !row.channelId && !row.threadRootId ? row.runId : null].filter((id): id is string =>
            Boolean(id),
          ),
        ),
      ]),
    ].filter((id) => !loaded.has(id));
  }
  if (pending.length) {
    if (budget) budget.exceeded = true;
    return new Set();
  }
  const dmReaders = new Map<string, ReturnType<typeof agentsDmReads>>();
  const dmFor = (channelId: string) => {
    let reader = dmReaders.get(channelId);
    if (!reader) {
      reader = agentsDmReads(db, input.orgId, channelId, () =>
        input.runId ? readerOfRun(db, input.orgId, input.runId) : Promise.resolve(input.personIds?.[0] ?? null),
      );
      dmReaders.set(channelId, reader);
    }
    return reader;
  };
  const readableSource = new Map<string, boolean>();
  for (const message of sourceMessages.values()) {
    const dm = allowed.includes(message.channelId) ? await dmFor(message.channelId) : null;
    readableSource.set(
      message.id,
      !message.deletedAt && allowed.includes(message.channelId) && (!dm || (await dm.ofMessages([message.id]))),
    );
  }
  for (const run of sourceRuns.values()) {
    const trigger = sourceMessages.get(run.triggerMessageId);
    const dm = allowed.includes(run.channelId) ? await dmFor(run.channelId) : null;
    readableSource.set(
      run.id,
      Boolean(
        trigger &&
          trigger.channelId === run.channelId &&
          readableSource.get(trigger.id) &&
          allowed.includes(run.channelId) &&
          (!dm || (await dm.ofRun(run.id))),
      ),
    );
  }
  for (const approval of sourceApprovals.values()) {
    const root = sourceMessages.get(approval.threadRootId);
    const dm = allowed.includes(approval.channelId) ? await dmFor(approval.channelId) : null;
    readableSource.set(
      approval.id,
      Boolean(
        root &&
          root.channelId === approval.channelId &&
          readableSource.get(root.id) &&
          allowed.includes(approval.channelId) &&
          (!dm || (approval.runId ? await dm.ofRun(approval.runId) : await dm.ofMessages([root.id]))),
      ),
    );
  }
  for (const outcome of sourceOutcomes.values()) {
    const root = outcome.threadRootId ? sourceMessages.get(outcome.threadRootId) : undefined;
    const run = outcome.runId ? sourceRuns.get(outcome.runId) : undefined;
    // Older native webhook outcomes may name their thread instead of duplicating its channel.
    // Resolve that live anchor, never the derived item's broad label.
    const channelId = outcome.channelId ?? root?.channelId ?? run?.channelId;
    const anchor = outcome.threadRootId
      ? Boolean(root && readableSource.get(root.id) && root.channelId === channelId)
      : outcome.channelId
        ? true
        : Boolean(run && readableSource.get(run.id));
    const dm = channelId && allowed.includes(channelId) ? await dmFor(channelId) : null;
    readableSource.set(
      outcome.id,
      Boolean(
        channelId &&
          allowed.includes(channelId) &&
          anchor &&
          (!dm || (outcome.runId ? await dm.ofRun(outcome.runId) : root ? await dm.ofMessages([root.id]) : false)),
      ),
    );
  }
  const evaluated = new Map<string, boolean>();
  let edges = 0;
  const visit = (id: string, path: ReadonlySet<string>): boolean => {
    if (++edges > 2048) {
      if (budget) budget.exceeded = true;
      return false;
    }
    if (path.has(id)) return false;
    if (readableSource.has(id)) return readableSource.get(id) === true;
    if (evaluated.has(id)) return evaluated.get(id) === true;
    const item = sourceItems.get(id);
    if (item?.status !== "active" || item.supersededBy || !scopeAllows(item)) return false;
    const next = new Set([...path, id]);
    const visible = item.sourceIds.every((source) => visit(source, next));
    evaluated.set(id, visible);
    return visible;
  };
  return new Set(
    items
      .filter((item) => scopeAllows(item) && item.sourceIds.every((source) => visit(source, new Set([item.id]))))
      .map((item) => item.id),
  );
}
