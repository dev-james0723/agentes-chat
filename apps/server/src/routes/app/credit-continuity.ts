import { and, eq, schema } from "@agenteschat/db";
import {
  approveCreditReserve,
  assertActiveMembership,
  ConflictError,
  type CreditPoolEvidence,
  CreditRouteRefusal,
  ensureCreditCredentialIdentity,
  ForbiddenError,
  getMembership,
  isUniqueViolation,
  NotFoundError,
  reconcileCreditAttempt,
  refreshCreditPoolEvidence,
  refreshCreditRoutePricingEvidence,
  registerCreditPool,
  registerCreditRoute,
  resumeReconciledCreditRun,
  setCreditRouteEnabled,
  startCreditGrantCycle,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { type AppDeps, body, createAppRouter, errors, json, OrgParams, requireSession, security } from "./context";

const tags = ["Credit continuity"];
const base = "/organizations/{orgId}/credit-continuity";
const ref = z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/);
const amount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const instant = z.iso.datetime({ offset: true });
const actor = { actorUserId: z.string().min(1).max(200).optional() };
const poolParams = OrgParams.extend({ poolId: z.uuid() });
const routeParams = OrgParams.extend({ routeId: z.uuid() });
const attemptParams = OrgParams.extend({ attemptId: z.uuid() });
const runParams = OrgParams.extend({ runId: z.uuid() });
const evidenceSchema = z
  .object({
    provider: z.enum(["openai", "anthropic"]),
    upstreamAccount: ref,
    product: z.enum(["openai_pro_api", "claude_ultra_api"]),
    cycleKey: ref,
    grantId: ref,
    grantStart: instant,
    grantEnd: instant,
    eligibleSince: instant,
    activatedAt: instant,
    enforcement: z.literal("prepaid_grant_only"),
    externalSpendCoverage: z.enum(["exclusive", "bounded"]),
    externalSpendBoundNanoUsd: amount,
    evidenceRef: ref,
    verifiedAt: instant,
    validUntil: instant,
    grantAmountNanoUsd: amount,
    observedRemainingNanoUsd: amount,
  })
  .strict();
const pricingEvidenceSchema = z
  .object({
    evidenceRef: ref,
    verifiedAt: instant,
    validUntil: instant,
    profileHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
const evidenceBody = z.object({ ...actor, evidence: evidenceSchema }).strict();

function pricingEvidenceOf(input: z.infer<typeof pricingEvidenceSchema>) {
  return { ...input, verifiedAt: new Date(input.verifiedAt), validUntil: new Date(input.validUntil) };
}

function evidenceOf(input: z.infer<typeof evidenceSchema>, userId: string): CreditPoolEvidence {
  return {
    ...input,
    verifiedByUserId: userId,
    grantStart: new Date(input.grantStart),
    grantEnd: new Date(input.grantEnd),
    eligibleSince: new Date(input.eligibleSince),
    activatedAt: new Date(input.activatedAt),
    verifiedAt: new Date(input.verifiedAt),
    validUntil: new Date(input.validUntil),
  };
}

/** Only bounded refusal codes cross HTTP. Provider bodies and credentials never do. */
async function mutate<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof CreditRouteRefusal)
      throw new ConflictError("Credit continuity change refused", `credit.${error.reason}`);
    if (isUniqueViolation(error)) throw new ConflictError("Credit continuity record already exists", "credit.conflict");
    throw error;
  }
}

/**
 * Owner preparation and explicit approval, using the existing session/CSRF/standing guards.
 * No endpoint buys credits, directly dispatches a model request or declares work complete.
 * Recovery only re-enqueues a reconciled run through the existing scheduler.
 */
