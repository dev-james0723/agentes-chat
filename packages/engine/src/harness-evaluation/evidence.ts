import { ChecksSchema, type DeliveryStage, DeliveryStageSchema, EvidenceRefSchema } from "../communication-contracts";
import {
  classifyFounderEvidence,
  type NativeFounderEvidenceResolver,
  projectFounderUpdate,
  type ResolvedFounderEvidence,
  resolveFounderEvidence,
  type TaskSnapshot,
} from "../founder-updates";

export type EvidenceSupport = "supported" | "failed" | "stale" | "unknown" | "unavailable" | "not_run";
export type SyntheticEvidenceInput = {
  task: TaskSnapshot;
  claims: readonly DeliveryStage[];
  references: readonly string[];
  /** Fixture lookup only. Production authentication, issuer verification and ACLs stay in native adapters. */
  resolver: NativeFounderEvidenceResolver;
  freshness: { revision: string; maxAgeMs: Record<DeliveryStage, number | null> };
};
export type EvidenceResolution = {
  referenceId: string;
  stage: DeliveryStage | null;
  status: EvidenceSupport;
  reason: string;
};
export type SyntheticEvidenceResult = {
  mode: "synthetic";
  freshnessRevision: string;
  claims: { stage: DeliveryStage; status: EvidenceSupport; evidenceRefs: string[] }[];
  resolutions: EvidenceResolution[];
  allRequestedClaimsSupported: boolean;
  fixtureDeliveryStage: DeliveryStage | null;
  checks: TaskSnapshot["checks"];
  inputIssues: string[];
  product: { availability: "not_available"; deliveryStage: null; improvement: "not_measured" };
  report: string;
};

const stageNames: Record<DeliveryStage, string> = {
  SOURCE_INSPECTED: "來源／文件核對",
  CODED: "程式改動",
  TESTED: "所需測試全部通過",
  DEPLOYED: "指定目標部署",
  LIVE_VERIFIED: "實際功能驗證",
  MEASURED_IMPROVEMENT: "改善量度",
};
const statusNames: Record<EvidenceSupport, string> = {
  supported: "有合成證據支持",
  failed: "未通過",
  stale: "證據已過期",
  unknown: "未核實",
  unavailable: "證據來源暫時無法讀取",
  not_run: "仍有必須執行的檢查未跑",
};
const currentStateStages = new Set<DeliveryStage>(["DEPLOYED", "LIVE_VERIFIED", "MEASURED_IMPROVEMENT"]);

function validFreshness(policy: SyntheticEvidenceInput["freshness"]): boolean {
  return (
    typeof policy?.revision === "string" &&
    policy.revision.length > 0 &&
    policy.revision.length <= 200 &&
    DeliveryStageSchema.options.every((stage) => {
      const age = policy.maxAgeMs?.[stage];
      return age === null
        ? !currentStateStages.has(stage)
        : typeof age === "number" && Number.isSafeInteger(age) && age > 0;
    })
  );
}

function inputIssues(input: SyntheticEvidenceInput): string[] {
  const issues: string[] = [];
  if (!Array.isArray(input.claims) || input.claims.length === 0) issues.push("missing_claims");
  if (
    !Array.isArray(input.claims) ||
    input.claims.length > DeliveryStageSchema.options.length ||
    input.claims.some((stage) => !DeliveryStageSchema.safeParse(stage).success)
  )
    issues.push("invalid_claims");
  if (!Array.isArray(input.references) || input.references.length > 100) issues.push("reference_limit_exceeded");
  else if (input.references.some((ref) => !EvidenceRefSchema.shape.id.safeParse(ref).success))
    issues.push("invalid_reference");
  if (!Number.isFinite(Date.parse(input.task.generatedAt))) issues.push("invalid_observation_time");
  if (!validFreshness(input.freshness)) issues.push("invalid_freshness_policy");
  return issues;
}

function claimStatus(rows: EvidenceResolution[], unavailable: boolean): EvidenceSupport {
  // A negative current check cannot be hidden by another positive claim.
  for (const status of ["failed", "not_run", "supported", "stale"] as const)
    if (rows.some((row) => row.status === status)) return status;
  return unavailable ? "unavailable" : "unknown";
}

