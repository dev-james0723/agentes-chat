import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents";
import { machines } from "./machines";
import { agentRuns } from "./runtime";
import { organizations } from "./tenancy";

/**
 * Files an agent says it made on its computer during a run (`register_files`, ADR 0197): where each
 * one is, what kind it is and what it is for. Drive files need no row here: their versions already
 * carry the run, size and hash. A file nobody registered is never a cleanup candidate.
 */
export const runFiles = pgTable(
  "run_files",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    agentId: uuid().notNull(),
    runId: uuid()
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    /** The computer the run worked on (ADR 0201). Rows from before it have none and are never cleaned. */
    machineId: uuid().references(() => machines.id, { onDelete: "set null" }),
    /** Workspace-relative path on the computer, as the agent wrote it. */
    path: text().notNull(),
    /** `image`, `video`, `html`, `markdown`, `log`, `build` or `other`. */
    kind: text().notNull(),
    /** `canonical` (the deliverable), `evidence` (proof a check passed), `scratch`, `derived` (rebuildable) or `unknown`. */
    role: text().notNull(),
    size: bigint({ mode: "number" }),
    sha256: text(),
    note: text(),
    /** The tool that saved it (ADR 0201: `browser_screenshot`, …), null for what the agent registered itself. Kept when the agent registers it again: it counts toward the run's capture budget. */
    capturedBy: text(),
    /**
     * Where the file is in its life (ADR 0214): `created`, `writing`, `sealed` (its writer closed it), `released`
     * (sealed and no reader or later stage holds it), `reserved` (one collector holds it for removal), `deleted`,
     * `review` (a person decides), `protected`, `kept`, `archived`, `relocated`, `failed` or `unknown`.
     */
    state: text().notNull().default("created"),
    /** Bumped on every change of state: a change names the version it saw, so two writers never both win. */
    version: integer().notNull().default(0),
    /** When its writer said it is complete (`file_lifecycle` seal); the collector's `notAfter`. */
    sealedAt: timestamp({ withTimezone: true }),
    /** The collector's claim while it removes the file; a claim left behind is checked again, never assumed. */
    reservedToken: text(),
    reservedAt: timestamp({ withTimezone: true }),
    /** When the collector last looked at it: each cycle starts with the files it looked at least recently. */
    gcCheckedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.runId, t.path),
    index().on(t.orgId, t.machineId, t.state),
    check(
      "run_files_state",
      sql`${t.state} in ('created', 'writing', 'sealed', 'released', 'reserved', 'deleted', 'review', 'protected', 'kept', 'archived', 'relocated', 'failed', 'unknown')`,
    ),
    index().on(t.orgId, t.agentId),
    foreignKey({ columns: [t.orgId, t.agentId], foreignColumns: [agents.orgId, agents.id] }).onDelete("cascade"),
    check("run_files_kind", sql`${t.kind} in ('image', 'video', 'html', 'markdown', 'log', 'build', 'other')`),
    check("run_files_role", sql`${t.role} in ('canonical', 'evidence', 'scratch', 'derived', 'unknown')`),
    check("run_files_sha256", sql`${t.sha256} is null or ${t.sha256} ~ '^[a-f0-9]{64}$'`),
  ],
);

/**
 * What could be kept or cleaned once a task or a mission ended (ADR 0197): a dry run, never a deletion.
 * One row per task or mission, rewritten each time it ends again.
 */
export const retentionReports = pgTable(
  "retention_reports",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** `issue` or `mission`. */
    subjectType: text().notNull(),
    subjectId: uuid().notNull(),
    /** How it ended: `done` or `canceled`. */
    outcome: text().notNull(),
    report: jsonb().$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.orgId, t.subjectType, t.subjectId),
    check("retention_reports_subject", sql`${t.subjectType} in ('issue', 'mission')`),
    check("retention_reports_outcome", sql`${t.outcome} in ('done', 'canceled')`),
  ],
);

/**
 * One file a person approved for cleanup out of a retention report, and what happened to it (ADR 0201): the
 * approval names the exact file, the job checks it again on the computer before it removes anything, and the row
 * keeps the receipt (the file's identity, the outcome and its reason, free space before and after). A file is
 * approved at most once: approving it again changes nothing.
 */
