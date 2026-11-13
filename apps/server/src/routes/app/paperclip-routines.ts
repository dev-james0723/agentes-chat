import {
  createPaperclipMapping,
  dispatchPaperclipRoutine,
  findPaperclipInvocation,
  inspectPaperclipAdoption,
  listPaperclipMappings,
  paperclipInvocationSchema,
  paperclipMappingSchema,
  paperclipPrepareSchema,
  preparePaperclipMapping,
  setPaperclipMappingEnabled,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import {
  type AppDeps,
  body,
  createAppRouter,
  errors,
  hookConfig,
  json,
  OrgParams,
  requireSession,
  routineConnectorDeps,
  security,
} from "./context";

const tags = ["Paperclip migration"];
const MappingParams = OrgParams.extend({ mappingId: z.uuid() });
const Row = z.record(z.string(), z.unknown());

/** Only the normal authenticated app surface; off unless the installation explicitly enables it. */
export function paperclipRoutineRoutes(deps: AppDeps) {
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  const compatibility = {
    db: deps.db,
    pubsub: deps.adapters.pubsub,
    context: deps.extras?.context,
    mail: deps.adapters.mail,
    hooks: hookConfig(deps.config),
    connectors: routineConnectorDeps(deps),
    enabled: deps.config.PAPERCLIP_ROUTINE_COMPATIBILITY === "on",
  };
  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/paperclip-routine-candidates/{routineId}",
      tags,
      security,
      summary: "Review the fingerprint of the caller's existing native routine before adoption",
      request: { params: OrgParams.extend({ routineId: z.uuid() }) },
      responses: { 200: json(Row), ...errors },
    }),
    async (c) => {
      const { orgId, routineId } = c.req.valid("param");
      return c.json(await inspectPaperclipAdoption(compatibility, c.get("user").id, orgId, routineId), 200);
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/paperclip-routines",
      tags,
      security,
      summary: "The caller's Paperclip routine migration bindings",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ mappings: z.array(Row) })), ...errors },
    }),
    async (c) =>
      c.json(
        { mappings: await listPaperclipMappings(compatibility, c.get("user").id, c.req.valid("param").orgId) },
        200,
      ),
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/paperclip-routines",
      tags,
      security,
      summary: "Create a disabled mapping and paused native routine; no work is started",
      request: { params: OrgParams, body: body(paperclipMappingSchema) },
      responses: { 201: json(Row), ...errors },
    }),
    async (c) =>
      c.json(
        await createPaperclipMapping(compatibility, c.get("user").id, c.req.valid("param").orgId, c.req.valid("json")),
        201,
      ),
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/paperclip-routines/{mappingId}/prepare",
      tags,
      security,
      summary: "Compare fingerprints and prepare the imported receipt execution wrapper; stays paused",
      request: { params: MappingParams, body: body(paperclipPrepareSchema) },
      responses: { 200: json(Row), ...errors },
    }),
    async (c) => {
      const { orgId, mappingId } = c.req.valid("param");
      return c.json(
        await preparePaperclipMapping(compatibility, c.get("user").id, orgId, mappingId, c.req.valid("json")),
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/paperclip-routines/{mappingId}/activation",
      tags,
      security,
      summary: "Enable or disable this mapping after checking its immutable configuration",
      request: {
        params: MappingParams,
        body: body(z.strictObject({ expectedConfigHash: z.string().regex(/^[a-f0-9]{64}$/), enabled: z.boolean() })),
      },
      responses: { 200: json(Row), ...errors },
    }),
    async (c) => {
      const { orgId, mappingId } = c.req.valid("param");
      const input = c.req.valid("json");
      return c.json(
        await setPaperclipMappingEnabled(
          compatibility,
          c.get("user").id,
          orgId,
          mappingId,
          input.expectedConfigHash,
          input.enabled,
        ),
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/paperclip-routines/{mappingId}/invocations",
      tags,
      security,
      summary: "Atomically queue a receipt, native issue and routine run",
      description:
        "Use an idempotency key. A timeout is unknown; reconcile with lookup rather than repeating an unkeyed request. Unsupported source overrides fail closed.",
      request: { params: MappingParams, body: body(paperclipInvocationSchema) },
      responses: { 202: json(Row), ...errors },
    }),
    async (c) => {
      const { orgId, mappingId } = c.req.valid("param");
      return c.json(
        await dispatchPaperclipRoutine(compatibility, c.get("user").id, orgId, mappingId, c.req.valid("json")),
        202,
      );
    },
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/paperclip-routines/{mappingId}/lookup",
      tags,
      security,
      summary: "Read-only reconciliation of an idempotency key; starts no work",
      request: {
        params: MappingParams,
        body: body(
          z.strictObject({
            source: z.enum(["manual", "api"]),
            triggerId: z.uuid().nullable().optional(),
            idempotencyKey: z.string().min(1).max(255),
          }),
        ),
      },
      responses: { 200: json(z.object({ receipt: Row.nullable() })), ...errors },
    }),
    async (c) => {
      const { orgId, mappingId } = c.req.valid("param");
      return c.json(
        {
          receipt: await findPaperclipInvocation(
            compatibility,
            c.get("user").id,
            orgId,
            mappingId,
            c.req.valid("json"),
          ),
        },
        200,
      );
    },
  );
  return app;
}
