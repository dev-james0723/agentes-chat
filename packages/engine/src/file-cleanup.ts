import { and, type Database, eq, inArray, notInArray, schema, sql } from "@agenteschat/db";
import { ValidationError } from "./errors";
import type { MachineCaller } from "./machine-hub";
import { requirePermission } from "./organizations";
import { enqueue } from "./outbox";
import type { RetentionItem } from "./run-files";
import { pressureOf } from "./storage-pressure";

/**
 * Cleaning what an ended task left behind, file by file, only as a person approved (ADR 0200).
 *
 * A retention report (ADR 0197) lists the scratch and rebuildable files the agents registered. A person with the
 * workspace's `configure` permission approves some or all of them; each approval is a `file_cleanups` row naming
 * one file. The `files.cleanup` job then asks the agent's own computer, as that agent, to check each file again and
 * remove it only if every check passes there and then (`CLEANUP_SCRIPT`). The row keeps the receipt: what the
 * computer saw, what happened and why, and the disk's free bytes before and after.
 *
 * Nothing here decides on its own: a file nobody registered, one the agent called a deliverable, evidence or
 * unknown, one on no known computer, or one of a task that was reopened, is never approved or removed.
 */

const { fileCleanups, retentionReports, runFiles, agents, agentRuns, issues, missions } = schema;

export const FILE_CLEANUP_JOB = "files.cleanup";
/** A job's budget (ADR 0200): no mass delete in one go; what is left waits for the next job. */
export const CLEANUP_LIMITS = { files: 200, bytes: 2 * 1024 ** 3, seconds: 120 } as const;
const BUSY_RUN = ["queued", "running", "waiting_approval", "waiting_input"] as const;
const RETRY_MS = 10 * 60 * 1000;

