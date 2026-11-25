import type { KeyWrapper } from "@agenteschat/adapters";
import { and, type Database, desc, type Executor, eq, gt, inArray, ne, schema, sql } from "@agenteschat/db";
import {
  assertSafeRouterEndpoint,
  buildDirectCloudOffers,
  CLOUDFLARE_FREE_DAILY_NEURONS,
  evaluateOfferEligibility,
  type GlobalRouterLane,
  isOpenRouterAutoModel,
  type ModelOffer,
  OPENROUTER_FREE_RPD,
  OPENROUTER_FREE_RPM,
  type ProviderEntitlementKind,
  parseCloudflareCatalogOffers,
  parseGroqCatalogOffers,
  parseOpenCodeCatalogOffers,
  parseOpenRouterCatalogOffers,
  routerDenylistReason,
} from "@agenteschat/providers";
import { credentialVersion, decryptCredential } from "./credentials";
import { ForbiddenError, ValidationError } from "./errors";
import { OPENROUTER_FALLBACK_MAX_NANO_USD } from "./openrouter-fallback-ledger";
import { assertActiveMembership, getMembership } from "./organizations";

const {
  globalRouterPolicies: policies,
  globalRouterAccounts: accounts,
  globalRouterOffers: offersTable,
  globalRouterWindows: windows,
  globalRouterAttempts: attempts,
  globalRouterBenchmarks: benchmarks,
  openRouterFallbackMonths,
} = schema;

const SUPPORTED_PROVIDERS = new Set([
  "openrouter",
  "groq",
  "cloudflare",
  "opencode",
  "deepseek",
  "tencent",
  "minimax",
  "zai",
  "moonshot",
  "xiaomi",
  "nvidia",
]);

const safeNonNegInt = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const periodOf = (at: Date) => at.toISOString().slice(0, 7);
const dayKeyOf = (at: Date) => at.toISOString().slice(0, 10);
const minuteKeyOf = (at: Date) => at.toISOString().slice(0, 16);

export class GlobalRouterRefusal extends Error {
  readonly retryable = false;
  constructor(readonly reason: string) {
    super(`Global Model Router: ${reason}`);
    this.name = "GlobalRouterRefusal";
  }
}

const refuse = (reason: string): never => {
  throw new GlobalRouterRefusal(reason);
};

async function requireOwner(tx: Executor, orgId: string, actor: string) {
  const member = await getMembership(tx, actor, orgId);
  if (member?.role !== "owner") throw new ForbiddenError();
  assertActiveMembership(member);
}

export interface GlobalRouterPolicyInput {
  enabled: boolean;
  killSwitch?: boolean;
  optOutAgentIds?: string[];
  maxEscalations?: number;
  maxRetriesPerRoute?: number;
  warnAt50?: boolean;
  warnAt80?: boolean;
  warnAt95?: boolean;
}

export async function configureGlobalRouterPolicy(
  db: Database,
  orgId: string,
  actor: string,
  input: GlobalRouterPolicyInput,
  now: () => Date = () => new Date(),
) {
  return db.transaction(async (tx) => {
    await requireOwner(tx, orgId, actor);
    const maxEscalations = input.maxEscalations ?? 2;
    const maxRetriesPerRoute = input.maxRetriesPerRoute ?? 1;
    if (
      !Number.isInteger(maxEscalations) ||
      maxEscalations < 0 ||
      maxEscalations > 2 ||
      !Number.isInteger(maxRetriesPerRoute) ||
      maxRetriesPerRoute < 0 ||
      maxRetriesPerRoute > 1
    ) {
      throw new ValidationError("Global Router escalation/retry limits exceed safety bounds.");
    }
    const optOut = [...new Set((input.optOutAgentIds ?? []).filter((id) => typeof id === "string" && id.length > 0))];
    await tx.insert(policies).values({ orgId }).onConflictDoNothing();
    const [prev] = await tx.select().from(policies).where(eq(policies.orgId, orgId)).for("update");
    if (!prev) return refuse("policy_missing");
    const [updated] = await tx
      .update(policies)
      .set({
        enabled: input.enabled,
        killSwitch: input.killSwitch ?? prev.killSwitch,
        optOutAgentIds: optOut,
        maxEscalations,
        maxRetriesPerRoute,
        warnAt50: input.warnAt50 ?? prev.warnAt50,
        warnAt80: input.warnAt80 ?? prev.warnAt80,
        warnAt95: input.warnAt95 ?? prev.warnAt95,
        approvedBy: actor,
        revision: prev.revision + 1,
        updatedAt: now(),
      })
      .where(eq(policies.orgId, orgId))
      .returning();
    return updated;
  });
}

export interface GlobalRouterAccountInput {
  provider: string;
  lane: Exclude<GlobalRouterLane, "subscription">;
  entitlement: ProviderEntitlementKind;
  credentialId: string;
  workspaceAccountRef?: string | null;
  enabled: boolean;
  killSwitch?: boolean;
  monthlyCapUsd?: number;
  maxPromptUsdPerMillion?: number;
  maxCompletionUsdPerMillion?: number;
  allowedModels: string[];
  rpmLimit?: number | null;
  rpdLimit?: number | null;
  tpmLimit?: number | null;
  tpdLimit?: number | null;
  dailyNeuronsLimit?: number;
  zdrRequired?: boolean;
  allowedRegion?: "global" | "us_eu" | "cn";
}

