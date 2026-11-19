import { createHash } from "node:crypto";
import { and, asc, type Database, type Executor, eq, inArray, ne, or, schema, sql } from "@agenteschat/db";
import { caches } from "./cache";
import type { ContextItem } from "./context/items";
import { ConflictError, ForbiddenError } from "./errors";
import { enqueue } from "./outbox";
import { enqueueIndex } from "./search";
import { openOrg } from "./standing";

const {
  contextItems,
  sharedMemoryProfiles: profiles,
  sharedMemoryEntries: entries,
  sharedMemoryDestinations: destinations,
  sharedMemoryReplicas: replicas,
  organizationMembers,
  organizations,
  messages,
} = schema;
export type SharedProfileRow = typeof profiles.$inferSelect;
export type SharedEntryRow = typeof entries.$inferSelect;
export const SHARED_MEMORY_JOB = "memory.shared.reconcile";

/** Destination enrollment state is separate from the organization's centralized standing policy. */
export function sharedMemoryDestinationActive<T extends Pick<typeof destinations.$inferSelect, "enabled" | "state">>(
  destination: T | null | undefined,
): destination is T {
  const synchronizationState = destination?.state;
  return Boolean(destination?.enabled && synchronizationState === "active");
}

/** Canonical managed records have explicit review/replication, so generic semantic maintenance cannot rewrite them. */
export const unmanagedMemorySql = () => sql`not exists (select 1 from ${entries}
  where ${entries.itemId} = ${contextItems.id} or ${entries.sourceItemId} = ${contextItems.id})
  and not exists (select 1 from ${replicas} where ${replicas.itemId} = ${contextItems.id})`;

/** Hash exact stored text; the portable logical-key header is identity metadata, not another observation. */
export const sharedMemoryHash = (content: string) =>
  createHash("sha256")
    .update(content.replace(/^Logical key: [^\r\n]+\r?\n/, ""))
    .digest("hex");

export async function sharedMemorySoleOwner(db: Executor, orgId: string, userId: string) {
  const members = await db
    .select({ userId: organizationMembers.userId, role: organizationMembers.role })
    .from(organizationMembers)
    .where(eq(organizationMembers.orgId, orgId));
  const [org] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(eq(organizations.id, orgId), openOrg));
  return Boolean(org && members.length === 1 && members[0]?.userId === userId && members[0]?.role === "owner");
}

