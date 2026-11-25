import { and, type Database, eq, gte, inArray, lt, ne, schema, sql } from "@agenteschat/db";
import { nanoUsdToUsd } from "@agenteschat/providers";
import { contractHash, contractOf, type StoredContract, verdictOf } from "./completion-contract";
import { ForbiddenError, ValidationError } from "./errors";
import type { EvidenceOutcome } from "./founder-status";
import { canViewCost } from "./usage";

/**
 * Cost per independently verified successful task (ADR 0207). Measurement only: nothing here changes routing.
 *
 * - A success is a task (`agent_runs.issue_id`) an independent verifier confirmed against its completion contract
 *   (`task_verified`, ADR 0211), with no reopen, new claim or rejection since and the contract unchanged. People's ticks
 *   alone (`criteria_met`) are evidence for the verifier, not a success. A task counts once, for the group of its
 *   latest finished run.
 * - Every finished run (done, failed, canceled) counts toward cost, verified or not.
 * - A run's cost is known only when it has usage rows and none is a plan turn (`billed_to = plan` records no price).
 *   One unknown run makes its group's cost unknown: never summed as 0.
 * - Retries are the runs on a task after its first in the window.
 */

const { agentRuns, usageRecords, outcomes, agents, issues } = schema;
const FINISHED = ["done", "failed", "canceled"] as const;
const DAY = 86_400_000;
/** The longest window one request reads (ADR 0207): the report loads the window's runs in memory. */
export const COST_PER_SUCCESS_MAX_DAYS = 92;

export type CostPerSuccessMissing = "no_success" | "unknown_cost";

export interface CostPerSuccessRow {
  runs: number;
  failedRuns: number;
  retries: number;
  verifiedSuccesses: number;
  tokens: number;
  /** Null: at least one run's cost is unknown. */
  costUsd: number | null;
  unknownCostRuns: number;
  /** Null when there is no verified success or the cost is unknown (`missing` says which). */
  costPerSuccessUsd: number | null;
  missing: CostPerSuccessMissing | null;
  /** The number in plain Hong Kong Chinese. */
  text: string;
}

export interface CostPerSuccessGroup extends CostPerSuccessRow {
  agentId: string;
  agentName: string;
  /** `agent_runs.brain`; `api` for the Model Gateway's own loop. */
  brain: string;
  /** The model with the most tokens in the group's runs; null when no run recorded usage. */
  model: string | null;
}

/**
 * False-pass counts (ADR 0211): tasks claimed done in the window (an `issue_closed` claim, by anyone), how many an
 * independent verifier confirmed, and how many a verifier rejected after the claim. Read only.
 */
export interface ClaimCounts {
  claimedDone: number;
  verified: number;
  rejectedAfterClaim: number;
  /** Claimed, neither verified nor rejected after the claim: done in name only so far. */
  unverified: number;
  /** `rejectedAfterClaim / claimedDone`; null with no claim. */
  falseClaimRate: number | null;
  text: string;
}

export interface CostPerSuccessReport {
  from: string;
  to: string;
  groups: CostPerSuccessGroup[];
  total: CostPerSuccessRow;
  claims: ClaimCounts;
}

const VERDICT_ROW_KINDS = ["task_verified", "task_rejected", "issue_reopened", "issue_closed"];

/** Each task's verdict rows and the hash of its contract and criteria now, for `verdictOf`. */
async function verdictInputs(db: Database, orgId: string, issueIds: string[]) {
  const rows = new Map<string, EvidenceOutcome[]>();
  const hashes = new Map<string, string>();
  if (issueIds.length === 0) return { rows, hashes };
  const found = await db
    .select({ id: outcomes.id, kind: outcomes.kind, details: outcomes.details, createdAt: outcomes.createdAt })
    .from(outcomes)
    .where(
      and(
        eq(outcomes.orgId, orgId),
        inArray(outcomes.kind, VERDICT_ROW_KINDS),
        inArray(sql<string>`${outcomes.details}->>'issueId'`, issueIds),
      ),
    );
  for (const o of found) {
    const issueId = o.details.issueId;
    if (typeof issueId !== "string") continue;
    rows.set(issueId, [...(rows.get(issueId) ?? []), { ...o, subject: "" }]);
  }
  const tasks = await db
    .select({ id: issues.id, criteria: issues.criteria, contract: issues.completionContract })
    .from(issues)
    .where(and(eq(issues.orgId, orgId), inArray(sql<string>`${issues.id}::text`, issueIds)));
  const byId = new Map(tasks.map((t) => [t.id, t]));
  // A task no longer here: the default contract over no criteria.
  for (const id of issueIds) {
    const t = byId.get(id);
    hashes.set(id, contractHash(contractOf((t?.contract as StoredContract | null) ?? null), t?.criteria ?? []));
  }
  return { rows, hashes };
}

