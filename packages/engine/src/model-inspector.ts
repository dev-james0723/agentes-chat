import type { PubSub } from "@agenteschat/adapters";
import {
  and,
  asc,
  type Database,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  ne,
  notInArray,
  rowsOf,
  schema,
  sql,
} from "@agenteschat/db";
import type { Agent } from "./agents";
import { recordAudit } from "./audit";
import { handoffModel } from "./auto-model";
import { setAgentBrain } from "./brain-settings";
import {
  brainAccountFor,
  computerBrainUnavailable,
  durableGrokRefusal,
  planIsOwners,
  quotaReserveOf,
  storedPlanLimit,
  storedPlanUsage,
} from "./brains/select";
import type { BrainKind } from "./brains/types";
import { caches } from "./cache";
import { publishAgentsChanged } from "./events";
import type { Judge } from "./judge";
import { refreshAiAccounts } from "./machine-accounts";
import type { MachineCaller, MachineStatus } from "./machine-hub";
import { publishMachineAgentsChanged } from "./machines";
import { type ModelInspectorWorkObservation, observeModelInspectorWork } from "./model-inspector-observations";
import { chooseModelInspectorRoute, type ModelInspectorCandidate } from "./model-inspector-routing";
import { agentUsageFor } from "./plan-usage";
import { createQuotaCliQualifier, hasCredentialText } from "./quota-qualifier";
import { personalBrain, thinkingAgent } from "./right-hand";

type RouteKind = ModelInspectorCandidate["kind"];
const ROUTES: readonly RouteKind[] = ["claude_code", "codex", "grok"];
const TERMINAL_RUNS = ["done", "failed", "canceled"] as const;
const TERMINAL_MISSIONS = ["done", "canceled"] as const;
const SWITCH_ACTION = "model_inspector.switch";
const SWEEP_MS = 60_000;
const PERSONAL = Symbol("model-inspector-personal-route");
type InspectionAgent = Agent & {
  [PERSONAL]?: {
    userId: string;
    globalFingerprint: string;
    bindingFingerprint: string;
    hasBinding: boolean;
  };
};

export interface ModelInspectorDeps {
  db: Database;
  pubsub: PubSub;
  machines: Pick<MachineCaller, "call" | "status">;
  orgIds: readonly string[];
  models: Record<RouteKind, string>;
  targets?: readonly RouteKind[];
  judge?: Judge;
  thresholdPercent?: number;
  maxAgeMs?: number;
  cooldownMs?: number;
  maxSwitches?: number;
  now?: () => Date;
}

export interface ModelInspectorAgentReport {
  id: string;
  name: string;
  brain: string;
  model: string | null;
  state: "healthy" | "near_limit" | "exhausted" | "unknown" | "unavailable" | "api_budget";
  usedPercent: number | null;
  observedAt: string | null;
  resetsAt: string | null;
  pool: string | null;
  activeRunIds: string[];
  activeMissionIds: string[];
  activeTaskIds: string[];
  /** Actual work routes are separate from this row's configured default brain/model and quota. */
  activeWork: ModelInspectorWorkObservation[];
  routineIds: string[];
  decision: "kept" | "switched" | "boundary" | "blocked" | "cooldown" | "deferred";
  reason: string;
  target?: { kind: RouteKind; model: string; quotaState: "normal" | "unknown"; usedPercent: number | null };
  lastSwitchAt?: string;
  cooldownUntil?: string;
  apiBudgetPercent?: number;
  /** A right hand is inspected for its configured owner's private route, never another member's. */
  scope?: "owner_personal";
}

export interface ModelInspectorReport {
  orgId: string;
  checkedAt: string;
  /** A snapshot only reads stored state; it never claims that routing or a probe completed. */
  mode: "sweep" | "snapshot";
  lastSweepAt: string | null;
  stale: boolean;
  policy: { thresholdPercent: number; maxAgeMs: number; cooldownMs: number; maxSwitches: number; intervalMs: number };
  agents: ModelInspectorAgentReport[];
  counts: { inspected: number; switched: number; boundary: number; blocked: number; unknown: number };
}

type Snapshot = Awaited<ReturnType<typeof loadFleet>>;
const routeKind = (kind: string): kind is RouteKind => ROUTES.includes(kind as RouteKind);
const poolKey = (kind: string, machineId: string, accountId: string | null) =>
  `${kind}:${machineId}:${accountId ?? "own"}`;
