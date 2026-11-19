import { boolean, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth";
import { organizations } from "./tenancy";

/** An owner's enrollment and receipts. The only store of memory bodies remains context_items. */
export const sharedMemoryProfiles = pgTable("shared_memory_profiles", {
  id: uuid().primaryKey().defaultRandom(),
  orgId: uuid()
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  ownerUserId: text()
    .notNull()
    .references(() => users.id, { onDelete: "cascade" })
    .unique(),
  name: text().notNull(),
  version: integer().notNull().default(1),
  consumers: jsonb().$type<Record<string, unknown>[]>().notNull().default([]),
  verification: jsonb().$type<Record<string, unknown>>(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/** Explicit destinations; membership is checked again at use and under the native membership lock at writes. */
export const sharedMemoryDestinations = pgTable(
  "shared_memory_destinations",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    profileId: uuid()
      .notNull()
      .references(() => sharedMemoryProfiles.id, { onDelete: "cascade" }),
    enabled: boolean().notNull().default(true),
    allowedSensitivity: jsonb().$type<string[]>().notNull().default(["personal", "workspace", "sensitive"]),
    state: text().notNull().default("active"),
    reason: text(),
    lastSyncedAt: timestamp({ withTimezone: true }),
  },
  (t) => [unique().on(t.profileId, t.orgId), index().on(t.orgId)],
);

/** Stable identities, provenance and forget fences, never a second copy of content. IDs survive native supersession. */
export const sharedMemoryEntries = pgTable(
  "shared_memory_entries",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    profileId: uuid()
      .notNull()
      .references(() => sharedMemoryProfiles.id, { onDelete: "cascade" }),
    logicalKey: text().notNull(),
    itemId: uuid(),
    itemOrgId: uuid().notNull(),
    sourceOrgId: uuid().notNull(),
    sourceItemId: uuid(),
    sourceId: uuid(),
    sourceIds: jsonb().$type<string[]>().notNull().default([]),
    historyIds: jsonb().$type<string[]>().notNull().default([]),
    originId: text().notNull(),
    sourceRevision: text(),
    contentHash: text().notNull(),
    forgottenHashes: jsonb().$type<string[]>().notNull().default([]),
    status: text().notNull().default("candidate"),
    sensitivity: text().notNull().default("personal"),
    assertion: text().notNull().default("inference"),
    version: integer().notNull().default(1),
    observedAt: timestamp({ withTimezone: true }),
    validFrom: timestamp({ withTimezone: true }),
    validTo: timestamp({ withTimezone: true }),
    forgottenAt: timestamp({ withTimezone: true }),
    externalOutstanding: jsonb().$type<string[]>().notNull().default([]),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.profileId, t.logicalKey),
    unique().on(t.profileId, t.originId),
    index().on(t.itemId),
    index().on(t.orgId),
  ],
);

/** Metadata-only replica baselines and per-destination tombstones. */
export const sharedMemoryReplicas = pgTable(
  "shared_memory_replicas",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    profileId: uuid()
      .notNull()
      .references(() => sharedMemoryProfiles.id, { onDelete: "cascade" }),
    entryId: uuid()
      .notNull()
      .references(() => sharedMemoryEntries.id, { onDelete: "cascade" }),
    itemId: uuid(),
    historyIds: jsonb().$type<string[]>().notNull().default([]),
    appliedHash: text(),
    appliedVersion: integer(),
    state: text().notNull().default("pending"),
    reason: text(),
    checkedAt: timestamp({ withTimezone: true }),
  },
  (t) => [unique().on(t.entryId, t.orgId), index().on(t.itemId), index().on(t.orgId)],
);

/** A capture is a source snapshot, never evidence that a consumer's native memory is continuously connected. */
export const sharedMemorySources = pgTable(
  "shared_memory_sources",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    profileId: uuid()
      .notNull()
      .references(() => sharedMemoryProfiles.id, { onDelete: "cascade" }),
    originId: text().notNull(),
    metadata: jsonb().$type<Record<string, unknown>>().notNull(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.profileId, t.originId), index().on(t.orgId)],
);