function claimText(c: Omit<ClaimCounts, "text">): string {
  if (c.claimedDone === 0) return "完成宣稱：呢段時間冇任務標完成。";
  return `完成宣稱：${c.claimedDone} 個任務標咗完成，${c.verified} 個經獨立核實，${c.rejectedAfterClaim} 個宣稱完成後被核實者退回，${c.unverified} 個未核實。`;
}

async function claimCounts(db: Database, orgId: string, from: Date, to: Date): Promise<ClaimCounts> {
  const claims = await db
    .select({ details: outcomes.details, createdAt: outcomes.createdAt })
    .from(outcomes)
    .where(
      and(
        eq(outcomes.orgId, orgId),
        eq(outcomes.kind, "issue_closed"),
        gte(outcomes.createdAt, from),
        lt(outcomes.createdAt, to),
      ),
    );
  const firstClaim = new Map<string, Date>();
  for (const c of claims) {
    const id = c.details.issueId;
    if (typeof id !== "string") continue;
    const seen = firstClaim.get(id);
    if (!seen || c.createdAt < seen) firstClaim.set(id, c.createdAt);
  }
  const ids = [...firstClaim.keys()];
  const { rows, hashes } = await verdictInputs(db, orgId, ids);
  let verified = 0;
  let rejectedAfterClaim = 0;
  for (const id of ids) {
    const own = rows.get(id) ?? [];
    if (verdictOf(own, hashes.get(id) ?? "").state === "verified") verified++;
    else if (own.some((r) => r.kind === "task_rejected" && r.createdAt > (firstClaim.get(id) as Date)))
      rejectedAfterClaim++;
  }
  const counts = {
    claimedDone: ids.length,
    verified,
    rejectedAfterClaim,
    unverified: ids.length - verified - rejectedAfterClaim,
    falseClaimRate: ids.length > 0 ? rejectedAfterClaim / ids.length : null,
  };
  return { ...counts, text: claimText(counts) };
}

const usd = (n: number) => `US$${n.toFixed(2)}`;

function textOf(r: Omit<CostPerSuccessRow, "text">): string {
  if (r.missing === "unknown_cost")
    return `每次成功成本：未知。有 ${r.unknownCostRuns} 次運行冇價錢紀錄（例如用訂閱計劃），唔會當係 0。經獨立核實嘅成功任務：${r.verifiedSuccesses} 個。`;
  if (r.missing === "no_success")
    return `每次成功成本：計唔到，未有經獨立核實嘅成功任務。${r.runs} 次運行共用咗 ${usd(r.costUsd ?? 0)}。`;
  return `每個經獨立核實嘅成功任務平均成本 ${usd(r.costPerSuccessUsd ?? 0)}（${r.verifiedSuccesses} 個成功，${r.runs} 次運行共用 ${usd(r.costUsd ?? 0)}）。`;
}

function finish(r: Omit<CostPerSuccessRow, "costPerSuccessUsd" | "missing" | "text">): CostPerSuccessRow {
  const missing: CostPerSuccessMissing | null =
    r.costUsd === null ? "unknown_cost" : r.verifiedSuccesses === 0 ? "no_success" : null;
  const costPerSuccessUsd = missing === null && r.costUsd !== null ? r.costUsd / r.verifiedSuccesses : null;
  const row = { ...r, costPerSuccessUsd, missing };
  return { ...row, text: textOf(row) };
}

