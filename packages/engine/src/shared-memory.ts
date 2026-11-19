import { and, asc, type Database, type Executor, eq, gt, inArray, isNull, ne, or, schema, sql } from "@agenteschat/db";
import { type ContextItem, checkContent, editContextItem, listContextItems } from "./context/items";
import { memorySourceVisibilityForUser } from "./context/memory-visibility";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { getMembership, requirePermission } from "./organizations";
import { enqueue } from "./outbox";
import { enqueueIndex, userVisibleChannels } from "./search";
import {
  assertSharedMemoryNotForgotten,
  forgetSharedMemoryEntry,
  lockSharedMemoryOrgs,
  queueSharedMemory,
  restoreSharedMemoryEnrollment,
  SHARED_MEMORY_JOB,
  type SharedProfileRow,
  sharedMemoryAvailability,
  sharedMemoryDestinationActive,
  sharedMemoryHash,
  sharedMemorySoleOwner,
  sharedMemoryVisibleIds,
  suspendSharedMemoryInOrg,
  writeSharedMemoryCopy,
} from "./shared-memory-store";
import type {
  SharedMemoryAction,
  SharedMemoryActionResult,
  SharedMemoryConsumer,
  SharedMemoryEntry,
  SharedMemorySensitivity,
  SharedMemorySnapshot,
  SharedMemorySource,
  SharedMemoryVerification,
} from "./shared-memory-types";

export { enqueueSharedMemoryRepair, SHARED_MEMORY_JOB } from "./shared-memory-store";
export * from "./shared-memory-types";

const {
  sharedMemoryProfiles: profiles,
  sharedMemoryEntries: entries,
  sharedMemoryDestinations: destinations,
  sharedMemoryReplicas: replicas,
  sharedMemorySources: sources,
  contextItems,
  organizations,
  organizationMembers,
} = schema;
const SENSITIVITIES: SharedMemorySensitivity[] = ["personal", "workspace", "sensitive"];
const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;
const conflict = () =>
  new ConflictError(
    "This memory changed. Read its current revision before deciding.",
    "shared_memory.version_conflict",
  );
const emptyVerification = (): SharedMemoryVerification => ({
  status: "not_run",
  checkedAt: null,
  runId: null,
  verifiedEntryIds: [],
  missingEntryIds: [],
  detail: "No fresh-thread retrieval has been verified.",
});
const initialConsumers = (): SharedMemoryConsumer[] => [
  {
    id: "claude_code",
    name: "Claude Code export",
    kind: "file",
    status: "not_connected",
    revision: null,
    checkedAt: null,
    reason: null,
    writable: false,
  },
  {
    id: "chatgpt",
    name: "ChatGPT native memory",
    kind: "chatgpt",
    status: "not_connected",
    revision: null,
    checkedAt: null,
    reason: "Native memory requires an observed import or snapshot.",
    writable: false,
  },
  {
    id: "claude",
    name: "Claude native memory",
    kind: "claude",
    status: "not_connected",
    revision: null,
    checkedAt: null,
    reason: "Native memory requires an observed import or snapshot.",
    writable: false,
  },
];

function date(value: string | null | undefined, name: string) {
  if (value === undefined || value === null) return null;
  const result = new Date(value);
  if (!Number.isFinite(result.getTime()) || (!name.startsWith("valid") && result.getTime() > Date.now() + 60_000))
    throw new ValidationError(`${name} must be a valid observed date, not a future capture`);
  return result;
}

function memoryKey(value: string) {
  if (!/^[\w][\w.\-:/]{0,159}$/.test(value))
    throw new ValidationError("Use a stable memory key of at most 160 characters");
  return value;
}

async function requireSource(db: Executor, profileId: string, sourceId?: string) {
  if (!sourceId) return;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sourceId))
    throw new ValidationError("Invalid source ID");
  const [source] = await db
    .select({ id: sources.id })
    .from(sources)
    .where(and(eq(sources.id, sourceId), eq(sources.profileId, profileId)));
  if (!source) throw new NotFoundError("Source not found in this profile");
}

async function actorProfile(db: Executor, actorId: string, orgId: string) {
  const [profile] = await db
    .select({ profile: profiles })
    .from(profiles)
    .innerJoin(destinations, eq(destinations.profileId, profiles.id))
    .where(and(eq(profiles.ownerUserId, actorId), eq(destinations.orgId, orgId)));
  return profile?.profile ?? null;
}

async function requireProfile(db: Database, actorId: string, orgId: string) {
  await requirePermission(db, actorId, orgId, "read");
  const profile = await actorProfile(db, actorId, orgId);
  if (!profile) throw new NotFoundError("Shared-memory profile not found");
  const member = await getMembership(db, actorId, profile.orgId);
  if (member?.role !== "owner") throw new ForbiddenError("Only the profile owner may change shared memory");
  return profile;
}

async function nativeItem(db: Executor, orgId: string, itemId: string, current = true) {
  const [row] = await db
    .select()
    .from(contextItems)
    .where(and(eq(contextItems.orgId, orgId), eq(contextItems.id, itemId)));
  if (!row || (current && (row.supersededBy || row.status !== "active")))
    throw new NotFoundError("Current native memory not found");
  return row;
}

async function readableItem(db: Database, actorId: string, orgId: string, itemId: string, current = true) {
  await requirePermission(db, actorId, orgId, "read");
  const item = await nativeItem(db, orgId, itemId, current);
  const visible = await memorySourceVisibilityForUser(
    db,
    orgId,
    actorId,
    await userVisibleChannels(db, orgId, actorId),
    [item],
  );
  if (!visible.has(item.id)) throw new NotFoundError("Native memory not found");
  return item;
}