export type CleanupStatus = "approved" | "done" | "skipped" | "blocked" | "unknown";

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
  const wanted = input.paths ? new Set(input.paths) : null;
  const chosen = items.filter((i) => !wanted || wanted.has(i.path));
  const approvable = chosen.filter((i) => i.agentId && i.machineId);
  if (wanted && chosen.length < wanted.size)
    throw new ValidationError("Only files the report lists as candidates can be cleaned.");
  if (approvable.length === 0) return { approved: 0, notOnAComputer: chosen.length };
  const rows = await db
    .insert(fileCleanups)
    .values(
      approvable.map((i) => ({
        orgId: input.orgId,
        reportId: report.id,
        agentId: i.agentId as string,
        machineId: i.machineId as string,
        path: i.path,
        bytes: i.size,
        approvedByUserId: input.userId,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: fileCleanups.id });
  // Link each row to its registration while it lasts (a receipt outlives it).
  await db.execute(sql`
    update ${fileCleanups} c set run_file_id = f.id
    from ${runFiles} f
    where c.report_id = ${report.id} and c.run_file_id is null and f.org_id = c.org_id
      and f.agent_id = c.agent_id and f.path = c.path and f.machine_id = c.machine_id`);
  await enqueue(db, {
    orgId: input.orgId,
    kind: FILE_CLEANUP_JOB,
    payload: { reportId: report.id },
    dedupeKey: `${FILE_CLEANUP_JOB}:${report.id}:${Date.now()}`,
  });
  return { approved: rows.length, notOnAComputer: chosen.length - approvable.length };
}

/** What the computer answers for each file. */
interface ScriptResult {
  path: string;
  status: "done" | "skipped" | "blocked";
  reason?: string;
  identity?: Record<string, unknown>;
  bytes?: number;
}
interface ScriptOutput {
  freeBefore: number;
  freeAfter: number;
  results: ScriptResult[];
}

/**
 * Runs on the agent's computer as the agent, in its folder (`python3 -I`, no site packages, no environment read):
 * one JSON argument `{files: [{path, size?, sha256?}]}`, one JSON line out. For each file, every check must pass:
 *
 * 1. a plain relative path, no `..`, nothing under `.git` or `node_modules`, not a database, disk
 *    image or backup by its name;
 * 2. reached one folder at a time without following a symlink, never onto another disk;
 * 3. a regular file with one link (a hard-linked copy frees nothing and may be someone else's), unchanged for ten
 *    minutes, and the size and SHA-256 the agent registered when it gave them;
 * 4. not in a Git work tree unless Git ignores it and tracks nothing there (an untracked file may be someone's only
 *    copy of their work);
 * 5. no process holds it open (`lsof`; without `lsof`, Linux's `/proc`; with neither, nothing is removed);
 * 6. at the moment of removal still the very file checked (same device and inode), removed by name in the folder
 *    it was opened from.
 *
 * Free bytes are measured on the folder's disk before and after, once writes settle. Any doubt is `blocked`.
 */
export const CLEANUP_SCRIPT = `
import json, os, sys, stat, hashlib, subprocess, time
req = json.loads(sys.argv[1])
root = os.getcwd()
DENY_PARTS = {".git", "node_modules"}
DENY_EXT = (".sqlite", ".sqlite3", ".db", ".qcow2", ".vmdk", ".vdi", ".img", ".dmg", ".iso", ".raw", ".bak", ".backup", ".pem", ".key")
class Refuse(Exception): pass
def free():
    s = os.statvfs(root); return s.f_bavail * s.f_frsize
def open_paths(abspaths):
    """Which of these files a program has open: one lsof for all; without lsof, Linux's /proc; else refuse."""
    if not abspaths: return set()
    try:
        r = subprocess.run(["lsof", "-F", "n", "--"] + abspaths, capture_output=True, text=True, timeout=60, env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin"})
        if r.returncode not in (0, 1): raise Refuse("could not check which programs have it open")
        return {l[1:] for l in r.stdout.splitlines() if l.startswith("n")}
    except FileNotFoundError:
        pass
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
    return subprocess.run(["git"] + args, cwd=cwd, capture_output=True, text=True, timeout=30, env=env)
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
def check(f):
    rel = f["path"]
    parts = rel.split("/")
    if rel.startswith("/") or ".." in parts or "" in parts or "." in parts: raise Refuse("not a plain path inside the folder")
    if any(p in DENY_PARTS or p.startswith(".git") for p in parts): raise Refuse("a protected folder")
    low = parts[-1].lower()
    if low.endswith(DENY_EXT) or "backup" in low: raise Refuse("a database, disk image, key or backup by its name")
    dfd, dev = walk(parts)
    if dfd is None: return None
    try:
        name = parts[-1]
        try: st = os.stat(name, dir_fd=dfd, follow_symlinks=False)
        except FileNotFoundError: return None
        if stat.S_ISLNK(st.st_mode): raise Refuse("a link, not a file")
        if not stat.S_ISREG(st.st_mode): raise Refuse("not a regular file")
        if st.st_dev != dev: raise Refuse("on another disk")
        if st.st_nlink != 1: raise Refuse("has other names (hard links)")
        if time.time() - st.st_mtime < 600: raise Refuse("changed in the last ten minutes")
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
        return {"identity": identity, "abs": os.path.join(dirpath, name), "blocks": st.st_blocks}
    finally:
        os.close(dfd)
def remove(rel, seen):
    parts = rel.split("/")
    dfd, _ = walk(parts)
    if dfd is None: raise Refuse("it changed while being checked")
    try:
        again = os.stat(parts[-1], dir_fd=dfd, follow_symlinks=False)
        i = seen["identity"]
        if (again.st_dev, again.st_ino, again.st_size, again.st_mtime_ns) != (i["dev"], i["ino"], i["size"], i["mtimeNs"]):
            raise Refuse("it changed while being checked")
        os.unlink(parts[-1], dir_fd=dfd)
    finally:
        os.close(dfd)
before = free()
results, checked = [], []
deadline = time.time() + req.get("seconds", 100)
for f in req["files"]:
    if time.time() > deadline:
        results.append({"path": f["path"], "status": "blocked", "reason": "out of time for this round"}); continue
    try:
        seen = check(f)
        if seen is None: results.append({"path": f["path"], "status": "skipped", "reason": "already gone"})
        else: checked.append((f["path"], seen))
    except Refuse as e: results.append({"path": f["path"], "status": "blocked", "reason": str(e)})
    except Exception as e: results.append({"path": f["path"], "status": "blocked", "reason": "check failed: " + type(e).__name__})
try: held = open_paths([s["abs"] for _, s in checked])
except Refuse as e: held, refusal = None, str(e)
for rel, seen in checked:
    if held is None:
        results.append({"path": rel, "status": "blocked", "reason": refusal}); continue
    if seen["abs"] in held:
        results.append({"path": rel, "status": "blocked", "reason": "a program has it open"}); continue
    try:
        remove(rel, seen)
        results.append({"path": rel, "status": "done", "identity": seen["identity"], "bytes": seen["blocks"] * 512})
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

export function cleanupCommand(files: { path: string; size?: number | null; sha256?: string | null }[]) {
  const payload = {
    seconds: CLEANUP_LIMITS.seconds - 20,
    files: files.map((f) => ({
      path: f.path,
      ...(typeof f.size === "number" ? { size: f.size } : {}),
      ...(f.sha256 ? { sha256: f.sha256 } : {}),
    })),
  };
  return `python3 -I -c ${shellWord(CLEANUP_SCRIPT)} ${shellWord(JSON.stringify(payload))}`;
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

async function setRows(db: Database, ids: string[], values: Partial<typeof fileCleanups.$inferInsert>) {
  if (ids.length) await db.update(fileCleanups).set(values).where(inArray(fileCleanups.id, ids));
}

/**
 * The job: works through a report's approved files, one computer and agent at a time. A computer that is offline,
 * or an agent still at work there, waits: the job comes back later. A run whose answer is unclear marks its files
 * `unknown`; the next job checks them again on the computer (a file already gone is `skipped`), never assuming.
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
  const pending = await db
    .select()
    .from(fileCleanups)
    .where(
      and(
        eq(fileCleanups.orgId, orgId),
        eq(fileCleanups.reportId, reportId),
        inArray(fileCleanups.status, ["approved", "unknown"]),
      ),
    );
  if (pending.length === 0) return { done: 0 };
  const status = await subjectStatus(db, orgId, report.subjectType, report.subjectId);
  if (status !== "done" && status !== "canceled") {
    await setRows(
      db,
      pending.map((r) => r.id),
      { status: "blocked", reason: "The work was reopened.", executedAt: new Date() },
    );
    return { done: 0 };
  }
  // Each file again as it is registered now: an agent may have called it evidence since (the approval no longer holds).
  const regs = await db
    .select()
    .from(runFiles)
    .where(
      and(
        eq(runFiles.orgId, orgId),
        inArray(
          runFiles.id,
          pending.map((r) => r.runFileId).filter((id): id is string => Boolean(id)),
        ),
      ),
    );
  const regOf = new Map(regs.map((r) => [r.id, r]));
  const revoked = pending.filter((r) => {
    const reg = r.runFileId ? regOf.get(r.runFileId) : null;
    return !reg || (reg.role !== "scratch" && reg.role !== "derived") || reg.machineId !== r.machineId;
  });
  await setRows(
    db,
    revoked.map((r) => r.id),
    {
      status: "blocked",
      reason: "No longer registered as scratch or rebuildable on that computer.",
      executedAt: new Date(),
    },
  );
  const live = pending.filter((r) => !revoked.includes(r));
  let later = false;
  let done = 0;
  const groups = new Map<string, typeof live>();
  for (const r of live) {
    const key = `${r.agentId}:${r.machineId}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  for (const rows of groups.values()) {
    const { agentId, machineId } = rows[0] as (typeof rows)[number];
    if (!machineId || !deps.hub) {
      later = true;
      continue;
    }
    const [busy] = await db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.agentId, agentId), inArray(agentRuns.status, [...BUSY_RUN])))
      .limit(1);
    const machine = await deps.hub.status(machineId);
    if (busy || !machine?.online) {
      later = true;
      continue;
    }
    const [agent] = await db
      .select({ id: agents.id, handle: agents.handle, name: agents.name })
      .from(agents)
      .where(and(eq(agents.orgId, orgId), eq(agents.id, agentId)));
    if (!agent) {
      await setRows(
        db,
        rows.map((r) => r.id),
        { status: "blocked", reason: "The agent is gone.", executedAt: new Date() },
      );
      continue;
    }
    // The job's budget: so many files and bytes; the rest wait for the next job.
    let bytes = 0;
    const batch = rows
      .filter((r) => {
        bytes += r.bytes ?? 0;
        return bytes <= CLEANUP_LIMITS.bytes;
      })
      .slice(0, CLEANUP_LIMITS.files);
    if (batch.length < rows.length) later = true;
    if (batch.length === 0) continue;
    const command = cleanupCommand(
      batch.map((r) => {
        const reg = r.runFileId ? regOf.get(r.runFileId) : undefined;
        return { path: r.path, size: reg?.size ?? null, sha256: reg?.sha256 ?? null };
      }),
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
        // A person approved these exact files (ADR 0200): the command policy's holds are for agents' own commands.
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
      await setRows(
        db,
        batch.map((r) => r.id),
        { status: "unknown", reason: why, executedAt: at },
      );
      continue;
    }
    const byPath = new Map(out.results.map((x) => [x.path, x]));
    for (const r of batch) {
      const x = byPath.get(r.path);
      const status: CleanupStatus = x ? x.status : "unknown";
      if (status === "done") done++;
      await setRows(db, [r.id], {
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

/** A workspace's reports with their cleanup state, newest first: for the Clean workspace page (ADR 0200). */
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

/** The Clean workspace page's read (ADR 0200): reports, cleanups and each computer's disk; `configure` only. */
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
