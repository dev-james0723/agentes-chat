import { createHash } from "node:crypto";
import type { Executor } from "@agenteschat/db";
import type { ToolContext, ToolDefinition, ToolExecutionPolicy } from "../tools/types";

/**
 * An operator-pinned builder phase on EXISTING native runs. This policy narrows
 * native grants; it never grants a scope, approves an action or creates a run.
 * It protects against the named native builder RUN, not the OS owner or another
 * independently authorized run of the same agent. Keep this distinction in any
 * evaluator protection receipt.
 *
 * Pins must survive server restart in operator-owned configuration. A mutable
 * task description, model argument or transcript marker is NOT a pin. In
 * particular, removing a transcript marker cannot remove this restriction.
 */
export interface FoundryBuilderRunPin {
  phaseRef: string;
  orgId: string;
  taskId: string;
  agentId: string;
  runIds: readonly string[];
  expiresAt: string;
}

export interface FoundryPolicyRun {
  id: string;
  orgId: string;
  agentId: string;
  issueId: string | null;
  status: string;
  background: boolean;
  workId: string | null;
  brain: string | null;
  brainSessionId: string | null;
}

export type FoundryPolicyContext = Pick<ToolContext, "orgId" | "agentId" | "runId"> &
  Pick<Partial<ToolContext>, "bridge" | "signal">;

/** Only independently reviewed native task/Skill reads may extend the default. */
export interface FoundryReviewedNativeRead {
  sourceName: string;
  name: string;
  scope: "issues:read" | "skills:read";
  /** Operator evidence identifying the exact native implementation reviewed. */
  reviewRef: string;
}

export type FoundryPolicyDecision = { ok: true } | { ok: false; message: string; code: "FOUNDRY_RUN_RESTRICTED" };

export interface FoundryBuilderProtection {
  schema: "foundry-builder-protection/1";
  claim: "native_builder_run_only";
  phaseRef: string;
  policyDigest: string;
  orgId: string;
  taskId: string;
  agentId: string;
  runId: string;
  expiresAt: string;
  brain: "model";
}

export interface FoundryExecutionPolicy extends ToolExecutionPolicy {
  /** Route selection may only narrow to the existing ModelBrain; it must not add spend. */
  requiresModelBrain(ctx: FoundryPolicyContext): boolean;
  /** Invoke before EVERY brain turn, including resume, spill and quota handoff. */
  beforeBrain(ctx: FoundryPolicyContext, kind: string): Promise<FoundryPolicyDecision>;
  /**
   * Also recognizes a pinned model run paused on a native checkpoint. The
   * evaluation worker must separately verify the EXACT pending tool/wait;
   * this claim never permits tool execution or a brain turn while waiting.
   * Null means no currently verified protection claim, never a fallback.
   */
  protection(
    ctx: FoundryPolicyContext,
    purpose?: "active" | "read_evidence",
    transaction?: Executor,
  ): Promise<FoundryBuilderProtection | null>;
}

export interface FoundryExecutionPolicyOptions {
  pins: readonly FoundryBuilderRunPin[];
  /**
   * Fresh server-owned native agent_runs.foundryPolicy column, set atomically
   * before the run is enqueued. No public/tool patch may write or delete it.
   * Revocation stores an expired pin, never null. Errors deny even an otherwise
   * unpinned run; absence is distinct from failure to read the authority.
   */
  readPin?(ctx: FoundryPolicyContext, transaction?: Executor): Promise<FoundryBuilderRunPin | null>;
  /** Fresh native row on every check. Never return a model-supplied identity. */
  readRun(ctx: FoundryPolicyContext, transaction?: Executor): Promise<FoundryPolicyRun | null>;
  /** Fresh native lifecycle discovery, not arbitrary names supplied by a builder. */
  capabilities?(ctx: ToolContext): Promise<readonly { candidateId: string; digest: string }[]>;
  nativeReads?: readonly FoundryReviewedNativeRead[];
  now?: () => number;
  /** Bounds only trusted control reads; it is not a candidate execution limit. */
  controlTimeoutMs?: number;
}

export const FOUNDRY_POLICY_MANAGEMENT = Object.freeze({
  propose_foundry_capability: "skills:read",
  stage_foundry_package: "skills:read",
  evaluate_foundry_capability: "sandbox:run",
  prepare_foundry_activation: "sandbox:run",
  activate_foundry_capability: "sandbox:run",
  run_foundry_canary: "sandbox:run",
  revoke_foundry_capability: "sandbox:run",
} as const);

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const NAME = /^[a-zA-Z0-9_-]{1,64}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: Security boundary deliberately rejects control characters in opaque references.
const REF = /^[^\u0000-\u001f\u007f]{1,512}$/;
const deny = (): FoundryPolicyDecision => ({
  ok: false,
  code: "FOUNDRY_RUN_RESTRICTED",
  message:
    "This run is restricted to its native Foundry workflow. The requested tool or execution route is unavailable.",
});
const allow = (): FoundryPolicyDecision => ({ ok: true });
type Pin = Readonly<FoundryBuilderRunPin> & { readonly policyDigest: string };
type Resolution = { state: "unrestricted" } | { state: "denied" } | { state: "restricted"; pin: Pin };

