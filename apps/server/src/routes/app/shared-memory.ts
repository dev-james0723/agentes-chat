import {
  ConflictError,
  ForbiddenError,
  type SharedMemorySnapshot,
  sharedMemoryAction,
  sharedMemorySnapshot,
  ValidationError,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { type AppDeps, body, createAppRouter, errors, json, OrgParams, requireSession, security } from "./context";

const tags = ["Shared memory"];
const sensitivity = z.enum(["personal", "workspace", "sensitive"]);
const assertion = z.enum(["owner_statement", "owner_correction", "observation", "inference", "import"]);
const timestamp = z.iso.datetime({ offset: true });
const nullableTime = timestamp.nullable();
const boundedId = z.string().min(1).max(200);
const version = z.number().int().min(1);
const Source = z.object({
  id: boundedId,
  name: z.string().min(1).max(200),
  provider: z.enum(["native", "file", "chatgpt", "claude", "other"]),
  reference: z.string().max(2000).nullable(),
  originId: boundedId,
  revision: z.string().max(200).nullable(),
  capturedAt: timestamp,
  observedAt: nullableTime,
  refreshAfter: nullableTime,
  coverage: z.string().max(1000),
  recordCount: z.number().int().min(0).max(10_000_000).nullable(),
  status: z.enum(["snapshot", "current", "stale", "blocked"]),
});
const Consumer = z.object({
  id: boundedId,
  name: z.string().min(1).max(200),
  kind: z.enum(["file", "chatgpt", "claude", "mem0", "other"]),
  status: z.enum(["not_connected", "snapshot", "current", "pending", "blocked"]),
  revision: version.nullable(),
  availabilityRevision: boundedId.nullable().optional(),
  checkedAt: nullableTime,
  reason: z.string().max(2000).nullable(),
  writable: z.boolean(),
});
const Entry = z.object({
  id: z.uuid(),
  key: boundedId,
  itemId: z.uuid().nullable(),
  sourceOrgId: z.uuid(),
  title: z.string(),
  content: z.string(),
  kind: z.string(),
  status: z.enum(["active", "candidate", "disputed", "rejected", "forgotten"]),
  version,
  itemVersion: version.nullable(),
  readable: z.boolean(),
  blockedReason: z.string().nullable(),
  sensitivity,
  assertion,
  originId: z.string(),
  sourceId: boundedId.nullable(),
  sourceIds: z.array(z.string()),
  sourceRevision: z.string().nullable(),
  observedAt: nullableTime,
  recordedAt: timestamp,
  validFrom: nullableTime,
  validTo: nullableTime,
  forgottenAt: nullableTime,
  externalOutstanding: z.array(z.string()),
  replicas: z.array(
    z.object({
      orgId: z.uuid(),
      itemId: z.uuid().nullable(),
      state: z.enum(["current", "pending", "conflict", "blocked", "forgotten"]),
      appliedVersion: version.nullable(),
      checkedAt: nullableTime,
      reason: z.string().nullable(),
    }),
  ),
  history: z.array(
    z.object({
      itemId: z.uuid(),
      version,
      title: z.string(),
      content: z.string(),
      status: z.string(),
      recordedAt: timestamp,
    }),
  ),
});

/** The app's owner-only view; connector receipts never stand in for agent-answer verification. */
export const SharedMemoryView = z.object({
  profile: z
    .object({
      id: z.uuid(),
      name: z.string(),
      ownerUserId: z.string(),
      canonicalOrgId: z.uuid(),
      version,
      availabilityRevision: boundedId,
      updatedAt: timestamp,
    })
    .nullable(),
  canManage: z.boolean(),
  entries: z.array(Entry),
  candidates: z.array(Entry),
  destinations: z.array(
    z.object({
      orgId: z.uuid(),
      name: z.string(),
      enabled: z.boolean(),
      state: z.enum(["active", "blocked", "paused"]),
      allowedSensitivity: z.array(sensitivity),
      lastSyncedAt: nullableTime,
      reason: z.string().nullable(),
      current: z.number(),
      pending: z.number(),
      conflicts: z.number(),
    }),
  ),
  sources: z.array(Source),
  consumers: z.array(Consumer),
  verification: z.object({
    status: z.enum(["not_run", "passed", "failed"]),
    checkedAt: nullableTime,
    runId: z.uuid().nullable(),
    verifiedEntryIds: z.array(z.uuid()),
    missingEntryIds: z.array(z.uuid()),
    detail: z.string(),
  }),
  availableItems: z.array(z.object({ itemId: z.uuid(), title: z.string(), kind: z.string(), version })),
  eligibleDestinations: z.array(z.object({ orgId: z.uuid(), name: z.string() })),
  pagination: z.object({ nextCursor: z.string().nullable(), complete: z.boolean(), total: z.number() }),
  graph: z.object({
    nodes: z.array(
      z.object({
        id: z.string(),
        kind: z.enum(["entry", "source", "workspace"]),
        label: z.string(),
        entryId: z.string().optional(),
        sourceId: z.string().optional(),
        orgId: z.string().optional(),
      }),
    ),
    edges: z.array(
      z.object({
        from: z.string(),
        to: z.string(),
        kind: z.enum(["derived_from", "replicated_to", "conflicts_with"]),
      }),
    ),
  }),
});

const edit = { entryId: z.uuid(), expectedVersion: version };
export const SharedMemoryActionBody = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("configure"),
      name: z.string().trim().min(1).max(200).optional(),
      destinations: z
        .array(z.object({ orgId: z.uuid(), allowedSensitivity: z.array(sensitivity).max(3).optional() }).strict())
        .max(100)
        .optional(),
      adopt: z
        .array(
          z
            .object({
              itemId: z.uuid(),
              key: boundedId,
              sensitivity: sensitivity.optional(),
              sourceId: z.uuid().optional(),
              replicas: z
                .array(z.object({ orgId: z.uuid(), itemId: z.uuid() }).strict())
                .max(100)
                .optional(),
            })
            .strict(),
        )
        .max(500)
        .optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("destination"),
      orgId: z.uuid(),
      enabled: z.boolean(),
      allowedSensitivity: z.array(sensitivity).max(3).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("capture"),
      itemId: z.uuid(),
      sourceOrgId: z.uuid(),
      key: boundedId.optional(),
      sourceId: z.uuid().optional(),
      originId: boundedId.optional(),
      observedAt: nullableTime.optional(),
    })
    .strict(),
  z.object({ type: z.literal("decide"), ...edit, decision: z.enum(["accept", "reject"]) }).strict(),
  z
    .object({
      type: z.literal("correct"),
      ...edit,
      content: z.string().min(1).max(8000),
      title: z.string().max(300).optional(),
      validFrom: nullableTime.optional(),
      validTo: nullableTime.optional(),
    })
    .strict(),
  z.object({ type: z.literal("sensitivity"), ...edit, sensitivity }).strict(),
  z
    .object({
      type: z.literal("forget"),
      ...edit,
      scope: z.enum(["profile", "workspace"]),
      destinationOrgId: z.uuid().optional(),
    })
    .strict(),
  z.object({ type: z.literal("reconcile") }).strict(),
  z
    .object({
      type: z.literal("source"),
      source: Source.omit({ id: true, status: true })
        .extend({
          id: z.uuid().optional(),
          status: z.enum(["snapshot", "current", "blocked"]).optional(),
        })
        .strict(),
    })
    .strict(),
  z.object({ type: z.literal("consumer"), consumer: Consumer.strict() }).strict(),
  z.object({ type: z.literal("verify"), runId: z.uuid(), entryIds: z.array(z.uuid()).min(1).max(100) }).strict(),
]);

