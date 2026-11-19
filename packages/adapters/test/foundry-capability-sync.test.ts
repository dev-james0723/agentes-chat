// SF-19 host side: a real git clone and bare remote, with a stand-in for sync-skill (same options and exit codes).
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHostCapabilitySync,
  createRemoteCapabilitySync,
  FOUNDRY_VERSION_FILE,
} from "../src/foundry-capability-sync";
import { createFoundryRpcHandler } from "../src/foundry-rpc";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd })
    .toString()
    .trim();

/** A bare remote with one commit on main, and a clone of it: the skills repository and its host clone. */
function repository(mode: "normal" | "push-fails") {
  const root = mkdtempSync(join(tmpdir(), "skills-repo-"));
  dirs.push(root);
  const remote = join(root, "remote.git");
  const clone = join(root, "clone");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  execFileSync("git", ["clone", "-q", remote, clone]);
  writeFileSync(join(clone, "catalog.jsonl"), "");
  git(clone, "add", ".");
  git(clone, "commit", "-q", "-m", "start");
  git(clone, "push", "-q", "origin", "HEAD:main");
  const script = join(root, "sync-skill");
  writeFileSync(
    script,
    `#!/bin/sh
REPO=${JSON.stringify(clone)}
while [ $# -gt 0 ]; do case "$1" in --path) SRC="$2"; shift 2 ;; --kind) KIND="$2"; shift 2 ;; --name) NAME="$2"; shift 2 ;; *) shift 2 ;; esac; done
if grep -rq 'sk-live-' "$SRC"; then echo "sync-skill: refusing: something that looks like a secret in: ./tool.mjs"; exit 1; fi
mkdir -p "$REPO/tools/$NAME" && cp -R "$SRC/." "$REPO/tools/$NAME/"
cd "$REPO" && git add -A && git -c user.name=t -c user.email=t@example.invalid commit -q -m "$NAME" || exit 1
${mode === "push-fails" ? 'echo "sync-skill: committed but the push failed"; exit 1' : "git push -q origin HEAD:main || exit 1"}
echo "sync-skill: tools/$NAME created"
`,
  );
  chmodSync(script, 0o755);
  return { remote, clone, script };
}

const DIGEST = "a".repeat(64);
const capability = (body = "export default () => 1;\n", digest = DIGEST) => ({
  digest,
  name: "receipt-normalizer",
  kind: "tool" as const,
  agent: "Charlie | Implementation Engineer",
  why: "Receipts arrived in three shapes.",
  use: "Normalize task receipts.",
  files: [
    { path: "tool.mjs", base64: Buffer.from(body).toString("base64") },
    { path: FOUNDRY_VERSION_FILE, base64: Buffer.from(JSON.stringify({ digest })).toString("base64") },
  ],
});

describe("host capability sync", () => {
  test("syncs, and the answer is the commit on the remote", async () => {
    const r = repository("normal");
    const sync = createHostCapabilitySync({ script: r.script, repoDir: r.clone });
    const result = await sync.sync(capability());
    expect(result).toMatchObject({ state: "SYNCED", path: "tools/receipt-normalizer" });
    if (result.state !== "SYNCED") throw new Error("expected SYNCED");
    expect(result.commit).toBe(git(r.remote, "rev-parse", "main"));
    expect(await sync.lookup(capability())).toMatchObject({ commit: result.commit });
  });

  test("a version already on the remote is not synced again", async () => {
    const r = repository("normal");
    const sync = createHostCapabilitySync({ script: r.script, repoDir: r.clone });
    await sync.sync(capability());
    const before = git(r.remote, "rev-list", "--count", "main");
    await sync.sync(capability());
    expect(git(r.remote, "rev-list", "--count", "main")).toBe(before);
  });

  test("lookup finds nothing for another digest", async () => {
    const r = repository("normal");
    const sync = createHostCapabilitySync({ script: r.script, repoDir: r.clone });
    await sync.sync(capability());
    expect(await sync.lookup({ digest: "b".repeat(64), name: "receipt-normalizer", kind: "tool" })).toBeNull();
  });

  test("a refusal is REFUSED and nothing reaches the remote", async () => {
    const r = repository("normal");
    const sync = createHostCapabilitySync({ script: r.script, repoDir: r.clone });
    const before = git(r.remote, "rev-parse", "main");
    expect(await sync.sync(capability("const key = 'sk-live-xyz';\n"))).toMatchObject({
      state: "REFUSED",
      reason: expect.stringContaining("looks like a secret"),
    });
    expect(git(r.remote, "rev-parse", "main")).toBe(before);
  });

  test("a commit whose push failed is pushed once more, then found on the remote", async () => {
    const r = repository("push-fails");
    const sync = createHostCapabilitySync({ script: r.script, repoDir: r.clone });
    const result = await sync.sync(capability());
    expect(result.state).toBe("SYNCED");
    expect(await sync.lookup(capability())).not.toBeNull();
  });

  test("a script that hangs is an unknown outcome, never a success", async () => {
    const r = repository("normal");
    writeFileSync(r.script, "#!/bin/sh\nsleep 5\n");
    const sync = createHostCapabilitySync({ script: r.script, repoDir: r.clone, timeoutMs: 300 });
    await expect(sync.sync(capability())).rejects.toThrow();
  });

  test("bad names, digests and paths are refused before anything runs", async () => {
    const r = repository("normal");
    const sync = createHostCapabilitySync({ script: r.script, repoDir: r.clone });
    await expect(sync.sync({ ...capability(), name: "../escape" })).rejects.toThrow("Invalid capability reference");
    await expect(sync.sync({ ...capability(), digest: "nope" })).rejects.toThrow("Invalid capability reference");
    await expect(sync.sync({ ...capability(), files: [{ path: "../../etc/x", base64: "eA==" }] })).rejects.toThrow(
      "Invalid file path",
    );
  });
});

test("the app reaches the host's sync only through the private runtime RPC, with its runtime token", async () => {
  const token = "c".repeat(64);
  const seen: unknown[] = [];
  const handle = createFoundryRpcHandler({
    token,
    methods: {
      syncCapability: async ({ capability }) => {
        seen.push(capability);
        return { state: "SYNCED", commit: "d".repeat(40), path: "tools/receipt-normalizer", url: "https://x" };
      },
      lookupCapability: async () => null,
    },
  });
  const fetch = ((input: string | URL | Request, init?: RequestInit) =>
    handle(input instanceof Request ? input : new Request(String(input), init))) as typeof globalThis.fetch;
  const remote = createRemoteCapabilitySync({ url: "http://127.0.0.1:9", token, fetch });
  expect(await remote.sync(capability())).toMatchObject({ state: "SYNCED", commit: "d".repeat(40) });
  expect(await remote.lookup(capability())).toBeNull();
  expect(seen).toHaveLength(1);
  const wrong = createRemoteCapabilitySync({ url: "http://127.0.0.1:9", token: "e".repeat(64), fetch });
  await expect(wrong.sync(capability())).rejects.toThrow();
});
