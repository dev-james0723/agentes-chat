import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  type ContextItem,
  logicalEvidenceClass,
  logicalMemoryKind,
  logicalMemoryStatus,
  nativeMemoryKind,
  toMemoryEnvelope,
} from "../src";

const item = (patch: Partial<ContextItem> = {}): ContextItem => ({
  id: "0196a000-0000-7000-8000-000000000001",
  orgId: "0196a000-0000-7000-8000-0000000000aa",
  kind: "fact",
  scopeType: "org",
  scopeId: null,
  agentId: null,
  subjectKey: "deploy host",
  title: "Deploy host",
  content: "The app deploys to host A.",
  sourceIds: ["0196a000-0000-7000-8000-0000000000b1"],
  channelIds: [],
  trust: "high",
  verified: true,
  evidence: [{ type: "human", ref: "msg-1", at: "2026-11-01T10:00:00.000Z" }],
  confidence: 0.7,
  relevance: 0.5,
  useCount: 0,
  recurrence: 1,
  lastUsedAt: null,
  pinned: false,
  relatedIds: [],
  disputed: false,
  status: "active",
  supersededBy: null,
  version: 1,
  coversUntil: null,
  createdByKind: "person",
  createdById: "person-1",
  proposedAt: null,
  createdAt: new Date("2026-11-10T08:00:00.000Z"),
  updatedAt: new Date("2026-11-10T08:00:00.000Z"),
  ...patch,
});

describe("logical ↔ native memory kinds are mapped explicitly (A05)", () => {
  test("shared kinds map one to one, both ways", () => {
    for (const k of ["fact", "decision", "preference", "lesson"] as const) {
      expect(logicalMemoryKind(k)).toEqual({ ok: true, value: k });
      expect(nativeMemoryKind(k)).toEqual({ ok: true, value: k });
    }
  });

  test("native summaries are episode references; an episode reference has no single native kind to write", () => {
    expect(logicalMemoryKind("thread_summary")).toEqual({ ok: true, value: "episode_reference" });
    expect(logicalMemoryKind("period_summary")).toEqual({ ok: true, value: "episode_reference" });
    expect(nativeMemoryKind("episode_reference").ok).toBe(false);
  });

  test("native kinds without a logical meaning are refused, not guessed", () => {
    for (const k of ["rule", "note", "open_question", "entity_profile"] as const) {
      const r = logicalMemoryKind(k);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain(k);
    }
  });

  test("checkpoints and skill references stay with their own native owners; unknown names are refused", () => {
    expect(nativeMemoryKind("checkpoint").ok).toBe(false);
    expect(nativeMemoryKind("skill_reference").ok).toBe(false);
    expect(nativeMemoryKind("lessons").ok).toBe(false);
    expect(logicalMemoryKind("lessons" as ContextItem["kind"]).ok).toBe(false);
  });
});

describe("evidence class follows the strongest actual evidence, never the generic verified flag (A06)", () => {
  test("outcome → tested, human → human_statement", () => {
    expect(logicalEvidenceClass([{ type: "outcome", ref: "o1", at: "2026-11-01T00:00:00Z" }])).toBe("tested");
    expect(logicalEvidenceClass([{ type: "human", ref: "m1", at: "2026-11-01T00:00:00Z" }])).toBe("human_statement");
  });

  test("text sent through a connected app is outside content and never supports a claim (ADR 0119)", () => {
    const appOnly = item({ evidence: [{ type: "app", ref: "person-1", at: "2026-11-01T00:00:00Z" }] });
    expect(logicalEvidenceClass(appOnly.evidence)).toBe("hypothesis");
    expect(logicalMemoryStatus(appOnly)).toEqual({ ok: true, value: "candidate" });
  });

  test("agent claims, self claims and no evidence are hypotheses", () => {
    expect(logicalEvidenceClass([{ type: "agent", ref: "r1", agentId: "x", at: "2026-11-01T00:00:00Z" }])).toBe(
      "hypothesis",
    );
    expect(logicalEvidenceClass([{ type: "self", ref: "r1", agentId: "x", at: "2026-11-01T00:00:00Z" }])).toBe(
      "hypothesis",
    );
    expect(logicalEvidenceClass([])).toBe("hypothesis");
  });

  test("an evidence entry without a reference supports nothing", () => {
    expect(logicalEvidenceClass([{ type: "outcome", ref: "", at: "2026-11-01T00:00:00Z" }])).toBe("hypothesis");
  });
});

