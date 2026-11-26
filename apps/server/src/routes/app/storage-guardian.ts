import {
  decideStorageReview,
  removeStorageScope,
  setStorageGc,
  setStorageScope,
  storageGuardianView,
  storageReview,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { type AppDeps, body, createAppRouter, errors, json, OrgParams, requireSession, security } from "./context";

/** Storage Guardian (ADR 0214): continuous cleanup's switch, authorized folders, review queue and figures. */
const tags = ["Storage Guardian"];

const Figures = z.object({
  unlinked: z.number(),
  logicalBytes: z.number(),
  allocatedBytes: z.number(),
  freeDeltaBytes: z.number(),
  measuredRounds: z.number(),
  shadowFiles: z.number(),
  shadowBytes: z.number(),
  relocated: z.number(),
  archived: z.number(),
  openReview: z.number(),
});
const View = z
  .object({
    enabled: z.boolean(),
    modeOverride: z.string().nullable(),
    computers: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        level: z.enum(["ok", "low", "critical", "unknown"]),
        freeGb: z.number().nullable(),
        use: z.number().nullable(),
        mode: z.enum(["normal", "elevated", "critical", "performance"]),
      }),
    ),
    scopes: z.array(z.object({ id: z.string(), machineId: z.string(), root: z.string(), mode: z.string() })),
    states: z.record(z.string(), z.number()),
    figures: Figures,
    recent: z.array(
      z.object({
        path: z.string(),
        status: z.string(),
        source: z.string(),
        shadow: z.boolean(),
        reason: z.string().nullable(),
        bytes: z.number().nullable(),
        freeBefore: z.number().nullable(),
        freeAfter: z.number().nullable(),
        executedAt: z.string().nullable(),
      }),
    ),
  })
  .openapi("StorageGuardian", {
    description:
      "Continuous cleanup (ADR 0214): its switch, each computer's disk and mode, the authorized folders, files by state and figures that are never added together.",
  });
const ReviewItem = z.object({
  id: z.string(),
  status: z.string(),
  code: z.string(),
  reason: z.string(),
  history: z.array(z.object({ at: z.string(), by: z.string(), action: z.string() })),
  createdAt: z.string(),
  file: z.object({
    id: z.string(),
    path: z.string(),
    kind: z.string(),
    role: z.string(),
    state: z.string(),
    size: z.number().nullable(),
    sha256: z.string().nullable(),
    agentId: z.string(),
    machineId: z.string().nullable(),
    capturedBy: z.string().nullable(),
  }),
});
const Settings = z.object({
  enabled: z.boolean().optional(),
  modeOverride: z.enum(["performance"]).nullable().optional(),
});
const Scope = z.object({
  machineId: z.uuid(),
  root: z.string().min(1).max(500),
  mode: z.enum(["shadow", "enforce"]).optional(),
});
const Decision = z.object({
  ids: z.array(z.uuid()).min(1).max(500),
  action: z.enum(["keep", "protect", "archive", "delete", "restore"]),
});

export function storageGuardianRoutes(deps: AppDeps) {
  const app = createAppRouter(deps);
  const { db } = deps;
  app.use("/organizations/*", requireSession(deps.auth));
  const base = "/organizations/{orgId}/storage-guardian";

  app.openapi(
    createRoute({
      method: "get",
      path: base,
      tags,
      security,
      summary: "Continuous cleanup: switch, computers, folders and figures",
      request: { params: OrgParams },
      responses: { 200: json(View), ...errors },
    }),
    async (c) =>
      c.json(
        (await storageGuardianView(db, c.get("user").id, c.req.valid("param").orgId)) as z.infer<typeof View>,
        200,
      ),
  );

  app.openapi(
    createRoute({
      method: "put",
      path: `${base}/settings`,
      tags,
      security,
      summary: "Switch continuous cleanup off or on, or hold it back while agents need the computer",
      request: { params: OrgParams, body: body(Settings) },
      responses: { 200: json(z.object({ enabled: z.boolean(), modeOverride: z.string().nullable() })), ...errors },
    }),
    async (c) => c.json(await setStorageGc(db, c.get("user").id, c.req.valid("param").orgId, c.req.valid("json")), 200),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: `${base}/scopes`,
      tags,
      security,
      summary: "Authorize a folder on a computer for continuous cleanup (shadow first)",
      request: { params: OrgParams, body: body(Scope) },
      responses: { 200: json(z.object({ id: z.string(), root: z.string(), mode: z.string() })), ...errors },
    }),
    async (c) => {
      const row = await setStorageScope(db, c.get("user").id, c.req.valid("param").orgId, c.req.valid("json"));
      return c.json({ id: row?.id ?? "", root: row?.root ?? "", mode: row?.mode ?? "shadow" }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: `${base}/scopes/{scopeId}`,
      tags,
      security,
      summary: "Withdraw a folder's authorization",
      request: { params: OrgParams.extend({ scopeId: z.uuid() }) },
      responses: { 204: { description: "Withdrawn" }, ...errors },
    }),
    async (c) => {
      const { orgId, scopeId } = c.req.valid("param");
      await removeStorageScope(db, c.get("user").id, orgId, scopeId);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: `${base}/review`,
      tags,
      security,
      summary: "Files waiting for a person's decision, with their history",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ items: z.array(ReviewItem) })), ...errors },
    }),
    async (c) => c.json({ items: await storageReview(db, c.get("user").id, c.req.valid("param").orgId) }, 200),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: `${base}/review/decisions`,
      tags,
      security,
      summary: "Keep, protect, archive, delete or restore review items, one or many",
      request: { params: OrgParams, body: body(Decision) },
      responses: {
        200: json(
          z.object({ results: z.array(z.object({ id: z.string(), ok: z.boolean(), note: z.string().optional() })) }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { ids, action } = c.req.valid("json");
      return c.json(await decideStorageReview(db, c.get("user").id, c.req.valid("param").orgId, ids, action), 200);
    },
  );

  return app;
}
