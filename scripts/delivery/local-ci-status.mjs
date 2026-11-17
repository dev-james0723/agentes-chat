// Cryptographic release evidence and optional GitHub App status bridge.
// This module cannot replace an independent reviewer or authorize deployment.
import { createSign, sign, verify } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
// Every step below is required by the existing scripts/ci-local.sh plus a real image boot.
// A passing Guardian smoke suite alone MUST NEVER become a release-ready external status.
export const REQUIRED_RELEASE_STEPS = Object.freeze([
  "frozen-deps",
  "lint",
  "shellcheck",
  "guardian",
  "boundaries-unit",
  "geometry-unit",
  "licenses",
  "typecheck",
  "build",
  "migration-drift",
  "migration-compat",
  "deployment-scripts",
  "engine-a-m",
  "engine-n-z-and-packages",
  "server",
  "web-ui",
  "geometry",
  "event-dialog",
  "mobile-desktop",
  "secret-scan",
  "boundaries",
  "container-boot",
]);

const SHA = /^[a-f0-9]{40}$/,
  HEX64 = /^[a-f0-9]{64}$/,
  REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
function canon(value) {
  if (Array.isArray(value)) return value.map(canon);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = canon(value[k]);
    return out;
  }
  return value;
}
function bytes(value) {
  return Buffer.from(JSON.stringify(canon(value)), "utf8");
}
export function signReceipt(receipt, privateKey) {
  return {
    receipt: JSON.parse(JSON.stringify(receipt)),
    signature: sign(null, bytes(receipt), privateKey).toString("base64"),
    format: "ed25519",
  };
}
export function verifyAttestation(envelope, publicKey, { now = Date.now(), repository, head } = {}) {
  const r = envelope?.receipt ?? {},
    blockers = [];
  if (!SHA.test(r.head ?? "") || r.head !== head) blockers.push("head_mismatch");
  if (!REPO.test(r.repo ?? "") || r.repo !== repository) blockers.push("repository_mismatch");
  let sigOk = false;
  try {
    sigOk =
      envelope?.format === "ed25519" &&
      typeof envelope.signature === "string" &&
      verify(null, bytes(r), publicKey, Buffer.from(envelope.signature, "base64"));
  } catch {}
  if (!sigOk) blockers.push("signature_invalid");
  const t = Date.parse(r.finishedAt),
    start = Date.parse(r.startedAt);
  if (!Number.isFinite(t) || !Number.isFinite(start) || t < start || t > now + 30000)
    blockers.push("invalid_receipt_time");
  else if (now - t > 600000) blockers.push("stale_receipt");
  if (r.schema !== "local-ci-release/v1" || r.mode !== "full" || r.sourceVerified !== true)
    blockers.push("incomplete_suite");
  const required = REQUIRED_RELEASE_STEPS,
    steps = r.steps;
  if (
    !Array.isArray(steps) ||
    required.some((id) => !steps.some((x) => x.id === id)) ||
    steps.length !== required.length ||
    new Set(steps?.map((x) => x.id)).size !== steps?.length
  )
    blockers.push("incomplete_suite");
  if (Array.isArray(steps)) {
    if (steps.some((x) => !required.includes(x.id) || !HEX64.test(x.logSha256 ?? "")))
      blockers.push("invalid_step_evidence");
    if (steps.some((x) => x.exitCode !== 0 || x.state !== "passed" || x.timedOut !== false))
      blockers.push("failed_suite");
  }
  if (r.review?.sha !== r.head || r.review?.independent !== true || r.review?.result !== "approved")
    blockers.push("review_unverified");
  return {
    ok: blockers.length === 0,
    blockers: [...new Set(blockers)],
    eligibleForStatus: blockers.length === 0,
    deployed: false,
  };
}
export function statusPayload(envelope, { publicKey, now = Date.now(), repository, head }) {
  const a = verifyAttestation(envelope, publicKey, { now, repository, head });
  if (!a.ok) throw Error(`release_not_verified:${a.blockers.join(",")}`);
  return {
    repository,
    sha: head,
    state: "success",
    context: "local-ci/full",
    description: "Verified local CI full suite and independent review for exact commit",
  };
}
export function assertPublisherConfiguration(config) {
  if (
    config?.authMode !== "github_app" ||
    !Number.isSafeInteger(config?.appId) ||
    config.appId <= 0 ||
    !Number.isSafeInteger(config?.installationId) ||
    config.installationId <= 0 ||
    typeof config?.privateKeyPath !== "string" ||
    !isAbsolute(config.privateKeyPath)
  )
    throw Error("app_required");
  return { appId: config.appId, installationId: config.installationId, privateKeyPath: config.privateKeyPath };
}
function jwtForApp(appId, privateKey, now = Date.now()) {
  const b64 = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const payload = b64({ iat: Math.floor(now / 1000) - 30, exp: Math.floor(now / 1000) + 540, iss: String(appId) });
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${payload}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKey).toString("base64url");
  return `${unsigned}.${signature}`;
}
async function github(path, token, { method = "GET", body } = {}) {
  const url = `https://api.github.com/${path}`;
  const response = await fetch(url, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2026-03-10",
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw Error(`github_api_status_${response.status}`);
  return response.json();
}
export async function publishAttestedStatus(
  envelope,
  { publicKey, now = Date.now(), repository, head, branch, config },
) {
  const payload = statusPayload(envelope, { publicKey, now, repository, head });
  const c = assertPublisherConfiguration(config);
  if (!/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(branch ?? "")) throw Error("invalid_branch");
  const stat = statSync(c.privateKeyPath);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw Error("app_key_permissions_unsafe");
  const key = readFileSync(c.privateKeyPath, "utf8");
  const jwt = jwtForApp(c.appId, key, now);
  const installation = await github(`app/installations/${c.installationId}/access_tokens`, jwt, {
    method: "POST",
    body: { repositories: [repository.split("/")[1]], permissions: { statuses: "write" } },
  });
  if (!installation.token || installation.permissions?.statuses !== "write")
    throw Error("app_not_authorized_for_statuses");
  const remote = await github(`repos/${repository}/git/ref/heads/${encodeURIComponent(branch)}`, installation.token);
  if (remote.object?.sha !== head) throw Error("remote_head_moved");
  const posted = await github(`repos/${repository}/statuses/${head}`, installation.token, {
    method: "POST",
    body: { state: payload.state, context: payload.context, description: payload.description },
  });
  return {
    id: posted.id,
    sha: head,
    context: payload.context,
    state: posted.state,
    postedBy: "github_app",
    appId: c.appId,
  };
}