const clamp = (n: number | undefined, fallback: number, low: number, high: number) =>
  Number.isFinite(n) ? Math.max(low, Math.min(high, n as number)) : fallback;

/** Read the entire enabled fleet, including queued/waiting work and scheduled or event routines. */
async function loadFleet(db: Database, orgId: string) {
  const [agents, runs, missions, routines, tasks] = await Promise.all([
    db
      .select()
      .from(schema.agents)
      .where(and(eq(schema.agents.orgId, orgId), isNull(schema.agents.deletedAt), isNull(schema.agents.archivedAt)))
      .orderBy(asc(schema.agents.createdAt), asc(schema.agents.id)),
    db
      .select({ id: schema.agentRuns.id, agentId: schema.agentRuns.agentId })
      .from(schema.agentRuns)
      .where(and(eq(schema.agentRuns.orgId, orgId), notInArray(schema.agentRuns.status, [...TERMINAL_RUNS]))),
    db
      .select({ id: schema.missions.id, agentId: schema.missions.agentId })
      .from(schema.missions)
      .where(and(eq(schema.missions.orgId, orgId), notInArray(schema.missions.status, [...TERMINAL_MISSIONS]))),
    db
      .select({
        id: schema.routines.id,
        agentId: schema.routines.agentId,
        prompt: schema.routines.prompt,
        createdByUserId: schema.routines.createdByUserId,
      })
      .from(schema.routines)
      .where(
        and(eq(schema.routines.orgId, orgId), eq(schema.routines.active, true), isNull(schema.routines.deletedAt)),
      ),
    db
      .select({ id: schema.machineTasks.id, agentId: schema.machineTasks.agentId })
      .from(schema.machineTasks)
      .where(
        and(
          eq(schema.machineTasks.orgId, orgId),
          isNull(schema.machineTasks.endedAt),
          inArray(schema.machineTasks.status, ["queued", "running", "interrupted"]),
          ne(schema.machineTasks.executor, "shell"),
        ),
      ),
  ]);
  return { agents, runs, missions, routines, tasks };
}

// Include authority and role changes, not only the route. A judgment for an older role may not change the new one.
function fingerprint(agent: Agent) {
  return JSON.stringify([
    agent.updatedAt,
    agent.brain,
    agent.brainModel,
    agent.brainAccountId,
    agent.brainAccountLentBy,
    agent.machineId,
    agent.ownerUserId,
    agent.instructions,
    agent.role,
    agent.brainExtraUsage,
    agent.brainFallback,
    agent.brainEffort,
    agent.brainSpeed,
    agent.contextTokens,
    agent.audienceMode,
    agent.audienceUserIds,
    agent.audienceRoleIds,
  ]);
}

function authority(agent: Agent) {
  return JSON.stringify([
    agent.ownerUserId,
    agent.machineId,
    agent.audienceMode,
    agent.audienceUserIds,
    agent.audienceRoleIds,
    agent.planForOthers,
  ]);
}

/**
 * A deterministic fleet monitor. It spends no model tokens to poll; JEV is called only for a real proposed route.
 * Running work owns its transcript and switches at the executor's verified boundary. This service only changes
 * idle defaults through the normal settings API, after a fresh quota/authority check under the agent's row lock.
 */
