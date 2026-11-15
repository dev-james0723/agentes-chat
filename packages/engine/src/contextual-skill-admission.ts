/**
 * A deterministic decision primitive, not a tool or an authority store. Native adapters must supply facts from
 * their current run, actor, assignment and policy checks; accepting model-supplied facts would bypass that contract.
 * An ALLOW result grants nothing, consumes no use and stops no process. A future adapter must atomically claim a
 * permitted use and recheck at execution, including after approval/resume. Existing gateway checks remain required.
 */
export type SkillActivationScope = { kind: "run" | "task" | "session"; id: string };

export interface SkillAuthorityBinding {
  kind: "person" | "routine" | "unattended";
  personId: string | null;
  routineId: string | null;
  fingerprint: string;
}

export interface SkillActivationEnvelopeV1 {
  schemaVersion: 1;
  id: string;
  orgId: string;
  agentId: string;
  runId: string;
  taskId: string | null;
  sessionId: string | null;
  authority: SkillAuthorityBinding;
  skillId: string;
  skillVersion: number;
  contentHash: string;
  scope: SkillActivationScope;
  approvalId: string | null;
  purposeHash: string;
  contextVersion: string;
  capabilityVersion: string;
  policyVersion: string;
  issuedAt: number;
  expiresAt: number;
  revokedAt: number | null;
  maxUses: number | null;
  usedCount: number;
}

export interface SkillUseApprovalV1 {
  id: string;
  orgId: string;
  agentId: string;
  skillId: string;
  skillVersion: number;
  contentHash: string;
  scope: SkillActivationScope;
  purposeHash: string;
  status: "pending" | "approved" | "refused" | "expired";
  expiresAt: number;
  maxUses: number | null;
}

/** Projections must come from trusted native reads, not from a skill's text or a model's claim of permission. */
export interface SkillAdmissionFactsV1 {
  schemaVersion: 1;
  serverNow: number;
  checkedAt: number;
  maxAgeMs: number;
  envelopeVerified: boolean;
  orgId: string;
  agentId: string;
  runId: string;
  taskId: string | null;
  sessionId: string | null;
  authority: SkillAuthorityBinding;
  runStatus: "running" | "queued" | "waiting_input" | "waiting_approval" | "done" | "failed" | "canceled";
  taskState: "none" | "open" | "terminal" | "unknown";
  sessionState: "none" | "active" | "terminal" | "unknown";
  actorAllowed: boolean;
  agentArchived: boolean;
  assignmentEnabled: boolean;
  skillDeleted: boolean;
  skillId: string;
  skillVersion: number;
  contentHash: string;
  purposeHash: string;
  underlyingAuthority: "allowed" | "denied" | "unknown";
  contextVersion: string;
  capabilityVersion: string;
  policyVersion: string;
  requiresOwnerApproval: boolean;
  approval: SkillUseApprovalV1 | null;
}

export type SkillAdmissionDecision = {
  decision: "ALLOW" | "REVALIDATE" | "NEEDS_OWNER" | "BLOCKED";
  reason: string;
};

const ENVELOPE_KEYS = [
  "schemaVersion",
  "id",
  "orgId",
  "agentId",
  "runId",
  "taskId",
  "sessionId",
  "authority",
  "skillId",
  "skillVersion",
  "contentHash",
  "scope",
  "approvalId",
  "purposeHash",
  "contextVersion",
  "capabilityVersion",
  "policyVersion",
  "issuedAt",
  "expiresAt",
  "revokedAt",
  "maxUses",
  "usedCount",
];
const FACT_KEYS = [
  "schemaVersion",
  "serverNow",
  "checkedAt",
  "maxAgeMs",
  "envelopeVerified",
  "orgId",
  "agentId",
  "runId",
  "taskId",
  "sessionId",
  "authority",
  "runStatus",
  "taskState",
  "sessionState",
  "actorAllowed",
  "agentArchived",
  "assignmentEnabled",
  "skillDeleted",
  "skillId",
  "skillVersion",
  "contentHash",
  "purposeHash",
  "underlyingAuthority",
  "contextVersion",
  "capabilityVersion",
  "policyVersion",
  "requiresOwnerApproval",
  "approval",
];
const APPROVAL_KEYS = [
  "id",
  "orgId",
  "agentId",
  "skillId",
  "skillVersion",
  "contentHash",
  "scope",
  "purposeHash",
  "status",
  "expiresAt",
  "maxUses",
];

