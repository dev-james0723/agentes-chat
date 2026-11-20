import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./tenancy";

/** Immutable standard tariff, stored with each reservation so a later catalog edit cannot reprice a receipt. */
export interface StoredCreditPricingProfile {
  version: 1;
  provider: "openai" | "anthropic";
  model: string;
  endpoint: string;
  serviceTier: "standard";
  contextWindow: number;
  maxOutputTokens: number | null;
  prices: { input: number; output: number; cacheRead: number; cacheWrite: number };
  longContext: {
    aboveInputTokens: number;
    prices: { input: number; output: number; cacheRead: number; cacheWrite: number };
  } | null;
  longCacheWriteMultiplier: 2;
  profileHash: string;
}

/** One upstream billing organization. No credentials or provider balance guesses are stored here. */
export const creditPools = pgTable(
  "credit_pools",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    upstreamNamespace: text().notNull(),
    upstreamAccount: text().notNull(),
    currentCycleId: uuid(),
    enabled: boolean().notNull().default(false),
    paused: boolean().notNull().default(false),
    status: text().notNull().default("unverified"),
  },
  (t) => [
    unique().on(t.orgId, t.id),
    unique().on(t.upstreamNamespace, t.upstreamAccount),
    // A second account or credential must not create another $120 provider allowance.
    unique().on(t.orgId, t.upstreamNamespace),
    check("credit_pool_provider", sql`${t.upstreamNamespace} in ('openai', 'anthropic')`),
    check(
      "credit_pool_status",
      sql`${t.status} in ('unverified', 'available', 'exhausted', 'expired', 'billing_blocked', 'reconciliation_required')`,
    ),
  ],
);

/** Immutable cycle identity and protected accounting. Renewing evidence never resets these counters. */
export const creditGrantCycles = pgTable(
  "credit_grant_cycles",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid().notNull(),
    poolId: uuid().notNull(),
    cycleKey: text().notNull(),
    product: text().notNull(),
    grantId: text().notNull(),
    grantStart: timestamp({ withTimezone: true }).notNull(),
    grantEnd: timestamp({ withTimezone: true }).notNull(),
    eligibleSince: timestamp({ withTimezone: true }).notNull(),
    activatedAt: timestamp({ withTimezone: true }).notNull(),
    evidenceRef: text().notNull(),
    verifiedByUserId: text().notNull(),
    verifiedAt: timestamp({ withTimezone: true }).notNull(),
    validUntil: timestamp({ withTimezone: true }).notNull(),
    enforcement: text().notNull(),
    externalSpendCoverage: text().notNull(),
    externalSpendBoundNanoUsd: bigint({ mode: "number" }).notNull().default(0),
    grantAmountNanoUsd: bigint({ mode: "number" }).notNull(),
    observedRemainingNanoUsd: bigint({ mode: "number" }).notNull(),
    localSpentAtObservationNanoUsd: bigint({ mode: "number" }).notNull().default(0),
    automaticLimitNanoUsd: bigint({ mode: "number" }).notNull(),
    emergencyLimitNanoUsd: bigint({ mode: "number" }).notNull(),
    safetyBufferNanoUsd: bigint({ mode: "number" }).notNull(),
    spentAutomaticNanoUsd: bigint({ mode: "number" }).notNull().default(0),
    spentEmergencyNanoUsd: bigint({ mode: "number" }).notNull().default(0),
    heldAutomaticNanoUsd: bigint({ mode: "number" }).notNull().default(0),
    heldEmergencyNanoUsd: bigint({ mode: "number" }).notNull().default(0),
  },
  (t) => [
    unique().on(t.orgId, t.poolId, t.id),
    unique().on(t.poolId, t.cycleKey),
    unique().on(t.poolId, t.grantId),
    foreignKey({ columns: [t.orgId, t.poolId], foreignColumns: [creditPools.orgId, creditPools.id] }).onDelete(
      "cascade",
    ),
    check("credit_cycle_product", sql`${t.product} in ('openai_pro_api', 'claude_ultra_api')`),
    check(
      "credit_cycle_enforcement",
      sql`${t.enforcement} = 'prepaid_grant_only' and ${t.externalSpendCoverage} in ('exclusive', 'bounded')`,
    ),
    check(
      "credit_cycle_window",
      sql`${t.grantStart} < ${t.grantEnd} and ${t.verifiedAt} < ${t.validUntil} and ${t.validUntil} <= ${t.grantEnd}`,
    ),
    check(
      "credit_cycle_nonnegative",
      sql`${t.grantAmountNanoUsd} >= 0 and ${t.observedRemainingNanoUsd} >= 0 and ${t.observedRemainingNanoUsd} <= ${t.grantAmountNanoUsd} and ${t.localSpentAtObservationNanoUsd} >= 0 and ${t.externalSpendBoundNanoUsd} >= 0 and ${t.spentAutomaticNanoUsd} >= 0 and ${t.spentEmergencyNanoUsd} >= 0 and ${t.heldAutomaticNanoUsd} >= 0 and ${t.heldEmergencyNanoUsd} >= 0`,
    ),
    check(
      "credit_cycle_limits",
      sql`${t.automaticLimitNanoUsd} between 0 and 120000000000 and ${t.emergencyLimitNanoUsd} between 0 and 60000000000 and ${t.safetyBufferNanoUsd} between 0 and 20000000000 and ${t.automaticLimitNanoUsd} + ${t.emergencyLimitNanoUsd} + ${t.safetyBufferNanoUsd} <= ${t.grantAmountNanoUsd}`,
    ),
  ],
);

