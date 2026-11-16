import { isIP } from "node:net";
import { z } from "zod";

// RFC 3986 sections 3 and Appendix A: validate the submitted URI bytes without
// WHATWG URL normalization. Scheme-specific resolution and access stay native.
const uriToken = "(?:[A-Za-z0-9._~!$&'()*+,;=-]|%[0-9A-Fa-f]{2})";
const uriName = new RegExp(`^${uriToken}*$`);
const uriUserInfo = new RegExp(`^(?:${uriToken}|:)*$`);
const uriPath = new RegExp(`^(?:${uriToken}|[:@/])*$`);
const uriQueryOrFragment = new RegExp(`^(?:${uriToken}|[:@/?])*$`);
const uriFutureIP = /^v[0-9a-f]+\.[A-Za-z0-9._~!$&'()*+,;=:-]+$/i;

function validUriAuthority(authority: string): boolean {
  const at = authority.indexOf("@");
  if (at !== -1 && !uriUserInfo.test(authority.slice(0, at))) return false;
  const hostPort = authority.slice(at + 1);
  if (hostPort.startsWith("[")) {
    const end = hostPort.indexOf("]");
    if (end === -1) return false;
    const host = hostPort.slice(1, end);
    const suffix = hostPort.slice(end + 1);
    if (suffix !== "" && !/^:\d*$/.test(suffix)) return false;
    // isIP also recognizes scoped IPv6 on some runtimes; RFC 3986 does not.
    return uriFutureIP.test(host) || (/^[0-9a-f:.]+$/i.test(host) && isIP(host) === 6);
  }
  const colon = hostPort.lastIndexOf(":");
  const host = colon === -1 ? hostPort : hostPort.slice(0, colon);
  return uriName.test(host) && (colon === -1 || /^\d*$/.test(hostPort.slice(colon + 1)));
}

function validAbsoluteUri(value: string): boolean {
  // Reject original whitespace, controls and non-ASCII before parsing; never
  // repair a malformed reference or scan beyond the contract's input bound.
  if (value.length > 2000 || /[^\x21-\x7e]/.test(value)) return false;
  const parts = /^[A-Za-z][A-Za-z0-9+.-]*:(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(value);
  if (!parts) return false;
  const [, authority, path, query, fragment] = parts;
  if (!uriPath.test(path) || !uriQueryOrFragment.test(query ?? "") || !uriQueryOrFragment.test(fragment ?? "")) {
    return false;
  }
  if (authority === undefined) return !path.startsWith("//");
  return (path === "" || path.startsWith("/")) && validUriAuthority(authority);
}

// JSON Schema length bounds count Unicode code points, rather than UTF-16 units.
const text = (max: number) =>
  z.string().refine((value) => value.length > 0 && value.length <= max * 2 && [...value].length <= max);
const id = text(200);
const integer = z.number().int().nonnegative();
const timestamp = z.iso.datetime({ offset: true });
const visibility = z.enum(["agent", "project", "team", "person"]);
const trust = z.enum(["user_statement", "authorized_system", "independent_review", "agent_claim", "external_data"]);
const refs = (min: number, max: number) => z.array(id).min(min).max(max);
const texts = (min: number, max: number) => z.array(text(4000)).min(min).max(max);

export const ScopeSchema = z.strictObject({
  orgId: id,
  projectId: id.nullable(),
  visibility,
  personId: id.nullable().optional(),
});

export const EvidenceRefSchema = z.strictObject({
  id,
  kind: z.enum([
    "source_inspection",
    "test_result",
    "deployment_receipt",
    "live_check",
    "user_statement",
    "tool_receipt",
    "benchmark_result",
  ]),
  uri: z.string().max(2000).refine(validAbsoluteUri),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  sourceRevision: id.optional(),
  environment: id,
  observedAt: timestamp,
  scope: ScopeSchema,
  trust,
  status: z.enum(["valid", "expired", "revoked", "unknown"]),
});

export const ChecksSchema = z.strictObject({ passed: integer, failed: integer, notRun: integer, scope: text(4000) });
export const ClaimSchema = z.strictObject({
  text: text(4000),
  confidence: z.enum(["certain", "likely", "guessing"]),
  evidenceRefs: refs(0, 100),
  rationale: text(2000).optional(),
});
export const BlockerSchema = z.strictObject({ summary: text(4000), ownerRef: id, nextAdmissibleAction: text(4000) });
export const DeliveryStageSchema = z.enum([
  "SOURCE_INSPECTED",
  "CODED",
  "TESTED",
  "DEPLOYED",
  "LIVE_VERIFIED",
  "MEASURED_IMPROVEMENT",
]);

export const FounderUpdateSchema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  taskId: id,
  taskRevision: integer,
  runId: id,
  audience: id,
  locale: text(40),
  outcome: text(4000),
  claims: z.array(ClaimSchema).min(1).max(20),
  deliveryStage: DeliveryStageSchema.nullable(),
  checks: ChecksSchema,
  availability: z.enum(["not_available", "local", "preview", "production", "unknown"]),
  howToTry: text(2000).optional(),
  remaining: texts(0, 20),
  blocker: BlockerSchema.nullable().optional(),
  nextOwner: id,
  decisionNeeded: z.boolean(),
  evidenceRefs: refs(0, 100),
  generatedAt: timestamp,
});

