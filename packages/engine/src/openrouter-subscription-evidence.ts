import type { PlanUsage } from "@agenteschat/adapters";
import { and, type Executor, eq, schema } from "@agenteschat/db";
import { planWindows } from "@agenteschat/ui/plan-state";
import type { Agent } from "./agents";
import type { BrainPlan } from "./brains/select";
import type { MachineCaller } from "./machine-hub";

type State = "available" | "exhausted" | "unavailable" | "unknown";
const routes = [
  ["claude_code", "claude"],
  ["codex", "codex"],
  ["grok", "grok"],
  ["antigravity", "antigravity"],
] as const;

/** Only account-wide, fresh observations are evidence. A per-model quota is not account exhaustion. */
export function openRouterPlanState(
  kind: string,
  usage: PlanUsage | null | undefined,
  now: number,
  maxAgeMs: number,
): State {
  const observed = usage?.at ? Date.parse(usage.at) : NaN;
  if (
    !usage ||
    !["probe", "turn"].includes(usage.source) ||
    !Number.isFinite(observed) ||
    observed > now ||
    now - observed > maxAgeMs
  )
    return "unknown";
  const windows = planWindows(usage, now).filter((w) => ["five_hour", "seven_day", "monthly"].includes(w.kind));
  if (windows.some((w) => Number.isFinite(w.used) && w.used >= 100)) return "exhausted";
  if (kind === "grok" && usage.source === "turn" && usage.limited === true && usage.windows.length === 0)
    return "exhausted";
  if (
    !usage.limited &&
    windows.length &&
    windows.every(
      (w) => Number.isFinite(w.used) && w.used >= 0 && w.used < 100 && (!w.resetsAt || Date.parse(w.resetsAt) > now),
    )
  )
    return "available";
  return "unknown";
}

/** Same-host candidates, matching the existing native handoff authority. Unknown or unverified installed accounts block paid fallback. */
export async function openRouterSubscriptionEvidence(
  db: Executor,
  machines: Pick<MachineCaller, "status"> | undefined,
  agent: Agent,
  plan: BrainPlan,
  maxAgeMs = 300_000,
) {
  const machineId = plan.session?.machineId ?? agent.machineId;
  const empty = { source: "unknown" as const, alternatives: [{ id: "inventory", state: "unknown" as const }] };
  if (!machineId || !machines || !routes.some(([kind]) => kind === plan.kind)) return empty;
  const host = await machines.status(machineId).catch(() => null);
  if (!host || host.orgId !== agent.orgId || !host.online || !host.execAllowed || host.paused || host.standby)
    return empty;
  const accounts = await db
    .select()
    .from(schema.machineAccounts)
    .where(and(eq(schema.machineAccounts.orgId, agent.orgId), eq(schema.machineAccounts.machineId, machineId)));
  const observed = Date.now();
  const states: { id: string; state: State }[] = [];
  const sourceId = plan.account?.id ?? `own:${plan.kind}`;
  for (const [kind, executor] of routes) {
    const installed = host.executors[executor];
    const eligible = accounts.filter(
      (a) =>
        a.kind === kind &&
        (a.id === sourceId || a.serves === "everyone" || a.createdBy === agent.ownerUserId) &&
        !a.keyHint &&
        !a.provider &&
        a.authMethod !== "api_key",
    );
    for (const a of eligible) {
      const state =
        a.statusUnknown || a.authMethod !== "cli_login"
          ? "unknown"
          : a.status === "signed_out"
            ? "unavailable"
            : a.status !== "active" || !installed
              ? "unknown"
              : openRouterPlanState(kind, a.usage, observed, maxAgeMs);
      states.push({ id: a.id, state });
    }
    let own: State = "unknown";
    if (!installed && host.protocol >= 44 && host.executors.detectedAt) own = "unavailable";
    else if (kind === "claude_code" && host.executors.claude?.loggedIn === false) own = "unavailable";
    else if (
      installed &&
      (kind !== "claude_code" ||
        (host.executors.claude?.loggedIn === true && host.executors.claude.authMethod === "claude.ai"))
    )
      own = openRouterPlanState(kind, host.executors.ownUsage?.[kind], observed, maxAgeMs);
    states.push({ id: `own:${kind}`, state: own });
  }
  const source = states.find((s) => s.id === sourceId)?.state ?? "unknown";
  return {
    source: source === "available" ? ("healthy" as const) : source,
    alternatives: states.filter((s) => s.id !== sourceId),
  };
}