/** The same fence as organizations.lockOrgMembers, in stable order when a job spans tenants. */
export async function lockSharedMemoryOrgs(tx: Executor, ids: string[]) {
  for (const id of [...new Set(ids)].sort())
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`org-members:${id}`}))`);
}

export async function queueSharedMemory(tx: Executor, profileId: string) {
  const [profile] = await tx
    .update(profiles)
    .set({ version: sql`${profiles.version} + 1`, verification: null, updatedAt: new Date() })
    .where(eq(profiles.id, profileId))
    .returning();
  if (!profile) return;
  await enqueue(tx, {
    orgId: profile.orgId,
    kind: SHARED_MEMORY_JOB,
    payload: { profileId },
    dedupeKey: `${SHARED_MEMORY_JOB}:${profileId}:${profile.version}`,
  });
}

export async function sharedProfilesInOrg(db: Executor, orgId: string) {
  return db
    .select({ profile: profiles })
    .from(profiles)
    .innerJoin(destinations, eq(destinations.profileId, profiles.id))
    .where(and(eq(destinations.orgId, orgId), eq(destinations.enabled, true), eq(destinations.state, "active")))
    .then((rows) => rows.map((r) => r.profile));
}

export async function assertSharedMemoryNotForgotten(db: Executor, input: { orgId: string; content: string }) {
  const available = await db
    .select({ id: profiles.id })
    .from(profiles)
    .innerJoin(destinations, eq(destinations.profileId, profiles.id))
    .where(eq(destinations.orgId, input.orgId));
  if (!available.length) return;
  const hash = sharedMemoryHash(input.content);
  const tombstones = await db
    .select({ hash: entries.contentHash, hashes: entries.forgottenHashes })
    .from(entries)
    .where(
      and(
        inArray(
          entries.profileId,
          available.map((p) => p.id),
        ),
        eq(entries.status, "forgotten"),
      ),
    );
  const scoped = await db
    .select({ entry: entries })
    .from(replicas)
    .innerJoin(entries, eq(entries.id, replicas.entryId))
    .where(
      and(
        eq(replicas.orgId, input.orgId),
        eq(replicas.state, "forgotten"),
        inArray(
          entries.profileId,
          available.map((p) => p.id),
        ),
      ),
    );
  const historyIds = scoped.flatMap(({ entry }) => entry.historyIds);
  const history = historyIds.length
    ? await db.select({ content: contextItems.content }).from(contextItems).where(inArray(contextItems.id, historyIds))
    : [];
  if (
    tombstones.some((t) => t.hash === hash || t.hashes.includes(hash)) ||
    scoped.some(({ entry }) => entry.contentHash === hash || entry.forgottenHashes.includes(hash)) ||
    history.some((item) => item.content && sharedMemoryHash(item.content) === hash)
  )
    throw new ConflictError(
      "This shared memory was forgotten. An old source cannot restore it.",
      "shared_memory.forgotten",
    );
}

/** Copy only a reviewed native body. Foreign source IDs are not laundered into the destination's source namespace. */
export async function writeSharedMemoryCopy(
  tx: Executor,
  _profile: SharedProfileRow,
  orgId: string,
  source: ContextItem,
  previous?: ContextItem,
): Promise<ContextItem> {
  const [row] = await tx
    .insert(contextItems)
    .values({
      orgId,
      kind: source.kind,
      scopeType: "org",
      scopeId: orgId,
      agentId: null,
      subjectKey: source.subjectKey,
      title: source.title,
      content: source.content,
      sourceIds: [],
      channelIds: [],
      trust: source.trust,
      verified: source.verified,
      evidence: source.evidence,
      confidence: source.confidence,
      pinned: source.pinned,
      createdByKind: source.createdByKind,
      createdById: source.createdById,
      validFrom: source.validFrom,
      validTo: source.validTo,
      sourceRevision: source.sourceRevision,
      version: previous ? previous.version + 1 : 1,
    })
    .returning();
  if (!row) throw new Error("Shared memory copy was not inserted");
  if (previous) {
    await tx
      .update(contextItems)
      .set({ status: "archived", supersededBy: row.id, supersededAt: new Date(), updatedAt: new Date() })
      .where(and(eq(contextItems.orgId, orgId), eq(contextItems.id, previous.id)));
    await enqueueIndex(tx, { orgId, kind: "context_item", sourceId: previous.id });
  }
  await enqueueIndex(tx, { orgId, kind: "context_item", sourceId: row.id });
  caches.contextPresence.delete(`${orgId}:`);
  return row;
}

const EXPLICIT_MEMORY =
  /(?:^|[.!:\n]\s*)(?:(?:please|also|and|now)\s+)*(?:remember\b|memorize\b|correction\b|correct my\b|save this\b|keep this\b|update my (?:memory|profile)\b)|\b(?:I (?:want|need) you to|make sure you) (?:remember|memorize)\b|(?:^|[，。；\n]\s*)(?:請|请|幫我|帮我|你要|請你|请你|麻煩你|麻烦你)?(?:記住|記低|記錄|更正|修正|改正|訂正|记住|记下|更改記憶)/i;
const AMBIGUOUS_MEMORY =
  /[?？]|\b(?:do not|don't|not to|never)\s+(?:remember|save|keep)\b|唔好記|不要記|别记|別記|忘記|\bforget\b/i;

async function ownerAssertion(tx: Executor, profile: SharedProfileRow, item: ContextItem, directOwner = false) {
  if (item.trust !== "high" || item.evidence.some((e) => e.type === "app")) return false;
  if (directOwner && item.createdByKind === "person" && item.createdById === profile.ownerUserId) return true;
  if (item.sourceIds.length === 0) return false;
  const source = await tx
    .select()
    .from(messages)
    .where(and(eq(messages.orgId, item.orgId), inArray(messages.id, item.sourceIds)));
  // A model's label or verified flag is insufficient. Every source must be a live message from this owner.
  const claim = item.content.replace(/^Logical key: [^\r\n]+\r?\n/, "").trim();
  return (
    Boolean(claim) &&
    source.length === item.sourceIds.length &&
    source.every(
      (m) =>
        !m.deletedAt &&
        m.authorType === "person" &&
        m.authorUserId === profile.ownerUserId &&
        !m.meta?.untrusted &&
        EXPLICIT_MEMORY.test(m.body) &&
        !AMBIGUOUS_MEMORY.test(m.body),
    ) &&
    source.some((m) => explicitMemoryPayload(m.body) === claim)
  );
}

/** Auto-accept only the complete top-level directive, never quoted examples or a fragment that drops qualifiers. */
function explicitMemoryPayload(body: string): string | null {
  const text = body.trim();
  if (/```|^>|\b(?:example|hypothetical|suppose|pretend|for illustration)\b|例如|假設|假设|舉例|举例/i.test(text))
    return null;
  const directive =
    /^(?:(?:please|also|now)\s+)*(?:remember|memorize|correction|correct my memory|save this|keep this|update my (?:memory|profile))\s*[:：,，-]?\s+([\s\S]+)$/i.exec(
      text,
    ) ??
    /^(?:請|请|幫我|帮我|你要|請你|请你|麻煩你|麻烦你)?(?:記住|記低|記錄|更正|修正|改正|訂正|记住|记下|更改記憶)\s*[:：,，-]?\s*([\s\S]+)$/.exec(
      text,
    );
  return directive?.[1]?.trim() || null;
}

/** Native person scope and explicit owner memory intent are bounded signals; a model's generic note is not. */
async function personalCaptureIntent(tx: Executor, profile: SharedProfileRow, item: ContextItem, directOwner = false) {
  if (item.scopeType === "person" && item.scopeId === profile.ownerUserId) return true;
  if (directOwner && item.createdByKind === "person" && item.createdById === profile.ownerUserId) return true;
  if (!item.sourceIds.length) return false;
  const source = await tx
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.orgId, item.orgId),
        inArray(messages.id, item.sourceIds),
        eq(messages.authorUserId, profile.ownerUserId),
      ),
    );
  return source.some(
    (m) =>
      !m.deletedAt &&
      m.authorType === "person" &&
      !m.meta?.untrusted &&
      EXPLICIT_MEMORY.test(m.body) &&
      !AMBIGUOUS_MEMORY.test(m.body),
  );
}