function record(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  return (
    actual.length === keys.length &&
    keys.every((key) => {
      const d = descriptors[key];
      return d !== undefined && "value" in d && d.enumerable;
    })
  );
}
const id = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9_.:/-]{1,256}$/.test(v);
const nullableId = (v: unknown): v is string | null => v === null || id(v);
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const positive = (v: unknown): v is number => integer(v) && v > 0;
const nullableInteger = (v: unknown): v is number | null => v === null || integer(v);
const uses = (v: unknown): v is number | null => v === null || positive(v);
const oneOf = (v: unknown, allowed: readonly string[]) => typeof v === "string" && allowed.includes(v);

function scope(value: unknown): value is SkillActivationScope {
  return record(value, ["kind", "id"]) && oneOf(value.kind, ["run", "task", "session"]) && id(value.id);
}
function authority(value: unknown): value is SkillAuthorityBinding {
  if (!record(value, ["kind", "personId", "routineId", "fingerprint"]) || !hash(value.fingerprint)) return false;
  return value.kind === "person"
    ? id(value.personId) && value.routineId === null
    : value.kind === "routine"
      ? value.personId === null && id(value.routineId)
      : value.kind === "unattended" && value.personId === null && value.routineId === null;
}
function envelope(value: unknown): value is SkillActivationEnvelopeV1 {
  return (
    record(value, ENVELOPE_KEYS) &&
    value.schemaVersion === 1 &&
    [value.id, value.orgId, value.agentId, value.runId, value.skillId, value.policyVersion].every(id) &&
    nullableId(value.taskId) &&
    nullableId(value.sessionId) &&
    nullableId(value.approvalId) &&
    authority(value.authority) &&
    positive(value.skillVersion) &&
    scope(value.scope) &&
    [value.contentHash, value.purposeHash, value.contextVersion, value.capabilityVersion].every(hash) &&
    integer(value.issuedAt) &&
    integer(value.expiresAt) &&
    value.expiresAt > value.issuedAt &&
    nullableInteger(value.revokedAt) &&
    uses(value.maxUses) &&
    integer(value.usedCount)
  );
}
function approval(value: unknown): value is SkillUseApprovalV1 {
  return (
    record(value, APPROVAL_KEYS) &&
    [value.id, value.orgId, value.agentId, value.skillId].every(id) &&
    positive(value.skillVersion) &&
    [value.contentHash, value.purposeHash].every(hash) &&
    scope(value.scope) &&
    oneOf(value.status, ["pending", "approved", "refused", "expired"]) &&
    integer(value.expiresAt) &&
    uses(value.maxUses)
  );
}
function facts(value: unknown): value is SkillAdmissionFactsV1 {
  return (
    record(value, FACT_KEYS) &&
    value.schemaVersion === 1 &&
    [value.serverNow, value.checkedAt].every(integer) &&
    positive(value.maxAgeMs) &&
    [value.orgId, value.agentId, value.runId, value.skillId, value.policyVersion].every(id) &&
    nullableId(value.taskId) &&
    nullableId(value.sessionId) &&
    authority(value.authority) &&
    oneOf(value.runStatus, ["running", "queued", "waiting_input", "waiting_approval", "done", "failed", "canceled"]) &&
    oneOf(value.taskState, ["none", "open", "terminal", "unknown"]) &&
    oneOf(value.sessionState, ["none", "active", "terminal", "unknown"]) &&
    [
      value.envelopeVerified,
      value.actorAllowed,
      value.agentArchived,
      value.assignmentEnabled,
      value.skillDeleted,
      value.requiresOwnerApproval,
    ].every((v) => typeof v === "boolean") &&
    positive(value.skillVersion) &&
    [value.contentHash, value.purposeHash, value.contextVersion, value.capabilityVersion].every(hash) &&
    oneOf(value.underlyingAuthority, ["allowed", "denied", "unknown"]) &&
    (value.approval === null || approval(value.approval))
  );
}
const blocked = (reason: string): SkillAdmissionDecision => ({ decision: "BLOCKED", reason });
const revalidate = (reason: string): SkillAdmissionDecision => ({ decision: "REVALIDATE", reason });

