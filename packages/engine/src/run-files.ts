import { and, type Database, type Executor, eq, gte, inArray, isNull, lte, or, schema, sql } from "@agenteschat/db";
import { refusalData, ValidationError } from "./errors";
import { enqueue } from "./outbox";
import type { ToolDefinition } from "./tools/types";

/**
 * The files agents make, and what to keep once the work ends (ADR 0197).
 *
 * An agent registers what it made on its computer with `register_files`: the deliverable, the evidence that a
 * check passed, scratch and rebuildable output. When a task or a mission ends, a job writes a dry-run report:
 * what stays, what could be cleaned and why. Nothing here deletes a file. A file nobody registered is not in
 * the report at all, so it is never a candidate.
 */

const {
  runFiles,
  retentionReports,
  agentRuns,
  agentWorks,
  artifactVersions,
  artifacts,
  machineTasks,
  missions,
  issues,
} = schema;

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
// Case-insensitive: the default APFS volume is, so `Node_Modules` is the same folder.
const BUILD_DIRS = /(^|\/)(dist|build|\.build|\.next|out|target|deriveddata)\//i;
const DEPENDENCIES = /(^|\/)node_modules(\/|$)/i;

/** A file's kind from its (clean) path, when the agent did not say. */
export function kindOfPath(path: string): RunFileKind {
  if (BUILD_DIRS.test(path)) return "build";
  for (const [re, kind] of EXTENSIONS) if (re.test(path)) return kind;
  return "other";
}

/**
 * One file, relative to the workspace, in one spelling: backslashes become slashes and `.` and empty segments go,
 * so `a/./b`, `a//b` and `a\b` are the same row. Absolute, rooted, drive and home paths, `..`, shell expansions,
 * control characters, a trailing slash (a folder) and the workspace itself are refused, never guessed at.
 */
export function cleanRunPath(raw: unknown): string {
  const given = typeof raw === "string" ? raw.trim() : "";
  if (!given || given.length > MAX_PATH) throw new ValidationError("Each file needs a path of up to 1000 characters.");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point.
  if (/[\u0000-\u001f\u007f]/.test(given)) throw new ValidationError("A path may not hold control characters.");
  const slashed = given.replace(/\\/g, "/");
  if (slashed.startsWith("/") || slashed.startsWith("~") || /^[A-Za-z]:/.test(slashed) || slashed.includes("$"))
    throw new ValidationError(`"${given}": give the path relative to your workspace, as written on disk.`);
  if (slashed.endsWith("/")) throw new ValidationError(`"${given}": register files, not folders.`);
  const parts = slashed.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.includes("..")) throw new ValidationError(`"${given}": a path may not use "..".`);
  if (parts.length === 0) throw new ValidationError(`"${given}": register files, not the workspace itself.`);
  return parts.join("/");
}

export interface RunFileInput {
  path: unknown;
  role?: unknown;
  kind?: unknown;
  size?: unknown;
  sha256?: unknown;
  note?: unknown;
}

/** Records (or updates, same run and path) the files a run made. All or nothing: one bad path records none. */
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
    const size = Number.isSafeInteger(f.size) && (f.size as number) >= 0 ? (f.size as number) : null;
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

/**
 * The tool, offered by the computer's tool source only where the agent has a computer (ADR 0197): an agent that
 * only chats makes no files there to register.
 */
export function registerFilesTool(db: Database): ToolDefinition {
  return {
    name: "register_files",
    description:
      "Note the files you made on your computer for this work and what each is for: canonical (the deliverable), evidence (proof a check passed: a screenshot, a test log), scratch (temporary), derived (output that can be made again, like a build) or unknown. One entry per file, its path relative to your workspace. When the task ends this feeds a report of what to keep; it never deletes anything, and a file you don't register is always kept.",
    // The computer's scope, written out: importing it would tie this module to the computer's whole graph.
    scope: "sandbox:run",
    inputSchema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          minItems: 1,
          maxItems: MAX_FILES_PER_CALL,
          items: {
            type: "object",
            properties: {
              path: { type: "string", minLength: 1, maxLength: MAX_PATH },
              role: { enum: [...RUN_FILE_ROLES] },
              kind: { enum: [...RUN_FILE_KINDS] },
              size: { type: "integer", minimum: 0 },
              sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
              note: { type: "string", maxLength: 300 },
            },
            required: ["path", "role"],
            additionalProperties: false,
          },
        },
      },
      required: ["files"],
      additionalProperties: false,
    },
    async execute(input, ctx) {
      // A mission task's bridge call has no run of its own to file these under.
      if (!ctx.runId) return refused(new ValidationError("Files are registered from a run. This call has none."));
      try {
        const rows = await registerRunFiles(
          db,
          { orgId: ctx.orgId, agentId: ctx.agentId, runId: ctx.runId },
          input.files as RunFileInput[],
        );
        const counts = new Map<string, number>();
        for (const r of rows) counts.set(r.role, (counts.get(r.role) ?? 0) + 1);
        const summary = [...counts].map(([role, n]) => `${n} ${role}`).join(", ");
        return {
          content: `Registered ${rows.length} file(s): ${summary}. Nothing was moved or deleted.`,
          data: { files: rows },
        };
      } catch (error) {
        return refused(error);
      }
    },
  };
}