export const creditRoutes = pgTable(
  "credit_routes",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid().notNull(),
    poolId: uuid().notNull(),
    credentialId: uuid().notNull(),
    credentialVersion: text().notNull(),
    /** Retained after local key rotation/revocation to prevent spending the old secret through another row. */
    credentialFingerprint: text().notNull(),
    pricingEvidenceRef: text().notNull(),
    pricingVerifiedAt: timestamp({ withTimezone: true }).notNull(),
    pricingValidUntil: timestamp({ withTimezone: true }).notNull(),
    pricingProfileHash: text().notNull(),
    model: text().notNull(),
    routeKind: text().notNull(),
    accountEvidenceRef: text().notNull(),
    supportsTools: boolean().notNull().default(false),
    maxPromptBytes: bigint({ mode: "number" }).notNull(),
    capabilities: jsonb().$type<string[]>().notNull().default([]),
    enabled: boolean().notNull().default(false),
  },
  (t) => [
    unique().on(t.orgId, t.poolId, t.id),
    unique().on(t.orgId, t.credentialId, t.model),
    foreignKey({ columns: [t.orgId, t.poolId], foreignColumns: [creditPools.orgId, creditPools.id] }).onDelete(
      "cascade",
    ),
    index().on(t.orgId, t.credentialId),
    index().on(t.credentialFingerprint),
    check("credit_route_fingerprint", sql`${t.credentialFingerprint} ~ '^[a-f0-9]{64}$'`),
    check(
      "credit_route_pricing",
      sql`${t.pricingProfileHash} ~ '^sha256:[a-f0-9]{64}$' and ${t.pricingVerifiedAt} < ${t.pricingValidUntil}`,
    ),
    check("credit_route_kind", sql`${t.routeKind} in ('openai_responses', 'anthropic_messages', 'claude_agent_sdk')`),
    check("credit_route_max_prompt", sql`${t.maxPromptBytes} > 0`),
  ],
);

