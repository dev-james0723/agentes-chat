import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents";
import { approvals } from "./runtime";
import { storageConfigs } from "./storage";
import { organizations } from "./tenancy";
import { issues } from "./work";

/** Metadata around native tasks, storage, approvals and ToolSource; never another skill registry. */
export const foundryCandidates = pgTable(
  "foundry_candidates",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    taskId: uuid()
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    agentId: uuid()
      .notNull()
      .references(() => agents.id),
    personId: text().notNull(),
    originRunId: uuid().notNull(),
    needKey: text().notNull(),
    needFingerprint: text().notNull(),
    contextRevision: text().notNull(),
    state: text().notNull().default("DRAFT"),
    revision: integer().notNull().default(0),
    reasonCode: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.orgId, t.taskId, t.needFingerprint, t.contextRevision), index().on(t.orgId, t.taskId)],
);

/** Frozen executable bytes are private native blobs. This row only holds their immutable identity. */
export const foundryVersions = pgTable(
  "foundry_versions",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    candidateId: uuid()
      .notNull()
      .references(() => foundryCandidates.id, { onDelete: "cascade" }),
    digest: text().notNull(),
    contractDigest: text().notNull(),
    effectsDigest: text().notNull(),
    storageConfigId: uuid().references(() => storageConfigs.id),
    blobKey: text().notNull(),
    blobBytes: integer().notNull(),
    state: text().notNull().default("DRAFT"),
    evaluationRef: text(),
    /** A bounded native outbox evaluation and its parent checkpoint; never a second task queue. */
    evaluationJob: jsonb().$type<Record<string, unknown>>(),
    runtimeDigest: text(),
    profileDigest: text(),
    /** Skills repository copy (SF-19): null until ACTIVE, then PENDING, UNKNOWN, SYNCED, REFUSED or FAILED. */
    syncState: text(),
    syncCommit: text(),
    syncReason: text(),
    /** When the creating agent told the approver; set once, with the report message, in one transaction. */
    syncReportedAt: timestamp({ withTimezone: true }),
    retiredAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.orgId, t.candidateId, t.digest), index().on(t.orgId, t.candidateId)],
);

/** One exact native approval consumes into one task-scoped binding. Superseded bindings remain rollback evidence. */
export const foundryBindings = pgTable(
  "foundry_bindings",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    candidateId: uuid()
      .notNull()
      .references(() => foundryCandidates.id),
    versionId: uuid()
      .notNull()
      .references(() => foundryVersions.id),
    taskId: uuid()
      .notNull()
      .references(() => issues.id),
    agentId: uuid()
      .notNull()
      .references(() => agents.id),
    personId: text().notNull(),
    approvalId: uuid()
      .notNull()
      .references(() => approvals.id),
    approvalHash: text().notNull(),
    previousBindingId: uuid(),
    state: text().notNull().default("CANARY"),
    generation: integer().notNull().default(0),
    maxCalls: integer().notNull(),
    reservedCalls: integer().notNull().default(0),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    revokedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.orgId, t.approvalId),
    uniqueIndex("foundry_bindings_current")
      .on(t.orgId, t.candidateId, t.taskId, t.agentId)
      .where(sql`${t.state} in ('CANARY', 'ACTIVE')`),
    index().on(t.orgId, t.taskId, t.agentId),
  ],
);

/** Durable reservation and outcome. Raw inputs/outputs and private fixture data never enter this ledger. */
export const foundryInvocations = pgTable(
  "foundry_invocations",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    bindingId: uuid()
      .notNull()
      .references(() => foundryBindings.id),
    runId: uuid().notNull(),
    toolUseId: text().notNull(),
    digest: text().notNull(),
    inputDigest: text().notNull(),
    state: text().notNull().default("RESERVED"),
    fencingToken: integer().notNull(),
    recoveryRevision: integer().notNull().default(0),
    bindingGeneration: integer().notNull(),
    leaseUntil: timestamp({ withTimezone: true }).notNull(),
    resultDigest: text(),
    reasonCode: text(),
    receipt: jsonb().$type<Record<string, unknown>>(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp({ withTimezone: true }),
  },
  (t) => [unique().on(t.orgId, t.runId, t.toolUseId), index().on(t.orgId, t.bindingId, t.state)],
);
