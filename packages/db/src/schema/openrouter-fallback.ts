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
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./tenancy";

/** Separate, owner-approved paid fallback pool; never part of the subscription grant tables. */
export const openRouterFallbackSettings = pgTable(
  "openrouter_fallback_settings",
  {
    orgId: uuid()
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),
    enabled: boolean().notNull().default(false),
    monthlyCapNanoUsd: bigint({ mode: "number" }).notNull().default(50_000_000_000),
    credentialId: uuid(),
    credentialVersion: text(),
    credentialFingerprint: text(),
    approvedBy: text(),
    policy: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    revision: integer().notNull().default(1),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.credentialFingerprint),
    check("openrouter_fallback_cap", sql`${t.monthlyCapNanoUsd} > 0 and ${t.monthlyCapNanoUsd} <= 50000000000`),
    check(
      "openrouter_fallback_identity",
      sql`not ${t.enabled} or (${t.credentialId} is not null and ${t.credentialVersion} is not null and ${t.credentialFingerprint} is not null and ${t.approvedBy} is not null)`,
    ),
  ],
);

export const openRouterFallbackMonths = pgTable(
  "openrouter_fallback_months",
  {
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    period: text().notNull(),
    spentNanoUsd: bigint({ mode: "number" }).notNull().default(0),
    heldNanoUsd: bigint({ mode: "number" }).notNull().default(0),
    paused: boolean().notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.period] }),
    check("openrouter_month_amounts", sql`${t.spentNanoUsd} >= 0 and ${t.heldNanoUsd} >= 0`),
  ],
);

/** Holds never expire automatically; an unknown charged dispatch must be reconciled before new spending. */
export const openRouterFallbackAttempts = pgTable(
  "openrouter_fallback_attempts",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid().notNull(),
    period: text().notNull(),
    runId: uuid().notNull(),
    turn: integer().notNull(),
    credentialId: uuid().notNull(),
    credentialVersion: text().notNull(),
    router: text().notNull(),
    allowedModels: jsonb().$type<string[]>().notNull(),
    reservedNanoUsd: bigint({ mode: "number" }).notNull(),
    actualNanoUsd: bigint({ mode: "number" }),
    actualModel: text(),
    state: text().$type<"held" | "settled" | "unknown">().notNull().default("held"),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    unique().on(t.orgId, t.runId, t.turn),
    foreignKey({
      columns: [t.orgId, t.period],
      foreignColumns: [openRouterFallbackMonths.orgId, openRouterFallbackMonths.period],
    }).onDelete("cascade"),
    index().on(t.orgId, t.state),
    check("openrouter_attempt_router", sql`${t.router} in ('openrouter/auto', 'openrouter/auto-code')`),
    check(
      "openrouter_attempt_amount",
      sql`${t.reservedNanoUsd} > 0 and ${t.turn} > 0 and (${t.actualNanoUsd} is null or ${t.actualNanoUsd} >= 0)`,
    ),
    check(
      "openrouter_attempt_state",
      sql`${t.state} in ('held','settled','unknown') and (${t.state} <> 'settled' or (${t.actualNanoUsd} is not null and ${t.actualModel} is not null and ${t.settledAt} is not null))`,
    ),
  ],
);
