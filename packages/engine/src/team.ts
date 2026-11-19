import { and, asc, type Database, desc, eq, gte, inArray, isNotNull, isNull, schema, sql } from "@agenteschat/db";
import { type AgentStatusView, lineInEnglish, loadAgentStatuses } from "./agent-status";
import { currentHandles } from "./agents";
import { type AiStatusDeps, agentAiStates } from "./ai-status";
import type { AgentAppearance } from "./appearance";
import { canTalkTo, type Speaker, seesAgentDetails, speakerFor, speakerOf, viaAgent } from "./audience";
import { inLine, mayCall } from "./autonomy-settings";
import { agentBrowserStatus } from "./browser/status";
import { BROWSER_SCOPE, DESKTOP_SCOPE } from "./browser/types";
import { caches } from "./cache";
import { capabilityKeys, summarizeScopes } from "./capabilities";
import { channelAudienceSql } from "./channels";
import {
  chooseDelegate,
  DELEGATION_PURPOSES,
  type DelegateChoice,
  delegationScope,
  MAX_DELEGATE_CANDIDATES,
  readDelegationIntent,
} from "./delegation-choice";
import { agentDesktopUseStatus } from "./desktop/status";
import { cutText, editDistance } from "./format";
import type { Judge } from "./judge";
import type { MachineCaller, MachineStatus } from "./machine-hub";
import { parseMentionHandles } from "./messages";
import { requirePermission } from "./organizations";
import { maySql } from "./permissions";
import { personBehindCall, routineCreatorOfCall } from "./requester";
import { getSandboxSettings, SANDBOX_SCOPE } from "./sandbox";
import type { ToolContext, ToolDefinition, ToolSource } from "./tools/types";
import { inWorkspaceWords, isPersonalWorkspace } from "./workspace-mode";

const {
  agentConsultations,
  agentRuns,
  agentScopes,
  agents,
  channelMembers,
  channels,
  connectorConnections,
  organizationMembers,
  users,
} = schema;

/**
 * Each agent's scopes, with a whole-connection grant (`connector:*`) named
 * after its connector (`sentry:*`), so summaries say "Sentry", not "Connector".
 */
export async function agentScopeNames(db: Database, orgId: string, agentIds: string[]) {
  if (agentIds.length === 0) return [];
  const rows = await db
    .select({ agentId: agentScopes.agentId, scope: agentScopes.scope, connector: connectorConnections.connector })
    .from(agentScopes)
    .leftJoin(connectorConnections, eq(connectorConnections.id, agentScopes.connectionId))
    .where(and(eq(agentScopes.orgId, orgId), inArray(agentScopes.agentId, agentIds)));
  return rows.map((r) => ({
    agentId: r.agentId,
    scope: r.scope.startsWith("connector:") && r.connector ? `${r.connector}:${r.scope.slice(10)}` : r.scope,
  }));
}

/**
 * Granted to every new agent, but each works only where the agent's computer serves it. A function, not a set made
 * as the module loads: `sandbox` reaches back into this module through an import cycle, so its constant may not be
 * initialized yet when this one is evaluated first.
 */
function isComputerScope(scope: string) {
  return scope === SANDBOX_SCOPE || scope === BROWSER_SCOPE || scope === DESKTOP_SCOPE;
}

/**
 * Each agent's scopes as the other agents read them (the roster in a run's
 * context, `find_agent`): a computer's (Code, Browser, Desktop) only while the
 * agent's computer serves it, by the checks its own tools pass.
 */
export async function rosterScopeNames(
  db: Database,
  machines: Pick<MachineCaller, "status"> | null | undefined,
  orgId: string,
  agentIds: string[],
) {
  if (agentIds.length === 0) return [];
  // Every run's context reads this: one round trip, and one read per computer however many agents share it.
  const reads = new Map<string, Promise<MachineStatus | null>>();
  const hub = machines
    ? {
        status: (id: string) => {
          const read = reads.get(id) ?? machines.status(id);
          reads.set(id, read);
          return read;
        },
      }
    : undefined;
  const [rows, sandbox, statuses] = await Promise.all([
    agentScopeNames(db, orgId, agentIds),
    getSandboxSettings(db, orgId),
    Promise.all(
      agentIds.map(async (agentId) => {
        const [browser, desktop] = await Promise.all([
          agentBrowserStatus(db, hub, orgId, agentId),
          agentDesktopUseStatus(db, hub, orgId, agentId),
        ]);
        return { agentId, browser, desktop };
      }),
    ),
  ]);
  const served = new Map(
    statuses.map(({ agentId, browser, desktop }) => {
      // No computer, or a removed one, is what the browser's status checks first.
      const computer = browser.available || !["no_machine", "machine_removed"].includes(browser.code);
      const code = sandbox.enabled && computer && rows.some((r) => r.agentId === agentId && r.scope === SANDBOX_SCOPE);
      const scopes = [
        ...(code ? [SANDBOX_SCOPE] : []),
        ...(browser.available ? [BROWSER_SCOPE] : []),
        ...(code && desktop.available ? [DESKTOP_SCOPE] : []),
      ];
      return [agentId, new Set(scopes)] as const;
    }),
  );
  return rows.filter((r) => !isComputerScope(r.scope) || served.get(r.agentId)?.has(r.scope));
}