function renderReport(result: Omit<SyntheticEvidenceResult, "report">): string {
  const supported = result.claims.filter((claim) => claim.status === "supported").length;
  const checks = result.checks;
  return [
    `[Certain] 合成案例已核對 ${supported} / ${result.claims.length} 項完成聲稱。`,
    ...result.claims.map((claim) => `・${stageNames[claim.stage]}：${statusNames[claim.status]}。`),
    checks
      ? `測試紀錄：${checks.passed} 項通過、${checks.failed} 項失敗、${checks.notRun} 項未跑。`
      : "測試數據未核實；不能當成全部通過。",
    result.allRequestedClaimsSupported
      ? "本案例要求的聲稱都有對應證據；此結論只適用於這組合成資料。"
      : "仍有未通過或未核實項目，不能說全部完成；下一步先補齊相應證據或檢查。",
    "[Certain] 合成資料不證明正式 App 已上線或可用；模型改善未量度。",
  ].join("\n");
}

/**
 * Development-only data slice (ADR 0198). Reuses the native evidence resolver and founder projection;
 * never executes candidate code, creates a grant, calls a model, fetches a URL or publishes a result.
 * The supplied resolver is a fixture seam, not independently authenticated evidence. Even positive
 * mock live receipts can only affect fixture fields; product availability is always not_available.
 */
export async function evaluateSyntheticDeliveryEvidence(
  input: SyntheticEvidenceInput,
): Promise<SyntheticEvidenceResult> {
  const issues = inputIssues(input);
  // Snapshot data before awaiting a resolver so later caller mutations cannot alter admitted identity.
  const task = structuredClone(input.task);
  const freshness = structuredClone(input.freshness);
  const requested = [...new Set(Array.isArray(input.claims) ? input.claims : [])].filter(
    (stage): stage is DeliveryStage => DeliveryStageSchema.safeParse(stage).success,
  );
  const references = issues.length ? [] : [...new Set(input.references)];
  const resolutions: EvidenceResolution[] = [];
  const supported: ResolvedFounderEvidence[] = [];

  for (const ref of references) {
    try {
      // The existing implementation owns task/artifact/target/issuer matching. Do not copy its policy.
      const evidence = await resolveFounderEvidence(task, [ref], input.resolver);
      const receipt = evidence[0];
      // Reuse native subject/issuer checks to classify an expired receipt. This temporary copy
      // is never admitted as support: the original remains expired and is never projected.
      const expiredStage =
        receipt?.reference.status === "expired"
          ? classifyFounderEvidence(task, { ...receipt, reference: { ...receipt.reference, status: "valid" } }).stage
          : null;
      if (expiredStage) {
        resolutions.push({
          referenceId: ref,
          stage: expiredStage,
          status: "stale",
          reason: "expired_native_fixture",
        });
        continue;
      }
      const classification = receipt ? classifyFounderEvidence(task, receipt) : null;
      const stage = classification?.stage ?? null;
      if (!receipt || !stage) {
        resolutions.push({
          referenceId: ref,
          stage: null,
          status: receipt?.reference.status === "expired" ? "stale" : "unknown",
          reason: "no_matching_native_fixture_receipt",
        });
        continue;
      }
      const maxAge = freshness.maxAgeMs[stage];
      const age = Date.parse(task.generatedAt) - Date.parse(receipt.reference.observedAt);
      const status: EvidenceSupport = maxAge !== null && age > maxAge ? "stale" : (classification?.status ?? "unknown");
      resolutions.push({
        referenceId: ref,
        stage,
        status,
        reason:
          status === "stale"
            ? "freshness_policy_exceeded"
            : status === "supported"
              ? "matching_native_fixture"
              : "required_checks_not_verified",
      });
      if (status === "supported") supported.push(receipt);
    } catch {
      // Native authentication/errors can contain sensitive details. Keep static, per-reference failure only.
      resolutions.push({
        referenceId: ref,
        stage: null,
        status: "unavailable",
        reason: "fixture_resolver_unavailable",
      });
    }
  }

  const unavailable = resolutions.some((row) => row.status === "unavailable");
  const claims = requested.map((stage) => {
    const rows = resolutions.filter((row) => row.stage === stage);
    return {
      stage,
      status: issues.length ? ("unknown" as const) : claimStatus(rows, unavailable),
      evidenceRefs: rows.filter((row) => row.status === "supported").map((row) => row.referenceId),
    };
  });
  const projection = projectFounderUpdate(task, supported, { locale: "zh-HK", style: "simple" });
  const checks = ChecksSchema.safeParse(projection.checks);
  const result: Omit<SyntheticEvidenceResult, "report"> = {
    mode: "synthetic",
    freshnessRevision: freshness.revision,
    claims,
    resolutions,
    allRequestedClaimsSupported:
      issues.length === 0 && claims.length > 0 && claims.every((claim) => claim.status === "supported"),
    fixtureDeliveryStage: projection.deliveryStage,
    checks: checks.success ? checks.data : null,
    inputIssues: issues,
    product: { availability: "not_available", deliveryStage: null, improvement: "not_measured" },
  };
  return { ...result, report: renderReport(result) };
}
