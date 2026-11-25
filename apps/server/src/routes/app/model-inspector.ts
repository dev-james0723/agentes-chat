import {
  can,
  ForbiddenError,
  readGlobalModelRouterStatus,
  readModelInspectorCredits,
  requirePermission,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { type AppDeps, createAppRouter, errors, json, OrgParams, requireSession, security } from "./context";

/** Status from stored observations only: opening it does not poll a provider, choose a model or interrupt a run. */
export function modelInspectorRoutes(deps: AppDeps) {
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/model-inspector",
      tags: ["Usage"],
      security,
      summary: "Model Inspector status for a workspace",
      description:
        "Requires both manage_agents and view_usage. A null report means inspection is disabled or no report is available. The report preserves observation times and unknown usage. Reading never changes models or refreshes provider usage.",
      request: { params: OrgParams },
      responses: {
        200: json(
          z.object({
            enabled: z.boolean(),
            credits: z
              .unknown()
              .openapi({ description: "Durable grant budget and unresolved costs; no provider calls." }),
            globalRouter: z
              .unknown()
              .optional()
              .openapi({ description: "Stored Global Model Router quotas, holds, and receipts; no provider calls." }),
            report: z
              .unknown()
              .nullable()
              .openapi({ description: "Native inspection status from stored observations." }),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const membership = await requirePermission(deps.db, c.get("user").id, orgId, "manage_agents");
      if (!can(membership, "view_usage")) throw new ForbiddenError();
      const inspector = deps.extras?.modelInspector;
      const enabled = inspector?.enabled(orgId) ?? false;
      const report = enabled && inspector ? await inspector.report(orgId) : null;
      const credits = await readModelInspectorCredits(deps.db, orgId, deps.config.CREDIT_FALLBACK_ENABLED === true);
      const globalRouter = await readGlobalModelRouterStatus(deps.db, orgId);
      return c.json({ enabled, report, credits, globalRouter }, 200);
    },
  );
  return app;
}