export const FIND_AGENT_TOOL = "find_agent";
/** Up to this many teammates are named in every prompt; above it, only a hint to use `find_agent`. */
export const TEAM_IN_PROMPT = 15;

type Teammate = Pick<
  typeof agents.$inferSelect,
  | "id"
  | "name"
  | "handle"
  | "role"
  | "instructions"
  | "ownerUserId"
  | "audienceMode"
  | "audienceUserIds"
  | "audienceRoleIds"
  | "consultable"
  | "brain"
  | "autonomyBrakes"
  | "reportsToAgentId"
> & { groupId?: string | null };

const TEAM_COLUMNS = {
  id: agents.id,
  name: agents.name,
  handle: agents.handle,
  role: agents.role,
  instructions: agents.instructions,
  ownerUserId: agents.ownerUserId,
  audienceMode: agents.audienceMode,
  audienceUserIds: agents.audienceUserIds,
  audienceRoleIds: agents.audienceRoleIds,
  consultable: agents.consultable,
  brain: agents.brain,
  autonomyBrakes: agents.autonomyBrakes,
  reportsToAgentId: agents.reportsToAgentId,
  groupId: agents.groupId,
};

/** The org's active agents, oldest first (per-process cache; agent writes drop it). */
export function loadTeam(db: Database, orgId: string): Promise<Teammate[]> {
  return caches.agents.getOrLoad(`${orgId}:team`, () =>
    db
      .select(TEAM_COLUMNS)
      .from(agents)
      .where(and(eq(agents.orgId, orgId), isNull(agents.archivedAt)))
      .orderBy(asc(agents.createdAt)),
  ) as Promise<Teammate[]>;
}

export const forgetTeam = (orgId: string) => caches.agents.delete(`${orgId}:team`);

/** Handles of the org's archived agents (per-process cache; archiving drops it). */
function loadArchived(db: Database, orgId: string): Promise<string[]> {
  return caches.agents.getOrLoad(`${orgId}:archived`, async () =>
    (
      await db
        .select({ handle: agents.handle })
        .from(agents)
        .where(
          and(
            eq(agents.orgId, orgId),
            isNotNull(agents.archivedAt),
            // A person may hold that handle now (people's handles don't check agents'): the @ is theirs.
            sql`not exists (select 1 from ${organizationMembers} om
              where om.org_id = ${orgId}::uuid and om.handle = ${agents.handle})`,
          ),
        )
    ).map((r) => r.handle),
  ) as Promise<string[]>;
}

/** Handles offered for one that no agent here has. */
const CLOSEST_HANDLES = 3;

/**
 * A tool's answer for `@handles` (lower case, without the @) that reach no agent here: an archived one says so,
 * so the run stops trying it and tells the person; any other gets the closest handles among the agents the
 * person behind the run can talk to (the ones `find_agent` lists).
 */
/** `viaAgent`: the tool asks the agent for the person (ask_agent, tell_agent), so agents that take consultations count. */
export async function noAgentText(
  ctx: ToolContext,
  handles: string[],
  options: { viaAgent?: boolean } = {},
): Promise<string> {
  const person = await personBehindCall(ctx);
  const [archived, team, talks] = await Promise.all([
    loadArchived(ctx.db, ctx.orgId),
    loadTeam(ctx.db, ctx.orgId),
    speakerFor(ctx.db, ctx.orgId, person),
  ]);
  const speaker = options.viaAgent ? viaAgent(talks) : talks;
  const others = team.filter((a) => a.id !== ctx.agentId && canTalkTo(a, person, speaker)).map((a) => a.handle);
  return handles
    .map((h) => {
      if (archived.includes(h)) {
        return `@${h} is archived: nothing you send reaches it. Don't try it again. If the work needs it, tell the person.`;
      }
      const closest = others
        .map((o) => ({ o, d: editDistance(h, o) }))
        .sort((x, y) => x.d - y.d)
        .slice(0, CLOSEST_HANDLES)
        .map((x) => `@${x.o}`);
      return `No agent @${h} here.${closest.length > 0 ? ` Closest handles: ${closest.join(", ")}.` : ""}`;
    })
    .join(" ");
}

