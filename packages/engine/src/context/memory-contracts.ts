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
  "policyRevision",
  "audienceIds",
  "observedAt",
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
  /** When the claim holds in the world, half-open; null = unknown or unbounded. */
  validFrom: string | null;
  validTo: string | null;
  /** The source revision it was read from; null = not recorded (every row written before T01). */
  sourceRevision: string | null;
  /** When a successor replaced it (known time); null when current or superseded before this was recorded. */
  supersededAt: string | null;
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
      validFrom: item.validFrom?.toISOString() ?? null,
      validTo: item.validTo?.toISOString() ?? null,
      sourceRevision: item.sourceRevision,
      // A version that un-superseded a row without clearing its time (before T01) must not look replaced.
      supersededAt: item.supersededBy ? (item.supersededAt?.toISOString() ?? null) : null,
      supersedes: [],
      supersededBy: item.supersededBy,
      contentHash: createHash("sha256").update(item.content).digest("hex"),
      createdBy: { kind: creator, id: item.createdById },
      unmappedFields: UNMAPPED_MEMORY_FIELDS,
    },
  };
}

/**
 * Bitemporal view over rows the caller has already authorized: `knownAt` is what memory held at that time (recorded
 * by then, not yet superseded); `asOf` is what holds in the world then (validity half-open, unknown bounds open). A
 * late correction adds a successor, so earlier known-time views keep showing what was believed then.
 *
 * A successor that starts later in the world than its predecessor ("Paris from January", then "Tokyo from
 * February") is a change over time, not a correction: asked about a time before the successor starts, the
 * predecessor still answers, up to the successor's start. A successor with no start, or one starting no later than
 * its predecessor, corrects it everywhere. The successor must be among `items` for this; otherwise the predecessor
 * stays out. Rows archived without a successor, and superseded rows whose supersession time was never recorded,
 * have no reliable known-time span and are left out. Not an authorization or visibility check.
 */
export function memoryViewAt<
  T extends Pick<
    ContextItem,
    "id" | "status" | "supersededBy" | "supersededAt" | "createdAt" | "validFrom" | "validTo"
  >,
>(items: readonly T[], at: { knownAt?: Date; asOf?: Date }): T[] {
  const known = at.knownAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const asOf = at.asOf?.getTime();
  const byId = new Map(items.map((i) => [i.id, i]));
  return items.filter((i) => {
    if (i.status === "archived" && !i.supersededBy) return false;
    if (i.createdAt.getTime() > known) return false;
    let validTo = i.validTo?.getTime();
    if (i.supersededBy) {
      if (!i.supersededAt) return false;
      if (i.supersededAt.getTime() <= known) {
        // Replaced by then: only a later-starting successor leaves it the time before that start.
        const next = byId.get(i.supersededBy)?.validFrom?.getTime();
        const laterStart = next !== undefined && (!i.validFrom || next > i.validFrom.getTime());
        if (!laterStart || asOf === undefined || asOf >= next) return false;
        validTo = validTo === undefined ? next : Math.min(validTo, next);
      }
    }
    if (asOf === undefined) return true;
    if (i.validFrom && i.validFrom.getTime() > asOf) return false;
    if (validTo !== undefined && validTo <= asOf) return false;
    return true;
  });
}
