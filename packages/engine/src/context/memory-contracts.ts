import { createHash } from "node:crypto";
import type { ContextItem, ContextKind, Evidence } from "./items";

/**
 * The explicit map between the long-term memory contract (contracts/memory-item.schema.json) and native
 * `context_items` rows. Native rows stay the only authority: this reads them, it never writes, filters by
 * visibility or authorizes anything. A caller must run the native read/publication checks before using the result.
 * The envelope does not conform to the contract schema yet: anything native does not store is listed in
 * `unmappedFields`, never invented.
 */

export type LogicalMemoryKind =
  | "episode_reference"
  | "fact"
  | "preference"
  | "decision"
  | "lesson"
  | "checkpoint"
  | "skill_reference";
export type LogicalEvidenceClass = "observed" | "human_statement" | "tested" | "hypothesis";
export type LogicalMemoryStatus = "candidate" | "active" | "disputed" | "superseded" | "quarantined" | "deleted";

export type Mapped<T> = { ok: true; value: T } | { ok: false; reason: string };

const own = <V>(table: Partial<Record<string, V>>, key: string): V | undefined =>
  Object.hasOwn(table, key) ? table[key] : undefined;

const LOGICAL_OF_NATIVE: Partial<Record<ContextKind, LogicalMemoryKind>> = {
  fact: "fact",
  decision: "decision",
  preference: "preference",
  lesson: "lesson",
  thread_summary: "episode_reference",
  period_summary: "episode_reference",
};

/**
 * The native item kind a logical kind corresponds to. A mapping only: it grants no right to write. Episode
 * references are produced by the native summary job; checkpoints and skills belong to their own native owners.
 */
const NATIVE_OF_LOGICAL: Partial<Record<LogicalMemoryKind, ContextKind>> = {
  fact: "fact",
  decision: "decision",
  preference: "preference",
  lesson: "lesson",
};

export function logicalMemoryKind(kind: ContextKind): Mapped<LogicalMemoryKind> {
  const value = own(LOGICAL_OF_NATIVE, kind);
  return value ? { ok: true, value } : { ok: false, reason: `native kind ${kind} has no logical memory kind` };
}

export function nativeMemoryKind(kind: string): Mapped<ContextKind> {
  const value = own(NATIVE_OF_LOGICAL, kind);
  return value ? { ok: true, value } : { ok: false, reason: `logical kind ${kind} has no native item kind` };
}

/** `app` is a person's text sent through a connected app: outside content that never verifies (ADR 0119). */
const CLASS_OF_EVIDENCE: Record<Evidence["type"], LogicalEvidenceClass> = {
  outcome: "tested",
  human: "human_statement",
  app: "hypothesis",
  agent: "hypothesis",
  self: "hypothesis",
};
const CLASS_RANK: Record<LogicalEvidenceClass, number> = { tested: 3, human_statement: 2, observed: 1, hypothesis: 0 };

const supports = (e: Evidence) => Boolean(e.ref) && CLASS_OF_EVIDENCE[e.type] !== "hypothesis";

/**
 * The item-level ceiling: the strongest class among evidence entries that reference something. Native evidence is
 * attached to the whole item, so this does not prove that every assertion in its content was tested.
 */
export function logicalEvidenceClass(evidence: readonly Evidence[]): LogicalEvidenceClass {
  let best: LogicalEvidenceClass = "hypothesis";
  for (const e of evidence) {
    const c = e.ref ? own(CLASS_OF_EVIDENCE, e.type) : undefined;
    if (c && CLASS_RANK[c] > CLASS_RANK[best]) best = c;
  }
  return best;
}

/**
 * Active needs a source, supporting evidence and high trust; the row's generic `verified` flag is not used. Low trust
 * is sticky native taint (ADR 0120), so it caps the item at candidate. Archived without a successor has no logical
 * status: native deletion removes the row, so it is not "deleted". An outweighed claim kept as history behind a
 * stronger one is also archived with a successor, so it reads as superseded here.
 */
