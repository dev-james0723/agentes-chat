import {
  disablePaperclipWorkspace,
  listPaperclipWorkspaces,
  paperclipWorkspaceRegistrationSchema,
  registerPaperclipWorkspace,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { type AppDeps, body, createAppRouter, errors, json, OrgParams, requireSession, security } from "./context";

/** Normal cookie session and CSRF route. Registration never creates a folder grant or enables a routine. */
export function paperclipWorkspaceRoutes(deps: AppDeps) {
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  const workspace = {
    db: deps.db,
    hub: deps.extras?.sandbox?.machines?.hub,
    enabled: deps.config.PAPERCLIP_ROUTINE_COMPATIBILITY === "on",
  };
  const path = "/organizations/{orgId}/paperclip-workspaces";
  const Row = z.record(z.string(), z.unknown());
  const tags = ["Paperclip migration"];
  app.openapi(
    createRoute({
      method: "get",
      path,
      tags,
      security,
      summary: "List the owner's registered project workspaces",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ bindings: z.array(Row) })), ...errors },
    }),
    async (c) =>
      c.json({ bindings: await listPaperclipWorkspaces(workspace, c.get("user").id, c.req.valid("param").orgId) }, 200),
  );
  app.openapi(
    createRoute({
      method: "post",
      path,
      tags,
      security,
      summary: "Register an owner-local binding after native proof; routines remain paused",
      request: { params: OrgParams, body: body(paperclipWorkspaceRegistrationSchema) },
      responses: { 201: json(Row), ...errors },
    }),
    async (c) =>
      c.json(
        await registerPaperclipWorkspace(workspace, c.get("user").id, c.req.valid("param").orgId, c.req.valid("json")),
        201,
      ),
  );
  app.openapi(
    createRoute({
      method: "post",
      path: `${path}/{bindingId}/disable`,
      tags,
      security,
      summary: "Permanently revoke a server project binding",
      request: { params: OrgParams.extend({ bindingId: z.uuid() }) },
      responses: { 200: json(Row), ...errors },
    }),
    async (c) =>
      c.json(
        await disablePaperclipWorkspace(
          workspace,
          c.get("user").id,
          c.req.valid("param").orgId,
          c.req.valid("param").bindingId,
        ),
        200,
      ),
  );
  return app;
}