export function creditContinuityRoutes(deps: AppDeps) {
  const app = createAppRouter(deps);
  const { db, config } = deps;
  app.use("/organizations/*", requireSession(deps.auth));

  async function owner(orgId: string, userId: string, assertedActor?: string) {
    if (assertedActor !== undefined && assertedActor !== userId) throw new ForbiddenError();
    const membership = await getMembership(db, userId, orgId);
    if (membership?.role !== "owner") throw new ForbiddenError();
    assertActiveMembership(membership);
    return userId;
  }
  function requireEnabled() {
    if (!config.CREDIT_FALLBACK_ENABLED)
      throw new ConflictError("Credit continuity is disabled on this server", "credit.disabled");
  }

  app.openapi(
    createRoute({
      method: "post",
      path: `${base}/pools`,
      tags,
      security,
      summary: "Register verified provider grant evidence without enabling spending",
      request: { params: OrgParams, body: body(evidenceBody) },
      responses: { 201: json(z.object({ poolId: z.uuid(), enabled: z.literal(false) })), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const input = c.req.valid("json");
      const userId = await owner(orgId, c.get("user").id, input.actorUserId);
      const poolId = await mutate(() => registerCreditPool(db, orgId, evidenceOf(input.evidence, userId)));
      return c.json({ poolId, enabled: false as const }, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: `${base}/pools/{poolId}/evidence`,
      tags,
      security,
      summary: "Refresh evidence conservatively within the same grant cycle",
      request: { params: poolParams, body: body(evidenceBody) },
      responses: { 200: json(z.object({ updated: z.literal(true) })), ...errors },
    }),
    async (c) => {
      const { orgId, poolId } = c.req.valid("param");
      const input = c.req.valid("json");
      const userId = await owner(orgId, c.get("user").id, input.actorUserId);
      await mutate(() => refreshCreditPoolEvidence(db, orgId, poolId, evidenceOf(input.evidence, userId)));
      return c.json({ updated: true as const }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: `${base}/pools/{poolId}/cycles`,
      tags,
      security,
      summary: "Prepare a verified new billing cycle with spending disabled",
      request: { params: poolParams, body: body(evidenceBody) },
      responses: { 201: json(z.object({ cycleId: z.uuid(), enabled: z.literal(false) })), ...errors },
    }),
    async (c) => {
      const { orgId, poolId } = c.req.valid("param");
      const input = c.req.valid("json");
      const userId = await owner(orgId, c.get("user").id, input.actorUserId);
      const cycleId = await mutate(() => startCreditGrantCycle(db, orgId, poolId, evidenceOf(input.evidence, userId)));
      return c.json({ cycleId, enabled: false as const }, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: `${base}/routes`,
      tags,
      security,
      summary: "Register a disabled route bound to an existing provider credential",
      request: {
        params: OrgParams,
        body: body(
          z
            .object({
              ...actor,
              poolId: z.uuid(),
              credentialId: z.uuid(),
              model: ref,
              supportsTools: z.boolean(),
              maxPromptBytes: z.number().int().positive().max(16_000_000),
              routeKind: z.enum(["openai_responses", "anthropic_messages", "claude_agent_sdk"]),
              accountEvidenceRef: ref,
              pricingEvidence: pricingEvidenceSchema,
              capabilities: z.array(ref).max(32).optional(),
            })
            .strict(),
        ),
      },
      responses: { 201: json(z.object({ routeId: z.uuid(), enabled: z.literal(false) })), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const { actorUserId, ...input } = c.req.valid("json");
      const userId = await owner(orgId, c.get("user").id, actorUserId);
      const routeId = await mutate(async () => {
        await ensureCreditCredentialIdentity(
          db,
          [deps.adapters.keyWrapper, ...deps.adapters.legacyKeyWrappers],
          orgId,
          input.credentialId,
        );
        return registerCreditRoute(
          db,
          orgId,
          { ...input, pricingEvidence: pricingEvidenceOf(input.pricingEvidence) },
          undefined,
          userId,
        );
      });
      return c.json({ routeId, enabled: false as const }, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: `${base}/routes/{routeId}/pricing-evidence`,
      tags,
      security,
      summary: "Refresh verified pricing and disable the route pending explicit reactivation",
      request: {
        params: routeParams,
        body: body(z.object({ ...actor, pricingEvidence: pricingEvidenceSchema }).strict()),
      },
      responses: { 200: json(z.object({ updated: z.literal(true), enabled: z.literal(false) })), ...errors },
    }),
    async (c) => {
      const { orgId, routeId } = c.req.valid("param");
      const input = c.req.valid("json");
      const userId = await owner(orgId, c.get("user").id, input.actorUserId);
      await mutate(() =>
        refreshCreditRoutePricingEvidence(
          db,
          orgId,
          routeId,
          pricingEvidenceOf(input.pricingEvidence),
          undefined,
          userId,
        ),
      );
      return c.json({ updated: true as const, enabled: false as const }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: `${base}/routes/{routeId}`,
      tags,
      security,
      summary: "Enable a verified route or disable it without requiring the feature flag",
      request: { params: routeParams, body: body(z.object({ ...actor, enabled: z.boolean() }).strict()) },
      responses: { 200: json(z.object({ enabled: z.boolean() })), ...errors },
    }),
    async (c) => {
      const { orgId, routeId } = c.req.valid("param");
      const input = c.req.valid("json");
      const userId = await owner(orgId, c.get("user").id, input.actorUserId);
      if (input.enabled) requireEnabled();
      await mutate(() => setCreditRouteEnabled(db, orgId, routeId, input.enabled, undefined, userId));
      return c.json({ enabled: input.enabled }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: `${base}/pools/{poolId}/emergency-approvals`,
      tags,
      security,
      summary: "Explicitly approve a bounded emergency grant reserve for this cycle",
      request: {
        params: poolParams,
        body: body(
          z
            .object({
              ...actor,
              cycleId: z.uuid(),
              amountNanoUsd: amount.positive(),
              validUntil: instant,
              decisionKey: ref,
              evidenceRef: ref,
            })
            .strict(),
        ),
      },
      responses: { 201: json(z.object({ approvalId: z.uuid() })), ...errors },
    }),
    async (c) => {
      const { orgId, poolId } = c.req.valid("param");
      const { actorUserId, validUntil, ...input } = c.req.valid("json");
      const userId = await owner(orgId, c.get("user").id, actorUserId);
      requireEnabled();
      const approvalId = await mutate(() =>
        approveCreditReserve(db, orgId, poolId, userId, {
          ...input,
          validUntil: new Date(validUntil),
        }),
      );
      return c.json({ approvalId }, 201);
    },
  );

  const reconciliation = {
    ...actor,
    evidenceRef: ref,
    reason: ref,
  };
  app.openapi(
    createRoute({
      method: "post",
      path: `${base}/attempts/{attemptId}/reconcile`,
      tags,
      security,
      summary: "Reconcile one existing debit without resuming or completing its task",
      request: {
        params: attemptParams,
        body: body(
          z.discriminatedUnion("outcome", [
            z.object({ ...reconciliation, outcome: z.literal("settled"), actualNanoUsd: amount }).strict(),
            z.object({ ...reconciliation, outcome: z.literal("released") }).strict(),
          ]),
        ),
      },
      responses: { 200: json(z.object({ changed: z.boolean(), state: z.string() })), ...errors },
    }),
    async (c) => {
      const { orgId, attemptId } = c.req.valid("param");
      const input = c.req.valid("json");
      const userId = await owner(orgId, c.get("user").id, input.actorUserId);
      const [attempt] = await db
        .select({ id: schema.creditAttempts.id })
        .from(schema.creditAttempts)
        .where(and(eq(schema.creditAttempts.orgId, orgId), eq(schema.creditAttempts.id, attemptId)))
        .limit(1);
      if (!attempt) throw new NotFoundError();
      const result = await mutate(() =>
        reconcileCreditAttempt(db, orgId, attemptId, userId, {
          evidenceRef: input.evidenceRef,
          reason: input.reason,
          ...(input.outcome === "settled" ? { actualNanoUsd: input.actualNanoUsd } : {}),
        }),
      );
      return c.json(result, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: `${base}/runs/{runId}/resume`,
      tags,
      security,
      summary: "Resume an explicitly reconciled run through the existing scheduler",
      request: { params: runParams, body: body(z.object({ ...actor, evidenceRef: ref }).strict()) },
      responses: { 200: json(z.object({ resumed: z.literal(true) })), ...errors },
    }),
    async (c) => {
      const { orgId, runId } = c.req.valid("param");
      const input = c.req.valid("json");
      const userId = await owner(orgId, c.get("user").id, input.actorUserId);
      const resumed = await mutate(() =>
        resumeReconciledCreditRun(db, {
          orgId,
          runId,
          actorUserId: userId,
          evidenceRef: input.evidenceRef,
        }),
      );
      if (!resumed) throw new ConflictError("This run is not ready to resume", "credit.resume_refused");
      return c.json({ resumed: true as const }, 200);
    },
  );

  return app;
}