export function logicalMemoryStatus(
  item: Pick<ContextItem, "status" | "supersededBy" | "disputed" | "sourceIds" | "evidence" | "trust">,
): Mapped<LogicalMemoryStatus> {
  if (item.status === "archived")
    return item.supersededBy
      ? { ok: true, value: "superseded" }
      : { ok: false, reason: "archived without a successor has no logical status" };
  if (item.disputed) return { ok: true, value: "disputed" };
  const supported = item.trust === "high" && item.sourceIds.length > 0 && item.evidence.some(supports);
  return { ok: true, value: supported ? "active" : "candidate" };
}

/** Contract fields native rows do not store yet (T01/T02 schema work); readers must treat them as unknown. */
export const UNMAPPED_MEMORY_FIELDS = [
  "sourceRefs",
  "sourceRevision",
  "policyRevision",
  "audienceIds",
  "observedAt",
  "validFrom",
  "validTo",
  "expiresAt",
  "derivedFrom",
  "scope.projectId",
  "scope.personIds",
  "scope.authorityRef",
] as const;

export interface NativeMemoryEnvelope {
  schemaVersion: 1;
  itemId: string;
  version: number;
  /** Native rows change in place (merges add evidence without a version bump), so a version is not a snapshot. */
  immutableVersion: false;
  organizationId: string;
  kind: LogicalMemoryKind;
  subjectKey: string;
  title: string;
  content: string;
  sourceIds: string[];
  evidenceClass: LogicalEvidenceClass;
  trust: ContextItem["trust"];
  status: LogicalMemoryStatus;
  scope: {
    organizationId: string;
    scopeType: string;
    scopeId: string | null;
    agentId: string | null;
    channelIds: string[];
  };
  /** When the event happened in the world: native does not store it. */
  observedAt: null;
  /** Earliest time a supporting evidence entry was attached to the item; null when none was. */
  supportAttachedAt: string | null;
  /** Latest time native recorded a change to this row. */
  recordedAt: string;
  firstRecordedAt: string;
  validFrom: null;
  validTo: null;
  /** Native supersession points forward only (old.supersededBy = new); predecessors need a lookup. */
  supersedes: string[];
  supersededBy: string | null;
  contentHash: string;
  createdBy: { kind: "person" | "agent" | "service"; id: string | null };
  unmappedFields: readonly string[];
}

const CREATOR_KIND: Partial<Record<string, NativeMemoryEnvelope["createdBy"]["kind"]>> = {
  person: "person",
  agent: "agent",
  job: "service",
};

export function toMemoryEnvelope(item: ContextItem): Mapped<NativeMemoryEnvelope> {
  const kind = logicalMemoryKind(item.kind);
  if (!kind.ok) return kind;
  const status = logicalMemoryStatus(item);
  if (!status.ok) return status;
  const creator = own(CREATOR_KIND, item.createdByKind);
  if (!creator) return { ok: false, reason: `native creator ${item.createdByKind} has no logical creator kind` };
  const times = item.evidence
    .filter(supports)
    .map((e) => Date.parse(e.at))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  return {
    ok: true,
    value: {
      schemaVersion: 1,
      itemId: item.id,
      version: item.version,
      immutableVersion: false,
      organizationId: item.orgId,
      kind: kind.value,
      subjectKey: item.subjectKey,
      title: item.title,
      content: item.content,
      sourceIds: [...item.sourceIds],
      evidenceClass: logicalEvidenceClass(item.evidence),
      trust: item.trust,
      status: status.value,
      scope: {
        organizationId: item.orgId,
        scopeType: item.scopeType,
        scopeId: item.scopeId,
        agentId: item.agentId,
        channelIds: [...item.channelIds],
      },
      observedAt: null,
      supportAttachedAt: times.length ? new Date(times[0] as number).toISOString() : null,
      recordedAt: item.updatedAt.toISOString(),
      firstRecordedAt: item.createdAt.toISOString(),
      validFrom: null,
      validTo: null,
      supersedes: [],
      supersededBy: item.supersededBy,
      contentHash: createHash("sha256").update(item.content).digest("hex"),
      createdBy: { kind: creator, id: item.createdById },
      unmappedFields: UNMAPPED_MEMORY_FIELDS,
    },
  };
}
