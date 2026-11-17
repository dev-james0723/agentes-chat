import { describe, expect, test } from "bun:test";
import type { NativeFounderReceipt, TaskSnapshot } from "../src/founder-updates";
import { evaluateSyntheticDeliveryEvidence, type SyntheticEvidenceInput } from "../src/harness-evaluation/evidence";

const task = (): TaskSnapshot => ({
  orgId: "fixture-org",
  projectId: "fixture-project",
  taskId: "fixture-task",
  revision: 3,
  runId: "fixture-run",
  audience: "fixture-viewer",
  owner: { type: "agent", id: "fixture-owner" },
  artifactRef: "fixture-artifact",
  artifactRevision: "fixture-source-3",
  artifactKind: "code",
  environment: "preview",
  lifecycle: "in_progress",
  generatedAt: "2026-11-16T12:00:00Z",
  checks: { passed: 9, failed: 0, notRun: 0, scope: "required fixture checks" },
  remaining: [],
  blocker: null,
  decisionNeeded: false,
  howToTry: null,
});
const policy: SyntheticEvidenceInput["freshness"] = {
  revision: "fixture-freshness-1",
  maxAgeMs: {
    SOURCE_INSPECTED: null,
    CODED: null,
    TESTED: null,
    DEPLOYED: 600_000,
    LIVE_VERIFIED: 600_000,
    MEASURED_IMPROVEMENT: 600_000,
  },
};
const producers = {
  SOURCE_INSPECTED: ["source_inspection", "source_inspector"],
  CODED: ["tool_receipt", "build_runner"],
  TESTED: ["test_result", "test_runner"],
  DEPLOYED: ["deployment_receipt", "release_controller"],
  LIVE_VERIFIED: ["live_check", "live_probe"],
  MEASURED_IMPROVEMENT: ["benchmark_result", "benchmark_runner"],
} as const;
function receipt(stage: keyof typeof producers, snapshot = task()): NativeFounderReceipt {
  const [kind, issuer] = producers[stage];
  return {
    reference: {
      id: `fixture-${stage}`,
      kind,
      uri: `urn:fixture:${stage}`,
      sourceRevision: snapshot.artifactRevision ?? "fixture-source-3",
      environment: snapshot.environment ?? "preview",
      observedAt: snapshot.generatedAt,
      scope: { orgId: snapshot.orgId, projectId: snapshot.projectId, visibility: "project" },
      trust: "authorized_system",
      status: "valid",
    },
    taskId: snapshot.taskId,
    taskRevision: snapshot.revision,
    artifactRef: snapshot.artifactRef ?? "fixture-artifact",
    artifactRevision: snapshot.artifactRevision ?? "fixture-source-3",
    issuer: { id: `fixture-issuer-${issuer}`, kind: issuer },
    stage,
  };
}
function input(
  values: NativeFounderReceipt[],
  claims: SyntheticEvidenceInput["claims"],
  snapshot = task(),
): SyntheticEvidenceInput {
  return {
    task: snapshot,
    claims,
    references: values.map((value) => value.reference.id),
    freshness: policy,
    resolver: { resolve: async (id) => values.find((value) => value.reference.id === id) ?? null },
  };
}