export async function upsertGlobalRouterAccount(
  db: Database,
  orgId: string,
  actor: string,
  input: GlobalRouterAccountInput,
  now: () => Date = () => new Date(),
) {
  if (!SUPPORTED_PROVIDERS.has(input.provider)) {
    throw new ValidationError(`Provider ${input.provider} is not permitted in the Global Model Router.`);
  }
  const cleanModels = [...new Set(input.allowedModels.map((m) => m.trim()).filter(Boolean))];
  if (input.enabled && cleanModels.length === 0) {
    throw new ValidationError("At least one concrete allowed model is required to enable a router account.");
  }
  for (const modelId of cleanModels) {
    const denied = routerDenylistReason(input.provider, modelId);
    if (denied) throw new ValidationError(`Model ${modelId} is blocked by policy (${denied}).`);
    if (isOpenRouterAutoModel(modelId)) {
      throw new ValidationError("Allowed models must list concrete verified models, not dynamic router aliases.");
    }
  }
  if (input.provider === "cloudflare" && input.enabled) {
    const ref = (input.workspaceAccountRef ?? "").trim();
    if (!/^[a-f0-9]{32}$/i.test(ref)) {
      throw new ValidationError("Cloudflare Workers AI requires a valid 32-hex Account ID.");
    }
  }

  const capNanoUsd =
    input.entitlement === "free_only" || input.entitlement === "subscription_go"
      ? 0
      : Math.round((input.monthlyCapUsd ?? 0) * 1e9);

  if (input.entitlement === "free_only" || input.entitlement === "subscription_go") {
    if ((input.monthlyCapUsd ?? 0) !== 0) {
      throw new ValidationError("Free-only and Go-included accounts must enforce a USD 0 incremental spend cap.");
    }
  } else {
    if (!safeNonNegInt(capNanoUsd) || capNanoUsd <= 0) {
      throw new ValidationError("Paid router accounts require a positive monthly USD cap.");
    }
    if (input.provider === "openrouter" && capNanoUsd > OPENROUTER_FALLBACK_MAX_NANO_USD) {
      throw new ValidationError("OpenRouter shared monthly cap cannot exceed the approved US$50 ceiling.");
    }
  }

  const maxPromptNanoPerToken = Math.ceil((input.maxPromptUsdPerMillion ?? 5) * 1000);
  const maxCompletionNanoPerToken = Math.ceil((input.maxCompletionUsdPerMillion ?? 25) * 1000);

  return db.transaction(async (tx) => {
    await requireOwner(tx, orgId, actor);
    const [credential] = await tx
      .select()
      .from(schema.providerCredentials)
      .where(and(eq(schema.providerCredentials.orgId, orgId), eq(schema.providerCredentials.id, input.credentialId)))
      .for("update");
    if (
      !credential ||
      credential.revokedAt ||
      credential.provider !== input.provider ||
      credential.options?.endpoint ||
      !credential.secretFingerprint ||
      !/^[a-f0-9]{64}$/.test(credential.secretFingerprint)
    ) {
      return refuse("dedicated_credential_required");
    }

    const [existing] = await tx
      .select()
      .from(accounts)
      .where(and(eq(accounts.orgId, orgId), eq(accounts.provider, input.provider), eq(accounts.lane, input.lane)))
      .for("update");

    if (existing && existing.credentialFingerprint !== credential.secretFingerprint) {
      const [heldWin] = await tx
        .select({ period: windows.period })
        .from(windows)
        .where(and(eq(windows.orgId, orgId), eq(windows.accountId, existing.id), gt(windows.heldNanoUsd, 0)))
        .limit(1);
      const [unknownAtt] = await tx
        .select({ id: attempts.id })
        .from(attempts)
        .where(and(eq(attempts.orgId, orgId), eq(attempts.accountId, existing.id), eq(attempts.state, "unknown")))
        .limit(1);
      if (heldWin || unknownAtt) return refuse("reconciliation_required");
    }

    const defaultRpm =
      input.rpmLimit !== undefined
        ? input.rpmLimit
        : input.provider === "openrouter" && input.lane === "free_api"
          ? OPENROUTER_FREE_RPM
          : null;
    const defaultRpd =
      input.rpdLimit !== undefined
        ? input.rpdLimit
        : input.provider === "openrouter" && input.lane === "free_api"
          ? OPENROUTER_FREE_RPD
          : null;
    const neuronsLimit = input.dailyNeuronsLimit ?? CLOUDFLARE_FREE_DAILY_NEURONS;

    if (existing) {
      const [updated] = await tx
        .update(accounts)
        .set({
          entitlement: input.entitlement,
          credentialId: credential.id,
          credentialVersion: credentialVersion(credential),
          credentialFingerprint: credential.secretFingerprint,
          workspaceAccountRef: input.workspaceAccountRef?.trim() ?? existing.workspaceAccountRef,
          enabled: input.enabled,
          killSwitch: input.killSwitch ?? false,
          extraUsageAllowed: false,
          monthlyCapNanoUsd: capNanoUsd,
          maxPromptNanoPerToken,
          maxCompletionNanoPerToken,
          allowedModels: cleanModels,
          rpmLimit: defaultRpm,
          rpdLimit: defaultRpd,
          tpmLimit: input.tpmLimit ?? null,
          tpdLimit: input.tpdLimit ?? null,
          dailyNeuronsLimit: neuronsLimit,
          zdrRequired: input.zdrRequired ?? false,
          allowedRegion: input.allowedRegion ?? "global",
          approvedBy: actor,
          revision: existing.revision + 1,
          updatedAt: now(),
        })
        .where(eq(accounts.id, existing.id))
        .returning();
      return updated;
    }

    const [created] = await tx
      .insert(accounts)
      .values({
        orgId,
        provider: input.provider,
        lane: input.lane,
        entitlement: input.entitlement,
        credentialId: credential.id,
        credentialVersion: credentialVersion(credential),
        credentialFingerprint: credential.secretFingerprint,
        workspaceAccountRef: input.workspaceAccountRef?.trim() ?? null,
        enabled: input.enabled,
        killSwitch: input.killSwitch ?? false,
        extraUsageAllowed: false,
        monthlyCapNanoUsd: capNanoUsd,
        maxPromptNanoPerToken,
        maxCompletionNanoPerToken,
        allowedModels: cleanModels,
        rpmLimit: defaultRpm,
        rpdLimit: defaultRpd,
        tpmLimit: input.tpmLimit ?? null,
        tpdLimit: input.tpdLimit ?? null,
        dailyNeuronsLimit: neuronsLimit,
        zdrRequired: input.zdrRequired ?? false,
        allowedRegion: input.allowedRegion ?? "global",
        approvedBy: actor,
        updatedAt: now(),
      })
      .returning();
    return created;
  });
}

/** Syncs dynamic `ModelOffer` snapshots for an organization, enforcing denylist quarantine. */
export async function syncGlobalRouterOffers(
  db: Database,
  orgId: string,
  actor: string,
  offers: readonly ModelOffer[],
) {
  return db.transaction(async (tx) => {
    await requireOwner(tx, orgId, actor);
    let stored = 0;
    for (const raw of offers) {
      const deny = routerDenylistReason(raw.provider, raw.modelId, raw.canonicalId);
      const normalized: ModelOffer = deny
        ? {
            ...raw,
            freeEligible: false,
            qualificationStatus: "denied",
            quarantineReason: deny,
          }
        : raw;
      const observedAt = new Date(normalized.observedAt);
      const expiresAt = new Date(normalized.expiresAt);
      if (Number.isNaN(observedAt.getTime()) || Number.isNaN(expiresAt.getTime())) continue;
      await tx
        .insert(offersTable)
        .values({
          orgId,
          offerId: normalized.offerId,
          provider: normalized.provider,
          lane: normalized.lane,
          modelId: normalized.modelId,
          label: normalized.label,
          qualificationStatus: normalized.qualificationStatus,
          freeEligible: normalized.freeEligible,
          offer: normalized as unknown as Record<string, unknown>,
          observedAt,
          expiresAt,
        })
        .onConflictDoUpdate({
          target: [offersTable.orgId, offersTable.offerId],
          set: {
            provider: normalized.provider,
            lane: normalized.lane,
            modelId: normalized.modelId,
            label: normalized.label,
            qualificationStatus: normalized.qualificationStatus,
            freeEligible: normalized.freeEligible,
            offer: normalized as unknown as Record<string, unknown>,
            observedAt,
            expiresAt,
          },
        });
      stored++;
    }
    return { stored };
  });
}