describe("only a supported claim is active (A06)", () => {
  test("a supported, uncontested current item is active", () => {
    expect(logicalMemoryStatus(item())).toEqual({ ok: true, value: "active" });
  });

  test("a source-less claim is only a candidate, even when the row says verified", () => {
    expect(logicalMemoryStatus(item({ sourceIds: [], evidence: [], verified: true }))).toEqual({
      ok: true,
      value: "candidate",
    });
  });

  test("an unsupported assertion stays a candidate even with sources and a verified flag", () => {
    const selfOnly = item({ evidence: [{ type: "self", ref: "run-1", agentId: "a", at: "2026-11-01T00:00:00Z" }] });
    expect(logicalMemoryStatus(selfOnly)).toEqual({ ok: true, value: "candidate" });
    expect(toMemoryEnvelope(selfOnly).ok && toMemoryEnvelope(selfOnly)).toMatchObject({
      value: { evidenceClass: "hypothesis", status: "candidate" },
    });
  });

  test("low trust caps the item at candidate, even with a person's quoted words (ADR 0120, 0167)", () => {
    const tainted = item({
      trust: "low",
      verified: false,
      evidence: [{ type: "human", ref: "msg-9", at: "2026-11-01T00:00:00Z", quote: true }],
    });
    expect(logicalMemoryStatus(tainted)).toEqual({ ok: true, value: "candidate" });
    const r = toMemoryEnvelope(tainted);
    expect(r.ok && r.value.trust).toBe("low");
  });

  test("disputed stays disputed; archived with a successor is superseded", () => {
    expect(logicalMemoryStatus(item({ disputed: true }))).toEqual({ ok: true, value: "disputed" });
    expect(logicalMemoryStatus(item({ status: "archived", supersededBy: "next" }))).toEqual({
      ok: true,
      value: "superseded",
    });
  });

  test("archived without a successor is not called deleted (native delete removes the row)", () => {
    const r = logicalMemoryStatus(item({ status: "archived", supersededBy: null }));
    expect(r.ok).toBe(false);
  });
});

describe("the envelope carries native identity, scope and time without inventing what native does not store", () => {
  test("evidence time differs from recorded time; observed time and validity stay unknown", () => {
    const r = toMemoryEnvelope(item());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.supportAttachedAt).toBe("2026-11-01T10:00:00.000Z");
    expect(r.value.recordedAt).toBe("2026-11-10T08:00:00.000Z");
    expect(r.value.observedAt).toBeNull();
    expect(r.value.validFrom).toBeNull();
    expect(r.value.validTo).toBeNull();
    expect(r.value.unmappedFields).toEqual(
      expect.arrayContaining([
        "policyRevision",
        "sourceRevision",
        "audienceIds",
        "validFrom",
        "validTo",
        "observedAt",
        "sourceRefs",
      ]),
    );
  });

  test("only supporting evidence dates support; hypotheses add no time", () => {
    const r = toMemoryEnvelope(
      item({
        evidence: [
          { type: "self", ref: "run-0", agentId: "a", at: "2026-10-01T00:00:00.000Z" },
          { type: "human", ref: "msg-1", at: "2026-11-01T10:00:00.000Z" },
        ],
      }),
    );
    expect(r.ok && r.value.supportAttachedAt).toBe("2026-11-01T10:00:00.000Z");
    const none = toMemoryEnvelope(item({ evidence: [] }));
    expect(none.ok && none.value.supportAttachedAt).toBeNull();
  });

  test("a row changed in place reports its latest record time and is not an immutable version", () => {
    const r = toMemoryEnvelope(item({ version: 2, updatedAt: new Date("2026-11-12T09:00:00.000Z") }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.recordedAt).toBe("2026-11-12T09:00:00.000Z");
    expect(r.value.firstRecordedAt).toBe("2026-11-10T08:00:00.000Z");
    expect(r.value.immutableVersion).toBe(false);
  });

  test("same-named items in different scopes stay distinct", () => {
    const a = toMemoryEnvelope(item({ scopeType: "channel", scopeId: "chan-a" }));
    const b = toMemoryEnvelope(
      item({ id: "0196a000-0000-7000-8000-000000000002", scopeType: "channel", scopeId: "chan-b" }),
    );
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value.subjectKey).toBe(b.value.subjectKey);
    expect(a.value.itemId).not.toBe(b.value.itemId);
    expect(a.value.scope).not.toEqual(b.value.scope);
  });

  test("identity, version, hash and creator map from the native row", () => {
    const r = toMemoryEnvelope(item({ version: 3, createdByKind: "job", createdById: null }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({
      schemaVersion: 1,
      itemId: "0196a000-0000-7000-8000-000000000001",
      version: 3,
      organizationId: "0196a000-0000-7000-8000-0000000000aa",
      kind: "fact",
      evidenceClass: "human_statement",
      createdBy: { kind: "service", id: null },
      contentHash: createHash("sha256").update("The app deploys to host A.").digest("hex"),
    });
  });

  test("creator kinds are looked up as own keys only", () => {
    for (const k of ["constructor", "__proto__", "toString", "robot"])
      expect(toMemoryEnvelope(item({ createdByKind: k })).ok).toBe(false);
  });

  test("an unmappable kind or status refuses the whole envelope", () => {
    expect(toMemoryEnvelope(item({ kind: "rule" })).ok).toBe(false);
    expect(toMemoryEnvelope(item({ status: "archived" })).ok).toBe(false);
  });
});