describe("synthetic delivery evidence through native founder projection", () => {
  test("matched native fixture receipts support only requested stages", async () => {
    const result = await evaluateSyntheticDeliveryEvidence(
      input([receipt("CODED"), receipt("TESTED")], ["CODED", "TESTED"]),
    );
    expect(result.claims.map((claim) => claim.status)).toEqual(["supported", "supported"]);
    expect(result.allRequestedClaimsSupported).toBe(true);
    expect(result.fixtureDeliveryStage).toBe("TESTED");
    expect(result.product).toEqual({ availability: "not_available", deliveryStage: null, improvement: "not_measured" });
  });

  test("worker JSON marked verified is not a resolver receipt", async () => {
    const request = {
      ...input([], ["LIVE_VERIFIED"]),
      references: ["worker-blob"],
      workerBlob: { verified: true, deployed: true },
    };
    const result = await evaluateSyntheticDeliveryEvidence(request);
    expect(result.claims[0]?.status).toBe("unknown");
    expect(result.allRequestedClaimsSupported).toBe(false);
    expect(result.fixtureDeliveryStage).toBeNull();
  });

  test("agent claim trust cannot become native deployment support", async () => {
    const value = receipt("DEPLOYED");
    value.reference.trust = "agent_claim";
    const result = await evaluateSyntheticDeliveryEvidence(input([value], ["DEPLOYED"]));
    expect(result.claims[0]?.status).toBe("unknown");
  });

  for (const mismatch of [
    "org",
    "project",
    "task",
    "task_revision",
    "artifact",
    "source",
    "target",
    "issuer",
  ] as const) {
    test(`mismatched ${mismatch} cannot support the current claim`, async () => {
      const value = receipt("LIVE_VERIFIED");
      if (mismatch === "org") value.reference.scope.orgId = "other-org";
      if (mismatch === "project") value.reference.scope.projectId = "other-project";
      if (mismatch === "task") value.taskId = "other-task";
      if (mismatch === "task_revision") value.taskRevision = 2;
      if (mismatch === "artifact") value.artifactRef = "other-artifact";
      if (mismatch === "source") {
        value.artifactRevision = "source-2";
        value.reference.sourceRevision = "source-2";
      }
      if (mismatch === "target") value.reference.environment = "production";
      if (mismatch === "issuer") value.issuer.kind = "source_inspector";
      const result = await evaluateSyntheticDeliveryEvidence(input([value], ["LIVE_VERIFIED"]));
      expect(result.claims[0]?.status).toBe("unknown");
      expect(JSON.stringify(result)).not.toContain("other-org");
      expect(result.product.availability).toBe("not_available");
    });
  }

  test("expired current-state proof remains stale while matching code proof survives", async () => {
    const value = receipt("LIVE_VERIFIED");
    value.reference.observedAt = "2026-11-16T11:40:00Z";
    const result = await evaluateSyntheticDeliveryEvidence(
      input([receipt("CODED"), value], ["CODED", "LIVE_VERIFIED"]),
    );
    expect(result.claims.map((claim) => claim.status)).toEqual(["supported", "stale"]);
    expect(result.fixtureDeliveryStage).toBe("CODED");
    expect(result.allRequestedClaimsSupported).toBe(false);
  });

  test("immutable tests can be reused when the frozen freshness policy allows it", async () => {
    const value = receipt("TESTED");
    value.reference.observedAt = "2026-05-16T12:00:00Z";
    const result = await evaluateSyntheticDeliveryEvidence(input([value], ["TESTED"]));
    expect(result.claims[0]?.status).toBe("supported");
  });

  test("future evidence cannot prove completion", async () => {
    const value = receipt("LIVE_VERIFIED");
    value.reference.observedAt = "2026-11-16T12:01:00Z";
    expect((await evaluateSyntheticDeliveryEvidence(input([value], ["LIVE_VERIFIED"]))).claims[0]?.status).toBe(
      "unknown",
    );
  });

  test("failed required checks defeat an all-tests-pass claim without hiding partial results", async () => {
    const snapshot = task();
    snapshot.checks = { passed: 9, failed: 1, notRun: 0, scope: "required fixture checks" };
    const result = await evaluateSyntheticDeliveryEvidence(
      input([receipt("CODED"), receipt("TESTED")], ["CODED", "TESTED"], snapshot),
    );
    expect(result.claims.map((claim) => claim.status)).toEqual(["supported", "failed"]);
    expect(result.checks).toEqual(snapshot.checks);
    expect(result.fixtureDeliveryStage).toBe("CODED");
    expect(result.report).toContain("9 項通過");
    expect(result.report).toContain("1 項失敗");
    expect(result.allRequestedClaimsSupported).toBe(false);
  });

  test("unrun required checks stay not_run rather than zero failures", async () => {
    const snapshot = task();
    snapshot.checks = { passed: 4, failed: 0, notRun: 2, scope: "required fixture checks" };
    const result = await evaluateSyntheticDeliveryEvidence(input([receipt("TESTED")], ["TESTED"], snapshot));
    expect(result.claims[0]?.status).toBe("not_run");
    expect(result.checks?.notRun).toBe(2);
    expect(result.allRequestedClaimsSupported).toBe(false);
  });

  test("missing check telemetry stays unknown", async () => {
    const snapshot = task();
    snapshot.checks = null;
    const result = await evaluateSyntheticDeliveryEvidence(input([receipt("TESTED")], ["TESTED"], snapshot));
    expect(result.claims[0]?.status).toBe("unknown");
    expect(result.checks).toBeNull();
    expect(result.report).toContain("測試數據未核實");
  });

  test("resolver failure is contained per reference and does not expose errors", async () => {
    const request = input([receipt("CODED")], ["CODED", "LIVE_VERIFIED"]);
    request.references = ["fixture-CODED", "offline-ref"];
    request.resolver = {
      resolve: async (id) => {
        if (id === "offline-ref") throw new Error("synthetic-secret-do-not-emit");
        return receipt("CODED");
      },
    };
    const result = await evaluateSyntheticDeliveryEvidence(request);
    expect(result.claims.map((claim) => claim.status)).toEqual(["supported", "unavailable"]);
    expect(result.resolutions.find((row) => row.referenceId === "offline-ref")?.status).toBe("unavailable");
    expect(JSON.stringify(result)).not.toContain("synthetic-secret-do-not-emit");
  });

  test("document validation never becomes live code", async () => {
    const snapshot = task();
    snapshot.artifactKind = "document";
    const result = await evaluateSyntheticDeliveryEvidence(
      input(
        [receipt("SOURCE_INSPECTED", snapshot), receipt("LIVE_VERIFIED", snapshot)],
        ["SOURCE_INSPECTED", "LIVE_VERIFIED"],
        snapshot,
      ),
    );
    expect(result.claims.map((claim) => claim.status)).toEqual(["supported", "unknown"]);
    expect(result.product.deliveryStage).toBeNull();
  });

  test("a mock live receipt supports only its fixture, never real product availability", async () => {
    const result = await evaluateSyntheticDeliveryEvidence(input([receipt("LIVE_VERIFIED")], ["LIVE_VERIFIED"]));
    expect(result.claims[0]?.status).toBe("supported");
    expect(result.fixtureDeliveryStage).toBe("LIVE_VERIFIED");
    expect(result.product.availability).toBe("not_available");
    expect(result.product.deliveryStage).toBeNull();
    expect(result.report).toContain("合成");
    expect(result.report).toContain("未量度");
  });

  test("revoked receipt is not counted as a successful security block or supported claim", async () => {
    const value = receipt("LIVE_VERIFIED");
    value.reference.status = "revoked";
    const result = await evaluateSyntheticDeliveryEvidence(input([value], ["LIVE_VERIFIED"]));
    expect(result.claims[0]?.status).toBe("unknown");
    expect(result.product.improvement).toBe("not_measured");
  });

  test("empty requested claims cannot produce vacuous completion", async () => {
    const result = await evaluateSyntheticDeliveryEvidence(input([], []));
    expect(result.allRequestedClaimsSupported).toBe(false);
    expect(result.inputIssues).toContain("missing_claims");
  });

  test("oversized reference lists are rejected before resolving rather than silently truncated", async () => {
    let calls = 0;
    const request = input([], ["CODED"]);
    request.references = Array.from({ length: 101 }, (_, i) => `fixture-${i}`);
    request.resolver = {
      resolve: async () => {
        calls++;
        return null;
      },
    };
    const result = await evaluateSyntheticDeliveryEvidence(request);
    expect(result.inputIssues).toContain("reference_limit_exceeded");
    expect(result.allRequestedClaimsSupported).toBe(false);
    expect(calls).toBe(0);
  });

  test("duplicate references are resolved once and do not inflate support", async () => {
    let calls = 0;
    const request = input([receipt("CODED")], ["CODED"]);
    request.references = ["fixture-CODED", "fixture-CODED"];
    request.resolver = {
      resolve: async () => {
        calls++;
        return receipt("CODED");
      },
    };
    const result = await evaluateSyntheticDeliveryEvidence(request);
    expect(calls).toBe(1);
    expect(result.claims[0]?.evidenceRefs).toEqual(["fixture-CODED"]);
  });

  test("invalid observation clock stops resolution conservatively", async () => {
    const snapshot = task();
    snapshot.generatedAt = "invalid";
    const result = await evaluateSyntheticDeliveryEvidence(input([receipt("CODED")], ["CODED"], snapshot));
    expect(result.inputIssues).toContain("invalid_observation_time");
    expect(result.allRequestedClaimsSupported).toBe(false);
  });

  test("a policy cannot make current-state evidence timeless", async () => {
    const request = input([receipt("LIVE_VERIFIED")], ["LIVE_VERIFIED"]);
    request.freshness = { revision: "bad-policy", maxAgeMs: { ...policy.maxAgeMs, LIVE_VERIFIED: null } };
    const result = await evaluateSyntheticDeliveryEvidence(request);
    expect(result.inputIssues).toContain("invalid_freshness_policy");
    expect(result.allRequestedClaimsSupported).toBe(false);
  });

  test("benign technical words do not trigger keyword denial", async () => {
    const snapshot = task();
    snapshot.checks = { passed: 2, failed: 0, notRun: 0, scope: "delete/system explanation" };
    const result = await evaluateSyntheticDeliveryEvidence(input([receipt("TESTED")], ["TESTED"], snapshot));
    expect(result.claims[0]?.status).toBe("supported");
    expect(result.checks?.scope).toBe("delete/system explanation");
  });

  test("resolver-side mutation cannot change the admitted task snapshot", async () => {
    const snapshot = task();
    const value = receipt("CODED", snapshot);
    const request = input([value], ["CODED"], snapshot);
    request.resolver = {
      resolve: async () => {
        snapshot.artifactRevision = "changed-during-await";
        if (snapshot.checks) snapshot.checks.failed = 50;
        return value;
      },
    };
    const result = await evaluateSyntheticDeliveryEvidence(request);
    expect(result.claims[0]?.status).toBe("supported");
    expect(result.checks?.failed).toBe(0);
  });

  test("an explicitly expired matching receipt remains stale in the claim and report", async () => {
    const value = receipt("LIVE_VERIFIED");
    value.reference.status = "expired";
    const result = await evaluateSyntheticDeliveryEvidence(input([value], ["LIVE_VERIFIED"]));
    expect(result.claims[0]?.status).toBe("stale");
    expect(result.report).toContain("證據已過期");
    expect(result.fixtureDeliveryStage).toBeNull();
    expect(result.allRequestedClaimsSupported).toBe(false);
  });

  test("expiration does not disclose a mismatched target as a current-stage fact", async () => {
    const value = receipt("LIVE_VERIFIED");
    value.reference.status = "expired";
    value.reference.environment = "other-target";
    const result = await evaluateSyntheticDeliveryEvidence(input([value], ["LIVE_VERIFIED"]));
    expect(result.claims[0]?.status).toBe("unknown");
    expect(result.resolutions[0]?.stage).toBeNull();
    expect(result.product.availability).toBe("not_available");
  });

  test("native-valid supplementary Unicode IDs keep benign evidence eligible", async () => {
    const value = receipt("CODED");
    value.reference.id = "😀".repeat(101);
    const result = await evaluateSyntheticDeliveryEvidence(input([value], ["CODED"]));
    expect(result.inputIssues).toEqual([]);
    expect(result.claims[0]?.status).toBe("supported");
    expect(result.claims[0]?.evidenceRefs).toEqual([value.reference.id]);
  });

  test("absent telemetry is unknown and is never called measured improvement", async () => {
    const result = await evaluateSyntheticDeliveryEvidence(input([], ["TESTED", "LIVE_VERIFIED"]));
    expect(result.claims.map((claim) => claim.status)).toEqual(["unknown", "unknown"]);
    expect(result.product.improvement).toBe("not_measured");
    expect(result.report).toContain("未量度");
  });
});
