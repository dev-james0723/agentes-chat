import { and, type Database, type Executor, eq, inArray, schema } from "@agenteschat/db";
import { recordAudit } from "./audit";
import { credentialVersion } from "./credentials";
import {
  assertCreditCachePolicy,
  assertCreditPricingEvidence,
  type CreditCacheTtl,
  type CreditPricingEvidence,
  type CreditPricingProfile,
  creditReceiptCost,
} from "./credit-pricing";
import {
  CREDIT_PROOF_MAX_MS,
  type CreditProof,
  type CreditQualification,
  type CreditRefusalReason,
  CreditRouteRefusal,
} from "./credit-route";
import { assertActiveMembership, getMembership } from "./organizations";

type Pool = typeof schema.creditPools.$inferSelect;
type Cycle = typeof schema.creditGrantCycles.$inferSelect;
type Route = typeof schema.creditRoutes.$inferSelect;
type Credential = typeof schema.providerCredentials.$inferSelect;
export type CreditProvider = "openai" | "anthropic";
export type CreditBucket = "automatic" | "emergency";
export const CREDIT_USD = 1_000_000_000;
export const CREDIT_MAX_REQUEST_MS = 120_000;
const SAFE_NAME = /^[A-Za-z0-9._:-]{1,200}$/;
const validAmount = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const validDate = (d: Date) => d instanceof Date && Number.isFinite(d.getTime());
const FINGERPRINT = /^[a-f0-9]{64}$/;
function routePricingEvidence(route: Route): CreditPricingEvidence {
  return {
    evidenceRef: route.pricingEvidenceRef,
    verifiedAt: route.pricingVerifiedAt,
    validUntil: route.pricingValidUntil,
    profileHash: route.pricingProfileHash,
  };
}
const sum = (...v: number[]) => {
  const n = v.reduce((a, b) => a + b, 0);
  if (!validAmount(n)) throw new CreditRouteRefusal("invalid_reservation");
  return n;
};
const spent = (c: Cycle) => sum(c.spentAutomaticNanoUsd, c.spentEmergencyNanoUsd);
const held = (c: Cycle) => sum(c.heldAutomaticNanoUsd, c.heldEmergencyNanoUsd);

/** Protection-first. A smaller grant reduces automatic use before emergency reserve or the safety buffer. */
export function creditBudgetForGrant(grantNanoUsd: number) {
  if (!validAmount(grantNanoUsd)) throw new CreditRouteRefusal("grant_unverified");
  const safetyBufferNanoUsd = Math.min(20 * CREDIT_USD, grantNanoUsd);
  const emergencyLimitNanoUsd = Math.min(60 * CREDIT_USD, grantNanoUsd - safetyBufferNanoUsd);
  const automaticLimitNanoUsd = Math.min(120 * CREDIT_USD, grantNanoUsd - safetyBufferNanoUsd - emergencyLimitNanoUsd);
  return { automaticLimitNanoUsd, emergencyLimitNanoUsd, safetyBufferNanoUsd };
}

/** A provider balance snapshot is reduced by local charges since that snapshot; open holds remain reserved. */
function remainingGrant(c: Cycle) {
  return Math.max(
    0,
    c.observedRemainingNanoUsd - Math.max(0, spent(c) - c.localSpentAtObservationNanoUsd) - c.externalSpendBoundNanoUsd,
  );
}
function available(c: Cycle, bucket: CreditBucket) {
  const grantRoom = remainingGrant(c) - held(c) - c.safetyBufferNanoUsd;
  if (bucket === "emergency")
    return Math.max(0, Math.min(c.emergencyLimitNanoUsd - c.spentEmergencyNanoUsd - c.heldEmergencyNanoUsd, grantRoom));
  const reservedEmergency = Math.max(0, c.emergencyLimitNanoUsd - c.spentEmergencyNanoUsd - c.heldEmergencyNanoUsd);
  return Math.max(
    0,
    Math.min(c.automaticLimitNanoUsd - c.spentAutomaticNanoUsd - c.heldAutomaticNanoUsd, grantRoom - reservedEmergency),
  );
}

export interface CreditNeed {
  /** Conservative full-call cost, when known; advisory qualification otherwise checks one nano-dollar. */
  amountNanoUsd?: number;
  tools: boolean;
  promptBytes: number;
  capabilities?: string[];
}

function refusalOf(
  pool: Pool,
  cycle: Cycle | undefined,
  route: Route,
  credential: Credential | undefined,
  need: CreditNeed,
  at: Date,
  amount: number,
  bucket: CreditBucket,
): CreditRefusalReason | null {
  if (!pool.enabled || !route.enabled) return "disabled";
  if (pool.paused) return "paused";
  if (pool.status === "exhausted") return "exhausted";
  if (pool.status === "billing_blocked") return "billing_blocked";
  if (pool.status === "expired") return "grant_expired";
  if (pool.status === "reconciliation_required") return "reconciliation_required";
  if (pool.status !== "available" || !cycle) return "grant_unverified";
  if (cycle.id !== pool.currentCycleId) return "cycle_mismatch";
  if (cycle.grantStart > at || cycle.grantEnd <= at) return "grant_expired";
  if (cycle.verifiedAt > at || cycle.validUntil.getTime() < at.getTime() + CREDIT_MAX_REQUEST_MS)
    return "stale_evidence";
  if (cycle.grantEnd.getTime() < at.getTime() + CREDIT_MAX_REQUEST_MS) return "grant_expired";
  if (cycle.enforcement !== "prepaid_grant_only") return "unverified";
  if (
    !credential ||
    credential.revokedAt ||
    credential.provider !== pool.upstreamNamespace ||
    !credential.secretFingerprint ||
    !FINGERPRINT.test(credential.secretFingerprint) ||
    credential.secretFingerprint !== route.credentialFingerprint ||
    credentialVersion(credential) !== route.credentialVersion
  )
    return "credential_changed";
  if (credential.options?.endpoint) return "endpoint_mismatch";
  if (
    pool.upstreamNamespace === "openai" &&
    (credential.options?.organization !== pool.upstreamAccount ||
      route.routeKind !== "openai_responses" ||
      cycle.product !== "openai_pro_api")
  )
    return "account_mismatch";
  if (
    pool.upstreamNamespace === "anthropic" &&
    (route.routeKind !== "anthropic_messages" || cycle.product !== "claude_ultra_api")
  )
    return "unsupported_capability";
  try {
    const profile = assertCreditPricingEvidence(route.model, routePricingEvidence(route), at, CREDIT_MAX_REQUEST_MS);
    if (profile.provider !== pool.upstreamNamespace) return "pricing_changed";
  } catch (error) {
    return error instanceof CreditRouteRefusal ? error.reason : "pricing_unverified";
  }
  // SDK routes require a separate proven adapter. Interactive Claude Code is never admitted here.
  if (
    !validAmount(need.promptBytes) ||
    (need.tools && !route.supportsTools) ||
    need.promptBytes > route.maxPromptBytes ||
    (need.capabilities ?? []).some((c) => !route.capabilities.includes(c))
  )
    return "unsupported_capability";
  if (amount > available(cycle, bucket)) return "budget_exhausted";
  return null;
}

async function owner(db: Executor, orgId: string, actorUserId: string) {
  await db
    .select({ id: schema.organizationMembers.userId })
    .from(schema.organizationMembers)
    .where(and(eq(schema.organizationMembers.orgId, orgId), eq(schema.organizationMembers.userId, actorUserId)))
    .for("share");
  const m = await getMembership(db, actorUserId, orgId);
  if (m?.role !== "owner") throw new CreditRouteRefusal("spend_approval_required");
  assertActiveMembership(m);
}

