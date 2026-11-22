import { and, desc, type Executor, eq, isNull, schema, sql } from "@agenteschat/db";
import { type PlanMeterUsage, planState } from "@agenteschat/ui/plan-state";
import type { EngineDeps, QuotaCliQualification, QuotaHandoffKind } from "./executor";
import type { MachineCaller } from "./machine-hub";

/**
 * Production qualifier for the owner's quota continuity policy (2026-11-14). A route qualifies only on subscription
 * evidence, so no unapproved API billing path is used:
 * - Claude Code: the runner's own `claude auth status` reports a `claude.ai` login (an API key reports `api_key`).
 * - Grok: an active machine account signed in with the plan's CLI login (`cli_login`) and no API key, the one the
 *   organization's Grok agents already use.
 * - Codex: the computer's own Codex sign-in has plan usage windows (an API key has none).
 * Context with credential-like text never moves. Capacity, login and session ownership are checked again by the
 * executor through the normal brain resolution.
 */
export const SECRET_PATTERNS: RegExp[] = [
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/,
];

export function hasCredentialText(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

const VALID_MS = 240_000;
const SAFE = /^[A-Za-z0-9._:-]{1,128}$/;

/** The plan account the organization's agents on this kind and computer already think with, if it is a plan login. */
export async function planAccountFor(
  db: Executor,
  orgId: string,
  machineId: string,
  kind: QuotaHandoffKind,
): Promise<string | null> {
  const { agents, machineAccounts } = schema;
  const [row] = await db
    .select({ id: machineAccounts.id, n: sql<number>`count(${agents.id})` })
    .from(machineAccounts)
    .innerJoin(agents, eq(agents.brainAccountId, machineAccounts.id))
    .where(
      and(
        eq(machineAccounts.orgId, orgId),
        eq(machineAccounts.machineId, machineId),
        eq(machineAccounts.kind, kind),
        eq(machineAccounts.status, "active"),
        eq(machineAccounts.authMethod, "cli_login"),
        isNull(machineAccounts.keyHint),
        eq(agents.brain, kind),
        isNull(agents.archivedAt),
      ),
    )
    .groupBy(machineAccounts.id)
    .orderBy(desc(sql`count(${agents.id})`))
    .limit(1);
  return row?.id ?? null;
}

/**
 * A subscription account explicitly shared with the agent owner's own agents.
 * We do not infer paid plans from a CLI binary or from an API-key sign-in.
 * This is a candidate discovery step; the executor re-checks authorization.
 */
export async function ownerSharedSubscriptionAccount(
  db: Executor,
  orgId: string,
  machineId: string,
  agentId: string,
  kind: QuotaHandoffKind,
): Promise<string | null> {
  const [agent] = await db
    .select({ ownerUserId: schema.agents.ownerUserId })
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, orgId), eq(schema.agents.id, agentId)))
    .limit(1);
  if (!agent?.ownerUserId) return null;
  const accounts = schema.machineAccounts;
  const matches = await db
    .select({ id: accounts.id, usage: accounts.usage })
    .from(accounts)
    .innerJoin(
      schema.organizationMembers,
      and(
        eq(schema.organizationMembers.orgId, accounts.orgId),
        eq(schema.organizationMembers.userId, accounts.createdBy),
      ),
    )
    .where(
      and(
        eq(accounts.orgId, orgId),
        eq(accounts.machineId, machineId),
        eq(accounts.kind, kind),
        eq(accounts.status, "active"),
        eq(accounts.createdBy, agent.ownerUserId),
        eq(accounts.shared, true),
        eq(accounts.authMethod, "cli_login"),
        isNull(accounts.keyHint),
        isNull(accounts.provider),
      ),
    )
    .orderBy(desc(accounts.lastSuccessAt), desc(accounts.lastUsedAt), desc(accounts.createdAt))
    .limit(32);
  // A fresh usage reading takes priority over an unknown one, and a full
  // subscription is excluded. The resolver checks real-time availability once
  // more immediately before dispatch; unknown readings are not claimed free.
  const now = Date.now();
  const ranked = matches.flatMap((row) => {
    const u = row.usage as PlanMeterUsage | null;
    const at = u ? Date.parse(u.at) : Number.NaN;
    const fresh = u && Number.isFinite(at) && at <= now && now - at < 15 * 60_000;
    if (!fresh) return [{ id: row.id, used: 101 }];
    const state = planState(u, now);
    return state.state === "limited" ? [] : [{ id: row.id, used: state.used }];
  });
  ranked.sort((a, b) => a.used - b.used || a.id.localeCompare(b.id));
  return ranked[0]?.id ?? null;
}

