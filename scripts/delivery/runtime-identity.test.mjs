import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { checkRuntime, inSourceScope, revisionIdentity } from "./runtime-identity.mjs";

function git(root, ...args) {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout;
}
const blob = (text) =>
  createHash("sha1")
    .update(`blob ${Buffer.byteLength(text)}\0`)
    .update(text)
    .digest("hex");

/** A repository with files in and out of the server's source scope. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "runtime-identity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "t");
  const files = {
    "package.json": "{}\n",
    "bun.lock": "lock\n",
    "apps/server/package.json": "{}\n",
    "apps/server/src/app.ts": "export {}\n",
    "apps/server/runner/main.ts": "run\n",
    "packages/db/migrations/0001_a.sql": "select 1;\n",
    "apps/server/test/app.test.ts": "test\n",
    "apps/web/dist/index.js": "built\n",
    "README.md": "readme\n",
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, dirname(path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  return { root, files, head: git(root, "rev-parse", "HEAD").trim() };
}

/** What the server reports for a set of path → text: the same scope, sorted, path and blob per line. */
function expectedDigest(files) {
  const inScope = Object.keys(files)
    .filter(inSourceScope)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const hash = createHash("sha256");
  for (const path of inScope) hash.update(`${path}\0${blob(files[path])}\n`);
  return { digest: `sha256:${hash.digest("hex")}`, files: inScope.length };
}

const health =
  (body, status = 200) =>
  async () => ({ status, ok: status === 200, text: async () => JSON.stringify(body) });

test("the scope is the server's: sources, runner, migrations and manifests; never tests or build output", () => {
  for (const p of [
    "package.json",
    "bun.lock",
    "apps/server/package.json",
    "apps/server/src/app.ts",
    "apps/server/runner/main.ts",
    "packages/db/migrations/0001_a.sql",
    "packages/engine/src/team.ts",
  ])
    assert.equal(inSourceScope(p), true, p);
  for (const p of [
    "README.md",
    "apps/server/test/app.test.ts",
    "apps/web/dist/index.js",
    "packages/engine/src/node_modules/x/index.js",
    "apps/web/runner/x.ts",
    "scripts/delivery/guardian.mjs",
  ])
    assert.equal(inSourceScope(p), false, p);
});

test("a revision's identity comes from its tree alone, as the server computes it from its files", (t) => {
  const { root, files, head } = fixture(t);
  assert.deepEqual(revisionIdentity(root, head), { commit: head, ...expectedDigest(files) });
  // An uncommitted edit changes nothing: the identity is the revision's, not the work tree's.
  writeFileSync(join(root, "apps/server/src/app.ts"), "export const changed = 1\n");
  assert.deepEqual(revisionIdentity(root, head), { commit: head, ...expectedDigest(files) });
});

test("a revision that does not exist is refused, never treated as empty", (t) => {
  const { root } = fixture(t);
  assert.throws(() => revisionIdentity(root, "0".repeat(40)));
  assert.throws(() => revisionIdentity(root, "--output=/tmp/x"));
});

test("live matches the revision: match, with both identities", async (t) => {
  const { root, files, head } = fixture(t);
  const id = expectedDigest(files);
  const d = await checkRuntime(root, head, "http://127.0.0.1:3000", {
    fetch: health({ status: "ok", source: id }),
  });
  assert.equal(d.status, "match");
  assert.equal(d.revision, head);
  assert.deepEqual(d.running, id);
  assert.deepEqual(d.expected, id);
});

test("live runs other code: mismatch, never match on file count alone", async (t) => {
  const { root, files, head } = fixture(t);
  const id = expectedDigest(files);
  const d = await checkRuntime(root, head, "http://127.0.0.1:3000", {
    fetch: health({ status: "ok", source: { digest: `sha256:${"a".repeat(64)}`, files: id.files } }),
  });
  assert.equal(d.status, "mismatch");
});