/** Native data is read afresh on every request; no cached private body is sent to a shared intermediary. */
export function sharedMemoryRoutes(deps: AppDeps) {
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  app.use("/organizations/:orgId/shared-memory*", async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    await next();
  });
  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/shared-memory",
      tags,
      security,
      summary: "Read your shared memory, provenance and destination evidence",
      request: {
        params: OrgParams,
        query: z.object({
          cursor: z.string().max(200).optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
        }),
      },
      responses: { 200: json(SharedMemoryView), ...errors },
    }),
    async (c) =>
      c.json(
        await sharedMemorySnapshot(deps.db, c.get("user").id, c.req.valid("param").orgId, c.req.valid("query")),
        200,
      ),
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/shared-memory/actions",
      tags,
      security,
      summary: "Manage your shared memory with native version and membership checks",
      request: { params: OrgParams, body: body(SharedMemoryActionBody) },
      responses: {
        200: json(
          z.object({
            snapshot: SharedMemoryView,
            action: z.object({
              state: z.enum(["applied", "queued", "blocked"]),
              id: z.string().optional(),
              reason: z.string().optional(),
            }),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const result = await sharedMemoryAction(
        deps.db,
        c.get("user").id,
        c.req.valid("param").orgId,
        c.req.valid("json"),
      );
      deps.wakeWorkers?.();
      return c.json(result, 200);
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/shared-memory/export",
      tags,
      security,
      summary: "Export current shared memories with their sources and validity dates",
      request: { params: OrgParams },
      responses: {
        200: { description: "Private Markdown export", content: { "text/markdown": { schema: z.string() } } },
        ...errors,
      },
    }),
    async (c) => {
      const orgId = c.req.valid("param").orgId;
      const userId = c.get("user").id;
      const first = await sharedMemorySnapshot(deps.db, userId, orgId, { limit: 500 });
      if (!first.profile || !first.canManage)
        throw new ForbiddenError("Only the memory owner may export this profile.");
      const entries = [...first.entries];
      const seen = new Set<string>();
      let cursor = first.pagination.nextCursor;
      while (cursor) {
        if (seen.has(cursor) || seen.size >= 20)
          throw new ValidationError("This export is too large to read completely.", "shared_memory.export_incomplete");
        seen.add(cursor);
        const page = await sharedMemorySnapshot(deps.db, userId, orgId, { cursor, limit: 500 });
        if (
          page.profile?.id !== first.profile.id ||
          page.profile.version !== first.profile.version ||
          page.profile.availabilityRevision !== first.profile.availabilityRevision
        )
          throw new ConflictError("Memory changed during the export. Read it again.", "shared_memory.export_changed");
        entries.push(...page.entries);
        cursor = page.pagination.nextCursor;
      }
      const latest = await sharedMemorySnapshot(deps.db, userId, orgId, { limit: 1 });
      if (
        latest.profile?.id !== first.profile.id ||
        latest.profile.version !== first.profile.version ||
        latest.profile.availabilityRevision !== first.profile.availabilityRevision
      )
        throw new ConflictError("Memory changed during the export. Read it again.", "shared_memory.export_changed");
      c.header("Content-Type", "text/markdown; charset=utf-8");
      c.header("Content-Disposition", 'attachment; filename="shared-memory.md"');
      return c.body(sharedMemoryMarkdown({ ...first, entries }));
    },
  );
  return app;
}