/**
 * "# Archived agents": the archived agents that what a run reads still names (its instructions, its notes, the
 * conversation), so it neither asks nor mentions them and tells the person when its work counted on one. Empty
 * when it names none.
 */
export async function archivedAgentsPrompt(db: Database, orgId: string, texts: string[]): Promise<string> {
  const named = new Set(texts.flatMap((t) => parseMentionHandles(t)));
  if (named.size === 0) return "";
  const gone = (await loadArchived(db, orgId)).filter((h) => named.has(h)).map((h) => `@${h}`);
  if (gone.length === 0) return "";
  const one = gone.length === 1;
  const them = one ? "it" : "them";
  return `# Archived agents\n${gone.join(", ")} ${one ? "is" : "are"} archived: nothing you send reaches ${them}. Don't ask or mention ${them}. If your instructions, notes or this conversation count on ${one ? "it" : "one"}, tell the person.`;
}

/**
 * "# Renamed agents": the old handles (`currentHandles`) that what a run reads still names (a routine's brief, its
 * notes, the conversation), each with the handle its agent has now, so the run asks and mentions it by that one.
 * Empty when it names none.
 */
export async function renamedAgentsPrompt(db: Database, orgId: string, texts: string[]): Promise<string> {
  const named = [...new Set(texts.flatMap((t) => parseMentionHandles(t)))];
  const now = await currentHandles(db, orgId, named);
  const renamed = named.flatMap((h, i) => (now[i] && now[i] !== h ? [`@${h} is @${now[i]}`] : []));
  if (renamed.length === 0) return "";
  return `# Renamed agents\nSome text here names agents by a handle they had before: ${renamed.join(", ")}. It is the same agent: ask and mention it by the handle it has now.`;
}

/**
 * The org's other agents a run may ask for the person behind it (they talk to them, or take consultations) and its
 * own settings let it call (ADR 0131 §8), `skip` left out: who "# Your team" lists.
 */
export const teammatesFor = (
  team: Teammate[],
  selfId: string,
  requester: string | null,
  skip: Set<string>,
  talks: Speaker,
) => {
  const self = team.find((a) => a.id === selfId);
  return team.filter(
    (a) =>
      a.id !== selfId &&
      !skip.has(a.id) &&
      canTalkTo(a, requester, viaAgent(talks)) &&
      ((!!self && inLine(self, a)) || mayCall(self?.autonomyBrakes, { id: a.id, autonomy: a.autonomyBrakes })),
  );
};

/**
 * The teammates a run can reach, as `@handle (role)` (at most 10), for its general means (ADR 0109): those the
 * person behind it, or its routine's creator, may talk to.
 */
export async function teammateMeans(
  ctx: Pick<ToolContext, "db" | "orgId" | "agentId" | "runId" | "triggerMessageId">,
  /** Whose agents they are, when the caller knows it already (the executor, from its run in memory). */
  known?: string | null,
) {
  const person = known !== undefined ? known : ((await personBehindCall(ctx)) ?? (await routineCreatorOfCall(ctx)));
  const [team, talks] = await Promise.all([loadTeam(ctx.db, ctx.orgId), speakerFor(ctx.db, ctx.orgId, person)]);
  return teammatesFor(team, ctx.agentId, person, new Set(), talks)
    .slice(0, 10)
    .map((a) => `@${a.handle}${a.role ? ` (${cutText(a.role, 60)})` : ""}`);
}

/**
 * "# Your team" for the system prompt: the other agents the person
 * behind the run can talk to, one short line each, so an agent knows who
 * exists even in a DM. Details stay behind `find_agent`. Agents already
 * described in "Where you are" (channel members) are left out. In a personal workspace (ADR 0159) they are the
 * person's other agents, not a team.
 */