/** Follow native history in the same organization, including converged predecessors, without guessing by titles. */
export async function sharedMemoryHistoryIds(db: Executor, orgId: string, currentId: string) {
  const found = new Set<string>();
  let frontier = [currentId];
  while (frontier.length) {
    const batch = await db
      .select({ id: contextItems.id })
      .from(contextItems)
      .where(and(eq(contextItems.orgId, orgId), inArray(contextItems.supersededBy, frontier)));
    frontier = batch.map((r) => r.id).filter((id) => !found.has(id) && id !== currentId);
    for (const id of frontier) found.add(id);
    if (found.size > 5000) throw new ValidationError("This history needs a paginated migration before enrollment");
  }
  return [...found];
}

async function configure(
  db: Database,
  actorId: string,
  orgId: string,
  input: Extract<SharedMemoryAction, { type: "configure" }>,
) {
  const orgIds = [...new Set([orgId, ...(input.destinations ?? []).map((d) => d.orgId)])];
  if ((input.adopt?.length ?? 0) > 500 || orgIds.length > 100)
    throw new ValidationError("Enroll at most 100 workspaces and 500 memories at a time");
  await db.transaction(async (tx) => {
    await lockSharedMemoryOrgs(tx, orgIds);
    for (const id of orgIds)
      if (!(await sharedMemorySoleOwner(tx, id, actorId)))
        throw new ForbiddenError(
          "Enrollment requires the same sole human owner in every selected workspace",
          "shared_memory.owner_only",
        );
    let [profile] = await tx.select().from(profiles).where(eq(profiles.ownerUserId, actorId)).for("update");
    if (profile && profile.orgId !== orgId)
      throw new ConflictError("Configure this profile in its canonical workspace");
    if (!profile)
      [profile] = await tx
        .insert(profiles)
        .values({
          orgId,
          ownerUserId: actorId,
          name: input.name?.trim().slice(0, 120) || "Shared memory",
          consumers: initialConsumers() as unknown as Record<string, unknown>[],
        })
        .returning();
    if (!profile) throw new Error("Profile was not inserted");
    if (input.name)
      await tx
        .update(profiles)
        .set({ name: input.name.trim().slice(0, 120) })
        .where(eq(profiles.id, profile.id));
    for (const id of orgIds)
      await tx
        .insert(destinations)
        .values({
          orgId: id,
          profileId: profile.id,
          allowedSensitivity: input.destinations?.find((d) => d.orgId === id)?.allowedSensitivity ?? SENSITIVITIES,
        })
        .onConflictDoUpdate({
          target: [destinations.profileId, destinations.orgId],
          set: { enabled: true, state: "active", reason: null },
        });
    for (const id of orgIds) await restoreSharedMemoryEnrollment(tx, profile, id);
    for (const choice of input.adopt ?? []) {
      memoryKey(choice.key);
      await requireSource(tx, profile.id, choice.sourceId);
      if (choice.replicas?.some((r) => r.orgId === orgId || !orgIds.includes(r.orgId)))
        throw new ValidationError("Every adopted replica must belong to an explicitly selected destination");
      const item = await readableItem(tx as Database, actorId, orgId, choice.itemId);
      await assertSharedMemoryNotForgotten(tx, item);
      if (item.agentId !== null || item.scopeType !== "org")
        throw new ValidationError("Adopt an organization-wide native item");
      checkContent(`${item.title}\n${item.content}`);
      const [prior] = await tx
        .select()
        .from(entries)
        .where(and(eq(entries.profileId, profile.id), eq(entries.logicalKey, choice.key)));
      if (prior && prior.itemId !== item.id) throw new ConflictError("That key already identifies another memory");
      let entry = prior;
      if (!entry)
        [entry] = await tx
          .insert(entries)
          .values({
            orgId,
            profileId: profile.id,
            logicalKey: choice.key,
            itemId: item.id,
            itemOrgId: orgId,
            sourceOrgId: orgId,
            sourceItemId: item.id,
            sourceId: choice.sourceId ?? null,
            sourceIds: item.sourceIds,
            historyIds: await sharedMemoryHistoryIds(tx, orgId, item.id),
            originId: `native:${orgId}:${item.id}`,
            sourceRevision: item.sourceRevision,
            contentHash: sharedMemoryHash(item.content),
            status: "active",
            assertion: "owner_statement",
            sensitivity: choice.sensitivity ?? "personal",
            validFrom: item.validFrom,
            validTo: item.validTo,
          })
          .returning();
      if (!entry) throw new Error("Memory binding was not inserted");
      for (const target of orgIds.filter((id) => id !== orgId)) {
        const explicit = choice.replicas?.find((r) => r.orgId === target);
        const matches = explicit
          ? [await readableItem(tx as Database, actorId, target, explicit.itemId)]
          : await tx
              .select()
              .from(contextItems)
              .where(
                and(
                  eq(contextItems.orgId, target),
                  isNull(contextItems.agentId),
                  isNull(contextItems.supersededBy),
                  eq(contextItems.status, "active"),
                  eq(contextItems.title, item.title),
                  eq(contextItems.content, item.content),
                ),
              );
        if (matches.length > 1)
          throw new ConflictError(
            "Several existing copies match; supply the current replica ID",
            "shared_memory.ambiguous_replica",
          );
        const replica = matches[0];
        if (!replica) continue;
        if (replica.agentId !== null || replica.scopeType !== "org")
          throw new ValidationError("Adopt an organization-wide replica");
        const same = sharedMemoryHash(replica.content) === entry.contentHash;
        await tx
          .insert(replicas)
          .values({
            orgId: target,
            profileId: profile.id,
            entryId: entry.id,
            itemId: replica.id,
            historyIds: await sharedMemoryHistoryIds(tx, target, replica.id),
            appliedHash: sharedMemoryHash(replica.content),
            appliedVersion: same ? entry.version : null,
            state: same ? "current" : "conflict",
            reason: same ? null : "The enrolled copy differs from the canonical memory",
            checkedAt: new Date(),
          })
          .onConflictDoNothing();
      }
    }
    await queueSharedMemory(tx, profile.id);
  });
}

