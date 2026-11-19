import { and, desc, eq, inArray, schema, sql } from "@agenteschat/db";
import {
  ConflictError,
  ForbiddenError,
  getSharedMemoryMem0Readiness,
  type Mem0SyntheticCheckpoint,
  pinnedOwner,
  recordAudit,
  runMem0SyntheticEvaluation,
  sharedMemoryAction,
  sharedMemorySnapshot,
  TooManyError,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { type AppDeps, body, createAppRouter, errors, json, OrgParams, requireSession, security } from "./context";

const tags = ["Shared memory"];
const Readiness = z.object({
  provider: z.literal("mem0"),
  readiness: z.enum(["disabled", "missing_key", "configured_unverified"]),
  configured: z.boolean(),
  mode: z.literal("synthetic_only"),
  privateProjectionEnabled: z.literal(false),
});
const Report = z.object({
  provider: z.literal("mem0"),
  suite: z.literal("synthetic_projection_v1"),
  evidenceMode: z.enum(["provider_live", "injected_transport", "not_run"]),
  readiness: Readiness,
  status: z.enum(["passed", "failed", "partial", "unavailable"]),
  providerVerified: z.boolean(),
  nativeAuthority: z.literal(true),
  privateMemoriesSent: z.literal(false),
  modelAnswersTested: z.literal(false),
  runId: z.string().nullable(),
  observedAt: z.string(),
  cases: z.array(
    z.object({
      id: z.string(),
      category: z.string(),
      status: z.enum(["passed", "failed", "unavailable", "skipped"]),
      reason: z.string().nullable(),
      elapsedMs: z.number(),
      matchedFactIds: z.array(z.string()),
      suppressedInputs: z.number(),
    }),
  ),
  totals: z.object({ passed: z.number(), failed: z.number(), unavailable: z.number(), skipped: z.number() }),
  metrics: z.object({
    requests: z.number(),
    elapsedMs: z.number(),
    searchP95Ms: z.number().nullable(),
    cost: z.null(),
  }),
  cleanup: z.object({
    status: z.enum(["complete", "incomplete", "not_needed"]),
    deleted: z.number(),
    remainingIds: z.array(z.string()),
    unresolvedOperations: z.array(z.string()),
    eventIds: z.array(z.string()),
    issues: z.array(z.string()),
  }),
});
const Checkpoint = z.object({
  provider: z.literal("mem0"),
  suite: z.literal("synthetic_projection_v1"),
  runId: z.string().regex(/^agentes-synthetic-[0-9a-f-]{36}$/i),
  observedAt: z.iso.datetime({ offset: true }),
  sequence: z.number().int().min(1).max(1024),
  evidenceMode: z.enum(["provider_live", "injected_transport"]),
  phase: z.enum(["started", "running", "cleanup"]),
  providerVerified: z.literal(false),
  privateMemoriesSent: z.literal(false),
  modelAnswersTested: z.literal(false),
  requests: z.number().int().min(0).max(256),
  completedCases: z.number().int().min(0).max(20),
  ownedMemoryIds: z.array(z.uuid()).max(256),
  eventIds: z.array(z.uuid()).max(256),
  unresolvedOperations: z.array(z.string().max(200)).max(256),
  cleanupDeleted: z.number().int().min(0).max(256),
});
const LatestEvaluation = z.object({ report: Report.nullable(), checkpoint: Checkpoint.nullable() });
const AUDIT_TYPE = "shared_memory_mem0_evaluation";
const CHECKPOINT_ACTION = "shared_memory.mem0.checkpoint";
const COMPLETED_ACTION = "shared_memory.mem0.completed";

/** The installation's optional key is never lent to another workspace owner or an agent. */
export function sharedMemoryMem0Routes(deps: AppDeps) {
  const app = createAppRouter(deps);
  const running = new Set<string>();
  app.use("/organizations/*", requireSession(deps.auth));
  const owner = async (actorId: string, orgId: string) => {
    const view = await sharedMemorySnapshot(deps.db, actorId, orgId, { limit: 1 });
    if (!view.profile || !view.canManage) throw new ForbiddenError("Only the profile owner may use its evaluation.");
    return view;
  };
  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/shared-memory/mem0/evaluations/latest",
      tags,
      security,
      summary: "Read the last synthetic evaluation and any unfinished attempt",
      request: { params: OrgParams },
      responses: { 200: json(LatestEvaluation), ...errors },
    }),
    async (c) => {
      const actorId = c.get("user").id;
      const view = await owner(actorId, c.req.valid("param").orgId);
      if ((await pinnedOwner(deps.db)) !== actorId)
        throw new ForbiddenError("Only the installation owner may read its Mem0 evaluation receipts.");
      const profile = view.profile;
      if (!profile) throw new ForbiddenError("The shared-memory profile is unavailable.");
      const audit = schema.auditLog;
      const boundary = and(
        eq(audit.orgId, profile.canonicalOrgId),
        eq(audit.actorType, "person"),
        eq(audit.actorId, actorId),
        eq(audit.targetType, AUDIT_TYPE),
        sql`${audit.details}->>'profileId' = ${profile.id}`,
      );
      // IDs are generated before starting each evaluation. Late checkpoint writes cannot make an older run newest.
      const [latest] = await deps.db
        .select({ id: audit.targetId })
        .from(audit)
        .where(and(boundary, inArray(audit.action, [CHECKPOINT_ACTION, COMPLETED_ACTION])))
        .orderBy(desc(audit.targetId))
        .limit(1);
      const [terminal] = await deps.db
        .select({ details: audit.details })
        .from(audit)
        .where(and(boundary, eq(audit.action, COMPLETED_ACTION)))
        .orderBy(desc(audit.targetId), desc(audit.id))
        .limit(1);
      const progress = latest?.id
        ? await deps.db
            .select({ details: audit.details })
            .from(audit)
            .where(and(boundary, eq(audit.targetId, latest.id), eq(audit.action, CHECKPOINT_ACTION)))
            .orderBy(desc(audit.id))
            .limit(512)
        : [];
      const checkpoints = progress.flatMap((row) => {
        const parsed = Checkpoint.safeParse(row.details.checkpoint);
        return parsed.success ? [parsed.data] : [];
      });
      checkpoints.sort((a, b) => b.sequence - a.sequence);
      const parsedReport = Report.safeParse(terminal?.details.report);
      c.header("Cache-Control", "private, no-store");
      return c.json(
        { report: parsedReport.success ? parsedReport.data : null, checkpoint: checkpoints[0] ?? null },
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/shared-memory/mem0",
      tags,
      security,
      summary: "Read Mem0 evaluation availability without exposing its key",
      request: { params: OrgParams },
      responses: { 200: json(Readiness.extend({ canEvaluate: z.boolean() })), ...errors },
    }),
    async (c) => {
      const actorId = c.get("user").id;
      await owner(actorId, c.req.valid("param").orgId);
      c.header("Cache-Control", "private, no-store");
      return c.json(
        { ...getSharedMemoryMem0Readiness(deps.config), canEvaluate: (await pinnedOwner(deps.db)) === actorId },
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/shared-memory/mem0/evaluate",
      tags,
      security,
      summary: "Evaluate fixed synthetic memories; no private memories are sent",
      request: { params: OrgParams, body: body(z.object({}).strict()) },
      responses: { 200: json(Report), ...errors },
    }),
    async (c) => {
      const actorId = c.get("user").id;
      const orgId = c.req.valid("param").orgId;
      const view = await owner(actorId, orgId);
      const profile = view.profile;
      if (!profile) throw new ForbiddenError("The shared-memory profile is unavailable.");
      if ((await pinnedOwner(deps.db)) !== actorId)
        throw new ForbiddenError("Only the installation owner may use its Mem0 key.");
      if (running.has(actorId))
        throw new ConflictError("This evaluation is already running.", "shared_memory.evaluation_running");
      // Reserve the owner before the asynchronous rate check so two requests cannot start together.
      running.add(actorId);
      try {
        if (
          !(await deps.adapters.rateLimiter.consume(`shared-memory-mem0:${actorId}`, { limit: 2, windowMs: 3_600_000 }))
            .allowed
        )
          throw new TooManyError("Wait before starting another evaluation.");
        const evaluationId = Bun.randomUUIDv7();
        let lastCheckpoint: Mem0SyntheticCheckpoint | null = null;
        const report = await runMem0SyntheticEvaluation({
          config: deps.config,
          transport: deps.extras?.http,
          signal: c.req.raw.signal,
          onCheckpoint: async (value) => {
            const checkpoint = Checkpoint.parse(value);
            await recordAudit(deps.db, {
              orgId: profile.canonicalOrgId,
              actor: { type: "person", id: actorId },
              action: CHECKPOINT_ACTION,
              target: { type: AUDIT_TYPE, id: evaluationId },
              details: { profileId: profile.id, checkpoint },
              outcome: "pending",
            });
            lastCheckpoint = checkpoint;
          },
        });
        // Persist the bounded report before replying or touching a summary receipt. A disconnected page loses no IDs.
        await recordAudit(deps.db, {
          orgId: profile.canonicalOrgId,
          actor: { type: "person", id: actorId },
          action: COMPLETED_ACTION,
          target: { type: AUDIT_TYPE, id: evaluationId },
          details: { profileId: profile.id, report: Report.parse(report), checkpoint: lastCheckpoint },
          outcome: report.status === "passed" ? "done" : "failed",
        });
        // A one-time synthetic evaluation never changes who owns a fact or claims to test real model answers.
        await sharedMemoryAction(deps.db, actorId, orgId, {
          type: "consumer",
          consumer: {
            id: "mem0-synthetic-evaluation",
            name: "Mem0 synthetic evaluation",
            kind: "mem0",
            status: report.providerVerified ? "snapshot" : "blocked",
            revision: null,
            checkedAt: report.observedAt,
            reason: `${report.evidenceMode}; ${report.totals.passed} passed, ${report.totals.failed} failed, ${report.totals.unavailable} unavailable; cleanup ${report.cleanup.status}. Synthetic fixtures only; model answers were not tested.`,
            writable: false,
          },
        });
        c.header("Cache-Control", "private, no-store");
        return c.json(report, 200);
      } finally {
        running.delete(actorId);
      }
    },
  );
  return app;
}