export function teamPrompt(
  team: Teammate[],
  selfId: string,
  requester: string | null,
  skip: Set<string>,
  /** The requester as the audience rule reads them (`speakerFor`). */
  talks: Speaker,
  personal = false,
) {
  const others = teammatesFor(team, selfId, requester, skip, talks);
  if (others.length === 0) return "";
  const where = personal ? "work for this person" : "work in this organization";
  const lines =
    others.length > TEAM_IN_PROMPT
      ? `${others.length} other agents ${where}.`
      : `Other agents ${personal ? "of this person" : "in this organization"}: ${others.map((a) => `@${a.handle}${a.role ? ` (${a.role})` : ""}`).join(", ")}.`;
  return `# ${personal ? "Your fellow agents" : "Your team"}\n${lines} Use \`${FIND_AGENT_TOOL}\` to see who knows or can do something and what each one can do. When you need another agent's answer for the task, ask it with \`ask_agent\`; to hand one work, use \`tell_agent\`, giving the whole job to the agent that owns it with everything it needs. Do this instead of saying you can't or sending the person to it. Either way the call returns at once and what comes of it reaches you here by itself.`;
}

const words = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3);

/** `find_agent` as a personal workspace's agents read it (ADR 0159). */
const FIND_AGENT_PERSONAL = {
  [FIND_AGENT_TOOL]:
    "Find this person's agents. Query alone searches names and roles. With task, Jev picks the best-placed agent among those you may reach and that are ready: give a short non-secret task summary and, when you know it, the purpose (default implementer). An exact handle or targetAgentId picks that agent; a departmentId narrows the choice; anything else in query is a hint. The pick is advice: it starts no work and grants no authority.",
};

/**
 * The built-in `find_agent` tool: who else works here, searchable by
 * name, role or what they do. Lists only agents the person behind the run can
 * talk to or that take consultations for them, with what they can do (`rosterScopeNames`), who is responsible and
 * whether they are busy. Read-only; asking one is `ask_agent`.
 */
