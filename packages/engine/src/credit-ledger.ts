import { and, type Database, desc, eq, schema } from "@agenteschat/db";
import { credentialVersion } from "./credentials";
import {
  CREDIT_NAMESPACE,
  CREDIT_PROOF_MAX_MS,
  CREDIT_PROVIDER,
  type CreditProof,
  type CreditQualification,
  type CreditRefusalReason,
  CreditRouteRefusal,
} from "./credit-route";

/**
 * The ledger of credit routes (ADR 0200). One pool is the one upstream billing authority every credential and agent
 * shares, so a hold is taken under that pool's row lock, in a fixed order (credential, route, pool), and two calls
 * racing for the last of the allocation never both get it. The allocation is our own ceiling, never the provider's
 * balance: the provider alone knows that, and a route only runs where its billing is known to stop at an empty grant.
 */

type Pool = typeof schema.creditPools.$inferSelect;
type Route = typeof schema.creditRoutes.$inferSelect;
type Credential = typeof schema.providerCredentials.$inferSelect;

const validAmount = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

export interface CreditNeed {
  /** Whether the call carries tools (the route must support them). */
  tools: boolean;
  /** The prompt's size as the gateway measures it. */
  promptBytes: number;
}

/** Why a pool and route cannot take a call now, or null when they can. Evidence and credential are read at `at`. */
function refusalOf(
  pool: Pool,
  route: Route,
  credential: Credential | undefined,
  need: CreditNeed,
  at: Date,
  amount: number,
): CreditRefusalReason | null {
  if (!pool.enabled || !route.enabled) return "disabled";
  if (pool.paused) return "paused";
  if (pool.status === "exhausted") return "exhausted";
  if (pool.status === "billing_blocked") return "billing_blocked";
  if (pool.status === "expired") return "grant_expired";
  if (pool.status !== "available") return "unverified";
  if (pool.upstreamNamespace !== CREDIT_NAMESPACE) return "account_mismatch";
  if (pool.verifiedAt > at || pool.validUntil <= at) return "stale_evidence";
  if ((pool.grantStart && pool.grantStart > at) || (pool.grantEnd && pool.grantEnd <= at)) return "grant_expired";
  if (!credential || credential.revokedAt || credential.provider !== CREDIT_PROVIDER) return "credential_changed";
  if (credentialVersion(credential) !== route.credentialVersion) return "credential_changed";
  if ((credential.options as { endpoint?: unknown } | null)?.endpoint) return "endpoint_mismatch";
  if ((need.tools && !route.supportsTools) || need.promptBytes > route.maxPromptBytes) return "unsupported_capability";
  if (
    !validAmount(pool.allocationNanoUsd) ||
    !validAmount(pool.spentNanoUsd) ||
    !validAmount(pool.heldNanoUsd) ||
    !validAmount(pool.spentNanoUsd + pool.heldNanoUsd + amount) ||
    pool.spentNanoUsd + pool.heldNanoUsd + amount > pool.allocationNanoUsd
  )
    return "no_allocation";
  return null;
}

/**
 * The first route that could take a call now, as a proof the run keeps, or why none can. A look, not a hold: the
 * gateway admits again, under lock, at the last moment. `routeId` pins a run that already moved to one route.
 */
export async function qualifyCreditRoute(
  db: Database,
  input: { orgId: string; need: CreditNeed; now?: () => Date; routeId?: string },
): Promise<CreditQualification> {
  const at = (input.now ?? (() => new Date()))();
  const { creditPools, creditRoutes, providerCredentials } = schema;
  const rows = await db
    .select({ route: creditRoutes, pool: creditPools })
    .from(creditRoutes)
    .innerJoin(creditPools, and(eq(creditPools.orgId, creditRoutes.orgId), eq(creditPools.id, creditRoutes.poolId)))
    .where(
      and(
        eq(creditRoutes.orgId, input.orgId),
        eq(creditRoutes.enabled, true),
        eq(creditPools.enabled, true),
        ...(input.routeId ? [eq(creditRoutes.id, input.routeId)] : []),
      ),
    )
    .orderBy(desc(creditPools.allocationNanoUsd), creditRoutes.id);
  if (rows.length === 0) return { ok: false, reason: "disabled" };
  let first: CreditRefusalReason | null = null;
  for (const { route, pool } of rows) {
    const [credential] = await db
      .select()
      .from(providerCredentials)
      .where(and(eq(providerCredentials.orgId, input.orgId), eq(providerCredentials.id, route.credentialId)));
    // An allocation too small for one call is a refusal only at the last moment (the call's own size is not known yet).
    const refusal = refusalOf(pool, route, credential, input.need, at, 0);
    if (refusal) {
      first ??= refusal;
      continue;
    }
    const validUntil = Math.min(
      pool.validUntil.getTime(),
      pool.grantEnd?.getTime() ?? Infinity,
      at.getTime() + CREDIT_PROOF_MAX_MS,
    );
    const proof: CreditProof = {
      routeId: route.id,
      poolId: pool.id,
      credentialId: route.credentialId,
      credentialVersion: route.credentialVersion,
      model: route.model,
      pool: `${pool.upstreamNamespace}:${pool.upstreamAccount}`,
      evidenceRef: pool.evidenceRef,
      observedAt: at.getTime(),
      validUntil,
    };
    return { ok: true, proof };
  }
  return { ok: false, reason: first ?? "disabled" };
}

