import { afterEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOwnerBinding, verifyBinding } from "../../runner/paperclip-identity";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "paperclip-workspace-proof-")));
  dirs.push(root);
  const source = join(root, "source"),
    target = join(root, "target");
  mkdirSync(source);
  mkdirSync(target);
  for (const dir of [source, target]) writeFileSync(join(dir, "readme.md"), "verified copy\n");
  const orgId = randomUUID(),
    machineId = randomUUID(),
    ownerId = "owner-auth-id_Ab12",
    agentId = randomUUID(),
    projectId = randomUUID(),
    workspaceId = randomUUID(),
    companyId = randomUUID();
  const project = { id: projectId, companyId, workspaces: [{ id: workspaceId, cwd: source, isPrimary: true }] };
  const bundle = Buffer.from("synthetic snapshot history");
  const snapshot = {
    source,
    target,
    sourceHead: "a".repeat(40),
    historyBundleSha256: sha(bundle.toString()),
    sourceAndTargetMatch: true,
    files: { "readme.md": { bytes: 14, sha256: sha("verified copy\n") } },
  };
  const input = {
    orgId,
    machineId,
    ownerId,
    agentIds: [agentId],
    generation: randomUUID(),
    uid: process.getuid!(),
    sourceCompanyId: companyId,
    sourceProjectId: projectId,
    sourceWorkspaceId: workspaceId,
    projectText: JSON.stringify(project),
    snapshotText: JSON.stringify(snapshot),
    projectDigest: sha(JSON.stringify(project)),
    snapshotDigest: sha(JSON.stringify(snapshot)),
    bundle,
  };
  const granted = (agent: string, path: string) => agent === agentId && path === target;
  return { root, source, target, input, project, snapshot, granted };
}

test("owner registration validates provenance and both snapshots, then rechecks the same native directories and grant", () => {
  const f = fixture();
  const b = createOwnerBinding(f.input, f.granted);
  expect(b.target.real).toBe(f.target);
  expect(b.source.real).toBe(f.source);
  expect(
    verifyBinding(
      b,
      {
        orgId: f.input.orgId,
        machineId: f.input.machineId,
        ownerId: f.input.ownerId,
        agentId: f.input.agentIds[0]!,
        generation: f.input.generation,
      },
      f.granted,
    ),
  ).toBe(true);
});

test("refuses source/target overlap, symlink alias, different file content, and ungranted agent", () => {
  const f = fixture();
  const overlapping = JSON.stringify({ ...f.snapshot, target: f.source });
  expect(() =>
    createOwnerBinding({ ...f.input, snapshotText: overlapping, snapshotDigest: sha(overlapping) }, f.granted),
  ).toThrow();
  const alias = join(f.root, "alias");
  symlinkSync(f.source, alias);
  const aliased = JSON.stringify({ ...f.snapshot, target: alias });
  expect(() =>
    createOwnerBinding({ ...f.input, snapshotText: aliased, snapshotDigest: sha(aliased) }, f.granted),
  ).toThrow();
  writeFileSync(join(f.target, "readme.md"), "different");
  expect(() => createOwnerBinding(f.input, f.granted)).toThrow();
  writeFileSync(join(f.target, "readme.md"), "verified copy\n");
  expect(() => createOwnerBinding(f.input, () => false)).toThrow();
});

test("refuses forged metadata, manifest digest, path traversal, workspace mismatch and source unavailability", () => {
  const f = fixture();
  expect(() => createOwnerBinding({ ...f.input, projectDigest: "0".repeat(64) }, f.granted)).toThrow();
  expect(() => createOwnerBinding({ ...f.input, snapshotDigest: "0".repeat(64) }, f.granted)).toThrow();
  expect(() => createOwnerBinding({ ...f.input, bundle: Buffer.from("different history") }, f.granted)).toThrow();
  expect(() => createOwnerBinding({ ...f.input, sourceWorkspaceId: randomUUID() }, f.granted)).toThrow();
  const bad = { ...f.snapshot, files: { "../readme.md": { bytes: 14, sha256: sha("verified copy\n") } } };
  expect(() =>
    createOwnerBinding(
      { ...f.input, snapshotText: JSON.stringify(bad), snapshotDigest: sha(JSON.stringify(bad)) },
      f.granted,
    ),
  ).toThrow();
  rmSync(f.source, { recursive: true });
  expect(() => createOwnerBinding(f.input, f.granted)).toThrow();
});