export function createFindAgentToolSource(
  deps: { machines?: Pick<MachineCaller, "status"> | null; judge?: Judge; ai?: Omit<AiStatusDeps, "db"> } = {},
): ToolSource {
  const tool: ToolDefinition = {
    name: FIND_AGENT_TOOL,
    description:
      "Find agents. Query alone searches names and roles. With task, Jev picks the best-placed agent among those you may reach and that are ready: give a short non-secret task summary and, when you know it, the purpose (default implementer; use independent_reviewer for a review so the author is not picked by habit). An exact handle or targetAgentId picks that agent; a departmentId narrows the choice; anything else in query, and requiredTools, are hints for Jev. The pick is advice: it starts no work and grants no authority.",
    scope: "",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", maxLength: 200, description: "What you need, e.g. 'staging deploy' or 'invoices'." },
        purpose: {
          enum: [...DELEGATION_PURPOSES],
          description:
            "Which responsibility is being selected (default implementer): delivery owner, department coordinator, implementer or independent reviewer.",
        },
        departmentId: {
          type: "string",
          format: "uuid",
          description: "Existing native department ID, not a role title or its human lead.",
        },
        targetAgentId: {
          type: "string",
          format: "uuid",
          description: "An exact existing agent ID. Selection still checks native reach/readiness.",
        },
        requiredTools: {
          type: "array",
          maxItems: 8,
          uniqueItems: true,
          items: { type: "string", pattern: "^[a-zA-Z][a-zA-Z0-9_-]{0,63}$" },
          description: "Tools the work needs, as a hint for Jev's choice. Not checked against what each agent can use.",
        },
        task: {
          type: "string",
          minLength: 1,
          maxLength: 1200,
          description:
            "A short, non-secret summary for Jev to recommend the best delegate. Read-only: no assignment or message is sent.",
        },
      },
      additionalProperties: false,
    },
    describe: (input) => ({
      title: typeof input.task === "string" ? "Delegate selection" : "Find agents",
      detail: String(input.task ?? input.query ?? ""),
    }),
    async execute(input, ctx) {
      const { db } = ctx;
      const output = (decision: DelegateChoice) => ({
        content:
          decision.status === "recommended"
            ? `${decision.by === "rules" ? "Explicit target" : "Jev suggests"} @${decision.handle} (agent ${decision.agentId}) for ${decision.purpose}. Task fitness and review independence are unverified. This starts no work and grants no authority; recheck ownership, readiness and approvals before dispatch.`
            : decision.status === "insufficient_scope"
              ? `Delegate selection needs more scope: ${decision.reason}. Fill the missing selection fields from the current task; use query-only lookup when needed. No agent selected. ${decision.decisionCalls === 0 ? "No decision-model call made." : "One decision-model call was consumed; no retry or substitute was attempted."}`
              : `Delegate selection result: ${decision.status}. No agent selected; no work started. Do not substitute a model or agent on failure.`,
        ...(["unavailable", "invalid", "invalid_input"].includes(decision.status) ? { isError: true } : {}),
        data: { delegation: decision },
      });
      const parsed = typeof input.task === "string" ? readDelegationIntent(input) : undefined;
      if (parsed && "decision" in parsed) return output(parsed.decision);
      if (typeof input.task === "string" && (!input.task.trim() || input.task.length > 1200))
        return output(delegationScope("invalid_task"));
      // A task mention must resolve to a nonempty exact identity before any native roster reads.
      // Leave query-only metadata search semantics intact.
      if (
        typeof input.task === "string" &&
        typeof input.query === "string" &&
        input.query.trim() &&
        !input.query.trim().replace(/^@/, "")
      )
        return output(
          delegationScope("exact_target_required", parsed && "intent" in parsed ? parsed.intent.purpose : undefined),
        );
      const person = await personBehindCall(ctx);
      const talks = await speakerFor(db, ctx.orgId, person);
      const allTeam = await loadTeam(db, ctx.orgId);
      const team = allTeam.filter((a) => a.id !== ctx.agentId && canTalkTo(a, person, viaAgent(talks)));
      if (typeof input.task === "string") {
        if (!parsed || !("intent" in parsed)) return output(delegationScope("selection_purpose_required"));
        const intent = parsed.intent;
        const facts = {
          purpose: intent.purpose,
          taskFit: "unverified" as const,
          independence: "not_evaluated" as const,
        };
        const noCandidates = (): DelegateChoice => ({
          status: "no_candidates",
          by: "rules",
          ...facts,
          decisionCalls: 0,
        });
        let callable = teammatesFor(allTeam, ctx.agentId, person, new Set(), talks);
        let targetId = intent.targetAgentId;
        const query = typeof input.query === "string" ? input.query.trim().replace(/^@/, "").toLowerCase() : "";
        // An exact handle names the target; any other description is only a hint for Jev.
        const exact = query ? callable.filter((a) => a.handle.toLowerCase() === query) : [];
        if (exact.length === 1) {
          if (targetId && targetId !== exact[0]?.id)
            return output(delegationScope("target_identity_conflict", intent.purpose));
          targetId = exact[0]?.id;
        }
        const hint = exact.length === 1 ? undefined : (input.query as string | undefined)?.trim() || undefined;
        callable = callable.filter(
          (a) => (!targetId || a.id === targetId) && (!intent.departmentId || a.groupId === intent.departmentId),
        );
        if (!callable.length) return output(noCandidates());
        if (callable.length > MAX_DELEGATE_CANDIDATES)
          return output(delegationScope("shortlist_too_large", intent.purpose));
        if (!deps.ai)
          return output({
            status: "unavailable",
            by: "rules",
            ...facts,
            decisionCalls: 0,
            reason: "readiness_unavailable",
          });
        const ids = callable.map((a) => a.id);
        const [scopes, statuses, readiness] = await Promise.all([
          rosterScopeNames(db, deps.machines, ctx.orgId, ids),
          loadAgentStatuses(db, ctx.orgId, new Date(), ids),
          agentAiStates({ db, ...deps.ai }, ctx.orgId, ids),
        ]);
        if (ctx.signal?.aborted) return output(delegationScope("canceled", intent.purpose));
        if ((await personBehindCall(ctx)) !== person)
          return output(delegationScope("requester_changed", intent.purpose));
        if (person) {
          try {
            await requirePermission(db, person, ctx.orgId, "read");
          } catch {
            return output(delegationScope("requester_unavailable", intent.purpose));
          }
        }
        // Explicit lookup only: bounded fresh rows and requester reach, after asynchronous readiness checks.
        // Keep inLine's existing permission semantics; it is not semantic task fitness.
        const [fresh, freshTalks] = await Promise.all([
          db
            .select(TEAM_COLUMNS)
            .from(agents)
            .where(
              and(eq(agents.orgId, ctx.orgId), inArray(agents.id, [ctx.agentId, ...ids]), isNull(agents.archivedAt)),
            ),
          speakerFor(db, ctx.orgId, person),
        ]);
        if (!fresh.some((a) => a.id === ctx.agentId)) return output(noCandidates());
        const statusOf = new Map(statuses.map((s) => [s.agentId, s]));
        const candidates = teammatesFor(fresh, ctx.agentId, person, new Set(), freshTalks)
          .filter(
            (a) =>
              ids.includes(a.id) &&
              (!targetId || a.id === targetId) &&
              (!intent.departmentId || a.groupId === intent.departmentId) &&
              readiness.get(a.id)?.state === "ready" &&
              !["offline", "out"].includes(statusOf.get(a.id)?.presence ?? "offline"),
          )
          .map((a) => ({
            id: a.id,
            handle: a.handle,
            name: a.name,
            role: a.role,
            about: cutText(a.instructions ?? "", 300),
            departmentId: a.groupId ?? null,
            can: summarizeScopes(scopes.filter((s) => s.agentId === a.id).map((s) => s.scope)),
            presence: statusOf.get(a.id)?.presence ?? "unknown",
          }));
        if (!candidates.length) return output(noCandidates());
        if (targetId) {
          const found = candidates.find((a) => a.id === targetId);
          if (!found) return output(noCandidates());
          return output({
            status: "recommended",
            by: "rules",
            ...facts,
            decisionCalls: 0,
            agentId: found.id,
            handle: found.handle,
            receipt: {
              candidateIds: [found.id],
              policyVersion: "delegate/2",
              approval: "not_evaluated",
              capacityLease: "not_reserved",
              dispatch: "not_requested",
            },
          });
        }
        if (!deps.judge) return output({ status: "unavailable", by: "rules", ...facts, decisionCalls: 0 });
        const decision = await chooseDelegate(
          deps.judge,
          { orgId: ctx.orgId, agentId: ctx.agentId, runId: ctx.runId },
          input.task,
          candidates,
          intent.purpose,
          { query: hint, requiredTools: intent.requiredTools },
        );
        // Judge settlement is asynchronous: its eligible inputs are evidence, not current authority.
        // Abstention discards the old receipt (including IDs/handles), but never resets consumed calls.
        const abstain = (status: "insufficient_scope" | "no_candidates", reason: string): DelegateChoice => ({
          status,
          by: "rules",
          ...facts,
          decisionCalls: decision.decisionCalls,
          reason,
        });
        try {
          if (ctx.signal?.aborted) return output(abstain("insufficient_scope", "canceled"));
          if ((await personBehindCall(ctx)) !== person)
            return output(abstain("insufficient_scope", "requester_changed"));
          if (person) await requirePermission(db, person, ctx.orgId, "read");
          if (decision.status !== "recommended") {
            // No recommendation needs its former shortlist disclosed in an error receipt.
            const { receipt: _receipt, ...withoutCandidates } = decision;
            return output(withoutCandidates);
          }
          const candidateIds = candidates.map((a) => a.id);
          const [currentReadiness, currentStatuses] = await Promise.all([
            agentAiStates({ db, ...deps.ai }, ctx.orgId, candidateIds),
            loadAgentStatuses(db, ctx.orgId, new Date(), candidateIds),
          ]);
          // Read candidate/caller authority only after asynchronous readiness/status has settled.
          const [current, currentTalks] = await Promise.all([
            db
              .select(TEAM_COLUMNS)
              .from(agents)
              .where(
                and(
                  eq(agents.orgId, ctx.orgId),
                  inArray(agents.id, [ctx.agentId, ...candidateIds]),
                  isNull(agents.archivedAt),
                ),
              ),
            speakerFor(db, ctx.orgId, person),
          ]);
          // Check actor/cancellation again after the native asynchronous checks.
          if (ctx.signal?.aborted) return output(abstain("insufficient_scope", "canceled"));
          if ((await personBehindCall(ctx)) !== person)
            return output(abstain("insufficient_scope", "requester_changed"));
          if (person) await requirePermission(db, person, ctx.orgId, "read");
          const presence = new Map(currentStatuses.map((a) => [a.agentId, a.presence]));
          const eligible = current.some((a) => a.id === ctx.agentId)
            ? teammatesFor(current, ctx.agentId, person, new Set(), currentTalks).filter(
                (a) =>
                  candidateIds.includes(a.id) &&
                  (!intent.departmentId || a.groupId === intent.departmentId) &&
                  currentReadiness.get(a.id)?.state === "ready" &&
                  !["offline", "out"].includes(presence.get(a.id) ?? "offline"),
              )
            : [];
          const selected = eligible.find((a) => a.id === decision.agentId);
          // Retaining the receipt also requires its entire original shortlist to remain disclosable/eligible.
          if (!selected || eligible.length !== candidateIds.length)
            return output(abstain("no_candidates", "eligibility_changed"));
          return output({ ...decision, handle: selected.handle });
        } catch {
          return output(abstain("insufficient_scope", "requester_unavailable"));
        }
      }
      const query = words(String(input.query ?? ""));
      const scored = team
        .map((a) => {
          const name = new Set(words(`${a.name} ${a.handle} ${a.role}`));
          const body = new Set(words(a.instructions));
          const score = query.reduce((s, w) => s + (name.has(w) ? 3 : 0) + (body.has(w) ? 1 : 0), 0);
          return { a, score };
        })
        .filter((x) => query.length === 0 || x.score > 0)
        .sort((x, y) => y.score - x.score)
        .slice(0, 10);
      if (scored.length === 0) {
        return {
          content:
            team.length === 0
              ? "No other agent here works with this person."
              : `No agent matches that. The others: ${team.map((a) => `@${a.handle}${a.role ? ` (${a.role})` : ""}`).join(", ")}.`,
        };
      }
      const ids = scored.map((x) => x.a.id);
      const ownerIds = [...new Set(scored.map((x) => x.a.ownerUserId).filter((id): id is string => !!id))];
      const [scopes, owners, statuses] = await Promise.all([
        rosterScopeNames(db, deps.machines, ctx.orgId, ids),
        ownerIds.length
          ? db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ownerIds))
          : Promise.resolve([]),
        loadAgentStatuses(db, ctx.orgId, new Date(), ids),
      ]);
      const statusOf = new Map(statuses.map((s) => [s.agentId, s]));
      const content = scored
        .map(({ a }) => {
          const about = a.instructions.trim().replace(/\s+/g, " ");
          const owner = owners.find((o) => o.id === a.ownerUserId)?.name;
          return [
            `@${a.handle}: ${a.name}${a.role ? `, ${a.role}` : ""}${presenceNote(statusOf.get(a.id))}`,
            `  Can: ${summarizeScopes(scopes.filter((s) => s.agentId === a.id).map((s) => s.scope))}`,
            owner ? `  Responsible person: ${owner}` : "",
            about ? `  About: ${about.length > 240 ? `${cutText(about, 237)}…` : about}` : "",
          ]
            .filter(Boolean)
            .join("\n");
        })
        .join("\n");
      return { content };
    },
  };
  return {
    name: "team",
    tools: async (ctx) => inWorkspaceWords(ctx.db, ctx.orgId, [tool], FIND_AGENT_PERSONAL),
  };
}

