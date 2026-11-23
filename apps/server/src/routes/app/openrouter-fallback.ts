import {
  assertActiveMembership,
  ConflictError,
  configureOpenRouterFallback,
  ForbiddenError,
  getMembership,
  isUniqueViolation,
  OpenRouterFallbackRefusal,
  readOpenRouterFallback,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { type AppDeps, body, createAppRouter, errors, json, OrgParams, requireSession, security } from "./context";

const path = "/organizations/{orgId}/openrouter-fallback";
const tags = ["OpenRouter fallback"];
const policy = z
  .object({
    allowedModels: z.array(z.string().min(3).max(100)).min(1).max(64),
    costTier: z.enum(["low", "medium", "high", "xhigh", "max"]),
    monthlyCapUsd: z.number().positive().max(50),
    maxPromptUsdPerMillion: z.number().positive().max(10_000),
    maxCompletionUsdPerMillion: z.number().positive().max(10_000),
  })
  .strict();
const change = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(false) }).strict(),
  z.object({ enabled: z.literal(true), credentialId: z.uuid(), policy }).strict(),
]);
const view = z.object({
  serverEnabled: z.boolean(),
  enabled: z.boolean(),
  monthlyCapNanoUsd: z.number(),
  credentialId: z.uuid().nullable(),
  revision: z.number(),
  policy: z.record(z.string(), z.unknown()),
  period: z.string(),
  spentNanoUsd: z.number(),
  heldNanoUsd: z.number(),
  blocked: z.boolean(),
});

export function openRouterFallbackRoutes(deps: AppDeps) {
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  const owner = async (orgId: string, userId: string) => {
    const member = await getMembership(deps.db, userId, orgId);
    if (member?.role !== "owner") throw new ForbiddenError();
    assertActiveMembership(member);
  };
  const status = async (orgId: string) => ({
    serverEnabled: deps.config.OPENROUTER_FALLBACK_ENABLED,
    ...(await readOpenRouterFallback(deps.db, orgId)),
  });
  app.openapi(
    createRoute({
      method: "get",
      path,
      tags,
      security,
      summary: "Read the independent OpenRouter fallback budget",
      request: { params: OrgParams },
      responses: { 200: json(view), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      await owner(orgId, c.get("user").id);
      return c.json(await status(orgId), 200);
    },
  );
  app.openapi(
    createRoute({
      method: "patch",
      path,
      tags,
      security,
      summary: "Set owner-approved fallback policy without dispatching inference",
      request: { params: OrgParams, body: body(change) },
      responses: { 200: json(view), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const actor = c.get("user").id;
      await owner(orgId, actor);
      const input = c.req.valid("json");
      if (input.enabled && !deps.config.OPENROUTER_FALLBACK_ENABLED)
        throw new ConflictError("OpenRouter fallback is disabled on this server", "openrouter.disabled");
      try {
        await configureOpenRouterFallback(deps.db, orgId, actor, input);
      } catch (error) {
        if (error instanceof OpenRouterFallbackRefusal)
          throw new ConflictError("OpenRouter fallback change refused", `openrouter.${error.reason}`);
        if (isUniqueViolation(error))
          throw new ConflictError("This fallback key is already reserved", "openrouter.conflict");
        throw error;
      }
      return c.json(await status(orgId), 200);
    },
  );
  return app;
}