/** Whether a credential belongs to a credit route: such a key is reserved, and no other call may spend it. */
export async function isCreditCredential(db: Database, orgId: string, credentialId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.creditRoutes.id })
    .from(schema.creditRoutes)
    .where(and(eq(schema.creditRoutes.orgId, orgId), eq(schema.creditRoutes.credentialId, credentialId)))
    .limit(1);
  return row !== undefined;
}

export interface CreditAdmission {
  attemptId: string;
  poolId: string;
  routeId: string;
}

/**
 * Takes the hold for one call, atomically, or refuses it with a reason and sends nothing. Every check is made again
 * under the locks: the credential's exact version (a rotation or revocation since qualification refuses), the route's
 * evidence and the pool's room.
 */
export async function admitCreditCall(
  db: Database,
  input: {
    orgId: string;
    credentialId: string;
    credentialVersion: string;
    model: string;
    need: CreditNeed;
    amountNanoUsd: number;
    runId?: string;
    agentId?: string;
    now?: () => Date;
  },
): Promise<CreditAdmission> {
  const now = input.now ?? (() => new Date());
  if (!validAmount(input.amountNanoUsd)) throw new CreditRouteRefusal("no_allocation");
  return db.transaction(async (tx) => {
    const { creditPools, creditRoutes, creditAttempts, providerCredentials } = schema;
    const [credential] = await tx
      .select()
      .from(providerCredentials)
      .where(and(eq(providerCredentials.orgId, input.orgId), eq(providerCredentials.id, input.credentialId)))
      .for("update");
    const [route] = await tx
      .select()
      .from(creditRoutes)
      .where(
        and(
          eq(creditRoutes.orgId, input.orgId),
          eq(creditRoutes.credentialId, input.credentialId),
          eq(creditRoutes.model, input.model),
        ),
      )
      .for("update");
    if (!route) throw new CreditRouteRefusal("disabled");
    if (route.credentialVersion !== input.credentialVersion) throw new CreditRouteRefusal("credential_changed");
    const [pool] = await tx
      .select()
      .from(creditPools)
      .where(and(eq(creditPools.orgId, input.orgId), eq(creditPools.id, route.poolId)))
      .for("update");
    if (!pool) throw new CreditRouteRefusal("disabled");
    const refusal = refusalOf(pool, route, credential, input.need, now(), input.amountNanoUsd);
    if (refusal) throw new CreditRouteRefusal(refusal);
    const [attempt] = await tx
      .insert(creditAttempts)
      .values({
        orgId: input.orgId,
        poolId: pool.id,
        routeId: route.id,
        runId: input.runId ?? null,
        agentId: input.agentId ?? null,
        amountNanoUsd: input.amountNanoUsd,
        createdAt: now(),
      })
      .returning({ id: creditAttempts.id });
    if (!attempt) throw new CreditRouteRefusal("disabled");
    await tx
      .update(creditPools)
      .set({ heldNanoUsd: pool.heldNanoUsd + input.amountNanoUsd })
      .where(and(eq(creditPools.orgId, input.orgId), eq(creditPools.id, pool.id)));
    return { attemptId: attempt.id, poolId: pool.id, routeId: route.id };
  });
}

