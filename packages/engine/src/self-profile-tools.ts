import { and, asc, desc, eq, isNull, schema } from "@agenteschat/db";
import { isAutoModel, parseCustomModel } from "@agenteschat/providers";
import { type AiStatusDeps, agentAiState } from "./ai-status";
import { seesAgentDetails } from "./audience";
import { brainOf } from "./brain-settings";
import { modelInfoFor } from "./credentials";
import { sha256 } from "./crypto";
import { requireActiveMembership } from "./organizations";
import { agentUsageFor } from "./plan-usage";
import { personBehindCall, routineCreatorOfCall } from "./requester";
import { carriesCredential } from "./tool-detail";
import { directoryRole } from "./tools/directory";
import { canonicalJson } from "./tools/json-schema";
import { accessWithNeeds, freshGrantedKeys, isAllowed } from "./tools/scopes";
import type { ToolContext, ToolDefinition, ToolSource } from "./tools/types";

export const SELF_PROFILE_TOOL = "get_my_profile";
const SECTIONS = ["summary", "skills", "capabilities", "route", "relationships", "usage"] as const;
const PAGE_SIZE = 20;
const TTL_MS = 5 * 60_000;
const ID = /^[a-zA-Z0-9_.*:/-]{1,160}$/;
const UUID = /^[0-9a-f-]{36}$/i;
const ACTIVE = new Set(["queued", "running", "waiting_approval", "waiting_input"]);

/** Identifiers and own-role text only: labels, endpoint addresses and account previews never enter the result. */
function safeText(value: string | null | undefined, max = 160): string | null {
  if (
    !value ||
    value.length > max ||
    carriesCredential(value) ||
    [...value].some((char) => char.charCodeAt(0) < 32) ||
    /@|https?:|(?:^|\s)[/~]|[A-Z]:\\/i.test(value)
  )
    return null;
  return value;
}
const identifier = (value: string | null | undefined) => (value && ID.test(value) ? safeText(value) : null);
const modelId = (value: string | null | undefined) =>
  identifier(value ? (parseCustomModel(value)?.model ?? value) : null);
const timestamp = (value: string | null | undefined) =>
  value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const uuid = (value: string | null | undefined) => (value && UUID.test(value) ? value : null);
const failure = () => ({
  content: "Your profile is unavailable for this run or its current requester.",
  isError: true,
});

type Deps = {
  /** Listing through the same gateway reuses its grants, denials, availability and run-policy filters. */
  listTools?: (ctx: ToolContext) => Promise<ToolDefinition[]>;
  ai?: Omit<AiStatusDeps, "db">;
};

/**
 * Fixed-context introspection (ADR 0063's own-usage boundary): observations, never grants. The requester must
 * still see this agent's details; consultation reach alone does not expose an owner's private configuration.
 * A routine's creator is checked only for visibility, never substituted as the run's acting person.
 */