/** An export describes its evidence and omits rejected/forgotten text. It is never a receipt of consumer loading. */
export function sharedMemoryMarkdown(snapshot: SharedMemorySnapshot): string {
  const active = snapshot.entries.filter((entry) => entry.status === "active" && entry.readable);
  const unavailable = snapshot.entries.filter((entry) => entry.status === "active" && !entry.readable).length;
  if (active.some((entry) => !entry.itemId || !entry.itemVersion))
    throw new ValidationError("An active memory has no readable native head.", "shared_memory.export_incomplete");
  const lines = [
    `# ${snapshot.profile?.name ?? "Shared memory"}`,
    "",
    `Canonical revision: ${snapshot.profile?.version ?? 0}`,
    `Source availability revision: ${snapshot.profile?.availabilityRevision ?? "unavailable"}`,
    `Readable active memories: ${active.length}`,
    `Unavailable active memories omitted: ${unavailable}`,
    "This file contains readable current native memories. Exporting it does not prove another AI has loaded it.",
    "",
  ];
  for (const entry of active) {
    lines.push(
      `## ${entry.title || entry.key}`,
      "",
      `Memory key: ${entry.key}`,
      `Assertion: ${entry.assertion}`,
      `Scope: ${entry.sensitivity}`,
      `Original source: ${entry.originId}`,
      `Recorded: ${entry.recordedAt}`,
    );
    const source = snapshot.sources.find((s) => s.id === entry.sourceId);
    if (source) lines.push(`Source snapshot: ${source.name} (${source.originId})`, `Captured: ${source.capturedAt}`);
    if (entry.sourceRevision) lines.push(`Source revision: ${entry.sourceRevision}`);
    if (entry.observedAt) lines.push(`Observed: ${entry.observedAt}`);
    if (entry.validFrom || entry.validTo)
      lines.push(`Valid: ${entry.validFrom ?? "unknown"} to ${entry.validTo ?? "open"}`);
    lines.push("", entry.content, "");
  }
  if (snapshot.sources.length) {
    lines.push("## Source coverage", "");
    for (const source of snapshot.sources) {
      lines.push(
        `### ${source.name}`,
        "",
        `Provider: ${source.provider}`,
        `Status: ${source.status}`,
        `Captured: ${source.capturedAt}`,
        `Coverage: ${source.coverage}`,
      );
      if (source.reference) lines.push(`Reference: ${source.reference}`);
      if (source.observedAt) lines.push(`Observed: ${source.observedAt}`);
      if (source.revision) lines.push(`Source revision: ${source.revision}`);
      if (source.recordCount !== null) lines.push(`Records: ${source.recordCount}`);
      lines.push("");
    }
  }
  return `${lines.join("\n")}\n`;
}
