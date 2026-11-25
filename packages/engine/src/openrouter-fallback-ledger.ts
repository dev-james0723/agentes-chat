import { and, type Database, type Executor, eq, gt, ne, schema } from "@agenteschat/db";
import {
  autoRouterParameters,
  isOpenRouterAutoModel,
  type OpenRouterAutoModel,
  type OpenRouterAutoPolicy,
} from "@agenteschat/providers";
import { credentialVersion } from "./credentials";
import { type CreditNativeClaim, lockCreditClaim } from "./credit-continuity";
import { ForbiddenError, ValidationError } from "./errors";
import { assertActiveMembership, getMembership } from "./organizations";

const {
  openRouterFallbackSettings: settings,
  openRouterFallbackMonths: months,
  openRouterFallbackAttempts: attempts,
} = schema;
export const OPENROUTER_FALLBACK_MAX_NANO_USD = 50_000_000_000;
const amount = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const periodOf = (at: Date) => at.toISOString().slice(0, 7);

export class OpenRouterFallbackRefusal extends Error {
  readonly retryable = false;
  constructor(readonly reason: string) {
    super(`OpenRouter fallback: ${reason}`);
    this.name = "OpenRouterFallbackRefusal";
  }
}
const refuse = (reason: string): never => {
  throw new OpenRouterFallbackRefusal(reason);
};

export interface OpenRouterFallbackRoute {
  schema: "openrouter-fallback/1";
  router: OpenRouterAutoModel;
  revision: number;
  credentialId: string;
  credentialVersion: string;
}
function readPolicy(value: unknown, cap: number): OpenRouterAutoPolicy {
  const p = value as OpenRouterAutoPolicy | undefined;
  if (!p || Math.round(p.monthlyCapUsd * 1e9) !== cap) return refuse("policy_invalid");
  try {
    autoRouterParameters(p);
  } catch {
    return refuse("policy_invalid");
  }
  return p;
}
async function requireOwner(tx: Executor, orgId: string, actor: string) {
  const member = await getMembership(tx, actor, orgId);
  if (member?.role !== "owner") throw new ForbiddenError();
  assertActiveMembership(member);
}

/** Configuring a cap is not dispatch authorization. Enable only through the authenticated owner path. */
export async function configureOpenRouterFallback(
  db: Database,
  orgId: string,
  actor: string,
  input: { enabled: false } | { enabled: true; credentialId: string; policy: OpenRouterAutoPolicy },
) {
  return db.transaction(async (tx) => {
    await requireOwner(tx, orgId, actor);
    await tx.insert(settings).values({ orgId }).onConflictDoNothing();
    const [previous] = await tx.select().from(settings).where(eq(settings.orgId, orgId)).for("update");
    if (!previous) return refuse("settings_missing");
    if (!input.enabled) {
      await tx
        .update(settings)
        .set({ enabled: false, revision: previous.revision + 1, updatedAt: new Date() })
        .where(eq(settings.orgId, orgId));
      return;
    }
    const cap = Math.round(input.policy.monthlyCapUsd * 1e9);
    if (!amount(cap) || cap < 1 || cap > OPENROUTER_FALLBACK_MAX_NANO_USD)
      throw new ValidationError("OpenRouter fallback cap must be within the approved US$50 per month.");
    const policy = readPolicy(input.policy, cap);
    const [credential] = await tx
      .select()
      .from(schema.providerCredentials)
      .where(and(eq(schema.providerCredentials.orgId, orgId), eq(schema.providerCredentials.id, input.credentialId)))
      .for("update");
    if (
      !credential ||
      credential.revokedAt ||
      credential.provider !== "openrouter" ||
      credential.options.endpoint ||
      !credential.secretFingerprint ||
      !/^[a-f0-9]{64}$/.test(credential.secretFingerprint)
    )
      return refuse("dedicated_credential_required");
    // Keep accounting bound to a single dedicated key while old liabilities exist.
    if (previous.credentialFingerprint && previous.credentialFingerprint !== credential.secretFingerprint) {
      const [held] = await tx
        .select({ period: months.period })
        .from(months)
        .where(and(eq(months.orgId, orgId), gt(months.heldNanoUsd, 0)))
        .limit(1);
      if (held) return refuse("reconciliation_required");
    }
    await tx
      .update(settings)
      .set({
        enabled: true,
        monthlyCapNanoUsd: cap,
        credentialId: credential.id,
        credentialVersion: credentialVersion(credential),
        credentialFingerprint: credential.secretFingerprint,
        approvedBy: actor,
        policy: { ...policy, allowedModels: [...policy.allowedModels] },
        revision: previous.revision + 1,
        updatedAt: new Date(),
      })
      .where(eq(settings.orgId, orgId));
  });
}