export async function reconcileSharedMemory(db: Database, profileId: string) {
  const [profile] = await db.select().from(profiles).where(eq(profiles.id, profileId));
  if (!profile) return { updated: 0, conflicts: 0, blocked: 0 };
  const targets = await db
    .select()
    .from(destinations)
    .where(
      and(eq(destinations.profileId, profileId), eq(destinations.enabled, true), ne(destinations.orgId, profile.orgId)),
    );
  let updated = 0;
  let conflicts = 0;
  let blocked = 0;
  for (const target of targets) {
    let cursor: string | undefined;
    while (true) {
      const page = await db
        .select({ id: entries.id })
        .from(entries)
        .where(and(eq(entries.profileId, profileId), cursor ? gt(entries.id, cursor) : undefined))
        .orderBy(asc(entries.id))
        .limit(100);
      if (!page.length) break;
      for (const { id } of page)
        await db.transaction(async (tx) => {
          await lockSharedMemoryOrgs(tx, [profile.orgId, target.orgId]);
          const [liveTarget] = await tx.select().from(destinations).where(eq(destinations.id, target.id));
          if (!sharedMemoryDestinationActive(liveTarget)) {
            blocked++;
            return;
          }
          if (
            !(await sharedMemorySoleOwner(tx, profile.orgId, profile.ownerUserId)) ||
            !(await sharedMemorySoleOwner(tx, target.orgId, profile.ownerUserId))
          ) {
            await suspendSharedMemoryInOrg(tx, target.orgId, "Workspace membership changed", profile.id);
            blocked++;
            return;
          }
          const [entry] = await tx
            .select()
            .from(entries)
            .where(and(eq(entries.id, id), eq(entries.profileId, profileId)))
            .for("update");
          if (!entry || entry.status === "forgotten") return;
          const [replica] = await tx
            .select()
            .from(replicas)
            .where(and(eq(replicas.entryId, id), eq(replicas.orgId, target.orgId)))
            .for("update");
          if (replica?.state === "forgotten") return;
          if (entry.status !== "active" || !liveTarget.allowedSensitivity.includes(entry.sensitivity)) {
            if (replica?.itemId) {
              await tx
                .update(contextItems)
                .set({ status: "archived", version: sql`${contextItems.version} + 1` })
                .where(and(eq(contextItems.id, replica.itemId), eq(contextItems.status, "active")));
              await tx
                .update(replicas)
                .set({
                  state: "blocked",
                  reason: "The memory is not approved for this destination",
                  checkedAt: new Date(),
                })
                .where(eq(replicas.id, replica.id));
              await enqueueIndex(tx, { orgId: target.orgId, kind: "context_item", sourceId: replica.itemId });
            }
            return;
          }
          if (!entry.itemId) return;
          let source: ContextItem;
          try {
            source = await readableItem(tx as Database, profile.ownerUserId, entry.itemOrgId, entry.itemId);
          } catch (error) {
            if (!(error instanceof NotFoundError || error instanceof ForbiddenError)) throw error;
            if (replica?.itemId) {
              await tx
                .update(contextItems)
                .set({ status: "archived", version: sql`${contextItems.version} + 1` })
                .where(
                  and(
                    eq(contextItems.orgId, target.orgId),
                    eq(contextItems.id, replica.itemId),
                    eq(contextItems.status, "active"),
                  ),
                );
              await enqueueIndex(tx, { orgId: target.orgId, kind: "context_item", sourceId: replica.itemId });
            }
            await tx
              .insert(replicas)
              .values({
                orgId: target.orgId,
                profileId,
                entryId: entry.id,
                state: "blocked",
                reason: "The canonical memory or its source is unavailable.",
                checkedAt: new Date(),
              })
              .onConflictDoUpdate({
                target: [replicas.entryId, replicas.orgId],
                set: {
                  state: "blocked",
                  reason: "The canonical memory or its source is unavailable.",
                  checkedAt: new Date(),
                },
              });
            blocked++;
            return;
          }
          if (
            source.orgId !== profile.orgId ||
            source.supersededBy ||
            sharedMemoryHash(source.content) !== entry.contentHash
          )
            throw new ConflictError(
              "The canonical native revision changed before synchronization",
              "shared_memory.source_changed",
            );
          let previous: ContextItem | undefined;
          if (replica?.itemId)
            [previous] = await tx
              .select()
              .from(contextItems)
              .where(and(eq(contextItems.orgId, target.orgId), eq(contextItems.id, replica.itemId)));
          if (previous?.supersededBy && replica) {
            await tx
              .update(replicas)
              .set({ state: "conflict", reason: "The destination has an unreviewed successor", checkedAt: new Date() })
              .where(eq(replicas.id, replica.id));
            conflicts++;
            return;
          }
          const same =
            previous &&
            replica &&
            previous.status === "active" &&
            previous.agentId === null &&
            previous.scopeType === "org" &&
            sharedMemoryHash(previous.content) === entry.contentHash &&
            previous.title === source.title &&
            previous.pinned === source.pinned;
          if (
            !same &&
            previous &&
            replica &&
            (replica.state === "conflict" || sharedMemoryHash(previous.content) !== replica.appliedHash)
          ) {
            await tx
              .update(replicas)
              .set({
                state: "conflict",
                reason: "The destination changed; the edit is preserved for review",
                checkedAt: new Date(),
              })
              .where(eq(replicas.id, replica.id));
            conflicts++;
            return;
          }
          const copy =
            same && previous ? previous : await writeSharedMemoryCopy(tx, profile, target.orgId, source, previous);
          if (!same) updated++;
          await tx
            .insert(replicas)
            .values({
              orgId: target.orgId,
              profileId,
              entryId: entry.id,
              itemId: copy.id,
              historyIds: [...new Set([...(replica?.historyIds ?? []), ...(previous ? [previous.id] : [])])].filter(
                (id) => id !== copy.id,
              ),
              appliedHash: entry.contentHash,
              appliedVersion: entry.version,
              state: "current",
              checkedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: [replicas.entryId, replicas.orgId],
              set: {
                itemId: copy.id,
                historyIds: [...new Set([...(replica?.historyIds ?? []), ...(previous ? [previous.id] : [])])].filter(
                  (id) => id !== copy.id,
                ),
                appliedHash: entry.contentHash,
                appliedVersion: entry.version,
                state: "current",
                reason: null,
                checkedAt: new Date(),
              },
            });
        });
      cursor = page.at(-1)?.id;
      if (page.length < 100) break;
    }
    await db
      .update(destinations)
      .set({ lastSyncedAt: new Date() })
      .where(and(eq(destinations.id, target.id), eq(destinations.state, "active")));
  }
  return { updated, conflicts, blocked };
}