function invalid(): never {
  throw new Error("Invalid operator-owned Foundry builder policy configuration");
}

/** Pure construction. No native grants or native task/agent records are changed. */
export function createFoundryExecutionPolicy(options: FoundryExecutionPolicyOptions): FoundryExecutionPolicy {
  const now = options.now ?? Date.now;
  const timeoutMs = options.controlTimeoutMs ?? 1000;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 10_000 ||
    !Array.isArray(options.pins) ||
    (options.nativeReads !== undefined && !Array.isArray(options.nativeReads))
  )
    invalid();
  const reads = (options.nativeReads ?? [])
    .map((r) => {
      if (
        !r ||
        typeof r.sourceName !== "string" ||
        !REF.test(r.sourceName) ||
        r.sourceName === "foundry" ||
        typeof r.name !== "string" ||
        !NAME.test(r.name) ||
        !/^(?:get|read|list|search)_/.test(r.name) ||
        typeof r.reviewRef !== "string" ||
        !REF.test(r.reviewRef) ||
        !["issues:read", "skills:read"].includes(r.scope)
      )
        invalid();
      return Object.freeze({ sourceName: r.sourceName, name: r.name, scope: r.scope, reviewRef: r.reviewRef });
    })
    .sort((a, b) => `${a.sourceName}:${a.name}:${a.scope}`.localeCompare(`${b.sourceName}:${b.name}:${b.scope}`));
  const byRun = new Map<string, Pin>();
  const observedDynamicPins = new Set<string>();
  function normalizePin(p: FoundryBuilderRunPin): Pin {
    if (
      !p ||
      typeof p.phaseRef !== "string" ||
      !REF.test(p.phaseRef) ||
      typeof p.orgId !== "string" ||
      !UUID.test(p.orgId) ||
      typeof p.taskId !== "string" ||
      !UUID.test(p.taskId) ||
      typeof p.agentId !== "string" ||
      !UUID.test(p.agentId) ||
      !Array.isArray(p.runIds) ||
      !p.runIds.length ||
      p.runIds.length > 100 ||
      p.runIds.some((id: unknown) => typeof id !== "string" || !UUID.test(id)) ||
      new Set(p.runIds).size !== p.runIds.length ||
      typeof p.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(p.expiresAt))
    )
      invalid();
    const normalized = Object.freeze({
      phaseRef: p.phaseRef,
      orgId: p.orgId,
      taskId: p.taskId,
      agentId: p.agentId,
      runIds: Object.freeze([...p.runIds].sort()),
      expiresAt: new Date(p.expiresAt).toISOString(),
    });
    const policyDigest = createHash("sha256")
      .update(
        JSON.stringify({
          schema: "foundry-builder-policy/1",
          claim: "native_builder_run_only",
          // Membership is checked byRun and each proof binds runId separately.
          // Adding an operator-pinned fresh run to the SAME phase must not change
          // the permission-profile digest of the already evaluated builder run.
          pin: {
            phaseRef: normalized.phaseRef,
            orgId: normalized.orgId,
            taskId: normalized.taskId,
            agentId: normalized.agentId,
            expiresAt: normalized.expiresAt,
          },
          brain: "model",
          management: FOUNDRY_POLICY_MANAGEMENT,
          nativeReads: reads,
        }),
      )
      .digest("hex");
    return Object.freeze({ ...normalized, policyDigest });
  }
  for (const p of options.pins) {
    const pin = normalizePin(p);
    for (const runId of pin.runIds) {
      if (byRun.has(runId)) invalid();
      byRun.set(runId, pin);
    }
  }

  async function control<T>(operation: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Foundry policy control read timed out")), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function resolve(
    ctx: FoundryPolicyContext,
    requireRecordedModel = true,
    allowWaiting = false,
    historical = false,
    transaction?: Executor,
  ): Promise<Resolution> {
    // Key by run id BEFORE comparing the organization: changing org cannot remove a pin.
    let pin = byRun.get(ctx.runId);
    if (options.readPin) {
      try {
        const record = await control(() => options.readPin!(ctx, transaction));
        if (record) {
          const fresh = normalizePin(record);
          if (!fresh.runIds.includes(ctx.runId) || (pin && pin.policyDigest !== fresh.policyDigest))
            return { state: "denied" };
          pin = fresh;
          observedDynamicPins.add(ctx.runId);
        } else if (observedDynamicPins.has(ctx.runId)) {
          // A missing pin cannot downgrade a run already observed as restricted.
          return { state: "denied" };
        }
      } catch {
        return { state: "denied" };
      }
    }
    if (!pin) return { state: "unrestricted" };
    if (
      ctx.orgId !== pin.orgId ||
      ctx.agentId !== pin.agentId ||
      ctx.bridge ||
      ctx.signal?.aborted ||
      Date.parse(pin.expiresAt) <= now()
    )
      return { state: "denied" };
    try {
      const identity = { orgId: pin.orgId, agentId: pin.agentId, runId: ctx.runId };
      const row = await control(() => options.readRun(identity, transaction));
      const statuses = allowWaiting ? ["running", "waiting_input", "waiting_approval"] : ["running"];
      if (historical) statuses.push("done");
      if (
        !row ||
        row.id !== ctx.runId ||
        row.orgId !== pin.orgId ||
        row.agentId !== pin.agentId ||
        row.issueId !== pin.taskId ||
        !statuses.includes(row.status) ||
        row.background !== false ||
        row.workId !== null ||
        row.brainSessionId !== null ||
        (requireRecordedModel ? row.brain !== "model" : row.brain !== null && row.brain !== "model") ||
        Date.parse(pin.expiresAt) <= now()
      )
        return { state: "denied" };
      return { state: "restricted", pin };
    } catch {
      return { state: "denied" };
    }
  }

  const toolContextDenied = (ctx: ToolContext) => !!ctx.bridge || ctx.signal?.aborted === true;
  const sameTool = (t: ToolDefinition, ref: { name: string; scope: string }) =>
    !t.connectionId && !t.connector && !t.needs && t.name === ref.name && t.scope === ref.scope;

  return {
    requiresModelBrain(ctx) {
      return byRun.has(ctx.runId) || observedDynamicPins.has(ctx.runId);
    },
    async beforeBrain(ctx, kind) {
      const current = await resolve(ctx, false);
      if (current.state === "unrestricted") return allow();
      return current.state === "restricted" && kind === "model" ? allow() : deny();
    },
    async protection(ctx, purpose = "active", transaction) {
      // Reuse the enclosing transaction: a second connection can deadlock and
      // cannot observe a cancellation written in this same transaction.
      const current = await resolve(ctx, true, true, purpose === "read_evidence", transaction);
      if (current.state !== "restricted") return null;
      const { pin } = current;
      return Object.freeze({
        schema: "foundry-builder-protection/1",
        claim: "native_builder_run_only",
        phaseRef: pin.phaseRef,
        policyDigest: pin.policyDigest,
        orgId: pin.orgId,
        taskId: pin.taskId,
        agentId: pin.agentId,
        runId: ctx.runId,
        expiresAt: pin.expiresAt,
        brain: "model",
      });
    },
    async sourceAllowed(ctx, sourceName) {
      // Native inventory precedes recording its initial model route. Listing
      // may admit null here; the source's actual checkCall/execute MUST require
      // protection(ctx), and beforeBrain rejects every non-model route.
      const current = await resolve(ctx, false);
      if (current.state === "unrestricted") return true;
      if (current.state !== "restricted" || toolContextDenied(ctx)) return false;
      return sourceName === "foundry" || reads.some((r) => r.sourceName === sourceName);
    },
    async check(ctx, tool, sourceName) {
      // Gateway uses this check for both listing and invoking. Foundry's own
      // execution guard additionally requires strict recorded-model protection.
      const current = await resolve(ctx, false);
      if (current.state === "unrestricted") return allow();
      if (current.state !== "restricted" || toolContextDenied(ctx) || !sourceName) return deny();
      if (reads.some((r) => r.sourceName === sourceName && sameTool(tool, r))) return allow();
      if (sourceName !== "foundry") return deny();
      const managementScope = Object.hasOwn(FOUNDRY_POLICY_MANAGEMENT, tool.name)
        ? FOUNDRY_POLICY_MANAGEMENT[tool.name as keyof typeof FOUNDRY_POLICY_MANAGEMENT]
        : null;
      if (managementScope) return sameTool(tool, { name: tool.name, scope: managementScope }) ? allow() : deny();
      if (!options.capabilities || !sameTool(tool, { name: tool.name, scope: "sandbox:run" })) return deny();
      try {
        const capabilities = await control(() => options.capabilities!(ctx));
        const exact =
          Array.isArray(capabilities) &&
          capabilities.some(
            (c) =>
              c &&
              UUID.test(c.candidateId) &&
              SHA256.test(c.digest) &&
              tool.name ===
                `foundry_receipt_normalizer_${c.candidateId.replaceAll("-", "").slice(0, 16)}_${c.digest.slice(0, 20)}`,
          );
        // Discovery may await I/O. A canceled, moved or expired run must not use its late answer.
        return exact && (await resolve(ctx, false)).state === "restricted" && !toolContextDenied(ctx)
          ? allow()
          : deny();
      } catch {
        return deny();
      }
    },
  };
}