export function createSelfProfileToolSource(deps: Deps = {}): ToolSource {
  const tool: ToolDefinition = {
    name: SELF_PROFILE_TOOL,
    description:
      "Your own current role, assigned skill versions, capability grants and native tool listing, selected versus observed AI route, and usage. The snapshot expires and grants no authority: calls still recheck permissions. Start with summary; fetch named sections and their next_offset for complete lists. Pass previous_context_version to detect changes, and restart pagination when it changes. Usage has a separate usage_observed_version and does not invalidate capability pages; compare it when paging usage. Never accepts another agent's id.",
    scope: "",
    inputSchema: {
      type: "object",
      properties: {
        section: { enum: [...SECTIONS] },
        offset: { type: "integer", minimum: 0, maximum: 100_000 },
        previous_context_version: { type: "string", pattern: "^[a-f0-9]{64}$" },
      },
      additionalProperties: false,
    },
    async execute(input, ctx) {
      try {
        const { db } = ctx;
        const a = schema.agents;
        const [agent] = await db
          .select({
            id: a.id,
            orgId: a.orgId,
            role: a.role,
            ownerUserId: a.ownerUserId,
            groupId: a.groupId,
            reportsToAgentId: a.reportsToAgentId,
            archivedAt: a.archivedAt,
            audienceMode: a.audienceMode,
            audienceUserIds: a.audienceUserIds,
            audienceRoleIds: a.audienceRoleIds,
            consultable: a.consultable,
            brain: a.brain,
            brainModel: a.brainModel,
            brainEffort: a.brainEffort,
            brainFallback: a.brainFallback,
            brainExtraUsage: a.brainExtraUsage,
            contextTokens: a.contextTokens,
            model: a.model,
            credentialId: a.credentialId,
            machineId: a.machineId,
            brainAccountId: a.brainAccountId,
            builtin: a.builtin,
            planForOthers: a.planForOthers,
          })
          .from(a)
          .where(and(eq(a.orgId, ctx.orgId), eq(a.id, ctx.agentId)));
        const r = schema.agentRuns;
        const [run] = await db
          .select({
            id: r.id,
            orgId: r.orgId,
            agentId: r.agentId,
            channelId: r.channelId,
            threadRootId: r.threadRootId,
            triggerMessageId: r.triggerMessageId,
            background: r.background,
            status: r.status,
            brain: r.brain,
          })
          .from(r)
          .where(and(eq(r.orgId, ctx.orgId), eq(r.id, ctx.runId), eq(r.agentId, ctx.agentId)));
        if (
          !agent ||
          agent.archivedAt ||
          !run ||
          !ACTIVE.has(run.status) ||
          run.channelId !== ctx.channelId ||
          run.triggerMessageId !== ctx.triggerMessageId ||
          run.threadRootId !== ctx.threadRootId
        )
          return failure();
        const person = await personBehindCall(ctx);
        const reader = person ?? (await routineCreatorOfCall(ctx));
        // No fallback to agent.ownerUserId: it is not the initiating actor.
        if (!reader) return failure();
        try {
          const membership = await requireActiveMembership(db, reader, ctx.orgId);
          if (!seesAgentDetails(agent, reader, membership)) return failure();
        } catch {
          return failure();
        }

        const [skills, grants, listed, observed, usage, ready] = await Promise.all([
          db
            .select({ id: schema.skills.id, name: schema.skills.name, version: schema.skills.version })
            .from(schema.agentSkills)
            .innerJoin(
              schema.skills,
              and(eq(schema.skills.id, schema.agentSkills.skillId), eq(schema.skills.orgId, ctx.orgId)),
            )
            .where(
              and(
                eq(schema.agentSkills.orgId, ctx.orgId),
                eq(schema.agentSkills.agentId, ctx.agentId),
                eq(schema.agentSkills.enabled, true),
                isNull(schema.skills.deletedAt),
              ),
            )
            .orderBy(asc(schema.skills.id)),
          freshGrantedKeys(db, ctx.orgId, ctx.agentId),
          deps.listTools ? deps.listTools({ ...ctx, loadedGroups: undefined }) : null,
          db
            .select({ data: schema.agentRunSteps.data })
            .from(schema.agentRunSteps)
            .where(and(eq(schema.agentRunSteps.runId, run.id), eq(schema.agentRunSteps.kind, "model_call")))
            .orderBy(desc(schema.agentRunSteps.seq))
            .limit(1),
          agentUsageFor(db, null, ctx.orgId, ctx.agentId),
          deps.ai ? agentAiState({ ...deps.ai, db }, agent, run) : null,
        ]);
        const knownModel = typeof observed[0]?.data.model === "string" ? observed[0].data.model : null;
        const info = !isAutoModel(agent.model) ? await modelInfoFor(db, agent.model, ctx.orgId) : undefined;
        const toolMap = new Map<string, ToolDefinition>();
        for (const t of listed ?? []) {
          for (const real of directoryRole(t)?.tools ?? [t])
            if (isAllowed(accessWithNeeds(grants, real).state)) toolMap.set(real.name, real);
        }
        const capabilities = [
          ...[...grants].sort().map((key) => {
            const [connection, scope] = key.split("|");
            return {
              kind: "grant",
              connection_id: connection === "builtin" ? null : uuid(connection),
              scope: identifier(scope),
              note: "Grant row; denials, dependencies, availability and approval checks still apply.",
            };
          }),
          ...[...toolMap.values()]
            .sort((x, y) => x.name.localeCompare(y.name))
            .map((t) => ({
              kind: "tool",
              name: identifier(t.name),
              scope: identifier(t.scope) ?? (t.scope === "" ? "" : null),
              connection_id: uuid(t.connectionId),
              availability: "listed_now",
              approval: "rechecked_on_call",
            })),
        ];
        const rawPlan = usage.view.current?.usage;
        const facts = {
          relationships: [
            {
              role: safeText(agent.role, 400),
              role_redacted: Boolean(agent.role && !safeText(agent.role, 400)),
              owner_user_id: identifier(agent.ownerUserId),
              supervisor_agent_id: uuid(agent.reportsToAgentId),
              department_id: uuid(agent.groupId),
              audience_mode: agent.audienceMode,
              consultable: agent.consultable,
            },
          ],
          route: [
            {
              configured_brain: brainOf(agent.brain),
              configured_api_model: modelId(agent.model),
              configured_computer_model: modelId(agent.brainModel),
              effort: identifier(agent.brainEffort),
              fallback_enabled: agent.brainFallback,
              extra_usage_enabled: agent.brainExtraUsage,
              context_tokens_setting: agent.contextTokens,
              catalog_context_window: info?.contextWindow ?? null,
              effective_run_brain: run.brain ? brainOf(run.brain) : null,
              last_observed_run_model: modelId(knownModel),
              observed_model_source: knownModel ? "completed_model_call_step" : "unknown_before_model_call_record",
              configured_api_provider: info?.provider ? identifier(info.provider) : null,
              pricing: info?.unpriced ? "unpriced" : info ? "catalog_priced" : "unknown",
              readiness: ready
                ? { state: ready.state, reason: ready.reason ?? null }
                : { state: "unknown", reason: "not_observed" },
              available_models: null,
              available_models_status: "not_observed; catalog choices do not prove account availability",
            },
          ],
          skills: skills.map((s) => ({ id: s.id, name: safeText(s.name), version: s.version })),
          capabilities,
          usage: [
            {
              kind: "aggregate",
              month: usage.view.month,
              tokens: usage.view.tokens,
              api_budget_used_percent: usage.api?.budgetPercent ?? null,
              plan_usage_observed_at: timestamp(rawPlan?.at),
              money: "not_exposed; zero recorded cost does not establish free usage",
              plan_limits: rawPlan ? "reported; may be stale" : "unknown",
            },
            ...[...(rawPlan?.windows ?? [])]
              .map((w) => ({
                kind: "plan_window",
                window: identifier(w.kind),
                used_percent: w.usedPercent,
                resets_at: timestamp(w.resetsAt),
              }))
              .sort((x, y) => canonicalJson(x).localeCompare(canonicalJson(y))),
          ],
          tool_listing_observed: listed !== null,
        };
        // Usage changes after ordinary turns; it must not invalidate capability pagination.
        const { usage: usageFacts, ...capabilityFacts } = facts;
        const identity = { agent_id: ctx.agentId, org_id: ctx.orgId };
        const version = sha256(canonicalJson({ ...identity, facts: capabilityFacts }));
        const usageVersion = sha256(canonicalJson({ ...identity, usage: usageFacts }));
        const captured = new Date();
        const summary = [
          {
            role: facts.relationships[0]?.role,
            configured_brain: brainOf(agent.brain),
            skills: skills.length,
            capability_entries: capabilities.length,
            tool_listing_observed: listed !== null,
            sections: SECTIONS.filter((s) => s !== "summary"),
            limits:
              "Snapshot only; permission changes apply at invocation, not by remembering this text. No atomic snapshot or automatic refresh is claimed.",
          },
        ];
        const section = (input.section ?? "summary") as (typeof SECTIONS)[number];
        const entries = section === "summary" ? summary : facts[section];
        const offset = typeof input.offset === "number" ? input.offset : 0;
        if (offset > entries.length)
          return {
            content: "Offset is beyond this section. Start at offset 0 with the current context_version.",
            isError: true,
          };
        const next = offset + PAGE_SIZE < entries.length ? offset + PAGE_SIZE : null;
        const result = {
          agent_id: ctx.agentId,
          source: "native_agent_runtime",
          captured_at: captured.toISOString(),
          expires_at: new Date(captured.getTime() + TTL_MS).toISOString(),
          context_version: version,
          usage_observed_version: usageVersion,
          changed:
            typeof input.previous_context_version === "string" ? input.previous_context_version !== version : null,
          authority: false,
          acting_person: person !== null,
          section,
          offset,
          total: entries.length,
          complete: next === null,
          next_offset: next,
          items: entries.slice(offset, offset + PAGE_SIZE),
        };
        return { content: JSON.stringify(result) };
      } catch {
        return failure();
      }
    },
  };
  return { name: "self-profile", tools: async () => [tool] };
}
