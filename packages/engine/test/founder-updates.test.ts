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
    expect(view.contract?.checks ?? null).toEqual(task.checks);
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

describe("native required-check evidence gate", () => {
  const tested: NativeFounderReceipt = {
    ...receipt,
    stage: "TESTED",
    issuer: { id: "test-1", kind: "test_runner" },
    reference: { ...ref, kind: "test_result" },
  };
  const cases: { label: string; checks: TaskSnapshot["checks"] }[] = [
    { label: "a failed required check", checks: { passed: 9, failed: 1, notRun: 0, scope: "required" } },
    { label: "an unrun required check", checks: { passed: 4, failed: 0, notRun: 2, scope: "required" } },
    { label: "missing telemetry", checks: null },
    { label: "zero executed checks", checks: { passed: 0, failed: 0, notRun: 0, scope: "required" } },
    { label: "invalid negative counts", checks: { passed: 2, failed: -1, notRun: 0, scope: "required" } },
    { label: "invalid fractional counts", checks: { passed: 1.5, failed: 0, notRun: 0, scope: "required" } },
  ];
  for (const { label, checks } of cases) {
    test(`TESTED does not hide ${label}`, async () => {
      const snapshot = { ...task, checks };
      const evidence = await resolved(tested, snapshot);
      expect(deriveDeliveryStage(snapshot, evidence)).toBeNull();
      const view = projectFounderUpdate(snapshot, evidence, preferences);
      expect(view.deliveryStage).toBeNull();
      expect(view.checks).toEqual(checks);
      // A real contract retains its required arrays; missing/invalid telemetry may make view.contract null.
      const completeShape = projectFounderUpdate(task, [], preferences).contract;
      const update = { ...completeShape, deliveryStage: "TESTED", checks: checks ?? task.checks } as FounderUpdate;
      expect(validateClaimSupport(update, snapshot, evidence).ok).toBe(false);
    });
  }
  test("all required checks passed still supports TESTED", async () => {
    const snapshot = { ...task, checks: { passed: 12, failed: 0, notRun: 0, scope: "required" } };
    const evidence = await resolved(tested, snapshot);
    expect(deriveDeliveryStage(snapshot, evidence)).toBe("TESTED");
    const view = projectFounderUpdate(snapshot, evidence, preferences);
    expect(view.deliveryStage).toBe("TESTED");
    expect(view.checks).toEqual(snapshot.checks);
    expect(view.contract).not.toBeNull();
    expect(validateClaimSupport(view.contract as FounderUpdate, snapshot, evidence).ok).toBe(true);
  });
  test("failed check evidence does not erase separate valid source proof", async () => {
    const evidence = [...(await resolved()), ...(await resolved(tested))];
    expect(projectFounderUpdate(task, evidence, preferences).deliveryStage).toBe("SOURCE_INSPECTED");
    expect(projectFounderUpdate(task, evidence, preferences).checks).toEqual(task.checks);
  });
});