/** "busy, on heavy work: Revisando o PR #12": what an agent is doing, its line in its own words. */
function presenceWords(s: AgentStatusView) {
  const what = {
    online: "online",
    busy: "busy, on heavy work",
    away: "away",
    out: "out of office",
    offline: "paused",
  }[s.presence];
  const line = s.status ? lineInEnglish(s.status) : null;
  return `${what}${line ? `: ${line.replace(/[()\n]/g, " ")}` : ""}`;
}

/** " (busy, on heavy work: Revisando o PR #12)" after an agent's name in `find_agent`. */
function presenceNote(s: AgentStatusView | undefined) {
  return s ? ` (${presenceWords(s)})` : "";
}

/**
 * "# Your teammates now": the live state of the agents a run's context lists ("Where you are", "# Your team"), in
 * that order: no AI yet, its computer away, paused, or else that it answers when called (busy with what, if so). Idle
 * isn't a state here: a mention or `ask_agent` wakes an idle agent at once (`find_agent` says its presence). It
 * outweighs older messages (a "no AI connected" card stays in the history after the agent gets one). Empty when none
 * of them is left.
 */
export async function teammatesNowPrompt(
  deps: Omit<AiStatusDeps, "db"> & { db: Database },
  orgId: string,
  listed: { id: string; handle: string }[],
): Promise<string> {
  const ids = listed.map((a) => a.id);
  if (ids.length === 0) return "";
  const [ai, presence, personal] = await Promise.all([
    agentAiStates(deps, orgId, ids),
    loadAgentStatuses(deps.db, orgId, new Date(), ids, {
      hasModel: (agent) => deps.gateway.hasModelCredential(agent),
    }),
    isPersonalWorkspace(deps.db, orgId),
  ]);
  const presenceOf = new Map(presence.map((s) => [s.agentId, s]));
  const lines = listed.flatMap((a) => {
    const s = presenceOf.get(a.id);
    if (!s) return [];
    const state = ai.get(a.id)?.state;
    // Out of office (ADR 0084 §12) says why and until when, so the agent asks someone else meanwhile.
    const now =
      state === "no_ai"
        ? "no AI connected yet"
        : s.presence === "out"
          ? presenceWords(s)
          : state === "waiting"
            ? "its computer is away for now"
            : s.presence === "offline"
              ? "paused"
              : s.presence === "busy"
                ? `${presenceWords(s)} (answers when called)`
                : "has an AI, answers when called";
    return [`- @${a.handle}: ${now}`];
  });
  if (lines.length === 0) return "";
  return `# ${personal ? "Your fellow agents now" : "Your teammates now"}\n${lines.join("\n")}\nThis is how they are now: it outweighs what older messages here say about them (a "no AI connected" card stays in the history after the agent gets one).`;
}

