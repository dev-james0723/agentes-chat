/** Owner-local prototype only. Do not expose registration or source paths to an agent or remote RPC. */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";

type FileInfo = { bytes: number; sha256: string };
type Project = { id: string; companyId: string; workspaces: { id: string; cwd: string; isPrimary: boolean }[] };
type Snapshot = {
  source: string;
  target: string;
  sourceHead: string;
  historyBundleSha256: string;
  sourceAndTargetMatch: boolean;
  files: Record<string, FileInfo>;
};
type Identity = { requested: string; real: string; chain: { dev: string; ino: string }[] };
type Input = {
  orgId: string;
  machineId: string;
  ownerId: string;
  agentIds: string[];
  generation: string;
  uid: number;
  sourceCompanyId: string;
  sourceProjectId: string;
  sourceWorkspaceId: string;
  projectText: string;
  snapshotText: string;
  projectDigest: string;
  snapshotDigest: string;
  bundle: Buffer;
};
export type Binding = {
  version: 1;
  orgId: string;
  machineId: string;
  ownerId: string;
  agentIds: string[];
  generation: string;
  uid: number;
  sourceCompanyId: string;
  sourceProjectId: string;
  sourceWorkspaceId: string;
  projectDigest: string;
  snapshotDigest: string;
  sourceHead: string;
  historyBundleSha256: string;
  source: Identity;
  target: Identity;
  sourceGit: Identity | null;
  targetGit: Identity | null;
};
type Expected = { orgId: string; machineId: string; ownerId: string; agentId: string; generation: string };
type Grant = (agentId: string, targetReal: string) => boolean;
const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hex64 = /^[0-9a-f]{64}$/;
const fail = (): never => {
  throw new Error("workspace binding refused");
};