export function createQuotaCliQualifier(o: {
  db?: Executor;
  machines: Pick<MachineCaller, "status">;
  /** The model each route runs on. */
  models: Partial<Record<QuotaHandoffKind, string>>;
  targets?: readonly QuotaHandoffKind[];
  now?: () => number;
}): NonNullable<EngineDeps["quotaCliContinuation"]> {
  const now = o.now ?? Date.now;
  return {
    ...(o.targets ? { targets: o.targets } : {}),
    async qualify(input): Promise<QuotaCliQualification | null> {
      const kind = input.targetKind;
      const model = o.models[kind];
      if (!model || !SAFE.test(model) || kind === input.sourceKind) return null;
      if (hasCredentialText(JSON.stringify(input.context))) return null;
      const status = await o.machines.status(input.machineId).catch(() => null);
      if (!status) return null;
      let accountId: string | null = null;
      let pool: string;
      let evidence: string;
      if (kind === "claude_code") {
        const claude = status.executors?.claude;
        const ownPlan = claude?.loggedIn === true && claude.authMethod === "claude.ai";
        // A separate account's login can be available even when the host's
        // own Claude login is missing or uses a paid API key.
        const shared =
          o.db && status.online
            ? await ownerSharedSubscriptionAccount(o.db, input.orgId, input.machineId, input.agentId, kind).catch(
                () => null,
              )
            : null;
        if (!ownPlan && !shared) return null;
        if (shared) {
          accountId = shared;
          pool = `claude_code:${input.machineId}:${shared}`;
          evidence = "owner-shared-claude-subscription";
        } else {
          const org =
            claude?.claudeOrgId && /^[A-Za-z0-9-]{1,64}$/.test(claude.claudeOrgId) ? claude.claudeOrgId : "own";
          pool = `claude_code:${input.machineId}:${org}`;
          evidence = "runner-claude-auth-claude.ai";
        }
      } else if (kind === "grok") {
        if (!status.executors?.grok || !o.db) return null;
        accountId = await ownerSharedSubscriptionAccount(o.db, input.orgId, input.machineId, input.agentId, kind).catch(
          () => null,
        );
        // Preserve the legacy named Grok plan only when it belongs to the
        // requesting agent and is admitted again by resolveBrain.
        if (!accountId) {
          const legacy = await planAccountFor(o.db, input.orgId, input.machineId, kind).catch(() => null);
          const [owner] = legacy
            ? await o.db
                .select({ createdBy: schema.machineAccounts.createdBy, provider: schema.machineAccounts.provider })
                .from(schema.machineAccounts)
                .where(and(eq(schema.machineAccounts.orgId, input.orgId), eq(schema.machineAccounts.id, legacy)))
            : [];
          const [agent] = await o.db
            .select({ ownerUserId: schema.agents.ownerUserId })
            .from(schema.agents)
            .where(and(eq(schema.agents.orgId, input.orgId), eq(schema.agents.id, input.agentId)));
          accountId = owner?.createdBy === agent?.ownerUserId && owner?.provider == null ? legacy : null;
        }
        if (!accountId) return null;
        pool = `grok:${input.machineId}:${accountId}`;
        evidence = "grok-account-cli-login";
      } else {
        if (!status.executors?.codex) return null;
        const windows = (status.executors as { ownUsage?: { codex?: { windows?: unknown[] } } }).ownUsage?.codex
          ?.windows;
        const shared =
          o.db && status.online
            ? await ownerSharedSubscriptionAccount(o.db, input.orgId, input.machineId, input.agentId, kind).catch(
                () => null,
              )
            : null;
        if (shared) {
          accountId = shared;
          pool = `codex:${input.machineId}:${shared}`;
          evidence = "owner-shared-codex-subscription";
        } else {
          if (!Array.isArray(windows) || windows.length === 0) return null;
          pool = `codex:${input.machineId}:own`;
          evidence = "codex-own-plan-windows";
        }
      }
      const sourcePool = `${input.sourceKind}:${input.machineId}:${input.sourceAccountId ?? "own"}`;
      if (sourcePool === pool) return null;
      const at = now();
      return {
        targetKind: kind,
        accountId,
        machineId: input.machineId,
        model,
        sourcePool,
        targetPool: pool,
        noPaidExtraUsage: true,
        noCredentialsInContext: true,
        evidence,
        observedAt: at,
        validUntil: at + VALID_MS,
      };
    },
  };
}
