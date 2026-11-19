import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, index, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents";
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
    /** Workspace-relative path on the computer, as the agent wrote it. */
    path: text().notNull(),
    /** `image`, `video`, `html`, `markdown`, `log`, `build` or `other`. */
    kind: text().notNull(),
    /** `canonical` (the deliverable), `evidence` (proof a check passed), `scratch`, `derived` (rebuildable) or `unknown`. */
    role: text().notNull(),
    size: bigint({ mode: "number" }),
    sha256: text(),
    note: text(),
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
