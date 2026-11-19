/**
 * A branch's own migration, generated again on top of the base branch's: `bun run db:regenerate [base]`.
 *
 * Two branches that each add a migration both take the next number and the next journal entry, and the migration guard
 * (packages/db/src/migration-guard.ts) refuses one dated before the base's latest. After merging the base in, this:
 * takes the base's migrations folder as it is, drops this branch's unreleased migration (its SQL and snapshot), runs
 * drizzle-kit generate again with the same name, and says whether the new SQL is the same as before. Committed
 * migrations of the base are never touched: a branch that changed or removed one is refused.
 *
 * base: a ref that has the base branch (default: the first of origin/main, gh/main, main that exists).
 */
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DIR = "packages/db/migrations";

const git = (...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
};

function fail(message: string): never {
  console.error(`db:regenerate: ${message}`);
  process.exit(1);
}

const base =
  process.argv[2] ?? ["origin/main", "gh/main", "main"].find((ref) => git("rev-parse", "--verify", "--quiet", ref).ok);
if (!base || !git("rev-parse", "--verify", "--quiet", base).ok) fail(`no base ref: give one, e.g. origin/main`);

const listAt = (ref: string) =>
  new Set(
    git("ls-tree", "--name-only", `${ref}:${DIR}`)
      .out.split("\n")
      .filter((f) => f.endsWith(".sql")),
  );
const inBase = listAt(base);
const here = new Set(readdirSync(join(ROOT, DIR)).filter((f) => f.endsWith(".sql")));

// The base's committed migrations stay as they are: one changed or missing here is a mistake to fix by hand.
for (const f of inBase) {
  if (!here.has(f)) fail(`${f} is in ${base} but not here: restore it, committed migrations are frozen`);
  const ours = readFileSync(join(ROOT, DIR, f), "utf8");
  if (ours !== git("show", `${base}:${DIR}/${f}`).out + (ours.endsWith("\n") ? "\n" : ""))
    fail(`${f} differs from ${base}'s: committed migrations are frozen, put the change in a new migration`);
}

const mine = [...here].filter((f) => !inBase.has(f)).sort();
if (mine.length === 0) fail(`this branch adds no migration over ${base}: nothing to generate again`);
if (mine.length > 1)
  fail(
    `this branch adds ${mine.length} migrations (${mine.join(", ")}): squash them into one first, or regenerate by hand`,
  );

const file = mine[0] as string;
const name = file.replace(/^[^_]+_/, "").replace(/\.sql$/, "");
const before = readFileSync(join(ROOT, DIR, file), "utf8");

// The base's folder as it is, journal and snapshots included; then nothing of this branch's migration is left.
if (!git("checkout", base, "--", DIR).ok) fail(`could not take ${DIR} from ${base}`);
rmSync(join(ROOT, DIR, file));
const snapshot = join(ROOT, DIR, "meta", `${file.split("_")[0]}_snapshot.json`);
if (existsSync(snapshot) && !git("cat-file", "-e", `${base}:${DIR}/meta/${file.split("_")[0]}_snapshot.json`).ok)
  rmSync(snapshot);

const gen = Bun.spawnSync(["bunx", "drizzle-kit", "generate", "--name", name], {
  cwd: join(ROOT, "packages/db"),
  stdout: "pipe",
  stderr: "pipe",
  stdin: "ignore",
});
if (gen.exitCode !== 0) fail(`drizzle-kit generate failed:\n${gen.stdout}\n${gen.stderr}`);

const after = [...readdirSync(join(ROOT, DIR))].filter((f) => f.endsWith(".sql") && !inBase.has(f));
if (after.length !== 1) fail(`expected one new migration after generating, found: ${after.join(", ") || "none"}`);
const now = after[0] as string;
const same = readFileSync(join(ROOT, DIR, now), "utf8") === before;
console.log(`${file} -> ${now}${same ? ", same SQL" : ", SQL CHANGED: read the diff before committing"}`);
if (!same) process.exit(3);
