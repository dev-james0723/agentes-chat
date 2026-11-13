import { boolean, index, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth";
import { organizations } from "./tenancy";
import { issues, routines } from "./work";

export interface PaperclipRoutineDefinition {
  title: string;
  description: string;
  priority: "low" | "medium" | "high" | "critical";
  sourceAgentId: string;
  projectId: string | null;
  projectWorkspaceId: string | null;
  goalId: string | null;
  parentIssueId: string | null;
  variables: unknown[];
  envFingerprint: string;
  activityGatePolicy: string;
  activityGateScope: string;
  catchUpPolicy: string;
  executionContract: "issue_reference_v1" | "unverified_import";
  preparedNative?: {
    originalPrompt: string;
    originalConfigHash: string;
    originalDefinition: Record<string, unknown>;
    originalHookFingerprint: string | null;
    sourceTemplateHash: string;
    preparedAt: string;
  };
}

/** Explicit migration bindings; importing a binding never enables its ingress or native routine. */
export const paperclipRoutineMappings = pgTable(
  "paperclip_routine_mappings",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    sourceCompanyId: uuid().notNull(),
    sourceRoutineId: uuid().notNull(),
    sourceRevisionId: text(),
    configHash: text().notNull(),
    nativeConfigHash: text().notNull(),
    agentId: uuid().notNull(),
    sourceActive: boolean().notNull(),
    sourceArchived: boolean().notNull().default(false),
    triggers: jsonb().$type<{ id: string; kind: "api" | "schedule"; enabled: boolean }[]>().notNull(),
    policy: text().$type<"always_enqueue" | "coalesce_if_active" | "skip_if_active">().notNull(),
    definition: jsonb().$type<PaperclipRoutineDefinition>().notNull(),
    routineId: uuid()
      .notNull()
      .references(() => routines.id, { onDelete: "cascade" }),
    enabled: boolean().notNull().default(false),
    createdByUserId: text().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.orgId, t.sourceCompanyId, t.sourceRoutineId), index().on(t.orgId)],
);

/** No TTL: a source-kind/nullable-trigger/key replay keeps its original receipt indefinitely. */
export const paperclipRoutineReceipts = pgTable(
  "paperclip_routine_receipts",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    mappingId: uuid()
      .notNull()
      .references(() => paperclipRoutineMappings.id, { onDelete: "cascade" }),
    source: text().$type<"api" | "manual">().notNull(),
    sourceTriggerId: uuid(),
    /** Hash of source-kind, nullable trigger and key. NULL means no idempotency key was supplied. */
    idempotencyScopeHash: text(),
    dispatchFingerprint: text().notNull(),
    status: text().$type<"queued" | "coalesced" | "skipped">().notNull(),
    issueId: uuid().references(() => issues.id, { onDelete: "set null" }),
    /** Not a FK: native event deferral replaces its row and updates this pointer atomically. */
    routineRunId: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.orgId, t.mappingId, t.idempotencyScopeHash),
    index().on(t.mappingId, t.dispatchFingerprint),
    index().on(t.routineRunId),
  ],
);