export interface LiveCatalogSyncSourceResult {
  source: string;
  ok: boolean;
  offerCount: number;
  eligibleCount: number;
  error?: string;
}

/**
 * Owner-only live catalog sync across OpenRouter, OpenCode Go/Zen, GroqCloud, Cloudflare Workers AI,
 * and Direct Cloud APIs. Never dispatches inference and never exposes credentials.
 */
export async function refreshLiveGlobalRouterCatalog(
  db: Database,
  orgId: string,
  actor: string,
  options: {
    fetch?: typeof fetch;
    keyWrappers?: KeyWrapper[];
    now?: () => Date;
    sources?: readonly ("openrouter" | "opencode" | "groq" | "cloudflare" | "direct")[];
  } = {},
): Promise<{ stored: number; sources: LiveCatalogSyncSourceResult[]; observedAt: string }> {
  await requireOwner(db, orgId, actor);
  const http = options.fetch ?? fetch;
  const observedAt = (options.now ?? (() => new Date()))().toISOString();
  const wanted = new Set(options.sources ?? ["openrouter", "opencode", "groq", "cloudflare", "direct"]);
  const allOffers: ModelOffer[] = [];
  const sources: LiveCatalogSyncSourceResult[] = [];

  const fetchJson = async (url: string, bearer?: string): Promise<unknown> => {
    assertSafeRouterEndpoint(url);
    const res = await http(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      redirect: "error",
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) throw new Error(`http_${res.status}`);
    return res.json();
  };

  if (wanted.has("openrouter")) {
    try {
      const body = await fetchJson("https://openrouter.ai/api/v1/models");
      const parsed = parseOpenRouterCatalogOffers(body, observedAt);
      allOffers.push(...parsed);
      sources.push({
        source: "openrouter",
        ok: true,
        offerCount: parsed.length,
        eligibleCount: parsed.filter((o) => o.qualificationStatus === "eligible").length,
      });
    } catch (err) {
      sources.push({
        source: "openrouter",
        ok: false,
        offerCount: 0,
        eligibleCount: 0,
        error: err instanceof Error ? err.message.slice(0, 80) : "fetch_failed",
      });
    }
  }

  if (wanted.has("opencode")) {
    try {
      const [goBody, zenBody] = await Promise.all([
        fetchJson("https://opencode.ai/inference/go/v1/models"),
        fetchJson("https://opencode.ai/zen/v1/models"),
      ]);
      const parsed = [
        ...parseOpenCodeCatalogOffers(goBody, "go", observedAt),
        ...parseOpenCodeCatalogOffers(zenBody, "zen", observedAt),
      ];
      allOffers.push(...parsed);
      sources.push({
        source: "opencode",
        ok: true,
        offerCount: parsed.length,
        eligibleCount: parsed.filter((o) => o.qualificationStatus === "eligible").length,
      });
    } catch (err) {
      sources.push({
        source: "opencode",
        ok: false,
        offerCount: 0,
        eligibleCount: 0,
        error: err instanceof Error ? err.message.slice(0, 80) : "fetch_failed",
      });
    }
  }

  const orgAccounts = await db.select().from(accounts).where(eq(accounts.orgId, orgId));

  if (wanted.has("groq") && options.keyWrappers?.length) {
    const groqAcct = orgAccounts.find((a) => a.provider === "groq" && a.enabled);
    if (groqAcct) {
      try {
        const cred = await decryptCredential(db, options.keyWrappers, orgId, groqAcct.credentialId);
        if (!cred?.apiKey) throw new Error("credential_missing");
        const body = await fetchJson("https://api.groq.com/openai/v1/models", cred.apiKey);
        const parsed = parseGroqCatalogOffers(body, groqAcct.entitlement, observedAt);
        allOffers.push(...parsed);
        sources.push({
          source: "groq",
          ok: true,
          offerCount: parsed.length,
          eligibleCount: parsed.filter((o) => o.qualificationStatus === "eligible").length,
        });
      } catch (err) {
        sources.push({
          source: "groq",
          ok: false,
          offerCount: 0,
          eligibleCount: 0,
          error: err instanceof Error ? err.message.slice(0, 80) : "fetch_failed",
        });
      }
    }
  }

  if (wanted.has("cloudflare") && options.keyWrappers?.length) {
    const cfAcct = orgAccounts.find((a) => a.provider === "cloudflare" && a.enabled && a.workspaceAccountRef);
    if (cfAcct?.workspaceAccountRef) {
      try {
        const cred = await decryptCredential(db, options.keyWrappers, orgId, cfAcct.credentialId);
        if (!cred?.apiKey) throw new Error("credential_missing");
        const cleanId = cfAcct.workspaceAccountRef.trim().toLowerCase();
        const body = await fetchJson(
          `https://api.cloudflare.com/client/v4/accounts/${cleanId}/ai/models/search?per_page=100`,
          cred.apiKey,
        );
        const parsed = parseCloudflareCatalogOffers(body, cleanId, cfAcct.entitlement, observedAt);
        allOffers.push(...parsed);
        sources.push({
          source: "cloudflare",
          ok: true,
          offerCount: parsed.length,
          eligibleCount: parsed.filter((o) => o.qualificationStatus === "eligible").length,
        });
      } catch (err) {
        sources.push({
          source: "cloudflare",
          ok: false,
          offerCount: 0,
          eligibleCount: 0,
          error: err instanceof Error ? err.message.slice(0, 80) : "fetch_failed",
        });
      }
    }
  }

  if (wanted.has("direct")) {
    const directOffers = buildDirectCloudOffers(observedAt);
    allOffers.push(...directOffers);
    sources.push({
      source: "direct",
      ok: true,
      offerCount: directOffers.length,
      eligibleCount: directOffers.filter((o) => o.qualificationStatus === "eligible").length,
    });
  }

  const { stored } = await syncGlobalRouterOffers(db, orgId, actor, allOffers);
  return { stored, sources, observedAt };
}

export interface GlobalRouterReserveRequest {
  orgId: string;
  accountId: string;
  runId: string;
  routineRunId?: string | null;
  agentId: string;
  turn: number;
  attemptIndex?: number;
  idempotencyKey: string;
  requestedModel: string;
  boundNanoUsd: number;
  estimatedPromptTokens: number;
  maxOutputTokens: number;
  reservedNeurons?: number;
  escalatedFromId?: string | null;
  now?: () => Date;
}

