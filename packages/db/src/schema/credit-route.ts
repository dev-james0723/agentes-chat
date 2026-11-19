import { sql } from "drizzle-orm";
import { bigint, boolean, check, foreignKey, index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./tenancy";

/**
 * Credit routes (ADR 0200): a Claude API credential an agent's run may continue on when its subscription reaches its
 * limit. Every row is disabled until an operator records billing evidence for it, and a provider call is admitted
 * only against fresh evidence, so a workspace with no rows behaves exactly as before.
 *
 * A pool is the one upstream billing authority (the provider's own organization, never a key) every credential and
 * agent shares. `allocationNanoUsd` is our own ceiling on what this server spends there; it is a defensive ledger, not
 * the provider's balance, which only the provider knows.
 */
export const creditPools = pgTable(
  "credit_pools",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Canonical billing authority (`anthropic`) and its organization at the provider. */
    upstreamNamespace: text().notNull(),
    upstreamAccount: text().notNull(),
    /** How the provider stops at an empty grant: only `prepaid_grant_only` (no purchased balance, no auto-reload). */
    enforcement: text().notNull(),
    enabled: boolean().notNull().default(false),
    paused: boolean().notNull().default(false),
    /** Reference to the evidence an operator read (never the evidence itself, never a secret). */
    evidenceRef: text().notNull(),
    verifiedAt: timestamp({ withTimezone: true }).notNull(),
    validUntil: timestamp({ withTimezone: true }).notNull(),
    /** The provider's grant window, when its own page gave one. */
    grantStart: timestamp({ withTimezone: true }),
    grantEnd: timestamp({ withTimezone: true }),
    /** Our own ceiling on spend here. */
    allocationNanoUsd: bigint({ mode: "number" }).notNull(),
    spentNanoUsd: bigint({ mode: "number" }).notNull().default(0),
    /** Held for calls in flight and for calls whose outcome is unknown. */
    heldNanoUsd: bigint({ mode: "number" }).notNull().default(0),
    /** `available` until a provider refusal says otherwise; only an operator's new evidence makes it available again. */
    status: text().notNull().default("available"),
  },
  (t) => [
    unique().on(t.orgId, t.id),
    // One row for an upstream pool across every workspace: two workspaces can't each spend the same grant.
    unique().on(t.upstreamNamespace, t.upstreamAccount),
    check("credit_pool_enforcement", sql`${t.enforcement} in ('prepaid_grant_only')`),
    check(
      "credit_pool_status",
      sql`${t.status} in ('available', 'exhausted', 'expired', 'billing_blocked', 'reconciliation_required')`,
    ),
    check(
      "credit_pool_nonnegative",
      sql`${t.allocationNanoUsd} >= 0 and ${t.spentNanoUsd} >= 0 and ${t.heldNanoUsd} >= 0`,
    ),
    check("credit_pool_evidence_window", sql`${t.verifiedAt} < ${t.validUntil}`),
  ],
);

/** One credential, at one exact version and endpoint, for one model. The credential is reserved for this route. */
export const creditRoutes = pgTable(
  "credit_routes",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid().notNull(),
    poolId: uuid().notNull(),
    credentialId: uuid().notNull(),
    /** Digest of the exact sealed row and endpoint configuration that was qualified (`credentialVersion`). */
    credentialVersion: text().notNull(),
    model: text().notNull(),
    supportsTools: boolean().notNull().default(false),
    maxPromptBytes: bigint({ mode: "number" }).notNull(),
    enabled: boolean().notNull().default(false),
  },
  (t) => [
    unique().on(t.orgId, t.poolId, t.id),
    unique().on(t.orgId, t.credentialId, t.model),
    foreignKey({
      columns: [t.orgId, t.poolId],
      foreignColumns: [creditPools.orgId, creditPools.id],
    }).onDelete("cascade"),
    index().on(t.orgId, t.credentialId),
    check("credit_route_max_prompt", sql`${t.maxPromptBytes} > 0`),
  ],
);

/**
 * One call's hold. `held` and `unknown` count against the pool until settled or released; nothing frees them by time:
 * a call that went out and did not come back stays held until someone reconciles it.
 */
export const creditAttempts = pgTable(
  "credit_attempts",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid().notNull(),
    poolId: uuid().notNull(),
    routeId: uuid().notNull(),
    runId: uuid(),
    agentId: uuid(),
    amountNanoUsd: bigint({ mode: "number" }).notNull(),
    actualNanoUsd: bigint({ mode: "number" }),
    state: text().notNull().default("held"),
    reason: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    foreignKey({
      columns: [t.orgId, t.poolId],
      foreignColumns: [creditPools.orgId, creditPools.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.orgId, t.poolId, t.routeId],
      foreignColumns: [creditRoutes.orgId, creditRoutes.poolId, creditRoutes.id],
    }),
    index().on(t.orgId, t.poolId, t.state),
    check("credit_attempt_state", sql`${t.state} in ('held', 'settled', 'released', 'unknown')`),
    check(
      "credit_attempt_nonnegative",
      sql`${t.amountNanoUsd} >= 0 and (${t.actualNanoUsd} is null or ${t.actualNanoUsd} >= 0)`,
    ),
  ],
);
