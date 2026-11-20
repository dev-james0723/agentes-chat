import { and, eq, isNull, schema } from "@agenteschat/db";
import { ForbiddenError } from "./errors";
import type { createModelInspector } from "./model-inspector";
import { assertActiveMembership, can, getMembership } from "./organizations";
import { personBehindCall } from "./requester";
import type { ToolContext, ToolDefinition, ToolSource } from "./tools/types";

export const MODEL_INSPECTOR_TOOL = "get_model_inspector_status";
type Inspector = Pick<ReturnType<typeof createModelInspector>, "enabled" | "report">;

/** The role's name grants nothing: it must also be enabled here and answer an authorized person. */
async function mayRead(inspector: Inspector, ctx: ToolContext): Promise<boolean> {
  if (!inspector.enabled(ctx.orgId)) return false;
  const [agent] = await ctx.db
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(
      and(
        eq(schema.agents.orgId, ctx.orgId),
        eq(schema.agents.id, ctx.agentId),
        eq(schema.agents.handle, "model-inspector"),
        isNull(schema.agents.archivedAt),
        isNull(schema.agents.deletedAt),
      ),
    );
  if (!agent) return false;
  const person = await personBehindCall(ctx);
  if (!person) return false;
  const membership = await getMembership(ctx.db, person, ctx.orgId);
  if (!membership) return false;
  assertActiveMembership(membership);
  return can(membership, "manage_agents") && can(membership, "view_usage");
}

/** The inspector's on-demand status; the deterministic server worker owns polling and routing. */
export function createModelInspectorToolSource(inspector: Inspector): ToolSource {
  const tool: ToolDefinition = {
    name: MODEL_INSPECTOR_TOOL,
    description:
      "Read the team's Model Inspector status: observed plan usage, its freshness, affected agents, active tasks and routing decisions. Use each observation time and keep unknown quota unknown. This reads stored observations; it does not change models, refresh a provider or run an inspection.",
    scope: "",
    readOnly: true,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute(_input, ctx) {
      // Recheck after discovery: the caller's role or the agent's identity may have changed meanwhile.
      if (!(await mayRead(inspector, ctx))) {
        throw new ForbiddenError("Model Inspector status requires the configured inspector and an authorized person.");
      }
      const report = await inspector.report(ctx.orgId);
      const data = { enabled: true, report };
      return {
        content: report
          ? JSON.stringify(data)
          : "Model Inspector is enabled, but no inspection report is available yet. No quota or model changes are confirmed.",
        data,
      };
    },
  };
  return {
    name: "model-inspector",
    tools: async (ctx) => ((await mayRead(inspector, ctx)) ? [tool] : []),
  };
}