export interface BudgetThresholdWarning {
  thresholdPercent: 50 | 80 | 95;
  accountId: string;
  provider: string;
  lane: string;
  usedNanoUsd: number;
  capNanoUsd: number;
}

export interface GlobalRouterReservationReceipt {
  attemptId: string;
  accountId: string;
  provider: string;
  lane: Exclude<GlobalRouterLane, "subscription">;
  entitlement: ProviderEntitlementKind;
  credentialId: string;
  credentialVersion: string;
  credentialFingerprint: string;
  workspaceAccountRef: string | null;
  allowedModels: string[];
  maxPromptNanoPerToken: number;
  maxCompletionNanoPerToken: number;
  monthlyCapNanoUsd: number;
  zdrRequired: boolean;
  reservedNanoUsd: number;
  reservedNeurons: number;
  warnings: BudgetThresholdWarning[];
}

/**
 * Budget Guardian: atomically reserves budget, RPM/RPD/TPM/TPD, or Cloudflare Neurons
 * under row-level locks. Enforces zero-spend on free/Go routes, shared $50/mo OpenRouter
 * cap across both legacy and global tables, and refuses across monthly rollover while any
 * unresolved hold remains.
 */
export async function reserveGlobalRouterAttempt(
  db: Database,
  input: GlobalRouterReserveRequest,
): Promise<GlobalRouterReservationReceipt> {
  const attemptIndex = input.attemptIndex ?? 1;
  const reservedNeurons = input.reservedNeurons ?? 0;
  if (
    !safeNonNegInt(input.boundNanoUsd) ||
    !safeNonNegInt(reservedNeurons) ||
    !safeNonNegInt(input.estimatedPromptTokens) ||
    !safeNonNegInt(input.maxOutputTokens) ||
    input.maxOutputTokens < 1 ||
    !Number.isSafeInteger(input.turn) ||
    input.turn < 1 ||
    !Number.isSafeInteger(attemptIndex) ||
    attemptIndex < 1 ||
    !input.idempotencyKey.trim()
  ) {
    return refuse("invalid_reservation_request");
  }
  const deny = routerDenylistReason("", input.requestedModel);
  if (deny) return refuse(deny);

  const nowFn = input.now ?? (() => new Date());
  return db.transaction(async (tx) => {
    const at = nowFn();
    const [policy] = await tx.select().from(policies).where(eq(policies.orgId, input.orgId)).for("update");
    if (!policy?.enabled || policy.killSwitch) return refuse("router_disabled");
    if (policy.optOutAgentIds.includes(input.agentId)) return refuse("agent_opted_out");
    if (!policy.approvedBy) return refuse("policy_unapproved");
    await requireOwner(tx, input.orgId, policy.approvedBy);

    const [account] = await tx
      .select()
      .from(accounts)
      .where(and(eq(accounts.orgId, input.orgId), eq(accounts.id, input.accountId)))
      .for("update");
    if (!account || !account.enabled || account.killSwitch || account.extraUsageAllowed) {
      return refuse("account_disabled");
    }
    const period = periodOf(at);
    const [unknownAny] = await tx
      .select({ id: attempts.id })
      .from(attempts)
      .where(and(eq(attempts.orgId, input.orgId), eq(attempts.accountId, account.id), eq(attempts.state, "unknown")))
      .limit(1);
    const [oldHold] = await tx
      .select({ period: windows.period })
      .from(windows)
      .where(
        and(
          eq(windows.orgId, input.orgId),
          eq(windows.accountId, account.id),
          ne(windows.period, period),
          gt(windows.heldNanoUsd, 0),
        ),
      )
      .limit(1);
    if (unknownAny || oldHold) return refuse("reconciliation_required");

    if (account.healthState === "paused" || account.healthState === "reauth_required") {
      return refuse(`account_${account.healthState}`);
    }
    const providerDeny = routerDenylistReason(account.provider, input.requestedModel);
    if (providerDeny) return refuse(providerDeny);

    await requireOwner(tx, input.orgId, account.approvedBy);

    const [credential] = await tx
      .select()
      .from(schema.providerCredentials)
      .where(
        and(eq(schema.providerCredentials.orgId, input.orgId), eq(schema.providerCredentials.id, account.credentialId)),
      )
      .for("update");
    if (
      !credential ||
      credential.revokedAt ||
      credential.provider !== account.provider ||
      credential.options?.endpoint ||
      credential.secretFingerprint !== account.credentialFingerprint ||
      credentialVersion(credential) !== account.credentialVersion
    ) {
      return refuse("credential_changed");
    }

    const isDynamicOpenRouter = account.provider === "openrouter" && isOpenRouterAutoModel(input.requestedModel);
    if (!isDynamicOpenRouter && !account.allowedModels.includes(input.requestedModel)) {
      return refuse("model_not_in_allowlist");
    }
    if (isDynamicOpenRouter && account.lane !== "paid_dynamic") {
      return refuse("dynamic_router_lane_mismatch");
    }

    // Verify dynamic catalog freshness and qualification before dispatch.
    const candidateModels = isDynamicOpenRouter ? account.allowedModels : [input.requestedModel];
    const offerRows = await tx
      .select()
      .from(offersTable)
      .where(
        and(
          eq(offersTable.orgId, input.orgId),
          eq(offersTable.provider, account.provider),
          inArray(offersTable.modelId, candidateModels),
        ),
      );
    if (offerRows.length !== candidateModels.length) return refuse("catalog_offer_missing");
    for (const row of offerRows) {
      const offer = row.offer as unknown as ModelOffer;
      // Direct APIs become eligible once an owner explicitly approves and binds this account.
      const effectiveOffer: ModelOffer =
        account.lane === "direct_api" && offer.qualificationStatus === "requires_owner_approval"
          ? { ...offer, qualificationStatus: "eligible" }
          : offer;
      const check = evaluateOfferEligibility(effectiveOffer, at.getTime());
      if (!check.eligible) return refuse(check.reason);
      if (account.zdrRequired && !effectiveOffer.privacy.zdr) return refuse("privacy_zdr_required");
    }

    // Enforce zero incremental spend on free_only and subscription_go entitlements.
    if (account.entitlement === "free_only" || account.entitlement === "subscription_go") {
      if (input.boundNanoUsd !== 0) return refuse("free_account_zero_spend_enforced");
    } else if (input.boundNanoUsd <= 0) {
      return refuse("paid_bound_must_be_positive");
    }

    // Check duplicate idempotency or turn attempt before modifying counters.
    const [dup] = await tx
      .select({ id: attempts.id })
      .from(attempts)
      .where(and(eq(attempts.orgId, input.orgId), eq(attempts.idempotencyKey, input.idempotencyKey)))
      .limit(1);
    if (dup) return refuse("duplicate_attempt");

    const [dupTurn] = await tx
      .select({ id: attempts.id })
      .from(attempts)
      .where(
        and(
          eq(attempts.orgId, input.orgId),
          eq(attempts.runId, input.runId),
          eq(attempts.turn, input.turn),
          eq(attempts.attemptIndex, attemptIndex),
        ),
      )
      .limit(1);
    if (dupTurn) return refuse("duplicate_attempt");

    const dayKey = dayKeyOf(at);
    const minuteKey = minuteKeyOf(at);

    // Cross-ledger OpenRouter $50/month shared ceiling lock.
    let openRouterCombinedCommitted = 0;
    if (account.provider === "openrouter" && account.entitlement === "paid_capped") {
      await tx.insert(openRouterFallbackMonths).values({ orgId: input.orgId, period }).onConflictDoNothing();
      const [legacyMonth] = await tx
        .select()
        .from(openRouterFallbackMonths)
        .where(and(eq(openRouterFallbackMonths.orgId, input.orgId), eq(openRouterFallbackMonths.period, period)))
        .for("update");
      if (legacyMonth?.paused) return refuse("reconciliation_required");
      openRouterCombinedCommitted += (legacyMonth?.spentNanoUsd ?? 0) + (legacyMonth?.heldNanoUsd ?? 0);

      const otherOrAccounts = await tx
        .select({ id: accounts.id })
        .from(accounts)
        .where(
          and(
            eq(accounts.orgId, input.orgId),
            eq(accounts.provider, "openrouter"),
            eq(accounts.entitlement, "paid_capped"),
            ne(accounts.id, account.id),
          ),
        )
        .for("update");
      if (otherOrAccounts.length > 0) {
        const otherWins = await tx
          .select()
          .from(windows)
          .where(
            and(
              eq(windows.orgId, input.orgId),
              eq(windows.period, period),
              inArray(
                windows.accountId,
                otherOrAccounts.map((a) => a.id),
              ),
            ),
          )
          .for("update");
        for (const w of otherWins) openRouterCombinedCommitted += w.spentNanoUsd + w.heldNanoUsd;
      }
    }

    await tx
      .insert(windows)
      .values({ orgId: input.orgId, accountId: account.id, period, dayKey, minuteKey })
      .onConflictDoNothing();
    const [win] = await tx
      .select()
      .from(windows)
      .where(and(eq(windows.orgId, input.orgId), eq(windows.accountId, account.id), eq(windows.period, period)))
      .for("update");
    if (!win || win.paused) return refuse("budget_paused");

    // Reset rolling day/minute counters if the UTC day or minute advanced.
    const sameDay = win.dayKey === dayKey;
    const sameMinute = win.minuteKey === minuteKey;
    const dayRequestsUsed = sameDay ? win.dayRequestsUsed : 0;
    const dayRequestsHeld = sameDay ? win.dayRequestsHeld : 0;
    const dayTokensUsed = sameDay ? win.dayTokensUsed : 0;
    const dayNeuronsUsed = sameDay ? win.dayNeuronsUsed : 0;
    const dayNeuronsHeld = sameDay ? win.dayNeuronsHeld : 0;
    const minuteRequestsUsed = sameMinute ? win.minuteRequestsUsed : 0;
    const minuteTokensUsed = sameMinute ? win.minuteTokensUsed : 0;

    const estTokens = input.estimatedPromptTokens + input.maxOutputTokens;
    if (account.rpmLimit !== null && minuteRequestsUsed + dayRequestsHeld + 1 > account.rpmLimit) {
      return refuse("rpm_limit_reached");
    }
    if (account.rpdLimit !== null && dayRequestsUsed + dayRequestsHeld + 1 > account.rpdLimit) {
      return refuse("rpd_limit_reached");
    }
    if (account.tpmLimit !== null && minuteTokensUsed + estTokens > account.tpmLimit) {
      return refuse("tpm_limit_reached");
    }
    if (account.tpdLimit !== null && dayTokensUsed + estTokens > account.tpdLimit) {
      return refuse("tpd_limit_reached");
    }
    if (
      account.provider === "cloudflare" &&
      dayNeuronsUsed + dayNeuronsHeld + reservedNeurons > account.dailyNeuronsLimit
    ) {
      return refuse("cloudflare_neurons_exhausted");
    }

    if (account.entitlement === "paid_capped") {
      const nextCommitted = win.spentNanoUsd + win.heldNanoUsd + input.boundNanoUsd;
      if (!safeNonNegInt(nextCommitted) || nextCommitted > account.monthlyCapNanoUsd) {
        return refuse("budget_exhausted");
      }
      if (account.provider === "openrouter") {
        const totalOpenRouter = openRouterCombinedCommitted + nextCommitted;
        const ceiling = Math.min(account.monthlyCapNanoUsd, OPENROUTER_FALLBACK_MAX_NANO_USD);
        if (!safeNonNegInt(totalOpenRouter) || totalOpenRouter > ceiling) {
          return refuse("budget_exhausted");
        }
      }
    }

    const [createdAttempt] = await tx
      .insert(attempts)
      .values({
        orgId: input.orgId,
        accountId: account.id,
        period,
        runId: input.runId,
        routineRunId: input.routineRunId ?? null,
        agentId: input.agentId,
        turn: input.turn,
        attemptIndex,
        idempotencyKey: input.idempotencyKey,
        credentialId: account.credentialId,
        credentialVersion: account.credentialVersion,
        lane: account.lane,
        provider: account.provider,
        requestedModel: input.requestedModel,
        allowedModels: candidateModels,
        reservedNanoUsd: input.boundNanoUsd,
        reservedNeurons,
        escalatedFromId: input.escalatedFromId ?? null,
        state: "held",
        createdAt: at,
      })
      .returning();
    if (!createdAttempt) return refuse("reservation_failed");

    const nextHeld = win.heldNanoUsd + input.boundNanoUsd;
    const projectedUsed = win.spentNanoUsd + nextHeld;
    const warnings: BudgetThresholdWarning[] = [];
    let warned50 = win.warned50;
    let warned80 = win.warned80;
    let warned95 = win.warned95;
    if (account.entitlement === "paid_capped" && account.monthlyCapNanoUsd > 0) {
      const ratio = projectedUsed / account.monthlyCapNanoUsd;
      if (policy.warnAt50 && !warned50 && ratio >= 0.5) {
        warned50 = true;
        warnings.push({
          thresholdPercent: 50,
          accountId: account.id,
          provider: account.provider,
          lane: account.lane,
          usedNanoUsd: projectedUsed,
          capNanoUsd: account.monthlyCapNanoUsd,
        });
      }
      if (policy.warnAt80 && !warned80 && ratio >= 0.8) {
        warned80 = true;
        warnings.push({
          thresholdPercent: 80,
          accountId: account.id,
          provider: account.provider,
          lane: account.lane,
          usedNanoUsd: projectedUsed,
          capNanoUsd: account.monthlyCapNanoUsd,
        });
      }
      if (policy.warnAt95 && !warned95 && ratio >= 0.95) {
        warned95 = true;
        warnings.push({
          thresholdPercent: 95,
          accountId: account.id,
          provider: account.provider,
          lane: account.lane,
          usedNanoUsd: projectedUsed,
          capNanoUsd: account.monthlyCapNanoUsd,
        });
      }
    }

    await tx
      .update(windows)
      .set({
        heldNanoUsd: nextHeld,
        dayKey,
        dayRequestsUsed,
        dayRequestsHeld: dayRequestsHeld + 1,
        dayTokensUsed,
        dayNeuronsUsed,
        dayNeuronsHeld: dayNeuronsHeld + reservedNeurons,
        minuteKey,
        minuteRequestsUsed,
        minuteTokensUsed,
        warned50,
        warned80,
        warned95,
      })
      .where(and(eq(windows.orgId, input.orgId), eq(windows.accountId, account.id), eq(windows.period, period)));

    return {
      attemptId: createdAttempt.id,
      accountId: account.id,
      provider: account.provider,
      lane: account.lane,
      entitlement: account.entitlement,
      credentialId: account.credentialId,
      credentialVersion: account.credentialVersion,
      credentialFingerprint: account.credentialFingerprint,
      workspaceAccountRef: account.workspaceAccountRef,
      allowedModels: candidateModels,
      maxPromptNanoPerToken: account.maxPromptNanoPerToken,
      maxCompletionNanoPerToken: account.maxCompletionNanoPerToken,
      monthlyCapNanoUsd: account.monthlyCapNanoUsd,
      zdrRequired: account.zdrRequired,
      reservedNanoUsd: input.boundNanoUsd,
      reservedNeurons,
      warnings,
    };
  });
}