/** Returns only non-secret owner-facing configuration/accounting. */
export async function readOpenRouterFallback(db: Executor, orgId: string, at = new Date()) {
  const [p] = await db.select().from(settings).where(eq(settings.orgId, orgId));
  const [m] = await db
    .select()
    .from(months)
    .where(and(eq(months.orgId, orgId), eq(months.period, periodOf(at))));
  const [unknown] = await db
    .select({ id: attempts.id })
    .from(attempts)
    .where(and(eq(attempts.orgId, orgId), eq(attempts.state, "unknown")))
    .limit(1);
  const [oldHold] = await db
    .select({ period: months.period })
    .from(months)
    .where(and(eq(months.orgId, orgId), ne(months.period, periodOf(at)), gt(months.heldNanoUsd, 0)))
    .limit(1);
  return {
    enabled: p?.enabled ?? false,
    monthlyCapNanoUsd: p?.monthlyCapNanoUsd ?? OPENROUTER_FALLBACK_MAX_NANO_USD,
    credentialId: p?.credentialId ?? null,
    revision: p?.revision ?? 0,
    policy: p?.policy ?? {},
    period: periodOf(at),
    spentNanoUsd: m?.spentNanoUsd ?? 0,
    heldNanoUsd: m?.heldNanoUsd ?? 0,
    blocked: Boolean(m?.paused || unknown || oldHold),
  };
}

/** Internal qualification; dispatch still must lock/revalidate this exact revision and credential. */
export async function openRouterFallbackConfig(db: Executor, orgId: string) {
  const [p] = await db.select().from(settings).where(eq(settings.orgId, orgId));
  if (!p?.enabled || !p.credentialId || !p.credentialVersion || !p.credentialFingerprint) return null;
  return { ...p, policy: readPolicy(p.policy, p.monthlyCapNanoUsd) };
}

/** The dedicated fallback key must not pay for ordinary provider calls or probes. */
export async function openRouterKeyReserved(db: Executor, orgId: string, id: string | null, fingerprint: string) {
  const [p] = await db
    .select({ orgId: settings.orgId })
    .from(settings)
    .where(eq(settings.credentialFingerprint, fingerprint))
    .limit(1);
  if (p) return true;
  if (!id) return false;
  const [same] = await db
    .select({ orgId: settings.orgId })
    .from(settings)
    .where(and(eq(settings.orgId, orgId), eq(settings.credentialId, id)))
    .limit(1);
  return Boolean(same);
}

export interface OpenRouterReserveInput {
  orgId: string;
  agentId: string;
  runId: string;
  turn: number;
  route: OpenRouterFallbackRoute;
  claim: CreditNativeClaim;
  boundNanoUsd: number;
  now?: () => Date;
}

/**
 * One durable reservation per native run turn. Organization settings serialize all agents,
 * workers and months, including key changes; no expired/ambiguous hold is freed automatically.
 * Called only after a conservative bounded transport has qualified the exact request.
 */
