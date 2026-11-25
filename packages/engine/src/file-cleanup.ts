import { and, type Database, eq, inArray, lt, notInArray, or, schema, sql } from "@agenteschat/db";
import { ValidationError } from "./errors";
import type { MachineCaller } from "./machine-hub";
import { requirePermission } from "./organizations";
import { enqueue } from "./outbox";
import type { RetentionItem } from "./run-files";
import { pressureOf } from "./storage-pressure";

/**
 * Cleaning what an ended task left behind, file by file, only as a person approved (ADR 0201).
 *
 * A retention report (ADR 0197) lists the scratch and rebuildable files the agents registered. A person with the
 * workspace's `configure` permission approves some or all of them; each approval is a `file_cleanups` row naming
 * one registration (its run and path). The `files.cleanup` job then asks the agent's own computer, as that agent, to
 * check each file again and remove it only if every check passes there and then (`CLEANUP_SCRIPT`). The row keeps
 * the receipt: what the computer saw, what happened and why, and the disk's free bytes before and after.
 *
 * Nothing here decides on its own: a file nobody registered, one the agent called a deliverable, evidence or
 * unknown (in this run or any other), one used again after the task ended, one on no known computer or on a
 * computer that is not macOS or Linux, or one of a task that was reopened, is never removed.
 */

const { fileCleanups, retentionReports, runFiles, agents, agentRuns, issues, missions } = schema;

export const FILE_CLEANUP_JOB = "files.cleanup";
/** A job's budget (ADR 0201): no mass delete in one go; what is left waits for the next job. */
export const CLEANUP_LIMITS = { files: 200, bytes: 2 * 1024 ** 3, seconds: 120, scriptSeconds: 60 } as const;
const BUSY_RUN = ["queued", "running", "waiting_approval", "waiting_input"] as const;
const RETRY_MS = 10 * 60 * 1000;
/** A row a job claimed and never finished (the server stopped): checked again on the computer, never assumed. */
const STALE_CLAIM_MS = 15 * 60 * 1000;
/** Only POSIX shells take the command as written (Windows runs `cmd.exe`, ADR 0201). */
const CLEANUP_OSES = new Set(["darwin", "linux"]);

export type CleanupStatus = "approved" | "running" | "done" | "skipped" | "blocked" | "unknown";

async function subjectStatus(db: Database, orgId: string, type: string, id: string) {
  const table = type === "issue" ? issues : missions;
  const [row] = await db
    .select({ status: table.status })
    .from(table)
    .where(and(eq(table.orgId, orgId), eq(table.id, id)));
  return row?.status ?? null;
}

/**
 * Approves the report's candidates on a computer for cleanup: all of them, or the `paths` given. Only files the
 * report itself lists as candidates can be approved; approving one again changes nothing.
 */