export type GlobalRouterSettleOutcome =
  | {
      kind: "not_sent";
      reason: string;
      /** On OpenRouter :free, upstream rejected attempts still count against RPD when reached. */
      upstreamAttempted?: boolean;
    }
  | {
      kind: "settled";
      actualModel: string;
      actualNanoUsd: number;
      actualNeurons?: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      latencyMs: number;
      qualityVerified: boolean;
      providerRequestId?: string | null;
    }
  | {
      kind: "unknown";
      reason: string;
    };

export async function settleGlobalRouterAttempt(
  db: Database,
  orgId: string,
  attemptId: string,
  outcome: GlobalRouterSettleOutcome,
  at = new Date(),
) {
  const refusal = await db.transaction(async (tx) => {
    const [att] = await tx
      .select()
      .from(attempts)
      .where(and(eq(attempts.orgId, orgId), eq(attempts.id, attemptId)))
      .for("update");
    if (!att || att.state !== "held") return "duplicate_or_unknown_receipt";

    const [account] = await tx
      .select()
      .from(accounts)
      .where(and(eq(accounts.orgId, orgId), eq(accounts.id, att.accountId)))
      .for("update");
    if (!account) return "account_missing";

    const [win] = await tx
      .select()
      .from(windows)
      .where(and(eq(windows.orgId, orgId), eq(windows.accountId, att.accountId), eq(windows.period, att.period)))
      .for("update");
    if (!win || win.heldNanoUsd < att.reservedNanoUsd) return "reconciliation_required";

    if (outcome.kind === "not_sent") {
      await tx
        .update(attempts)
        .set({ state: "released", failureReason: outcome.reason, settledAt: at })
        .where(eq(attempts.id, att.id));
      const countRequest = Boolean(outcome.upstreamAttempted);
      await tx
        .update(windows)
        .set({
          heldNanoUsd: win.heldNanoUsd - att.reservedNanoUsd,
          dayRequestsHeld: Math.max(0, win.dayRequestsHeld - 1),
          dayRequestsUsed: win.dayRequestsUsed + (countRequest ? 1 : 0),
          minuteRequestsUsed: win.minuteRequestsUsed + (countRequest ? 1 : 0),
          dayNeuronsHeld: Math.max(0, win.dayNeuronsHeld - att.reservedNeurons),
        })
        .where(and(eq(windows.orgId, orgId), eq(windows.accountId, att.accountId), eq(windows.period, att.period)));
      return null;
    }

    if (outcome.kind === "unknown") {
      await tx.update(attempts).set({ state: "unknown", failureReason: outcome.reason }).where(eq(attempts.id, att.id));
      await tx
        .update(windows)
        .set({ paused: true })
        .where(and(eq(windows.orgId, orgId), eq(windows.accountId, att.accountId), eq(windows.period, att.period)));
      await tx.update(accounts).set({ healthState: "paused", updatedAt: at }).where(eq(accounts.id, account.id));
      return "reconciliation_required";
    }

    const actualNeurons = outcome.actualNeurons ?? att.reservedNeurons;
    const deny = routerDenylistReason(att.provider, outcome.actualModel);
    const modelMatched =
      att.allowedModels.includes(outcome.actualModel) ||
      (att.provider !== "openrouter" && outcome.actualModel === att.requestedModel);
    const freeViolated =
      (account.entitlement === "free_only" || account.entitlement === "subscription_go") && outcome.actualNanoUsd !== 0;

    if (
      deny ||
      !modelMatched ||
      freeViolated ||
      !safeNonNegInt(outcome.actualNanoUsd) ||
      !safeNonNegInt(actualNeurons) ||
      !safeNonNegInt(outcome.inputTokens) ||
      !safeNonNegInt(outcome.outputTokens)
    ) {
      const why = deny
        ? deny
        : !modelMatched
          ? "unexpected_actual_model"
          : freeViolated
            ? "free_route_charged_unexpectedly"
            : "invalid_receipt";
      await tx.update(attempts).set({ state: "unknown", failureReason: why }).where(eq(attempts.id, att.id));
      await tx
        .update(windows)
        .set({ paused: true })
        .where(and(eq(windows.orgId, orgId), eq(windows.accountId, att.accountId), eq(windows.period, att.period)));
      await tx.update(accounts).set({ healthState: "paused", updatedAt: at }).where(eq(accounts.id, account.id));
      return why;
    }

    const overBound = account.entitlement === "paid_capped" && outcome.actualNanoUsd > att.reservedNanoUsd;
    await tx
      .update(attempts)
      .set({
        state: "settled",
        actualModel: outcome.actualModel,
        actualNanoUsd: outcome.actualNanoUsd,
        actualNeurons,
        inputTokens: outcome.inputTokens,
        outputTokens: outcome.outputTokens,
        cacheReadTokens: outcome.cacheReadTokens ?? 0,
        latencyMs: Math.max(0, Math.round(outcome.latencyMs)),
        qualityVerified: outcome.qualityVerified,
        providerRequestId: outcome.providerRequestId?.slice(0, 128) ?? null,
        settledAt: at,
      })
      .where(eq(attempts.id, att.id));

    const totalTokens = outcome.inputTokens + outcome.outputTokens;
    const nextSpent = win.spentNanoUsd + outcome.actualNanoUsd;
    await tx
      .update(windows)
      .set({
        heldNanoUsd: win.heldNanoUsd - att.reservedNanoUsd,
        spentNanoUsd: nextSpent,
        dayRequestsHeld: Math.max(0, win.dayRequestsHeld - 1),
        dayRequestsUsed: win.dayRequestsUsed + 1,
        dayTokensUsed: win.dayTokensUsed + totalTokens,
        dayNeuronsHeld: Math.max(0, win.dayNeuronsHeld - att.reservedNeurons),
        dayNeuronsUsed: win.dayNeuronsUsed + actualNeurons,
        minuteRequestsUsed: win.minuteRequestsUsed + 1,
        minuteTokensUsed: win.minuteTokensUsed + totalTokens,
        paused: win.paused || overBound,
      })
      .where(and(eq(windows.orgId, orgId), eq(windows.accountId, att.accountId), eq(windows.period, att.period)));

    if (overBound) {
      await tx.update(accounts).set({ healthState: "paused", updatedAt: at }).where(eq(accounts.id, account.id));
      return "cost_bound_exceeded";
    }
    return null;
  });
  if (refusal) return refuse(refusal);
}