/** Consultations shown on the team screen: the last day. */
export const TEAM_CONSULTATIONS_MS = 24 * 60 * 60_000;

/**
 * The team screen: the org's agents grouped by their responsible person,
 * what each can do (stable capability keys), who is working now, and which
 * agents consulted each other in the last day. Questions and answers stay out:
 * a conversation between agents is private.
 */
export async function getTeam(db: Database, actorId: string, orgId: string) {
  const membership = await requirePermission(db, actorId, orgId, "read");
  const talks = speakerOf(membership);
  const list = await db
    .select({
      id: agents.id,
      name: agents.name,
      handle: agents.handle,
      role: agents.role,
      appearance: agents.appearance,
      ownerUserId: agents.ownerUserId,
      audienceMode: agents.audienceMode,
      audienceUserIds: agents.audienceUserIds,
      audienceRoleIds: agents.audienceRoleIds,
      consultable: agents.consultable,
      brain: agents.brain,
      reportsToAgentId: agents.reportsToAgentId,
    })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), isNull(agents.archivedAt)))
    .orderBy(asc(agents.createdAt));
  const ids = list.map((a) => a.id);
  const ownerIds = [...new Set(list.map((a) => a.ownerUserId).filter((id): id is string => !!id))];
  const since = new Date(Date.now() - TEAM_CONSULTATIONS_MS);
  const [scopes, owners, busy, consultations, seats] = ids.length
    ? await Promise.all([
        agentScopeNames(db, orgId, ids),
        ownerIds.length
          ? db
              .select({ id: users.id, name: users.name, image: users.image })
              .from(users)
              .where(inArray(users.id, ownerIds))
          : Promise.resolve([]),
        db
          .selectDistinct({ agentId: agentRuns.agentId })
          .from(agentRuns)
          .where(
            and(
              eq(agentRuns.orgId, orgId),
              inArray(agentRuns.agentId, ids),
              inArray(agentRuns.status, ["running", "waiting_approval", "waiting_input"]),
            ),
          ),
        db
          .select({
            id: agentConsultations.id,
            askerAgentId: agentConsultations.askerAgentId,
            targetAgentId: agentConsultations.targetAgentId,
            status: agentConsultations.status,
            createdAt: agentConsultations.createdAt,
          })
          .from(agentConsultations)
          .where(and(eq(agentConsultations.orgId, orgId), gte(agentConsultations.createdAt, since)))
          .orderBy(desc(agentConsultations.createdAt))
          .limit(50),
        // The channels each agent is in, among those the viewer may see: listChannels' rule.
        db
          .select({ agentId: channelMembers.agentId, channelId: channels.id })
          .from(channelMembers)
          .innerJoin(channels, eq(channels.id, channelMembers.channelId))
          .where(
            and(
              eq(channels.orgId, orgId),
              inArray(channelMembers.agentId, ids),
              eq(channels.kind, "channel"),
              isNull(channels.archivedAt),
              isNull(channels.deletedAt),
              sql`(${channels.visibility} = 'public' or exists (select 1 from ${channelMembers} me where me.channel_id = ${channels.id} and me.user_id = ${actorId}) or ${channelAudienceSql("channels", sql`${actorId}`)} or ${maySql(sql`${orgId}::uuid`, sql`${actorId}::text`, "administrator")})`,
            ),
          )
          .orderBy(asc(channels.position), asc(channels.name)),
      ])
    : [[], [], [], [], []];
  const busyIds = new Set(busy.map((r) => r.agentId));
  const active = new Set(ids);
  return {
    agents: list.map((a) => {
      const seesDetails = seesAgentDetails(a, actorId, membership);
      return {
        id: a.id,
        name: a.name,
        handle: a.handle,
        role: a.role,
        appearance: (a.appearance ?? null) as AgentAppearance | null,
        ownerUserId: a.ownerUserId,
        reportsToAgentId: a.reportsToAgentId,
        capabilities: seesDetails ? capabilityKeys(scopes.filter((s) => s.agentId === a.id).map((s) => s.scope)) : [],
        busy: busyIds.has(a.id),
        channelIds: seats.filter((r) => r.agentId === a.id).map((r) => r.channelId),
        canTalk: canTalkTo(a, actorId, talks),
        seesDetails,
      };
    }),
    people: owners.map((o) => ({ id: o.id, name: o.name, image: o.image ?? null })),
    // Only between agents still here (an archived one has no place in the sky).
    consultations: consultations.filter((c) => active.has(c.askerAgentId) && active.has(c.targetAgentId)),
  };
}
