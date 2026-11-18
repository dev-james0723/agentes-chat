import { and, type Database, eq, inArray, schema, sql } from "@agenteschat/db";
import { ValidationError } from "./errors";
import { enqueue } from "./outbox";

/**
 * The files agents make, and what to keep once the work ends (ADR 0197).
 *
 * An agent registers what it made on its computer with `register_files`: the deliverable, the evidence that a
 * check passed, scratch and rebuildable output. When a task or a mission ends, a job writes a dry-run report:
 * what stays, what could be cleaned and why. Nothing here deletes a file. A file nobody registered is not in
 * the report at all, so it is never a candidate.
 */

const { runFiles, retentionReports, agentRuns, artifactVersions, artifacts, machineTasks } = schema;

export const RUN_FILE_KINDS = ["image", "video", "html", "markdown", "log", "build", "other"] as const;
export const RUN_FILE_ROLES = ["canonical", "evidence", "scratch", "derived", "unknown"] as const;
export type RunFileKind = (typeof RUN_FILE_KINDS)[number];
export type RunFileRole = (typeof RUN_FILE_ROLES)[number];

export const RETENTION_REPORT_JOB = "files.retention_report";
const MAX_FILES_PER_CALL = 100;
const MAX_PATH = 1000;

const EXTENSIONS: [RegExp, RunFileKind][] = [
  [/\.(png|jpe?g|gif|webp|heic|tiff?|bmp|svg)$/i, "image"],
  [/\.(mp4|mov|m4v|webm|mkv|avi)$/i, "video"],
  [/\.html?$/i, "html"],
  [/\.(md|markdown)$/i, "markdown"],
  [/\.(log|jsonl)$/i, "log"],
];
const BUILD_DIRS = /(^|\/)(dist|build|\.build|\.next|out|target|DerivedData)\//;

/** A file's kind from its path, when the agent did not say. */
export function kindOfPath(path: string): RunFileKind {
  if (BUILD_DIRS.test(path)) return "build";
  for (const [re, kind] of EXTENSIONS) if (re.test(path)) return kind;
  return "other";
}

/** A workspace-relative path, without `..`: anything else is refused, never guessed at. */
export function cleanRunPath(raw: unknown): string {
  const path = typeof raw === "string" ? raw.trim().replace(/^\.\//, "") : "";
  if (!path || path.length > MAX_PATH) throw new ValidationError("Each file needs a path of up to 1000 characters.");
  if (path.startsWith("/") || path.startsWith("~") || /^[A-Za-z]:[\\/]/.test(path))
    throw new ValidationError(`"${path}": give the path relative to your workspace.`);
  if (path.split(/[\\/]/).includes("..")) throw new ValidationError(`"${path}": a path may not use "..".`);
  return path;
}

export interface RunFileInput {
  path: unknown;
  role?: unknown;
  kind?: unknown;
  size?: unknown;
  sha256?: unknown;
  note?: unknown;
}

/** Records (or updates, same run and path) the files a run made. */
export async function registerRunFiles(
  db: Database,
  who: { orgId: string; agentId: string; runId: string },
  files: RunFileInput[],
) {
  if (!Array.isArray(files) || files.length === 0) throw new ValidationError("List at least one file.");
  if (files.length > MAX_FILES_PER_CALL) throw new ValidationError(`At most ${MAX_FILES_PER_CALL} files a call.`);
  const rows = files.map((f) => {
    const path = cleanRunPath(f.path);
    const role = RUN_FILE_ROLES.includes(f.role as RunFileRole) ? (f.role as RunFileRole) : "unknown";
    const kind = RUN_FILE_KINDS.includes(f.kind as RunFileKind) ? (f.kind as RunFileKind) : kindOfPath(path);
    const size = Number.isInteger(f.size) && (f.size as number) >= 0 ? (f.size as number) : null;
    const sha256 = typeof f.sha256 === "string" && /^[a-f0-9]{64}$/.test(f.sha256) ? f.sha256 : null;
    const note = typeof f.note === "string" && f.note.trim() ? f.note.trim().slice(0, 300) : null;
    return { orgId: who.orgId, agentId: who.agentId, runId: who.runId, path, role, kind, size, sha256, note };
  });
  const byPath = new Map(rows.map((r) => [r.path, r]));
  return db
    .insert(runFiles)
    .values([...byPath.values()])
    .onConflictDoUpdate({
      target: [runFiles.runId, runFiles.path],
      set: {
        role: sql`excluded.role`,
        kind: sql`excluded.kind`,
        size: sql`excluded.size`,
        sha256: sql`excluded.sha256`,
        note: sql`excluded.note`,
        updatedAt: new Date(),
      },
    })
    .returning({ path: runFiles.path, role: runFiles.role, kind: runFiles.kind });
}

export type RetentionDecision = "keep" | "candidate";
export interface RetentionItem {
  where: "drive" | "computer";
  path: string;
  kind: string;
  role: string;
  size: number | null;
  runId: string | null;
  decision: RetentionDecision;
  why: string;
}

/**
 * The rules, on their own so they can be tested: deliverables, evidence and anything of unknown purpose stay;
 * only scratch and rebuildable output become candidates, and dependency folders never do (their blocks are
 * shared copies on APFS: deleting them frees almost nothing, so `du` is no measure of what comes back).
 */
export function retentionDecision(file: { where: "drive" | "computer"; path: string; role: string; kind: string }): {
  decision: RetentionDecision;
  why: string;
} {
  if (file.where === "drive") return { decision: "keep", why: "A Drive file: people open it from the task." };
  if (/(^|\/)node_modules(\/|$)/.test(file.path))
    return { decision: "keep", why: "Dependencies: shared copies on disk, cleaning them frees almost nothing." };
  switch (file.role) {
    case "canonical":
      return { decision: "keep", why: "The deliverable." };
    case "evidence":
      return {
        decision: "keep",
        why: "Evidence that a check passed: kept while the work can be reviewed or rolled back.",
      };
    case "scratch":
      return { decision: "candidate", why: "Scratch the agent made for this work, which has ended." };
    case "derived":
      return {
        decision: "candidate",
        why:
          file.kind === "build"
            ? "Build output that can be made again. Measure free space before and after: file sizes overstate it."
            : "Made from other files and can be made again.",
      };
    default:
      return { decision: "keep", why: "Its purpose is unknown, so it stays." };
  }
}

type Subject = { type: "issue" | "mission"; id: string };

async function runsOf(db: Database, orgId: string, subject: Subject): Promise<string[]> {
  if (subject.type === "issue") {
    const rows = await db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.issueId, subject.id)));
    return rows.map((r) => r.id);
  }
  const rows = await db
    .select({ id: machineTasks.runId })
    .from(machineTasks)
    .where(and(eq(machineTasks.orgId, orgId), eq(machineTasks.missionId, subject.id)));
  return [...new Set(rows.map((r) => r.id).filter((id): id is string => Boolean(id)))];
}