export function createModelInspector(deps: ModelInspectorDeps) {
  const orgIds = [...new Set(deps.orgIds.filter(Boolean))];
  const enabled = (orgId: string) => orgIds.includes(orgId);
  const now = deps.now ?? (() => new Date());
  const policy = {
    thresholdPercent: clamp(deps.thresholdPercent, 95, 1, 100),
    maxAgeMs: clamp(deps.maxAgeMs, 300_000, 1000, 3_600_000),
    cooldownMs: clamp(deps.cooldownMs, 900_000, 0, 86_400_000),
    maxSwitches: Math.floor(clamp(deps.maxSwitches, 4, 1, 50)),
    intervalMs: SWEEP_MS,
  };
  const latest = new Map<string, ModelInspectorReport>();
  const refreshed = new Map<string, number>();
  let sweeping: Promise<ModelInspectorReport[]> | undefined;
  const targets = [...new Set(deps.targets ?? ROUTES)].filter(routeKind);
  const qualifier = createQuotaCliQualifier({
    db: deps.db,
    machines: deps.machines,
    models: deps.models,
    targets,
    now: () => now().getTime(),
  });

  async function forInspection(db: Database, stored: Agent): Promise<InspectionAgent> {
    if (stored.builtin !== "right_hand" || !stored.ownerUserId) return stored;
    const binding = await personalBrain(db, stored.orgId, stored.ownerUserId);
    const effective = await thinkingAgent(db, stored, stored.ownerUserId);
    return {
      ...effective,
      [PERSONAL]: {
        userId: stored.ownerUserId,
        globalFingerprint: fingerprint(stored),
        bindingFingerprint: JSON.stringify(binding),
        hasBinding: binding !== null,
      },
    };
  }

  async function readQuota(
    db: Database,
    agent: Agent,
    kind = agent.brain as BrainKind,
    model = agent.brainModel ?? undefined,
  ) {
    const usage = agent.machineId
      ? await storedPlanUsage(db, agent.orgId, agent.machineId, kind, agent.brainAccountId ?? undefined)
      : null;
    const reserve = quotaReserveOf(
      usage,
      { machineId: agent.machineId, kind, accountId: agent.brainAccountId },
      { now: now().getTime(), thresholdPercent: policy.thresholdPercent, maxAgeMs: policy.maxAgeMs, model },
    );
    const at = usage ? Date.parse(usage.at) : Number.NaN;
    const fresh = Number.isFinite(at) && at <= now().getTime() && now().getTime() - at <= policy.maxAgeMs;
    const exhausted =
      (kind === "grok" && durableGrokRefusal(usage, now().getTime())) ||
      (fresh && !!storedPlanLimit(usage, now().getTime(), kind === "claude_code" ? (model ?? "sonnet") : undefined));
    return { usage, reserve, exhausted };
  }

  async function refresh(fleet: Snapshot, orgId: string) {
    // The runner also deduplicates free usage probes. This does not run a paid completion to discover a quota.
    const owners = [
      ...new Set(
        fleet.agents
          .filter((a) => a.machineId || a.builtin === "right_hand")
          .map((a) => a.ownerUserId)
          .filter((id): id is string => !!id),
      ),
    ];
    await Promise.allSettled(
      owners.map(async (owner) => {
        const key = `${orgId}:${owner}`;
        if (now().getTime() - (refreshed.get(key) ?? 0) < policy.maxAgeMs) return;
        const controller = new AbortController();
        let accepted = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const hub: ModelInspectorDeps["machines"] = {
          status: (id) => deps.machines.status(id),
          async call(id, request) {
            const reply = await deps.machines.call(id, request, { timeoutMs: 8000, signal: controller.signal });
            accepted = true;
            return reply;
          },
        };
        try {
          await Promise.race([
            refreshAiAccounts({ db: deps.db, hub, pubsub: deps.pubsub }, owner, orgId),
            new Promise<void>((resolve) => {
              timer = setTimeout(() => {
                controller.abort();
                resolve();
              }, 8000);
            }),
          ]);
          if (accepted) refreshed.set(key, now().getTime());
        } finally {
          clearTimeout(timer);
        }
      }),
    );
  }

  async function inspect(
    fleet: Snapshot,
    agent: InspectionAgent,
    work: ModelInspectorWorkObservation[],
  ): Promise<ModelInspectorAgentReport> {
    const { reserve, usage, exhausted } = await readQuota(deps.db, agent);
    const result: ModelInspectorAgentReport = {
      id: agent.id,
      name: agent.name,
      brain: agent.brain,
      model: agent.brainModel,
      state: exhausted
        ? "exhausted"
        : reserve.state === "normal"
          ? "healthy"
          : reserve.state === "low"
            ? "near_limit"
            : "unknown",
      usedPercent: reserve.usedPercent ?? null,
      observedAt: reserve.observedAt ?? usage?.at ?? null,
      resetsAt: reserve.resetsAt ?? null,
      pool: agent.machineId ? poolKey(agent.brain, agent.machineId, agent.brainAccountId) : null,
      activeRunIds: fleet.runs.filter((r) => r.agentId === agent.id).map((r) => r.id),
      activeMissionIds: fleet.missions.filter((m) => m.agentId === agent.id).map((m) => m.id),
      activeTaskIds: fleet.tasks.filter((t) => t.agentId === agent.id).map((t) => t.id),
      activeWork: work.filter((w) => w.agentId === agent.id),
      routineIds: fleet.routines
        .filter((r) => r.agentId === agent.id && (!agent[PERSONAL] || r.createdByUserId === agent[PERSONAL]?.userId))
        .map((r) => r.id),
      decision: "kept",
      reason:
        reserve.state === "unknown"
          ? "No fresh applicable allowance reading; unknown is not remaining capacity."
          : "The current subscription has room.",
    };
    if (agent.builtin === "right_hand") {
      result.scope = "owner_personal";
      const personal = agent[PERSONAL];
      if (!personal?.hasBinding || !agent.machineId || agent.ownerUserId !== personal.userId) {
        result.decision = "blocked";
        result.reason =
          "The right hand has no available owner-specific subscription route; other members' choices and the workspace default are retained.";
      }
    }
    if (agent.brain === "model") {
      const api = (await agentUsageFor(deps.db, null, agent.orgId, agent.id, now())).api;
      result.state = "api_budget";
      if (api) result.apiBudgetPercent = api.budgetPercent;
      result.reason =
        "API budget is inspected separately from subscription allowance; existing API budget controls remain in force.";
    } else if (!routeKind(agent.brain)) {
      result.reason =
        "This adapter is inspected, but automatic subscription handoff currently supports Claude Code, Codex and Grok.";
    } else if (result.decision !== "blocked" && (reserve.state === "low" || exhausted)) {
      result.reason =
        agent.brain === "grok" && durableGrokRefusal(usage, now().getTime())
          ? "Grok explicitly refused the account's usage balance; remaining allowance and reset time are unknown."
          : "The current subscription reached the configured switch threshold.";
    }
    const [last] = await deps.db
      .select({ createdAt: schema.auditLog.createdAt, details: schema.auditLog.details })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.orgId, agent.orgId),
          inArray(schema.auditLog.action, [SWITCH_ACTION, "model_inspector.handoff"]),
          eq(schema.auditLog.targetId, agent.id),
          ...(agent[PERSONAL] ? [sql`${schema.auditLog.details}->>'personalUserId' = ${agent[PERSONAL]?.userId}`] : []),
        ),
      )
      .orderBy(desc(schema.auditLog.createdAt))
      .limit(1);
    if (last) {
      result.lastSwitchAt = last.createdAt.toISOString();
      const to = last.details.to as { kind?: string; accountId?: string | null } | undefined;
      // A run handoff does not change idle defaults. Only leaving the recently selected route is cooling down.
      if (to?.kind === agent.brain && (to.accountId ?? null) === agent.brainAccountId) {
        result.cooldownUntil = new Date(last.createdAt.getTime() + policy.cooldownMs).toISOString();
      }
    }
    return result;
  }

  async function admit(
    db: Database,
    agent: Agent,
    candidate: ModelInspectorCandidate,
    observedStatus?: MachineStatus | null,
  ) {
    const next = {
      ...agent,
      brain: candidate.kind,
      brainModel: candidate.model,
      brainAccountId: candidate.accountId,
      brainAccountLentBy: null,
    };
    const status =
      observedStatus === undefined ? await deps.machines.status(candidate.machineId).catch(() => null) : observedStatus;
    if (!status || status.id !== agent.machineId || (status.orgId && status.orgId !== agent.orgId)) return null;
    const [computer] = await db
      .select({ executors: schema.machines.executors })
      .from(schema.machines)
      .where(
        and(
          eq(schema.machines.orgId, agent.orgId),
          eq(schema.machines.id, candidate.machineId),
          isNull(schema.machines.deletedAt),
        ),
      );
    if (!computer) return null;
    // A quota reading can outlive an authentication change. Repeat subscription evidence at each admission,
    // including the transaction, so a newly configured API key cannot silently replace the qualified login.
    if (candidate.accountId) {
      const [login] = await db
        .select({
          authMethod: schema.machineAccounts.authMethod,
          keyHint: schema.machineAccounts.keyHint,
          provider: schema.machineAccounts.provider,
          kind: schema.machineAccounts.kind,
          status: schema.machineAccounts.status,
        })
        .from(schema.machineAccounts)
        .where(
          and(
            eq(schema.machineAccounts.orgId, agent.orgId),
            eq(schema.machineAccounts.id, candidate.accountId),
            eq(schema.machineAccounts.machineId, candidate.machineId),
          ),
        );
      if (
        !login ||
        login.kind !== candidate.kind ||
        login.status !== "active" ||
        login.authMethod !== "cli_login" ||
        login.keyHint !== null ||
        login.provider !== null
      )
        return null;
    } else if (candidate.kind === "claude_code") {
      if (computer.executors.claude?.loggedIn !== true || computer.executors.claude.authMethod !== "claude.ai")
        return null;
    } else if (candidate.kind === "codex") {
      if (!computer.executors.codex || !computer.executors.ownUsage?.codex?.windows.length) return null;
    } else return null;
    const models = candidate.kind === "grok" ? computer.executors.grok?.models : undefined;
    if (models && !models.some((model) => model.id === candidate.model)) return null;
    const account = await brainAccountFor(db, next, candidate.kind, candidate.machineId);
    if (candidate.accountId && !account) return null;
    const owned = await planIsOwners(db, next, candidate.machineId, account);
    const { usage, reserve } = await readQuota(db, next, candidate.kind, candidate.model);
    if (
      computerBrainUnavailable(
        candidate.kind,
        candidate.machineId,
        status,
        now().getTime(),
        account,
        owned,
        usage,
        candidate.model,
      )
    )
      return null;
    if (reserve.state === "low") return null;
    // Only Grok currently lacks a reliable headless allowance feed. Stale Claude/Codex evidence cannot admit a move.
    if (reserve.state === "unknown" && candidate.kind !== "grok") return null;
    return {
      ...candidate,
      usedPercent: reserve.usedPercent ?? null,
      quotaState: reserve.state === "normal" ? ("normal" as const) : ("unknown" as const),
    };
  }

  async function candidates(
    fleet: Snapshot,
    agent: Agent,
    work: ModelInspectorWorkObservation[],
  ): Promise<ModelInspectorCandidate[]> {
    if (!agent.machineId || !routeKind(agent.brain)) return [];
    const out: ModelInspectorCandidate[] = [];
    for (const kind of targets) {
      const qualified = await qualifier.qualify({
        orgId: agent.orgId,
        agentId: agent.id,
        runId: "model-inspector",
        channelId: "model-inspector",
        goalMessageId: "model-inspector",
        machineId: agent.machineId,
        sourceKind: agent.brain,
        sourceAccountId: agent.brainAccountId,
        targetKind: kind,
        requiredTools: [],
        context: { system: [], messages: [] },
      });
      if (!qualified) continue;
      const accountId = qualified.accountId ?? null;
      const assigned = fleet.agents.filter(
        (a) => a.brain === kind && a.machineId === qualified.machineId && a.brainAccountId === accountId,
      );
      const active = work.filter((w) => w.type !== "mission");
      const busy = new Set(active.map((w) => w.agentId));
      const onPool = active.filter(
        (w) => w.kind === kind && w.machineId === qualified.machineId && w.accountId === accountId,
      );
      const candidate: ModelInspectorCandidate = {
        id: `${kind}:${accountId ?? "own"}`,
        kind,
        model: qualified.model,
        accountId,
        machineId: qualified.machineId,
        pool: qualified.targetPool,
        usedPercent: null,
        quotaState: "unknown",
        pressure: assigned.filter((a) => !busy.has(a.id)).length + new Set(onPool.map((w) => w.id)).size,
      };
      const allowed = await admit(deps.db, agent, candidate);
      if (allowed) out.push(allowed);
    }
    return out;
  }

  async function changeIdle(
    fleet: Snapshot,
    agent: InspectionAgent,
    row: ModelInspectorAgentReport,
    work: ModelInspectorWorkObservation[],
  ): Promise<boolean> {
    const personal = agent[PERSONAL];
    if (agent.builtin === "right_hand" && row.decision === "blocked") return false;
    if (
      row.activeWork.some(
        (work) =>
          work.type !== "task" && routeKind(work.kind) && (work.state === "near_limit" || work.state === "exhausted"),
      )
    ) {
      row.decision = "boundary";
      row.reason =
        "An actual active run or mission route reached the threshold; its main executor will switch at a completed boundary. Already launched native child tasks keep their own harness and receipts.";
      return false;
    }
    if (row.activeTaskIds.length) {
      row.decision = "deferred";
      row.reason =
        "Native child work is still live or awaiting a safe resume. Only new or provably unstarted children can change harness; launched work is never replayed to force a switch.";
      return false;
    }
    if (!routeKind(agent.brain) || (row.state !== "near_limit" && row.state !== "exhausted")) return false;
    if (row.activeRunIds.length || row.activeMissionIds.length) {
      const allHealthy = row.activeWork.length > 0 && row.activeWork.every((work) => work.state === "healthy");
      row.decision = allHealthy ? "deferred" : "boundary";
      row.reason = allHealthy
        ? "Active work already uses routes with room; the depleted default will be updated once the agent is idle."
        : "Active work checks fresh usage and changes model at its next safe executor boundary; its session and transcript stay owned by that work.";
      return false;
    }
    if (!agent.ownerUserId || (agent.builtin && !personal) || agent.brainAccountLentBy) {
      row.decision = "blocked";
      row.reason =
        "This agent requires its existing personal or lent-plan authority; no automatic permission change is allowed.";
      return false;
    }
    if (row.state !== "exhausted" && row.cooldownUntil && now().getTime() < Date.parse(row.cooldownUntil)) {
      row.decision = "cooldown";
      row.reason = "A recent route change is cooling down; verified exhaustion can override the cooldown.";
      return false;
    }
    const task =
      fleet.routines
        .filter((r) => row.routineIds.includes(r.id))
        .map((r) => r.prompt)
        .join("\n")
        .slice(0, 3000) || "Prepare the most appropriate available model for this idle agent's next task.";
    if (hasCredentialText(`${agent.role}\n${agent.instructions}\n${task}`)) {
      row.decision = "blocked";
      row.reason = "The task context contains credential-like text and cannot be transferred to another provider.";
      return false;
    }
    const routes = await candidates(fleet, agent, work);
    const choice = await chooseModelInspectorRoute(deps.judge, {
      orgId: agent.orgId,
      agentId: agent.id,
      role: agent.role,
      instructions: agent.instructions,
      task,
      mission: false,
      routine: row.routineIds.length > 0,
      tools: ["computer"],
      candidates: routes,
      thresholdPercent: policy.thresholdPercent,
    });
    if (!choice) {
      row.decision = "blocked";
      row.reason = "No available subscription route passed quota, login and ownership checks.";
      return false;
    }
    // Revalidate the concrete model. A depleted model-specific window need not hide the same route's healthy
    // configured model; if the whole preferred route changed, bounded fallback tries other qualified routes.
    const rest = routes
      .filter((c) => c.id !== choice.candidate.id)
      .sort(
        (a, b) =>
          Number(b.quotaState === "normal") - Number(a.quotaState === "normal") ||
          (a.usedPercent ?? 0) + a.pressure * 2 - ((b.usedPercent ?? 0) + b.pressure * 2),
      );
    let validated: ModelInspectorCandidate | null = null;
    let reason = choice.reason;
    let selection = choice.source;
    for (const candidate of [choice.candidate, ...rest]) {
      const mapped = handoffModel(candidate.kind, candidate.model, choice.tier);
      for (const model of [...new Set([mapped, candidate.model])]) {
        validated = await admit(deps.db, agent, { ...candidate, model });
        if (validated) {
          if (candidate.id !== choice.candidate.id || model !== mapped) {
            selection = "fallback";
            reason = `The preferred concrete model failed fresh admission; use qualified ${candidate.kind}/${model}, ${validated.quotaState === "normal" ? `${validated.usedPercent}% used` : "quota unknown"}.`;
          }
          break;
        }
      }
      if (validated) break;
    }
    if (!validated) {
      row.decision = "blocked";
      row.reason = "The selected model no longer passes admission; the existing configuration is retained.";
      return false;
    }
    const selected = validated;
    if (agent.brainEffort && agent.brainEffort !== "auto" && agent.brainEffort !== choice.effort) {
      reason += ` The agent's explicit ${agent.brainEffort} effort is retained.`;
    }
    row.target = {
      kind: selected.kind,
      model: selected.model,
      quotaState: selected.quotaState,
      usedPercent: selected.usedPercent,
    };
    // status() may read through the global DB pool. Capture it before the row-lock transaction to avoid acquiring
    // another connection from inside a single-connection database; usage and authority are still read in tx.
    const targetStatus = await deps.machines.status(selected.machineId).catch(() => null);
    const changed = await deps.db.transaction(async (tx) => {
      const db = tx as unknown as Database;
      // Serialize commits, not JEV calls. CAS makes duplicate inspections harmless; the audit count limits changes
      // across replicas, not just inside this worker's memory.
      const [lock] = rowsOf<{ ok: boolean }>(
        await tx.execute(
          sql`select pg_try_advisory_xact_lock(hashtextextended(${`model-inspector:${agent.orgId}`}, 0)) as ok`,
        ),
      );
      if (lock?.ok === false) {
        row.reason = "Another inspection is committing a change; retry on the next sweep.";
        return false;
      }
      const recent = await tx
        .select({ id: schema.auditLog.id })
        .from(schema.auditLog)
        .where(
          and(
            eq(schema.auditLog.orgId, agent.orgId),
            eq(schema.auditLog.action, SWITCH_ACTION),
            gte(schema.auditLog.createdAt, new Date(now().getTime() - SWEEP_MS)),
          ),
        )
        .limit(policy.maxSwitches);
      if (recent.length >= policy.maxSwitches) {
        row.reason = "This sweep's migration allowance is used; another batch follows on the next sweep.";
        return false;
      }
      const [stored] = await tx
        .select()
        .from(schema.agents)
        .where(
          and(
            eq(schema.agents.orgId, agent.orgId),
            eq(schema.agents.id, agent.id),
            isNull(schema.agents.deletedAt),
            isNull(schema.agents.archivedAt),
          ),
        )
        .for("update");
      if (!stored?.ownerUserId || fingerprint(stored) !== (personal?.globalFingerprint ?? fingerprint(agent))) {
        row.reason = "The agent changed after inspection; its newer settings take priority.";
        return false;
      }
      if (personal) {
        const [binding] = await tx
          .select()
          .from(schema.rightHandBrains)
          .where(and(eq(schema.rightHandBrains.orgId, agent.orgId), eq(schema.rightHandBrains.userId, personal.userId)))
          .for("update");
        if (!binding || JSON.stringify(binding) !== personal.bindingFingerprint) {
          row.reason = "The owner's personal route changed after inspection; the newer choice takes priority.";
          return false;
        }
      }
      const current = personal ? await thinkingAgent(db, stored, personal.userId) : stored;
      if (fingerprint(current) !== fingerprint(agent)) {
        row.reason = "The effective subscription authority changed after inspection; inspect it again.";
        return false;
      }
      const active = await loadFleet(db, agent.orgId);
      if (active.tasks.some((t) => t.agentId === agent.id)) {
        row.reason = "Native child work started during inspection; its settings and effects are retained.";
        return false;
      }
      if (active.runs.some((r) => r.agentId === agent.id) || active.missions.some((m) => m.agentId === agent.id)) {
        row.reason = "Work started during inspection; its executor will switch at a safe boundary.";
        row.decision = "boundary";
        return false;
      }
      const fresh = await readQuota(db, current);
      if (fresh.reserve.state !== "low" && !fresh.exhausted) {
        row.reason = "The source usage reading changed; inspect again before changing it.";
        return false;
      }
      const target = await admit(db, current, selected, targetStatus);
      if (!target) {
        row.reason = "The target's current usage or authority no longer admits the switch.";
        return false;
      }
      await setAgentBrain(
        { db },
        current.ownerUserId,
        current.orgId,
        current.id,
        {
          ...(personal ? { scope: "mine", machineId: target.accountId === null ? target.machineId : undefined } : {}),
          brain: target.kind,
          model: current.brainModel === "auto" ? "auto" : target.model,
          account: target.accountId,
          effort: current.brainEffort ?? choice.effort,
          extraUsage: false,
          fallback: current.brainFallback,
        },
        { remember: false, audit: { source: "model-inspector", reason } },
      );
      const [savedRecord] = await tx
        .select()
        .from(schema.agents)
        .where(and(eq(schema.agents.orgId, agent.orgId), eq(schema.agents.id, agent.id)));
      if (
        !savedRecord ||
        authority(savedRecord) !== authority(stored) ||
        (personal && fingerprint(savedRecord) !== fingerprint(stored))
      ) {
        throw new Error("model_inspector.authority_changed");
      }
      const saved = personal ? await thinkingAgent(db, savedRecord, personal.userId) : savedRecord;
      if (
        personal &&
        (saved.ownerUserId !== personal.userId ||
          saved.machineId !== target.machineId ||
          saved.brain !== target.kind ||
          saved.brainAccountId !== target.accountId ||
          saved.brainFallback !== current.brainFallback ||
          saved.brainExtraUsage !== current.brainExtraUsage)
      ) {
        throw new Error("model_inspector.personal_route_changed");
      }
      await recordAudit(tx, {
        orgId: agent.orgId,
        actor: { type: "system", id: null },
        action: SWITCH_ACTION,
        target: { type: "agent", id: agent.id },
        details: {
          ...(personal ? { scope: "owner_personal", personalUserId: personal.userId } : {}),
          from: {
            kind: current.brain,
            model: current.brainModel,
            accountId: current.brainAccountId,
            usedPercent: fresh.reserve.usedPercent,
            observedAt: fresh.reserve.observedAt,
          },
          to: {
            kind: target.kind,
            model: saved.brainModel,
            accountId: target.accountId,
            usedPercent: target.usedPercent,
            quotaState: target.quotaState,
          },
          selection,
          tier: choice.tier,
          effort: saved.brainEffort,
          judgedEffort: choice.effort,
          reason,
          routineIds: row.routineIds,
        },
      });
      Object.assign(agent, saved);
      return true;
    });
    if (changed) {
      caches.agents.delete(`${agent.orgId}:${agent.id}`);
      caches.agents.delete(`${agent.orgId}:team`);
      row.decision = "switched";
      row.reason = reason;
      row.lastSwitchAt = now().toISOString();
    } else if (row.decision !== "boundary") row.decision = "deferred";
    return changed;
  }

  function finish(
    orgId: string,
    agents: ModelInspectorAgentReport[],
    mode: "sweep" | "snapshot",
  ): ModelInspectorReport {
    return {
      orgId,
      checkedAt: now().toISOString(),
      mode,
      lastSweepAt: mode === "sweep" ? now().toISOString() : (latest.get(orgId)?.lastSweepAt ?? null),
      stale: mode === "snapshot",
      policy,
      agents,
      counts: {
        inspected: agents.length,
        switched: agents.filter((a) => a.decision === "switched").length,
        boundary: agents.filter((a) => a.decision === "boundary").length,
        blocked: agents.filter((a) => a.decision === "blocked").length,
        unknown: agents.filter((a) => a.state === "unknown").length,
      },
    };
  }

  async function runSweep() {
    const reports: ModelInspectorReport[] = [];
    for (const orgId of orgIds) {
      let fleet = await loadFleet(deps.db, orgId);
      await refresh(fleet, orgId);
      fleet = await loadFleet(deps.db, orgId);
      const work = await observeModelInspectorWork({
        db: deps.db,
        orgId,
        now: now().getTime(),
        thresholdPercent: policy.thresholdPercent,
        maxAgeMs: policy.maxAgeMs,
      });
      const agents: ModelInspectorAgentReport[] = [];
      let changed = 0;
      for (const stored of fleet.agents) {
        const agent = await forInspection(deps.db, stored);
        const row = await inspect(fleet, agent, work);
        try {
          if (
            changed < policy.maxSwitches ||
            row.activeRunIds.length ||
            row.activeMissionIds.length ||
            row.activeTaskIds.length
          ) {
            if (await changeIdle(fleet, agent, row, work)) changed++;
          } else if (row.state === "near_limit" || row.state === "exhausted") {
            row.decision = "deferred";
            row.reason = "A later sweep will move this idle agent; migrations are staggered across the team.";
          }
        } catch {
          row.decision = "blocked";
          row.reason =
            "The normal settings or permission checks refused the proposed change; its configuration was retained.";
        }
        agents.push(row);
      }
      const report = finish(orgId, agents, "sweep");
      latest.set(orgId, report);
      reports.push(report);
      if (changed)
        await Promise.all([publishAgentsChanged(deps.pubsub, orgId), publishMachineAgentsChanged(deps.pubsub, orgId)]);
    }
    return reports;
  }

  return {
    enabled,
    sweep(): Promise<ModelInspectorReport[]> {
      if (!sweeping)
        sweeping = runSweep().finally(() => {
          sweeping = undefined;
        });
      return sweeping;
    },
    async report(orgId: string): Promise<ModelInspectorReport | null> {
      if (!enabled(orgId)) return null;
      const last = latest.get(orgId);
      if (last && now().getTime() - Date.parse(last.checkedAt) <= SWEEP_MS) return last;
      const fleet = await loadFleet(deps.db, orgId);
      const work = await observeModelInspectorWork({
        db: deps.db,
        orgId,
        now: now().getTime(),
        thresholdPercent: policy.thresholdPercent,
        maxAgeMs: policy.maxAgeMs,
      });
      return finish(
        orgId,
        await Promise.all(fleet.agents.map(async (a) => inspect(fleet, await forInspection(deps.db, a), work))),
        "snapshot",
      );
    },
  };
}
