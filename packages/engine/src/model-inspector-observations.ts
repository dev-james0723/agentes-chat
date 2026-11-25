import type { PlanUsage } from "@agenteschat/adapters";
import { and, asc, type Database, desc, eq, inArray, isNull, ne, notInArray, schema, sql } from "@agenteschat/db";
import { isAutoModel } from "@agenteschat/providers";
import { brainModelFor, durableGrokRefusal, quotaReserveOf, storedPlanLimit } from "./brains/select";
import { type BrainKind, isComputerBrain } from "./brains/types";
import { missionBrain } from "./missions-engine";

export interface ModelInspectorWorkObservation {
  agentId: string;
  id: string;
  type: "run" | "mission" | "task";
  kind: string;
  model: string | null;
  machineId: string | null;
  accountId: string | null;
  state: "healthy" | "near_limit" | "exhausted" | "unknown";
  usedPercent: number | null;
  observedAt: string | null;
}

type Route = Pick<ModelInspectorWorkObservation, "kind" | "model" | "machineId" | "accountId"> & { resolved: boolean };
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const concreteModel = (value: string | null | undefined) => (value && !isAutoModel(value) ? value : null);
const unknownRoute = (kind: string | null = null): Route => ({
  kind: kind ?? "unknown",
  model: null,
  machineId: null,
  accountId: null,
  resolved: false,
});

/**
 * Read persisted work routes, not an agent's possibly different default. This never resolves or starts a session,
 * probes a runner, or changes work. A route whose session/account binding cannot be established stays unknown.
 */
