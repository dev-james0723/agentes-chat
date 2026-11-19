import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Which source a running server is made of, worked out from the files themselves.
 *
 * An image's tag or label says what its builder meant to ship, and an image patched file by file over an older one
 * keeps the older one's label. This reads the code the process actually has, so a deploy can be checked against the
 * git revision it claims: `scripts/runtime-identity.ts` works out the same identity from a revision's tree.
 *
 * Each file counts as its git blob id, so a revision's identity comes from `git ls-tree` without reading any file.
 */
export interface SourceIdentity {
  /** `sha256:` over every in-scope path and its git blob id, sorted by path. */
  digest: string;
  files: number;
}

export interface SourceEntry {
  path: string;
  blob: string;
}

const SKIPPED_DIRS = new Set(["node_modules", "dist", ".turbo", "coverage"]);

const ROOT_FILES = ["package.json", "bun.lock"];

/**
 * The code a server runs: each app's and package's `src`, the server's `runner` (it imports it and serves its
 * install script), the database migrations, and every package manifest and the lockfile (a dependency change counts).
 * Tests and build output are not: `apps/web/dist` is built in the image, so a web change copied in without a rebuild
 * is not seen here.
 */
export function inSourceScope(path: string): boolean {
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

export function sourceIdentityOf(entries: SourceEntry[]): SourceIdentity {
  const sorted = entries
    .filter((e) => inSourceScope(e.path))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const hash = createHash("sha256");
  for (const e of sorted) hash.update(`${e.path}\0${e.blob}\n`);
  return { digest: `sha256:${hash.digest("hex")}`, files: sorted.length };
}

function blobOf(bytes: Buffer): string {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

/** Every regular in-scope file under `root`, as git would name it. Symlinks are left out, as `gitSourceEntries` does. */
export function scanSourceTree(root: string): SourceEntry[] {
  const out: SourceEntry[] = [];
  const walk = (rel: string) => {
    for (const d of readdirSync(join(root, rel), { withFileTypes: true })) {
      const path = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (!SKIPPED_DIRS.has(d.name)) walk(path);
      } else if (d.isFile() && inSourceScope(path)) {
        out.push({ path, blob: blobOf(readFileSync(join(root, path))) });
      }
    }
  };
  for (const path of ROOT_FILES) {
    if (lstatSync(join(root, path), { throwIfNoEntry: false })?.isFile()) {
      out.push({ path, blob: blobOf(readFileSync(join(root, path))) });
    }
  }
  for (const top of ["apps", "packages"]) {
    if (lstatSync(join(root, top), { throwIfNoEntry: false })?.isDirectory()) walk(top);
  }
  return out;
}

/** A revision's in-scope files from its tree, regular files only (mode 100644/100755). */
export function gitSourceEntries(repo: string, revision: string): SourceEntry[] {
  const r = Bun.spawnSync(
    ["git", "-C", repo, "ls-tree", "-r", "-z", "--full-tree", revision, "--", "apps", "packages", ...ROOT_FILES],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (r.exitCode !== 0) throw new Error(`git ls-tree ${revision}: ${r.stderr.toString().trim()}`);
  const out: SourceEntry[] = [];
  for (const line of r.stdout.toString().split("\0")) {
    // `s`: a path may hold a newline (records are NUL-separated); the disk scan counts such a file, so this must too.
    const m = /^(\d+) blob ([0-9a-f]+)\t(.+)$/s.exec(line);
    if (m && (m[1] === "100644" || m[1] === "100755")) out.push({ path: m[3] as string, blob: m[2] as string });
  }
  return out;
}

/** The repository root this file is in (`apps/server/src` → three levels up). */
export const repoRoot = resolve(import.meta.dir, "../../..");

/** How long a failed scan is remembered before the next health check tries again. */
export const SOURCE_RETRY_MS = 5 * 60_000;

/**
 * This process's identity, worked out once on first use. A failure (an unreadable file, say) is remembered for
 * `SOURCE_RETRY_MS`, so health checks do not rescan the tree every time.
 */
export function runningSourceIdentity(root = repoRoot, now = Date.now): () => Promise<SourceIdentity> {
  let pending: Promise<SourceIdentity> | undefined;
  let failedAt: number | undefined;
  return () => {
    if (failedAt !== undefined && now() - failedAt >= SOURCE_RETRY_MS) {
      pending = undefined;
      failedAt = undefined;
    }
    pending ??= Promise.resolve()
      .then(() => sourceIdentityOf(scanSourceTree(root)))
      .catch((err) => {
        failedAt = now();
        throw err;
      });
    return pending;
  };
}