describe("founder report truth preservation", () => {
  const blockedTask: TaskSnapshot = {
    ...task,
    blocker: { summary: "Required check failed", ownerRef: "agent-1", nextAdmissibleAction: "Fix the failed check" },
    decisionNeeded: true,
    howToTry: "Wait for the required checks before trying the feature",
  };
  const mutations: { field: string; change: (update: FounderUpdate) => void }[] = [
    {
      field: "outcome",
      change: (update) => {
        update.outcome = "正式版已上線，全部驗收通過";
      },
    },
    {
      field: "claims.text",
      change: (update) => {
        update.claims = update.claims.map((claim) => ({ ...claim, text: "正式 App 已可使用" }));
      },
    },
    {
      field: "claims.confidence",
      change: (update) => {
        update.claims = update.claims.map((claim) => ({ ...claim, confidence: "guessing" }));
      },
    },
    {
      field: "claims.rationale",
      change: (update) => {
        update.claims = update.claims.map((claim) => ({ ...claim, rationale: "All release checks passed" }));
      },
    },
    {
      field: "howToTry",
      change: (update) => {
        update.howToTry = "Use the released production feature now";
      },
    },
    {
      field: "remaining",
      change: (update) => {
        update.remaining = [];
      },
    },
    {
      field: "blocker",
      change: (update) => {
        update.blocker = null;
      },
    },
    {
      field: "nextOwner",
      change: (update) => {
        update.nextOwner = "unrelated-owner";
      },
    },
    {
      field: "decisionNeeded",
      change: (update) => {
        update.decisionNeeded = false;
      },
    },
    {
      field: "generatedAt",
      change: (update) => {
        update.generatedAt = "2026-11-17T12:00:00Z";
      },
    },
  ];
  for (const { field, change } of mutations) {
    test(`rejects changed ${field} while stage and evidence references remain unchanged`, async () => {
      const evidence = await resolved(receipt, blockedTask);
      const canonical = projectFounderUpdate(blockedTask, evidence, preferences).contract;
      expect(canonical).not.toBeNull();
      const changed = structuredClone(canonical) as FounderUpdate;
      change(changed);
      expect(changed.deliveryStage).toBe(canonical?.deliveryStage ?? null);
      expect(changed.evidenceRefs).toEqual(canonical?.evidenceRefs ?? []);
      const validation = validateClaimSupport(changed, blockedTask, evidence);
      expect(validation.ok).toBe(false);
      expect(validation.issues.every((issue) => issue.message === "Claim lacks current native support")).toBe(true);
      // The deterministic fallback remains truthful and retains the failed/unrun counts.
      expect(projectFounderUpdate(blockedTask, evidence, preferences).contract).toEqual(canonical);
    });
  }
  for (const locale of ["zh-HK", "en", "pt-BR"]) {
    test(`accepts unchanged canonical ${locale} with object properties reordered`, async () => {
      const evidence = await resolved(receipt, blockedTask);
      const canonical = projectFounderUpdate(blockedTask, evidence, { locale, style: "simple" }).contract;
      expect(canonical).not.toBeNull();
      const reordered = Object.fromEntries(Object.entries(canonical as FounderUpdate).reverse()) as FounderUpdate;
      reordered.claims = reordered.claims.map((claim) =>
        Object.fromEntries(Object.entries(claim).reverse()),
      ) as FounderUpdate["claims"];
      reordered.blocker = Object.fromEntries(
        Object.entries(reordered.blocker ?? {}).reverse(),
      ) as FounderUpdate["blocker"];
      expect(validateClaimSupport(reordered, blockedTask, evidence).ok).toBe(true);
    });
  }
  for (const [label, malformed] of [
    ["null", null],
    ["missing fields", {}],
    ["missing claims", { ...projectFounderUpdate(task, [], preferences).contract, claims: null }],
    ["invalid checks", { ...projectFounderUpdate(task, [], preferences).contract, checks: { passed: -1 } }],
    [
      "untrusted extra field",
      { ...projectFounderUpdate(task, [], preferences).contract, "synthetic-secret-marker": true },
    ],
  ] as const) {
    test(`rejects ${label} without throwing or disclosing submitted values`, () => {
      let result: ReturnType<typeof validateClaimSupport> | undefined;
      expect(() => {
        result = validateClaimSupport(malformed as FounderUpdate, task, []);
      }).not.toThrow();
      expect(result?.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain("synthetic-secret-marker");
    });
  }
  test("fails closed when the native projection has no complete contract", () => {
    const canonical = projectFounderUpdate(task, [], preferences).contract as FounderUpdate;
    expect(validateClaimSupport(canonical, { ...task, projectId: null }, []).ok).toBe(false);
  });
});

describe("viewer-bound native evidence projection", () => {
  const otherScopes: { field: string; change: Partial<TaskSnapshot> }[] = [
    { field: "organization", change: { orgId: "other-org" } },
    { field: "project", change: { projectId: "other-project" } },
    { field: "task", change: { taskId: "other-task" } },
    { field: "revision", change: { revision: 4 } },
    { field: "viewer", change: { audience: "other-viewer" } },
  ];
  for (const { field, change } of otherScopes) {
    test(`does not reuse evidence metadata or support across ${field}`, async () => {
      const evidence = await resolved();
      const view = projectFounderUpdate({ ...task, ...change }, evidence, preferences);
      expect(view.evidence).toEqual([]);
      expect(view.deliveryStage).toBeNull();
      expect(view.contract?.evidenceRefs).toEqual([]);
    });
  }
  for (const status of ["expired", "revoked"] as const) {
    test(`retains authorized ${status} diagnostics without completion support`, async () => {
      const evidence = await resolved({ ...receipt, reference: { ...ref, status } });
      const view = projectFounderUpdate(task, evidence, preferences);
      expect(view.evidence).toHaveLength(1);
      expect(view.evidence[0]?.status).toBe(status);
      expect(view.evidence[0]?.stage).toBeNull();
      expect(view.deliveryStage).toBeNull();
      expect(view.contract?.evidenceRefs).toEqual([]);
    });
  }
  test("requires native re-resolution for a different viewer and accepts an authorized result", async () => {
    const otherViewer = { ...task, audience: "other-viewer" };
    const scopes: unknown[] = [];
    const evidence = await resolveFounderEvidence(otherViewer, [ref.id], {
      resolve: async (_id, scope) => {
        scopes.push(scope);
        return receipt;
      },
    });
    expect(scopes).toHaveLength(1);
    expect(scopes[0]).toMatchObject({
      orgId: task.orgId,
      projectId: task.projectId,
      taskId: task.taskId,
      viewerId: "other-viewer",
    });
    expect(projectFounderUpdate(otherViewer, evidence, preferences).deliveryStage).toBe("SOURCE_INSPECTED");
    expect(projectFounderUpdate(task, evidence, preferences).evidence).toEqual([]);
  });
  test("snapshots scope before the first await and does not retarget later references", async () => {
    const mutable = structuredClone(task);
    const second = { ...receipt, reference: { ...ref, id: "receipt-2" } };
    const scopes: unknown[] = [];
    const evidence = await resolveFounderEvidence(mutable, [ref.id, second.reference.id], {
      resolve: async (id, scope) => {
        scopes.push({ ...scope });
        await Promise.resolve();
        mutable.audience = "other-viewer";
        mutable.orgId = "other-org";
        mutable.revision = 4;
        return id === ref.id ? receipt : second;
      },
    });
    expect(scopes).toHaveLength(2);
    for (const scope of scopes) expect(scope).toMatchObject({ orgId: task.orgId, viewerId: task.audience });
    expect(projectFounderUpdate(task, evidence, preferences).evidence).toHaveLength(2);
    expect(projectFounderUpdate(mutable, evidence, preferences).evidence).toEqual([]);
  });
  test("cannot import a JSON copy of resolved evidence as native proof", async () => {
    const evidence = JSON.parse(JSON.stringify(await resolved())) as ResolvedFounderEvidence[];
    expect(projectFounderUpdate(task, evidence, preferences).evidence).toEqual([]);
    expect(deriveDeliveryStage(task, evidence)).toBeNull();
  });
});