export const ContextRefSchema = z.strictObject({ ref: text(2000), revision: id.nullable() });
export const KnownFactSchema = z.strictObject({ statement: text(4000), evidenceRefs: refs(1, 20) });
export const ActionScopeSchema = z.strictObject({
  allowedActions: refs(1, 40),
  deniedActions: refs(0, 40),
  resourceRefs: refs(1, 40),
});
export const BudgetSchema = z.strictObject({
  toolCalls: integer.max(10000),
  workerDepth: integer.min(1).max(10),
  outputChars: integer.min(1).max(1000000),
  nativeLimitRefs: refs(1, 20),
});
export const DeliverableSchema = z.strictObject({
  type: id,
  description: text(4000),
  requiredFields: z.array(text(100)).min(1).max(30),
});

export const HandoffPacketSchema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  orgId: id,
  projectId: id,
  taskId: id,
  taskRevision: integer,
  parentRunId: id,
  handoffId: id,
  ownerAgentId: id,
  assigneeAgentId: id,
  objective: text(4000),
  successCriteria: texts(1, 20),
  contextRefs: z.array(ContextRefSchema).min(1).max(30),
  knownFacts: z.array(KnownFactSchema).min(0).max(30),
  assumptions: texts(0, 20),
  unresolvedQuestions: texts(0, 20),
  actionScope: ActionScopeSchema,
  grantRef: id,
  leaseRef: id.optional(),
  budget: BudgetSchema,
  deadline: timestamp.optional(),
  deliverable: DeliverableSchema,
  stopConditions: texts(1, 20),
  idempotencyKey: text(250),
  createdAt: timestamp,
  expiresAt: timestamp,
});

export const LineageSchema = z.strictObject({
  sourceRef: text(2000),
  originKind: z.enum(["user", "tool", "document", "agent", "review"]),
  parentRefs: z.array(text(2000)).min(0).max(30),
  trust,
});
export const LessonCandidateSchema = z.strictObject({
  id,
  revision: integer,
  orgId: id,
  projectId: id.optional(),
  visibility,
  sourceTaskIds: refs(1, 30),
  sourceEvidenceRefs: refs(1, 30),
  provenanceLineage: z.array(LineageSchema).min(1).max(30),
  category: z.enum(["fact", "preference", "operational_lesson", "procedure", "skill_change"]),
  statement: text(4000),
  appliesWhen: texts(1, 20),
  doesNotApplyWhen: texts(1, 20),
  failureSignature: text(2000).optional(),
  proposedChange: text(4000).optional(),
  status: z.enum([
    "candidate",
    "verified",
    "shadow",
    "canary",
    "active",
    "disputed",
    "quarantined",
    "revoked",
    "archived",
  ]),
  independentReviewerRef: id.optional(),
  verificationRefs: refs(0, 30),
  expiresAt: timestamp.optional(),
  supersedes: id.optional(),
  rollbackRef: id.optional(),
  rejectionReason: text(4000).optional(),
});

