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
  const sameSubject = scope.every((key) => typeof a[key] === "string" && a[key].length > 0 && a[key] === o[key]);
  if (a.state === "succeeded")
    return {
      action: sameSubject && o.state === "succeeded" ? "reuse_result" : "observe_outcome",
      execute: false,
    };
  if (sameSubject && o.state === "succeeded") return { action: "record_observed_success", execute: false };
  if (["executing", "outcome_unknown"].includes(a.state)) return { action: "observe_outcome", execute: false };
  return { action: "publisher_preflight_required", execute: false };
}

// Presentation only: callers still need the native reader/ACLs and existing release
// boundary. Legacy availableNow is a verification flag, not a service-health claim.
// Founder UI should render publicTargets; do not dump this technical record as UI.
export function renderFounderReport(projection, options = {}) {
  const p = object(projection) ? projection : {},
    opts = object(options) ? options : {};
  const now = opts.now ?? Date.now();
  const knownResults = ["pass", "fail", "unknown", "stale", "not_run", "not_applicable"];
  const gateLabels = {
    committed: "程式碼提交",
    pushed: "遠端備份",
    reviewed: "獨立覆核",
    tested: "必要測試",
    merged: "合併",
    built: "正式建置",
    installed_or_deployed: "安裝或部署",
    running: "實際運行版本",
    live_verified: "真實功能操作驗證",
  };
  const safeRef = (value) =>
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value) &&
    !/(?:gh[pousr]_|github_pat_|sk-(?:proj-)?|AKIA[0-9A-Z]{12}|bearer|password|secret|token=)/i.test(value);
  const iso = (value) => {
    if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) return null;
    const time = Date.parse(value);
    if (!Number.isFinite(time)) return null;
    const normalized = new Date(time).toISOString();
    const expanded = value.includes(".")
      ? value.replace(/\.(\d{1,3})Z$/, (_, digits) => `.${digits.padEnd(3, "0")}Z`)
      : value.replace(/Z$/, ".000Z");
    return normalized === expanded ? normalized : null;
  };
  const observedAt = iso(p.observedAt),
    observedTime = observedAt ? Date.parse(observedAt) : NaN;
  // Re-rendering a cached projection must not keep an old green runtime alive.
  // Sixty seconds is the shortest native projection evidence lifetime above.
  const timeState =
    !Number.isFinite(now) || !Number.isFinite(observedTime) || observedTime > now
      ? "unknown"
      : now - observedTime > 60_000
        ? "stale"
        : "fresh";
  const entries = object(p.targetAvailability) ? Object.entries(p.targetAvailability) : [];
  const targetsOmitted = Math.max(0, entries.length - 128);
  const coverage = object(p.coverage) ? p.coverage : {};
  const unknownGates = !Array.isArray(p.missingGates) || p.missingGates.some((name) => !CLAIMS.includes(name));
  const sourceComplete =
    p.schema === "delivery-projection/v1.1" &&
    !unknownGates &&
    Array.isArray(coverage.failed) &&
    coverage.failed.length === 0 &&
    Array.isArray(coverage.omitted) &&
    coverage.omitted.length === 0 &&
    coverage.truncated === false &&
    targetsOmitted === 0;
  const missing = [...new Set(array(p.missingGates).filter((name) => CLAIMS.includes(name)))];
  const availableNow = {},
    targetRefs = [];
  const missingContradiction = missing.some((name) => p.currentClaims?.[name]?.result === "pass");
  const descriptions = {
    available: "已核實可用。",
    unavailable: "未通過今次交付驗證；未可確認改動已可用。",
    unknown: "目前狀態未核實。",
    stale: "核查資料已過期，要重新確認目前狀態。",
    not_run: "所需驗證未核實，未可確認改動已可用。",
  };
  const publicTargets = entries.slice(0, 128).map(([id, row], index) => {
    const validRef = safeRef(id),
      label = `目標 ${index + 1}`;
    let result = object(row) && knownResults.includes(row.result) ? row.result : "unknown";
    const local = object(p.targetClaims?.[id]) ? p.targetClaims[id] : {};
    const scopedClaim = (name) =>
      ["built", "installed_or_deployed", "running", "live_verified"].includes(name)
        ? local[name]
        : p.currentClaims?.[name];
    // A display summary cannot override failed, missing or contradictory detail.
    // This checks presentation consistency; it does not authenticate evidence.
    if (
      result === "pass" &&
      (missingContradiction || CLAIMS.some((name) => !object(scopedClaim(name)) || scopedClaim(name).result !== "pass"))
    ) {
      result = "unknown";
    }
    if (!validRef || !sourceComplete || timeState === "unknown") result = "unknown";
    else if (timeState === "stale" && ["pass", "fail"].includes(result)) result = "stale";
    const state = { pass: "available", fail: "unavailable", stale: "stale", not_run: "not_run" }[result] ?? "unknown";
    if (validRef) {
      // Keep not_run=false for existing consumers; publicTargets explains that it
      // means unverified, not that an existing installed service is unavailable.
      availableNow[id] = state === "available" ? true : ["unavailable", "not_run"].includes(state) ? false : null;
      targetRefs.push({ label, ref: id });
    }
    const scoped = CLAIMS.filter((name) => object(scopedClaim(name)) && scopedClaim(name).result !== "pass");
    return {
      label,
      state,
      text: descriptions[state],
      missingGates: state === "available" ? [] : (scoped.length ? scoped : missing).map((name) => gateLabels[name]),
    };
  });
  const states = publicTargets.map((target) => target.state);
  const currentAvailability = !states.length
    ? "unknown"
    : states.every((state) => state === "available")
      ? "available"
      : states.some((state) => state === "available") ||
          (states.some((state) => state === "unavailable") && new Set(states).size > 1)
        ? "partial"
        : states.every((state) => state === "unavailable")
          ? "unavailable"
          : states.some((state) => state === "unknown")
            ? "unknown"
            : states.some((state) => state === "stale")
              ? "stale"
              : "not_run";
  const goalResult = knownResults.includes(p.goalResult) ? p.goalResult : "unknown";
  const goalStages = Object.hasOwn(goals, p.closeoutGoal) ? goals[p.closeoutGoal] : null;
  const consistentGoal =
    goalStages &&
    goalStages.every((name) => p.currentClaims?.[name]?.result === "pass" && !missing.includes(name)) &&
    (p.closeoutGoal !== "available_on_selected_targets" || currentAvailability === "available");
  const freshnessResult =
    !sourceComplete || timeState === "unknown"
      ? "unknown"
      : timeState === "stale"
        ? "stale"
        : goalResult === "pass" && !consistentGoal
          ? "unknown"
          : goalResult;
  const headlines = {
    available: "所選目標已核實可用；結果以列出嘅核查時間為準。",
    partial: "各目標進度唔一致；仍有目標未通過或未完成驗證。",
    unavailable: "所選目標未通過交付驗證；未可確認今次改動已可用。",
    unknown: "目前可用狀態未核實；需補齊最新可信證據。",
    stale: "核查資料已過期；目前可用狀態要重新確認。",
    not_run: "交付驗證尚未完成；未可確認今次改動已可用。",
  };
  const completedGoal = {
    development_verified: "所選開發驗證已核實。",
    backed_up: "所選程式碼備份已核實。",
    integrated: "所選合併目標已核實。",
  };
  const ownerDecisionRequired =
    sourceComplete && timeState === "fresh" && typeof p.ownerDecisionRequired === "boolean"
      ? p.ownerDecisionRequired
      : null;
  const nextStep =
    !sourceComplete || timeState === "unknown"
      ? "重新讀取未能核實嘅原生證據，再逐個目標更新狀態。"
      : timeState === "stale" || states.includes("stale")
        ? "更新過期證據，再逐個目標確認實際可用狀態。"
        : ownerDecisionRequired === true
          ? "核實現有負責人，處理已記錄嘅待決事項，再沿用原有流程。"
          : missing.length
            ? `先補齊「${gateLabels[missing[0]]}」嘅最新證據，再沿用現有發布流程。`
            : currentAvailability === "available"
              ? "保留最新驗證紀錄，按原有流程完成收口。"
              : "取得原生任務同實際目標嘅最新證據。";
  return {
    locale: "zh-HK",
    userVisibleOutcome: `${freshnessResult === "pass" && Object.hasOwn(completedGoal, p.closeoutGoal) ? `${completedGoal[p.closeoutGoal]} ` : ""}${headlines[currentAvailability]}`,
    currentAvailability,
    publicTargets,
    availableNow,
    targetsOmitted,
    howToUse: "逐個目標查看目前狀態同未完成驗證；技術紀錄由原生任務嘅私有詳情查閱。",
    notYetAvailable: missing,
    missingGateLabels: [...missing.map((name) => gateLabels[name]), ...(unknownGates ? ["未能辨識嘅驗收關卡"] : [])],
    // A native reference alone does not establish a verified public display name.
    owner: null,
    ownerStatus: "發布負責人待核實。",
    nextStep,
    ownerDecisionRequired,
    evidenceRefs: [],
    freshness: { observedAt, result: freshnessResult, coverage: sourceComplete ? "complete" : "incomplete" },
    isAuthorizationGrant: false,
    ...(opts.includePrivateDetails === true
      ? {
          privateDetails: {
            requiresNativeAccessControl: true,
            ownerRef: safeRef(p.blockerOwnerRef) ? p.blockerOwnerRef : null,
            evidenceRefs: [
              ...new Set(
                array(p.historicalClaims)
                  .map((r) => (object(r) ? r.evidenceId : null))
                  .filter(safeRef),
              ),
            ].slice(0, 256),
            targetRefs,
          },
        }
      : {}),
  };
}
