// A pure delivery projection, plus an in-process boundary for a native evidence
// reader. This is not an authorization service or a sandbox against arbitrary
// code in the host. Only the existing trusted integration may construct a reader.
// JSON from agents/CLI cannot manufacture a validated handle. No state is stored
// outside the lifetime of that handle; the native task remains authoritative.
import { createHash } from "node:crypto";
import { REQUIRED_RELEASE_CHECKS } from "./policy.mjs";

const handles = new WeakMap();
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const array = (v) => (Array.isArray(v) ? v : []);
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const CLAIMS = [
  "committed",
  "pushed",
  "reviewed",
  "tested",
  "merged",
  "built",
  "installed_or_deployed",
  "running",
  "live_verified",
];
const KINDS = [
  "commit",
  "remote_ref",
  "review",
  "test",
  "integration",
  "artifact",
  "promotion",
  "runtime",
  "feature",
  "exception",
];
const ttl = {
  commit: 60_000,
  remote_ref: 120_000,
  review: 120_000,
  test: 120_000,
  integration: 120_000,
  artifact: 60_000,
  promotion: 60_000,
  runtime: 60_000,
  feature: 60_000,
  exception: 120_000,
};
const goals = {
  development_verified: ["committed", "reviewed", "tested"],
  backed_up: ["committed", "pushed"],
  integrated: ["committed", "reviewed", "tested", "merged"],
  available_on_selected_targets: CLAIMS,
};
const canonical = (value) =>
  value === null || typeof value !== "object"
    ? JSON.stringify(value)
    : Array.isArray(value)
      ? `[${value.map(canonical).join(",")}]`
      : `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
          .join(",")}}`;
