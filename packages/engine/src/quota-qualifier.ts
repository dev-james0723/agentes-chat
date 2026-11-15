import { and, desc, type Executor, eq, isNull, schema, sql } from "@agenteschat/db";
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
async function planAccountFor(
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
        if (!claude || claude.loggedIn !== true || claude.authMethod !== "claude.ai") return null;
        const org = claude.claudeOrgId && /^[A-Za-z0-9-]{1,64}$/.test(claude.claudeOrgId) ? claude.claudeOrgId : "own";
        pool = `claude_code:${input.machineId}:${org}`;
        evidence = "runner-claude-auth-claude.ai";
      } else if (kind === "grok") {
        if (!status.executors?.grok || !o.db) return null;
        accountId = await planAccountFor(o.db, input.orgId, input.machineId, "grok").catch(() => null);
        if (!accountId) return null;
        pool = `grok:${input.machineId}:${accountId}`;
        evidence = "grok-account-cli-login";
      } else {
        if (!status.executors?.codex) return null;
        const windows = (status.executors as { ownUsage?: { codex?: { windows?: unknown[] } } }).ownUsage?.codex
          ?.windows;
        if (!Array.isArray(windows) || windows.length === 0) return null;
        pool = `codex:${input.machineId}:own`;
        evidence = "codex-own-plan-windows";
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