function preserveKey(original: string, content: string) {
  const header = /^Logical key: [^\r\n]+\r?\n/.exec(original)?.[0];
  return header && !content.startsWith(header)
    ? `${header}${content.replace(/^Logical key: [^\r\n]+\r?\n/, "")}`
    : content;
}

async function verifyRun(db: Database, profile: SharedProfileRow, runId: string, requested: string[], persist = true) {
  if (!requested.length || requested.length > 100) throw new ValidationError("Verify between 1 and 100 memory entries");
  const [run] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, runId));
  const [target] = run
    ? await db
        .select()
        .from(destinations)
        .where(and(eq(destinations.profileId, profile.id), eq(destinations.orgId, run.orgId)))
    : [];
  if (
    !run ||
    !target ||
    !sharedMemoryDestinationActive(target) ||
    run.status !== "done" ||
    run.threadRootId !== run.triggerMessageId ||
    run.createdAt.getTime() > Date.now() ||
    Date.now() - run.createdAt.getTime() > 86_400_000
  )
    throw new ValidationError(
      "Use a completed, fresh native thread from the last day",
      "shared_memory.invalid_verification",
    );
  if (
    !(await sharedMemorySoleOwner(db, profile.orgId, profile.ownerUserId)) ||
    !(await sharedMemorySoleOwner(db, run.orgId, profile.ownerUserId))
  )
    throw new ValidationError(
      "Verification requires the currently enrolled owner-only audience",
      "shared_memory.invalid_verification",
    );
  const [trigger] = await db
    .select()
    .from(schema.messages)
    .where(and(eq(schema.messages.orgId, run.orgId), eq(schema.messages.id, run.triggerMessageId)));
  if (!trigger || trigger.deletedAt || trigger.authorType !== "person" || trigger.authorUserId !== profile.ownerUserId)
    throw new ValidationError(
      "The verification must come from this profile owner",
      "shared_memory.invalid_verification",
    );
  const desired = await db
    .select()
    .from(entries)
    .where(and(eq(entries.profileId, profile.id), inArray(entries.id, [...new Set(requested)])));
  if (
    desired.length !== new Set(requested).size ||
    desired.some((e) => e.status !== "active" || e.updatedAt > run.createdAt)
  )
    throw new ValidationError("The run predates the current memory revision", "shared_memory.invalid_verification");
  const used = await db
    .select({ id: schema.contextUsage.itemId })
    .from(schema.contextUsage)
    .where(and(eq(schema.contextUsage.orgId, run.orgId), eq(schema.contextUsage.runId, run.id)));
  const copies = await db
    .select()
    .from(replicas)
    .where(and(eq(replicas.orgId, run.orgId), inArray(replicas.entryId, requested)));
  const readable = await sharedMemoryVisibleIds(
    db,
    run.orgId,
    used.map((u) => u.id),
    undefined,
    { agent: true },
  );
  const verified = desired
    .filter((e) => {
      const replica = copies.find((c) => c.entryId === e.id);
      const id =
        run.orgId === profile.orgId
          ? e.itemId
          : replica?.state === "current" && replica.appliedVersion === e.version
            ? replica.itemId
            : null;
      return id && readable.has(id) && used.some((u) => u.id === id);
    })
    .map((e) => e.id);
  const missing = requested.filter((id) => !verified.includes(id));
  const verification: SharedMemoryVerification = {
    status: missing.length ? "failed" : "passed",
    checkedAt: new Date().toISOString(),
    runId,
    verifiedEntryIds: verified,
    missingEntryIds: missing,
    detail:
      "Checks current native item IDs recorded as retrieved in a fresh thread. It does not grade the final answer.",
  };
  if (persist)
    await db
      .update(profiles)
      .set({ verification: verification as unknown as Record<string, unknown> })
      .where(eq(profiles.id, profile.id));
  return verification;
}