/** The native write transaction captures provenance. Ordinary notes stay candidates; exact echoes add no new fact. */
export async function trackSharedMemoryWrite(
  tx: Executor,
  item: ContextItem,
  options: { previous?: ContextItem; actorId?: string; directOwner?: boolean; forget?: boolean } = {},
) {
  const previousId = options.previous?.id ?? item.id;
  const [bound] = await tx.select().from(entries).where(eq(entries.itemId, previousId)).for("update");
  if (bound) {
    const [profile] = await tx.select().from(profiles).where(eq(profiles.id, bound.profileId));
    if (!profile) return;
    if (bound.status === "forgotten") throw new ConflictError("This memory was forgotten", "shared_memory.forgotten");
    if (options.forget) {
      if (options.actorId !== profile.ownerUserId)
        throw new ForbiddenError("Only the profile owner may forget this memory");
      await forgetSharedMemoryEntry(tx, profile, bound);
      return;
    }
    const changed = sharedMemoryHash(item.content) !== bound.contentHash;
    const owner =
      options.actorId === profile.ownerUserId || (await ownerAssertion(tx, profile, item, options.directOwner));
    if (bound.status === "active" && changed && !owner)
      throw new ConflictError("An inferred revision needs the owner's review", "shared_memory.review_required");
    await tx
      .update(entries)
      .set({
        itemId: item.id,
        itemOrgId: item.orgId,
        contentHash: sharedMemoryHash(item.content),
        version: bound.version + 1,
        historyIds: [...new Set([...bound.historyIds, previousId])].filter((id) => id !== item.id),
        status: item.status === "archived" && !item.supersededBy ? "rejected" : bound.status,
        assertion: changed && owner ? "owner_correction" : bound.assertion,
        ...((owner && changed) || bound.sourceItemId === previousId
          ? {
              sourceOrgId: item.orgId,
              sourceItemId: item.id,
              sourceIds: item.sourceIds,
            }
          : {}),
        validFrom: item.validFrom,
        validTo: item.validTo,
        sourceRevision: item.sourceRevision,
        updatedAt: new Date(),
      })
      .where(eq(entries.id, bound.id));
    await queueSharedMemory(tx, profile.id);
    return;
  }
  const [replica] = await tx.select().from(replicas).where(eq(replicas.itemId, previousId));
  // A person-scoped original can live beside an organization-wide canonical copy in the same workspace.
  const [origin] = replica
    ? []
    : await tx
        .select()
        .from(entries)
        .where(and(eq(entries.sourceItemId, previousId), ne(entries.itemId, previousId)))
        .for("update");
  if (origin) {
    const [profile] = await tx.select().from(profiles).where(eq(profiles.id, origin.profileId));
    if (!profile) return;
    if (origin.status === "forgotten") throw new ConflictError("This memory was forgotten", "shared_memory.forgotten");
    if (options.forget) {
      if (options.actorId !== profile.ownerUserId)
        throw new ForbiddenError("Only the profile owner may forget this memory");
      await forgetSharedMemoryEntry(tx, profile, origin, item.orgId === profile.orgId ? undefined : item.orgId);
      return;
    }
    const owner =
      (options.actorId === profile.ownerUserId && options.directOwner) || (await ownerAssertion(tx, profile, item));
    const baseline = options.previous ?? item;
    if (owner && sharedMemoryHash(baseline.content) === origin.contentHash && origin.itemId) {
      if (item.status === "archived" && !item.supersededBy) {
        await tx
          .update(entries)
          .set({ status: "rejected", version: origin.version + 1, updatedAt: new Date() })
          .where(eq(entries.id, origin.id));
      } else {
        const [canonical] = await tx
          .select()
          .from(contextItems)
          .where(and(eq(contextItems.orgId, profile.orgId), eq(contextItems.id, origin.itemId)))
          .for("update");
        if (!canonical || canonical.supersededBy || sharedMemoryHash(canonical.content) !== origin.contentHash)
          throw new ConflictError(
            "The canonical revision changed; review this correction",
            "shared_memory.version_conflict",
          );
        const header = /^Logical key: [^\r\n]+\r?\n/.exec(canonical.content)?.[0] ?? "";
        const next = await writeSharedMemoryCopy(
          tx,
          profile,
          profile.orgId,
          {
            ...item,
            title: canonical.title,
            content: `${header}${item.content.replace(/^Logical key: [^\r\n]+\r?\n/, "")}`,
          },
          canonical,
        );
        await tx
          .update(entries)
          .set({
            itemId: next.id,
            itemOrgId: profile.orgId,
            sourceItemId: item.id,
            sourceIds: item.sourceIds,
            sourceRevision: item.sourceRevision,
            contentHash: sharedMemoryHash(next.content),
            historyIds: [...new Set([...origin.historyIds, canonical.id, previousId])].filter((id) => id !== item.id),
            version: origin.version + 1,
            status: "active",
            assertion: "owner_correction",
            validFrom: item.validFrom,
            validTo: item.validTo,
            updatedAt: new Date(),
          })
          .where(eq(entries.id, origin.id));
      }
      await queueSharedMemory(tx, profile.id);
      return;
    }
    // A stale or inferred change to a retained source is captured for review below.
  }
  if (replica) {
    const [entry] = await tx.select().from(entries).where(eq(entries.id, replica.entryId));
    const [profile] = await tx.select().from(profiles).where(eq(profiles.id, replica.profileId));
    if (!entry || !profile) return;
    if (entry.status === "forgotten" || replica.state === "forgotten")
      throw new ConflictError("This memory was forgotten", "shared_memory.forgotten");
    if (options.forget) {
      if (options.actorId !== profile.ownerUserId)
        throw new ForbiddenError("Only the profile owner may forget this memory");
      await forgetSharedMemoryEntry(tx, profile, entry, item.orgId);
      return;
    }
    const explicitCorrection =
      (options.actorId === profile.ownerUserId && options.directOwner) || (await ownerAssertion(tx, profile, item));
    if (explicitCorrection && replica.appliedVersion === entry.version && entry.status === "active" && entry.itemId) {
      const [canonical] = await tx
        .select()
        .from(contextItems)
        .where(and(eq(contextItems.orgId, profile.orgId), eq(contextItems.id, entry.itemId)))
        .for("update");
      if (!canonical || canonical.supersededBy || sharedMemoryHash(canonical.content) !== entry.contentHash)
        throw new ConflictError(
          "The canonical revision changed; review this correction",
          "shared_memory.version_conflict",
        );
      const header = /^Logical key: [^\r\n]+\r?\n/.exec(canonical.content)?.[0] ?? "";
      const corrected = {
        ...item,
        title: canonical.title,
        content: `${header}${item.content.replace(/^Logical key: [^\r\n]+\r?\n/, "")}`,
      };
      const next = await writeSharedMemoryCopy(tx, profile, profile.orgId, corrected, canonical);
      await tx
        .update(entries)
        .set({
          itemId: next.id,
          itemOrgId: profile.orgId,
          historyIds: [...new Set([...entry.historyIds, canonical.id])],
          contentHash: sharedMemoryHash(next.content),
          version: entry.version + 1,
          assertion: "owner_correction",
          sourceOrgId: item.orgId,
          sourceItemId: item.id,
          sourceIds: item.sourceIds,
          sourceRevision: item.sourceRevision,
          updatedAt: new Date(),
        })
        .where(eq(entries.id, entry.id));
      await tx
        .update(replicas)
        .set({
          itemId: item.id,
          historyIds: [...new Set([...replica.historyIds, previousId])].filter((id) => id !== item.id),
          appliedHash: sharedMemoryHash(item.content),
          appliedVersion: entry.version + 1,
          state: "current",
          reason: null,
          checkedAt: new Date(),
        })
        .where(eq(replicas.id, replica.id));
      await queueSharedMemory(tx, profile.id);
      return;
    }
    await tx
      .update(replicas)
      .set({
        itemId: item.id,
        historyIds: [...new Set([...replica.historyIds, previousId])].filter((id) => id !== item.id),
        state: "conflict",
        reason: "This workspace changed its copy; review the contribution before replacing it.",
        checkedAt: new Date(),
      })
      .where(eq(replicas.id, replica.id));
    // An edit based on an older replica is a candidate, even when its author is the owner.
  }
  if (options.forget) return;
  for (const profile of await sharedProfilesInOrg(tx, item.orgId)) {
    if (!(await sharedMemorySoleOwner(tx, item.orgId, profile.ownerUserId))) continue;
    const hash = sharedMemoryHash(item.content);
    const existing = await tx
      .select({
        id: entries.id,
        hash: entries.contentHash,
        itemId: entries.itemId,
        historyIds: entries.historyIds,
        sourceIds: entries.sourceIds,
      })
      .from(entries)
      .where(eq(entries.profileId, profile.id));
    const historyIds = existing.flatMap((e) => e.historyIds);
    const history = historyIds.length
      ? await tx
          .select({ content: contextItems.content })
          .from(contextItems)
          .where(inArray(contextItems.id, historyIds))
      : [];
    const echo =
      existing.some((e) => e.hash === hash) ||
      history.some((row) => row.content && sharedMemoryHash(row.content) === hash);
    if (echo) {
      // Suppressing an echo must not leave its newly written native body unprotected after a member joins.
      const [captured] = await tx
        .insert(entries)
        .values({
          orgId: profile.orgId,
          profileId: profile.id,
          logicalKey: `echo.${item.id}`,
          itemId: item.id,
          itemOrgId: item.orgId,
          sourceOrgId: item.orgId,
          sourceItemId: item.id,
          sourceIds: item.sourceIds,
          originId: `native:${item.orgId}:${item.id}`,
          contentHash: hash,
          status: "rejected",
          assertion: "inference",
        })
        .onConflictDoNothing()
        .returning({ id: entries.id });
      await tx
        .update(contextItems)
        .set({ status: "archived", version: sql`${contextItems.version} + 1` })
        .where(eq(contextItems.id, item.id));
      await enqueueIndex(tx, { orgId: item.orgId, kind: "context_item", sourceId: item.id });
      if (captured) await queueSharedMemory(tx, profile.id);
      continue;
    }
    const sourceReplicas = item.sourceIds.length
      ? await tx
          .select({ id: replicas.id })
          .from(replicas)
          .where(and(eq(replicas.profileId, profile.id), inArray(replicas.itemId, item.sourceIds)))
          .limit(1)
      : [];
    const derived =
      sourceReplicas.length > 0 ||
      existing.some(
        (e) =>
          (e.itemId && item.sourceIds.includes(e.itemId)) ||
          e.historyIds.some((id) => item.sourceIds.includes(id)) ||
          e.sourceIds.some((id) => item.sourceIds.includes(id)),
      );
    // Unrelated operational learning keeps its native scope and availability; it is not a personal claim to review.
    if (!replica && !origin && !derived && !(await personalCaptureIntent(tx, profile, item, options.directOwner)))
      continue;
    const accepted = !replica && !origin && !derived && (await ownerAssertion(tx, profile, item, options.directOwner));
    let canonical = item;
    if (accepted && (item.orgId !== profile.orgId || item.scopeType !== "org" || item.agentId !== null))
      canonical = await writeSharedMemoryCopy(tx, profile, profile.orgId, item);
    const [captured] = await tx
      .insert(entries)
      .values({
        orgId: profile.orgId,
        profileId: profile.id,
        logicalKey: `native.${item.id}`,
        itemId: canonical.id,
        itemOrgId: canonical.orgId,
        sourceOrgId: item.orgId,
        sourceItemId: item.id,
        sourceIds: item.sourceIds,
        originId: `native:${item.orgId}:${item.id}`,
        contentHash: hash,
        status: accepted ? "active" : "candidate",
        assertion: accepted ? "owner_statement" : "inference",
        sourceRevision: item.sourceRevision,
        validFrom: item.validFrom,
        validTo: item.validTo,
      })
      .onConflictDoNothing()
      .returning();
    if (captured && accepted && item.orgId !== profile.orgId)
      await tx
        .insert(replicas)
        .values({
          orgId: item.orgId,
          profileId: profile.id,
          entryId: captured.id,
          itemId: item.id,
          appliedHash: hash,
          appliedVersion: captured.version,
          state: "current",
          checkedAt: new Date(),
        })
        .onConflictDoNothing();
    await queueSharedMemory(tx, profile.id);
  }
}