/** Approval adds authority only within the existing emergency bucket, never new credits or top-ups. */
export const creditReserveApprovals = pgTable(
  "credit_reserve_approvals",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid().notNull(),
    poolId: uuid().notNull(),
    cycleId: uuid().notNull(),
    actorUserId: text().notNull(),
    decisionKey: text().notNull(),
    evidenceRef: text().notNull(),
    amountNanoUsd: bigint({ mode: "number" }).notNull(),
    heldNanoUsd: bigint({ mode: "number" }).notNull().default(0),
    spentNanoUsd: bigint({ mode: "number" }).notNull().default(0),
    approvedAt: timestamp({ withTimezone: true }).notNull(),
    validUntil: timestamp({ withTimezone: true }).notNull(),
    revokedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    unique().on(t.orgId, t.decisionKey),
    foreignKey({
      columns: [t.orgId, t.poolId, t.cycleId],
      foreignColumns: [creditGrantCycles.orgId, creditGrantCycles.poolId, creditGrantCycles.id],
    }),
    check(
      "credit_approval_amount",
      sql`${t.amountNanoUsd} > 0 and ${t.amountNanoUsd} <= 60000000000 and ${t.heldNanoUsd} >= 0 and ${t.spentNanoUsd} >= 0`,
    ),
    check("credit_approval_window", sql`${t.approvedAt} < ${t.validUntil}`),
  ],
);

/** Native work-unit ownership is checked again immediately before a request leaves the gateway. */
export const creditWorkUnits = pgTable(
  "credit_work_units",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    workUnitKey: text().notNull(),
    runId: uuid().notNull(),
    ownerEpoch: bigint({ mode: "number" }).notNull(),
    ownerJobId: uuid().notNull(),
    ownerWorkerId: text().notNull(),
  },
  (t) => [unique().on(t.orgId, t.workUnitKey), check("credit_unit_epoch", sql`${t.ownerEpoch} >= 0`)],
);

/** Holds survive crashes. A dispatched/unknown hold is never freed merely because its lease expired. */
export const creditAttempts = pgTable(
  "credit_attempts",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid().notNull(),
    poolId: uuid().notNull(),
    cycleId: uuid().notNull(),
    routeId: uuid().notNull(),
    runId: uuid().notNull(),
    agentId: uuid(),
    workUnitKey: text().notNull(),
    attemptKey: text().notNull(),
    ownerEpoch: bigint({ mode: "number" }).notNull(),
    ownerJobId: uuid().notNull(),
    ownerWorkerId: text().notNull(),
    bucket: text().notNull(),
    reservationNeed: jsonb().$type<{ tools: boolean; promptBytes: number; capabilities?: string[] }>().notNull(),
    pricingSnapshot: jsonb().$type<StoredCreditPricingProfile>().notNull(),
    pricingProfileHash: text().notNull(),
    cacheTtl: text().$type<"default" | "1h">().notNull(),
    approvalId: uuid().references(() => creditReserveApprovals.id),
    amountNanoUsd: bigint({ mode: "number" }).notNull(),
    actualNanoUsd: bigint({ mode: "number" }),
    state: text().notNull().default("held"),
    reason: text(),
    providerRequestId: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    dispatchedAt: timestamp({ withTimezone: true }),
    settledAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    unique().on(t.orgId, t.attemptKey),
    check(
      "credit_attempt_pricing",
      sql`${t.pricingProfileHash} ~ '^sha256:[a-f0-9]{64}$' and ${t.cacheTtl} in ('default', '1h')`,
    ),
    foreignKey({
      columns: [t.orgId, t.poolId, t.cycleId],
      foreignColumns: [creditGrantCycles.orgId, creditGrantCycles.poolId, creditGrantCycles.id],
    }),
    foreignKey({
      columns: [t.orgId, t.poolId, t.routeId],
      foreignColumns: [creditRoutes.orgId, creditRoutes.poolId, creditRoutes.id],
    }),
    index().on(t.orgId, t.poolId, t.state),
    index().on(t.orgId, t.workUnitKey),
    check("credit_attempt_state", sql`${t.state} in ('held', 'dispatching', 'settled', 'released', 'unknown')`),
    check("credit_attempt_bucket", sql`${t.bucket} in ('automatic', 'emergency')`),
    check(
      "credit_attempt_nonnegative",
      sql`${t.amountNanoUsd} > 0 and ${t.ownerEpoch} >= 0 and (${t.actualNanoUsd} is null or ${t.actualNanoUsd} >= 0)`,
    ),
  ],
);