export async function approveCleanup(
  db: Database,
  input: { orgId: string; reportId: string; userId: string; paths?: string[] },
) {
  const [report] = await db
    .select()
    .from(retentionReports)
    .where(and(eq(retentionReports.orgId, input.orgId), eq(retentionReports.id, input.reportId)));
  if (!report) throw new ValidationError("No such report.");
  const status = await subjectStatus(db, input.orgId, report.subjectType, report.subjectId);
  if (status !== "done" && status !== "canceled")
    throw new ValidationError("The work was reopened: its files can't be cleaned until it ends again.");
  const items = ((report.report as { items?: RetentionItem[] }).items ?? []).filter(
    (i) => i.where === "computer" && i.decision === "candidate",
  );
  if (input.paths) {
    const listed = new Set(items.map((i) => i.path));
    if (input.paths.some((p) => !listed.has(p)))
      throw new ValidationError("Only files the report lists as candidates can be cleaned.");
  }
  const wanted = input.paths ? new Set(input.paths) : null;
  const chosen = items.filter((i) => !wanted || wanted.has(i.path));
  const approvable = chosen.filter((i) => i.agentId && i.machineId && i.runId);
  if (approvable.length === 0) return { approved: 0, notOnAComputer: chosen.length };
  const rows = await db
    .insert(fileCleanups)
    .values(
      approvable.map((i) => ({
        orgId: input.orgId,
        reportId: report.id,
        runId: i.runId as string,
        agentId: i.agentId as string,
        machineId: i.machineId as string,
        path: i.path,
        bytes: i.size,
        approvedByUserId: input.userId,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: fileCleanups.id });
  // Each row names its own registration: that run's, that path (a receipt outlives it).
  await db.execute(sql`
    update ${fileCleanups} c set run_file_id = f.id
    from ${runFiles} f
    where c.report_id = ${report.id} and c.run_file_id is null and f.org_id = c.org_id
      and f.run_id = c.run_id and f.path = c.path`);
  if (rows.length > 0)
    await enqueue(db, {
      orgId: input.orgId,
      kind: FILE_CLEANUP_JOB,
      payload: { reportId: report.id },
      dedupeKey: `${FILE_CLEANUP_JOB}:${report.id}:${Date.now()}`,
    });
  return { approved: rows.length, notOnAComputer: chosen.length - approvable.length };
}

/** What the computer answers for each file. `later`: over this round's byte budget, for the next job. */
export interface ScriptResult {
  path: string;
  status: "done" | "skipped" | "blocked" | "later";
  reason?: string;
  identity?: Record<string, unknown>;
  bytes?: number;
}
export interface ScriptOutput {
  freeBefore: number;
  freeAfter: number;
  results: ScriptResult[];
}

/**
 * Runs on the agent's computer as the agent, in its folder (`python3 -I`, no site packages, no environment read):
 * one base64 JSON argument `{files: [{path, size?, sha256?}], notAfter, maxBytes, seconds}`, one JSON line out. For
 * each file, every check must pass:
 *
 * 1. a plain relative path, no `..`; nothing under `.git`, `node_modules` or a folder of keys or settings (`.ssh`,
 *    `.aws`, `.config`…); not a hidden file, nor a database, disk image, key, backup or secret by its name;
 * 2. reached one folder at a time without following a symlink, never onto another disk;
 * 3. a regular file with one link (a hard-linked copy frees nothing and may be someone else's), unchanged for ten
 *    minutes and since the task ended (`notAfter`), with the size and SHA-256 the agent registered when it gave them;
 * 4. not in a Git work tree unless Git ignores it and tracks nothing there (an untracked file may be someone's only
 *    copy of their work);
 * 5. no process holds it open (`lsof` on the name the folder really holds, so a different case or Unicode spelling
 *    can't slip past; without `lsof`, Linux's `/proc`; with neither, nothing is removed);
 * 6. at the moment of removal still the very file checked (same device, inode, size and mtime), removed by its real
 *    name in the folder it was opened from.
 *
 * At most `maxBytes` go in one round (a single larger file may go alone); the rest come back `later`. Free bytes
 * are measured on the folder's disk before and after, once writes settle. Any doubt is `blocked`.
 */
export const CLEANUP_SCRIPT = `
import base64, json, os, sys, stat, hashlib, subprocess, time
req = json.loads(base64.b64decode(sys.argv[1]).decode("utf-8"))
root = os.getcwd()
DENY_PARTS = {".git", "node_modules", ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".config", ".password-store"}
DENY_EXT = (".sqlite", ".sqlite3", ".db", ".qcow2", ".vmdk", ".vdi", ".img", ".dmg", ".iso", ".raw", ".bak", ".backup", ".pem", ".key", ".p12", ".pfx", ".kdbx", ".keychain", ".keychain-db", ".env", ".age", ".gpg")
DENY_WORDS = ("backup", "secret", "credential", "password", "token", "id_rsa", "id_ed25519", "id_ecdsa")
class Refuse(Exception): pass
def free():
    s = os.statvfs(root); return s.f_bavail * s.f_frsize
def open_paths(abspaths):
    """Which of these files a program has open: one lsof for all; without lsof, Linux's /proc; else refuse."""
    if not abspaths: return set()
    try:
        r = subprocess.run(["lsof", "-F", "n", "--"] + abspaths, capture_output=True, text=True, timeout=30, env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin"})
        if r.returncode not in (0, 1): raise Refuse("could not check which programs have it open")
        return {l[1:] for l in r.stdout.splitlines() if l.startswith("n")}
    except FileNotFoundError:
        pass
    except subprocess.TimeoutExpired:
        raise Refuse("could not check which programs have it open in time")
    if not os.path.isdir("/proc"): raise Refuse("no way to check which programs have it open on this computer")
    wanted, found = set(abspaths), set()
    for pid in os.listdir("/proc"):
        if not pid.isdigit(): continue
        fds = "/proc/%s/fd" % pid
        try: names = os.listdir(fds)
        except OSError: continue
        for n in names:
            try:
                t = os.readlink(os.path.join(fds, n))
                if t in wanted: found.add(t)
            except OSError: pass
    return found
def git(args, cwd):
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    return subprocess.run(["git"] + args, cwd=cwd, capture_output=True, text=True, timeout=10, env=env)
def in_git(dirpath):
    d = dirpath
    while True:
        if os.path.lexists(os.path.join(d, ".git")): return True
        parent = os.path.dirname(d)
        if parent == d: return False
        d = parent
def check_git(dirpath, name):
    if not in_git(dirpath): return
    try:
        if git(["ls-files", "--error-unmatch", "--", name], dirpath).returncode == 0: raise Refuse("Git tracks it")
        if git(["check-ignore", "-q", "--", name], dirpath).returncode != 0: raise Refuse("in a Git work tree and not ignored: it may be someone's only copy")
    except FileNotFoundError:
        raise Refuse("in a Git work tree and Git is not available to check it")
    except subprocess.TimeoutExpired:
        raise Refuse("Git did not answer in time")
def sha256_fd(fd):
    h = hashlib.sha256()
    os.lseek(fd, 0, 0)
    while True:
        b = os.read(fd, 1 << 20)
        if not b: break
        h.update(b)
    return h.hexdigest()
def walk(parts):
    """The folder holding the file, opened one step at a time without following a link, on the same disk."""
    dfd = os.open(".", os.O_RDONLY | os.O_DIRECTORY)
    dev = os.fstat(dfd).st_dev
    for p in parts[:-1]:
        try: nfd = os.open(p, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=dfd)
        except FileNotFoundError:
            os.close(dfd); return None, dev
        except OSError:
            os.close(dfd); raise Refuse("a folder on the way is a link or not a folder")
        os.close(dfd); dfd = nfd
        if os.fstat(dfd).st_dev != dev:
            os.close(dfd); raise Refuse("on another disk")
    return dfd, dev
def real_name(dfd, name, st):
    """The name the folder really holds for this file (its case and Unicode form on disk), found by device and inode."""
    names = os.listdir(dfd)
    if name in names: return name
    for n in names:
        try:
            o = os.stat(n, dir_fd=dfd, follow_symlinks=False)
            if (o.st_dev, o.st_ino) == (st.st_dev, st.st_ino): return n
        except OSError: pass
    raise Refuse("its name on disk could not be found")
def check(f):
    rel = f["path"]
    parts = rel.split("/")
    if rel.startswith("/") or ".." in parts or "" in parts or "." in parts: raise Refuse("not a plain path inside the folder")
    if any(p.lower() in DENY_PARTS or p.lower().startswith(".git") for p in parts): raise Refuse("a protected folder")
    low = parts[-1].lower()
    if low.startswith("."): raise Refuse("a hidden file: often settings or keys")
    if low.endswith(DENY_EXT) or any(w in low for w in DENY_WORDS): raise Refuse("a database, disk image, key, backup or secret by its name")
    dfd, dev = walk(parts)
    if dfd is None: return None
    try:
        try: st = os.stat(parts[-1], dir_fd=dfd, follow_symlinks=False)
        except FileNotFoundError: return None
        if stat.S_ISLNK(st.st_mode): raise Refuse("a link, not a file")
        if not stat.S_ISREG(st.st_mode): raise Refuse("not a regular file")
        if st.st_dev != dev: raise Refuse("on another disk")
        if st.st_nlink != 1: raise Refuse("has other names (hard links)")
        quiet = req.get("quiet", 600)
        if time.time() - st.st_mtime < quiet: raise Refuse("changed in the last ten minutes" if quiet == 600 else "changed in the last %d seconds" % quiet)
        if "notAfter" in f:
            if st.st_mtime > f["notAfter"]: raise Refuse("changed after it was sealed: something else may use it now")
        elif st.st_mtime > req["notAfter"]: raise Refuse("changed after the work ended: something else may use it now")
        name = real_name(dfd, parts[-1], st)
        identity = {"dev": st.st_dev, "ino": st.st_ino, "size": st.st_size, "mtimeNs": st.st_mtime_ns}
        if f.get("size") is not None and f["size"] != st.st_size: raise Refuse("its size changed since it was registered")
        ffd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=dfd)
        try:
            fst = os.fstat(ffd)
            if (fst.st_dev, fst.st_ino) != (st.st_dev, st.st_ino): raise Refuse("it changed while being checked")
            if f.get("sha256"):
                digest = sha256_fd(ffd)
                identity["sha256"] = digest
                if digest != f["sha256"]: raise Refuse("its contents changed since it was registered")
        finally:
            os.close(ffd)
        dirpath = os.path.join(root, *parts[:-1])
        check_git(dirpath, name)
        return {"identity": identity, "abs": os.path.join(dirpath, name), "name": name, "blocks": st.st_blocks}
    finally:
        os.close(dfd)
def remove(rel, seen):
    parts = rel.split("/")
    dfd, _ = walk(parts)
    if dfd is None: raise Refuse("it changed while being checked")
    try:
        again = os.stat(seen["name"], dir_fd=dfd, follow_symlinks=False)
        i = seen["identity"]
        if (again.st_dev, again.st_ino, again.st_size, again.st_mtime_ns) != (i["dev"], i["ino"], i["size"], i["mtimeNs"]):
            raise Refuse("it changed while being checked")
        os.unlink(seen["name"], dir_fd=dfd)
    finally:
        os.close(dfd)
before = free()
results, checked = [], []
deadline = time.time() + req.get("seconds", 60)
for f in req["files"]:
    if time.time() > deadline:
        results.append({"path": f["path"], "status": "later", "reason": "out of time for this round"}); continue
    try:
        seen = check(f)
        if seen is None: results.append({"path": f["path"], "status": "skipped", "reason": "already gone"})
        else: checked.append((f["path"], seen))
    except Refuse as e: results.append({"path": f["path"], "status": "blocked", "reason": str(e)})
    except Exception as e: results.append({"path": f["path"], "status": "blocked", "reason": "check failed: " + type(e).__name__})
refusal = None
try: held = open_paths([s["abs"] for _, s in checked])
except Refuse as e: held, refusal = None, str(e)
removed = 0
for rel, seen in checked:
    if held is None:
        results.append({"path": rel, "status": "blocked", "reason": refusal}); continue
    if seen["abs"] in held:
        results.append({"path": rel, "status": "blocked", "reason": "a program has it open"}); continue
    size = seen["blocks"] * 512
    if removed > 0 and removed + size > req["maxBytes"]:
        results.append({"path": rel, "status": "later", "reason": "over this round's budget"}); continue
    try:
        remove(rel, seen)
        removed += size
        results.append({"path": rel, "status": "done", "identity": seen["identity"], "bytes": size})
    except Refuse as e: results.append({"path": rel, "status": "blocked", "reason": str(e)})
    except Exception as e: results.append({"path": rel, "status": "blocked", "reason": "removal failed: " + type(e).__name__})
try: os.sync()
except Exception: pass
time.sleep(2)
print(json.dumps({"freeBefore": before, "freeAfter": free(), "results": results}))
`;

/** One shell word, whatever it holds. */
export function shellWord(s: string) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The command for a POSIX shell. The files go as one base64 argument: whatever a path holds (an agent chose it),
 * the shell sees only letters, digits, `+`, `/` and `=`.
 */
export function cleanupCommand(
  files: { path: string; size?: number | null; sha256?: string | null; notAfter?: Date | null }[],
  notAfter: Date,
  maxBytes: number = CLEANUP_LIMITS.bytes,
  /**
   * Continuous cleanup (ADR 0213): `quiet` is how long the file must have been unchanged (ten minutes by default;
   * shorter only for a file its writer sealed), `seconds` the round's time budget, `lowPriority` runs it under `nice`
   * so it yields to the agents' own work.
   */
  options: { quiet?: number; seconds?: number; lowPriority?: boolean } = {},
) {
  const payload = {
    seconds: options.seconds ?? CLEANUP_LIMITS.scriptSeconds,
    notAfter: Math.floor(notAfter.getTime() / 1000),
    maxBytes,
    ...(options.quiet !== undefined ? { quiet: Math.max(30, options.quiet) } : {}),
    files: files.map((f) => ({
      path: f.path,
      ...(typeof f.size === "number" ? { size: f.size } : {}),
      ...(f.sha256 ? { sha256: f.sha256 } : {}),
      ...(f.notAfter ? { notAfter: Math.floor(f.notAfter.getTime() / 1000) } : {}),
    })),
  };
  const python = `python3 -I -c ${shellWord(CLEANUP_SCRIPT)} ${Buffer.from(JSON.stringify(payload)).toString("base64")}`;
  return options.lowPriority ? `nice -n 19 ${python}` : python;
}

export function parseCleanupOutput(stdout: string): ScriptOutput | null {
  const line = stdout.trim().split("\n").pop() ?? "";
  try {
    const out = JSON.parse(line) as ScriptOutput;
    if (typeof out.freeBefore !== "number" || typeof out.freeAfter !== "number" || !Array.isArray(out.results))
      return null;
    return out;
  } catch {
    return null;
  }
}

/** Writes a claimed row's outcome; a row no longer `running` (another job finished it) is left as it is. */
async function finish(db: Database, ids: string[], values: Partial<typeof fileCleanups.$inferInsert>) {
  if (ids.length)
    await db
      .update(fileCleanups)
      .set(values)
      .where(and(inArray(fileCleanups.id, ids), eq(fileCleanups.status, "running")));
}

/**
 * The job: works through a report's approved files, one computer and agent at a time. It claims its rows first
 * (`running`), so two jobs never send the same file. A computer that is offline or not macOS or Linux, or an agent
 * still at work there, waits: the job comes back later. A run whose answer is unclear marks its files `unknown`;
 * the next job checks them again on the computer (a file already gone is `skipped`), never assuming.
 */
export async function runFileCleanup(
  deps: { db: Database; hub: Pick<MachineCaller, "call" | "status"> | null },
  orgId: string,
  reportId: string,
) {
  const { db } = deps;
  const [report] = await db
    .select()
    .from(retentionReports)
    .where(and(eq(retentionReports.orgId, orgId), eq(retentionReports.id, reportId)));
  if (!report) return { done: 0 };
  const status = await subjectStatus(db, orgId, report.subjectType, report.subjectId);
  const reopened = status !== "done" && status !== "canceled";
  // Claim: what waits, what came back unclear, and claims a stopped server left behind.
  const claimed = await db
    .update(fileCleanups)
    .set({ status: "running", executedAt: new Date() })
    .where(
      and(
        eq(fileCleanups.orgId, orgId),
        eq(fileCleanups.reportId, reportId),
        eq(fileCleanups.source, "approved"),
        or(
          inArray(fileCleanups.status, ["approved", "unknown"]),
          and(eq(fileCleanups.status, "running"), lt(fileCleanups.executedAt, new Date(Date.now() - STALE_CLAIM_MS))),
        ),
      ),
    )
    .returning();
  if (claimed.length === 0) return { done: 0 };
  const release = (ids: string[]) =>
    ids.length
      ? db
          .update(fileCleanups)
          .set({ status: "approved" })
          .where(and(inArray(fileCleanups.id, ids), eq(fileCleanups.status, "running")))
      : Promise.resolve();
  if (reopened) {
    await finish(
      db,
      claimed.map((r) => r.id),
      { status: "blocked", reason: "The work was reopened.", executedAt: new Date() },
    );
    return { done: 0 };
  }
  // Each registration as it stands now, and every other registration of the same file by the same agent.
  const regs = await db
    .select()
    .from(runFiles)
    .where(
      and(
        eq(runFiles.orgId, orgId),
        inArray(
          runFiles.agentId,
          claimed.map((r) => r.agentId),
        ),
        inArray(
          runFiles.path,
          claimed.map((r) => r.path),
        ),
      ),
    );
  const blocked = new Map<string, string>();
  for (const r of claimed) {
    const same = regs.filter((g) => g.agentId === r.agentId && g.path === r.path);
    const own = same.find((g) => g.runId === r.runId);
    if (!own || (own.role !== "scratch" && own.role !== "derived") || own.machineId !== r.machineId) {
      blocked.set(r.id, "No longer registered as scratch or rebuildable on that computer.");
      continue;
    }
    const others = same.filter((g) => g.runId !== r.runId && (g.machineId === r.machineId || g.machineId === null));
    const kept = others.find((g) => g.role !== "scratch" && g.role !== "derived");
    if (kept) {
      blocked.set(
        r.id,
        `Another piece of work calls the same file ${kept.role === "canonical" ? "a deliverable" : kept.role}.`,
      );
      continue;
    }
    if (others.some((g) => g.updatedAt > report.createdAt))
      blocked.set(r.id, "Registered again after the work ended: something else may use it now.");
  }
  for (const [id, reason] of blocked) await finish(db, [id], { status: "blocked", reason, executedAt: new Date() });
  const regOf = new Map(regs.map((g) => [`${g.runId}:${g.path}`, g]));
  const live = claimed.filter((r) => !blocked.has(r.id));
  let later = false;
  let done = 0;
  const groups = new Map<string, typeof live>();
  for (const r of live) {
    const key = `${r.agentId}:${r.machineId}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  for (const rows of groups.values()) {
    const { agentId, machineId } = rows[0] as (typeof rows)[number];
    const ids = rows.map((r) => r.id);
    if (!machineId || !deps.hub) {
      await release(ids);
      later = true;
      continue;
    }
    const [busy] = await db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.agentId, agentId), inArray(agentRuns.status, [...BUSY_RUN])))
      .limit(1);
    const machine = await deps.hub.status(machineId);
    if (machine && !CLEANUP_OSES.has(machine.os)) {
      await finish(db, ids, {
        status: "blocked",
        reason: "Cleaning is only done on macOS and Linux computers.",
        executedAt: new Date(),
      });
      continue;
    }
    if (busy || !machine?.online) {
      await release(ids);
      later = true;
      continue;
    }
    const [agent] = await db
      .select({ id: agents.id, handle: agents.handle, name: agents.name })
      .from(agents)
      .where(and(eq(agents.orgId, orgId), eq(agents.id, agentId)));
    if (!agent) {
      await finish(db, ids, { status: "blocked", reason: "The agent is gone.", executedAt: new Date() });
      continue;
    }
    // So many files a round; the computer itself keeps to the byte budget, measuring real sizes.
    const batch = rows.slice(0, CLEANUP_LIMITS.files);
    if (batch.length < rows.length) {
      await release(rows.slice(CLEANUP_LIMITS.files).map((r) => r.id));
      later = true;
    }
    const command = cleanupCommand(
      batch.map((r) => {
        const reg = regOf.get(`${r.runId}:${r.path}`);
        return { path: r.path, size: reg?.size ?? null, sha256: reg?.sha256 ?? null };
      }),
      report.createdAt,
    );
    let out: ScriptOutput | null = null;
    let why = "The computer's answer was unclear.";
    try {
      const r = await deps.hub.call(machineId, {
        agent: { id: agent.id, handle: agent.handle, name: agent.name },
        op: "exec",
        command,
        timeoutSeconds: CLEANUP_LIMITS.seconds,
        stream: false,
        // A person approved these exact files (ADR 0201): the command policy's holds are for agents' own commands.
        approved: true,
      });
      out = r.exitCode === 0 ? parseCleanupOutput(r.stdout) : null;
      if (!out && /python3/.test(r.stderr) && /not found/.test(r.stderr))
        why = "This computer has no python3 to check files with.";
    } catch (error) {
      why = `The computer did not answer: ${error instanceof Error ? error.message : String(error)}`;
    }
    const at = new Date();
    if (!out) {
      await finish(
        db,
        batch.map((r) => r.id),
        { status: "unknown", reason: why, executedAt: at },
      );
      continue;
    }
    const byPath = new Map(out.results.map((x) => [x.path, x]));
    for (const r of batch) {
      const x = byPath.get(r.path);
      if (x?.status === "later") {
        await release([r.id]);
        later = true;
        continue;
      }
      const status: CleanupStatus = x ? x.status : "unknown";
      if (status === "done") done++;
      await finish(db, [r.id], {
        status,
        reason: x?.reason ?? (x ? null : "The computer did not report this file."),
        identity: x?.identity ?? null,
        ...(x?.bytes !== undefined ? { bytes: x.bytes } : {}),
        freeBefore: out.freeBefore,
        freeAfter: out.freeAfter,
        executedAt: at,
      });
    }
  }
  if (later)
    await enqueue(db, {
      orgId,
      kind: FILE_CLEANUP_JOB,
      payload: { reportId },
      dedupeKey: `${FILE_CLEANUP_JOB}:${reportId}:later:${Math.floor(Date.now() / RETRY_MS)}`,
      runAt: new Date(Date.now() + RETRY_MS),
    });
  return { done };
}

/** A workspace's reports with their cleanup state, newest first: for the Clean workspace page (ADR 0201). */
export async function listRetentionReports(db: Database, orgId: string, limit = 50) {
  const reports = await db
    .select()
    .from(retentionReports)
    .where(eq(retentionReports.orgId, orgId))
    .orderBy(sql`${retentionReports.createdAt} desc`)
    .limit(limit);
  if (reports.length === 0) return [];
  const cleanups = await db
    .select()
    .from(fileCleanups)
    .where(
      and(
        eq(fileCleanups.orgId, orgId),
        inArray(
          fileCleanups.reportId,
          reports.map((r) => r.id),
        ),
      ),
    );
  return reports.map((r) => {
    const report = r.report as Record<string, unknown>;
    const mine = cleanups.filter((c) => c.reportId === r.id);
    const done = mine.filter((c) => c.status === "done");
    return {
      id: r.id,
      subjectType: r.subjectType,
      subjectId: r.subjectId,
      outcome: r.outcome,
      createdAt: r.createdAt.toISOString(),
      kept: Number(report.kept ?? 0),
      candidates: Number(report.candidates ?? 0),
      candidateBytes: Number(report.candidateBytes ?? 0),
      duplicates: Number(report.duplicates ?? 0),
      snapshot: report.snapshot ?? null,
      items: (report.items as RetentionItem[] | undefined) ?? [],
      cleanups: mine.map((c) => ({
        path: c.path,
        status: c.status,
        reason: c.reason,
        bytes: c.bytes,
        freeBefore: c.freeBefore,
        freeAfter: c.freeAfter,
        executedAt: c.executedAt?.toISOString() ?? null,
      })),
      removedBytes: done.reduce((n, c) => n + (c.bytes ?? 0), 0),
    };
  });
}

/** Rows still waiting on a computer (for the page's count); `notInArray` keeps finished receipts out. */
export async function pendingCleanups(db: Database, orgId: string) {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(fileCleanups)
    .where(and(eq(fileCleanups.orgId, orgId), notInArray(fileCleanups.status, ["done", "skipped", "blocked"])));
  return row?.n ?? 0;
}

/** The Clean workspace page's read (ADR 0201): reports, cleanups and each computer's disk; `configure` only. */
export async function cleanWorkspaceView(db: Database, userId: string, orgId: string) {
  await requirePermission(db, userId, orgId, "configure");
  const computers = await db
    .select({ id: schema.machines.id, name: schema.machines.name, load: schema.machines.load })
    .from(schema.machines)
    .where(eq(schema.machines.orgId, orgId));
  return {
    computers: computers.map((m) => ({ id: m.id, name: m.name, ...pressureOf(m.load) })),
    pending: await pendingCleanups(db, orgId),
    reports: await listRetentionReports(db, orgId),
  };
}

/** A person's approval of a report's candidates (all, or the `paths` given); `configure` only. */
export async function approveFileCleanup(
  db: Database,
  userId: string,
  orgId: string,
  reportId: string,
  paths?: string[],
) {
  await requirePermission(db, userId, orgId, "configure");
  return approveCleanup(db, { orgId, reportId, userId, ...(paths ? { paths } : {}) });
}