export async function reserveOpenRouterFallback(db: Database, input: OpenRouterReserveInput) {
  if (
    !amount(input.boundNanoUsd) ||
    input.boundNanoUsd < 1 ||
    !Number.isSafeInteger(input.turn) ||
    input.turn < 1 ||
    !isOpenRouterAutoModel(input.route.router) ||
    input.route.schema !== "openrouter-fallback/1"
  )
    return refuse("invalid_request");
  const now = input.now ?? (() => new Date());
  return db.transaction(async (tx) => {
    const at = now();
    await lockCreditClaim(tx, input.orgId, input.runId, input.claim, at);
    const [p] = await tx.select().from(settings).where(eq(settings.orgId, input.orgId)).for("update");
    if (
      !p?.enabled ||
      !p.approvedBy ||
      p.revision !== input.route.revision ||
      p.credentialId !== input.route.credentialId ||
      p.credentialVersion !== input.route.credentialVersion
    )
      return refuse("policy_changed");
    await requireOwner(tx, input.orgId, p.approvedBy);
    const policy = readPolicy(p.policy, p.monthlyCapNanoUsd);
    const [credential] = await tx
      .select()
      .from(schema.providerCredentials)
      .where(
        and(
          eq(schema.providerCredentials.orgId, input.orgId),
          eq(schema.providerCredentials.id, input.route.credentialId),
        ),
      )
      .for("update");
    if (
      !credential ||
      credential.revokedAt ||
      credential.provider !== "openrouter" ||
      credential.options.endpoint ||
      credential.secretFingerprint !== p.credentialFingerprint ||
      credentialVersion(credential) !== p.credentialVersion
    )
      return refuse("credential_changed");
    const [run] = await tx
      .select()
      .from(schema.agentRuns)
      .where(and(eq(schema.agentRuns.orgId, input.orgId), eq(schema.agentRuns.id, input.runId)))
      .for("update");
    const marker = run?.transcript?.openRouterFallback as OpenRouterFallbackRoute | undefined;
    if (
      !run ||
      run.agentId !== input.agentId ||
      run.status !== "running" ||
      run.turns + 1 !== input.turn ||
      !marker ||
      (marker as OpenRouterFallbackRoute & { ended?: string }).ended ||
      run.transcript?.openRouterHold ||
      marker.schema !== input.route.schema ||
      marker.router !== input.route.router ||
      marker.revision !== p.revision ||
      marker.credentialId !== p.credentialId ||
      marker.credentialVersion !== p.credentialVersion ||
      run.transcript?.pending ||
      run.transcript?.effectUncertain ||
      run.transcript?.hostAcpUncertain ||
      run.transcript?.continuityCheckpoint
    )
      return refuse("unsafe_checkpoint");
    const [duplicate] = await tx
      .select({ id: attempts.id })
      .from(attempts)
      .where(and(eq(attempts.orgId, input.orgId), eq(attempts.runId, input.runId), eq(attempts.turn, input.turn)))
      .limit(1);
    if (duplicate) return refuse("duplicate_attempt");
    const [unknown] = await tx
      .select({ id: attempts.id })
      .from(attempts)
      .where(and(eq(attempts.orgId, input.orgId), eq(attempts.state, "unknown")))
      .limit(1);
    const period = periodOf(at);
    const [old] = await tx
      .select({ period: months.period })
      .from(months)
      .where(and(eq(months.orgId, input.orgId), ne(months.period, period), gt(months.heldNanoUsd, 0)))
      .limit(1);
    if (unknown || old) return refuse("reconciliation_required");
    await tx.insert(months).values({ orgId: input.orgId, period }).onConflictDoNothing();
    const [m] = await tx
      .select()
      .from(months)
      .where(and(eq(months.orgId, input.orgId), eq(months.period, period)))
      .for("update");
    if (
      !m ||
      m.paused ||
      !amount(m.spentNanoUsd + m.heldNanoUsd + input.boundNanoUsd) ||
      m.spentNanoUsd + m.heldNanoUsd + input.boundNanoUsd > p.monthlyCapNanoUsd
    )
      return refuse("budget_exhausted");
    const [a] = await tx
      .insert(attempts)
      .values({
        orgId: input.orgId,
        period,
        runId: input.runId,
        turn: input.turn,
        credentialId: credential.id,
        credentialVersion: p.credentialVersion,
        router: input.route.router,
        allowedModels: [...policy.allowedModels],
        reservedNanoUsd: input.boundNanoUsd,
      })
      .returning();
    if (!a) return refuse("reservation_failed");
    await tx
      .update(months)
      .set({ heldNanoUsd: m.heldNanoUsd + a.reservedNanoUsd })
      .where(and(eq(months.orgId, input.orgId), eq(months.period, period)));
    return { attemptId: a.id, policy };
  });
}

/** Final receipt or retained liability. A duplicate settlement cannot subtract twice. */
export async function settleOpenRouterFallback(
  db: Database,
  orgId: string,
  attemptId: string,
  receipt: { model: string; costNanoUsd: number } | null,
  at = new Date(),
) {
  const result = await db.transaction(async (tx) => {
    const [p] = await tx.select().from(settings).where(eq(settings.orgId, orgId)).for("update");
    if (!p) return refuse("settings_missing");
    const [a] = await tx
      .select()
      .from(attempts)
      .where(and(eq(attempts.orgId, orgId), eq(attempts.id, attemptId)))
      .for("update");
    if (a?.state !== "held") return refuse("duplicate_or_unknown_receipt");
    const [m] = await tx
      .select()
      .from(months)
      .where(and(eq(months.orgId, orgId), eq(months.period, a.period)))
      .for("update");
    if (!m || m.heldNanoUsd < a.reservedNanoUsd) return refuse("reconciliation_required");
    if (
      !receipt ||
      !amount(receipt.costNanoUsd) ||
      !a.allowedModels.includes(receipt.model) ||
      !amount(m.spentNanoUsd + receipt.costNanoUsd)
    ) {
      await tx.update(attempts).set({ state: "unknown" }).where(eq(attempts.id, a.id));
      await tx
        .update(months)
        .set({ paused: true })
        .where(and(eq(months.orgId, orgId), eq(months.period, a.period)));
      return "reconciliation_required";
    }
    const over = receipt.costNanoUsd > a.reservedNanoUsd;
    await tx
      .update(attempts)
      .set({ state: "settled", actualModel: receipt.model, actualNanoUsd: receipt.costNanoUsd, settledAt: at })
      .where(eq(attempts.id, a.id));
    await tx
      .update(months)
      .set({
        heldNanoUsd: m.heldNanoUsd - a.reservedNanoUsd,
        spentNanoUsd: m.spentNanoUsd + receipt.costNanoUsd,
        paused: m.paused || over,
      })
      .where(and(eq(months.orgId, orgId), eq(months.period, a.period)));
    return over ? "cost_bound_exceeded" : null;
  });
  if (result) return refuse(result);
}
