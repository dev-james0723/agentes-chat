import { boolean, foreignKey, index, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth";
import { machines } from "./machines";
import { organizations } from "./tenancy";

export interface PaperclipWorkspaceAgentPin {
  id: string;
  ownerId: string;
  brain: "claude_code" | "codex";
  model: string;
  accountId: string | null;
}

/** Server registration of an immutable owner-local record. Contains no source path or native inode data. */
export const paperclipWorkspaceBindings = pgTable(
  "paperclip_workspace_bindings",
  {
    id: uuid().primaryKey(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    ownerId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    machineId: uuid().notNull(),
    generation: uuid().notNull(),
    sourceCompanyId: uuid().notNull(),
    sourceProjectId: uuid().notNull(),
    sourceWorkspaceId: uuid().notNull(),
    projectDigest: text().notNull(),
    snapshotDigest: text().notNull(),
    bindingDigest: text().notNull(),
    targetCwd: text().notNull(),
    agents: jsonb().$type<PaperclipWorkspaceAgentPin[]>().notNull(),
    enabled: boolean().notNull().default(true),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.machineId], foreignColumns: [machines.orgId, machines.id] }),
    unique().on(t.orgId, t.id),
    index().on(t.orgId, t.sourceCompanyId, t.sourceProjectId, t.sourceWorkspaceId),
  ],
);