export async function sharedMemoryAction(
  db: Database,
  actorId: string,
  orgId: string,
  input: SharedMemoryAction,
): Promise<SharedMemoryActionResult> {
  if (input.type === "configure") {
    await configure(db, actorId, orgId, input);
    return { snapshot: await sharedMemorySnapshot(db, actorId, orgId), action: { state: "queued" } };
  }
  const profile = await requireProfile(db, actorId, orgId);
  if (input.type === "verify") await verifyRun(db, profile, input.runId, input.entryIds);
  else
    await db.transaction(async (tx) => {
      await lockSharedMemoryOrgs(tx, [profile.orgId, ...(input.type === "destination" ? [input.orgId] : [])]);
      if (!(await sharedMemorySoleOwner(tx, profile.orgId, actorId)))
        throw new ForbiddenError("The canonical workspace is no longer owner-only", "shared_memory.owner_only");
      const [lockedProfile] = await tx.select().from(profiles).where(eq(profiles.id, profile.id)).for("update");
      if (!lockedProfile) throw new NotFoundError("Profile not found");
      if (input.type === "reconcile") {
        await enqueue(tx, {
          orgId: profile.orgId,
          kind: SHARED_MEMORY_JOB,
          payload: { profileId: profile.id },
          dedupeKey: `${SHARED_MEMORY_JOB}:manual:${profile.id}:${Math.floor(Date.now() / 60_000)}`,
        });
        return;
      }
      if (input.type === "destination") {
        if (input.orgId === profile.orgId && !input.enabled)
          throw new ValidationError("The canonical workspace cannot be disabled");
        if (input.enabled && !(await sharedMemorySoleOwner(tx, input.orgId, actorId)))
          throw new ForbiddenError("The destination must have this same sole human owner");
        if (!input.enabled) {
          const [enrolled] = await tx
            .select({ id: destinations.id })
            .from(destinations)
            .where(and(eq(destinations.profileId, profile.id), eq(destinations.orgId, input.orgId)));
          if (!enrolled) throw new NotFoundError("Destination not found in this profile");
          await suspendSharedMemoryInOrg(tx, input.orgId, "Destination disabled by its owner", profile.id);
        }
        await tx
          .insert(destinations)
          .values({
            orgId: input.orgId,
            profileId: profile.id,
            enabled: input.enabled,
            state: input.enabled ? "active" : "paused",
            allowedSensitivity: input.allowedSensitivity ?? SENSITIVITIES,
          })
          .onConflictDoUpdate({
            target: [destinations.profileId, destinations.orgId],
            set: {
              enabled: input.enabled,
              state: input.enabled ? "active" : "paused",
              reason: null,
              ...(input.allowedSensitivity ? { allowedSensitivity: input.allowedSensitivity } : {}),
            },
          });
        if (input.enabled) await restoreSharedMemoryEnrollment(tx, lockedProfile, input.orgId);
        await queueSharedMemory(tx, profile.id);
        return;
      }
      if (input.type === "source") {
        const value = input.source;
        date(value.capturedAt, "capturedAt");
        date(value.observedAt, "observedAt");
        if (value.refreshAfter && !Number.isFinite(new Date(value.refreshAfter).getTime()))
          throw new ValidationError("Invalid refresh date");
        if (value.id) {
          await requireSource(tx, profile.id, value.id);
          const [prior] = await tx
            .select()
            .from(sources)
            .where(and(eq(sources.id, value.id), eq(sources.profileId, profile.id)));
          if (prior?.originId !== value.originId) throw new ConflictError("A source ID cannot change its origin");
        }
        if (value.reference && !/^(https?:\/\/|\/|library:|native:)/.test(value.reference))
          throw new ValidationError("Unsupported source reference");
        const metadata = {
          ...value,
          status:
            value.provider === "native" && value.status === "current"
              ? "current"
              : value.status === "blocked"
                ? "blocked"
                : "snapshot",
        };
        await tx
          .insert(sources)
          .values({ orgId: profile.orgId, profileId: profile.id, originId: value.originId, metadata })
          .onConflictDoUpdate({
            target: [sources.profileId, sources.originId],
            set: { metadata, updatedAt: new Date() },
          });
        await queueSharedMemory(tx, profile.id);
        return;
      }
      if (input.type === "consumer") {
        const consumer = { ...input.consumer, writable: false };
        if (consumer.checkedAt) date(consumer.checkedAt, "checkedAt");
        if (consumer.revision !== null && consumer.revision > lockedProfile.version)
          throw new ValidationError("Consumer revision is ahead of the profile");
        // An owner may record a snapshot receipt; this API cannot manufacture a live consumer adapter.
        if (consumer.status === "current" && consumer.kind !== "file") consumer.status = "snapshot";
        if (consumer.status === "current") {
          const availability = await sharedMemoryAvailability(tx, lockedProfile);
          if (consumer.revision !== lockedProfile.version || consumer.availabilityRevision !== availability.revision) {
            consumer.status = "pending";
            consumer.reason = "The native revision or source availability changed after this receipt.";
          }
        }
        const list = lockedProfile.consumers.filter((c) => c.id !== consumer.id);
        list.push(consumer as unknown as Record<string, unknown>);
        await tx.update(profiles).set({ consumers: list }).where(eq(profiles.id, profile.id));
        return;
      }
      if (input.type === "capture") {
        await requireSource(tx, profile.id, input.sourceId);
        if (input.key) memoryKey(input.key);
        const [target] = await tx
          .select()
          .from(destinations)
          .where(and(eq(destinations.profileId, profile.id), eq(destinations.orgId, input.sourceOrgId)));
        if (!sharedMemoryDestinationActive(target) || !(await sharedMemorySoleOwner(tx, input.sourceOrgId, actorId)))
          throw new ForbiddenError("Enroll the source workspace with this same sole owner first");
        const item = await readableItem(tx as Database, actorId, input.sourceOrgId, input.itemId);
        await assertSharedMemoryNotForgotten(tx, item);
        const hash = sharedMemoryHash(item.content);
        const [existing] = await tx
          .select()
          .from(entries)
          .where(
            and(
              eq(entries.profileId, profile.id),
              or(
                eq(entries.contentHash, hash),
                eq(entries.originId, input.originId ?? `native:${item.orgId}:${item.id}`),
              ),
            ),
          );
        if (existing?.status === "forgotten")
          throw new ConflictError("This memory was forgotten", "shared_memory.forgotten");
        if (existing) return;
        await tx.insert(entries).values({
          orgId: profile.orgId,
          profileId: profile.id,
          logicalKey: input.key ?? `native.${item.id}`,
          itemId: item.id,
          itemOrgId: item.orgId,
          sourceOrgId: item.orgId,
          sourceItemId: item.id,
          sourceId: input.sourceId ?? null,
          sourceIds: item.sourceIds,
          originId: input.originId ?? `native:${item.orgId}:${item.id}`,
          contentHash: hash,
          sourceRevision: item.sourceRevision,
          status: "candidate",
          assertion: "import",
          observedAt: date(input.observedAt, "observedAt"),
          validFrom: item.validFrom,
          validTo: item.validTo,
        });
        await queueSharedMemory(tx, profile.id);
        return;
      }
      const [entry] = await tx
        .select()
        .from(entries)
        .where(and(eq(entries.id, input.entryId), eq(entries.profileId, profile.id)))
        .for("update");
      if (!entry) throw new NotFoundError("Memory entry not found");
      if (entry.version !== input.expectedVersion) throw conflict();
      if (entry.status === "forgotten") throw new ConflictError("This memory was forgotten", "shared_memory.forgotten");
      if (input.type === "forget") {
        if (input.scope === "workspace") {
          if (!input.destinationOrgId || input.destinationOrgId === profile.orgId)
            throw new ValidationError("Choose a replica workspace, or forget the whole profile");
          const [target] = await tx
            .select()
            .from(destinations)
            .where(and(eq(destinations.profileId, profile.id), eq(destinations.orgId, input.destinationOrgId)));
          if (!target) throw new NotFoundError("Destination not found");
        }
        await forgetSharedMemoryEntry(
          tx,
          lockedProfile,
          entry,
          input.scope === "workspace" ? input.destinationOrgId : undefined,
        );
        return;
      }
      if (input.type === "sensitivity") {
        await tx
          .update(entries)
          .set({ sensitivity: input.sensitivity, version: entry.version + 1, updatedAt: new Date() })
          .where(eq(entries.id, entry.id));
        await queueSharedMemory(tx, profile.id);
        return;
      }
      if (input.type === "decide" && input.decision === "reject") {
        if (!["candidate", "disputed"].includes(entry.status))
          throw new ConflictError("Only a candidate can be decided");
        await tx
          .update(entries)
          .set({ status: "rejected", version: entry.version + 1, updatedAt: new Date() })
          .where(eq(entries.id, entry.id));
        await queueSharedMemory(tx, profile.id);
        return;
      }
      if (!entry.itemId) throw new NotFoundError("Native memory no longer exists");
      const item = await readableItem(tx as Database, actorId, entry.itemOrgId, entry.itemId);
      if (input.type === "correct") {
        const content = preserveKey(item.content, input.content);
        if (content.length > 8000)
          throw new ValidationError("The memory including its identity header must be at most 8000 characters");
        checkContent(content);
        const next = await editContextItem(tx as Database, actorId, entry.itemOrgId, item.id, {
          expectedVersion: item.version,
          content,
          title: input.title ?? item.title,
          pinned: item.pinned,
        });
        if (input.validFrom !== undefined || input.validTo !== undefined) {
          const from = input.validFrom === undefined ? item.validFrom : date(input.validFrom, "validFrom");
          const to = input.validTo === undefined ? item.validTo : date(input.validTo, "validTo");
          if (from && to && to <= from) throw new ValidationError("Validity must end after it starts");
          await tx.update(contextItems).set({ validFrom: from, validTo: to }).where(eq(contextItems.id, next.id));
          await tx.update(entries).set({ validFrom: from, validTo: to }).where(eq(entries.id, entry.id));
        }
        return;
      }
      if (input.type === "decide") {
        if (!["candidate", "disputed"].includes(entry.status))
          throw new ConflictError("Only a candidate can be decided");
        await assertSharedMemoryNotForgotten(tx, item);
        {
          const [contribution] = await tx
            .select({ id: replicas.id })
            .from(replicas)
            .where(
              and(eq(replicas.profileId, profile.id), eq(replicas.itemId, item.id), ne(replicas.entryId, entry.id)),
            );
          if (contribution)
            throw new ConflictError(
              "This is a conflicting replica contribution. Correct the current canonical entry, then reject this proposal.",
              "shared_memory.replica_contribution",
            );
          const accepted = {
            ...item,
            trust: "high" as const,
            verified: true,
            createdByKind: "person",
            createdById: actorId,
            evidence: [...item.evidence, { type: "human" as const, ref: actorId, at: new Date().toISOString() }],
          };
          const copy = await writeSharedMemoryCopy(
            tx,
            profile,
            profile.orgId,
            accepted,
            item.orgId === profile.orgId ? item : undefined,
          );
          await tx
            .update(entries)
            .set({
              itemId: copy.id,
              itemOrgId: profile.orgId,
              status: "active",
              assertion: "owner_statement",
              version: entry.version + 1,
              historyIds: item.orgId === profile.orgId ? [...entry.historyIds, item.id] : entry.historyIds,
              updatedAt: new Date(),
            })
            .where(eq(entries.id, entry.id));
          if (item.orgId !== profile.orgId)
            await tx
              .insert(replicas)
              .values({
                orgId: item.orgId,
                profileId: profile.id,
                entryId: entry.id,
                itemId: item.id,
                historyIds: await sharedMemoryHistoryIds(tx, item.orgId, item.id),
                appliedHash: entry.contentHash,
                appliedVersion: entry.version + 1,
                state: "current",
                checkedAt: new Date(),
              })
              .onConflictDoNothing();
        }
        await queueSharedMemory(tx, profile.id);
      }
    });
  return {
    snapshot: await sharedMemorySnapshot(db, actorId, orgId),
    action: {
      state: input.type === "verify" || input.type === "source" || input.type === "consumer" ? "applied" : "queued",
    },
  };
}