export async function qualifyCreditRoute(
  db: Database,
  input: { orgId: string; need: CreditNeed; now?: () => Date; routeId?: string; provider?: CreditProvider },
): Promise<CreditQualification> {
  const at = (input.now ?? (() => new Date()))();
  const amount = input.need.amountNanoUsd ?? 1;
  if (!validAmount(amount) || amount === 0) return { ok: false, reason: "invalid_reservation" };
  const { creditPools: p, creditRoutes: r, creditGrantCycles: c, providerCredentials: k } = schema;
  const rows = await db
    .select({ pool: p, route: r, cycle: c, credential: k })
    .from(r)
    .innerJoin(p, and(eq(p.orgId, r.orgId), eq(p.id, r.poolId)))
    .innerJoin(c, and(eq(c.orgId, p.orgId), eq(c.id, p.currentCycleId)))
    .innerJoin(k, and(eq(k.orgId, r.orgId), eq(k.id, r.credentialId)))
    .where(
      and(
        eq(r.orgId, input.orgId),
        eq(r.enabled, true),
        eq(p.enabled, true),
        input.routeId ? eq(r.id, input.routeId) : undefined,
        input.provider ? eq(p.upstreamNamespace, input.provider) : undefined,
      ),
    )
    .orderBy(r.id);
  let first: CreditRefusalReason = "disabled";
  for (const { pool, route, cycle, credential } of rows) {
    let reason = refusalOf(pool, cycle, route, credential, input.need, at, amount, "automatic");
    let bucket: CreditBucket = "automatic";
    let approvalId: string | undefined;
    if (reason === "budget_exhausted" && amount <= available(cycle, "emergency")) {
      const approvals = await db
        .select()
        .from(schema.creditReserveApprovals)
        .where(
          and(
            eq(schema.creditReserveApprovals.orgId, input.orgId),
            eq(schema.creditReserveApprovals.poolId, pool.id),
            eq(schema.creditReserveApprovals.cycleId, cycle.id),
          ),
        )
        .orderBy(schema.creditReserveApprovals.approvedAt);
      for (const approval of approvals) {
        if (
          approval.revokedAt ||
          approval.approvedAt > at ||
          approval.validUntil.getTime() < at.getTime() + CREDIT_MAX_REQUEST_MS ||
          sum(approval.heldNanoUsd, approval.spentNanoUsd, amount) > approval.amountNanoUsd
        )
          continue;
        const membership = await getMembership(db, approval.actorUserId, input.orgId);
        if (membership?.role !== "owner") continue;
        try {
          assertActiveMembership(membership);
        } catch {
          continue;
        }
        reason = null;
        bucket = "emergency";
        approvalId = approval.id;
        break;
      }
      if (!approvalId) reason = "spend_approval_required";
    }
    if (reason) {
      if (first === "disabled") first = reason;
      continue;
    }
    const proof: CreditProof = {
      routeId: route.id,
      poolId: pool.id,
      cycleId: cycle.id,
      bucket,
      ...(approvalId ? { approvalId } : {}),
      credentialId: route.credentialId,
      credentialVersion: route.credentialVersion,
      provider: pool.upstreamNamespace as CreditProvider,
      product: cycle.product as "openai_pro_api" | "claude_ultra_api",
      routeKind: route.routeKind as "openai_responses" | "anthropic_messages",
      model: route.model,
      pool: `${pool.upstreamNamespace}:${pool.upstreamAccount}`,
      evidenceRef: cycle.evidenceRef,
      observedAt: at.getTime(),
      validUntil: Math.min(
        cycle.validUntil.getTime(),
        cycle.grantEnd.getTime(),
        route.pricingValidUntil.getTime(),
        at.getTime() + CREDIT_PROOF_MAX_MS,
      ),
    };
    return { ok: true, proof };
  }
  return { ok: false, reason: first };
}

export async function isCreditCredential(db: Executor, orgId: string, credentialId: string): Promise<boolean> {
  const [r] = await db
    .select({ id: schema.creditRoutes.id })
    .from(schema.creditRoutes)
    .where(and(eq(schema.creditRoutes.orgId, orgId), eq(schema.creditRoutes.credentialId, credentialId)))
    .limit(1);
  return !!r;
}

export interface CreditAdmission {
  attemptId: string;
  poolId: string;
  routeId: string;
  cycleId: string;
  ownerEpoch: number;
  replayed: boolean;
  pricingSnapshot: CreditPricingProfile;
  cacheTtl: CreditCacheTtl;
}
export interface CreditAdmissionInput {
  orgId: string;
  routeId: string;
  cycleId: string;
  credentialId: string;
  credentialVersion: string;
  model: string;
  pricingProfileHash: string;
  cacheTtl?: "1h";
  need: CreditNeed;
  amountNanoUsd: number;
  runId: string;
  agentId?: string;
  workUnitKey: string;
  attemptKey: string;
  ownerEpoch: number;
  ownerJobId: string;
  ownerWorkerId: string;
  bucket?: CreditBucket;
  approvalId?: string;
  now?: () => Date;
}

/** One serialization order for all mutations: pool, cycle, credential/route, work unit, attempt, approval. */
async function lockPool(db: Executor, orgId: string, poolId: string) {
  const [p] = await db
    .select()
    .from(schema.creditPools)
    .where(and(eq(schema.creditPools.orgId, orgId), eq(schema.creditPools.id, poolId)))
    .for("update");
  if (!p) throw new CreditRouteRefusal("disabled");
  return p;
}
async function lockCycle(db: Executor, orgId: string, poolId: string, cycleId: string) {
  const [c] = await db
    .select()
    .from(schema.creditGrantCycles)
    .where(
      and(
        eq(schema.creditGrantCycles.orgId, orgId),
        eq(schema.creditGrantCycles.poolId, poolId),
        eq(schema.creditGrantCycles.id, cycleId),
      ),
    )
    .for("update");
  if (!c) throw new CreditRouteRefusal("grant_unverified");
  return c;
}
async function checkRun(
  db: Executor,
  orgId: string,
  runId: string,
  claim: { ownerEpoch: number; ownerJobId: string; ownerWorkerId: string },
  at: Date,
) {
  const [job] = await db
    .select()
    .from(schema.outbox)
    .where(and(eq(schema.outbox.orgId, orgId), eq(schema.outbox.id, claim.ownerJobId)))
    .for("update");
  if (
    !job ||
    job.payload.runId !== runId ||
    job.status !== "processing" ||
    job.lockedBy !== claim.ownerWorkerId ||
    job.attempts !== claim.ownerEpoch ||
    !job.lockedUntil ||
    job.lockedUntil <= at
  )
    throw new CreditRouteRefusal("stale_owner");
  const [run] = await db
    .select({ status: schema.agentRuns.status })
    .from(schema.agentRuns)
    .where(and(eq(schema.agentRuns.orgId, orgId), eq(schema.agentRuns.id, runId)))
    .for("update");
  if (run?.status !== "running") throw new CreditRouteRefusal("stale_owner");
}