async function redactItems(tx: Executor, ids: string[]) {
  if (!ids.length) return;
  const rows = await tx
    .update(contextItems)
    .set({
      content: "",
      title: "",
      status: "archived",
      sourceIds: [],
      evidence: [],
      version: sql`${contextItems.version} + 1`,
      updatedAt: new Date(),
    })
    .where(inArray(contextItems.id, [...new Set(ids)]))
    .returning({ id: contextItems.id, orgId: contextItems.orgId });
  // Search is an immediately removed projection; do not leave old bodies readable until a queued index job runs.
  await tx
    .delete(schema.searchDocuments)
    .where(
      and(eq(schema.searchDocuments.kind, "context_item"), inArray(schema.searchDocuments.sourceId, [...new Set(ids)])),
    );
  for (const row of rows) {
    await enqueueIndex(tx, { orgId: row.orgId, kind: "context_item", sourceId: row.id });
    caches.contextPresence.delete(`${row.orgId}:`);
  }
}

export async function forgetSharedMemoryEntry(
  tx: Executor,
  profile: SharedProfileRow,
  entry: SharedEntryRow,
  destinationOrgId?: string,
  visited = new Set<string>(),
) {
  if (visited.has(entry.id)) return;
  visited.add(entry.id);
  const copies = await tx
    .select()
    .from(replicas)
    .where(and(eq(replicas.entryId, entry.id), destinationOrgId ? eq(replicas.orgId, destinationOrgId) : undefined));
  const ids = copies.flatMap((r) => [...r.historyIds, ...(r.itemId ? [r.itemId] : [])]);
  const retained = [
    ...entry.historyIds,
    ...(entry.itemId ? [entry.itemId] : []),
    ...(entry.sourceItemId ? [entry.sourceItemId] : []),
  ];
  if (!destinationOrgId) ids.push(...retained);
  else if (retained.length) {
    const local = await tx
      .select({ id: contextItems.id })
      .from(contextItems)
      .where(and(eq(contextItems.orgId, destinationOrgId), inArray(contextItems.id, retained)));
    ids.push(...local.map((row) => row.id));
  }
  const old = ids.length
    ? await tx.select({ content: contextItems.content }).from(contextItems).where(inArray(contextItems.id, ids))
    : [];
  const forgottenHashes = [
    ...new Set([
      entry.contentHash,
      ...entry.forgottenHashes,
      ...old.filter((r) => r.content).map((r) => sharedMemoryHash(r.content)),
    ]),
  ];
  const related = await tx
    .select()
    .from(entries)
    .where(
      and(
        eq(entries.profileId, profile.id),
        ne(entries.id, entry.id),
        or(
          inArray(entries.contentHash, forgottenHashes),
          ids.length ? historyMatches(entries.sourceIds, ids) : undefined,
        ),
      ),
    );
  await redactItems(tx, ids);
  if (destinationOrgId) {
    await tx
      .insert(replicas)
      .values({
        orgId: destinationOrgId,
        profileId: profile.id,
        entryId: entry.id,
        state: "forgotten",
        reason: "Forgotten in this workspace",
        checkedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [replicas.entryId, replicas.orgId],
        set: {
          state: "forgotten",
          appliedHash: null,
          reason: "Forgotten in this workspace",
          checkedAt: new Date(),
        },
      });
  } else {
    await tx
      .update(entries)
      .set({
        status: "forgotten",
        forgottenAt: new Date(),
        version: entry.version + 1,
        forgottenHashes,
        externalOutstanding: [...new Set(["source_archives", ...profile.consumers.map((c) => String(c.id))])],
        updatedAt: new Date(),
      })
      .where(eq(entries.id, entry.id));
    await tx
      .update(replicas)
      .set({ state: "forgotten", appliedHash: null, checkedAt: new Date() })
      .where(eq(replicas.entryId, entry.id));
  }
  for (const other of related)
    if (other.status !== "forgotten") await forgetSharedMemoryEntry(tx, profile, other, destinationOrgId, visited);
  await queueSharedMemory(tx, profile.id);
}