/** Owner-only authoritative reconciliation of an ambiguous `unknown` attempt. */
export async function reconcileGlobalRouterAttempt(
  db: Database,
  orgId: string,
  actor: string,
  attemptId: string,
  resolution:
    | { kind: "proven_no_send"; note: string }
    | { kind: "confirmed_charge"; actualModel: string; actualNanoUsd: number; note: string },
  at = new Date(),
) {
  return db.transaction(async (tx) => {
    await requireOwner(tx, orgId, actor);
    const [att] = await tx
      .select()
      .from(attempts)
      .where(and(eq(attempts.orgId, orgId), eq(attempts.id, attemptId)))
      .for("update");
    if (!att || att.state !== "unknown") return refuse("attempt_not_reconcilable");
    const [account] = await tx
      .select()
      .from(accounts)
      .where(and(eq(accounts.orgId, orgId), eq(accounts.id, att.accountId)))
      .for("update");
    if (!account) return refuse("account_missing");
    const [win] = await tx
      .select()
      .from(windows)
      .where(and(eq(windows.orgId, orgId), eq(windows.accountId, att.accountId), eq(windows.period, att.period)))
      .for("update");
    if (!win || win.heldNanoUsd < att.reservedNanoUsd) return refuse("window_inconsistent");

    if (resolution.kind === "proven_no_send") {
      await tx
        .update(attempts)
        .set({ state: "released", failureReason: `reconciled_no_send:${resolution.note.slice(0, 120)}`, settledAt: at })
        .where(eq(attempts.id, att.id));
      await tx
        .update(windows)
        .set({
          heldNanoUsd: win.heldNanoUsd - att.reservedNanoUsd,
          dayRequestsHeld: Math.max(0, win.dayRequestsHeld - 1),
          dayNeuronsHeld: Math.max(0, win.dayNeuronsHeld - att.reservedNeurons),
        })
        .where(and(eq(windows.orgId, orgId), eq(windows.accountId, att.accountId), eq(windows.period, att.period)));
    } else {
      if (!safeNonNegInt(resolution.actualNanoUsd)) return refuse("invalid_reconciliation_amount");
      await tx
        .update(attempts)
        .set({
          state: "settled",
          actualModel: resolution.actualModel,
          actualNanoUsd: resolution.actualNanoUsd,
          failureReason: `reconciled_charge:${resolution.note.slice(0, 120)}`,
          settledAt: at,
        })
        .where(eq(attempts.id, att.id));
      await tx
        .update(windows)
        .set({
          heldNanoUsd: win.heldNanoUsd - att.reservedNanoUsd,
          spentNanoUsd: win.spentNanoUsd + resolution.actualNanoUsd,
          dayRequestsHeld: Math.max(0, win.dayRequestsHeld - 1),
          dayNeuronsHeld: Math.max(0, win.dayNeuronsHeld - att.reservedNeurons),
        })
        .where(and(eq(windows.orgId, orgId), eq(windows.accountId, att.accountId), eq(windows.period, att.period)));
    }

    const [stillUnknown] = await tx
      .select({ id: attempts.id })
      .from(attempts)
      .where(and(eq(attempts.orgId, orgId), eq(attempts.accountId, att.accountId), eq(attempts.state, "unknown")))
      .limit(1);
    if (!stillUnknown) {
      await tx
        .update(windows)
        .set({ paused: false })
        .where(and(eq(windows.orgId, orgId), eq(windows.accountId, att.accountId), eq(windows.period, att.period)));
      await tx.update(accounts).set({ healthState: "healthy", updatedAt: at }).where(eq(accounts.id, account.id));
    }
    return { reconciled: true, stillBlocked: Boolean(stillUnknown) };
  });
}

