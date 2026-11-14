import type { MachineCaller } from "./machine-hub";
import type { EngineDeps, QuotaCliQualification } from "./executor";

/**
 * Production qualifier for the owner's quota continuity policy (2026-11-14): a Codex agent near or at its plan limit
 * may continue on the same computer's Claude Code subscription sign-in. It qualifies only when the runner's own
 * `claude auth status` reports a `claude.ai` subscription login (an API key reports `api_key` and is refused, so no
 * unapproved API billing path is used) and the portable context carries no credential-like text. Capacity of the
 * target window, the agent's extra-usage setting and session ownership are checked again by the executor.
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

export function createQuotaCliQualifier(o: {
  machines: Pick<MachineCaller, "status">;
  /** The Claude Code model the handoff runs on (the fleet's own Claude agents use it). */
  model: string;
  now?: () => number;
}): NonNullable<EngineDeps["quotaCliContinuation"]> {
  const now = o.now ?? Date.now;
  return {
    async qualify(input): Promise<QuotaCliQualification | null> {
      if (input.sourceKind !== "codex") return null;
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(o.model)) return null;
      const status = await o.machines.status(input.machineId).catch(() => null);
      const claude = status?.executors?.claude;
      if (!claude || claude.loggedIn !== true || claude.authMethod !== "claude.ai") return null;
      if (hasCredentialText(JSON.stringify(input.context))) return null;
      const at = now();
      const org = claude.claudeOrgId && /^[A-Za-z0-9-]{1,64}$/.test(claude.claudeOrgId) ? claude.claudeOrgId : "own";
      return {
        targetKind: "claude_code",
        machineId: input.machineId,
        model: o.model,
        sourcePool: `codex:${input.machineId}:${input.sourceAccountId ?? "own"}`,
        targetPool: `claude_code:${input.machineId}:${org}`,
        noPaidExtraUsage: true,
        noCredentialsInContext: true,
        evidence: "runner-claude-auth-claude.ai",
        observedAt: at,
        validUntil: at + VALID_MS,
      };
    },
  };
}