/** Runs within the membership transaction, before a new human is admitted. Historical bodies also stay owner-only. */
export async function suspendSharedMemoryInOrg(
  tx: Executor,
  orgId: string,
  reason = "Workspace membership changed",
  profileId?: string,
) {
  const affected = await tx
    .select({ profile: profiles })
    .from(destinations)
    .innerJoin(profiles, eq(destinations.profileId, profiles.id))
    .where(and(eq(destinations.orgId, orgId), profileId ? eq(destinations.profileId, profileId) : undefined));
  for (const { profile } of affected) {
    const all = profile.orgId === orgId;
    await tx
      .update(destinations)
      .set({ state: "blocked", reason })
      .where(and(eq(destinations.profileId, profile.id), all ? undefined : eq(destinations.orgId, orgId)));
    const copies = await tx
      .update(replicas)
      .set({ state: "blocked", reason, checkedAt: new Date() })
      .where(
        and(
          eq(replicas.profileId, profile.id),
          ne(replicas.state, "forgotten"),
          all ? undefined : eq(replicas.orgId, orgId),
        ),
      )
      .returning({ itemId: replicas.itemId, orgId: replicas.orgId });
    const own = await tx
      .select({
        itemId: entries.itemId,
        orgId: entries.itemOrgId,
        sourceItemId: entries.sourceItemId,
        sourceOrgId: entries.sourceOrgId,
      })
      .from(entries)
      .where(
        and(
          eq(entries.profileId, profile.id),
          all ? undefined : or(eq(entries.itemOrgId, orgId), eq(entries.sourceOrgId, orgId)),
        ),
      );
    const bodies = [
      ...copies,
      ...own.filter((row) => all || row.orgId === orgId),
      ...own
        .filter((row) => row.sourceItemId && (all || row.sourceOrgId === orgId))
        .map((row) => ({ itemId: row.sourceItemId, orgId: row.sourceOrgId })),
    ];
    for (const row of new Map(bodies.map((body) => [body.itemId, body])).values())
      if (row.itemId) {
        await tx
          .update(contextItems)
          .set({ status: "archived", version: sql`${contextItems.version} + 1`, updatedAt: new Date() })
          .where(
            and(eq(contextItems.orgId, row.orgId), eq(contextItems.id, row.itemId), eq(contextItems.status, "active")),
          );
        await enqueueIndex(tx, { orgId: row.orgId, kind: "context_item", sourceId: row.itemId });
        caches.contextPresence.deletePrefix(`${row.orgId}:`);
      }
    await queueSharedMemory(tx, profile.id);
  }
}