/** No network, DB writes, card creation or use consumption. This must not be registered directly as a model tool. */
export function decideSkillAdmission(inputEnvelope: unknown, inputFacts: unknown): SkillAdmissionDecision {
  try {
    if (!envelope(inputEnvelope)) return blocked("invalid_envelope");
    if (!facts(inputFacts)) return blocked("invalid_facts");
    const e = inputEnvelope;
    const f = inputFacts;
    if (!f.envelopeVerified) return blocked("unverified_envelope");
    if (
      e.orgId !== f.orgId ||
      e.agentId !== f.agentId ||
      e.runId !== f.runId ||
      e.taskId !== f.taskId ||
      e.sessionId !== f.sessionId ||
      e.skillId !== f.skillId
    )
      return blocked("boundary_mismatch");
    const expectedScope = e.scope.kind === "run" ? f.runId : e.scope.kind === "task" ? f.taskId : f.sessionId;
    if (expectedScope === null || e.scope.id !== expectedScope) return blocked("boundary_mismatch");
    if (
      e.authority.kind !== f.authority.kind ||
      e.authority.personId !== f.authority.personId ||
      e.authority.routineId !== f.authority.routineId ||
      e.authority.fingerprint !== f.authority.fingerprint
    )
      return blocked("authority_mismatch");
    if (!f.actorAllowed) return blocked("actor_not_allowed");
    if (f.agentArchived) return blocked("agent_archived");
    if (f.runStatus !== "running") return blocked("run_not_running");
    if (f.taskState === "terminal") return blocked("task_ended");
    if (f.sessionState === "terminal") return blocked("session_ended");
    if ((f.sessionId === null) !== (f.sessionState === "none")) return blocked("invalid_facts");
    if ((f.taskId === null) !== (f.taskState === "none")) return blocked("invalid_facts");
    if (!f.assignmentEnabled) return blocked("assignment_revoked");
    if (f.skillDeleted) return blocked("skill_deleted");
    if (
      e.issuedAt > f.serverNow ||
      f.checkedAt > f.serverNow ||
      (e.revokedAt !== null && (e.revokedAt > f.serverNow || e.revokedAt < e.issuedAt))
    )
      return blocked("invalid_clock");
    if (e.revokedAt !== null) return blocked("revoked");
    if (e.expiresAt <= f.serverNow) return blocked("expired");
    if (f.underlyingAuthority === "denied") return blocked("underlying_denied");
    if (e.purposeHash !== f.purposeHash) return blocked("purpose_mismatch");
    const a = f.approval;
    if (e.approvalId !== (a?.id ?? null)) return blocked("approval_mismatch");
    if (a) {
      if (
        a.orgId !== e.orgId ||
        a.agentId !== e.agentId ||
        a.skillId !== e.skillId ||
        a.skillVersion !== e.skillVersion ||
        a.contentHash !== e.contentHash ||
        a.scope.kind !== e.scope.kind ||
        a.scope.id !== e.scope.id ||
        a.purposeHash !== e.purposeHash
      )
        return blocked("approval_mismatch");
      if (a.status === "refused") return blocked("approval_refused");
      if (a.status === "expired" || a.expiresAt <= f.serverNow) return blocked("approval_expired");
      if (e.expiresAt > a.expiresAt || (a.maxUses !== null && (e.maxUses === null || e.maxUses > a.maxUses)))
        return blocked("approval_bounds");
    }
    if (e.maxUses !== null && e.usedCount >= e.maxUses) return blocked("uses_exhausted");
    if (e.skillVersion !== f.skillVersion || e.contentHash !== f.contentHash) return revalidate("skill_changed");
    if (
      e.contextVersion !== f.contextVersion ||
      e.capabilityVersion !== f.capabilityVersion ||
      e.policyVersion !== f.policyVersion
    )
      return revalidate("context_changed");
    if (f.serverNow - f.checkedAt > f.maxAgeMs) return revalidate("facts_stale");
    if (f.underlyingAuthority === "unknown") return revalidate("authority_unknown");
    if (f.taskState === "unknown") return revalidate("task_unknown");
    if (f.sessionState === "unknown") return revalidate("session_unknown");
    if (a?.status === "pending") return { decision: "NEEDS_OWNER", reason: "approval_pending" };
    if (f.requiresOwnerApproval && !a) return { decision: "NEEDS_OWNER", reason: "approval_required" };
    return { decision: "ALLOW", reason: "eligible" };
  } catch {
    return blocked("invalid_input");
  }
}
