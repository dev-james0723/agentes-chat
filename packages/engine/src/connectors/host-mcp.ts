import { randomUUID } from "node:crypto";
import { HOST_MCP_PROTOCOL, type HostMcpBinding, type HostMcpRequest, type HostMcpTool } from "@agenteschat/adapters";
import { and, type Database, eq, isNull, schema } from "@agenteschat/db";
import { recordAudit } from "../audit";
import { ForbiddenError, ValidationError } from "../errors";
import type { MachineCaller } from "../machine-hub";
import { requirePermission } from "../organizations";
import type { ToolContext, ToolDefinition, ToolSource } from "../tools/types";
import { customScope } from "./custom";
import { exposedToolName } from "./mcp";

const { connectorConnections, customTools, agentScopes, agentRuns } = schema;
export const MACHINE_MCP_AUTH = "machine_mcp";
export interface HostMcpDeps {
  db: Database;
  hub: MachineCaller;
}
/** Only dedicated human-admin binding can create this discriminated identity. Never fetched as a URL. */
export function hostMcpAddress(machineId: string, profileId: string, revision: string) {
  if (
    !/^[A-Za-z0-9_-]{1,100}$/.test(machineId) ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(profileId) ||
    !/^[a-f0-9]{64}$/.test(revision)
  )
    throw new ValidationError("Invalid host MCP identity");
  return `machine-mcp://${machineId}/${profileId}/${revision}`;
}
export function hostMcpIdentity(address: string) {
  const m = /^machine-mcp:\/\/([A-Za-z0-9_-]{1,100})\/([A-Za-z0-9_-]{1,100})\/([a-f0-9]{64})$/.exec(address);
  if (!m) throw new ValidationError("Invalid host MCP identity");
  return { machineId: m[1]!, profileId: m[2]!, revision: m[3]! };
}
async function machine(deps: HostMcpDeps, orgId: string, machineId: string) {
  const s = await deps.hub.status(machineId);
  if (!s || s.orgId !== orgId) throw new ForbiddenError("Host MCP machine binding mismatch");
  if (!s.online || s.protocol < HOST_MCP_PROTOCOL)
    throw new ValidationError("Host MCP runner is offline or needs an update");
}
export async function listHostMcpProfiles(deps: HostMcpDeps, actorId: string, orgId: string, machineId: string) {
  await requirePermission(deps.db, actorId, orgId, "manage_connectors");
  await machine(deps, orgId, machineId);
  return deps.hub.call(machineId, { op: "host_mcp", request: { action: "profiles", actorId, orgId, machineId } });
}
/** Initial binding creates no agent grants. Registry policy and explicit per-agent grants must both permit calls. */
export async function bindHostMcp(
  deps: HostMcpDeps,
  actorId: string,
  orgId: string,
  input: { machineId: string; profileId: string; revision: string; agentId: string },
) {
  await requirePermission(deps.db, actorId, orgId, "manage_connectors");
  await machine(deps, orgId, input.machineId);
  const serverUrl = hostMcpAddress(input.machineId, input.profileId, input.revision);
  const profiles = await listHostMcpProfiles(deps, actorId, orgId, input.machineId);
  const p = profiles.profiles?.find((p) => p.id === input.profileId && p.revision === input.revision && p.enabled);
  if (!p) throw new ValidationError("Owner profile is disabled or changed");
  const [agent] = await deps.db
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(and(eq(schema.agents.id, input.agentId), eq(schema.agents.orgId, orgId)));
  if (!agent) throw new ForbiddenError("Host MCP agent binding mismatch");
  const catalog = await deps.hub.call(input.machineId, {
    op: "host_mcp",
    agent: { id: input.agentId, handle: "agent" },
    request: { ...input, orgId, action: "catalog" },
  });
  if (!catalog.tools) throw new ValidationError("Host MCP catalog missing");
  const tools = catalog.tools;
  const [old] = await deps.db
    .select()
    .from(connectorConnections)
    .where(
      and(
        eq(connectorConnections.orgId, orgId),
        eq(connectorConnections.authType, MACHINE_MCP_AUTH),
        eq(connectorConnections.serverUrl, serverUrl),
        isNull(connectorConnections.revokedAt),
      ),
    );
  const id = old?.id ?? randomUUID();
  await deps.db.transaction(async (tx) => {
    if (!old)
      await tx.insert(connectorConnections).values({
        id,
        orgId,
        connector: `custom:${id}`,
        serverUrl,
        label: p.label,
        toolPrefix: `host_${id.replaceAll("-", "").slice(0, 12)}`,
        authType: MACHINE_MCP_AUTH,
        createdByUserId: actorId,
        reviewedAt: new Date(),
      });
    // This is an upper ceiling for UI permissions. Per-agent registry policy is checked afresh by runner and source.
    for (const t of tools)
      await tx
        .insert(customTools)
        .values({
          orgId,
          connectionId: id,
          name: t.name,
          description: t.description,
          label: t.name,
          access: t.access,
          sensitive: t.access !== "read",
          confirmedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [customTools.connectionId, customTools.name],
          set: {
            description: t.description,
            removedAt: null,
          },
        });
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "connector.host_mcp_bound",
      target: { type: "connector_connection", id },
      details: {
        machineId: input.machineId,
        profileId: input.profileId,
        revision: input.revision,
        tools: tools.length,
      },
    });
  });
  return { id, label: p.label, tools: catalog.tools.length, grantsCreated: 0 as const };
}
export async function manageHostMcp(
  deps: HostMcpDeps,
  actorId: string,
  orgId: string,
  connectionId: string,
  input: {
    action: "close" | "reconcile";
    agentId: string;
    runId?: string;
    callId?: string;
    decision?: "observed_completed" | "observed_not_executed";
  },
) {
  await requirePermission(deps.db, actorId, orgId, "manage_connectors");
  const [c] = await deps.db
    .select()
    .from(connectorConnections)
    .where(
      and(
        eq(connectorConnections.orgId, orgId),
        eq(connectorConnections.id, connectionId),
        eq(connectorConnections.authType, MACHINE_MCP_AUTH),
        isNull(connectorConnections.revokedAt),
      ),
    );
  if (!c) throw new ForbiddenError("Host MCP connection binding mismatch");
  const [agent] = await deps.db
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(and(eq(schema.agents.id, input.agentId), eq(schema.agents.orgId, orgId)));
  if (!agent) throw new ForbiddenError("Host MCP agent binding mismatch");
  const target = hostMcpIdentity(c.serverUrl);
  await machine(deps, orgId, target.machineId);
  const bound = { ...target, orgId, agentId: input.agentId };
  let request: HostMcpRequest;
  if (input.action === "close") request = { ...bound, action: "close" };
  else {
    if (!input.runId || !input.callId || !input.decision)
      throw new ValidationError("Reconciliation needs the exact run, call and observed decision");
    request = {
      ...bound,
      actorId,
      action: "reconcile",
      runId: input.runId,
      callId: input.callId,
      decision: input.decision,
    };
  }
  const out = await deps.hub.call(target.machineId, {
    op: "host_mcp",
    agent: { id: input.agentId, handle: "agent" },
    request,
  });
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: `connector.host_mcp_${input.action}`,
    target: { type: "connector_connection", id: connectionId },
    details: { ...input },
  });
  return out;
}
async function active(deps: HostMcpDeps, ctx: ToolContext) {
  const [r] = await deps.db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.id, ctx.runId),
        eq(agentRuns.orgId, ctx.orgId),
        eq(agentRuns.agentId, ctx.agentId),
        eq(agentRuns.status, "running"),
      ),
    );
  if (!r) throw new ForbiddenError("Host MCP run binding is inactive");
}
export function createHostMcpToolSource(deps: HostMcpDeps): ToolSource {
  return {
    name: "host-mcp",
    async tools(ctx) {
      const connections = await deps.db
        .select()
        .from(connectorConnections)
        .where(
          and(
            eq(connectorConnections.orgId, ctx.orgId),
            eq(connectorConnections.authType, MACHINE_MCP_AUTH),
            eq(connectorConnections.status, "active"),
            isNull(connectorConnections.revokedAt),
          ),
        );
      const out: ToolDefinition[] = [];
      for (const c of connections) {
        // Existing “all tools” grants do not silently enroll an agent into host processes.
        const grants = await deps.db
          .select()
          .from(agentScopes)
          .where(
            and(
              eq(agentScopes.orgId, ctx.orgId),
              eq(agentScopes.agentId, ctx.agentId),
              eq(agentScopes.connectionId, c.id),
            ),
          );
        if (grants.length === 0) continue;
        try {
          const target = hostMcpIdentity(c.serverUrl);
          await machine(deps, ctx.orgId, target.machineId);
          const bound: HostMcpBinding = { ...target, orgId: ctx.orgId, agentId: ctx.agentId };
          const catalog = await deps.hub.call(
            target.machineId,
            { op: "host_mcp", agent: { id: ctx.agentId, handle: "agent" }, request: { ...bound, action: "catalog" } },
            { signal: ctx.signal },
          );
          const exposed = (catalog.tools ?? []).map((t) => exposedToolName(c.toolPrefix, t.name));
          if (new Set(exposed).size !== exposed.length)
            throw new ValidationError("Host MCP tool names collide. The owner must review them");
          const rows = await deps.db
            .select()
            .from(customTools)
            .where(and(eq(customTools.connectionId, c.id), isNull(customTools.removedAt)));
          const classified = new Map(rows.map((r) => [r.name, r]));
          for (const tool of catalog.tools ?? []) {
            const row = classified.get(tool.name);
            if (!row || row.access === "off" || !row.access || tool.access === "off") continue;
            const access = tool.access === "approval" || row.sensitive || row.access !== "read" ? "approval" : "read";
            const scope = customScope(c.id, access);
            if (!grants.some((g) => g.scope === scope)) continue;
            out.push(definition(c, tool, bound, scope, access === "approval"));
          }
        } catch {
          /* An unavailable/changed/disabled profile exposes no tool, never a remote URL fallback. */
        }
      }
      return out;
    },
  };
  function definition(
    c: typeof connectorConnections.$inferSelect,
    tool: HostMcpTool,
    bound: HostMcpBinding,
    scope: string,
    sensitive: boolean,
  ): ToolDefinition {
    return {
      name: exposedToolName(c.toolPrefix, tool.name),
      description: `[${c.label}] ${tool.description}`.slice(0, 1024),
      inputSchema: tool.inputSchema,
      scope,
      connectionId: c.id,
      connector: { key: `mcp:${c.id}`, via: "mcp", tool: tool.name },
      connectorLabel: c.label,
      toolPrefix: c.toolPrefix,
      sensitive,
      external: true,
      async execute(args, ctx) {
        if (ctx.orgId !== bound.orgId || ctx.agentId !== bound.agentId || !ctx.toolUseId)
          throw new ForbiddenError("Host MCP call binding mismatch");
        const [current] = await deps.db
          .select({ id: connectorConnections.id })
          .from(connectorConnections)
          .where(
            and(
              eq(connectorConnections.id, c.id),
              eq(connectorConnections.orgId, ctx.orgId),
              eq(connectorConnections.authType, MACHINE_MCP_AUTH),
              eq(connectorConnections.serverUrl, c.serverUrl),
              eq(connectorConnections.status, "active"),
              isNull(connectorConnections.revokedAt),
            ),
          );
        const [grant] = await deps.db
          .select({ id: agentScopes.agentId })
          .from(agentScopes)
          .where(
            and(
              eq(agentScopes.orgId, ctx.orgId),
              eq(agentScopes.agentId, ctx.agentId),
              eq(agentScopes.connectionId, c.id),
              eq(agentScopes.scope, scope),
            ),
          );
        if (!current || !grant) throw new ForbiddenError("Host MCP connection or grant binding was revoked");
        const [currentTool] = await deps.db
          .select()
          .from(customTools)
          .where(
            and(
              eq(customTools.connectionId, c.id),
              eq(customTools.orgId, ctx.orgId),
              eq(customTools.name, tool.name),
              isNull(customTools.removedAt),
            ),
          );
        if (!currentTool || !["read", "write", "approval"].includes(currentTool.access ?? ""))
          throw new ForbiddenError("Host MCP tool policy is off or removed");
        const currentAccess =
          tool.access === "approval" || currentTool.sensitive || currentTool.access !== "read" ? "approval" : "read";
        if (customScope(c.id, currentAccess) !== scope || (currentAccess === "approval" && ctx.approved !== true))
          throw new ForbiddenError("Host MCP tool policy changed. Reload the tools and get a current approval");
        await active(deps, ctx);
        await machine(deps, ctx.orgId, bound.machineId);
        const reply = await deps.hub.call(
          bound.machineId,
          {
            op: "host_mcp",
            agent: { id: ctx.agentId, handle: "agent" },
            request: {
              ...bound,
              action: "call",
              runId: ctx.runId,
              callId: ctx.toolUseId,
              tool: tool.name,
              args,
              approved: ctx.approved === true,
            },
          },
          { signal: ctx.signal, timeoutMs: 125000 },
        );
        if (typeof reply.content !== "string" || typeof reply.isError !== "boolean")
          throw new ValidationError("Host MCP result missing");
        return { content: reply.content, isError: reply.isError, images: reply.images };
      },
    };
  }
}
