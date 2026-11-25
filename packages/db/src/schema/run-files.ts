import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, index, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
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
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.runId, t.path),
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
    reportId: uuid()
      .notNull()
      .references(() => retentionReports.id, { onDelete: "cascade" }),
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
  ],
);