/** Before native account/tenant cascades remove the bindings, erase bodies retained in other enrolled tenants. */
export async function forgetSharedMemoryOwner(tx: Executor, ownerUserId: string) {
  for (const profile of await tx.select().from(profiles).where(eq(profiles.ownerUserId, ownerUserId)))
    for (const entry of await tx
      .select()
      .from(entries)
      .where(and(eq(entries.profileId, profile.id), ne(entries.status, "forgotten"))))
      await forgetSharedMemoryEntry(tx, profile, entry);
}

export async function forgetSharedMemoryCanonicalOrg(tx: Executor, orgId: string) {
  for (const profile of await tx.select().from(profiles).where(eq(profiles.orgId, orgId)))
    for (const entry of await tx
      .select()
      .from(entries)
      .where(and(eq(entries.profileId, profile.id), ne(entries.status, "forgotten"))))
      await forgetSharedMemoryEntry(tx, profile, entry);
}

const historyMatches = (
  column: typeof entries.historyIds | typeof entries.sourceIds | typeof replicas.historyIds,
  ids: string[],
) =>
  sql`${column} ?| array[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )}]::text[]`;

/** Complete live read fence for exports, receipts and verification. No content or authorization is cached here. */
export async function sharedMemoryAvailability(db: Executor, profile: SharedProfileRow) {
  const bindings = await db.select().from(entries).where(eq(entries.profileId, profile.id));
  const ids = [
    ...new Set(
      bindings.flatMap((e) => [...e.historyIds, e.itemId, e.sourceItemId].filter((id): id is string => Boolean(id))),
    ),
  ];
  const rows = ids.length ? await db.select().from(contextItems).where(inArray(contextItems.id, ids)) : [];
  const native = new Map(rows.map((row) => [row.id, row]));
  const copies = await db.select().from(replicas).where(eq(replicas.profileId, profile.id));
  const { memorySourceProvenanceForUser } = await import("./context/memory-visibility");
  const { userVisibleChannels } = await import("./search");
  const readableItems = new Set<string>();
  const readableOrigins = new Set<string>();
  const channels = new Map<string, string[]>();
  for (const orgId of [...new Set(rows.map((row) => row.orgId))]) {
    try {
      const visible = await userVisibleChannels(db as Database, orgId, profile.ownerUserId);
      channels.set(orgId, visible);
      const group = rows.filter((row) => row.orgId === orgId);
      const managed = await sharedMemoryVisibleIds(
        db,
        orgId,
        group.map((item) => item.id),
        profile.ownerUserId,
        { provenanceOnly: true },
      );
      for (const id of await memorySourceProvenanceForUser(
        db as Database,
        orgId,
        profile.ownerUserId,
        visible,
        group.filter((item) => managed.has(item.id)),
      ))
        readableItems.add(id);
    } catch (error) {
      if (!(error instanceof ForbiddenError)) throw error;
    }
  }
  for (const entry of bindings) {
    if (!entry.sourceItemId || entry.sourceItemId === entry.itemId) {
      readableOrigins.add(entry.id);
      continue;
    }
    const source = native.get(entry.sourceItemId);
    if (!source || source.orgId !== entry.sourceOrgId) continue;
    if (source.status === "active" && !source.supersededBy && readableItems.has(source.id)) {
      readableOrigins.add(entry.id);
      continue;
    }
    const promotedHere =
      readableItems.has(source.id) &&
      sharedMemoryHash(source.content) === entry.contentHash &&
      ((source.orgId === profile.orgId &&
        source.supersededBy === entry.itemId &&
        entry.historyIds.includes(source.id)) ||
        copies.some(
          (copy) =>
            copy.entryId === entry.id &&
            copy.orgId === source.orgId &&
            copy.itemId === source.supersededBy &&
            copy.historyIds.includes(source.id) &&
            copy.state === "current",
        ));
    if (promotedHere) {
      readableOrigins.add(entry.id);
      continue;
    }
    // Only an explicit scoped tombstone retains the accepted canonical fact after its origin body is erased.
    const forgottenHere = copies.some(
      (copy) =>
        copy.entryId === entry.id &&
        copy.orgId === source.orgId &&
        copy.state === "forgotten" &&
        (copy.itemId === source.id || copy.historyIds.includes(source.id)),
    );
    if (!forgottenHere || source.content !== "" || !channels.has(source.orgId)) continue;
    try {
      const proof = { ...source, sourceIds: entry.sourceIds };
      const valid = await memorySourceProvenanceForUser(
        db as Database,
        source.orgId,
        profile.ownerUserId,
        channels.get(source.orgId) ?? [],
        [proof],
      );
      if (valid.has(source.id)) readableOrigins.add(entry.id);
    } catch (error) {
      if (!(error instanceof ForbiddenError)) throw error;
    }
  }
  const readable = new Set<string>();
  const reasons = new Map<string, string>();
  for (const entry of bindings) {
    const item = entry.itemId ? native.get(entry.itemId) : undefined;
    const reason =
      entry.status === "forgotten"
        ? "This memory was forgotten."
        : !item || item.orgId !== entry.itemOrgId
          ? "The native memory body is unavailable."
          : sharedMemoryHash(item.content) !== entry.contentHash
            ? "The native revision changed and needs review."
            : entry.status === "active" && (item.status !== "active" || item.supersededBy)
              ? "The canonical memory is suspended or superseded."
              : !readableItems.has(item.id) || !readableOrigins.has(entry.id)
                ? "A native source is unavailable or no longer readable."
                : null;
    if (reason) reasons.set(entry.id, reason);
    else readable.add(entry.id);
  }
  // A clone's empty native source list cannot make a withdrawn managed parent into independent evidence.
  const byNative = new Map<string, Set<string>>();
  for (const entry of bindings)
    for (const id of [entry.itemId, entry.sourceItemId, ...entry.historyIds])
      if (id) {
        const owners = byNative.get(id) ?? new Set<string>();
        owners.add(entry.id);
        byNative.set(id, owners);
      }
  for (let changed = true; changed; ) {
    changed = false;
    for (const entry of bindings)
      if (
        readable.has(entry.id) &&
        entry.sourceIds.some((id) =>
          [...(byNative.get(id) ?? [])].some((parent) => parent !== entry.id && !readable.has(parent)),
        )
      ) {
        readable.delete(entry.id);
        reasons.set(entry.id, "A managed source is unavailable or no longer readable.");
        changed = true;
      }
  }
  const revision = createHash("sha256")
    .update(
      JSON.stringify({
        profile: profile.id,
        version: profile.version,
        entries: [...bindings]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((e) => [
            e.id,
            e.version,
            e.status,
            e.itemId,
            readable.has(e.id),
            reasons.get(e.id) ?? null,
            e.historyIds.slice().sort(),
          ]),
        native: [...rows]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((item) => [
            item.id,
            item.version,
            item.status,
            item.supersededBy,
            sharedMemoryHash(item.content),
            readableItems.has(item.id),
          ]),
      }),
    )
    .digest("hex");
  return { bindings, native, readable, readableItems, reasons, revision };
}

