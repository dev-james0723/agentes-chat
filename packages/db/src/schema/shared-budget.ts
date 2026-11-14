import { sql } from "drizzle-orm";
import { bigint, boolean, check, foreignKey, index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./tenancy";

/** Disabled unless explicitly enabled for this workspace. Existing deployments have no rows. */
export const sharedBudgetPolicies = pgTable("shared_budget_policies", {
  orgId: uuid()
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  enabled: boolean().notNull().default(false),
});

/** One explicitly approved window. Uncertain amounts remain held after a crash until reconciliation. */
export const sharedBudgetPools = pgTable(
  "shared_budget_pools",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    windowStart: timestamp({ withTimezone: true }).notNull(),
    windowEnd: timestamp({ withTimezone: true }).notNull(),
    approvalUntil: timestamp({ withTimezone: true }).notNull(),
    approvedBy: text().notNull(),
    approvalRef: text().notNull(),
    /** Canonical billing namespace (not execution provider), account and pool, attested by trusted transport. */
    upstreamProvider: text(),
    upstreamAccount: text(),
    upstreamPool: text(),
    ceilingNanoUsd: bigint({ mode: "number" }).notNull(),
    spentNanoUsd: bigint({ mode: "number" }).notNull().default(0),
    heldNanoUsd: bigint({ mode: "number" }).notNull().default(0),
    paused: boolean().notNull().default(false),
  },
  (t) => [
    unique().on(t.orgId, t.id),
    // One row for a canonical billing pool globally. Reusing a pool for a later window requires safe reconciliation.
    unique().on(t.upstreamProvider, t.upstreamAccount, t.upstreamPool),
    check(
      "shared_budget_nonnegative",
      sql`${t.ceilingNanoUsd} >= 0 and ${t.spentNanoUsd} >= 0 and ${t.heldNanoUsd} >= 0`,
    ),
    check("shared_budget_window", sql`${t.windowStart} < ${t.windowEnd}`),
  ],
);

/** Exact route, call subject, data scope and recorded qualification; never substitutes for the cost guard. */
export const sharedBudgetRoutes = pgTable(
  "shared_budget_routes",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid().notNull(),
    poolId: uuid().notNull(),
    provider: text().notNull(),
    credentialId: uuid().notNull(),
    /** Digest of the exact sealed row and endpoint configuration that was qualified. */
    credentialVersion: text(),
    model: text().notNull(),
    subject: text().notNull(),
    dataClass: text().notNull(),
    supportsTools: boolean().notNull().default(false),
    maxPromptBytes: bigint({ mode: "number" }).notNull(),
    evidenceRef: text().notNull(),
    verifiedAt: timestamp({ withTimezone: true }).notNull(),
    validUntil: timestamp({ withTimezone: true }).notNull(),
    enabled: boolean().notNull().default(false),
  },
  (t) => [
    unique().on(t.orgId, t.poolId, t.id),
    foreignKey({
      columns: [t.orgId, t.poolId],
      foreignColumns: [sharedBudgetPools.orgId, sharedBudgetPools.id],
    }).onDelete("cascade"),
    index().on(t.orgId, t.provider, t.credentialId, t.model, t.subject),
    check("shared_route_window", sql`${t.verifiedAt} < ${t.validUntil}`),
    check("shared_route_max_prompt", sql`${t.maxPromptBytes} > 0`),
  ],
);

/** No time-to-live automatically frees uncertain usage. */
export const sharedBudgetReservations = pgTable(
  "shared_budget_reservations",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid().notNull(),
    poolId: uuid().notNull(),
    routeId: uuid().notNull(),
    amountNanoUsd: bigint({ mode: "number" }).notNull(),
    actualNanoUsd: bigint({ mode: "number" }),
    state: text().notNull().default("held"),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    foreignKey({
      columns: [t.orgId, t.poolId],
      foreignColumns: [sharedBudgetPools.orgId, sharedBudgetPools.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.orgId, t.poolId, t.routeId],
      foreignColumns: [sharedBudgetRoutes.orgId, sharedBudgetRoutes.poolId, sharedBudgetRoutes.id],
    }),
    check(
      "shared_reservation_nonnegative",
      sql`${t.amountNanoUsd} >= 0 and (${t.actualNanoUsd} is null or ${t.actualNanoUsd} >= 0)`,
    ),
    check("shared_reservation_state", sql`${t.state} in ('held', 'settled')`),
  ],
);