test("no identity to compare is unknown with its reason, never match", async (t) => {
  const { root, head } = fixture(t);
  const cases = [
    [health({ status: "ok" }), "no_source_identity"],
    [health({ status: "ok", source: { digest: "md5:x", files: 1 } }), "no_source_identity"],
    [health({}, 503), "health_status_503"],
    [
      async () => {
        throw new Error("ECONNREFUSED");
      },
      "unreachable",
    ],
    [async () => ({ status: 200, ok: true, text: async () => "not json" }), "unreachable"],
  ];
  for (const [fetch, reason] of cases) {
    const d = await checkRuntime(root, head, "http://127.0.0.1:3000", { fetch });
    assert.equal(d.status, "unknown", reason);
    assert.equal(d.reason, reason);
  }
});

test("only an http(s) base address is read, and only its health endpoint", async (t) => {
  const { root, files, head } = fixture(t);
  const seen = [];
  const fetch = async (url, init) => {
    seen.push([url, init?.method ?? "GET", init?.redirect]);
    return { status: 200, ok: true, text: async () => JSON.stringify({ source: expectedDigest(files) }) };
  };
  await checkRuntime(root, head, "https://agentes.example/", { fetch });
  assert.deepEqual(seen, [["https://agentes.example/api/health", "GET", "error"]]);
  for (const bad of ["file:///etc/passwd", "ftp://x", "not a url", "http://user:pw@host"])
    await assert.rejects(() => checkRuntime(root, head, bad, { fetch }), /runtime URL/);
});

