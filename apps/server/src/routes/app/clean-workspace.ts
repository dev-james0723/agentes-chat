import { approveFileCleanup, cleanWorkspaceView } from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { type AppDeps, body, createAppRouter, errors, json, OrgParams, requireSession, security } from "./context";

const tags = ["Clean workspace"];

const Item = z.object({
  where: z.enum(["drive", "computer"]),
  path: z.string(),
  kind: z.string(),
  role: z.string(),
  size: z.number().nullable(),
  decision: z.enum(["keep", "candidate"]),
  why: z.string(),
  sha256: z.string().nullable().optional(),
  sameAs: z.string().optional(),
});

const Cleanup = z.object({
  path: z.string(),
  status: z.enum(["approved", "done", "skipped", "blocked", "unknown"]),
  reason: z.string().nullable(),
  bytes: z.number().nullable(),
  freeBefore: z.number().nullable(),
  freeAfter: z.number().nullable(),
  executedAt: z.string().nullable(),
});

const Report = z.object({
  id: z.string(),
  subjectType: z.enum(["issue", "mission"]),
  subjectId: z.string(),
  outcome: z.enum(["done", "canceled"]),
  createdAt: z.string(),
  kept: z.number(),
  candidates: z.number(),
  candidateBytes: z.number(),
  duplicates: z.number(),
  snapshot: z.unknown(),
  items: z.array(Item),
  cleanups: z.array(Cleanup),
  removedBytes: z.number(),
});

const View = z
  .object({
    computers: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        level: z.enum(["ok", "low", "critical", "unknown"]),
        freeGb: z.number().nullable(),
        use: z.number().nullable(),
      }),
    ),
    pending: z.number().int(),
    reports: z.array(Report),
  })
  .openapi("CleanWorkspace", {
    description:
      "Each computer's disk, and what ended tasks left: kept files, cleanup candidates and the receipts of approved cleanups (ADR 0201).",
  });

const ReportParams = OrgParams.extend({ reportId: z.uuid() });
const Approve = z
  .object({ paths: z.array(z.string().min(1).max(1000)).min(1).max(500).optional() })
  .openapi("CleanupApproval", { description: "The candidates to clean; all the report's candidates when left out." });

export function cleanWorkspaceRoutes(deps: AppDeps) {
  const app = createAppRouter(deps);
  const { db } = deps;
  app.use("/organizations/*", requireSession(deps.auth));

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/clean-workspace",
      tags,
      security,
      summary: "Computers' disks, ended tasks' files and cleanup receipts",
      request: { params: OrgParams },
      responses: { 200: json(View), ...errors },
    }),
    async (c) => {
      const view = await cleanWorkspaceView(db, c.get("user").id, c.req.valid("param").orgId);
      return c.json(view as z.infer<typeof View>, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/clean-workspace/{reportId}/approve",
      tags,
      security,
      summary: "Approve cleaning a report's candidates; each is checked again on its computer before removal",
      request: { params: ReportParams, body: body(Approve) },
      responses: {
        200: json(z.object({ approved: z.number().int(), notOnAComputer: z.number().int() })),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, reportId } = c.req.valid("param");
      const { paths } = c.req.valid("json");
      return c.json(await approveFileCleanup(db, c.get("user").id, orgId, reportId, paths), 200);
    },
  );

  return app;
}