export async function admitCreditCall(db: Database, input: CreditAdmissionInput): Promise<CreditAdmission> {
  if (
    !validAmount(input.amountNanoUsd) ||
    input.amountNanoUsd === 0 ||
    !validAmount(input.ownerEpoch) ||
    !SAFE_NAME.test(input.workUnitKey) ||
    !SAFE_NAME.test(input.attemptKey)
  )
    throw new CreditRouteRefusal("invalid_reservation");
  const now = input.now ?? (() => new Date());
  const bucket = input.bucket ?? "automatic";
  const {
    creditGrantCycles: c,
    creditRoutes: r,
    creditAttempts: a,
    creditWorkUnits: w,
    providerCredentials: k,
    creditReserveApprovals: ap,
  } = schema;
  return db.transaction(async (tx) => {
    const [hint] = await tx
      .select({ poolId: r.poolId })
      .from(r)
      .where(and(eq(r.orgId, input.orgId), eq(r.id, input.routeId)));
    if (!hint) throw new CreditRouteRefusal("disabled");
    const pool = await lockPool(tx, input.orgId, hint.poolId);
    const cycle = await lockCycle(tx, input.orgId, pool.id, input.cycleId);
    const [credential] = await tx
      .select()
      .from(k)
      .where(and(eq(k.orgId, input.orgId), eq(k.id, input.credentialId)))
      .for("update");
    const [route] = await tx
      .select()
      .from(r)
      .where(and(eq(r.orgId, input.orgId), eq(r.id, input.routeId)))
      .for("update");
    if (
      !route ||
      route.poolId !== pool.id ||
      route.credentialId !== input.credentialId ||
      route.model !== input.model ||
      route.credentialVersion !== input.credentialVersion
    )
      throw new CreditRouteRefusal("credential_changed");
    const refusal = refusalOf(pool, cycle, route, credential, input.need, now(), 0, bucket);
    if (refusal) throw new CreditRouteRefusal(refusal);
    const pricingSnapshot = assertCreditPricingEvidence(
      input.model,
      routePricingEvidence(route),
      now(),
      CREDIT_MAX_REQUEST_MS,
    );
    if (input.pricingProfileHash !== pricingSnapshot.profileHash) throw new CreditRouteRefusal("pricing_changed");
    const cacheTtl = input.cacheTtl ?? "default";
    assertCreditCachePolicy(pricingSnapshot, cacheTtl);
    await checkRun(tx, input.orgId, input.runId, input, now());
    await tx
      .insert(w)
      .values({
        orgId: input.orgId,
        workUnitKey: input.workUnitKey,
        runId: input.runId,
        ownerEpoch: input.ownerEpoch,
        ownerJobId: input.ownerJobId,
        ownerWorkerId: input.ownerWorkerId,
      })
      .onConflictDoNothing();
    const [unit] = await tx
      .select()
      .from(w)
      .where(and(eq(w.orgId, input.orgId), eq(w.workUnitKey, input.workUnitKey)))
      .for("update");
    if (
      !unit ||
      unit.runId !== input.runId ||
      (unit.ownerJobId === input.ownerJobId && unit.ownerEpoch > input.ownerEpoch)
    )
      throw new CreditRouteRefusal("stale_owner");
    if (unit.ownerJobId !== input.ownerJobId) {
      const [prior] = await tx
        .select()
        .from(schema.outbox)
        .where(and(eq(schema.outbox.orgId, input.orgId), eq(schema.outbox.id, unit.ownerJobId)));
      if (prior?.status === "processing" && prior.lockedUntil && prior.lockedUntil > now())
        throw new CreditRouteRefusal("stale_owner");
    }
    const [same] = await tx
      .select()
      .from(a)
      .where(and(eq(a.orgId, input.orgId), eq(a.attemptKey, input.attemptKey)))
      .for("update");
    if (same) {
      if (
        same.routeId !== route.id ||
        same.cycleId !== cycle.id ||
        same.workUnitKey !== input.workUnitKey ||
        same.runId !== input.runId ||
        same.ownerEpoch !== input.ownerEpoch ||
        same.ownerJobId !== input.ownerJobId ||
        same.ownerWorkerId !== input.ownerWorkerId ||
        same.amountNanoUsd !== input.amountNanoUsd ||
        same.pricingProfileHash !== input.pricingProfileHash ||
        same.pricingSnapshot.profileHash !== input.pricingProfileHash ||
        same.cacheTtl !== cacheTtl ||
        same.reservationNeed.tools !== input.need.tools ||
        same.reservationNeed.promptBytes !== input.need.promptBytes ||
        JSON.stringify([...(same.reservationNeed.capabilities ?? [])].sort()) !==
          JSON.stringify([...(input.need.capabilities ?? [])].sort()) ||
        same.bucket !== bucket ||
        same.approvalId !== (input.approvalId ?? null)
      )
        throw new CreditRouteRefusal("duplicate_attempt");
      if (same.state !== "held")
        throw new CreditRouteRefusal(
          same.state === "unknown" || same.state === "dispatching" ? "reconciliation_required" : "duplicate_attempt",
        );
      return {
        attemptId: same.id,
        poolId: pool.id,
        routeId: route.id,
        cycleId: cycle.id,
        ownerEpoch: input.ownerEpoch,
        replayed: true,
        pricingSnapshot: same.pricingSnapshot,
        cacheTtl: same.cacheTtl,
      };
    }
    const [open] = await tx
      .select({ state: a.state })
      .from(a)
      .where(
        and(
          eq(a.orgId, input.orgId),
          eq(a.workUnitKey, input.workUnitKey),
          inArray(a.state, ["held", "dispatching", "unknown", "settled"]),
        ),
      )
      .limit(1);
    if (open) throw new CreditRouteRefusal(open.state === "settled" ? "duplicate_attempt" : "reconciliation_required");
    // A crash may have left another call of this logical run in flight on another provider.
    const [runOpen] = await tx
      .select({ id: a.id })
      .from(a)
      .where(
        and(eq(a.orgId, input.orgId), eq(a.runId, input.runId), inArray(a.state, ["held", "dispatching", "unknown"])),
      )
      .limit(1);
    if (runOpen) throw new CreditRouteRefusal("reconciliation_required");
    if (input.amountNanoUsd > available(cycle, bucket)) throw new CreditRouteRefusal("budget_exhausted");
    if (bucket === "emergency") {
      if (!input.approvalId) throw new CreditRouteRefusal("spend_approval_required");
      const [approval] = await tx
        .select()
        .from(ap)
        .where(and(eq(ap.orgId, input.orgId), eq(ap.id, input.approvalId)))
        .for("update");
      if (
        !approval ||
        approval.poolId !== pool.id ||
        approval.cycleId !== cycle.id ||
        approval.revokedAt ||
        approval.approvedAt > now() ||
        approval.validUntil.getTime() < now().getTime() + CREDIT_MAX_REQUEST_MS ||
        sum(approval.heldNanoUsd, approval.spentNanoUsd, input.amountNanoUsd) > approval.amountNanoUsd
      )
        throw new CreditRouteRefusal("spend_approval_required");
      await owner(tx, input.orgId, approval.actorUserId);
      await tx
        .update(ap)
        .set({ heldNanoUsd: sum(approval.heldNanoUsd, input.amountNanoUsd) })
        .where(eq(ap.id, approval.id));
    }
    await tx
      .update(w)
      .set({ ownerEpoch: input.ownerEpoch, ownerJobId: input.ownerJobId, ownerWorkerId: input.ownerWorkerId })
      .where(eq(w.id, unit.id));
    const [attempt] = await tx
      .insert(a)
      .values({
        orgId: input.orgId,
        poolId: pool.id,
        cycleId: cycle.id,
        routeId: route.id,
        runId: input.runId,
        agentId: input.agentId ?? null,
        workUnitKey: input.workUnitKey,
        attemptKey: input.attemptKey,
        ownerEpoch: input.ownerEpoch,
        ownerJobId: input.ownerJobId,
        ownerWorkerId: input.ownerWorkerId,
        amountNanoUsd: input.amountNanoUsd,
        pricingSnapshot,
        pricingProfileHash: pricingSnapshot.profileHash,
        cacheTtl,
        bucket,
        reservationNeed: {
          tools: input.need.tools,
          promptBytes: input.need.promptBytes,
          capabilities: [...(input.need.capabilities ?? [])].sort(),
        },
        approvalId: input.approvalId ?? null,
        createdAt: now(),
      })
      .returning({ id: a.id });
    if (!attempt) throw new Error("credit reservation was not inserted");
    await tx
      .update(c)
      .set(
        bucket === "automatic"
          ? { heldAutomaticNanoUsd: sum(cycle.heldAutomaticNanoUsd, input.amountNanoUsd) }
          : { heldEmergencyNanoUsd: sum(cycle.heldEmergencyNanoUsd, input.amountNanoUsd) },
      )
      .where(eq(c.id, cycle.id));
    return {
      attemptId: attempt.id,
      poolId: pool.id,
      routeId: route.id,
      cycleId: cycle.id,
      ownerEpoch: input.ownerEpoch,
      replayed: false,
      pricingSnapshot,
      cacheTtl,
    };
  });
}

