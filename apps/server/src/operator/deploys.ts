import { eq, schema } from "@agenteschat/db";
import { recordDeploy } from "@agenteschat/engine";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { apiError, errorResponse } from "../http/errors";
import { body, json, OrgParams } from "../routes/app/context";
import type { OperatorDeps } from "./app";

const tags = ["Operator"];
const errors = {
  400: errorResponse("Invalid request"),
  401: errorResponse("Missing or wrong token"),
  404: errorResponse("Not found"),
  409: errorResponse("This server does not run that source"),
};

const Commit = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/);

const DeployInput = z.object({
  repo: z.string().min(3).max(200).openapi({ description: "`owner/name` on GitHub." }),
  commit: Commit.openapi({ description: "The deployed commit." }),
  commits: z.array(Commit).max(500).optional().openapi({
    description:
      "Other commits the caller vouches this deploy holds (e.g. the first-parent history since the last deploy): a task whose merge commit is one of them reads as deployed.",
  }),
  sourceDigest: z
    .string()
    .regex(/^sha256:[0-9a-f]{64}$/)
    .openapi({
      description: "The commit's source identity, as `scripts/runtime-identity.ts rev <commit>` works it out.",
    }),
});

const DeployRecord = z
  .object({ id: z.uuid(), commit: z.string(), sourceDigest: z.string(), recordedAt: z.string() })
  .openapi("OperatorDeployRecord");

/**
 * A deploy's record for tasks' founder status (ADR 0204). The caller vouches commit → digest; this server writes it
 * only when it runs that digest itself, so no record claims a deploy that isn't the one serving.
 */
export function registerOperatorDeploys(api: OpenAPIHono, deps: OperatorDeps) {
  const { db } = deps;
  api.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/deploys",
      tags,
      summary: "Record that this server runs a commit, for the workspace's task status",
      description:
        "Refused with 409 `deploy_not_running` unless `sourceDigest` is this server's own source identity now (the one `/api/health` reports). The same commit and digest again returns the record already there.",
      request: { params: OrgParams, body: body(DeployInput) },
      responses: { 200: json(DeployRecord), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const [org] = await db
        .select({ id: schema.organizations.id })
        .from(schema.organizations)
        .where(eq(schema.organizations.id, orgId));
      if (!org) return apiError(c, 404, "not_found", "No workspace with this id");
      const running = deps.sourceIdentity ? await deps.sourceIdentity().catch(() => null) : null;
      const row = await recordDeploy(db, { orgId, ...c.req.valid("json") }, running);
      return c.json(
        {
          id: row.id,
          commit: String(row.details.commit),
          sourceDigest: String(row.details.sourceDigest),
          recordedAt: row.createdAt.toISOString(),
        },
        200,
      );
    },
  );
}
