import { eq, schema } from "@agenteschat/db";
import { recordDeploy, recordTestReceipt } from "@agenteschat/engine";
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

const TestReceiptInput = z.object({
  repo: z.string().min(3).max(200).openapi({ description: "`owner/name` on GitHub." }),
  commit: Commit.openapi({ description: "The commit the suite ran on (a task's merge commit, for its receipt)." }),
  suite: z
    .string()
    .min(1)
    .max(200)
    .openapi({ description: "The suite's name, as a task's completion contract pins it." }),
  testsDigest: z
    .string()
    .regex(/^sha256:[0-9a-f]{64}$/)
    .openapi({ description: "Digest of the suite's test files as run; must equal the digest the contract pinned." }),
  passed: z.boolean(),
});

const TestReceiptRecord = z
  .object({ id: z.uuid(), kind: z.enum(["tests_passed", "tests_failed"]), recordedAt: z.string() })
  .openapi("OperatorTestReceipt");

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

  api.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/test-receipts",
      tags,
      summary: "Record a CI test receipt, the only test evidence a task's completion contract accepts (ADR 0211)",
      description:
        "Written as a `tests_passed` / `tests_failed` outcome with source `operator`. A receipt counts for a task only when it names the task's merge commit, the contract's suite and the test files' digest the contract pinned. The same receipt again returns the record already there.",
      request: { params: OrgParams, body: body(TestReceiptInput) },
      responses: { 200: json(TestReceiptRecord), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const [org] = await db
        .select({ id: schema.organizations.id })
        .from(schema.organizations)
        .where(eq(schema.organizations.id, orgId));
      if (!org) return apiError(c, 404, "not_found", "No workspace with this id");
      const row = await recordTestReceipt(db, { orgId, ...c.req.valid("json") });
      return c.json(
        {
          id: row.id,
          kind: row.kind === "tests_failed" ? ("tests_failed" as const) : ("tests_passed" as const),
          recordedAt: row.createdAt.toISOString(),
        },
        200,
      );
    },
  );
}