function identity(requested: string): Identity {
  if (typeof requested !== "string" || !path.isAbsolute(requested) || requested === "/" || requested.includes("\0"))
    return fail();
  const abs = path.resolve(requested);
  // Owner must choose paths without symlinked components: avoid retaining a mutable alias.
  for (let at = abs; ; at = path.dirname(at)) {
    const st = lstatSync(at);
    if (st.isSymbolicLink()) return fail();
    if (at === path.dirname(at)) break;
  }
  const real = realpathSync(abs);
  const chain: Identity["chain"] = [];
  for (let at = real; ; at = path.dirname(at)) {
    const st = statSync(at, { bigint: true });
    if (!st.isDirectory()) return fail();
    chain.push({ dev: st.dev.toString(), ino: st.ino.toString() });
    if (at === path.dirname(at)) break;
  }
  return { requested: abs, real, chain };
}
const key = (x: { dev: string; ino: string }) => `${x.dev}:${x.ino}`;
function separate(source: Identity, target: Identity) {
  if (
    source.chain.some((x) => key(x) === key(target.chain[0]!)) ||
    target.chain.some((x) => key(x) === key(source.chain[0]!))
  )
    return fail();
}
function checkedFile(root: string, relative: string, info: FileInfo): string {
  if (
    typeof relative !== "string" ||
    !relative ||
    relative.includes("\0") ||
    relative.includes("\\") ||
    path.posix.isAbsolute(relative) ||
    relative.split("/").some((x) => !x || x === "." || x === "..")
  )
    return fail();
  if (
    !info ||
    !Number.isSafeInteger(info.bytes) ||
    info.bytes < 0 ||
    info.bytes > 16 * 1024 * 1024 ||
    !hex64.test(info.sha256)
  )
    return fail();
  let current = root;
  for (const component of relative.split("/")) {
    current = path.join(current, component);
    if (lstatSync(current).isSymbolicLink()) return fail();
  }
  const fd = openSync(current, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const st = fstatSync(fd, { bigint: true });
    if (!st.isFile() || st.size !== BigInt(info.bytes) || sha(readFileSync(fd)) !== info.sha256) return fail();
    return key({ dev: st.dev.toString(), ino: st.ino.toString() });
  } finally {
    closeSync(fd);
  }
}
function gitIdentity(root: string): Identity | null {
  const git = path.join(root, ".git");
  try {
    lstatSync(git);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  const g = identity(git);
  if (!g.real.startsWith(root + path.sep)) return fail();
  for (const name of ["commondir", "gitdir", "objects/info/alternates"])
    if (existsSync(path.join(g.real, name))) return fail();
  // Git can redirect its worktree or include an external configuration even when .git itself is separate.
  // Ask Git to parse only this local config, without following includes or printing any values.
  const config = path.join(g.real, "config");
  const st = lstatSync(config);
  if (!st.isFile() || st.isSymbolicLink() || st.size > 131072) return fail();
  const check = spawnSync(
    "git",
    [
      "config",
      "--no-includes",
      "--file",
      config,
      "--name-only",
      "--get-regexp",
      "^(core\\.worktree|core\\.hookspath|include\\..*|includeif\\..*|extensions\\.worktreeconfig)$",
    ],
    {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 131072,
    },
  );
  if (check.error || check.status !== 1) return fail();
  return g;
}
/** Current subtree identities, including git metadata; never follow a link. */
function currentTree(root: string): Set<string> {
  let count = 0;
  const ids = new Set<string>();
  function walk(dir: string, rel: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!rel && entry.name === "node_modules") return fail();
      if (++count > 12000) return fail();
      const next = path.join(dir, entry.name),
        st = lstatSync(next, { bigint: true });
      if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile())) return fail();
      ids.add(key({ dev: st.dev.toString(), ino: st.ino.toString() }));
      if (st.isDirectory()) walk(next, rel ? `${rel}/${entry.name}` : entry.name);
    }
  }
  walk(root, "");
  return ids;
}
function disjointTrees(source: string, target: string) {
  const a = currentTree(source),
    b = currentTree(target);
  if ([...b].some((x) => a.has(x))) return fail();
}
function checkInventory(root: string, expected: Set<string>): void {
  let visited = 0;
  const found = new Set<string>();
  function walk(dir: string, relative: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!relative && (entry.name === ".git" || entry.name === "node_modules")) continue;
      if (++visited > 6000) return fail();
      const rel = relative ? `${relative}/${entry.name}` : entry.name,
        full = path.join(dir, entry.name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) return fail();
      if (st.isDirectory()) walk(full, rel);
      else if (st.isFile()) found.add(rel);
      else return fail();
    }
  }
  walk(root, "");
  if (found.size !== expected.size || [...found].some((x) => !expected.has(x))) fail();
}
export function createOwnerBinding(input: Input, isGranted: Grant): Binding {
  if (
    ![
      input.orgId,
      input.machineId,
      input.generation,
      input.sourceCompanyId,
      input.sourceProjectId,
      input.sourceWorkspaceId,
      ...input.agentIds,
    ].every((x) => uuid.test(x))
  )
    return fail();
  if (
    typeof input.ownerId !== "string" ||
    !input.ownerId ||
    input.ownerId.length > 256 ||
    [...input.ownerId].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    return fail();
  if (
    !input.agentIds.length ||
    input.agentIds.length > 32 ||
    new Set(input.agentIds).size !== input.agentIds.length ||
    input.uid !== process.getuid?.()
  )
    return fail();
  if (
    Buffer.byteLength(input.projectText) > 1024 * 1024 ||
    Buffer.byteLength(input.snapshotText) > 4 * 1024 * 1024 ||
    sha(input.projectText) !== input.projectDigest ||
    sha(input.snapshotText) !== input.snapshotDigest
  )
    return fail();
  const project = JSON.parse(input.projectText) as Project,
    snapshot = JSON.parse(input.snapshotText) as Snapshot;
  if (
    project.id !== input.sourceProjectId ||
    project.companyId !== input.sourceCompanyId ||
    !Array.isArray(project.workspaces)
  )
    return fail();
  const ws = project.workspaces.filter((x) => x.id === input.sourceWorkspaceId);
  if (ws.length !== 1 || ws[0]?.isPrimary !== true || ws[0]?.cwd !== snapshot.source) return fail();
  if (
    snapshot.sourceAndTargetMatch !== true ||
    !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(snapshot.sourceHead) ||
    !hex64.test(snapshot.historyBundleSha256) ||
    !Buffer.isBuffer(input.bundle) ||
    input.bundle.length > 16 * 1024 * 1024 ||
    sha(input.bundle) !== snapshot.historyBundleSha256 ||
    !snapshot.files ||
    typeof snapshot.files !== "object" ||
    Array.isArray(snapshot.files)
  )
    return fail();
  const source = identity(snapshot.source),
    target = identity(snapshot.target);
  separate(source, target);
  const sourceGit = gitIdentity(source.real),
    targetGit = gitIdentity(target.real);
  if (Boolean(sourceGit) !== Boolean(targetGit)) return fail();
  if (sourceGit && targetGit) separate(sourceGit, targetGit);
  disjointTrees(source.real, target.real);
  const entries = Object.entries(snapshot.files);
  if (
    !entries.length ||
    entries.length > 3000 ||
    entries.reduce((n, [, v]) => n + (Number.isSafeInteger(v?.bytes) ? v.bytes : Infinity), 0) > 32 * 1024 * 1024
  )
    return fail();
  const expected = new Set(entries.map(([name]) => name));
  checkInventory(source.real, expected);
  checkInventory(target.real, expected);
  const sourceFiles = new Set(entries.map(([name, info]) => checkedFile(source.real, name, info)));
  for (const [name, info] of entries) if (sourceFiles.has(checkedFile(target.real, name, info))) return fail();
  if (!input.agentIds.every((agent) => isGranted(agent, target.real))) return fail();
  return {
    version: 1,
    orgId: input.orgId,
    machineId: input.machineId,
    ownerId: input.ownerId,
    agentIds: [...input.agentIds],
    generation: input.generation,
    uid: input.uid,
    sourceCompanyId: input.sourceCompanyId,
    sourceProjectId: input.sourceProjectId,
    sourceWorkspaceId: input.sourceWorkspaceId,
    projectDigest: input.projectDigest,
    snapshotDigest: input.snapshotDigest,
    sourceHead: snapshot.sourceHead,
    historyBundleSha256: snapshot.historyBundleSha256,
    source,
    target,
    sourceGit,
    targetGit,
  };
}
export function verifyBinding(binding: Binding, expected: Expected, isGranted: Grant): true {
  if (
    binding.version !== 1 ||
    binding.uid !== process.getuid?.() ||
    binding.orgId !== expected.orgId ||
    binding.machineId !== expected.machineId ||
    binding.ownerId !== expected.ownerId ||
    binding.generation !== expected.generation ||
    !binding.agentIds.includes(expected.agentId)
  )
    return fail();
  const source = identity(binding.source.requested),
    target = identity(binding.target.requested);
  separate(source, target);
  const sourceGit = gitIdentity(source.real),
    targetGit = gitIdentity(target.real);
  if (sourceGit && targetGit) separate(sourceGit, targetGit);
  if (
    JSON.stringify(source) !== JSON.stringify(binding.source) ||
    JSON.stringify(target) !== JSON.stringify(binding.target) ||
    JSON.stringify(sourceGit) !== JSON.stringify(binding.sourceGit) ||
    JSON.stringify(targetGit) !== JSON.stringify(binding.targetGit) ||
    !isGranted(expected.agentId, target.real)
  )
    return fail();
  disjointTrees(source.real, target.real);
  return true;
}