/** The Guardian's own CLI against a real local server; `serve.source` is what its health reports. */
async function guardianAgainst(t) {
  const { root, files } = fixture(t);
  git(root, "remote", "add", "origin", "https://github.com/example/app.git");
  git(root, "checkout", "-q", "-b", "feat/task");
  const serve = { source: expectedDigest(files) };
  const server = createServer((req, res) => {
    if (req.url !== "/api/health") return res.writeHead(404).end();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", source: serve.source }));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const run = (...extra) =>
    new Promise((done) => {
      const p = spawn(process.execPath, [
        join(import.meta.dirname, "guardian.mjs"),
        "observe",
        "--root",
        root,
        ...extra,
      ]);
      let out = "";
      p.stdout.on("data", (d) => {
        out += d;
      });
      p.on("close", (code) => done({ code, out }));
    });
  return { url, run, serve };
}

test("observe --runtime-url: the server runs the observed HEAD, exit 0 and match", async (t) => {
  const { url, run } = await guardianAgainst(t);
  const { code, out } = await run("--runtime-url", url);
  const o = JSON.parse(out);
  assert.equal(o.deployment.status, "match");
  assert.equal(o.deployment.revision, o.head);
  assert.deepEqual(o.errors, []);
  assert.equal(code, 0);
});

test("observe --runtime-url: other code running is a blocker, exit 1 and runtime_mismatch", async (t) => {
  const { url, run, serve } = await guardianAgainst(t);
  serve.source = { digest: `sha256:${"b".repeat(64)}`, files: serve.source.files };
  const { code, out } = await run("--runtime-url", url);
  const o = JSON.parse(out);
  assert.equal(o.deployment.status, "mismatch");
  assert.ok(o.errors.includes("runtime_mismatch"));
  assert.equal(code, 1);
});

test("observe --runtime-url: no server to ask is unverified, exit 1, never a match", async (t) => {
  const { run } = await guardianAgainst(t);
  const { code, out } = await run("--runtime-url", "http://127.0.0.1:9");
  const o = JSON.parse(out);
  assert.equal(o.deployment.status, "unknown");
  assert.ok(o.errors.includes("runtime_unverified"));
  assert.equal(code, 1);
});

test("observe without --runtime-url leaves deployment unknown and asks nothing", async (t) => {
  const { run } = await guardianAgainst(t);
  const { code, out } = await run();
  const o = JSON.parse(out);
  assert.equal(o.deployment.status, "unknown");
  assert.deepEqual(o.errors, []);
  assert.equal(code, 0);
});

test("the text summary says verified only on a match, and still asks for runner and user-path evidence", async (t) => {
  const { url, run, serve } = await guardianAgainst(t);
  const matched = await run("--runtime-url", url, "--text");
  assert.match(matched.out, /伺服器源碼：已核實同本機 commit 一樣/);
  assert.match(matched.out, /執行器同用戶流程仍然要另外核實/);
  serve.source = { digest: `sha256:${"c".repeat(64)}`, files: 1 };
  const mismatched = await run("--runtime-url", url, "--text");
  assert.match(mismatched.out, /同本機 commit 唔一樣/);
  assert.equal(mismatched.code, 1);
});

test("no files is no evidence: an empty identity on either side is unknown, never a match", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "runtime-identity-empty-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "t");
  writeFileSync(join(root, "README.md"), "nothing in scope\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "empty scope");
  const head = git(root, "rev-parse", "HEAD").trim();
  const empty = revisionIdentity(root, head);
  assert.equal(empty.files, 0);
  // A server whose root is wrong hashes to the same empty digest: that is not proof of anything.
  const d = await checkRuntime(root, head, "http://127.0.0.1:3000", { fetch: health({ source: empty }) });
  assert.equal(d.status, "unknown");
  assert.equal(d.reason, "empty_source_identity");
  // And a server that reports no files against a real revision is unknown too.
  const { root: r2, head: h2 } = fixture(t);
  const d2 = await checkRuntime(r2, h2, "http://127.0.0.1:3000", { fetch: health({ source: empty }) });
  assert.equal(d2.status, "unknown");
  assert.equal(d2.reason, "empty_source_identity");
});

test("a base address with a query or fragment is refused, so the health asked is the one meant", async (t) => {
  const { root, head } = fixture(t);
  const fetch = health({});
  for (const bad of ["http://h/staging?x=1", "http://h/staging#top", "https://h/?a"])
    await assert.rejects(() => checkRuntime(root, head, bad, { fetch }), /runtime URL/);
  const seen = [];
  await checkRuntime(root, head, "http://h/staging", {
    fetch: async (url) => {
      seen.push(url);
      return { status: 200, ok: true, text: async () => "{}" };
    },
  });
  assert.deepEqual(seen, ["http://h/staging/api/health"]);
});

test("a health body over 64 KiB is not read whole: unknown, too_large", async (t) => {
  const { root, head } = fixture(t);
  const big = "x".repeat(70 * 1024);
  const d = await checkRuntime(root, head, "http://127.0.0.1:3000", {
    fetch: async () => ({ status: 200, ok: true, text: async () => big }),
  });
  assert.equal(d.status, "unknown");
  assert.equal(d.reason, "too_large");
});

test("the commit compared is the one the identity was computed from, resolved once", async (t) => {
  const { root, files } = fixture(t);
  const id = expectedDigest(files);
  const head = git(root, "rev-parse", "HEAD").trim();
  const d = await checkRuntime(root, "main", "http://127.0.0.1:3000", { fetch: health({ source: id }) });
  assert.equal(d.revision, head);
  assert.equal(revisionIdentity(root, "main").commit, head);
});

test("the text summary says why the server's source is unverified", async (t) => {
  const { run } = await guardianAgainst(t);
  const unreachable = await run("--runtime-url", "http://127.0.0.1:9", "--text");
  assert.match(unreachable.out, /伺服器源碼：未能核實（unreachable）/);
  assert.equal(unreachable.code, 1);
});

test("an empty ? or # never drops the base path", async (t) => {
  const { root, head } = fixture(t);
  const seen = [];
  const fetch = async (url) => {
    seen.push(url);
    return { status: 200, ok: true, text: async () => "{}" };
  };
  for (const base of ["http://h/staging?", "http://h/staging#", "http://h/staging/"])
    await checkRuntime(root, head, base, { fetch });
  assert.deepEqual(seen, ["http://h/staging/api/health", "http://h/staging/api/health", "http://h/staging/api/health"]);
});

test("a streamed body past 64 KiB is cut off and cancelled: unknown, too_large", async (t) => {
  const { root, head } = fixture(t);
  let pulled = 0;
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      pulled++;
      controller.enqueue(new Uint8Array(16 * 1024).fill(0x20));
    },
    cancel() {
      cancelled = true;
    },
  });
  const d = await checkRuntime(root, head, "http://127.0.0.1:3000", {
    fetch: async () => ({ status: 200, ok: true, body, text: async () => assert.fail("text() must not be used") }),
  });
  assert.equal(d.status, "unknown");
  assert.equal(d.reason, "too_large");
  assert.equal(cancelled, true);
  assert.ok(pulled <= 6, `read ${pulled} chunks`);
});
