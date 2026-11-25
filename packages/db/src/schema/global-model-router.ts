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

/**
 * Organization-wide Global Model Router policy and kill switch.
 * Additive alongside `openrouter_fallback_settings` so rolling deploys remain compatible.
 */
export const globalRouterPolicies = pgTable(
  "global_router_policies",
  {
    orgId: uuid()
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),
    enabled: boolean().notNull().default(false),
    killSwitch: boolean().notNull().default(false),
    optOutAgentIds: jsonb().$type<string[]>().notNull().default([]),
    maxEscalations: integer().notNull().default(2),
    maxRetriesPerRoute: integer().notNull().default(1),
    warnAt50: boolean().notNull().default(true),
    warnAt80: boolean().notNull().default(true),
    warnAt95: boolean().notNull().default(true),
    approvedBy: text(),
    revision: integer().notNull().default(1),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "global_router_policy_bounds",
      sql`${t.maxEscalations} >= 0 and ${t.maxEscalations} <= 2 and ${t.maxRetriesPerRoute} >= 0 and ${t.maxRetriesPerRoute} <= 1`,
    ),
    check("global_router_policy_approver", sql`not ${t.enabled} or ${t.approvedBy} is not null`),
  ],
);

/**
 * Per-provider lane account binding, entitlement, quota limits, and spend cap.
 * - `free_only` and `subscription_go` accounts enforce zero incremental USD cap (`monthly_cap_nano_usd = 0`).
 * - `openrouter` paid accounts enforce `monthly_cap_nano_usd <= 50_000_000_000` (USD 50/month).
 * - `extra_usage_allowed` is strictly `false` (no automatic overage or Extra Usage).
 * - `gemini` metered API and `custom` local endpoints are excluded by constraint.
 */
export const globalRouterAccounts = pgTable(
  "global_router_accounts",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    provider: text().notNull(),
    lane: text().$type<"opencode_go" | "free_api" | "paid_low_cost" | "paid_dynamic" | "direct_api">().notNull(),
    entitlement: text().$type<"subscription_go" | "free_only" | "paid_capped">().notNull(),
    credentialId: uuid().notNull(),
    credentialVersion: text().notNull(),
    credentialFingerprint: text().notNull(),
    workspaceAccountRef: text(),
    enabled: boolean().notNull().default(false),
    killSwitch: boolean().notNull().default(false),
    extraUsageAllowed: boolean().notNull().default(false),
    monthlyCapNanoUsd: bigint({ mode: "number" }).notNull().default(0),
    maxPromptNanoPerToken: bigint({ mode: "number" }).notNull().default(5000),
    maxCompletionNanoPerToken: bigint({ mode: "number" }).notNull().default(25000),
    allowedModels: jsonb().$type<string[]>().notNull().default([]),
    rpmLimit: integer(),
    rpdLimit: integer(),
    tpmLimit: integer(),
    tpdLimit: integer(),
    dailyNeuronsLimit: integer().notNull().default(10000),
    zdrRequired: boolean().notNull().default(false),
    allowedRegion: text().notNull().default("global"),
    healthState: text()
      .$type<"healthy" | "quota_warning" | "rate_limited" | "outage" | "reauth_required" | "paused">()
      .notNull()
      .default("healthy"),
    quotaTelemetry: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    quotaObservedAt: timestamp({ withTimezone: true }),
    resetsAt: timestamp({ withTimezone: true }),
    approvedBy: text().notNull(),
    revision: integer().notNull().default(1),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("global_router_accounts_org_provider_lane_unique").on(t.orgId, t.provider, t.lane),
    index("global_router_accounts_org_enabled_idx").on(t.orgId, t.enabled),
    check(
      "global_router_account_provider",
      sql`${t.provider} in ('openrouter','groq','cloudflare','opencode','deepseek','tencent','minimax','zai','moonshot','xiaomi','nvidia')`,
    ),
    check(
      "global_router_account_lane",
      sql`${t.lane} in ('opencode_go','free_api','paid_low_cost','paid_dynamic','direct_api')`,
    ),
    check("global_router_account_extra_off", sql`${t.extraUsageAllowed} = false`),
    check(
      "global_router_account_caps",
      sql`(
        (${t.entitlement} in ('free_only','subscription_go') and ${t.monthlyCapNanoUsd} = 0)
        or (
          ${t.entitlement} = 'paid_capped'
          and ${t.monthlyCapNanoUsd} > 0
          and (${t.provider} <> 'openrouter' or ${t.monthlyCapNanoUsd} <= 50000000000)
        )
      ) and ${t.maxPromptNanoPerToken} >= 0 and ${t.maxCompletionNanoPerToken} >= 0 and ${t.dailyNeuronsLimit} >= 0`,
    ),
  ],
);

/** Persisted dynamic catalog snapshots with freshness and qualification status. */
export const globalRouterOffers = pgTable(
  "global_router_offers",
  {
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    offerId: text().notNull(),
    provider: text().notNull(),
    lane: text().notNull(),
    modelId: text().notNull(),
    label: text().notNull(),
    qualificationStatus: text().notNull(),
    freeEligible: boolean().notNull().default(false),
    offer: jsonb().$type<Record<string, unknown>>().notNull(),
    observedAt: timestamp({ withTimezone: true }).notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.offerId] }),
    index("global_router_offers_org_status_idx").on(t.orgId, t.qualificationStatus),
  ],
);