/** Only explicit re-enrollment restores unchanged current bodies and retained origins in that destination. */
export async function restoreSharedMemoryEnrollment(tx: Executor, profile: SharedProfileRow, orgId: string) {
  if (
    !(await sharedMemorySoleOwner(tx, profile.orgId, profile.ownerUserId)) ||
    !(await sharedMemorySoleOwner(tx, orgId, profile.ownerUserId))
  )
    throw new ForbiddenError("The enrolled workspaces must have the same sole human owner");
  const current = await tx
    .select()
    .from(entries)
    .where(and(eq(entries.profileId, profile.id), eq(entries.status, "active")));
  const forgotten = new Set(
    (
      await tx
        .select({ entryId: replicas.entryId })
        .from(replicas)
        .where(and(eq(replicas.profileId, profile.id), eq(replicas.orgId, orgId), eq(replicas.state, "forgotten")))
    ).map((copy) => copy.entryId),
  );
  for (const entry of current) {
    if (forgotten.has(entry.id)) continue;
    const ids = [
      ...new Set([
        ...(orgId === profile.orgId && entry.itemOrgId === orgId && entry.itemId ? [entry.itemId] : []),
        ...(entry.sourceOrgId === orgId && entry.sourceItemId ? [entry.sourceItemId] : []),
      ]),
    ];
    if (!ids.length) continue;
    const items = await tx
      .select()
      .from(contextItems)
      .where(and(eq(contextItems.orgId, orgId), inArray(contextItems.id, ids)))
      .for("update");
    for (const item of items) {
      if (
        item.status !== "archived" ||
        item.supersededBy ||
        (item.id === entry.itemId && (item.agentId !== null || item.scopeType !== "org")) ||
        sharedMemoryHash(item.content) !== entry.contentHash
      )
        continue;
      await tx
        .update(contextItems)
        .set({ status: "active", version: sql`${contextItems.version} + 1`, updatedAt: new Date() })
        .where(eq(contextItems.id, item.id));
      await enqueueIndex(tx, { orgId, kind: "context_item", sourceId: item.id });
    }
  }
  caches.contextPresence.deletePrefix(`${orgId}:`);
}