export async function sharedMemorySnapshot(
  db: Database,
  actorId: string,
  orgId: string,
  options: { cursor?: string; limit?: number } = {},
): Promise<SharedMemorySnapshot> {
  const membership = await requirePermission(db, actorId, orgId, "read");
  const profile = await actorProfile(db, actorId, orgId);
  const own = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
    .where(and(eq(organizationMembers.userId, actorId), eq(organizationMembers.role, "owner")));
  const eligibleDestinations: SharedMemorySnapshot["eligibleDestinations"] = [];
  for (const row of own)
    if (await sharedMemorySoleOwner(db, row.id, actorId)) eligibleDestinations.push({ orgId: row.id, name: row.name });
  const availableItems =
    membership.role === "owner"
      ? (await listContextItems(db, actorId, orgId, { limit: 500 }))
          .filter((i) => !i.supersededBy && i.status === "active" && i.agentId === null && i.scopeType === "org")
          .map((i) => ({ itemId: i.id, title: i.title || i.content.slice(0, 80), kind: i.kind, version: i.version }))
      : [];
  const empty: SharedMemorySnapshot = {
    profile: null,
    canManage: membership.role === "owner",
    entries: [],
    candidates: [],
    destinations: [],
    sources: [],
    consumers: [],
    verification: emptyVerification(),
    availableItems,
    eligibleDestinations,
    pagination: { nextCursor: null, complete: true, total: 0 },
    graph: { nodes: [], edges: [] },
  };
  if (!profile) return empty;
  const limit = Math.max(1, Math.min(500, options.limit ?? 100));
  if (options.cursor && !/^[0-9a-f-]{36}$/i.test(options.cursor)) throw new ValidationError("Invalid cursor");
  const [page, counts, targets, sourceRows, replicaRows, availability] = await Promise.all([
    db
      .select()
      .from(entries)
      .where(and(eq(entries.profileId, profile.id), options.cursor ? gt(entries.id, options.cursor) : undefined))
      .orderBy(asc(entries.id))
      .limit(limit + 1),
    db.select({ total: sql<number>`count(*)::int` }).from(entries).where(eq(entries.profileId, profile.id)),
    db
      .select({ row: destinations, name: organizations.name })
      .from(destinations)
      .innerJoin(organizations, eq(organizations.id, destinations.orgId))
      .where(eq(destinations.profileId, profile.id)),
    db.select().from(sources).where(eq(sources.profileId, profile.id)),
    db.select().from(replicas).where(eq(replicas.profileId, profile.id)),
    sharedMemoryAvailability(db, profile),
  ]);
  const states = availability.bindings;
  const kept = page.slice(0, limit);
  const native = [...availability.native.values()];
  const views: SharedMemoryEntry[] = kept.map((e) => {
    const item = native.find((i) => i.id === e.itemId && i.orgId === e.itemOrgId);
    const forgotten = e.status === "forgotten";
    const readable = availability.readable.has(e.id);
    return {
      id: e.id,
      key: e.logicalKey,
      itemId: readable ? e.itemId : null,
      sourceOrgId: e.sourceOrgId,
      title: forgotten ? "Forgotten memory" : readable ? (item?.title ?? e.logicalKey) : "Unavailable memory",
      content: readable ? (item?.content ?? "") : "",
      readable,
      blockedReason: availability.reasons.get(e.id) ?? null,
      kind: item?.kind ?? "fact",
      status: e.status as SharedMemoryEntry["status"],
      version: e.version,
      itemVersion: readable ? (item?.version ?? null) : null,
      sensitivity: e.sensitivity as SharedMemorySensitivity,
      assertion: e.assertion as SharedMemoryEntry["assertion"],
      originId: e.originId,
      sourceId: e.sourceId,
      sourceIds: e.sourceIds,
      sourceRevision: e.sourceRevision,
      observedAt: iso(e.observedAt),
      recordedAt: e.createdAt.toISOString(),
      validFrom: iso(e.validFrom),
      validTo: iso(e.validTo),
      forgottenAt: iso(e.forgottenAt),
      externalOutstanding: e.externalOutstanding,
      replicas: replicaRows
        .filter((r) => r.entryId === e.id)
        .map((r) => ({
          orgId: r.orgId,
          itemId: r.itemId,
          state: (r.state === "current" && !readable
            ? "blocked"
            : r.state === "current" && r.appliedVersion !== e.version
              ? "pending"
              : r.state) as "current",
          appliedVersion: r.appliedVersion,
          checkedAt: iso(r.checkedAt),
          reason: !readable ? (availability.reasons.get(e.id) ?? r.reason) : r.reason,
        })),
      history: !readable
        ? []
        : native
            .filter(
              (i) => e.historyIds.includes(i.id) && i.orgId === e.itemOrgId && availability.readableItems.has(i.id),
            )
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
            .map((i) => ({
              itemId: i.id,
              version: i.version,
              title: i.title,
              content: i.content,
              status: i.status,
              recordedAt: i.createdAt.toISOString(),
            })),
    };
  });
  const sourceViews = sourceRows.map((s) => ({
    ...s.metadata,
    id: s.id,
    status:
      typeof s.metadata.refreshAfter === "string" &&
      new Date(s.metadata.refreshAfter).getTime() < Date.now() &&
      s.metadata.status !== "blocked"
        ? "stale"
        : (s.metadata.status ?? "snapshot"),
  })) as unknown as SharedMemorySource[];
  const graph: SharedMemorySnapshot["graph"] = { nodes: [], edges: [] };
  const destinationCounts = (row: typeof destinations.$inferSelect) => {
    const eligible = sharedMemoryDestinationActive(row)
      ? states.filter(
          (e) =>
            e.status === "active" && availability.readable.has(e.id) && row.allowedSensitivity.includes(e.sensitivity),
        )
      : [];
    if (row.orgId === profile.orgId) return { current: eligible.length, pending: 0, conflicts: 0 };
    const copies = replicaRows.filter((r) => r.orgId === row.orgId);
    return {
      current: eligible.filter((e) =>
        copies.some((r) => r.entryId === e.id && r.state === "current" && r.appliedVersion === e.version),
      ).length,
      pending: eligible.filter((e) => {
        const copy = copies.find((r) => r.entryId === e.id);
        return !copy || copy.state === "pending" || (copy.state === "current" && copy.appliedVersion !== e.version);
      }).length,
      conflicts: copies.filter((r) => r.state === "conflict").length,
    };
  };
  for (const s of sourceViews)
    graph.nodes.push({ id: `source:${s.id}`, kind: "source", label: s.name, sourceId: s.id });
  for (const t of targets)
    graph.nodes.push({ id: `org:${t.row.orgId}`, kind: "workspace", label: t.name, orgId: t.row.orgId });
  for (const e of views) {
    graph.nodes.push({ id: `entry:${e.id}`, kind: "entry", label: e.title, entryId: e.id });
    if (e.sourceId && sourceViews.some((s) => s.id === e.sourceId))
      graph.edges.push({ from: `entry:${e.id}`, to: `source:${e.sourceId}`, kind: "derived_from" });
    for (const parent of states)
      if (parent.id !== e.id && e.sourceIds.some((id) => id === parent.itemId || parent.historyIds.includes(id)))
        graph.edges.push({ from: `entry:${e.id}`, to: `entry:${parent.id}`, kind: "derived_from" });
    for (const r of e.replicas)
      graph.edges.push({
        from: `entry:${e.id}`,
        to: `org:${r.orgId}`,
        kind: r.state === "conflict" ? "conflicts_with" : "replicated_to",
      });
  }
  let verification = (profile.verification as unknown as SharedMemoryVerification | null) ?? emptyVerification();
  if (verification.status === "passed" && verification.runId) {
    try {
      const current = await verifyRun(db, profile, verification.runId, verification.verifiedEntryIds, false);
      verification = { ...current, checkedAt: verification.checkedAt };
    } catch (error) {
      if (!(error instanceof ValidationError) && !(error instanceof ForbiddenError)) throw error;
      verification = {
        ...emptyVerification(),
        checkedAt: verification.checkedAt,
        runId: verification.runId,
        detail: "The previous check no longer proves current source availability. Verify a fresh run.",
      };
    }
  }
  return {
    ...empty,
    profile: {
      id: profile.id,
      name: profile.name,
      ownerUserId: profile.ownerUserId,
      canonicalOrgId: profile.orgId,
      version: profile.version,
      availabilityRevision: availability.revision,
      updatedAt: profile.updatedAt.toISOString(),
    },
    canManage: true,
    entries: views.filter((v) => v.status !== "candidate" && v.status !== "disputed"),
    candidates: views.filter((v) => v.status === "candidate" || v.status === "disputed"),
    destinations: targets.map(({ row, name }) => ({
      orgId: row.orgId,
      name,
      enabled: row.enabled,
      state: row.state as "active",
      allowedSensitivity: row.allowedSensitivity as SharedMemorySensitivity[],
      lastSyncedAt: iso(row.lastSyncedAt),
      reason: row.reason,
      ...destinationCounts(row),
    })),
    sources: sourceViews,
    consumers: (profile.consumers as unknown as SharedMemoryConsumer[]).map((c) => ({
      ...c,
      availabilityRevision: c.availabilityRevision ?? null,
      status:
        c.status === "current" && (c.revision !== profile.version || c.availabilityRevision !== availability.revision)
          ? "pending"
          : c.status,
      reason:
        c.status === "current" && (c.revision !== profile.version || c.availabilityRevision !== availability.revision)
          ? "The native revision or source availability changed after this receipt."
          : c.reason,
      writable: false,
    })),
    verification,
    pagination: {
      nextCursor: page.length > limit ? (kept.at(-1)?.id ?? null) : null,
      complete: page.length <= limit,
      total: counts[0]?.total ?? 0,
    },
    graph,
  };
}