const hash = (value) => `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
const claim = (result, reason, evidenceIds = []) => ({ result, reasonCodes: reason ? [reason] : [], evidenceIds });
function aggregate(values) {
  if (!values.length) return claim("not_run", "no_required_observations");
  const rank = ["fail", "unknown", "stale", "not_run", "not_applicable", "pass"];
  const worst = values.reduce((a, b) => (rank.indexOf(a.result) <= rank.indexOf(b.result) ? a : b));
  return {
    result: worst.result,
    reasonCodes: [...new Set(values.flatMap((v) => v.reasonCodes))],
    evidenceIds: [...new Set(values.flatMap((v) => v.evidenceIds))],
  };
}

export function createNativeEvidenceReader({ readRecord, trustedIssuers, policy } = {}) {
  if (
    typeof readRecord !== "function" ||
    !object(trustedIssuers) ||
    !object(policy) ||
    typeof policy.version !== "string"
  )
    throw new TypeError("A native reader, issuer allowlist and versioned policy are required");
  const issuers = structuredClone(trustedIssuers),
    nativePolicy = structuredClone(policy);
  return async (ids) => {
    const requested = array(ids);
    const coverage = { attempted: [], failed: [], omitted: [], truncated: requested.length > 256 };
    const records = [];
    const seen = new Set();
    for (const id of requested.slice(0, 256)) {
      if (typeof id !== "string" || id.length < 1 || id.length > 256 || seen.has(id)) {
        coverage.failed.push({
          id: typeof id === "string" ? id.slice(0, 256) : null,
          reason: "invalid_or_duplicate_evidence_id",
        });
        continue;
      }
      seen.add(id);
      coverage.attempted.push(id);
      try {
        const value = await readRecord(id);
        // The loader must enforce native ACLs and return bounded plain data.
        const encoded = JSON.stringify(value);
        if (typeof encoded !== "string" || encoded.length > 64 * 1024) throw new Error();
        const r = JSON.parse(encoded);
        const { payloadDigest, ...payload } = r;
        if (
          !object(r) ||
          r.id !== id ||
          !KINDS.includes(r.kind) ||
          !object(r.subjectBinding) ||
          !array(issuers[r.trustedIssuerRef]).includes(r.kind) ||
          r.policyVersion !== nativePolicy.version ||
          !DIGEST.test(payloadDigest ?? "") ||
          hash(payload) !== payloadDigest ||
          !["pass", "fail", "unknown", "stale", "not_run", "not_applicable"].includes(r.result)
        )
          throw new Error();
        records.push(r);
      } catch {
        coverage.failed.push({ id, reason: "native_evidence_unavailable_or_invalid" });
      }
    }
    coverage.omitted = requested.slice(256).map((id) => (typeof id === "string" ? id.slice(0, 256) : null));
    const handle = Object.freeze({
      schema: "native-evidence-handle/v1",
      evidenceIds: Object.freeze(records.map((r) => r.id)),
    });
    handles.set(handle, { records, coverage, policy: nativePolicy });
    return handle;
  };
}

export function reconcileDelivery(deliveryItem, evidenceSet, { now = Date.now() } = {}) {
  const item = object(deliveryItem) ? deliveryItem : {};
  const data = object(evidenceSet) ? handles.get(evidenceSet) : null;
  const records = data?.records ?? [],
    policy = data?.policy ?? {};
  const validClock = Number.isFinite(now) && !Number.isNaN(new Date(now).valueOf());
  const validItem =
    ["taskId", "projectId", "repositoryId", "branch"].every((k) => typeof item[k] === "string" && item[k]) &&
    SHA.test(item.candidateSha ?? "") &&
    SHA.test(item.candidateTree ?? "");
  const targets = array(item.targetIds).filter((id) => typeof id === "string" && id.length && id.length <= 256);
  const invalid =
    !data ||
    !validClock ||
    !validItem ||
    targets.length !== array(item.targetIds).length ||
    new Set(targets).size !== targets.length;
  // If a record could not be read/validated, its subject and precedence are
  // unknown. It might supersede an older success. Use separate handles for
  // independent projects; never discard an unbound gap to keep a green target.
  const incomplete = data && (data.coverage.failed.length > 0 || data.coverage.truncated);
  const missing = (reason) => claim("unknown", reason);
  const matching = records.filter(
    (r) =>
      r.subjectBinding.taskId === item.taskId &&
      r.subjectBinding.projectId === item.projectId &&
      r.subjectBinding.repositoryId === item.repositoryId &&
      r.candidateSha === item.candidateSha,
  );
  function evaluate(kind, targetId, predicate) {
    if (invalid) return missing(!data ? "native_evidence_reader_required" : "invalid_delivery_subject_or_clock");
    if (incomplete) return missing("evidence_coverage_incomplete");
    const possible = matching.filter((r) => r.kind === kind && (targetId === undefined || r.targetId === targetId));
    if (!possible.length) {
      // Unknown or invalid native records never collapse into a successful empty list.
      if (
        data.coverage.failed.length ||
        records.some((r) => r.kind === kind && (targetId === undefined || r.targetId === targetId))
      )
        return missing("evidence_missing_or_wrong_subject");
      return claim("not_run", `missing:${kind}`);
    }
    const ordered = [...possible].sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt));
    if (ordered.some((r) => !Number.isFinite(Date.parse(r.capturedAt)) || Date.parse(r.capturedAt) > now))
      return missing("invalid_or_future_evidence_time");
    const r = ordered[0],
      time = Date.parse(r.capturedAt);
    if (
      ordered.length > 1 &&
      Date.parse(ordered[1].capturedAt) === time &&
      ordered[1].payloadDigest !== r.payloadDigest
    )
      return missing("conflicting_current_evidence");
    if (now - time > ttl[kind]) return claim("stale", `stale:${kind}`, [r.id]);
    if (r.result !== "pass")
      return claim(r.result === "not_applicable" ? "unknown" : r.result, `evidence:${r.result}`, [r.id]);
    return predicate(r) ? claim("pass", null, [r.id]) : claim("fail", `mismatch:${kind}`, [r.id]);
  }
  let integrationSha = null,
    integrationTree = null;
  const merged = evaluate("integration", undefined, (r) => {
    const ok =
      r.facts?.state === "merged" &&
      r.facts?.sourceSha === item.candidateSha &&
      ["merge", "squash", "rebase"].includes(r.facts?.mergeMethod) &&
      SHA.test(r.integrationSha ?? "") &&
      SHA.test(r.integrationTree ?? "");
    if (ok) {
      integrationSha = r.integrationSha;
      integrationTree = r.integrationTree;
    }
    return ok;
  });
  const expectedTestSha = integrationSha ?? item.candidateSha;
  const expectedTree = integrationTree ?? item.candidateTree;
  const currentClaims = {
    committed: evaluate("commit", undefined, (r) => r.facts?.exists === true && r.facts?.tree === item.candidateTree),
    pushed: evaluate(
      "remote_ref",
      undefined,
      (r) => r.facts?.ref === `refs/heads/${item.branch}` && r.facts?.sha === item.candidateSha,
    ),
    reviewed: evaluate(
      "review",
      undefined,
      (r) => r.reviewedSha === item.candidateSha && r.facts?.independent === true && r.facts?.decision === "approved",
    ),
    tested: evaluate(
      "test",
      undefined,
      (r) =>
        r.facts?.sha === expectedTestSha &&
        REQUIRED_RELEASE_CHECKS.every((name) => {
          const checks = array(r.facts?.checks).filter((c) => object(c) && c.name === name);
          return (
            checks.length === 1 &&
            checks[0].sha === expectedTestSha &&
            checks[0].conclusion === "success" &&
            array(policy.trustedCheckIssuers).includes(checks[0].issuerRef)
          );
        }),
    ),
    merged,
  };
  const targetAvailability = {},
    targetClaims = {};
  for (const targetId of targets) {
    let artifact = null,
      runtimeIdentity = null;
    const built = evaluate("artifact", targetId, (r) => {
      const ok =
        DIGEST.test(r.artifactDigest ?? "") &&
        r.facts?.sourceSha === expectedTestSha &&
        r.facts?.tree === expectedTree &&
        r.facts?.dirty === false &&
        DIGEST.test(r.facts?.dependencyLockDigest ?? "") &&
        DIGEST.test(r.facts?.configDigest ?? "") &&
        typeof r.facts?.toolchainIdentity === "string" &&
        r.facts.toolchainIdentity.length > 0;
      if (ok) artifact = r.artifactDigest;
      return ok;
    });
    const installed = evaluate(
      "promotion",
      targetId,
      (r) => artifact !== null && r.artifactDigest === artifact && r.facts?.installedArtifactDigest === artifact,
    );
    const running = evaluate("runtime", targetId, (r) => {
      const ok =
        artifact !== null &&
        r.artifactDigest === artifact &&
        r.facts?.runningArtifactDigest === artifact &&
        r.facts?.identityVerified === true &&
        r.facts?.compatibilityVerified === true &&
        typeof r.facts?.runtimeIdentity === "string" &&
        r.facts.runtimeIdentity.length > 0;
      if (ok) runtimeIdentity = r.facts.runtimeIdentity;
      return ok;
    });
    const feature = evaluate("feature", targetId, (r) => {
      const required = array(policy.requiredFeatureIds?.[targetId]);
      return (
        required.length > 0 &&
        required.every((id) => array(r.facts?.acceptanceIds).includes(id) && array(r.facts?.passedIds).includes(id)) &&
        artifact !== null &&
        r.artifactDigest === artifact &&
        r.facts?.fixtureApproved === true &&
        runtimeIdentity !== null &&
        r.facts?.runtimeIdentity === runtimeIdentity
      );
    });
    targetClaims[targetId] = {
      built,
      installed_or_deployed: installed,
      running,
      live_verified: aggregate([built, installed, running, feature]),
    };
    targetAvailability[targetId] = aggregate([
      ...Object.values(currentClaims),
      ...Object.values(targetClaims[targetId]),
    ]);
  }
  for (const name of ["built", "installed_or_deployed", "running", "live_verified"])
    currentClaims[name] = aggregate(targets.map((id) => targetClaims[id][name]));
  // A revert invalidates present availability even if the old executable remains.
  currentClaims.live_verified = aggregate([currentClaims.live_verified, merged]);
  const needed = goals[item.closeoutGoal];
  const goal =
    needed && !invalid ? aggregate(needed.map((name) => currentClaims[name])) : missing("invalid_goal_or_evidence");
  return {
    schema: "delivery-projection/v1.1",
    taskId: item.taskId ?? null,
    projectId: item.projectId ?? null,
    historicalClaims: records.map((r) => ({
      evidenceId: r.id,
      kind: r.kind,
      result: r.result,
      capturedAt: r.capturedAt,
      candidateSha: r.candidateSha,
      targetId: r.targetId ?? null,
    })),
    currentClaims,
    targetClaims,
    targetAvailability,
    closeoutGoal: item.closeoutGoal ?? null,
    goalResult: goal.result,
    missingGates: CLAIMS.filter((name) => currentClaims[name].result !== "pass"),
    blockerOwnerRef: item.releaseOwnerRef ?? null,
    nextAction:
      goal.result === "pass" ? "保留證據；由現有發布流程判斷下一步。" : "補齊所列階段嘅最新可信證據，再核對現有授權。",
    observedAt: validClock ? new Date(now).toISOString() : null,
    coverage: data
      ? structuredClone(data.coverage)
      : { attempted: [], failed: [{ reason: "native_evidence_reader_required" }], omitted: [], truncated: false },
    isAuthorizationGrant: false,
  };
}

export function validateTransition(request, evidenceSet, authority, lease, { now = Date.now() } = {}) {
  const r = object(request) ? request : {},
    a = object(authority) ? authority : {},
    l = object(lease) ? lease : {};
  const reasonCodes = ["trusted_publisher_required"];
  const fresh = (value) =>
    Number.isFinite(now) &&
    Number.isFinite(Date.parse(value)) &&
    Date.parse(value) <= now &&
    now - Date.parse(value) <= 10_000;
  if (!object(evidenceSet) || !handles.has(evidenceSet)) reasonCodes.push("unverified_evidence_set");
  if (
    !SHA.test(r.candidateSha ?? "") ||
    typeof r.targetId !== "string" ||
    !r.targetId ||
    typeof r.idempotencyKey !== "string" ||
    !r.idempotencyKey
  )
    reasonCodes.push("invalid_operation_subject");
  if (
    a.state !== "valid" ||
    !fresh(a.observedAt) ||
    !array(a.operations).includes(r.operation) ||
    a.candidateSha !== r.candidateSha ||
    !array(a.targetIds).includes(r.targetId)
  )
    reasonCodes.push("current_scoped_authority_required");
  if (
    l.state !== "held" ||
    !fresh(l.observedAt) ||
    l.targetId !== r.targetId ||
    typeof l.fencingOrVersionToken !== "string" ||
    !l.fencingOrVersionToken
  )
    reasonCodes.push("current_fenced_lease_required");
  for (const [snapshot, reason] of [
    [a, "authority_expired"],
    [l, "lease_expired"],
  ])
    if (
      snapshot.expiresAt &&
      (!Number.isFinite(Date.parse(snapshot.expiresAt)) || Date.parse(snapshot.expiresAt) <= now)
    )
      reasonCodes.push(reason);
  return {
    decision: "blocked",
    reasonCodes,
    missingEvidenceIds: [],
    evaluatedSubject: { candidateSha: r.candidateSha ?? null, targetId: r.targetId ?? null },
    evaluatedAt: Number.isFinite(now) && !Number.isNaN(new Date(now).valueOf()) ? new Date(now).toISOString() : null,
    responsibleOwnerRef: r.ownerRef ?? null,
    nextAction: "由既有 publisher 即時重核原生授權、候選版本及 lease；此純函式唔會授權執行。",
    isAuthorizationGrant: false,
  };
}

export function reconcileOperation(attempt, observation) {
  const a = object(attempt) ? attempt : {},
    o = object(observation) ? observation : {};
  if (typeof a.idempotencyKey !== "string" || !a.idempotencyKey)
    return { action: "blocked", reason: "stable_operation_identity_required", execute: false };
  const scope = [
    "projectId",
    "taskId",
    "repositoryId",
    "operation",
    "targetId",
    "artifactDigest",
    "candidateSha",
    "idempotencyKey",
  ];
  // A historical "succeeded" flag cannot certify a new session's operation.
  // Verify the full immutable subject against the observed outcome before any
  // reuse. An absent, stale or conflicting readback means observe again, never
  // retry the provider effect or upgrade untrusted receipt text into authority.
  const sameSubject = scope.every(
    (key) => typeof a[key] === "string" && a[key].length > 0 && a[key] === o[key],
  );
  if (a.state === "succeeded")
    return {
      action: sameSubject && o.state === "succeeded" ? "reuse_result" : "observe_outcome",
      execute: false,
    };
  if (sameSubject && o.state === "succeeded") return { action: "record_observed_success", execute: false };
  if (["executing", "outcome_unknown"].includes(a.state)) return { action: "observe_outcome", execute: false };
  return { action: "publisher_preflight_required", execute: false };
}

export function renderFounderReport(projection) {
  const p = object(projection) ? projection : {};
  return {
    locale: "zh-HK",
    userVisibleOutcome:
      p.goalResult === "pass" ? "所選目標嘅證據已核對；操作授權仍由現有流程檢查。" : "交付未完成；仍有階段未核實。",
    availableNow: Object.fromEntries(
      Object.entries(p.targetAvailability ?? {}).map(([id, status]) => [id, status.result === "pass"]),
    ),
    notYetAvailable: array(p.missingGates),
    owner: p.blockerOwnerRef ?? null,
    nextStep: p.nextAction ?? "重新取得原生證據。",
    ownerDecisionRequired: false,
    evidenceRefs: array(p.historicalClaims).map((r) => r.evidenceId),
    freshness: { observedAt: p.observedAt ?? null, result: p.goalResult ?? "unknown" },
  };
}
