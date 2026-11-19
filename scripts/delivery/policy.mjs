// Delivery evidence is data, not authorization. These gates never execute a release.
export const REQUIRED_RELEASE_CHECKS = Object.freeze([
  "unit",
  "typecheck",
  "lint",
  "boundaries",
  "build",
  "secrets",
  "regression",
]);
const SHA = /^[a-f0-9]{40,64}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PROTECTED_BRANCHES = /^(main|master|production|prod|release(?:\/.*)?)$/;
const result = (stage, blockers) => ({
  ok: blockers.length === 0,
  stage: blockers.length ? "blocked" : stage,
  blockers: [...new Set(blockers)],
  deployed: false,
});
const list = (v) => (Array.isArray(v) ? v : []);
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export function safePath(path) {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    !/^[A-Za-z]:/.test(path) &&
    !path.split("/").some((p) => p === "." || p === ".." || p === "" || p.toLowerCase() === ".git")
  );
}

export function protectedPath(path) {
  if (typeof path !== "string") return true;
  return (
    path
      .split("/")
      .some((part) => /^\.env(?:\.|$)/i.test(part) && ![".env.example", ".env.sample"].includes(part.toLowerCase())) ||
    /(^|\/)(?:id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|[^/]*\.(?:pem|p12|pfx|key|cookies)|credentials(?:\.[^/]*)?|secrets?(?:\.[^/]*)?)$/i.test(
      path,
    )
  );
}

function freshness(value, now, maxAge) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value)) return "invalid";
  const date = Date.parse(value);
  if (!Number.isFinite(date) || date > now + 30_000) return "invalid";
  return now - date <= maxAge ? "fresh" : "stale";
}

export function checkCheckpoint(observation, scope, { now = Date.now() } = {}) {
  const o = object(observation) ? observation : {};
  const s = object(scope) ? scope : {};
  const blockers = [];
  if (!Number.isFinite(now)) return result("checkpoint_eligible", ["invalid_clock"]);
  if (o.schema !== "delivery-observation/v1") blockers.push("invalid_schema");
  if (!REPO.test(o.repository ?? "") || !REPO.test(s.repository ?? "") || o.repository !== s.repository)
    blockers.push("repository_mismatch");
  if (typeof o.branch !== "string" || !o.branch || PROTECTED_BRANCHES.test(o.branch)) blockers.push("protected_branch");
  if (typeof s.branch !== "string" || s.branch !== o.branch) blockers.push("branch_mismatch");
  if (!SHA.test(o.head ?? "") || !SHA.test(s.head ?? "") || o.head !== s.head) blockers.push("head_mismatch");
  const age = freshness(o.observedAt, now, 600_000);
  if (age !== "fresh") blockers.push(age === "stale" ? "stale_observation" : "invalid_observation_time");
  if (o.stable !== true) blockers.push("unstable_observation");
  if (!Array.isArray(o.errors) || o.errors.length) blockers.push("collection_failed");
  if (s.authorized !== true) blockers.push("authorization_required");
  if (s.writerConfirmed !== true) blockers.push("writer_unverified");
  if (
    !Number.isInteger(o.trackedCount) ||
    o.trackedCount < 1 ||
    !Array.isArray(o.changes) ||
    !Array.isArray(o.staged) ||
    !Array.isArray(o.deletedPaths)
  )
    blockers.push("invalid_inventory");
  const paths = list(s.paths);
  if (!paths.length) blockers.push("empty_scope");
  if (paths.some((p) => !safePath(p))) blockers.push("unsafe_path");
  if (paths.some(protectedPath)) blockers.push("protected_path");
  if (new Set(paths).size !== paths.length) blockers.push("duplicate_scope_path");
  if (list(o.staged).some((p) => !paths.includes(p))) blockers.push("foreign_staged_path");
  const scopedChanges = list(o.changes).filter((row) => object(row) && paths.includes(row.path));
  if (
    scopedChanges.some(
      (row) =>
        row.pathSafe === false || row.symlink === true || (row.originalPath && !paths.includes(row.originalPath)),
    )
  )
    blockers.push("unsafe_path");
  if (scopedChanges.some((row) => row.conflict === true || row.index === "U" || row.worktree === "U"))
    blockers.push("unresolved_conflict");
  if (paths.some((p) => !scopedChanges.some((row) => row.path === p))) blockers.push("scope_has_no_change");
  const deleted = list(o.deletedPaths);
  if (deleted.length > 20 || deleted.length > o.trackedCount * 0.2) blockers.push("bulk_deletion");
  return result("checkpoint_eligible", blockers);
}

export function checkRelease(evidence, { now = Date.now() } = {}) {
  const e = object(evidence) ? evidence : {};
  const blockers = [];
  if (!Number.isFinite(now)) return result("release_eligible", ["invalid_clock"]);
  if (!SHA.test(e.head ?? "") || e.head !== e.expectedHead) blockers.push("head_mismatch");
  if (freshness(e.observedAt, now, 600_000) !== "fresh") blockers.push("stale_observation");
  if (e.authorized !== true) blockers.push("authorization_required");
  // This attestation must come from the native trusted verifier, not a skill, PR body or agent JSON.
  if (e.trustedChecks !== true) blockers.push("untrusted_checks");
  const required = list(e.requiredChecks);
  if (REQUIRED_RELEASE_CHECKS.some((name) => !required.includes(name))) blockers.push("required_policy_checks_missing");
  if (
    !required.length ||
    required.some((n) => typeof n !== "string" || !n.trim()) ||
    new Set(required).size !== required.length
  )
    blockers.push("missing_required_checks");
  for (const name of required) {
    const matching = list(e.checks).filter((c) => object(c) && c.name === name);
    if (matching.length !== 1) {
      blockers.push(`check_missing:${name}`);
      continue;
    }
    const c = matching[0];
    if (c.sha !== e.head) blockers.push(`check_sha_mismatch:${name}`);
    if (c.conclusion !== "success") blockers.push(`check_not_success:${name}`);
    if (freshness(c.observedAt, now, 86_400_000) !== "fresh") blockers.push(`check_stale:${name}`);
  }
  const r = e.review;
  if (
    !object(r) ||
    r.sha !== e.head ||
    r.decision !== "approved" ||
    r.independent !== true ||
    freshness(r.observedAt, now, 86_400_000) !== "fresh"
  )
    blockers.push("review_unverified");
  if (e.activeRuns !== 0) blockers.push("active_work");
  for (const [field, code] of [
    ["hazardsReviewed", "hazards_unreviewed"],
    ["exclusiveLease", "lease_unverified"],
    ["backupRestoreVerified", "backup_restore_unverified"],
    ["stagedArtifactVerified", "staging_unverified"],
    ["rollbackVerified", "rollback_unverified"],
    ["runnerCompatible", "runner_unverified"],
  ]) {
    if (e[field] !== true) blockers.push(code);
  }
  return result("release_eligible", blockers);
}
