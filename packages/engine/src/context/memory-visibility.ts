import { and, type Database, eq, inArray, isNull, schema } from "@agenteschat/db";
import { agentsDmReads, readerOfRun } from "../agents-dm-reads";
import { peopleAllIn, readsOrMayJoin } from "../channels";
import { consultationOrigin } from "../consultations";
import { isAgentOnlyDm } from "../dms";
import { isRoutineRoomKey } from "../routine-brief";
import { routineReportChannel } from "../search";
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
  const { messages, outcomes, contextItems } = schema;
  const sourceMessages = new Map<string, typeof messages.$inferSelect>();
  const sourceOutcomes = new Map<string, typeof outcomes.$inferSelect>();
  const sourceItems = new Map<string, ContextItem>();
  const loaded = new Set<string>();
  let pending = [...new Set(items.flatMap((item) => item.sourceIds))];
  for (let depth = 0; pending.length && depth < 8; depth++) {
    const ids = pending.filter((id) => !loaded.has(id));
    if (loaded.size + ids.length > 256) return new Set();
    if (!ids.length) {
      pending = [];
      break;
    }
    for (const id of ids) loaded.add(id);
    const [ms, os, cs] = await Promise.all([
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
    ]);
    for (const row of ms) sourceMessages.set(row.id, row);
    for (const row of os) sourceOutcomes.set(row.id, row);
    for (const row of cs) sourceItems.set(row.id, row);
    pending = [...new Set(cs.flatMap((row) => row.sourceIds))].filter((id) => !loaded.has(id));
  }
  if (pending.length) return new Set();
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
  for (const outcome of sourceOutcomes.values()) {
    const dm = outcome.channelId && allowed.includes(outcome.channelId) ? await dmFor(outcome.channelId) : null;
    readableSource.set(
      outcome.id,
      Boolean(
        outcome.channelId &&
          allowed.includes(outcome.channelId) &&
          (!dm || (outcome.runId && (await dm.ofRun(outcome.runId)))),
      ),
    );
  }
  const scopeAllows = (item: ContextItem) =>
    item.orgId === input.orgId &&
    item.channelIds.every((id) => allowed.includes(id)) &&
    (!item.agentId || item.agentId === input.agentId) &&
    (item.scopeType !== "person" || input.personIds?.includes(item.scopeId ?? ""));
  const evaluated = new Map<string, boolean>();
  let edges = 0;
  const visit = (id: string, path: ReadonlySet<string>): boolean => {
    if (++edges > 2048) return false;
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