export const fileCleanups = pgTable(
  "file_cleanups",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** The report it was approved from; none for a cleanup an authorized scope or a review decided (ADR 0214). */
    reportId: uuid().references(() => retentionReports.id, { onDelete: "cascade" }),
    /** `approved` (a person, from a report), `auto` (an authorized scope, ADR 0214) or `review` (a person, from the review queue). */
    source: text().notNull().default("approved"),
    /** `shadow`: what would have been removed, nothing sent to the computer (ADR 0214). */
    shadow: boolean().notNull().default(false),
    /** The run that registered it: the approval is for that registration, not for whatever has that path later. */
    runId: uuid().notNull(),
    /** The registration it came from; kept as a receipt when the row goes (the path and computer stay here). */
    runFileId: uuid().references(() => runFiles.id, { onDelete: "set null" }),
    agentId: uuid().notNull(),
    machineId: uuid(),
    path: text().notNull(),
    /** `approved` (waiting), `running` (claimed by a job), `done`, `skipped` (already gone), `blocked` (a check refused) or `unknown`. */
    status: text().notNull().default("approved"),
    /** Why it was blocked or skipped, in words. */
    reason: text(),
    /** What the computer saw: device, inode, size, mtime, sha256 when known. */
    identity: jsonb().$type<Record<string, unknown>>(),
    bytes: bigint({ mode: "number" }),
    freeBefore: bigint({ mode: "number" }),
    freeAfter: bigint({ mode: "number" }),
    approvedByUserId: text().notNull(),
    approvedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    executedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    unique().on(t.reportId, t.runId, t.path),
    index().on(t.orgId, t.status),
    check("file_cleanups_status", sql`${t.status} in ('approved', 'running', 'done', 'skipped', 'blocked', 'unknown')`),
    check("file_cleanups_source", sql`${t.source} in ('approved', 'auto', 'review')`),
  ],
);

/**
 * Who uses a registered file now and who will later (ADR 0214): a writer (`write`), a reader (`read`) or a later
 * stage of the work that declared it needs it (`future`). A file with any open lease is never removed. A lease whose
 * heartbeat stopped is `expired`: that proves nothing about the file, which goes to review, never to removal.
 */
export const artifactLeases = pgTable(
  "artifact_leases",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    runFileId: uuid()
      .notNull()
      .references(() => runFiles.id, { onDelete: "cascade" }),
    holderAgentId: uuid().notNull(),
    holderRunId: uuid(),
    /** `write`, `read` or `future`. */
    kind: text().notNull(),
    /** The later stage that needs it, in the holder's words. */
    stage: text(),
    /** The file's version when the lease was taken. */
    generation: integer().notNull(),
    /** `open`, `released` or `expired`. */
    status: text().notNull().default("open"),
    heartbeatAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    releasedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index().on(t.runFileId, t.status),
    index().on(t.orgId, t.status, t.expiresAt),
    check("artifact_leases_kind", sql`${t.kind} in ('write', 'read', 'future')`),
    check("artifact_leases_status", sql`${t.status} in ('open', 'released', 'expired')`),
  ],
);

/** Every change of a file's state, append only (ADR 0214): from, to, the version it made, who and why. */
export const artifactTransitions = pgTable(
  "artifact_transitions",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    runFileId: uuid()
      .notNull()
      .references(() => runFiles.id, { onDelete: "cascade" }),
    fromState: text().notNull(),
    toState: text().notNull(),
    version: integer().notNull(),
    /** `agent:<id>`, `person:<id>` or `collector`. */
    actor: text().notNull(),
    /** The decision code (`in_use_reader`, `disposable_verified`, …) or the person's action. */
    code: text().notNull(),
    detail: jsonb().$type<Record<string, unknown>>(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.runFileId, t.version), index().on(t.orgId, t.createdAt)],
);

/**
 * Where a person allowed scratch to be removed while work goes on, without approving each file (ADR 0214): one
 * computer, one folder (relative to the agents' workspace), and whether the collector only reports (`shadow`) or
 * removes (`enforce`). Only `scratch` and `derived` files inside it, sealed and released, are ever removed.
 */
export const storageScopes = pgTable(
  "storage_scopes",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    machineId: uuid()
      .notNull()
      .references(() => machines.id, { onDelete: "cascade" }),
    /** A relative folder prefix ending in `/` (`scratch/`). */
    root: text().notNull(),
    /** `shadow` or `enforce`. */
    mode: text().notNull().default("shadow"),
    createdByUserId: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.orgId, t.machineId, t.root),
    check("storage_scopes_mode", sql`${t.mode} in ('shadow', 'enforce')`),
  ],
);

/** A workspace's switch for continuous cleanup (ADR 0214): `enabled` false stops every removal at once. */
export const storageGcSettings = pgTable("storage_gc_settings", {
  orgId: uuid()
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  enabled: boolean().notNull().default(true),
  /** A person may hold the collector back while agents need the computer (`performance`), else `auto`. */
  modeOverride: text(),
  updatedByUserId: text(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/**
 * A file the collector would not decide alone (ADR 0214), and what a person decided: `open`, `kept`, `protected`,
 * `archive` (asked for), `delete` (approved for removal, checked again on the computer), `restored` (a decision
 * undone). Every decision is kept in `history`.
 */
export const storageReviewItems = pgTable(
  "storage_review_items",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    runFileId: uuid()
      .notNull()
      .references(() => runFiles.id, { onDelete: "cascade" }),
    code: text().notNull(),
    reason: text().notNull(),
    status: text().notNull().default("open"),
    decidedByUserId: text(),
    decidedAt: timestamp({ withTimezone: true }),
    history: jsonb().$type<{ at: string; by: string; action: string }[]>().notNull().default([]),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.runFileId),
    index().on(t.orgId, t.status),
    check(
      "storage_review_items_status",
      sql`${t.status} in ('open', 'kept', 'protected', 'archive', 'delete', 'restored')`,
    ),
  ],
);