/** Read-only non-secret status projection for Model Inspector & Global Router UI. */
export async function readGlobalModelRouterStatus(db: Executor, orgId: string, at = new Date()) {
  const period = periodOf(at);
  const [policy] = await db.select().from(policies).where(eq(policies.orgId, orgId));
  const accountRows = await db.select().from(accounts).where(eq(accounts.orgId, orgId));
  const windowRows = await db
    .select()
    .from(windows)
    .where(and(eq(windows.orgId, orgId), eq(windows.period, period)));
  const offerRows = await db.select().from(offersTable).where(eq(offersTable.orgId, orgId));
  const recentAttempts = await db
    .select()
    .from(attempts)
    .where(eq(attempts.orgId, orgId))
    .orderBy(desc(attempts.createdAt))
    .limit(50);
  const [latestBenchmark] = await db
    .select()
    .from(benchmarks)
    .where(eq(benchmarks.orgId, orgId))
    .orderBy(desc(benchmarks.createdAt))
    .limit(1);

  const windowByAccount = new Map(windowRows.map((w) => [w.accountId, w]));
  const nowMs = at.getTime();

  // Compute quality/cost per verified success per actual model from settled attempts.
  const modelMetrics = new Map<
    string,
    {
      model: string;
      provider: string;
      lane: string;
      attempts: number;
      verifiedSuccesses: number;
      totalSpendNanoUsd: number;
      latencies: number[];
    }
  >();
  for (const a of recentAttempts) {
    if (a.state !== "settled" || !a.actualModel) continue;
    const key = `${a.provider}:${a.actualModel}`;
    const entry = modelMetrics.get(key) ?? {
      model: a.actualModel,
      provider: a.provider,
      lane: a.lane,
      attempts: 0,
      verifiedSuccesses: 0,
      totalSpendNanoUsd: 0,
      latencies: [],
    };
    entry.attempts++;
    if (a.qualityVerified) entry.verifiedSuccesses++;
    entry.totalSpendNanoUsd += a.actualNanoUsd ?? 0;
    if (typeof a.latencyMs === "number") entry.latencies.push(a.latencyMs);
    modelMetrics.set(key, entry);
  }

  const metrics = [...modelMetrics.values()].map((m) => {
    const sorted = [...m.latencies].sort((x, y) => x - y);
    const p50 = sorted.length ? (sorted[Math.floor((sorted.length - 1) * 0.5)] ?? 0) : null;
    const p95 = sorted.length ? (sorted[Math.floor((sorted.length - 1) * 0.95)] ?? 0) : null;
    return {
      provider: m.provider,
      lane: m.lane,
      model: m.model,
      attempts: m.attempts,
      verifiedSuccesses: m.verifiedSuccesses,
      totalSpendNanoUsd: m.totalSpendNanoUsd,
      costPerVerifiedSuccessNanoUsd:
        m.verifiedSuccesses > 0 ? Math.round(m.totalSpendNanoUsd / m.verifiedSuccesses) : null,
      p50LatencyMs: p50,
      p95LatencyMs: p95,
    };
  });

  return {
    observedAt: at.toISOString(),
    period,
    policy: {
      enabled: policy?.enabled ?? false,
      killSwitch: policy?.killSwitch ?? false,
      optOutAgentIds: policy?.optOutAgentIds ?? [],
      maxEscalations: policy?.maxEscalations ?? 2,
      maxRetriesPerRoute: policy?.maxRetriesPerRoute ?? 1,
      warnAt50: policy?.warnAt50 ?? true,
      warnAt80: policy?.warnAt80 ?? true,
      warnAt95: policy?.warnAt95 ?? true,
      revision: policy?.revision ?? 0,
    },
    accounts: accountRows.map((a) => {
      const w = windowByAccount.get(a.id);
      const spent = w?.spentNanoUsd ?? 0;
      const held = w?.heldNanoUsd ?? 0;
      const usedRatio = a.monthlyCapNanoUsd > 0 ? (spent + held) / a.monthlyCapNanoUsd : 0;
      const unknownCount = recentAttempts.filter((att) => att.accountId === a.id && att.state === "unknown").length;
      const uiState =
        a.killSwitch || !a.enabled
          ? "disabled"
          : unknownCount > 0 || w?.paused
            ? "budget_held"
            : a.healthState === "reauth_required"
              ? "authorization_needed"
              : a.healthState === "outage"
                ? "provider_outage"
                : a.healthState === "rate_limited"
                  ? "rate_limited"
                  : a.monthlyCapNanoUsd > 0 && spent + held >= a.monthlyCapNanoUsd
                    ? "budget_held"
                    : usedRatio >= 0.8 || a.healthState === "quota_warning"
                      ? "quota_warning"
                      : "eligible";
      return {
        id: a.id,
        provider: a.provider,
        lane: a.lane,
        entitlement: a.entitlement,
        credentialId: a.credentialId,
        workspaceAccountRef: a.workspaceAccountRef,
        enabled: a.enabled,
        killSwitch: a.killSwitch,
        extraUsageAllowed: false as const,
        monthlyCapNanoUsd: a.monthlyCapNanoUsd,
        spentNanoUsd: spent,
        heldNanoUsd: held,
        allowedModels: a.allowedModels,
        rpmLimit: a.rpmLimit,
        rpdLimit: a.rpdLimit,
        dailyNeuronsLimit: a.dailyNeuronsLimit,
        dayRequestsUsed: w?.dayRequestsUsed ?? 0,
        dayNeuronsUsed: w?.dayNeuronsUsed ?? 0,
        zdrRequired: a.zdrRequired,
        allowedRegion: a.allowedRegion,
        healthState: a.healthState,
        uiState,
        resetsAt: a.resetsAt?.toISOString() ?? null,
        quotaObservedAt: a.quotaObservedAt?.toISOString() ?? null,
        revision: a.revision,
      };
    }),
    offers: offerRows.map((r) => {
      const offer = r.offer as unknown as ModelOffer;
      const fresh = evaluateOfferEligibility(offer, nowMs);
      return {
        offerId: r.offerId,
        provider: r.provider,
        lane: r.lane,
        modelId: r.modelId,
        label: r.label,
        freeEligible: r.freeEligible,
        qualificationStatus:
          r.qualificationStatus === "eligible" && !fresh.eligible && fresh.reason === "stale_catalog"
            ? "stale"
            : r.qualificationStatus,
        disabledReason: fresh.eligible ? null : fresh.reason,
        contextWindow: offer.contextWindow,
        capabilities: offer.capabilities,
        prices: offer.prices,
        observedAt: r.observedAt.toISOString(),
        expiresAt: r.expiresAt.toISOString(),
      };
    }),
    recentReceipts: recentAttempts.slice(0, 20).map((att) => ({
      id: att.id,
      runId: att.runId,
      routineRunId: att.routineRunId,
      agentId: att.agentId,
      turn: att.turn,
      attemptIndex: att.attemptIndex,
      lane: att.lane,
      provider: att.provider,
      requestedModel: att.requestedModel,
      actualModel: att.actualModel,
      reservedNanoUsd: att.reservedNanoUsd,
      actualNanoUsd: att.actualNanoUsd,
      state: att.state,
      qualityVerified: att.qualityVerified,
      latencyMs: att.latencyMs,
      failureReason: att.failureReason,
      createdAt: att.createdAt.toISOString(),
      settledAt: att.settledAt?.toISOString() ?? null,
    })),
    metrics,
    latestBenchmark: latestBenchmark
      ? {
          id: latestBenchmark.id,
          suiteVersion: latestBenchmark.suiteVersion,
          taskCount: latestBenchmark.taskCount,
          modelCount: latestBenchmark.modelCount,
          summary: latestBenchmark.summary,
          createdAt: latestBenchmark.createdAt.toISOString(),
        }
      : null,
  };
}
