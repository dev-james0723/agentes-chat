// Which git revision a running server is made of, from the code itself rather than an image's tag or label.
//
//   bun scripts/runtime-identity.ts rev <revision>                 identity of a revision's tree
//   bun scripts/runtime-identity.ts dir <path>                     identity of a checkout or an image's extracted /app
//   bun scripts/runtime-identity.ts check --url <base> --rev <r>…  compare a server's /api/health to revisions
//   bun scripts/runtime-identity.ts diff --dir <path> --rev <r>    files that differ between a tree and a revision
//
// `check` prints one JSON verdict and exits 0 on MATCH, 1 on MISMATCH, 2 when the server does not say (UNKNOWN):
// an older server reports no `source`, and its /app can be extracted and checked with `dir` / `diff` instead.
import {
  gitSourceEntries,
  inSourceScope,
  type SourceEntry,
  type SourceIdentity,
  scanSourceTree,
  sourceIdentityOf,
} from "../apps/server/src/source-identity";

const [mode, ...rest] = process.argv.slice(2);

function opts(args: string[]) {
  const out: Record<string, string[]> = {};
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i]?.replace(/^--/, "");
    const v = args[i + 1];
    if (!k || v === undefined) throw new Error(`expected --name value pairs, got: ${args.join(" ")}`);
    out[k] = [...(out[k] ?? []), v];
  }
  return out;
}

function repoOf(o: Record<string, string[]>) {
  return o.repo?.[0] ?? process.cwd();
}

function print(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
}

async function check(o: Record<string, string[]>): Promise<number> {
  const base = o.url?.[0];
  const revisions = o.rev ?? [];
  if (!base || revisions.length === 0) throw new Error("check needs --url and at least one --rev");
  const url = new URL("/api/health", base).href;
  const observedAt = new Date().toISOString();
  const res = await fetch(url);
  const body = (await res.json()) as { version?: string; source?: SourceIdentity | null };
  const expected = revisions.map((r) => ({ revision: r, ...sourceIdentityOf(gitSourceEntries(repoOf(o), r)) }));
  // No files is no evidence: a wrong root on either side would hash to the same empty digest.
  const running = body.source && body.source.files > 0 ? body.source : null;
  const matched = running ? expected.find((e) => e.digest === running.digest) : undefined;
  const verdict = !running ? "UNKNOWN" : matched ? "MATCH" : "MISMATCH";
  print({
    verdict,
    url,
    observedAt,
    httpStatus: res.status,
    version: body.version,
    running,
    matched: matched?.revision ?? null,
    expected,
  });
  return verdict === "MATCH" ? 0 : verdict === "MISMATCH" ? 1 : 2;
}

function diff(o: Record<string, string[]>) {
  const dir = o.dir?.[0];
  const rev = o.rev?.[0];
  if (!dir || !rev) throw new Error("diff needs --dir and --rev");
  const byPath = (xs: SourceEntry[]) => new Map(xs.filter((e) => inSourceScope(e.path)).map((e) => [e.path, e.blob]));
  const running = byPath(scanSourceTree(dir));
  const revision = byPath(gitSourceEntries(repoOf(o), rev));
  const changed = [...running].filter(([p, b]) => revision.has(p) && revision.get(p) !== b).map(([p]) => p);
  const onlyRunning = [...running.keys()].filter((p) => !revision.has(p));
  const onlyRevision = [...revision.keys()].filter((p) => !running.has(p));
  const same = changed.length + onlyRunning.length + onlyRevision.length === 0;
  print({ verdict: same ? "MATCH" : "MISMATCH", dir, revision: rev, changed, onlyRunning, onlyRevision });
  return same ? 0 : 1;
}

async function main(): Promise<number> {
  if (mode === "rev" && rest[0]) {
    print({ revision: rest[0], ...sourceIdentityOf(gitSourceEntries(repoOf(opts(rest.slice(1))), rest[0])) });
    return 0;
  }
  if (mode === "dir" && rest[0]) {
    print({ dir: rest[0], ...sourceIdentityOf(scanSourceTree(rest[0])) });
    return 0;
  }
  if (mode === "check") return check(opts(rest));
  if (mode === "diff") return diff(opts(rest));
  console.error(
    "usage: runtime-identity.ts rev <revision> | dir <path> | check --url <base> --rev <r>… | diff --dir <path> --rev <r>",
  );
  return 64;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(String(err));
    process.exit(3);
  },
);