test("rejects unlisted files and symlinked contents rather than validating a partial inventory", () => {
  const f = fixture();
  writeFileSync(join(f.source, "unlisted.txt"), "extra");
  expect(() => createOwnerBinding(f.input, f.granted)).toThrow();
  rmSync(join(f.source, "unlisted.txt"));
  symlinkSync(join(f.source, "readme.md"), join(f.source, "link"));
  expect(() => createOwnerBinding(f.input, f.granted)).toThrow();
});

test("rejects shared hardlinked snapshot files and a .git symlink to the source", () => {
  const f = fixture();
  rmSync(join(f.target, "readme.md"));
  linkSync(join(f.source, "readme.md"), join(f.target, "readme.md"));
  expect(() => createOwnerBinding(f.input, f.granted)).toThrow();
  rmSync(join(f.target, "readme.md"));
  writeFileSync(join(f.target, "readme.md"), "verified copy\n");
  mkdirSync(join(f.source, ".git"));
  symlinkSync(join(f.source, ".git"), join(f.target, ".git"));
  expect(() => createOwnerBinding(f.input, f.granted)).toThrow();
});

test("ordinary rename or replacement, a source/target symlink change, revoked grant and identity drift fail closed", () => {
  const f = fixture();
  const b = createOwnerBinding(f.input, f.granted);
  const expected = {
    orgId: f.input.orgId,
    machineId: f.input.machineId,
    ownerId: f.input.ownerId,
    agentId: f.input.agentIds[0]!,
    generation: f.input.generation,
  };
  expect(() => verifyBinding(b, { ...expected, orgId: randomUUID() }, f.granted)).toThrow();
  expect(() => verifyBinding(b, expected, () => false)).toThrow();
  renameSync(f.target, join(f.root, "old-target"));
  mkdirSync(f.target);
  expect(() => verifyBinding(b, expected, f.granted)).toThrow();
  rmSync(f.target, { recursive: true });
  symlinkSync(f.source, f.target);
  expect(() => verifyBinding(b, expected, f.granted)).toThrow();
});

test("a new symlink or hardlink into source after registration fails before use", () => {
  const f = fixture();
  const b = createOwnerBinding(f.input, f.granted);
  const expected = {
    orgId: f.input.orgId,
    machineId: f.input.machineId,
    ownerId: f.input.ownerId,
    agentId: f.input.agentIds[0]!,
    generation: f.input.generation,
  };
  symlinkSync(join(f.source, "readme.md"), join(f.target, "new-link"));
  expect(() => verifyBinding(b, expected, f.granted)).toThrow();
  rmSync(join(f.target, "new-link"));
  linkSync(join(f.source, "readme.md"), join(f.target, "new-hardlink"));
  expect(() => verifyBinding(b, expected, f.granted)).toThrow();
});

test("a changed Git worktree redirect fails workspace verification", () => {
  const f = fixture();
  for (const dir of [f.source, f.target]) {
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".git", "config"), "[core]\n\tbare = false\n");
  }
  const b = createOwnerBinding(f.input, f.granted);
  const expected = {
    orgId: f.input.orgId,
    machineId: f.input.machineId,
    ownerId: f.input.ownerId,
    agentId: f.input.agentIds[0]!,
    generation: f.input.generation,
  };
  writeFileSync(join(f.target, ".git", "config"), `[core]\n\tworktree = ${f.source}\n`);
  expect(() => verifyBinding(b, expected, f.granted)).toThrow();
});