/**
 * Atomic monthly spend/hold and minute/day request/token/neuron windows per account.
 * Unresolved holds in prior periods block new paid reservations across monthly rollovers.
 */
export const globalRouterWindows = pgTable(
  "global_router_windows",
  {
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    accountId: uuid()
      .notNull()
      .references(() => globalRouterAccounts.id, { onDelete: "cascade" }),
    period: text().notNull(),
    spentNanoUsd: bigint({ mode: "number" }).notNull().default(0),
    heldNanoUsd: bigint({ mode: "number" }).notNull().default(0),
    dayKey: text().notNull().default(""),
    dayRequestsUsed: integer().notNull().default(0),
    dayRequestsHeld: integer().notNull().default(0),
    dayTokensUsed: bigint({ mode: "number" }).notNull().default(0),
    dayNeuronsUsed: integer().notNull().default(0),
    dayNeuronsHeld: integer().notNull().default(0),
    minuteKey: text().notNull().default(""),
    minuteRequestsUsed: integer().notNull().default(0),
    minuteTokensUsed: bigint({ mode: "number" }).notNull().default(0),
    warned50: boolean().notNull().default(false),
    warned80: boolean().notNull().default(false),
    warned95: boolean().notNull().default(false),
    paused: boolean().notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.accountId, t.period] }),
    check(
      "global_router_window_nonnegative",
      sql`${t.spentNanoUsd} >= 0 and ${t.heldNanoUsd} >= 0 and ${t.dayRequestsUsed} >= 0 and ${t.dayRequestsHeld} >= 0 and ${t.dayTokensUsed} >= 0 and ${t.dayNeuronsUsed} >= 0 and ${t.dayNeuronsHeld} >= 0 and ${t.minuteRequestsUsed} >= 0 and ${t.minuteTokensUsed} >= 0`,
    ),
  ],
);

/**
 * Append-only inference reservation and settlement receipts across all lanes.
 * Unknown dispatches retain their hold until owner reconciliation.
 */
export const globalRouterAttempts = pgTable(
  "global_router_attempts",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid().notNull(),
    accountId: uuid().notNull(),
    period: text().notNull(),
    runId: uuid().notNull(),
    routineRunId: uuid(),
    agentId: uuid().notNull(),
    turn: integer().notNull(),
    attemptIndex: integer().notNull().default(1),
    idempotencyKey: text().notNull(),
    credentialId: uuid().notNull(),
    credentialVersion: text().notNull(),
    lane: text().notNull(),
    provider: text().notNull(),
    requestedModel: text().notNull(),
    actualModel: text(),
    allowedModels: jsonb().$type<string[]>().notNull(),
    reservedNanoUsd: bigint({ mode: "number" }).notNull().default(0),
    actualNanoUsd: bigint({ mode: "number" }),
    reservedNeurons: integer().notNull().default(0),
    actualNeurons: integer(),
    inputTokens: integer(),
    outputTokens: integer(),
    cacheReadTokens: integer(),
    latencyMs: integer(),
    qualityVerified: boolean().notNull().default(false),
    providerRequestId: text(),
    escalatedFromId: uuid(),
    state: text().$type<"held" | "settled" | "released" | "unknown">().notNull().default("held"),
    failureReason: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    unique("global_router_attempts_org_idempotency_unique").on(t.orgId, t.idempotencyKey),
    unique("global_router_attempts_org_run_turn_attempt_unique").on(t.orgId, t.runId, t.turn, t.attemptIndex),
    foreignKey({
      columns: [t.orgId, t.accountId, t.period],
      foreignColumns: [globalRouterWindows.orgId, globalRouterWindows.accountId, globalRouterWindows.period],
    }).onDelete("cascade"),
    index("global_router_attempts_org_state_idx").on(t.orgId, t.state),
    index("global_router_attempts_org_run_idx").on(t.orgId, t.runId),
    check(
      "global_router_attempt_amounts",
      sql`${t.reservedNanoUsd} >= 0 and ${t.reservedNeurons} >= 0 and ${t.turn} > 0 and ${t.attemptIndex} > 0 and (${t.actualNanoUsd} is null or ${t.actualNanoUsd} >= 0) and (${t.actualNeurons} is null or ${t.actualNeurons} >= 0)`,
    ),
    check(
      "global_router_attempt_state",
      sql`${t.state} in ('held','settled','released','unknown') and (${t.state} <> 'settled' or (${t.actualNanoUsd} is not null and ${t.actualModel} is not null and ${t.settledAt} is not null))`,
    ),
  ],
);

/** Durable stratified benchmark receipts for quality/cost routing decisions. */
export const globalRouterBenchmarks = pgTable(
  "global_router_benchmarks",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    suiteVersion: text().notNull(),
    taskCount: integer().notNull(),
    modelCount: integer().notNull(),
    summary: jsonb().$type<Record<string, unknown>>().notNull(),
    results: jsonb().$type<unknown[]>().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("global_router_benchmarks_org_created_idx").on(t.orgId, t.createdAt),
    check("global_router_benchmark_counts", sql`${t.taskCount} >= 30 and ${t.modelCount} >= 1`),
  ],
);