/** Additional privacy on managed data; a review_memory role never becomes this profile owner's identity. */
export async function sharedMemoryVisibleIds(
  db: Executor,
  orgId: string,
  ids: string[],
  userId?: string,
  options: { agent?: boolean; provenanceOnly?: boolean } = {},
) {
  if (!ids.length) return new Set<string>();
  const primary = await db
    .select({ entry: entries, profile: profiles })
    .from(entries)
    .innerJoin(profiles, eq(profiles.id, entries.profileId))
    .where(
      or(inArray(entries.itemId, ids), historyMatches(entries.historyIds, ids), inArray(entries.sourceItemId, ids)),
    );
  const copied = await db
    .select({ copy: replicas, entry: entries, profile: profiles })
    .from(replicas)
    .innerJoin(entries, eq(entries.id, replicas.entryId))
    .innerJoin(profiles, eq(profiles.id, replicas.profileId))
    .where(and(eq(replicas.orgId, orgId), or(inArray(replicas.itemId, ids), historyMatches(replicas.historyIds, ids))));
  const allowed = new Set(ids);
  const safe = new Map<string, boolean>();
  const sensitivities = new Map<string, string[]>();
  for (const { profile } of [...primary, ...copied])
    if (options.agent && !safe.has(profile.id)) {
      const [destination] = await db
        .select()
        .from(destinations)
        .where(and(eq(destinations.profileId, profile.id), eq(destinations.orgId, orgId)));
      sensitivities.set(profile.id, destination?.allowedSensitivity ?? []);
      safe.set(
        profile.id,
        Boolean(
          sharedMemoryDestinationActive(destination) &&
            (await sharedMemorySoleOwner(db, orgId, profile.ownerUserId)) &&
            (await sharedMemorySoleOwner(db, profile.orgId, profile.ownerUserId)),
        ),
      );
    }
  const current = new Map<string, boolean>();
  if (!options.provenanceOnly) {
    const bindings = [...new Map([...primary, ...copied].map((row) => [row.entry.id, row])).values()];
    for (const profile of new Map(bindings.map((row) => [row.profile.id, row.profile])).values()) {
      const selected = bindings.filter((row) => row.profile.id === profile.id).map((row) => row.entry);
      const availability = await sharedMemoryAvailability(db, profile);
      for (const entry of selected) current.set(entry.id, availability.readable.has(entry.id));
    }
  }
  for (const { entry, profile } of primary) {
    const relevant = [
      ...entry.historyIds,
      ...(entry.itemId ? [entry.itemId] : []),
      ...(entry.sourceItemId ? [entry.sourceItemId] : []),
    ];
    const canRead = options.agent
      ? safe.get(profile.id) &&
        (options.provenanceOnly || current.get(entry.id)) &&
        entry.status === "active" &&
        sensitivities.get(profile.id)?.includes(entry.sensitivity)
      : userId === profile.ownerUserId && (options.provenanceOnly || current.get(entry.id));
    if (!canRead || entry.status === "forgotten") for (const id of relevant) allowed.delete(id);
    if (options.agent) for (const id of entry.historyIds) if (id !== entry.itemId) allowed.delete(id);
  }
  for (const { copy, entry, profile } of copied) {
    const canRead = options.agent
      ? safe.get(profile.id) &&
        (options.provenanceOnly || current.get(entry.id)) &&
        entry.status === "active" &&
        copy.state === "current" &&
        sensitivities.get(profile.id)?.includes(entry.sensitivity) &&
        copy.appliedVersion === entry.version
      : userId === profile.ownerUserId && (options.provenanceOnly || current.get(entry.id));
    if (!canRead || entry.status === "forgotten" || copy.state === "forgotten")
      for (const id of [...copy.historyIds, ...(copy.itemId ? [copy.itemId] : [])]) allowed.delete(id);
    if (options.agent) for (const id of copy.historyIds) if (id !== copy.itemId) allowed.delete(id);
  }
  return allowed;
}

/** One repair job per profile per day, using the existing durable queue and worker tick. */
export async function enqueueSharedMemoryRepair(db: Executor, now = new Date()) {
  const rows = await db.select({ id: profiles.id, orgId: profiles.orgId }).from(profiles).orderBy(asc(profiles.id));
  for (const row of rows)
    await enqueue(db, {
      orgId: row.orgId,
      kind: SHARED_MEMORY_JOB,
      payload: { profileId: row.id },
      dedupeKey: `${SHARED_MEMORY_JOB}:repair:${row.id}:${now.toISOString().slice(0, 10)}`,
    });
  return rows.length;
}
