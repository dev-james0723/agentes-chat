/** Run only from the locally invoked owner CLI. Never wire this to server/machine RPC. */

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { checkFolder, foldersFor } from "./access";
import type { StoredConfig } from "./config";
import { createOwnerBinding } from "./paperclip-identity";
import { writeOwnerBinding } from "./paperclip-registry";
import { isInside } from "./paths";

type Args = {
  ownerId: string;
  agentIds: string[];
  sourceCompanyId: string;
  sourceProjectId: string;
  sourceWorkspaceId: string;
  projectFile: string;
  snapshotFile: string;
  bundleFile: string;
  projectDigest: string;
  snapshotDigest: string;
};
function ownerFile(file: string, max: number): Buffer {
  if (!path.isAbsolute(file) || realpathSync(file) !== path.resolve(file))
    throw new Error("owner source artifact path refused");
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0 || st.size > max)
      throw new Error("owner source artifact refused");
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function registerOwnerProject(home: string, config: StoredConfig, args: Args) {
  if (
    config.mode === "system" ||
    !config.orgId ||
    !config.machineId ||
    !config.workspace ||
    !config.access ||
    config.access.tools.commands !== true
  )
    throw new Error("paired single-user machine with commands required");
  const projectText = ownerFile(args.projectFile, 1024 * 1024).toString("utf8"),
    snapshotText = ownerFile(args.snapshotFile, 4 * 1024 * 1024).toString("utf8"),
    bundle = ownerFile(args.bundleFile, 16 * 1024 * 1024);
  const snapshot = JSON.parse(snapshotText) as { source: string };
  const source = realpathSync(snapshot.source);
  const workspace = realpathSync(config.workspace);
  if (isInside(source, workspace) || isInside(workspace, source)) throw new Error("source overlaps agent workspace");
  const roots = new Map(
    args.agentIds.map((id) => [
      id,
      foldersFor(config.access!, id).map((p) =>
        checkFolder(p, { runnerHome: home, ...(config.workspace ? { workspace: config.workspace } : {}) }),
      ),
    ]),
  );
  for (const list of roots.values())
    if (list.some((root) => isInside(root, source) || isInside(source, root)))
      throw new Error("source workspace already granted");
  const binding = createOwnerBinding(
    {
      orgId: config.orgId,
      machineId: config.machineId,
      ownerId: args.ownerId,
      agentIds: args.agentIds,
      generation: randomUUID(),
      uid: process.getuid?.() ?? -1,
      sourceCompanyId: args.sourceCompanyId,
      sourceProjectId: args.sourceProjectId,
      sourceWorkspaceId: args.sourceWorkspaceId,
      projectText,
      snapshotText,
      bundle,
      projectDigest: args.projectDigest,
      snapshotDigest: args.snapshotDigest,
    },
    (agent, target) => roots.get(agent)?.some((root) => isInside(root, target)) === true,
  );
  // Git reads only the already-hashed bundle through stdin; no hooks, global Git config or source repo code.
  const git = (...argv: string[]) =>
    spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-C", binding.target.real, "bundle", ...argv, "-"], {
      input: bundle,
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 1024 * 1024,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_OPTIONAL_LOCKS: "0",
      },
    });
  const heads = git("list-heads");
  if (heads.status !== 0 || !heads.stdout.split("\n").some((line) => line === `${binding.sourceHead} HEAD`))
    throw new Error("source bundle HEAD mismatch");
  if (git("verify").status !== 0) throw new Error("source bundle verification failed");
  for (const cwd of [binding.source.real, binding.target.real]) {
    const current = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-C", cwd, "rev-parse", "--verify", "HEAD"], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 1024,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_OPTIONAL_LOCKS: "0",
      },
    });
    if (current.status !== 0 || current.stdout.trim() !== binding.sourceHead)
      throw new Error("snapshot Git HEAD changed");
  }
  const bindingId = randomUUID(),
    record = { id: bindingId, ...binding };
  writeOwnerBinding(home, bindingId, record);
  return {
    bindingId,
    generation: binding.generation,
    bindingDigest: createHash("sha256").update(JSON.stringify(record)).digest("hex"),
    registration: {
      id: bindingId,
      machineId: binding.machineId,
      generation: binding.generation,
      sourceCompanyId: binding.sourceCompanyId,
      sourceProjectId: binding.sourceProjectId,
      sourceWorkspaceId: binding.sourceWorkspaceId,
      projectDigest: binding.projectDigest,
      snapshotDigest: binding.snapshotDigest,
      targetCwd: binding.target.real,
      agentIds: binding.agentIds,
      bindingDigest: createHash("sha256").update(JSON.stringify(record)).digest("hex"),
    },
  };
}