/** A refusal the bridge knows as one (a bad path is fixed and sent again, never an effect left in doubt). */
function refused(error: unknown) {
  return { content: error instanceof Error ? error.message : String(error), isError: true, ...refusalData(error) };
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
  if (DEPENDENCIES.test(file.path))
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
type Outcome = "done" | "canceled";

/**
 * Every run that worked on it. A task: runs filed under it, and runs of background work linked to it (a later run
 * of the same work may not carry the task). A mission: the agent's runs in the mission's thread (as canceling the
 * mission finds them) and runs that started its tasks.
 */
async function runsOf(db: Database, orgId: string, subject: Subject): Promise<string[]> {
  if (subject.type === "issue") {
    const works = db
      .select({ id: agentWorks.id })
      .from(agentWorks)
      .where(and(eq(agentWorks.orgId, orgId), eq(agentWorks.issueId, subject.id)));
    const rows = await db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(and(eq(agentRuns.orgId, orgId), or(eq(agentRuns.issueId, subject.id), inArray(agentRuns.workId, works))));
    return rows.map((r) => r.id);
  }
  const [mission] = await db
    .select()
    .from(missions)
    .where(and(eq(missions.orgId, orgId), eq(missions.id, subject.id)));
  if (!mission) return [];
  const thread = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.orgId, orgId),
        eq(agentRuns.agentId, mission.agentId),
        eq(agentRuns.channelId, mission.channelId),
        eq(agentRuns.threadRootId, mission.threadRootId),
        // Only while it was open: chat in the thread before it, or an earlier mission there, is not its work.
        gte(agentRuns.createdAt, mission.createdAt),
        lte(agentRuns.createdAt, mission.closedAt ?? new Date()),
      ),
    );
  const starters = await db
    .select({ id: machineTasks.runId })
    .from(machineTasks)
    .where(and(eq(machineTasks.orgId, orgId), eq(machineTasks.missionId, subject.id)));
  return [...new Set([...thread, ...starters].map((r) => r.id).filter((id): id is string => Boolean(id)))];
}

/** Its status now: the report is about how it stands when the job runs, not when it was queued. */
async function statusOf(db: Database, orgId: string, subject: Subject): Promise<string | null> {
  const table = subject.type === "issue" ? issues : missions;
  const [row] = await db
    .select({ status: table.status })
    .from(table)
    .where(and(eq(table.orgId, orgId), eq(table.id, subject.id)));
  return row?.status ?? null;
}

/** Builds the report for a task or a mission from what its runs saved and registered. */
export async function buildRetentionReport(db: Database, orgId: string, subject: Subject, outcome: Outcome) {
  const runIds = await runsOf(db, orgId, subject);
  const items: RetentionItem[] = [];
  if (runIds.length > 0) {
    // One item per Drive file a run saved (not per version), trashed ones left out. Ids and names only: whoever
    // reads the report still needs access to a file to open it.
    const drive = await db
      .selectDistinctOn([artifacts.id], {
        artifactId: artifacts.id,
        runId: artifactVersions.runId,
        title: artifacts.title,
        fileName: artifactVersions.fileName,
        size: artifactVersions.size,
      })
      .from(artifactVersions)
      .innerJoin(artifacts, eq(artifacts.id, artifactVersions.artifactId))
      .where(
        and(
          eq(artifactVersions.orgId, orgId),
          eq(artifacts.orgId, orgId),
          inArray(artifactVersions.runId, runIds),
          isNull(artifacts.deletedAt),
        ),
      )
      .orderBy(artifacts.id, sql`${artifactVersions.version} desc`);
    for (const d of drive) {
      const path = d.fileName ?? d.title;
      const file = { where: "drive" as const, path, role: "canonical", kind: kindOfPath(path) };
      items.push({ ...file, size: d.size, runId: d.runId, ...retentionDecision(file) });
    }
    const local = await db
      .select()
      .from(runFiles)
      .where(and(eq(runFiles.orgId, orgId), inArray(runFiles.runId, runIds)));
    const paths = new Set(local.map((f) => f.path));
    for (const f of local) {
      const file = { where: "computer" as const, path: f.path, role: f.role, kind: f.kind };
      // A path that holds other registered files is a folder after all: it stays.
      const holdsOthers = [...paths].some((p) => p !== f.path && p.startsWith(`${f.path}/`));
      const decided = holdsOthers
        ? { decision: "keep" as const, why: "A folder holding other registered files." }
        : retentionDecision(file);
      items.push({ ...file, size: f.size, runId: f.runId, ...decided });
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

/**
 * Writes (or rewrites) the report of a task or mission, as it stands now: one that was reopened before the job ran
 * gets none, and the outcome is its current one, whatever order the jobs ran in. Idempotent, as jobs must be.
 */
export async function writeRetentionReport(db: Database, orgId: string, subject: Subject) {
  const status = await statusOf(db, orgId, subject);
  if (status !== "done" && status !== "canceled") return null;
  const report = await buildRetentionReport(db, orgId, subject, status);
  await db
    .insert(retentionReports)
    .values({ orgId, subjectType: subject.type, subjectId: subject.id, outcome: status, report })
    .onConflictDoUpdate({
      target: [retentionReports.orgId, retentionReports.subjectType, retentionReports.subjectId],
      set: { outcome: status, report, createdAt: new Date() },
    });
  return report;
}

/**
 * Queues the report once a task or a mission reaches `done` or `canceled`; other states queue nothing. Call it in
 * the transaction that changes the status, so the change and its job commit together.
 */
export async function queueRetentionReport(
  db: Executor,
  orgId: string,
  subject: Subject,
  status: string,
  at: Date = new Date(),
) {
  if (status !== "done" && status !== "canceled") return;
  await enqueue(db, {
    orgId,
    kind: RETENTION_REPORT_JOB,
    payload: { subjectType: subject.type, subjectId: subject.id },
    dedupeKey: `${RETENTION_REPORT_JOB}:${subject.type}:${subject.id}:${status}:${at.getTime()}`,
  });
}