export async function costPerSuccess(
  db: Database,
  userId: string,
  orgId: string,
  window: { from?: Date; to?: Date },
): Promise<CostPerSuccessReport> {
  if (!(await canViewCost(db, userId, orgId))) throw new ForbiddenError("Viewing usage is not allowed");
  const to = window.to ?? new Date();
  const from = window.from ?? new Date(to.getTime() - 30 * DAY);
  if (!(from < to)) throw new ValidationError("`from` must be before `to`");
  if (to.getTime() - from.getTime() > COST_PER_SUCCESS_MAX_DAYS * DAY)
    throw new ValidationError(`The window is at most ${COST_PER_SUCCESS_MAX_DAYS} days`);

  const runs = await db
    .select({
      id: agentRuns.id,
      agentId: agentRuns.agentId,
      agentName: agents.name,
      brain: agentRuns.brain,
      status: agentRuns.status,
      issueId: agentRuns.issueId,
      createdAt: agentRuns.createdAt,
    })
    .from(agentRuns)
    .innerJoin(agents, eq(agents.id, agentRuns.agentId))
    .where(
      and(
        eq(agentRuns.orgId, orgId),
        gte(agentRuns.createdAt, from),
        lt(agentRuns.createdAt, to),
        inArray(agentRuns.status, [...FINISHED]),
      ),
    )
    .orderBy(agentRuns.createdAt, agentRuns.id);

  const runIds = runs.map((r) => r.id);
  const usage = runIds.length
    ? await db
        .select({
          runId: usageRecords.runId,
          model: usageRecords.model,
          billedTo: usageRecords.billedTo,
          cost: usageRecords.costNanoUsd,
          tokens: sql<number>`${usageRecords.inputTokens} + ${usageRecords.outputTokens} + ${usageRecords.cacheReadTokens} + ${usageRecords.cacheWriteTokens}`,
        })
        .from(usageRecords)
        // Internal services on this server's own keys are not the workspace's spend (ADR 0063).
        .where(
          and(
            eq(usageRecords.orgId, orgId),
            inArray(usageRecords.runId, runIds),
            ne(usageRecords.billedTo, "platform"),
          ),
        )
    : [];
  const perRun = new Map<string, { cost: number; tokens: number; unknown: boolean; models: Map<string, number> }>();
  for (const u of usage) {
    if (!u.runId) continue;
    const r = perRun.get(u.runId) ?? { cost: 0, tokens: 0, unknown: false, models: new Map() };
    r.cost += Number(u.cost);
    r.tokens += Number(u.tokens);
    if (u.billedTo === "plan") r.unknown = true;
    r.models.set(u.model, (r.models.get(u.model) ?? 0) + Number(u.tokens));
    perRun.set(u.runId, r);
  }

  const issueIds = [...new Set(runs.flatMap((r) => (r.issueId ? [r.issueId] : [])))];
  const verified = new Set<string>();
  {
    const { rows, hashes } = await verdictInputs(db, orgId, issueIds);
    for (const id of issueIds)
      if (verdictOf(rows.get(id) ?? [], hashes.get(id) ?? "").state === "verified") verified.add(id);
  }

  // Per run: its group (agent × brain × model).
  const keyOf = new Map<string, string>();
  const groups = new Map<string, { agentId: string; agentName: string; brain: string; ids: string[] }>();
  for (const r of runs) {
    const u = perRun.get(r.id);
    const model = u ? ([...u.models].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null) : null;
    const brain = r.brain ?? "api";
    const key = `${r.agentId}|${brain}|${model ?? ""}`;
    keyOf.set(r.id, key);
    const g = groups.get(key) ?? { agentId: r.agentId, agentName: r.agentName, brain, ids: [] as string[] };
    g.ids.push(r.id);
    groups.set(key, g);
  }

  // Retries and the run each verified task is credited to (its latest; runs are ordered oldest first).
  const seen = new Set<string>();
  const retryRuns = new Set<string>();
  const creditTo = new Map<string, string>();
  for (const r of runs) {
    if (!r.issueId) continue;
    if (seen.has(r.issueId)) retryRuns.add(r.id);
    seen.add(r.issueId);
    if (verified.has(r.issueId)) creditTo.set(r.issueId, r.id);
  }
  const successOf = new Map<string, number>();
  for (const runId of creditTo.values()) {
    const key = keyOf.get(runId) as string;
    successOf.set(key, (successOf.get(key) ?? 0) + 1);
  }
  const byId = new Map(runs.map((r) => [r.id, r]));

  const sum = (ids: string[], successes: number) => {
    let cost = 0;
    let tokens = 0;
    let unknownCostRuns = 0;
    for (const id of ids) {
      const u = perRun.get(id);
      if (!u || u.unknown) unknownCostRuns++;
      if (u) {
        cost += u.cost;
        tokens += u.tokens;
      }
    }
    return finish({
      runs: ids.length,
      failedRuns: ids.filter((id) => byId.get(id)?.status !== "done").length,
      retries: ids.filter((id) => retryRuns.has(id)).length,
      verifiedSuccesses: successes,
      tokens,
      costUsd: unknownCostRuns > 0 ? null : nanoUsdToUsd(cost),
      unknownCostRuns,
    });
  };

  const list: CostPerSuccessGroup[] = [...groups].map(([key, g]) => {
    const model = key.split("|")[2] || null;
    return {
      agentId: g.agentId,
      agentName: g.agentName,
      brain: g.brain,
      model,
      ...sum(g.ids, successOf.get(key) ?? 0),
    };
  });
  list.sort((a, b) => a.agentName.localeCompare(b.agentName) || b.runs - a.runs);
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    groups: list,
    total: sum(runIds, creditTo.size),
    claims: await claimCounts(db, orgId, from, to),
  };
}
