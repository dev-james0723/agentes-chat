import { describe, expect, test } from "bun:test";
import type { EvidenceRef, FounderUpdate } from "../src/communication-contracts";
import {
  clarificationFor,
  deriveDeliveryStage,
  FounderProjectionSchema,
  type NativeFounderReceipt,
  projectFounderUpdate,
  projectNativeIssueUpdate,
  type ResolvedFounderEvidence,
  resolveFounderEvidence,
  shouldEmitFounderUpdate,
  type TaskSnapshot,
  validateClaimSupport,
} from "../src/founder-updates";

const task: TaskSnapshot = {
  orgId: "org-1",
  projectId: "project-1",
  taskId: "task-1",
  revision: 3,
  runId: "run-1",
  audience: "person-1",
  owner: { type: "agent", id: "agent-1" },
  artifactRef: "artifact-1",
  artifactRevision: "git-3",
  artifactKind: "code",
  environment: "preview",
  lifecycle: "in_progress",
  generatedAt: "2026-11-16T12:00:00Z",
  checks: { passed: 4, failed: 1, notRun: 2, scope: "local unit tests" },
  remaining: ["Resolve the failed check"],
  blocker: null,
  decisionNeeded: false,
  howToTry: null,
};
const ref: EvidenceRef = {
  id: "receipt-1",
  kind: "source_inspection",
  uri: "urn:artifact:artifact-1",
  sourceRevision: "git-3",
  environment: "preview",
  observedAt: task.generatedAt,
  scope: { orgId: "org-1", projectId: "project-1", visibility: "project" },
  trust: "authorized_system",
  status: "valid",
};
const receipt: NativeFounderReceipt = {
  reference: ref,
  taskId: "task-1",
  taskRevision: 3,
  artifactRef: "artifact-1",
  artifactRevision: "git-3",
  issuer: { id: "source-runner-1", kind: "source_inspector" },
  stage: "SOURCE_INSPECTED",
};
const preferences = { locale: "zh-HK", style: "simple" as const };
const resolved = (value: NativeFounderReceipt = receipt, snapshot = task) =>
  resolveFounderEvidence(snapshot, [value.reference.id], { resolve: async () => value });