/** Persist intent before transport. A second caller never receives authorization to send the same attempt. */
export async function markCreditAttemptDispatched(
  db: Database,
  orgId: string,
  attemptId: string,
  input: { ownerEpoch: number; ownerJobId: string; ownerWorkerId: string; runId: string; now?: () => Date },
): Promise<void> {
  const { creditAttempts: a, creditWorkUnits: w, creditRoutes: r, providerCredentials: k } = schema;
  await db.transaction(async (tx) => {
    const [hint] = await tx
      .select()
      .from(a)
      .where(and(eq(a.orgId, orgId), eq(a.id, attemptId)));
    if (!hint) throw new CreditRouteRefusal("invalid_reservation");
    const pool = await lockPool(tx, orgId, hint.poolId);
    const cycle = await lockCycle(tx, orgId, pool.id, hint.cycleId);
    const [route] = await tx
      .select()
      .from(r)
      .where(and(eq(r.orgId, orgId), eq(r.id, hint.routeId)))
      .for("update");
    const [credential] = route
      ? await tx
          .select()
          .from(k)
          .where(and(eq(k.orgId, orgId), eq(k.id, route.credentialId)))
      : [];
    const at = (input.now ?? (() => new Date()))();
    if (!route) throw new CreditRouteRefusal("disabled");
    const reason = refusalOf(pool, cycle, route, credential, hint.reservationNeed, at, 0, hint.bucket as CreditBucket);
    if (reason) throw new CreditRouteRefusal(reason);
    if (
      hint.pricingProfileHash !== route.pricingProfileHash ||
      hint.pricingSnapshot.profileHash !== hint.pricingProfileHash
    )
      throw new CreditRouteRefusal("pricing_changed");
    creditReceiptCost(
      hint.pricingSnapshot,
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      hint.cacheTtl,
    );
    const protectedAmount =
      held(cycle) +
      cycle.safetyBufferNanoUsd +
      (hint.bucket === "automatic"
        ? Math.max(0, cycle.emergencyLimitNanoUsd - cycle.spentEmergencyNanoUsd - cycle.heldEmergencyNanoUsd)
        : 0);
    if (
      remainingGrant(cycle) < protectedAmount ||
      cycle.spentAutomaticNanoUsd + cycle.heldAutomaticNanoUsd > cycle.automaticLimitNanoUsd ||
      cycle.spentEmergencyNanoUsd + cycle.heldEmergencyNanoUsd > cycle.emergencyLimitNanoUsd
    )
      throw new CreditRouteRefusal("budget_exhausted");
    await checkRun(tx, orgId, input.runId, input, at);
    const [unit] = await tx
      .select()
      .from(w)
      .where(and(eq(w.orgId, orgId), eq(w.workUnitKey, hint.workUnitKey)))
      .for("update");
    const [attempt] = await tx
      .select()
      .from(a)
      .where(and(eq(a.orgId, orgId), eq(a.id, attemptId)))
      .for("update");
    if (
      !attempt ||
      attempt.runId !== input.runId ||
      attempt.ownerEpoch !== input.ownerEpoch ||
      attempt.ownerJobId !== input.ownerJobId ||
      attempt.ownerWorkerId !== input.ownerWorkerId ||
      !unit ||
      unit.ownerEpoch !== input.ownerEpoch ||
      unit.ownerJobId !== input.ownerJobId ||
      unit.ownerWorkerId !== input.ownerWorkerId ||
      unit.runId !== input.runId
    )
      throw new CreditRouteRefusal("stale_owner");
    if (attempt.state !== "held") throw new CreditRouteRefusal("duplicate_attempt");
    if (attempt.bucket === "emergency") {
      const [approval] = await tx
        .select()
        .from(schema.creditReserveApprovals)
        .where(eq(schema.creditReserveApprovals.id, attempt.approvalId ?? "00000000-0000-0000-0000-000000000000"));
      if (
        !approval ||
        approval.orgId !== orgId ||
        approval.cycleId !== cycle.id ||
        approval.revokedAt ||
        approval.validUntil.getTime() < at.getTime() + CREDIT_MAX_REQUEST_MS
      )
        throw new CreditRouteRefusal("spend_approval_required");
      await owner(tx, orgId, approval.actorUserId);
    }
    await tx.update(a).set({ state: "dispatching", dispatchedAt: at }).where(eq(a.id, attemptId));
  });
}

export type CreditSettlement =
  | {
      kind: "settled";
      actualNanoUsd: number;
      providerRequestId?: string;
      reconciliation?: { actorUserId: string; evidenceRef: string };
    }
  | {
      kind: "released";
      reason: string;
      providerRefusal?: boolean;
      reconciliation?: { actorUserId: string; evidenceRef: string };
    }
  | { kind: "unknown"; reason: string };

/** Settlement is idempotent, but a conflicting repeated amount is an accounting incident, not success. */
export async function settleCreditAttempt(
  db: Database,
  orgId: string,
  attemptId: string,
  settlement: CreditSettlement,
  now: () => Date = () => new Date(),
): Promise<{ changed: boolean; state: string }> {
  const { creditAttempts: a, creditGrantCycles: c, creditPools: p, creditReserveApprovals: ap } = schema;
  const result = await db.transaction(async (tx) => {
    const [hint] = await tx
      .select()
      .from(a)
      .where(and(eq(a.orgId, orgId), eq(a.id, attemptId)));
    if (!hint) throw new Error("credit attempt not found");
    const pool = await lockPool(tx, orgId, hint.poolId);
    const cycle = await lockCycle(tx, orgId, pool.id, hint.cycleId);
    const [attempt] = await tx
      .select()
      .from(a)
      .where(and(eq(a.orgId, orgId), eq(a.id, attemptId)))
      .for("update");
    if (!attempt) throw new Error("credit attempt not found");
    if (attempt.state === "settled" || attempt.state === "released") {
      if (
        settlement.kind === attempt.state &&
        (settlement.kind !== "settled" || settlement.actualNanoUsd === attempt.actualNanoUsd)
      )
        return { changed: false, state: attempt.state };
      await tx.update(p).set({ paused: true, status: "reconciliation_required" }).where(eq(p.id, pool.id));
      return { changed: false, state: "conflicting" };
    }
    if (settlement.kind === "unknown") {
      if (attempt.state === "unknown") return { changed: false, state: "unknown" };
      await tx
        .update(a)
        .set({ state: "unknown", reason: settlement.reason.slice(0, 300) })
        .where(eq(a.id, attempt.id));
      await tx.update(p).set({ status: "reconciliation_required" }).where(eq(p.id, pool.id));
      return { changed: true, state: "unknown" };
    }
    if (settlement.reconciliation) {
      if (!SAFE_NAME.test(settlement.reconciliation.evidenceRef))
        throw new CreditRouteRefusal("reconciliation_required");
      await owner(tx, orgId, settlement.reconciliation.actorUserId);
    }
    if (settlement.kind === "settled" && attempt.state === "unknown") {
      if (!settlement.reconciliation || !SAFE_NAME.test(settlement.reconciliation.evidenceRef))
        throw new CreditRouteRefusal("reconciliation_required");
      await owner(tx, orgId, settlement.reconciliation.actorUserId);
    }
    if (settlement.kind === "released" && attempt.state !== "held") {
      if (attempt.state === "unknown" || !settlement.providerRefusal) {
        if (!settlement.reconciliation || !SAFE_NAME.test(settlement.reconciliation.evidenceRef))
          throw new CreditRouteRefusal("reconciliation_required");
        await owner(tx, orgId, settlement.reconciliation.actorUserId);
      }
    }
    const actual = settlement.kind === "settled" ? settlement.actualNanoUsd : 0;
    if (!validAmount(actual)) throw new CreditRouteRefusal("invalid_reservation");
    const automatic = attempt.bucket === "automatic";
    const currentHeld = automatic ? cycle.heldAutomaticNanoUsd : cycle.heldEmergencyNanoUsd;
    if (currentHeld < attempt.amountNanoUsd) throw new Error("credit hold inconsistent");
    await tx
      .update(a)
      .set({
        state: settlement.kind,
        actualNanoUsd: actual,
        reason: settlement.kind === "released" ? settlement.reason.slice(0, 300) : null,
        providerRequestId: settlement.kind === "settled" ? (settlement.providerRequestId?.slice(0, 200) ?? null) : null,
        settledAt: now(),
      })
      .where(eq(a.id, attempt.id));
    await tx
      .update(c)
      .set(
        automatic
          ? {
              heldAutomaticNanoUsd: currentHeld - attempt.amountNanoUsd,
              spentAutomaticNanoUsd: sum(cycle.spentAutomaticNanoUsd, actual),
            }
          : {
              heldEmergencyNanoUsd: currentHeld - attempt.amountNanoUsd,
              spentEmergencyNanoUsd: sum(cycle.spentEmergencyNanoUsd, actual),
            },
      )
      .where(eq(c.id, cycle.id));
    if (attempt.approvalId) {
      const [approval] = await tx
        .select()
        .from(ap)
        .where(and(eq(ap.orgId, orgId), eq(ap.id, attempt.approvalId)))
        .for("update");
      if (!approval || approval.heldNanoUsd < attempt.amountNanoUsd)
        throw new Error("credit approval hold inconsistent");
      await tx
        .update(ap)
        .set({
          heldNanoUsd: approval.heldNanoUsd - attempt.amountNanoUsd,
          spentNanoUsd: sum(approval.spentNanoUsd, actual),
        })
        .where(eq(ap.id, approval.id));
    }
    if (actual > attempt.amountNanoUsd)
      await tx.update(p).set({ paused: true, status: "reconciliation_required" }).where(eq(p.id, pool.id));
    if (settlement.reconciliation) {
      await recordAudit(tx, {
        orgId,
        actor: { type: "person", id: settlement.reconciliation.actorUserId },
        action: "credit.reconciled",
        target: { type: "credit_attempt", id: attempt.id },
        runId: attempt.runId,
        details: {
          poolId: pool.id,
          cycleId: cycle.id,
          evidenceRef: settlement.reconciliation.evidenceRef,
          previousState: attempt.state,
          outcome: settlement.kind,
          actualNanoUsd: actual,
          reconciledAt: now().toISOString(),
        },
      });
    }
    return { changed: true, state: settlement.kind };
  });
  if (result.state === "conflicting") throw new Error("conflicting credit settlement requires reconciliation");
  return result;
}

