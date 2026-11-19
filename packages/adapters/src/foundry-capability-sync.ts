import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { createFoundryRpcClient } from "./foundry-rpc";

/** One ACTIVE capability version, exported for the skills repository. Never evaluator cases or receipts. */
export interface FoundryCapabilityExport {
  digest: string;
  name: string;
  kind: "skill" | "tool";
  agent: string;
  why: string;
  use: string;
  files: { path: string; base64: string }[];
}
export type FoundryCapabilitySyncResult =
  | { state: "SYNCED"; commit: string; path: string; url: string }
  | { state: "REFUSED"; reason: string };
export interface FoundryCapabilityLookup {
  digest: string;
  name: string;
  kind: "skill" | "tool";
}

/** Saves capability versions to the skills repository. A throw means the outcome is unknown: the caller
 * looks the version up before ever syncing again. */
export interface FoundryCapabilitySyncPort {
  sync(capability: FoundryCapabilityExport): Promise<FoundryCapabilitySyncResult>;
  lookup(query: FoundryCapabilityLookup): Promise<{ commit: string; path: string; url: string } | null>;
}

/** The version marker written next to each capability: how a later lookup knows this exact version landed. */
export const FOUNDRY_VERSION_FILE = "FOUNDRY-VERSION.json";
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DIGEST = /^[a-f0-9]{64}$/;

type Run = (
  file: string,
  args: string[],
  options: { cwd?: string; timeoutMs: number },
) => Promise<{ code: number; stdout: string }>;

const runFile: Run = (file, args, { cwd, timeoutMs }) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error && (error as { killed?: boolean }).killed) return reject(new Error("timed out"));
      const code = error ? Number((error as { code?: unknown }).code) : 0;
      if (error && !Number.isInteger(code)) return reject(error);
      resolve({ code, stdout: String(stdout) });
    });
  });

/**
 * Host side only (the Foundry runtime service): runs James's `sync-skill` script against the local clone of the
 * skills repository, whose git credentials never leave this host. The app server reaches it through the runtime
 * RPC and never holds a git credential itself.
 */
export function createHostCapabilitySync(options: {
  script: string;
  repoDir: string;
  timeoutMs?: number;
  run?: Run;
}): FoundryCapabilitySyncPort {
  const run = options.run ?? runFile;
  // Inside the app's 115 s request, with time left for the fetch that checks the remote afterwards.
  const timeoutMs = options.timeoutMs ?? 50_000;
  const git = (args: string[]) => run("git", ["-C", options.repoDir, ...args], { timeoutMs: 30_000 });
  const url = async () => {
    const remote = (await git(["remote", "get-url", "origin"])).stdout.trim();
    return remote.replace(/\.git$/, "").replace(/^git@github\.com:/, "https://github.com/");
  };
  const check = (q: FoundryCapabilityLookup) => {
    if (!NAME.test(q.name) || !DIGEST.test(q.digest) || (q.kind !== "skill" && q.kind !== "tool"))
      throw new Error("Invalid capability reference");
    return `${q.kind === "skill" ? "skills" : "tools"}/${q.name}`;
  };

  /** On origin/main, the newest commit whose marker holds this exact digest. */
  async function onRemote(q: FoundryCapabilityLookup) {
    const path = check(q);
    if ((await git(["fetch", "-q", "origin", "main"])).code !== 0) throw new Error("Could not read the repository");
    const marker = await git(["show", `origin/main:${path}/${FOUNDRY_VERSION_FILE}`]);
    if (marker.code !== 0) return null;
    let digest: unknown;
    try {
      digest = (JSON.parse(marker.stdout) as { digest?: unknown }).digest;
    } catch {
      return null;
    }
    if (digest !== q.digest) return null;
    const log = await git(["log", "-1", "--format=%H", "origin/main", "--", `${path}/${FOUNDRY_VERSION_FILE}`]);
    const commit = log.stdout.trim();
    return /^[a-f0-9]{40}$/.test(commit) ? { commit, path, url: await url() } : null;
  }

  return {
    lookup: onRemote,
    async sync(capability) {
      const path = check(capability);
      const found = await onRemote(capability);
      if (found) return { state: "SYNCED", ...found };
      const work = await mkdtemp(join(tmpdir(), "foundry-sync-"));
      try {
        const folder = join(work, capability.name);
        for (const file of capability.files) {
          const rel = normalize(file.path);
          if (rel.startsWith("..") || rel.startsWith("/") || rel.includes("\0")) throw new Error("Invalid file path");
          await mkdir(dirname(join(folder, rel)), { recursive: true });
          await writeFile(join(folder, rel), Buffer.from(file.base64, "base64"));
        }
        const result = await run(
          options.script,
          [
            "--path",
            folder,
            "--kind",
            capability.kind,
            "--name",
            capability.name,
            "--agent",
            capability.agent,
            "--why",
            capability.why,
            "--use",
            capability.use,
          ],
          { timeoutMs },
        );
        const refusal = result.stdout.match(/^sync-skill: (refusing: .*)$/m);
        if (result.code !== 0 && refusal) return { state: "REFUSED", reason: refusal[1]!.slice(0, 500) };
        // Whatever the script said, only the remote decides: a commit that never reached origin is not saved.
        const landed = await onRemote(capability);
        if (landed) return { state: "SYNCED", ...landed };
        // The script commits before it pushes. A failed push leaves the commit here; push it once more.
        const ahead = await git([
          "log",
          "-1",
          "--format=%H",
          "origin/main..HEAD",
          "--",
          `${path}/${FOUNDRY_VERSION_FILE}`,
        ]);
        if (ahead.stdout.trim()) {
          await git(["push", "-q", "origin", "HEAD:main"]);
          const pushed = await onRemote(capability);
          if (pushed) return { state: "SYNCED", ...pushed };
        }
        throw new Error(`Sync did not reach the repository (exit ${result.code})`);
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    },
  };
}

/** The app server's side: asks the runtime service, which owns the repository clone. */
export function createRemoteCapabilitySync(options: {
  url: string;
  token: string;
  fetch?: typeof fetch;
}): FoundryCapabilitySyncPort {
  const call = createFoundryRpcClient(options);
  return {
    async sync(capability) {
      const result = (await call("syncCapability", { capability }, 115_000)) as FoundryCapabilitySyncResult;
      if (result?.state === "SYNCED" || result?.state === "REFUSED") return result;
      throw new Error("Unexpected sync answer");
    },
    async lookup(query) {
      return (await call("lookupCapability", { query }, 90_000)) as Awaited<
        ReturnType<FoundryCapabilitySyncPort["lookup"]>
      >;
    },
  };
}