describe("deterministic founder projection", () => {
  test("source_only_is_not_live", async () => {
    const evidence = await resolved();
    expect(deriveDeliveryStage(task, evidence)).toBe("SOURCE_INSPECTED");
    const view = projectFounderUpdate(task, evidence, preferences);
    expect(view.contract).not.toBeNull();
    const update = { ...view.contract, deliveryStage: "LIVE_VERIFIED" } as FounderUpdate;
    expect(validateClaimSupport(update, task, evidence).ok).toBe(false);
    expect(deriveDeliveryStage(task, [ref as unknown as ResolvedFounderEvidence])).toBeNull();
  });

  test("wrong_revision_receipt_is_rejected", async () => {
    const evidence = await resolved({
      ...receipt,
      artifactRevision: "git-2",
      reference: { ...ref, sourceRevision: "git-2" },
    });
    expect(deriveDeliveryStage(task, evidence)).toBeNull();
    expect(deriveDeliveryStage({ ...task, revision: 4 }, await resolved())).toBeNull();
  });

  test("preview_is_not_production", async () => {
    const evidence = await resolved({
      ...receipt,
      stage: "DEPLOYED",
      issuer: { id: "release-1", kind: "release_controller" },
      reference: { ...ref, kind: "deployment_receipt" },
    });
    const view = projectFounderUpdate(task, evidence, preferences);
    expect(view.availability).toBe("preview");
    expect(
      validateClaimSupport({ ...view.contract, availability: "production" } as FounderUpdate, task, evidence).ok,
    ).toBe(false);
    expect(deriveDeliveryStage({ ...task, environment: "production" }, evidence)).toBeNull();
  });

  test("benchmark evidence does not imply deployed availability", async () => {
    const evidence = await resolved({
      ...receipt,
      stage: "MEASURED_IMPROVEMENT",
      issuer: { id: "benchmark-1", kind: "benchmark_runner" },
      reference: { ...ref, kind: "benchmark_result" },
    });
    const view = projectFounderUpdate(task, evidence, preferences);
    expect(view.deliveryStage).toBe("MEASURED_IMPROVEMENT");
    expect(view.availability).toBe("unknown");
  });

  test("failed_checks_remain_visible", () => {
    const view = projectFounderUpdate(task, [], preferences);
    expect(view.checks).toEqual(task.checks);
    expect(view.contract?.checks).toEqual(task.checks);
    expect(view.availability).toBe("unknown");
    expect(view.deliveryStage).toBeNull();
  });

  test("unknown_checks_are_not_zero_failures", () => {
    const view = projectFounderUpdate({ ...task, checks: null }, [], preferences);
    expect(view.checks).toBeNull();
    expect(view.contract).toBeNull();
    expect(view.contractUnavailable).toContain("checks");
  });

  test("no_extra_model_call", () => {
    const first = projectFounderUpdate(task, [], preferences);
    expect(first).toEqual(projectFounderUpdate(task, [], preferences));
    expect(first).not.toBeInstanceOf(Promise);
  });

  test("known_decision_is_not_reasked", () => {
    expect(
      clarificationFor({ release: "Use preview" }, { key: "release", question: "Which environment?", material: true }),
    ).toBeNull();
  });

  test("material_gap_requires_narrow_question", () => {
    expect(clarificationFor({}, { key: "release", question: "Preview or production?", material: true })).toBe(
      "Preview or production?",
    );
    expect(clarificationFor({}, { key: "wording", question: "Which title?", material: false })).toBeNull();
  });

  test("issuer, viewer scope, revocation and document checks cannot mint delivery proof", async () => {
    const spoof = { ...receipt, stage: "DEPLOYED" as const };
    expect(deriveDeliveryStage(task, await resolved(spoof))).toBeNull();
    for (const status of ["revoked", "expired", "unknown"] as const) {
      expect(deriveDeliveryStage(task, await resolved({ ...receipt, reference: { ...ref, status } }))).toBeNull();
    }
    expect(
      deriveDeliveryStage(
        task,
        await resolved({ ...receipt, reference: { ...ref, scope: { ...ref.scope, orgId: "other" } } }),
      ),
    ).toBeNull();
    const tested = {
      ...receipt,
      stage: "TESTED" as const,
      issuer: { id: "test-1", kind: "test_runner" as const },
      reference: { ...ref, kind: "test_result" as const },
    };
    expect(deriveDeliveryStage({ ...task, artifactKind: "document" }, await resolved(tested))).toBeNull();
    expect(
      deriveDeliveryStage(task, await resolveFounderEvidence(task, [ref.id], { resolve: async () => null })),
    ).toBeNull();
  });

  test("task identity and claimed evidence references are validated", async () => {
    const evidence = await resolved();
    const view = projectFounderUpdate(task, evidence, preferences);
    expect(validateClaimSupport({ ...view.contract, taskRevision: 2 } as FounderUpdate, task, evidence).ok).toBe(false);
    expect(
      validateClaimSupport({ ...view.contract, evidenceRefs: ["missing"] } as FounderUpdate, task, evidence).ok,
    ).toBe(false);
    expect(
      validateClaimSupport(
        { ...view.contract, checks: { passed: 4, failed: 0, notRun: 2, scope: "local unit tests" } } as FounderUpdate,
        task,
        evidence,
      ).ok,
    ).toBe(false);
  });

  test("legacy native tasks retain null IDs and raw metadata cannot promote stage", () => {
    const issue = {
      id: "task-1",
      revision: 3,
      status: "done",
      project: null,
      assignee: null,
      work: null,
      criteria: [],
      updatedAt: task.generatedAt,
      communication: {
        deliveryStage: "LIVE_VERIFIED",
        availability: "production",
        checks: { passed: 100, failed: 0, notRun: 0 },
      },
    };
    const view = projectNativeIssueUpdate(issue, { orgId: "org-1", audience: "person-1", ...preferences });
    expect(view.contract).toBeNull();
    expect(view.nextOwner).toBeNull();
    expect(view.deliveryStage).toBeNull();
    expect(view.availability).toBe("unknown");
    expect(view.checks).toBeNull();
    expect(view.evidence).toEqual([]);
    expect(view.outcome).toContain("標記");
    expect(FounderProjectionSchema.safeParse(view).success).toBe(true);
    const blocked = projectNativeIssueUpdate(
      { ...issue, blocked: { reason: "input", text: "Choose a target" } },
      { orgId: "org-1", audience: "person-1", ...preferences },
    );
    expect(blocked.blocker?.summary).toBe("Choose a target");
    expect(blocked.blocker?.ownerRef).toBeNull();
  });

  test("system waiting does not claim the viewer has an action to take", () => {
    const issue = {
      id: "task-1",
      revision: 3,
      status: "in_progress",
      project: null,
      assignee: null,
      criteria: [],
      updatedAt: task.generatedAt,
      work: { runId: "run-1", state: "waiting_input" },
    };
    const viewer = { orgId: "org-1", audience: "person-1", ...preferences };
    expect(projectNativeIssueUpdate(issue, viewer).decisionNeeded).toBe(false);
    expect(
      projectNativeIssueUpdate({ ...issue, work: { ...issue.work, state: "waiting_approval" } }, viewer).decisionNeeded,
    ).toBe(false);
    expect(projectNativeIssueUpdate(issue, { ...viewer, decisionPending: true }).decisionNeeded).toBe(true);
    expect(projectNativeIssueUpdate(issue, { ...viewer, decisionPending: false }).decisionNeeded).toBe(false);
  });

  test("style and locale are per viewer without altering evidence facts", () => {
    const simple = projectFounderUpdate(task, [], preferences);
    const technical = projectFounderUpdate(task, [], { locale: "en", style: "technical" });
    expect(simple.locale).toBe("zh-HK");
    expect(technical.locale).toBe("en");
    expect(technical.style).toBe("technical");
    expect(simple.checks).toEqual(technical.checks);
    expect(simple.deliveryStage).toBe(technical.deliveryStage);
  });

  test("coalesces at 59 seconds, emits at 60 and does not hide urgent decisions", () => {
    const event = { orgId: "org-1", taskId: "task-1", revision: 3, eventKind: "progress", audience: "person-1", at: 0 };
    expect(shouldEmitFounderUpdate(event, { ...event, at: 59000 })).toBe(false);
    expect(shouldEmitFounderUpdate(event, { ...event, at: 60000 })).toBe(true);
    expect(shouldEmitFounderUpdate(event, { ...event, at: 59000, audience: "person-2" })).toBe(true);
    expect(shouldEmitFounderUpdate(event, { ...event, at: 59000, revision: 4 })).toBe(true);
    expect(shouldEmitFounderUpdate(event, { ...event, at: 1000, urgent: true })).toBe(true);
    expect(
      shouldEmitFounderUpdate({ ...event, eventKind: "decision" }, { ...event, eventKind: "decision", at: 1000 }),
    ).toBe(true);
  });
});