export type CreditSettlement =
  /** The provider reported what the call cost. */
  | { kind: "settled"; actualNanoUsd: number }
  /** The provider refused before generating: nothing was charged, the hold goes back. */
  | { kind: "released"; reason: string }
  /** It went out and nobody knows: the hold stays until someone reconciles it. */
  | { kind: "unknown"; reason: string };

/**
 * Closes a hold, once. A repeated settlement of a closed hold changes nothing, and a hold of unknown outcome closes
 * only by a later `settled` or `released` (a person's reconciliation). Nothing closes a hold by time.
 */
export async function settleCreditAttempt(
  db: Database,
  orgId: string,
  attemptId: string,
  settlement: CreditSettlement,
  now: () => Date = () => new Date(),
): Promise<{ changed: boolean; state: string }> {
  return db.transaction(async (tx) => {
    const { creditPools, creditAttempts } = schema;
    const [attempt] = await tx
      .select()
      .from(creditAttempts)
      .where(and(eq(creditAttempts.orgId, orgId), eq(creditAttempts.id, attemptId)))
      .for("update");
    if (!attempt) throw new Error("credit attempt not found");
    const open = attempt.state === "held" || (attempt.state === "unknown" && settlement.kind !== "unknown");
    if (!open) return { changed: false, state: attempt.state };
    const [pool] = await tx
      .select()
      .from(creditPools)
      .where(and(eq(creditPools.orgId, orgId), eq(creditPools.id, attempt.poolId)))
      .for("update");
    if (!pool || pool.heldNanoUsd < attempt.amountNanoUsd) throw new Error("credit pool hold inconsistent");
    if (settlement.kind === "unknown") {
      await tx
        .update(creditAttempts)
        .set({ state: "unknown", reason: settlement.reason.slice(0, 300) })
        .where(eq(creditAttempts.id, attempt.id));
      return { changed: true, state: "unknown" };
    }
    if (settlement.kind === "released") {
      await tx
        .update(creditAttempts)
        .set({ state: "released", reason: settlement.reason.slice(0, 300), settledAt: now() })
        .where(eq(creditAttempts.id, attempt.id));
      await tx
        .update(creditPools)
        .set({ heldNanoUsd: pool.heldNanoUsd - attempt.amountNanoUsd })
        .where(eq(creditPools.id, pool.id));
      return { changed: true, state: "released" };
    }
    if (!validAmount(settlement.actualNanoUsd) || !validAmount(pool.spentNanoUsd + settlement.actualNanoUsd))
      throw new Error("credit settlement amount invalid");
    await tx
      .update(creditAttempts)
      .set({ state: "settled", actualNanoUsd: settlement.actualNanoUsd, settledAt: now() })
      .where(eq(creditAttempts.id, attempt.id));
    await tx
      .update(creditPools)
      .set({
        heldNanoUsd: pool.heldNanoUsd - attempt.amountNanoUsd,
        spentNanoUsd: pool.spentNanoUsd + settlement.actualNanoUsd,
        // A call that cost more than its hold means the estimate cannot be trusted: the pool stops for a person.
        paused: pool.paused || settlement.actualNanoUsd > attempt.amountNanoUsd,
      })
      .where(eq(creditPools.id, pool.id));
    return { changed: true, state: "settled" };
  });
}

/** A provider refusal that ends the route: only an operator's new evidence makes the pool available again. */
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

/** What an operator must read at the provider before a pool is registered; the evidence itself is not stored here. */
export interface CreditPoolEvidence {
  upstreamAccount: string;
  /** Only a prepaid grant with no purchased balance, no auto-reload and no invoicing: the provider stops at empty. */
  enforcement: "prepaid_grant_only";
  evidenceRef: string;
  verifiedAt: Date;
  validUntil: Date;
  grantStart?: Date | null;
  grantEnd?: Date | null;
  allocationNanoUsd: number;
}

