import { NotFoundError, startFoundryTaskRun } from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { type AppDeps, body, createAppRouter, errors, json, OrgParams, requireSession, security } from "./context";

/** Owner-only task opt-in. Native approval cards still decide exact activation.
 * No credential, raw evaluator artifact, host command or global grant is exposed. */
export function foundryRoutes(deps: AppDeps) {
  const app = createAppRouter(deps);
  app.use("*", requireSession(deps.auth));
  app.openapi(createRoute({ method: "post", path: "/organizations/{orgId}/issues/{issueId}/foundry-runs",
    tags: ["Tasks"], security, summary: "Start a restricted pure-tool phase on this existing assigned task (owner only)",
    request: { params: OrgParams.extend({ issueId: z.uuid() }), body: body(z.object({ requestId: z.uuid(), phaseFromRunId: z.uuid().optional() }).strict()) },
    responses: { 201: json(z.object({ runId: z.uuid(), taskId: z.uuid(), phaseRef: z.string(), expiresAt: z.string() }), "Queued"), ...errors },
  }), async c => {
    const foundry = deps.extras?.foundry;
    if (!deps.config.FOUNDRY_ENABLED || !foundry?.deps.executor) throw new NotFoundError("Foundry is not configured");
    const { orgId, issueId } = c.req.valid("param");
    const result = await startFoundryTaskRun({ db: deps.db, pubsub: deps.adapters.pubsub, qualify: () => foundry.deps.executor!.qualify() },
      c.get("user").id, orgId, issueId, c.req.valid("json"));
    deps.wakeWorkers?.();
    return c.json(result, 201);
  });
  return app;
}