export async function observeModelInspectorWork(input: {
  db: Database;
  orgId: string;
  now: number;
  thresholdPercent: number;
  maxAgeMs: number;
}): Promise<ModelInspectorWorkObservation[]> {
  const { db, orgId, now, thresholdPercent, maxAgeMs } = input;
  const [agents, runs, missions, machines, accounts, tasks] = await Promise.all([
    db
      .select()
      .from(schema.agents)
      .where(and(eq(schema.agents.orgId, orgId), isNull(schema.agents.deletedAt), isNull(schema.agents.archivedAt))),
    db
      .select({
        id: schema.agentRuns.id,
        agentId: schema.agentRuns.agentId,
        channelId: schema.agentRuns.channelId,
        threadRootId: schema.agentRuns.threadRootId,
        triggerMessageId: schema.agentRuns.triggerMessageId,
        brain: schema.agentRuns.brain,
        brainSessionId: schema.agentRuns.brainSessionId,
        handoff: sql<unknown>`${schema.agentRuns.transcript}->'quotaCliHandoff'`,
      })
      .from(schema.agentRuns)
      .where(
        and(eq(schema.agentRuns.orgId, orgId), notInArray(schema.agentRuns.status, ["done", "failed", "canceled"])),
      ),
    db
      .select()
      .from(schema.missions)
      .where(and(eq(schema.missions.orgId, orgId), notInArray(schema.missions.status, ["done", "canceled"]))),
    db
      .select({ id: schema.machines.id, executors: schema.machines.executors })
      .from(schema.machines)
      .where(eq(schema.machines.orgId, orgId)),
    db
      .select({
        id: schema.machineAccounts.id,
        machineId: schema.machineAccounts.machineId,
        kind: schema.machineAccounts.kind,
        provider: schema.machineAccounts.provider,
        usage: schema.machineAccounts.usage,
      })
      .from(schema.machineAccounts)
      .where(eq(schema.machineAccounts.orgId, orgId)),
    db
      .select({
        id: schema.machineTasks.id,
        agentId: schema.machineTasks.agentId,
        machineId: schema.machineTasks.machineId,
        channelId: schema.machineTasks.channelId,
        threadRootId: schema.machineTasks.threadRootId,
        missionId: schema.machineTasks.missionId,
        executor: schema.machineTasks.executor,
        sessionId: schema.machineTasks.sessionId,
        status: schema.machineTasks.status,
        startedAt: schema.machineTasks.startedAt,
        resumedFromId: schema.machineTasks.resumedFromId,
        startRequest: schema.machineTasks.startRequest,
        missionAgentId: schema.missions.agentId,
        missionOwnerId: schema.missions.ownerId,
        missionMainSessionId: schema.missions.mainSessionId,
      })
      .from(schema.machineTasks)
      .leftJoin(
        schema.missions,
        and(eq(schema.missions.id, schema.machineTasks.missionId), eq(schema.missions.orgId, orgId)),
      )
      .where(
        and(
          eq(schema.machineTasks.orgId, orgId),
          isNull(schema.machineTasks.endedAt),
          inArray(schema.machineTasks.status, ["queued", "running", "interrupted"]),
          ne(schema.machineTasks.executor, "shell"),
        ),
      ),
  ]);
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const machineById = new Map(machines.map((machine) => [machine.id, machine]));
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const activeRuns = runs.filter((run) => agentById.has(run.agentId));
  const activeMissions = missions.filter((mission) => agentById.has(mission.agentId));
  const usageRows = activeRuns.length
    ? await db
        .selectDistinctOn([schema.usageRecords.runId], {
          runId: schema.usageRecords.runId,
          provider: schema.usageRecords.provider,
          model: schema.usageRecords.model,
          machineId: schema.usageRecords.machineId,
          accountId: schema.usageRecords.brainAccountId,
          createdAt: schema.usageRecords.createdAt,
        })
        .from(schema.usageRecords)
        .where(
          and(
            eq(schema.usageRecords.orgId, orgId),
            eq(schema.usageRecords.kind, "agent"),
            eq(schema.usageRecords.billedTo, "plan"),
            inArray(
              schema.usageRecords.runId,
              activeRuns.map((run) => run.id),
            ),
          ),
        )
        .orderBy(asc(schema.usageRecords.runId), desc(schema.usageRecords.createdAt), desc(schema.usageRecords.id))
    : [];
  const usageByRun = new Map(usageRows.map((usage) => [usage.runId, usage]));

  const missionRoutes = new Map<string, Route>();
  await Promise.all(
    activeMissions.map(async (mission) => {
      const agent = agentById.get(mission.agentId);
      if (!agent) return;
      const choice = missionBrain(mission);
      const route: Route = {
        kind: choice.brain,
        model: concreteModel(brainModelFor(choice.brain, agent, choice)),
        machineId: mission.machineId,
        accountId: null,
        resolved: isComputerBrain(choice.brain) && !!mission.machineId,
      };
      const [event] = await db
        .select({ data: schema.missionEvents.data })
        .from(schema.missionEvents)
        .where(
          and(
            eq(schema.missionEvents.orgId, orgId),
            eq(schema.missionEvents.missionId, mission.id),
            eq(schema.missionEvents.kind, "model_inspector_route"),
            sql`${schema.missionEvents.data}->>'sessionId' = ${mission.mainSessionId}`,
          ),
        )
        .orderBy(desc(schema.missionEvents.createdAt), desc(schema.missionEvents.id))
        .limit(1);
      if (event) {
        const value = event.data;
        const bound =
          value.schema === "model-inspector-mission-route/1" &&
          value.brain === choice.brain &&
          value.machineId === mission.machineId &&
          value.ownerId === mission.ownerId &&
          value.agentId === mission.agentId &&
          (value.accountId === null || nonempty(value.accountId));
        if (bound) route.accountId = value.accountId as string | null;
        else route.resolved = false;
      } else if (agent.brain === choice.brain && agent.machineId === mission.machineId && agent.brainAccountId) {
        // Same rules as brainAccountFor: a missing or differently bound account is no account.
        const account = accountById.get(agent.brainAccountId);
        if (account?.kind === choice.brain && account.machineId === mission.machineId) route.accountId = account.id;
      }
      missionRoutes.set(mission.id, route);
    }),
  );

  const observe = (
    identity: Pick<ModelInspectorWorkObservation, "id" | "agentId" | "type">,
    route: Route,
  ): ModelInspectorWorkObservation => {
    const { resolved, ...fields } = route;
    const result: ModelInspectorWorkObservation = {
      ...identity,
      ...fields,
      state: "unknown",
      usedPercent: null,
      observedAt: null,
    };
    if (!resolved || !route.machineId || !isComputerBrain(route.kind)) return result;
    const machine = machineById.get(route.machineId);
    const account = route.accountId ? accountById.get(route.accountId) : undefined;
    if (
      !machine ||
      (route.accountId && (!account || account.machineId !== route.machineId || account.kind !== route.kind))
    )
      return result;
    const usage = (account ? account.usage : machine.executors.ownUsage?.[route.kind]) as PlanUsage | null | undefined;
    const at = usage ? Date.parse(usage.at) : Number.NaN;
    if (usage && Number.isFinite(at) && at <= now) result.observedAt = usage.at;
    const reserve = quotaReserveOf(
      usage,
      { machineId: route.machineId, kind: route.kind, accountId: route.accountId },
      { now, thresholdPercent, maxAgeMs, model: route.model ?? "" },
    );
    const fresh =
      Number.isFinite(at) &&
      at <= now &&
      now - at <= maxAgeMs &&
      (usage?.source === "probe" || usage?.source === "turn") &&
      Array.isArray(usage.windows);
    const exhausted =
      (route.kind === "grok" && durableGrokRefusal(usage, now)) ||
      (fresh &&
        !!storedPlanLimit(
          usage,
          now,
          route.kind === "claude_code" && !account?.provider ? (route.model ?? "") : undefined,
        ));
    result.state = exhausted
      ? "exhausted"
      : reserve.state === "low"
        ? "near_limit"
        : reserve.state === "normal"
          ? "healthy"
          : "unknown";
    result.usedPercent = reserve.usedPercent ?? null;
    return result;
  };

  const observations = activeMissions.map((mission) =>
    observe(
      { id: mission.id, agentId: mission.agentId, type: "mission" },
      missionRoutes.get(mission.id) ?? unknownRoute(),
    ),
  );
  for (const run of activeRuns) {
    let route = unknownRoute(run.brain);
    const h = record(run.handoff);
    const billed = usageByRun.get(run.id);
    if (h) {
      const bound =
        h.schema === "quota-cli-handoff/1" &&
        h.disposition === "CONTINUE" &&
        h.runId === run.id &&
        h.agentId === run.agentId &&
        h.channelId === run.channelId &&
        h.goalMessageId === run.triggerMessageId &&
        h.targetSessionId === run.brainSessionId &&
        h.targetKind === run.brain &&
        isComputerBrain(h.targetKind) &&
        nonempty(h.machineId) &&
        nonempty(h.model) &&
        (h.targetAccountId === null || nonempty(h.targetAccountId));
      if (bound) {
        route = {
          kind: h.targetKind as BrainKind,
          model: h.model as string,
          machineId: h.machineId as string,
          accountId: h.targetAccountId as string | null,
          resolved: true,
        };
        // A later answered model is more precise than the requested handoff model, but only on that same pool.
        if (
          billed &&
          billed.provider === route.kind &&
          billed.machineId === route.machineId &&
          billed.accountId === route.accountId &&
          typeof h.observedAt === "number" &&
          billed.createdAt.getTime() >= h.observedAt &&
          billed.model !== billed.provider
        )
          route.model = concreteModel(billed.model);
      }
    } else if (run.brainSessionId && isComputerBrain(run.brain)) {
      if (billed?.provider === run.brain && billed.machineId) {
        route = {
          kind: run.brain,
          model: billed.model === billed.provider ? null : concreteModel(billed.model),
          machineId: billed.machineId,
          accountId: billed.accountId,
          resolved: true,
        };
      } else {
        const mission = activeMissions.find(
          (m) =>
            m.agentId === run.agentId &&
            m.channelId === run.channelId &&
            m.threadRootId === run.threadRootId &&
            m.mainSessionId === run.brainSessionId,
        );
        const current = mission && missionRoutes.get(mission.id);
        if (current?.kind === run.brain) route = current;
      }
    }
    observations.push(observe({ id: run.id, agentId: run.agentId, type: "run" }, route));
  }
  const taskObservations = await Promise.all(
    tasks
      .filter((task) => agentById.has(task.agentId))
      .map(async (task) => {
        // The launched executor and computer are durable even on legacy rows that never recorded an account/model.
        const kind = task.executor === "claude" ? "claude_code" : task.executor;
        let route: Route = { ...unknownRoute(kind), machineId: task.machineId };
        if (task.missionId && task.missionAgentId === task.agentId) {
          let proof: Record<string, unknown> | null = null;
          let bound = false;
          if (task.status === "queued" && task.startedAt === null && task.startRequest !== null) {
            const start = record(task.startRequest);
            const requestedMission = record(start?.mission);
            proof = record(start?.modelInspectorRoute);
            const pinned = start?.resume === true || task.resumedFromId !== null;
            bound =
              !!start &&
              !!proof &&
              start.orgId === orgId &&
              record(start.agent)?.id === task.agentId &&
              start.machineId === task.machineId &&
              start.channelId === task.channelId &&
              (start.threadRootId ?? null) === task.threadRootId &&
              start.executor === task.executor &&
              (start.sessionId ?? null) === task.sessionId &&
              (requestedMission?.id ?? start.missionId ?? null) === task.missionId &&
              (start.missionId === undefined || start.missionId === null || start.missionId === task.missionId) &&
              (pinned || (proof.ownerId === task.missionOwnerId && proof.mainSessionId === task.missionMainSessionId));
          } else {
            const [event] = await db
              .select({ data: schema.missionEvents.data })
              .from(schema.missionEvents)
              .where(
                and(
                  eq(schema.missionEvents.orgId, orgId),
                  eq(schema.missionEvents.missionId, task.missionId),
                  eq(schema.missionEvents.kind, "model_inspector_child_route"),
                  sql`${schema.missionEvents.data}->>'taskId' = ${task.id}`,
                ),
              )
              .orderBy(desc(schema.missionEvents.createdAt), desc(schema.missionEvents.id))
              .limit(1);
            proof = event?.data ?? null;
            // A running/interrupted child's main-session and owner fields describe launch history. Its mission may
            // already have moved elsewhere: only this child's native identity establishes the route it still uses.
            bound =
              !!proof &&
              proof.taskId === task.id &&
              proof.executor === task.executor &&
              proof.sessionId === task.sessionId;
          }
          if (
            bound &&
            proof?.schema === "model-inspector-child-route/1" &&
            proof.agentId === task.agentId &&
            proof.machineId === task.machineId &&
            proof.brain === kind &&
            nonempty(proof.model) &&
            (proof.accountId === null || nonempty(proof.accountId))
          ) {
            route = {
              kind,
              model: concreteModel(proof.model),
              machineId: task.machineId,
              accountId: proof.accountId as string | null,
              resolved: true,
            };
          }
        }
        return observe({ id: task.id, agentId: task.agentId, type: "task" }, route);
      }),
  );
  observations.push(...taskObservations);
  return observations.sort(
    (a, b) => a.agentId.localeCompare(b.agentId) || a.type.localeCompare(b.type) || a.id.localeCompare(b.id),
  );
}