/** Owner-only reconciliation of an unknown debit; no new request or task completion is implied. */
export async function reconcileCreditAttempt(
  db: Database,
  orgId: string,
  attemptId: string,
  actorUserId: string,
  input: { evidenceRef: string; actualNanoUsd?: number; reason: string },
  now: () => Date = () => new Date(),
) {
  if (!SAFE_NAME.test(input.evidenceRef)) throw new CreditRouteRefusal("reconciliation_required");
  await owner(db, orgId, actorUserId);
  const reconciliation = { actorUserId, evidenceRef: input.evidenceRef };
  return settleCreditAttempt(
    db,
    orgId,
    attemptId,
    input.actualNanoUsd === undefined
      ? { kind: "released", reason: input.reason, reconciliation }
      : { kind: "settled", actualNanoUsd: input.actualNanoUsd, reconciliation },
    now,
  );
}

export async function markCreditPool(
  db: Database,
  orgId: string,
  poolId: string,
  status: "exhausted" | "billing_blocked" | "expired" | "reconciliation_required",
): Promise<void> {
  await db
    .update(schema.creditPools)
    .set({ status })
    .where(and(eq(schema.creditPools.orgId, orgId), eq(schema.creditPools.id, poolId)));
}

/** Official Billing evidence is required. A subscription label, model list or API success is not evidence. */
export interface CreditPoolEvidence {
  provider: CreditProvider;
  upstreamAccount: string;
  product: "openai_pro_api" | "claude_ultra_api";
  cycleKey: string;
  grantId: string;
  grantStart: Date;
  grantEnd: Date;
  eligibleSince: Date;
  activatedAt: Date;
  enforcement: "prepaid_grant_only";
  externalSpendCoverage: "exclusive" | "bounded";
  externalSpendBoundNanoUsd: number;
  evidenceRef: string;
  verifiedByUserId: string;
  verifiedAt: Date;
  validUntil: Date;
  grantAmountNanoUsd: number;
  observedRemainingNanoUsd: number;
}
function validateEvidence(e: CreditPoolEvidence, at: Date = new Date()) {
  const dates = [e.grantStart, e.grantEnd, e.eligibleSince, e.activatedAt, e.verifiedAt, e.validUntil];
  if (
    ![e.upstreamAccount, e.cycleKey, e.grantId, e.evidenceRef].every(
      (v) => typeof v === "string" && SAFE_NAME.test(v),
    ) ||
    !dates.every(validDate) ||
    e.verifiedAt > at ||
    e.grantStart >= e.grantEnd ||
    e.verifiedAt >= e.validUntil ||
    e.validUntil > e.grantEnd ||
    e.validUntil.getTime() - e.verifiedAt.getTime() > 86_400_000 ||
    e.eligibleSince.getTime() + 7 * 86_400_000 > e.verifiedAt.getTime() ||
    e.activatedAt > e.verifiedAt ||
    e.verifiedAt < e.grantStart ||
    e.enforcement !== "prepaid_grant_only" ||
    !["exclusive", "bounded"].includes(e.externalSpendCoverage) ||
    ![e.grantAmountNanoUsd, e.observedRemainingNanoUsd, e.externalSpendBoundNanoUsd].every(validAmount) ||
    e.observedRemainingNanoUsd > e.grantAmountNanoUsd ||
    (e.externalSpendCoverage === "exclusive" && e.externalSpendBoundNanoUsd !== 0) ||
    (e.provider === "openai"
      ? e.product !== "openai_pro_api"
      : e.provider !== "anthropic" || e.product !== "claude_ultra_api")
  )
    throw new CreditRouteRefusal("grant_unverified");
}
function cycleValues(orgId: string, poolId: string, e: CreditPoolEvidence) {
  const { provider: _provider, upstreamAccount: _account, ...rest } = e;
  return { orgId, poolId, ...rest, ...creditBudgetForGrant(e.grantAmountNanoUsd) };
}

export async function registerCreditPool(
  db: Database,
  orgId: string,
  evidence: CreditPoolEvidence,
  now: () => Date = () => new Date(),
): Promise<string> {
  validateEvidence(evidence, now());
  return db.transaction(async (tx) => {
    await owner(tx, orgId, evidence.verifiedByUserId);
    const [pool] = await tx
      .insert(schema.creditPools)
      .values({
        orgId,
        upstreamNamespace: evidence.provider,
        upstreamAccount: evidence.upstreamAccount,
        status: "available",
      })
      .returning();
    if (!pool) throw new Error("credit pool insert returned nothing");
    const [cycle] = await tx
      .insert(schema.creditGrantCycles)
      .values(cycleValues(orgId, pool.id, evidence))
      .returning();
    if (!cycle) throw new Error("credit cycle insert returned nothing");
    await tx.update(schema.creditPools).set({ currentCycleId: cycle.id }).where(eq(schema.creditPools.id, pool.id));
    return pool.id;
  });
}

