import {
  assertActiveMembership,
  ConflictError,
  can,
  configureGlobalRouterPolicy,
  ForbiddenError,
  GlobalRouterRefusal,
  getMembership,
  isUniqueViolation,
  readGlobalModelRouterStatus,
  reconcileGlobalRouterAttempt,
  refreshLiveGlobalRouterCatalog,
  requirePermission,
  upsertGlobalRouterAccount,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { type AppDeps, body, createAppRouter, errors, json, OrgParams, requireSession, security } from "./context";

const basePath = "/organizations/{orgId}/global-model-router";
const tags = ["Global Model Router"];

const policyBody = z
  .object({
    enabled: z.boolean(),
    killSwitch: z.boolean().optional(),
    optOutAgentIds: z.array(z.string().min(1).max(64)).max(256).optional(),
    maxEscalations: z.number().int().min(0).max(2).optional(),
    maxRetriesPerRoute: z.number().int().min(0).max(1).optional(),
    warnAt50: z.boolean().optional(),
    warnAt80: z.boolean().optional(),
    warnAt95: z.boolean().optional(),
  })
  .strict();

const accountBody = z
  .object({
    provider: z.enum([
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
    ]),
    lane: z.enum(["opencode_go", "free_api", "paid_low_cost", "paid_dynamic", "direct_api"]),
    entitlement: z.enum(["subscription_go", "free_only", "paid_capped"]),
    credentialId: z.uuid(),
    workspaceAccountRef: z.string().max(128).nullable().optional(),
    enabled: z.boolean(),
    killSwitch: z.boolean().optional(),
    monthlyCapUsd: z.number().min(0).max(10_000).optional(),
    maxPromptUsdPerMillion: z.number().positive().max(10_000).optional(),
    maxCompletionUsdPerMillion: z.number().positive().max(10_000).optional(),
    allowedModels: z.array(z.string().min(2).max(120)).max(128),
    rpmLimit: z.number().int().positive().max(1_000_000).nullable().optional(),
    rpdLimit: z.number().int().positive().max(10_000_000).nullable().optional(),
    tpmLimit: z.number().int().positive().max(1_000_000_000).nullable().optional(),
    tpdLimit: z.number().int().positive().max(10_000_000_000).nullable().optional(),
    dailyNeuronsLimit: z.number().int().positive().max(10_000_000).optional(),
    zdrRequired: z.boolean().optional(),
    allowedRegion: z.enum(["global", "us_eu", "cn"]).optional(),
  })
  .strict();

const syncBody = z
  .object({
    sources: z
      .array(z.enum(["openrouter", "opencode", "groq", "cloudflare", "direct"]))
      .min(1)
      .max(5)
      .optional(),
  })
  .strict();

const reconcileBody = z.discriminatedUnion("kind", [
  z
    .object({
      attemptId: z.uuid(),
      kind: z.literal("proven_no_send"),
      note: z.string().min(3).max(240),
    })
    .strict(),
  z
    .object({
      attemptId: z.uuid(),
      kind: z.literal("confirmed_charge"),
      actualModel: z.string().min(2).max(120),
      actualNanoUsd: z.number().int().min(0).max(10_000_000_000_000),
      note: z.string().min(3).max(240),
    })
    .strict(),
]);

const statusView = z.object({
  serverEnabled: z.boolean(),
  canManagePolicy: z.boolean(),
  observedAt: z.string(),
  period: z.string(),
  policy: z.object({
    enabled: z.boolean(),
    killSwitch: z.boolean(),
    optOutAgentIds: z.array(z.string()),
    maxEscalations: z.number(),
    maxRetriesPerRoute: z.number(),
    warnAt50: z.boolean(),
    warnAt80: z.boolean(),
    warnAt95: z.boolean(),
    revision: z.number(),
  }),
  accounts: z.array(z.record(z.string(), z.unknown())),
  offers: z.array(z.record(z.string(), z.unknown())),
  recentReceipts: z.array(z.record(z.string(), z.unknown())),
  metrics: z.array(z.record(z.string(), z.unknown())),
  latestBenchmark: z.record(z.string(), z.unknown()).nullable(),
});

export function globalModelRouterRoutes(deps: AppDeps) {
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));

  const requireOwner = async (orgId: string, userId: string) => {
    const member = await getMembership(deps.db, userId, orgId);
    if (member?.role !== "owner") throw new ForbiddenError();
    assertActiveMembership(member);
  };

  const buildView = async (orgId: string, canManagePolicy: boolean) => ({
    serverEnabled: deps.config.GLOBAL_MODEL_ROUTER_ENABLED,
    canManagePolicy,
    ...(await readGlobalModelRouterStatus(deps.db, orgId)),
  });

  app.openapi(
    createRoute({
      method: "get",
      path: basePath,
      tags,
      security,
      summary: "Read Global Model Router policy, quotas, offers, receipts, and quality/cost metrics",
      description:
        "Readable by workspace owners or members with both manage_agents and view_usage. Never returns credentials or dispatches provider calls.",
      request: { params: OrgParams },
      responses: { 200: json(statusView), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const userId = c.get("user").id;
      const member = await getMembership(deps.db, userId, orgId);
      if (!member) throw new ForbiddenError();
      assertActiveMembership(member);
      const isOwner = member.role === "owner";
      if (!isOwner) {
        const permMember = await requirePermission(deps.db, userId, orgId, "manage_agents");
        if (!can(permMember, "view_usage")) throw new ForbiddenError();
      }
      return c.json(await buildView(orgId, isOwner), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: `${basePath}/policy`,
      tags,
      security,
      summary: "Configure workspace Global Model Router opt-in, kill switch, opt-out list, and escalation bounds",
      request: { params: OrgParams, body: body(policyBody) },
      responses: { 200: json(statusView), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const actor = c.get("user").id;
      await requireOwner(orgId, actor);
      const input = c.req.valid("json");
      if (input.enabled && !deps.config.GLOBAL_MODEL_ROUTER_ENABLED) {
        throw new ConflictError("Global Model Router is disabled on this server", "global_router.disabled");
      }
      try {
        await configureGlobalRouterPolicy(deps.db, orgId, actor, input);
      } catch (err) {
        if (err instanceof GlobalRouterRefusal) {
          throw new ConflictError("Global Model Router policy change refused", `global_router.${err.reason}`);
        }
        throw err;
      }
      return c.json(await buildView(orgId, true), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: `${basePath}/accounts`,
      tags,
      security,
      summary: "Configure an owner-approved Global Model Router provider lane and cap",
      request: { params: OrgParams, body: body(accountBody) },
      responses: { 200: json(statusView), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const actor = c.get("user").id;
      await requireOwner(orgId, actor);
      const input = c.req.valid("json");
      try {
        await upsertGlobalRouterAccount(deps.db, orgId, actor, input);
      } catch (err) {
        if (err instanceof GlobalRouterRefusal) {
          throw new ConflictError("Global Model Router account change refused", `global_router.${err.reason}`);
        }
        if (isUniqueViolation(err)) {
          throw new ConflictError("This router credential is already bound", "global_router.conflict");
        }
        throw err;
      }
      return c.json(await buildView(orgId, true), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: `${basePath}/sync-catalog`,
      tags,
      security,
      summary: "Refresh live cloud model catalog offers without dispatching inference",
      request: { params: OrgParams, body: body(syncBody) },
      responses: {
        200: json(
          z.object({
            sync: z.object({
              stored: z.number(),
              observedAt: z.string(),
              sources: z.array(
                z.object({
                  source: z.string(),
                  ok: z.boolean(),
                  offerCount: z.number(),
                  eligibleCount: z.number(),
                  error: z.string().optional(),
                }),
              ),
            }),
            status: statusView,
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const actor = c.get("user").id;
      await requireOwner(orgId, actor);
      const input = c.req.valid("json");
      const sync = await refreshLiveGlobalRouterCatalog(deps.db, orgId, actor, {
        fetch: deps.extras?.http,
        keyWrappers: [deps.adapters.keyWrapper, ...deps.adapters.legacyKeyWrappers],
        sources: input.sources,
      });
      return c.json({ sync, status: await buildView(orgId, true) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: `${basePath}/reconcile`,
      tags,
      security,
      summary: "Reconcile an ambiguous held router attempt with owner proof",
      request: { params: OrgParams, body: body(reconcileBody) },
      responses: { 200: json(statusView), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const actor = c.get("user").id;
      await requireOwner(orgId, actor);
      const input = c.req.valid("json");
      try {
        if (input.kind === "proven_no_send") {
          await reconcileGlobalRouterAttempt(deps.db, orgId, actor, input.attemptId, {
            kind: "proven_no_send",
            note: input.note,
          });
        } else {
          await reconcileGlobalRouterAttempt(deps.db, orgId, actor, input.attemptId, {
            kind: "confirmed_charge",
            actualModel: input.actualModel,
            actualNanoUsd: input.actualNanoUsd,
            note: input.note,
          });
        }
      } catch (err) {
        if (err instanceof GlobalRouterRefusal) {
          throw new ConflictError("Global Model Router reconciliation refused", `global_router.${err.reason}`);
        }
        throw err;
      }
      return c.json(await buildView(orgId, true), 200);
    },
  );

  return app;
}