export type Scope = z.infer<typeof ScopeSchema>;
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;
export type FounderUpdate = z.infer<typeof FounderUpdateSchema>;
export type HandoffPacket = z.infer<typeof HandoffPacketSchema>;
export type LessonCandidate = z.infer<typeof LessonCandidateSchema>;
export type DeliveryStage = z.infer<typeof DeliveryStageSchema>;
export type Lineage = z.infer<typeof LineageSchema>;

const schemas = {
  EvidenceRef: EvidenceRefSchema,
  FounderUpdate: FounderUpdateSchema,
  HandoffPacket: HandoffPacketSchema,
  LessonCandidate: LessonCandidateSchema,
};
export type ContractName = keyof typeof schemas;
export type ContractValues = { [K in ContractName]: z.infer<(typeof schemas)[K]> };
export type ValidationIssue = { code: string; path: string; message: string };
export type ContractValidation<K extends ContractName = ContractName> =
  | { ok: true; value: ContractValues[K] }
  | { ok: false; issues: ValidationIssue[] };

/** Structural validation only: trust/status/grant fields are claims, never authority. */
export function validateEnvelope<K extends ContractName>(kind: K, payload: unknown): ContractValidation<K> {
  if (!Object.hasOwn(schemas, kind)) {
    return { ok: false, issues: [{ code: "unknown_contract", path: "", message: "Unknown contract type" }] };
  }
  const result = schemas[kind].safeParse(payload);
  if (result.success) return { ok: true, value: result.data as ContractValues[K] };
  // Zod's messages can contain submitted values or unknown key names. Return only
  // static messages and schema paths, capped to keep error responses bounded.
  return {
    ok: false,
    issues: result.error.issues.slice(0, 20).map((issue) => ({
      code: issue.code,
      path: issue.path.map(String).join("."),
      message: "Invalid contract field",
    })),
  };
}

/**
 * Supplied exclusively by a server adapter after native identity/task/grant
 * lookups. It is not an input schema, capability, or replacement grant record.
 * The adapter must still check current native permissions, limits and leases.
 */
export type HandoffBindingContext = {
  orgId: string;
  projectId: string;
  taskId: string;
  taskRevision: number;
  parentRunId: string;
  ownerAgentId: string;
  assigneeAgentId: string;
  grant: { ref: string; orgId: string; projectId: string } | null;
};
export type HandoffBindingCheck = { ok: true } | { ok: false; issues: ValidationIssue[] };

/** Consistency only. A successful comparison does not admit or authorize work. */
export function checkHandoffBinding(packet: HandoffPacket, resolved: HandoffBindingContext): HandoffBindingCheck {
  const issues: ValidationIssue[] = [];
  const mismatch = (path: string) =>
    issues.push({ code: "native_binding_mismatch", path, message: "Native binding does not match" });
  for (const key of [
    "orgId",
    "projectId",
    "taskId",
    "taskRevision",
    "parentRunId",
    "ownerAgentId",
    "assigneeAgentId",
  ] as const) {
    if (packet[key] !== resolved[key]) mismatch(key);
  }
  if (
    !resolved.grant ||
    resolved.grant.ref !== packet.grantRef ||
    resolved.grant.orgId !== resolved.orgId ||
    resolved.grant.projectId !== resolved.projectId
  ) {
    mismatch("grantRef");
  }
  return issues.length ? { ok: false, issues } : { ok: true };
}