/** A later billing cycle is a new retained row. No pending old debit is forgiven by rollover. */
export async function startCreditGrantCycle(
  db: Database,
  orgId: string,
  poolId: string,
  evidence: CreditPoolEvidence,
  now: () => Date = () => new Date(),
): Promise<string> {
  validateEvidence(evidence, now());
  return db.transaction(async (tx) => {
    const pool = await lockPool(tx, orgId, poolId);
    await owner(tx, orgId, evidence.verifiedByUserId);
    if (evidence.provider !== pool.upstreamNamespace || evidence.upstreamAccount !== pool.upstreamAccount)
      throw new CreditRouteRefusal("account_mismatch");
    if (pool.currentCycleId) {
      const old = await lockCycle(tx, orgId, poolId, pool.currentCycleId);
      if (evidence.grantStart < old.grantEnd || evidence.cycleKey === old.cycleKey)
        throw new CreditRouteRefusal("cycle_mismatch");
    }
    const [open] = await tx
      .select({ id: schema.creditAttempts.id })
      .from(schema.creditAttempts)
      .where(
        and(
          eq(schema.creditAttempts.orgId, orgId),
          eq(schema.creditAttempts.poolId, poolId),
          inArray(schema.creditAttempts.state, ["held", "dispatching", "unknown"]),
        ),
      )
      .limit(1);
    if (open) throw new CreditRouteRefusal("reconciliation_required");
    const [cycle] = await tx
      .insert(schema.creditGrantCycles)
      .values(cycleValues(orgId, poolId, evidence))
      .returning();
    if (!cycle) throw new Error("credit cycle insert returned nothing");
    await tx
      .update(schema.creditPools)
      .set({ currentCycleId: cycle.id, status: "available", paused: false, enabled: false })
      .where(eq(schema.creditPools.id, poolId));
    return cycle.id;
  });
}

export async function refreshCreditPoolEvidence(
  db: Database,
  orgId: string,
  poolId: string,
  e: CreditPoolEvidence,
  now: () => Date = () => new Date(),
): Promise<void> {
  validateEvidence(e, now());
  await db.transaction(async (tx) => {
    const pool = await lockPool(tx, orgId, poolId);
    await owner(tx, orgId, e.verifiedByUserId);
    if (!pool.currentCycleId) throw new CreditRouteRefusal("grant_unverified");
    const cycle = await lockCycle(tx, orgId, poolId, pool.currentCycleId);
    if (
      e.provider !== pool.upstreamNamespace ||
      e.upstreamAccount !== pool.upstreamAccount ||
      e.cycleKey !== cycle.cycleKey ||
      e.grantId !== cycle.grantId ||
      e.product !== cycle.product ||
      +e.grantStart !== +cycle.grantStart ||
      +e.grantEnd !== +cycle.grantEnd ||
      e.grantAmountNanoUsd > cycle.grantAmountNanoUsd ||
      e.verifiedAt < cycle.verifiedAt
    )
      throw new CreditRouteRefusal("cycle_mismatch");
    const limits = creditBudgetForGrant(e.grantAmountNanoUsd);
    // A lagging dashboard cannot restore money already spent. External reserve is separately deducted below.
    const conservativelyRemaining = Math.min(
      e.observedRemainingNanoUsd,
      cycle.observedRemainingNanoUsd - Math.max(0, spent(cycle) - cycle.localSpentAtObservationNanoUsd),
    );
    await tx
      .update(schema.creditGrantCycles)
      .set({
        evidenceRef: e.evidenceRef,
        verifiedByUserId: e.verifiedByUserId,
        verifiedAt: e.verifiedAt,
        validUntil: e.validUntil,
        observedRemainingNanoUsd: Math.max(0, conservativelyRemaining),
        localSpentAtObservationNanoUsd: spent(cycle),
        grantAmountNanoUsd: e.grantAmountNanoUsd,
        externalSpendCoverage: e.externalSpendCoverage,
        externalSpendBoundNanoUsd: Math.max(cycle.externalSpendBoundNanoUsd, e.externalSpendBoundNanoUsd),
        automaticLimitNanoUsd: Math.min(cycle.automaticLimitNanoUsd, limits.automaticLimitNanoUsd),
        emergencyLimitNanoUsd: Math.min(cycle.emergencyLimitNanoUsd, limits.emergencyLimitNanoUsd),
        safetyBufferNanoUsd: limits.safetyBufferNanoUsd,
      })
      .where(eq(schema.creditGrantCycles.id, cycle.id));
    const [unresolved] = await tx
      .select({ id: schema.creditAttempts.id })
      .from(schema.creditAttempts)
      .where(
        and(
          eq(schema.creditAttempts.orgId, orgId),
          eq(schema.creditAttempts.poolId, poolId),
          inArray(schema.creditAttempts.state, ["dispatching", "unknown"]),
        ),
      )
      .limit(1);
    // New evidence does not override a debt/overrun breaker or a still uncertain provider request.
    if (!unresolved && !pool.paused)
      await tx.update(schema.creditPools).set({ status: "available" }).where(eq(schema.creditPools.id, poolId));
  });
}

export async function registerCreditRoute(
  db: Database,
  orgId: string,
  input: {
    poolId: string;
    credentialId: string;
    model: string;
    supportsTools: boolean;
    maxPromptBytes: number;
    routeKind: "openai_responses" | "anthropic_messages" | "claude_agent_sdk";
    accountEvidenceRef: string;
    capabilities?: string[];
    pricingEvidence: CreditPricingEvidence;
  },
  now: () => Date = () => new Date(),
  actorUserId?: string,
): Promise<string> {
  if (
    !SAFE_NAME.test(input.accountEvidenceRef) ||
    !SAFE_NAME.test(input.model) ||
    !validAmount(input.maxPromptBytes) ||
    input.maxPromptBytes === 0 ||
    (input.capabilities ?? []).some((c) => !SAFE_NAME.test(c))
  )
    throw new CreditRouteRefusal("unsupported_capability");
  const profile = assertCreditPricingEvidence(input.model, input.pricingEvidence, now(), CREDIT_MAX_REQUEST_MS);
  return db.transaction(async (tx) => {
    const pool = await lockPool(tx, orgId, input.poolId);
    if (actorUserId) await owner(tx, orgId, actorUserId);
    assertCreditPricingEvidence(input.model, input.pricingEvidence, now(), CREDIT_MAX_REQUEST_MS);
    if (profile.provider !== pool.upstreamNamespace) throw new CreditRouteRefusal("account_mismatch");
    const [credential] = await tx
      .select()
      .from(schema.providerCredentials)
      .where(and(eq(schema.providerCredentials.orgId, orgId), eq(schema.providerCredentials.id, input.credentialId)))
      .for("update");
    if (
      !credential ||
      credential.revokedAt ||
      credential.provider !== pool.upstreamNamespace ||
      !credential.secretFingerprint ||
      !FINGERPRINT.test(credential.secretFingerprint)
    )
      throw new CreditRouteRefusal("credential_changed");
    if (credential.options?.endpoint) throw new CreditRouteRefusal("endpoint_mismatch");
    if (
      pool.upstreamNamespace === "openai"
        ? credential.options?.organization !== pool.upstreamAccount || input.routeKind !== "openai_responses"
        : input.routeKind !== "anthropic_messages"
    )
      throw new CreditRouteRefusal("account_mismatch");
    const [other] = await tx
      .select({ poolId: schema.creditRoutes.poolId })
      .from(schema.creditRoutes)
      .where(and(eq(schema.creditRoutes.orgId, orgId), eq(schema.creditRoutes.credentialId, input.credentialId)))
      .limit(1);
    if (other && other.poolId !== pool.id) throw new CreditRouteRefusal("account_mismatch");
    const { pricingEvidence, ...routeInput } = input;
    const [route] = await tx
      .insert(schema.creditRoutes)
      .values({
        orgId,
        ...routeInput,
        credentialVersion: credentialVersion(credential),
        credentialFingerprint: credential.secretFingerprint,
        pricingEvidenceRef: pricingEvidence.evidenceRef,
        pricingVerifiedAt: pricingEvidence.verifiedAt,
        pricingValidUntil: pricingEvidence.validUntil,
        pricingProfileHash: pricingEvidence.profileHash,
        capabilities: input.capabilities ?? [],
      })
      .returning({ id: schema.creditRoutes.id });
    if (!route) throw new Error("credit route insert returned nothing");
    if (actorUserId)
      await recordAudit(tx, {
        orgId,
        actor: { type: "person", id: actorUserId },
        action: "credit.route_registered",
        target: { type: "credit_route", id: route.id },
        details: {
          poolId: pool.id,
          enabled: false,
          pricingEvidenceRef: pricingEvidence.evidenceRef,
          pricingProfileHash: pricingEvidence.profileHash,
          pricingVerifiedAt: pricingEvidence.verifiedAt.toISOString(),
          pricingValidUntil: pricingEvidence.validUntil.toISOString(),
        },
      });
    return route.id;
  });
}

