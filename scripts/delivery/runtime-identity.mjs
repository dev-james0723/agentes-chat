// Which revision a running server is made of: its /api/health `source` against a revision's tree. Read-only.
//
// The same scope and digest as apps/server/src/source-identity.ts (the server's side) and scripts/runtime-identity.ts.
// This copy is plain Node so the Guardian keeps no dependencies; a test in apps/server/test keeps the three equal.
import { createHash } from "node:crypto";
import { createGitReader } from "./git-read.mjs";

const SKIPPED_DIRS = new Set(["node_modules", "dist", ".turbo", "coverage"]);
const ROOT_FILES = ["package.json", "bun.lock"];
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const TIMEOUT_MS = 10_000;
/** A health response is a few hundred bytes; more is not read. */
const MAX_BODY = 64 * 1024;

/** The code a server runs: each app's and package's src, the server's runner, migrations, manifests and lockfile. */
export function inSourceScope(path) {
  const parts = path.split("/");
  if (parts.length === 1) return ROOT_FILES.includes(path);
  if (parts[0] !== "apps" && parts[0] !== "packages") return false;
  if (parts.some((p) => SKIPPED_DIRS.has(p))) return false;
  if (parts.length === 3 && parts[2] === "package.json") return true;
  if (parts.length < 4) return false;
  return (
    parts[2] === "src" ||
    (parts[0] === "apps" && parts[1] === "server" && parts[2] === "runner") ||
    (parts[0] === "packages" && parts[1] === "db" && parts[2] === "migrations")
  );
}

/** `{commit, digest, files}` of a commit's in-scope regular files, from its tree (no file is read). */
export function revisionIdentity(root, revision) {
  if (typeof revision !== "string" || !/^[0-9a-zA-Z][0-9a-zA-Z_./^~-]*$/.test(revision))
    throw new Error("Invalid revision");
  const reader = createGitReader(root);
  const commit = reader.read(["rev-parse", "--verify", "--quiet", `${revision}^{commit}`]).trim();
  if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error("Unknown revision");
  const out = reader.read(["ls-tree", "-r", "-z", "--full-tree", commit, "--", "apps", "packages", ...ROOT_FILES]);
  const entries = [];
  for (const line of out.split("\0")) {
    const m = /^(\d+) blob ([0-9a-f]+)\t(.+)$/s.exec(line);
    if (m && (m[1] === "100644" || m[1] === "100755") && inSourceScope(m[3])) entries.push({ path: m[3], blob: m[2] });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const hash = createHash("sha256");
  for (const e of entries) hash.update(`${e.path}\0${e.blob}\n`);
  return { commit, digest: `sha256:${hash.digest("hex")}`, files: entries.length };
}

function healthUrl(base) {
  let url;
  try {
    url = new URL(base);
  } catch {
    throw new Error("Invalid runtime URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("Invalid runtime URL: http(s) without credentials, query or fragment only");
  // From the origin and path alone: an empty `?` or `#` left in the address must not drop its path.
  return new URL(`${url.pathname.replace(/\/?$/, "/")}api/health`, url.origin).href;
}

/** The response's text, refused past `MAX_BODY` bytes. */
async function cappedText(response) {
  if (!response.body?.getReader) {
    const text = await response.text();
    if (text.length > MAX_BODY) throw new RangeError("too_large");
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel();
      throw new RangeError("too_large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Whether the server at `base` runs `revision`: `match`, `mismatch`, or `unknown` with a reason (unreachable, no
 * identity reported, an empty one). Never `match` without both identities equal and non-empty; a health response
 * alone proves nothing, and no files is no evidence: a wrong root on either side hashes to the same empty digest.
 */
export async function checkRuntime(root, revision, base, { fetch = globalThis.fetch } = {}) {
  const url = healthUrl(base);
  const { commit, ...expected } = revisionIdentity(root, revision);
  const unknown = (reason) => ({ status: "unknown", reason, revision: commit, url, expected, running: null });
  let response;
  let body;
  try {
    response = await fetch(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (response.status !== 200) return unknown(`health_status_${response.status}`);
    body = JSON.parse(await cappedText(response));
  } catch (error) {
    return unknown(error instanceof RangeError && error.message === "too_large" ? "too_large" : "unreachable");
  }
  const source = body?.source;
  if (!source || typeof source.digest !== "string" || !DIGEST.test(source.digest) || !Number.isInteger(source.files))
    return unknown("no_source_identity");
  const running = { digest: source.digest, files: source.files };
  if (running.files < 1 || expected.files < 1) return unknown("empty_source_identity");
  const same = running.digest === expected.digest && running.files === expected.files;
  return { status: same ? "match" : "mismatch", revision: commit, url, expected, running };
}
