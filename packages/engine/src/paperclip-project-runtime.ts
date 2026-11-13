import { randomUUID } from "node:crypto";
import type { BrainTurnRequest, MachineRequest } from "@agenteschat/adapters/machine-protocol";
import { and, type Database, eq, schema } from "@agenteschat/db";
import type { Brain } from "./brains/types";
import { ValidationError } from "./errors";
import type { MachineCaller, MachineCallOptions } from "./machine-hub";
import { paperclipRunRefusal } from "./paperclip-routine-state";
import { runOwnerBoundProjectTurn } from "./paperclip-workspace-client";
import { assertMappingWorkspace } from "./paperclip-workspaces";

const {
  agentRuns,
  routineRuns,
  routines,
  paperclipRoutineMappings: mappings,
  paperclipRoutineReceipts: receipts,
  agents,
} = schema;
type Deps = { db: Database; enabled?: boolean };
const fail = (): never => {
  throw new ValidationError("Project execution authority is unavailable or changed", "paperclip.workspace_changed");
};
/** Resolve only durable server-created routine/run links; invocation text never selects a path or binding. */
export async function paperclipProjectRun(deps: Deps, orgId: string, runId: string) {
  const [row] = await deps.db
    .select({ run: agentRuns, firing: routineRuns, routine: routines, mapping: mappings })
    .from(agentRuns)
    .innerJoin(routineRuns, and(eq(routineRuns.agentRunId, agentRuns.id), eq(routineRuns.orgId, agentRuns.orgId)))
    .innerJoin(routines, and(eq(routines.id, routineRuns.routineId), eq(routines.orgId, agentRuns.orgId)))
    .leftJoin(mappings, and(eq(mappings.routineId, routines.id), eq(mappings.orgId, agentRuns.orgId)))
    .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.id, runId)));
  if (!row) return null;
  const m = row.mapping;
  if (!m) {
    if (row.firing.event?.type === "paperclip.received") return fail();
    return null;
  }
  if (
    !m.definition.workspaceScope &&
    !m.definition.projectId &&
    !m.definition.projectWorkspaceId &&
    !m.definition.workspaceBindingId
  )
    return null;
  if (
    deps.enabled !== true ||
    !row.run.background ||
    row.run.status !== "running" ||
    row.run.agentId !== m.agentId ||
    row.routine.agentId !== m.agentId ||
    row.routine.deletedAt ||
    !row.routine.active ||
    (await paperclipRunRefusal(deps.db, row.firing, row.routine, deps.enabled))
  )
    return fail();
  const [receipt] = await deps.db
    .select()
    .from(receipts)
    .where(
      and(
        eq(receipts.orgId, orgId),
        eq(receipts.mappingId, m.id),
        eq(receipts.routineRunId, row.firing.id),
        eq(receipts.id, String(row.firing.event?.receiptId)),
        eq(receipts.status, "queued"),
      ),
    );
  if (!receipt || (m.definition.workspaceScope != null && !receipt.workspaceSelection)) return fail();
  const binding = await assertMappingWorkspace(deps.db, m, false, receipt.workspaceSelection);
  const [agent] = await deps.db
    .select()
    .from(agents)
    .where(and(eq(agents.orgId, orgId), eq(agents.id, m.agentId)));
  if (!binding || !agent) return fail();
  return { binding, agent, mapping: m };
}
/** Every brain, including a model fallback, passes this gate before it can execute a project run. */
export function paperclipProjectBrain(deps: Deps, brain: Brain): Brain {
  return {
    kind: brain.kind,
    async *run(turn, io) {
      try {
        const ctx = await paperclipProjectRun(deps, turn.orgId, turn.runId);
        if (!ctx) {
          yield* brain.run(turn, io);
          return;
        }
        if (
          brain.kind !== ctx.agent.brain ||
          !["claude_code", "codex"].includes(brain.kind) ||
          turn.agentId !== ctx.agent.id ||
          turn.model !== ctx.agent.brainModel ||
          turn.session?.machineId !== ctx.binding.machineId
        )
          return fail();
        const cwd = ctx.binding.targetCwd;
        // Give the normal prompt builder the whole conversation for a fresh native session, on every turn.
        const fresh = {
          ...turn,
          session: { ...turn.session, id: randomUUID(), resume: false, cwd },
          code: Promise.resolve({
            cwd,
            prompt: "# Registered project workspace\nUse only the assigned target workspace and normal permissions.",
            start: `You start in ${cwd}.`,
          }),
        };
        for await (const event of brain.run(fresh, io)) {
          // A disconnect/result loss after dispatch has an unknown effect: require reconciliation, never replay.
          yield event.type === "error"
            ? { ...event, code: "paperclip_workspace_turn_failed", retryable: false, serverStop: false }
            : event;
        }
      } catch (e) {
        yield {
          type: "error",
          code: "paperclip_workspace_changed",
          message: e instanceof Error ? e.message : "Project workspace unavailable",
          retryable: false,
        };
      }
    },
  };
}
/** Keep the hub's authenticated transport/stream handling, replacing only a persisted project run's turn. */
export function paperclipProjectHub(
  deps: Deps & { hub: Pick<MachineCaller, "call" | "status"> },
): Pick<MachineCaller, "call" | "status"> {
  const call = (async (machineId: string, request: MachineRequest, options?: MachineCallOptions) => {
    if (request.op !== "brain.turn") return deps.hub.call(machineId, request, options);
    // Agent IDs are server-selected; the lookup still scopes through the agent's persisted organization.
    const [run] = await deps.db
      .select({ orgId: agentRuns.orgId })
      .from(agentRuns)
      .where(eq(agentRuns.id, request.runId));
    if (!run) return deps.hub.call(machineId, request, options);
    const ctx = await paperclipProjectRun(deps, run.orgId, request.runId);
    if (!ctx) return deps.hub.call(machineId, request, options);
    if (!request.agent || request.agent.id !== ctx.agent.id || request.agent.handle !== ctx.agent.handle) return fail();
    const authorized = async () => {
      const current = await paperclipProjectRun(deps, run.orgId, request.runId);
      return Boolean(
        current &&
          current.binding.id === ctx.binding.id &&
          current.binding.bindingDigest === ctx.binding.bindingDigest &&
          current.mapping.configHash === ctx.mapping.configHash &&
          current.agent.brain === request.kind &&
          current.agent.brainModel === request.model &&
          current.agent.brainAccountId === (request.account ?? null) &&
          current.binding.machineId === machineId &&
          request.cwd === current.binding.targetCwd &&
          request.keepAlive === false &&
          request.session.resume === false,
      );
    };
    return runOwnerBoundProjectTurn(
      { hub: deps.hub, assertAuthorized: authorized, signal: options?.signal },
      {
        orgId: run.orgId,
        machineId,
        ownerId: ctx.binding.ownerId,
        agent: request.agent,
        bindingId: ctx.binding.id,
        generation: ctx.binding.generation,
        targetCwd: ctx.binding.targetCwd,
        bindingDigest: ctx.binding.bindingDigest,
        turn: request as BrainTurnRequest,
      },
    );
  }) as MachineCaller["call"];
  return { status: (id) => deps.hub.status(id), call };
}