/** Renewing tariff evidence never changes the credential fingerprint or automatically enables a route. */
export async function refreshCreditRoutePricingEvidence(
  db: Database,
  orgId: string,
  routeId: string,
  evidence: CreditPricingEvidence,
  now: () => Date = () => new Date(),
  actorUserId?: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [hint] = await tx
      .select()
      .from(schema.creditRoutes)
      .where(and(eq(schema.creditRoutes.orgId, orgId), eq(schema.creditRoutes.id, routeId)));
    if (!hint) throw new CreditRouteRefusal("disabled");
    await lockPool(tx, orgId, hint.poolId);
    if (actorUserId) await owner(tx, orgId, actorUserId);
    const [credential] = await tx
      .select()
      .from(schema.providerCredentials)
      .where(and(eq(schema.providerCredentials.orgId, orgId), eq(schema.providerCredentials.id, hint.credentialId)))
      .for("update");
    const [route] = await tx
      .select()
      .from(schema.creditRoutes)
      .where(and(eq(schema.creditRoutes.orgId, orgId), eq(schema.creditRoutes.id, routeId)))
      .for("update");
    if (
      !route ||
      !credential ||
      credential.revokedAt ||
      credentialVersion(credential) !== route.credentialVersion ||
      !credential.secretFingerprint ||
      credential.secretFingerprint !== route.credentialFingerprint
    )
      throw new CreditRouteRefusal("credential_changed");
    assertCreditPricingEvidence(route.model, evidence, now(), CREDIT_MAX_REQUEST_MS);
    if (evidence.verifiedAt < route.pricingVerifiedAt) throw new CreditRouteRefusal("pricing_expired");
    await tx
      .update(schema.creditRoutes)
      .set({
        pricingEvidenceRef: evidence.evidenceRef,
        pricingVerifiedAt: evidence.verifiedAt,
        pricingValidUntil: evidence.validUntil,
        pricingProfileHash: evidence.profileHash,
        enabled: false,
      })
      .where(eq(schema.creditRoutes.id, routeId));
    if (actorUserId)
      await recordAudit(tx, {
        orgId,
        actor: { type: "person", id: actorUserId },
        action: "credit.pricing_verified",
        target: { type: "credit_route", id: routeId },
        details: {
          enabled: false,
          pricingEvidenceRef: evidence.evidenceRef,
          pricingProfileHash: evidence.profileHash,
          pricingVerifiedAt: evidence.verifiedAt.toISOString(),
          pricingValidUntil: evidence.validUntil.toISOString(),
        },
      });
  });
}

export async function setCreditRouteEnabled(
  db: Database,
  orgId: string,
  routeId: string,
  enabled: boolean,
  now: () => Date = () => new Date(),
  actorUserId?: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [hint] = await tx
      .select()
      .from(schema.creditRoutes)
      .where(and(eq(schema.creditRoutes.orgId, orgId), eq(schema.creditRoutes.id, routeId)));
    if (!hint) throw new CreditRouteRefusal("disabled");
    const pool = await lockPool(tx, orgId, hint.poolId);
    if (actorUserId) await owner(tx, orgId, actorUserId);
    const [route] = await tx
      .select()
      .from(schema.creditRoutes)
      .where(and(eq(schema.creditRoutes.orgId, orgId), eq(schema.creditRoutes.id, routeId)))
      .for("update");
    if (!route || route.poolId !== pool.id) throw new CreditRouteRefusal("disabled");
    if (enabled) {
      if (!pool.currentCycleId) throw new CreditRouteRefusal("grant_unverified");
      const cycle = await lockCycle(tx, orgId, pool.id, pool.currentCycleId);
      const [credential] = await tx
        .select()
        .from(schema.providerCredentials)
        .where(and(eq(schema.providerCredentials.orgId, orgId), eq(schema.providerCredentials.id, route.credentialId)));
      const reason = refusalOf(
        { ...pool, enabled: true },
        cycle,
        { ...route, enabled: true },
        credential,
        { tools: false, promptBytes: 0 },
        now(),
        0,
        "automatic",
      );
      if (reason) throw new CreditRouteRefusal(reason);
    }
    if (enabled) await tx.update(schema.creditPools).set({ enabled: true }).where(eq(schema.creditPools.id, pool.id));
    await tx.update(schema.creditRoutes).set({ enabled }).where(eq(schema.creditRoutes.id, routeId));
    if (actorUserId)
      await recordAudit(tx, {
        orgId,
        actor: { type: "person", id: actorUserId },
        action: enabled ? "credit.route_enabled" : "credit.route_disabled",
        target: { type: "credit_route", id: routeId },
        details: {
          enabled,
          poolId: pool.id,
          cycleId: pool.currentCycleId,
          pricingEvidenceRef: route.pricingEvidenceRef,
          pricingProfileHash: route.pricingProfileHash,
          decidedAt: now().toISOString(),
        },
      });
  });
}
export async function disableCreditRoute(db: Database, orgId: string, credentialId: string): Promise<void> {
  await db
    .update(schema.creditRoutes)
    .set({ enabled: false })
    .where(and(eq(schema.creditRoutes.orgId, orgId), eq(schema.creditRoutes.credentialId, credentialId)));
}
export function createCreditRouteQualifier(db: Database) {
  return {
    qualify: (input: { orgId: string; need: CreditNeed; routeId?: string; provider?: CreditProvider }) =>
      qualifyCreditRoute(db, input),
  };
}

export async function approveCreditReserve(
  db: Database,
  orgId: string,
  poolId: string,
  actorUserId: string,
  input: { cycleId: string; amountNanoUsd: number; validUntil: Date; decisionKey: string; evidenceRef: string },
  now: () => Date = () => new Date(),
): Promise<string> {
  if (
    !validAmount(input.amountNanoUsd) ||
    input.amountNanoUsd === 0 ||
    !SAFE_NAME.test(input.decisionKey) ||
    !SAFE_NAME.test(input.evidenceRef) ||
    !validDate(input.validUntil)
  )
    throw new CreditRouteRefusal("spend_approval_required");
  return db.transaction(async (tx) => {
    const pool = await lockPool(tx, orgId, poolId);
    await owner(tx, orgId, actorUserId);
    if (pool.currentCycleId !== input.cycleId) throw new CreditRouteRefusal("cycle_mismatch");
    const cycle = await lockCycle(tx, orgId, poolId, input.cycleId);
    if (
      input.amountNanoUsd > cycle.emergencyLimitNanoUsd ||
      input.validUntil <= now() ||
      input.validUntil > cycle.grantEnd
    )
      throw new CreditRouteRefusal("spend_approval_required");
    const [existing] = await tx
      .select()
      .from(schema.creditReserveApprovals)
      .where(
        and(
          eq(schema.creditReserveApprovals.orgId, orgId),
          eq(schema.creditReserveApprovals.decisionKey, input.decisionKey),
        ),
      );
    if (existing) {
      if (
        existing.actorUserId !== actorUserId ||
        existing.poolId !== poolId ||
        existing.cycleId !== input.cycleId ||
        existing.amountNanoUsd !== input.amountNanoUsd ||
        +existing.validUntil !== +input.validUntil ||
        existing.revokedAt
      )
        throw new CreditRouteRefusal("spend_approval_required");
      return existing.id;
    }
    const [row] = await tx
      .insert(schema.creditReserveApprovals)
      .values({ orgId, poolId, actorUserId, ...input, approvedAt: now() })
      .returning({ id: schema.creditReserveApprovals.id });
    if (!row) throw new Error("credit reserve approval was not inserted");
    return row.id;
  });
}