/** Builds the report for a task or a mission from what its runs saved and registered. */
export async function buildRetentionReport(
  db: Database,
  orgId: string,
  subject: Subject,
  outcome: "done" | "canceled",
) {
  const runIds = await runsOf(db, orgId, subject);
  const items: RetentionItem[] = [];
  if (runIds.length > 0) {
    const drive = await db
      .select({
        runId: artifactVersions.runId,
        title: artifacts.title,
        fileName: artifactVersions.fileName,
        size: artifactVersions.size,
        contentType: artifactVersions.contentType,
      })
      .from(artifactVersions)
      .innerJoin(artifacts, eq(artifacts.id, artifactVersions.artifactId))
      .where(and(eq(artifactVersions.orgId, orgId), inArray(artifactVersions.runId, runIds)));
    for (const d of drive) {
      const path = d.fileName ?? d.title;
      const file = { where: "drive" as const, path, role: "canonical", kind: kindOfPath(path) };
      items.push({ ...file, size: d.size, runId: d.runId, ...retentionDecision(file) });
    }
    const local = await db
      .select()
      .from(runFiles)
      .where(and(eq(runFiles.orgId, orgId), inArray(runFiles.runId, runIds)));
    for (const f of local) {
      const file = { where: "computer" as const, path: f.path, role: f.role, kind: f.kind };
      items.push({ ...file, size: f.size, runId: f.runId, ...retentionDecision(file) });
    }
  }
  const candidates = items.filter((i) => i.decision === "candidate");
  return {
    dryRun: true,
    subject,
    outcome,
    runs: runIds.length,
    kept: items.length - candidates.length,
    candidates: candidates.length,
    candidateBytes: candidates.reduce((n, i) => n + (i.size ?? 0), 0),
    note: "Nothing was deleted. Files no agent registered are not listed and stay where they are.",
    items,
  };
}

/** Writes (or rewrites) the report of a task or mission that ended. Idempotent, as jobs must be. */
export async function writeRetentionReport(
  db: Database,
  orgId: string,
  subject: Subject,
  outcome: "done" | "canceled",
) {
  const report = await buildRetentionReport(db, orgId, subject, outcome);
  await db
    .insert(retentionReports)
    .values({ orgId, subjectType: subject.type, subjectId: subject.id, outcome, report })
    .onConflictDoUpdate({
      target: [retentionReports.orgId, retentionReports.subjectType, retentionReports.subjectId],
      set: { outcome, report, createdAt: new Date() },
    });
  return report;
}

/** Queues the report once a task or a mission reaches `done` or `canceled`; other states queue nothing. */
export async function queueRetentionReport(
  db: Database,
  orgId: string,
  subject: Subject,
  status: string,
  at: Date = new Date(),
) {
  if (status !== "done" && status !== "canceled") return;
  await enqueue(db, {
    orgId,
    kind: RETENTION_REPORT_JOB,
    payload: { subjectType: subject.type, subjectId: subject.id, outcome: status },
    dedupeKey: `${RETENTION_REPORT_JOB}:${subject.type}:${subject.id}:${status}:${at.getTime()}`,
  });
}