/** Registers a pool for a workspace, disabled. It is enabled only by `setCreditPoolEnabled` after the evidence is read. */
export async function registerCreditPool(db: Database, orgId: string, evidence: CreditPoolEvidence): Promise<string> {
  if (
    !evidence.upstreamAccount.trim() ||
    !evidence.evidenceRef.trim() ||
    evidence.enforcement !== "prepaid_grant_only" ||
    !validAmount(evidence.allocationNanoUsd) ||
    evidence.verifiedAt >= evidence.validUntil
  )
    throw new Error("credit pool evidence incomplete");
  const [row] = await db
    .insert(schema.creditPools)
    .values({
      orgId,
      upstreamNamespace: CREDIT_NAMESPACE,
      upstreamAccount: evidence.upstreamAccount.trim(),
      enforcement: evidence.enforcement,
      evidenceRef: evidence.evidenceRef.trim(),
      verifiedAt: evidence.verifiedAt,
      validUntil: evidence.validUntil,
      grantStart: evidence.grantStart ?? null,
      grantEnd: evidence.grantEnd ?? null,
      allocationNanoUsd: evidence.allocationNanoUsd,
    })
    .returning({ id: schema.creditPools.id });
  if (!row) throw new Error("credit pool insert returned nothing");
  return row.id;
}

/** Registers a route for the exact credential as it is now, disabled. A key may belong to one pool only. */
export async function registerCreditRoute(
  db: Database,
  orgId: string,
  input: { poolId: string; credentialId: string; model: string; supportsTools: boolean; maxPromptBytes: number },
): Promise<string> {
  const { providerCredentials, creditRoutes } = schema;
  const [credential] = await db
    .select()
    .from(providerCredentials)
    .where(and(eq(providerCredentials.orgId, orgId), eq(providerCredentials.id, input.credentialId)));
  if (!credential || credential.revokedAt || credential.provider !== CREDIT_PROVIDER)
    throw new CreditRouteRefusal("credential_changed");
  if ((credential.options as { endpoint?: unknown } | null)?.endpoint)
    throw new CreditRouteRefusal("endpoint_mismatch");
  const [other] = await db
    .select({ poolId: creditRoutes.poolId })
    .from(creditRoutes)
    .where(and(eq(creditRoutes.orgId, orgId), eq(creditRoutes.credentialId, input.credentialId)))
    .limit(1);
  if (other && other.poolId !== input.poolId) throw new CreditRouteRefusal("account_mismatch");
  const [row] = await db
    .insert(creditRoutes)
    .values({
      orgId,
      poolId: input.poolId,
      credentialId: input.credentialId,
      credentialVersion: credentialVersion(credential),
      model: input.model,
      supportsTools: input.supportsTools,
      maxPromptBytes: input.maxPromptBytes,
    })
    .returning({ id: creditRoutes.id });
  if (!row) throw new Error("credit route insert returned nothing");
  return row.id;
}

/** The operator's switch, after reading the provider's billing page: a route and its pool take calls only when on. */
export async function setCreditRouteEnabled(
  db: Database,
  orgId: string,
  routeId: string,
  enabled: boolean,
  now: () => Date = () => new Date(),
): Promise<void> {
  await db.transaction(async (tx) => {
    const [route] = await tx
      .select()
      .from(schema.creditRoutes)
      .where(and(eq(schema.creditRoutes.orgId, orgId), eq(schema.creditRoutes.id, routeId)))
      .for("update");
    if (!route) throw new CreditRouteRefusal("disabled");
    if (enabled) {
      // Switching on is the operator vouching for evidence that is still valid, never for an old reading.
      const [pool] = await tx
        .select()
        .from(schema.creditPools)
        .where(and(eq(schema.creditPools.orgId, orgId), eq(schema.creditPools.id, route.poolId)))
        .for("update");
      if (!pool || pool.validUntil <= now() || pool.verifiedAt > now()) throw new CreditRouteRefusal("stale_evidence");
      await tx
        .update(schema.creditPools)
        .set({ enabled: true, status: "available" })
        .where(eq(schema.creditPools.id, pool.id));
    }
    await tx.update(schema.creditRoutes).set({ enabled }).where(eq(schema.creditRoutes.id, route.id));
  });
}

/** A route whose credential the provider refused is switched off: only an operator switches it on again. */
export async function disableCreditRoute(db: Database, orgId: string, credentialId: string): Promise<void> {
  await db
    .update(schema.creditRoutes)
    .set({ enabled: false })
    .where(and(eq(schema.creditRoutes.orgId, orgId), eq(schema.creditRoutes.credentialId, credentialId)));
}

/** The executor's view of the ledger: a look at the routes of the run's workspace, never a hold. */
export function createCreditRouteQualifier(db: Database) {
  return {
    qualify: (input: { orgId: string; need: CreditNeed; routeId?: string }) =>
      qualifyCreditRoute(db, { orgId: input.orgId, need: input.need, routeId: input.routeId }),
  };
}