/** Read-only recovery: process restarts do not release holds or create new attempts. */
export async function recoverCreditReservations(db: Database, orgId: string) {
  return db
    .select({
      attemptId: schema.creditAttempts.id,
      poolId: schema.creditAttempts.poolId,
      cycleId: schema.creditAttempts.cycleId,
      runId: schema.creditAttempts.runId,
      workUnitKey: schema.creditAttempts.workUnitKey,
      state: schema.creditAttempts.state,
      amountNanoUsd: schema.creditAttempts.amountNanoUsd,
    })
    .from(schema.creditAttempts)
    .where(
      and(
        eq(schema.creditAttempts.orgId, orgId),
        inArray(schema.creditAttempts.state, ["held", "dispatching", "unknown"]),
      ),
    );
}

/** Sanitized projection for the existing inspector/dashboard. No credential values or transcripts. */
export async function creditLedgerSnapshot(db: Database, orgId: string, now: () => Date = () => new Date()) {
  const at = now();
  const { creditPools: p, creditGrantCycles: c } = schema;
  const rows = await db
    .select({ pool: p, cycle: c })
    .from(p)
    .leftJoin(c, and(eq(c.orgId, p.orgId), eq(c.id, p.currentCycleId)))
    .where(eq(p.orgId, orgId))
    .orderBy(p.upstreamNamespace);
  const routeRows = await db
    .select({ route: schema.creditRoutes, credential: schema.providerCredentials })
    .from(schema.creditRoutes)
    .leftJoin(
      schema.providerCredentials,
      and(
        eq(schema.providerCredentials.orgId, schema.creditRoutes.orgId),
        eq(schema.providerCredentials.id, schema.creditRoutes.credentialId),
      ),
    )
    .where(eq(schema.creditRoutes.orgId, orgId));
  const approvalRows = await db
    .select()
    .from(schema.creditReserveApprovals)
    .where(eq(schema.creditReserveApprovals.orgId, orgId));
  const readiness = new Map<
    string,
    {
      eligibleRouteCount: number;
      pricingStatus: "verified" | "expired" | "changed" | "unverified";
      approvedEmergencyAvailableNanoUsd: number;
      activeReserveApprovalCount: number;
    }
  >();
  for (const { pool, cycle } of rows) {
    let eligibleRouteCount = 0;
    let pricingStatus: "verified" | "expired" | "changed" | "unverified" = "unverified";
    for (const { route, credential } of routeRows) {
      if (route.poolId !== pool.id) continue;
      try {
        assertCreditPricingEvidence(route.model, routePricingEvidence(route), at, CREDIT_MAX_REQUEST_MS);
        pricingStatus = "verified";
      } catch (error) {
        if (pricingStatus !== "verified" && error instanceof CreditRouteRefusal)
          pricingStatus =
            error.reason === "pricing_expired"
              ? "expired"
              : error.reason === "pricing_changed"
                ? "changed"
                : "unverified";
      }
      if (
        !refusalOf(
          pool,
          cycle ?? undefined,
          route,
          credential ?? undefined,
          { tools: false, promptBytes: 0 },
          at,
          0,
          "automatic",
        )
      )
        eligibleRouteCount++;
    }
    let approvedEmergencyAvailableNanoUsd = 0;
    let activeReserveApprovalCount = 0;
    if (cycle) {
      const emergencyRoom = available(cycle, "emergency");
      for (const approval of approvalRows) {
        if (
          approval.poolId !== pool.id ||
          approval.cycleId !== cycle.id ||
          approval.revokedAt ||
          approval.approvedAt > at ||
          approval.validUntil.getTime() < at.getTime() + CREDIT_MAX_REQUEST_MS
        )
          continue;
        const room = Math.max(0, approval.amountNanoUsd - approval.spentNanoUsd - approval.heldNanoUsd);
        if (room <= 0) continue;
        const membership = await getMembership(db, approval.actorUserId, orgId);
        if (membership?.role !== "owner") continue;
        try {
          assertActiveMembership(membership);
        } catch {
          continue;
        }
        activeReserveApprovalCount++;
        if (eligibleRouteCount > 0)
          approvedEmergencyAvailableNanoUsd = Math.min(emergencyRoom, approvedEmergencyAvailableNanoUsd + room);
      }
    }
    readiness.set(pool.id, {
      eligibleRouteCount,
      pricingStatus,
      approvedEmergencyAvailableNanoUsd,
      activeReserveApprovalCount,
    });
  }
  return {
    observedAt: at.toISOString(),
    pools: rows.map(({ pool, cycle }) => ({
      poolId: pool.id,
      provider: pool.upstreamNamespace,
      enabled: pool.enabled,
      paused: pool.paused,
      status: pool.status,
      eligibleRouteCount: readiness.get(pool.id)?.eligibleRouteCount ?? 0,
      pricingStatus: readiness.get(pool.id)?.pricingStatus ?? "unverified",
      approvedEmergencyAvailableNanoUsd: readiness.get(pool.id)?.approvedEmergencyAvailableNanoUsd ?? 0,
      activeReserveApprovalCount: readiness.get(pool.id)?.activeReserveApprovalCount ?? 0,
      cycleId: cycle?.id ?? null,
      cycleKey: cycle?.cycleKey ?? null,
      evidenceStatus: !cycle
        ? "unverified"
        : cycle.grantEnd <= at
          ? "expired"
          : cycle.verifiedAt > at || cycle.validUntil <= at
            ? "stale"
            : "verified",
      verifiedAt: cycle?.verifiedAt.toISOString() ?? null,
      validUntil: cycle?.validUntil.toISOString() ?? null,
      grantExpiresAt: cycle?.grantEnd.toISOString() ?? null,
      grantAmountNanoUsd: cycle?.grantAmountNanoUsd ?? 0,
      observedRemainingNanoUsd: cycle?.observedRemainingNanoUsd ?? 0,
      conservativeRemainingNanoUsd: cycle ? remainingGrant(cycle) : 0,
      automaticLimitNanoUsd: cycle?.automaticLimitNanoUsd ?? 0,
      emergencyLimitNanoUsd: cycle?.emergencyLimitNanoUsd ?? 0,
      safetyBufferNanoUsd: cycle?.safetyBufferNanoUsd ?? 0,
      spentNanoUsd: cycle ? spent(cycle) : 0,
      heldNanoUsd: cycle ? held(cycle) : 0,
      automaticAvailableNanoUsd:
        (readiness.get(pool.id)?.eligibleRouteCount ?? 0) > 0 &&
        cycle &&
        cycle.verifiedAt <= at &&
        cycle.grantStart <= at &&
        cycle.validUntil.getTime() >= at.getTime() + CREDIT_MAX_REQUEST_MS &&
        cycle.grantEnd.getTime() >= at.getTime() + CREDIT_MAX_REQUEST_MS &&
        pool.enabled &&
        !pool.paused &&
        pool.status === "available"
          ? available(cycle, "automatic")
          : 0,
      emergencyRequiresOwnerApproval: true,
      paidTopUpsEnabled: false,
    })),
    unresolved: await recoverCreditReservations(db, orgId),
  };
}

/** Forecasts are estimates only; admission always uses the worst-case reservation. */
export async function forecastCreditWorkUnit(
  db: Database,
  orgId: string,
  poolId: string,
  upperBoundNanoUsd: number,
  now: () => Date = () => new Date(),
) {
  if (!validAmount(upperBoundNanoUsd) || upperBoundNanoUsd === 0) throw new CreditRouteRefusal("invalid_reservation");
  const snapshot = await creditLedgerSnapshot(db, orgId, now);
  const pool = snapshot.pools.find((p) => p.poolId === poolId);
  if (!pool) return { kind: "unknown" as const, canReserve: false, workUnitsRemaining: 0 };
  return {
    kind: "conservative_estimate" as const,
    canReserve: pool.automaticAvailableNanoUsd >= upperBoundNanoUsd,
    workUnitsRemaining: Math.floor(pool.automaticAvailableNanoUsd / upperBoundNanoUsd),
    reservedUpperBoundNanoUsd: upperBoundNanoUsd,
    automaticAvailableNanoUsd: pool.automaticAvailableNanoUsd,
    validUntil: pool.validUntil,
  };
}
