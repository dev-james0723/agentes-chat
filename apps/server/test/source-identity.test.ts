import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createApp } from "../src/app";
import { workerHealth } from "../src/routes/health";
import {
  gitSourceEntries,
  inSourceScope,
  runningSourceIdentity,
  SOURCE_RETRY_MS,
  scanSourceTree,
  sourceIdentityOf,
} from "../src/source-identity";

function tree(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "source-identity-"));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}

function git(root: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
}

const files = {
  "apps/server/src/a.ts": "export const a = 1;\n",
  "apps/web/src/b.tsx": "export const b = 'é';\n",
  "packages/engine/src/c.ts": "export const c = 3;\n",
  "packages/db/migrations/0001_x.sql": "select 1;\n",
  "apps/server/runner/install-script.ts": "export const s = 1;\n",
  "apps/server/package.json": "{}\n",
  "package.json": "{}\n",
  "bun.lock": "{}\n",
};

test("the running tree and the git revision it came from give the same identity", () => {
  const root = tree(files);
  try {
    git(root, "init", "-q");
    git(root, "add", ".");
    git(root, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "x");
    const running = sourceIdentityOf(scanSourceTree(root));
    const fromGit = sourceIdentityOf(gitSourceEntries(root, "HEAD"));
    expect(running.files).toBe(8);
    expect(running.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(running).toEqual(fromGit);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("one changed source file changes the identity; files outside the source scope do not", () => {
  const base = sourceIdentityOf(scanSourceTree(tree(files)));
  const patched = sourceIdentityOf(
    scanSourceTree(tree({ ...files, "packages/engine/src/c.ts": "export const c = 4;\n" })),
  );
  expect(patched.digest).not.toBe(base.digest);
  const noise = tree({
    ...files,
    "packages/engine/node_modules/x/src/i.ts": "x",
    "apps/web/dist/src/o.js": "x",
    "docs/readme.md": "x",
    "apps/server/test/t.test.ts": "x",
  });
  expect(sourceIdentityOf(scanSourceTree(noise))).toEqual(base);
});

test("symlinks are left out on both sides, as git stores them differently from files", () => {
  const root = tree(files);
  try {
    symlinkSync("a.ts", join(root, "apps/server/src/link.ts"));
    expect(sourceIdentityOf(scanSourceTree(root)).files).toBe(8);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the scope is the code a server runs: app and package sources, and migrations", () => {
  expect(inSourceScope("apps/server/src/start.ts")).toBe(true);
  expect(inSourceScope("packages/db/migrations/meta/_journal.json")).toBe(true);
  expect(inSourceScope("apps/server/test/app.test.ts")).toBe(false);
  expect(inSourceScope("packages/engine/node_modules/a/src/x.ts")).toBe(false);
  expect(inSourceScope("apps/web/dist/src/x.js")).toBe(false);
  expect(inSourceScope("scripts/smoke.ts")).toBe(false);
  // The server imports its runner and serves its install script; a dependency change is a code change.
  expect(inSourceScope("apps/server/runner/install-script.ts")).toBe(true);
  expect(inSourceScope("apps/server/runner/assets/x.sh")).toBe(true);
  expect(inSourceScope("package.json")).toBe(true);
  expect(inSourceScope("bun.lock")).toBe(true);
  expect(inSourceScope("packages/engine/package.json")).toBe(true);
  expect(inSourceScope("README.md")).toBe(false);
  expect(inSourceScope("apps/server/runner/node_modules/x/a.ts")).toBe(false);
});

test("health carries the running source identity when the server has one", async () => {
  const source = { digest: `sha256:${"a".repeat(64)}`, files: 12 };
  const app = createApp({
    edition: "selfhost",
    version: "1",
    modules: [],
    pingDatabase: async () => {},
    sourceIdentity: async () => source,
  });
  expect(await (await app.request("/api/health")).json()).toMatchObject({ status: "ok", source });
  const worker = workerHealth({
    version: "1",
    edition: "selfhost",
    modules: [],
    pingDatabase: async () => {},
    sourceIdentity: async () => source,
  });
  expect(await (await worker(new Request("http://x/api/health"))).json()).toMatchObject({ source });
});

test("an identity the server could not work out is reported as unknown, and the server stays healthy", async () => {
  const app = createApp({
    edition: "selfhost",
    version: "1",
    modules: [],
    pingDatabase: async () => {},
    sourceIdentity: async () => {
      throw new Error("unreadable");
    },
  });
  const res = await app.request("/api/health");
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ status: "ok", source: null });
});

test("a scan that failed is remembered for a while, then tried again", async () => {
  // A root below a regular file cannot be read (ENOTDIR).
  const file = join(mkdtempSync(join(tmpdir(), "source-identity-")), "not-a-dir");
  writeFileSync(file, "x");
  let clock = 0;
  const identity = runningSourceIdentity(join(file, "app"), () => clock);
  const first = identity();
  await expect(first).rejects.toThrow();
  clock = SOURCE_RETRY_MS - 1;
  expect(identity()).toBe(first);
  clock = SOURCE_RETRY_MS;
  const retried = identity();
  expect(retried).not.toBe(first);
  await expect(retried).rejects.toThrow();
});

test("a server that works out its identity once reuses it", async () => {
  const identity = runningSourceIdentity(tree(files));
  const first = await identity();
  expect(first.files).toBe(8);
  expect(identity()).toBe(identity());
});
