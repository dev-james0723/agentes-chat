import { and, type Database, desc, eq, inArray, isNull, lt, or, schema, sql } from "@agenteschat/db";
import { deliverNotice } from "./delivery";
import { refusalData, ValidationError } from "./errors";
import { cleanupCommand, parseCleanupOutput, type ScriptOutput } from "./file-cleanup";
import type { MachineCaller } from "./machine-hub";
import { requirePermission } from "./organizations";
import { enqueue } from "./outbox";
import { cleanRunPath, machineOfRun } from "./run-files";
import {
  type ArtifactFacts,
  type Decision,
  decide,
  gcBudget,
  gcMode,
  type LifecycleState,
  protectedPath,
  SETTLE_SECONDS,
} from "./storage-decision";
import { pressureOf } from "./storage-pressure";
import type { ToolContext, ToolDefinition } from "./tools/types";

/**
 * Continuous cleanup while work goes on (ADR 0213), on top of ADR 0197's registry and ADR 0201's checks.
 *
 * Agents say when a file is complete (`seal`), who reads it (`read`), which later stage needs it (`future`) and when
 * they are done with it (`release`). After each such event a small job on that computer looks only at the files the
 * events touched: `decide` (storage-decision.ts) picks what to do, a file to remove is reserved first (one collector,
 * one version, no open lease, in one statement), then the computer checks it again and removes it (`CLEANUP_SCRIPT`,
 * low priority, a few files and seconds a cycle). Every change of state is journaled; every outcome is a receipt in
 * `file_cleanups` and a quiet line in the agent's own conversation. Anything uncertain goes to a person's review.
 */

const { runFiles, artifactLeases, artifactTransitions, storageScopes, storageGcSettings, storageReviewItems } = schema;
const { fileCleanups, agentRuns, agents, machines } = schema;

export const STORAGE_GC_JOB = "files.gc";
/** A lease's life without a heartbeat. Its end makes the file a review item, never a removal. */
export const LEASE_TTL_SECONDS = 15 * 60;
/** A collector's claim older than this was left by a stopped server: the computer checks the file again. */
export const STALE_RESERVATION_MS = 15 * 60 * 1000;
const GC_COALESCE_MS = 5_000;
const FINISHED_RUNS = ["done", "failed", "canceled"] as const;
type RunFile = typeof runFiles.$inferSelect;

/** One change of state, only from the version the caller saw; journaled. False: someone else changed it first. */
export async function transition(
  db: Database,
  file: Pick<RunFile, "id" | "orgId" | "state" | "version">,
  to: LifecycleState,
  actor: string,
  code: string,
  extra: Partial<Pick<RunFile, "sealedAt" | "reservedToken" | "reservedAt">> = {},
  detail?: Record<string, unknown>,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const moved = await tx
      .update(runFiles)
      .set({ state: to, version: file.version + 1, updatedAt: new Date(), ...extra })
      .where(and(eq(runFiles.id, file.id), eq(runFiles.version, file.version)))
      .returning({ id: runFiles.id });
    if (moved.length === 0) return false;
    await tx.insert(artifactTransitions).values({
      orgId: file.orgId,
      runFileId: file.id,
      fromState: file.state,
      toState: to,
      version: file.version + 1,
      actor,
      code,
      ...(detail ? { detail } : {}),
    });
    return true;
  });
}

/**
 * The reservation (§6, §8): the file moves to `reserved` only if it is still at the version decided on, still
 * `sealed` or `released` (or a person approved it), and no lease is open on it, all in one statement. Two collectors
 * racing for it: exactly one wins.
 */
export async function reserve(db: Database, file: RunFile, token: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const moved = await tx
      .update(runFiles)
      .set({ state: "reserved", version: file.version + 1, reservedToken: token, reservedAt: new Date() })
      .where(
        and(
          eq(runFiles.id, file.id),
          eq(runFiles.version, file.version),
          inArray(runFiles.state, ["sealed", "released", "review", "created"]),
          sql`not exists (select 1 from ${artifactLeases} l where l.run_file_id = ${runFiles.id} and l.status = 'open')`,
        ),
      )
      .returning({ id: runFiles.id });
    if (moved.length === 0) return false;
    await tx.insert(artifactTransitions).values({
      orgId: file.orgId,
      runFileId: file.id,
      fromState: file.state,
      toState: "reserved",
      version: file.version + 1,
      actor: "collector",
      code: "reserved",
      detail: { token },
    });
    return true;
  });
}

/** The latest registration of a path on a computer (any run, any agent of the workspace). */
async function fileAt(db: Database, orgId: string, machineId: string | null, path: string) {
  const [row] = await db
    .select()
    .from(runFiles)
    .where(
      and(
        eq(runFiles.orgId, orgId),
        eq(runFiles.path, path),
        machineId ? eq(runFiles.machineId, machineId) : isNull(runFiles.machineId),
      ),
    )
    .orderBy(desc(runFiles.updatedAt))
    .limit(1);
  return row ?? null;
}

/** Asks for a collector cycle on a computer soon; events within a few seconds share one. */
export async function scheduleGc(db: Database, orgId: string, machineId: string | null, now = Date.now()) {
  if (!machineId) return;
  await enqueue(db, {
    orgId,
    kind: STORAGE_GC_JOB,
    payload: { machineId },
    dedupeKey: `${STORAGE_GC_JOB}:${machineId}:${Math.floor(now / GC_COALESCE_MS)}`,
    runAt: new Date(now + GC_COALESCE_MS),
  });
}

export type LifecycleOp = "seal" | "read" | "future" | "release" | "heartbeat" | "pin";

/** One agent event on some files (§4). Cheap: rows only; the cleanup itself is a job of its own. */
export async function lifecycleEvent(
  db: Database,
  who: { orgId: string; agentId: string; runId: string; machineId: string | null },
  op: LifecycleOp,
  paths: string[],
  stage?: string,
) {
  const actor = `agent:${who.agentId}`;
  const now = new Date();
  const out: { path: string; state: string; note?: string }[] = [];
  if (op === "heartbeat") {
    const rows = await db
      .update(artifactLeases)
      .set({ heartbeatAt: now, expiresAt: new Date(now.getTime() + LEASE_TTL_SECONDS * 1000) })
      .where(
        and(
          eq(artifactLeases.orgId, who.orgId),
          eq(artifactLeases.holderRunId, who.runId),
          eq(artifactLeases.status, "open"),
        ),
      )
      .returning({ id: artifactLeases.id });
    return { renewed: rows.length, files: out };
  }
  for (const raw of paths) {
    const path = cleanRunPath(raw);
    const file = await fileAt(db, who.orgId, who.machineId, path);
    if (!file) {
      out.push({ path, state: "unregistered", note: "not registered on this computer: register_files it first" });
      continue;
    }
    if (op === "seal") {
      if (file.agentId !== who.agentId) {
        out.push({ path, state: file.state, note: "only the agent that made it can seal it" });
        continue;
      }
      if (["created", "writing", "unknown"].includes(file.state)) {
        await transition(db, file, "sealed", actor, "sealed", { sealedAt: now });
      } else if (file.state === "sealed" || file.state === "released") {
        // Sealed again: it was written again, so its seal time moves (the computer refuses anything newer).
        await transition(db, file, "sealed", actor, "resealed", { sealedAt: now });
      }
      await db
        .update(artifactLeases)
        .set({ status: "released", releasedAt: now })
        .where(
          and(
            eq(artifactLeases.runFileId, file.id),
            eq(artifactLeases.holderAgentId, who.agentId),
            eq(artifactLeases.kind, "write"),
            eq(artifactLeases.status, "open"),
          ),
        );
    } else if (op === "read" || op === "future") {
      await db.insert(artifactLeases).values({
        orgId: who.orgId,
        runFileId: file.id,
        holderAgentId: who.agentId,
        holderRunId: who.runId,
        kind: op,
        stage: stage?.slice(0, 200) ?? null,
        generation: file.version,
        expiresAt: new Date(now.getTime() + LEASE_TTL_SECONDS * 1000),
      });
    } else if (op === "release") {
      await db
        .update(artifactLeases)
        .set({ status: "released", releasedAt: now })
        .where(
          and(
            eq(artifactLeases.runFileId, file.id),
            eq(artifactLeases.holderAgentId, who.agentId),
            eq(artifactLeases.status, "open"),
          ),
        );
    } else if (op === "pin") {
      // Any agent may protect a file; only a person undoes it (in review).
      if (file.state !== "protected" && file.state !== "deleted")
        await transition(db, file, "protected", actor, "agent_pinned");
    }
    const [now2] = await db.select({ state: runFiles.state }).from(runFiles).where(eq(runFiles.id, file.id));
    out.push({ path, state: now2?.state ?? file.state });
  }
  if (op !== "pin") await scheduleGc(db, who.orgId, who.machineId);
  return { files: out };
}

/** The tool beside `register_files` (ADR 0213): tell the collector what is done, read, needed later or released. */
export function fileLifecycleTool(
  db: Database,
  computerOf?: (ctx: ToolContext, computer: string | undefined) => Promise<string>,
): ToolDefinition {
  return {
    name: "file_lifecycle",
    description:
      "Tell Storage Guardian what your registered files are doing so scratch is cleaned while you work: `seal` files you finished writing, `read` files (yours or another agent's) you are reading, `future` files a later step will need (say which in `stage`), `release` files you no longer need, `heartbeat` while a long read goes on, `pin` a file that must never be removed. Only scratch and rebuildable files that are sealed and released by everyone, inside a folder a person authorized, are ever removed, each checked again on the computer; anything uncertain waits for a person. Receipts come back to this conversation.",
    scope: "sandbox:run",
    inputSchema: {
      type: "object",
      properties: {
        op: { enum: ["seal", "read", "future", "release", "heartbeat", "pin"] },
        paths: { type: "array", items: { type: "string", minLength: 1, maxLength: 1000 }, maxItems: 100 },
        stage: { type: "string", maxLength: 200 },
        computer: { type: "string", maxLength: 120 },
      },
      required: ["op"],
      additionalProperties: false,
    },
    async execute(input, ctx) {
      if (!ctx.runId) return { content: "File events come from a run. This call has none.", isError: true };
      try {
        const named = typeof input.computer === "string" && input.computer.trim() ? input.computer.trim() : undefined;
        const machineId = computerOf ? await computerOf(ctx, named) : named ? null : await machineOfRun(db, ctx);
        const op = input.op as LifecycleOp;
        const paths = Array.isArray(input.paths) ? (input.paths as string[]) : [];
        if (op !== "heartbeat" && paths.length === 0) throw new ValidationError("List the files.");
        const result = await lifecycleEvent(
          db,
          { orgId: ctx.orgId, agentId: ctx.agentId, runId: ctx.runId, machineId },
          op,
          paths,
          typeof input.stage === "string" ? input.stage : undefined,
        );
        const lines = result.files.map((f) => `${f.path}: ${f.state}${f.note ? ` (${f.note})` : ""}`);
        return {
          content: `${op}: ${lines.join("; ") || `${(result as { renewed?: number }).renewed ?? 0} lease(s) renewed`}. Nothing was deleted by this call.`,
          data: result,
        };
      } catch (error) {
        return {
          content: error instanceof Error ? error.message : String(error),
          isError: true,
          ...refusalData(error),
        };
      }
    },
  };
}

/**
 * Lease housekeeping before a cycle: a lease whose run ended is released (the run can no longer read: that is
 * evidence); a lease whose heartbeat stopped while its run is still open is `expired` (§6: nothing is proven, its
 * file goes to review).
 */
export async function settleLeases(db: Database, orgId: string, now = new Date()) {
  const released = await db.execute(sql`
    update ${artifactLeases} l set status = 'released', released_at = ${now}
    from ${agentRuns} r
    where l.org_id = ${orgId} and l.status = 'open' and l.holder_run_id = r.id
      and r.status::text in (${sql.join(
        FINISHED_RUNS.map((s) => sql`${s}`),
        sql`, `,
      )})
    returning l.id`);
  const expired = await db
    .update(artifactLeases)
    .set({ status: "expired" })
    .where(and(eq(artifactLeases.orgId, orgId), eq(artifactLeases.status, "open"), lt(artifactLeases.expiresAt, now)))
    .returning({ id: artifactLeases.id });
  return { released: (released as unknown as { rows?: unknown[] }).rows?.length ?? 0, expired: expired.length };
}

/**
 * A claim a stopped collector left behind (§16): the file goes back to `released`; the next cycle reserves it
 * again and the computer answers for it (`skipped` when it is already gone). Nothing is assumed removed.
 */
export async function recoverReservations(db: Database, orgId: string, machineId: string, now = Date.now()) {
  const stale = await db
    .select()
    .from(runFiles)
    .where(
      and(
        eq(runFiles.orgId, orgId),
        eq(runFiles.machineId, machineId),
        eq(runFiles.state, "reserved"),
        lt(runFiles.reservedAt, new Date(now - STALE_RESERVATION_MS)),
      ),
    );
  let n = 0;
  for (const f of stale)
    if (await transition(db, f, "released", "collector", "reservation_stale_recheck", { reservedToken: null })) n++;
  return n;
}

interface Settings {
  enabled: boolean;
  modeOverride: string | null;
}
async function settingsOf(db: Database, orgId: string): Promise<Settings> {
  const [row] = await db.select().from(storageGcSettings).where(eq(storageGcSettings.orgId, orgId));
  return { enabled: row?.enabled ?? true, modeOverride: row?.modeOverride ?? null };
}

/** The facts `decide` needs for these files, in a few queries. */
export async function factsFor(
  db: Database,
  orgId: string,
  files: RunFile[],
  context: {
    machinePosix: Map<string, boolean>;
    pressure: ArtifactFacts["pressure"];
    enabled: boolean;
    now?: number;
  },
): Promise<Map<string, ArtifactFacts>> {
  const out = new Map<string, ArtifactFacts>();
  if (files.length === 0) return out;
  const ids = files.map((f) => f.id);
  const leases = await db.select().from(artifactLeases).where(inArray(artifactLeases.runFileId, ids));
  const reviews = await db.select().from(storageReviewItems).where(inArray(storageReviewItems.runFileId, ids));
  const others = await db
    .select({ id: runFiles.id, path: runFiles.path, machineId: runFiles.machineId, role: runFiles.role })
    .from(runFiles)
    .where(
      and(
        eq(runFiles.orgId, orgId),
        inArray(
          runFiles.path,
          files.map((f) => f.path),
        ),
      ),
    );
  const scopes = await db.select().from(storageScopes).where(eq(storageScopes.orgId, orgId));
  const now = context.now ?? Date.now();
  for (const f of files) {
    const mine = leases.filter((l) => l.runFileId === f.id);
    const open = mine.filter((l) => l.status === "open");
    const review = reviews.find((r) => r.runFileId === f.id);
    const scope = scopeFor(scopes, f);
    out.set(f.id, {
      role: f.role,
      path: f.path,
      state: f.state,
      sealed: f.sealedAt !== null,
      sealedAgeSeconds: f.sealedAt ? (now - f.sealedAt.getTime()) / 1000 : null,
      openWriters: open.filter((l) => l.kind === "write").length,
      openReaders: open.filter((l) => l.kind === "read").length,
      futureStages: open.filter((l) => l.kind === "future").length,
      expiredLeases: mine.filter((l) => l.status === "expired").length,
      otherRegistrationKeeps: others.some(
        (o) =>
          o.id !== f.id &&
          o.path === f.path &&
          (o.machineId === f.machineId || o.machineId === null) &&
          o.role !== "scratch" &&
          o.role !== "derived",
      ),
      review:
        review?.status === "open" ||
        review?.status === "kept" ||
        review?.status === "protected" ||
        review?.status === "delete" ||
        review?.status === "archive"
          ? review.status
          : "none",
      machineKnown: f.machineId !== null && context.machinePosix.has(f.machineId),
      machinePosix: f.machineId !== null && context.machinePosix.get(f.machineId) === true,
      scope: scope ? { mode: scope.mode as "shadow" | "enforce" } : null,
      collectorEnabled: context.enabled,
      pressure: context.pressure,
    });
  }
  return out;
}

/** The authorized folder a file lies in; where two overlap, `shadow` wins (the cautious one). */
function scopeFor(scopes: (typeof storageScopes.$inferSelect)[], f: Pick<RunFile, "machineId" | "path">) {
  const within = scopes.filter((s) => s.machineId === f.machineId && f.path.startsWith(s.root));
  return within.find((s) => s.mode === "shadow") ?? within[0];
}

async function openReview(db: Database, file: RunFile, d: Decision) {
  await db
    .insert(storageReviewItems)
    .values({ orgId: file.orgId, runFileId: file.id, code: d.code, reason: d.reason })
    .onConflictDoUpdate({
      target: storageReviewItems.runFileId,
      set: { code: d.code, reason: d.reason, status: "open" },
      setWhere: sql`${storageReviewItems.status} in ('restored')`,
    });
  if (file.state !== "review") await transition(db, file, "review", "collector", d.code);
}

export interface GcCycle {
  mode: string;
  considered: number;
  decisions: Record<string, number>;
  reserved: number;
  removed: number;
  shadow: number;
  blocked: number;
  unknown: number;
  logicalBytes: number;
  allocatedBytes: number;
  freeBefore: number | null;
  freeAfter: number | null;
  skippedReason?: string;
}

/**
 * One collector cycle on one computer (§4, §8). Bounded by its mode's budget, interruptible between files, and
 * never waits on an agent: the agents keep working while it runs.
 */
export async function runStorageGc(
  deps: { db: Database; hub: Pick<MachineCaller, "call" | "status"> | null },
  orgId: string,
  machineId: string,
  options: { now?: number; signal?: AbortSignal } = {},
): Promise<GcCycle> {
  const { db } = deps;
  const now = options.now ?? Date.now();
  const settings = await settingsOf(db, orgId);
  const [machine] = await db
    .select({ id: machines.id, load: machines.load })
    .from(machines)
    .where(and(eq(machines.orgId, orgId), eq(machines.id, machineId)));
  const pressure = pressureOf(machine?.load ?? null, now).level;
  const mode = gcMode(pressure, settings.modeOverride);
  const budget = gcBudget(mode);
  const cycle: GcCycle = {
    mode,
    considered: 0,
    decisions: {},
    reserved: 0,
    removed: 0,
    shadow: 0,
    blocked: 0,
    unknown: 0,
    logicalBytes: 0,
    allocatedBytes: 0,
    freeBefore: null,
    freeAfter: null,
  };
  await settleLeases(db, orgId, new Date(now));
  await recoverReservations(db, orgId, machineId, now);
  const status = machine && deps.hub ? await deps.hub.status(machineId) : null;
  const posix = new Map<string, boolean>();
  if (machine) posix.set(machineId, status ? status.os === "darwin" || status.os === "linux" : false);
  const reviewDeletes = db
    .select({ id: storageReviewItems.runFileId })
    .from(storageReviewItems)
    .where(and(eq(storageReviewItems.orgId, orgId), eq(storageReviewItems.status, "delete")));
  const candidates = await db
    .select()
    .from(runFiles)
    .where(
      and(
        eq(runFiles.orgId, orgId),
        eq(runFiles.machineId, machineId),
        or(inArray(runFiles.state, ["sealed", "released", "unknown"]), inArray(runFiles.id, reviewDeletes)),
      ),
    )
    .orderBy(runFiles.sealedAt)
    .limit(budget.files * 4);
  const facts = await factsFor(db, orgId, candidates, {
    machinePosix: posix,
    pressure,
    enabled: settings.enabled,
    now,
  });
  const toRemove: {
    file: RunFile;
    decision: Decision;
    shadow: boolean;
    approver: string;
    source: "auto" | "review";
  }[] = [];
  const scopes = await db.select().from(storageScopes).where(eq(storageScopes.orgId, orgId));
  const reviewers = await db
    .select()
    .from(storageReviewItems)
    .where(and(eq(storageReviewItems.orgId, orgId), eq(storageReviewItems.status, "delete")));
  for (const file of candidates) {
    if (options.signal?.aborted) break;
    const f = facts.get(file.id);
    if (!f) continue;
    cycle.considered++;
    const d = decide(f);
    cycle.decisions[d.code] = (cycle.decisions[d.code] ?? 0) + 1;
    if (d.action === "RELEASE" && file.state === "sealed") await transition(db, file, "released", "collector", d.code);
    else if (d.action === "REVIEW") await openReview(db, file, d);
    else if (d.action === "PROTECT" && file.state !== "protected")
      await transition(db, file, "protected", "collector", d.code);
    else if (d.action === "DELETE" && toRemove.length < budget.files) {
      const scope = scopeFor(scopes, file);
      const reviewer = reviewers.find((r) => r.runFileId === file.id);
      const source = reviewer ? "review" : "auto";
      const shadow = source === "auto" && scope?.mode !== "enforce";
      const approver = reviewer?.decidedByUserId ?? scope?.createdByUserId ?? "";
      if (!approver) continue;
      toRemove.push({ file, decision: d, shadow, approver, source });
    }
  }
  // Shadow (§17): what would go, recorded once per file; nothing reaches the computer.
  for (const r of toRemove.filter((x) => x.shadow)) {
    const [seen] = await db
      .select({ id: fileCleanups.id })
      .from(fileCleanups)
      .where(and(eq(fileCleanups.runFileId, r.file.id), eq(fileCleanups.shadow, true)))
      .limit(1);
    if (seen) continue;
    await db.insert(fileCleanups).values({
      orgId,
      runId: r.file.runId,
      runFileId: r.file.id,
      agentId: r.file.agentId,
      machineId,
      path: r.file.path,
      status: "skipped",
      source: "auto",
      shadow: true,
      reason: `shadow: would remove (${r.decision.code})`,
      bytes: r.file.size,
      approvedByUserId: r.approver,
      executedAt: new Date(now),
    });
    cycle.shadow++;
  }
  const live = toRemove.filter((x) => !x.shadow);
  if (live.length === 0) return cycle;
  if (!deps.hub || !status?.online) {
    cycle.skippedReason = "computer offline: nothing reserved";
    return cycle;
  }
  // Reserve each, then send them, grouped by the agent that made them (it runs as that agent, in its folder).
  const reserved: typeof live = [];
  for (const r of live) {
    const token = Bun.randomUUIDv7();
    if (await reserve(db, r.file, token)) {
      reserved.push({ ...r, file: { ...r.file, state: "reserved", version: r.file.version + 1 } });
      cycle.reserved++;
    }
  }
  const byAgent = new Map<string, typeof reserved>();
  for (const r of reserved) byAgent.set(r.file.agentId, [...(byAgent.get(r.file.agentId) ?? []), r]);
  const receipts = new Map<string, string[]>();
  for (const [agentId, rows] of byAgent) {
    if (options.signal?.aborted) break;
    const [agent] = await db
      .select({ id: agents.id, handle: agents.handle, name: agents.name })
      .from(agents)
      .where(and(eq(agents.orgId, orgId), eq(agents.id, agentId)));
    const cleanupRows = await db
      .insert(fileCleanups)
      .values(
        rows.map((r) => ({
          orgId,
          runId: r.file.runId,
          runFileId: r.file.id,
          agentId,
          machineId,
          path: r.file.path,
          status: "running",
          source: r.source,
          bytes: r.file.size,
          approvedByUserId: r.approver,
          executedAt: new Date(now),
        })),
      )
      .returning({ id: fileCleanups.id, runFileId: fileCleanups.runFileId });
    const rowOf = new Map(cleanupRows.map((c) => [c.runFileId, c.id]));
    let out: ScriptOutput | null = null;
    let why = "The computer's answer was unclear.";
    if (agent) {
      try {
        const reply = await deps.hub.call(machineId, {
          agent: { id: agent.id, handle: agent.handle, name: agent.name },
          op: "exec",
          command: cleanupCommand(
            rows.map((r) => ({
              path: r.file.path,
              size: r.file.size,
              sha256: r.file.sha256,
              notAfter: r.file.sealedAt ?? r.file.updatedAt,
            })),
            new Date(now),
            budget.bytes,
            { quiet: SETTLE_SECONDS, seconds: Math.max(5, budget.seconds * 3), lowPriority: true },
          ),
          timeoutSeconds: 60,
          stream: false,
          // The person who authorized this folder (or approved this file in review) approved it (ADR 0213).
          approved: true,
        });
        out = reply.exitCode === 0 ? parseCleanupOutput(reply.stdout) : null;
      } catch (error) {
        why = `The computer did not answer: ${error instanceof Error ? error.message : String(error)}`;
      }
    } else why = "The agent is gone.";
    const at = new Date();
    if (out) {
      cycle.freeBefore = cycle.freeBefore ?? out.freeBefore;
      cycle.freeAfter = out.freeAfter;
    }
    const byPath = new Map((out?.results ?? []).map((x) => [x.path, x]));
    for (const r of rows) {
      const x = byPath.get(r.file.path);
      const id = rowOf.get(r.file.id);
      const status = !out ? "unknown" : x?.status === "later" ? "later" : (x?.status ?? "unknown");
      if (id)
        await db
          .update(fileCleanups)
          .set({
            status: status === "later" ? "skipped" : status,
            reason: status === "later" ? "over this cycle's budget; next cycle" : (x?.reason ?? (out ? null : why)),
            identity: x?.identity ?? null,
            ...(x?.bytes !== undefined ? { bytes: x.bytes } : {}),
            freeBefore: out?.freeBefore ?? null,
            freeAfter: out?.freeAfter ?? null,
            executedAt: at,
          })
          .where(eq(fileCleanups.id, id));
      const note = receipts.get(r.file.runId) ?? [];
      if (status === "done" || status === "skipped") {
        await transition(db, r.file, "deleted", "collector", status === "done" ? "removed" : "already_gone", {
          reservedToken: null,
        });
        if (status === "done") {
          cycle.removed++;
          cycle.logicalBytes += r.file.size ?? 0;
          cycle.allocatedBytes += x?.bytes ?? 0;
        }
        note.push(`${r.file.path} ${status === "done" ? "removed" : "already gone"}`);
      } else if (status === "later") {
        await transition(db, r.file, "released", "collector", "over_budget", { reservedToken: null });
      } else if (status === "blocked") {
        cycle.blocked++;
        await transition(db, r.file, "review", "collector", "computer_refused", { reservedToken: null });
        await db
          .insert(storageReviewItems)
          .values({ orgId, runFileId: r.file.id, code: "computer_refused", reason: x?.reason ?? "refused" })
          .onConflictDoUpdate({
            target: storageReviewItems.runFileId,
            set: { code: "computer_refused", reason: x?.reason ?? "refused", status: "open" },
          });
        note.push(`${r.file.path} kept (${x?.reason ?? "refused"})`);
      } else {
        // Unknown: stays reserved; once the claim is stale the computer is asked again (never assumed removed).
        cycle.unknown++;
        note.push(`${r.file.path} unknown (${why})`);
      }
      receipts.set(r.file.runId, note);
    }
  }
  await postReceipts(db, orgId, receipts, cycle);
  return cycle;
}

/** One quiet line per run in the agent's own conversation (§15): never wakes it, never news to people. */
async function postReceipts(db: Database, orgId: string, receipts: Map<string, string[]>, cycle: GcCycle) {
  if (receipts.size === 0) return;
  const runs = await db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.orgId, orgId), inArray(agentRuns.id, [...receipts.keys()])));
  const delta =
    cycle.freeBefore !== null && cycle.freeAfter !== null
      ? `free space ${cycle.freeAfter - cycle.freeBefore >= 0 ? "+" : ""}${cycle.freeAfter - cycle.freeBefore} B (whole disk, all processes)`
      : "free space unmeasured";
  for (const run of runs) {
    const lines = receipts.get(run.id) ?? [];
    const text = `🧹 ${lines.length} file(s): ${lines.slice(0, 5).join("; ")}${lines.length > 5 ? `; +${lines.length - 5} more` : ""}. Cycle: ${cycle.removed} removed, logical ${cycle.logicalBytes} B, allocated ${cycle.allocatedBytes} B; ${delta}.`;
    await deliverNotice(db, {
      orgId,
      agentId: run.agentId,
      channelId: run.channelId,
      threadId: run.threadRootId,
      hop: run.hop,
      stretchId: run.stretchId,
      notice: { kind: "cleanup_receipt", text, refs: { runId: run.id } },
      wake: false,
    });
  }
}

// ---- People: switch, folders, review and the dashboard ----

/** The kill switch and the performance hold (§12, §17); `configure` only. */
export async function setStorageGc(
  db: Database,
  userId: string,
  orgId: string,
  input: { enabled?: boolean; modeOverride?: "performance" | null },
) {
  await requirePermission(db, userId, orgId, "configure");
  const current = await settingsOf(db, orgId);
  const next = {
    enabled: input.enabled ?? current.enabled,
    modeOverride: input.modeOverride === undefined ? current.modeOverride : input.modeOverride,
  };
  await db
    .insert(storageGcSettings)
    .values({ orgId, ...next, updatedByUserId: userId })
    .onConflictDoUpdate({
      target: storageGcSettings.orgId,
      set: { ...next, updatedByUserId: userId, updatedAt: new Date() },
    });
  return next;
}

/** A folder where scratch may be removed without per-file approval; starts in `shadow` unless said otherwise. */
export async function setStorageScope(
  db: Database,
  userId: string,
  orgId: string,
  input: { machineId: string; root: string; mode?: "shadow" | "enforce" },
) {
  await requirePermission(db, userId, orgId, "configure");
  const root = `${cleanRunPath(input.root.replace(/\/+$/, ""))}/`;
  const refused = protectedPath(`${root}x.tmp`);
  if (refused) throw new ValidationError(`That folder can't be authorized: ${refused}.`);
  const [machine] = await db
    .select({ id: machines.id })
    .from(machines)
    .where(and(eq(machines.orgId, orgId), eq(machines.id, input.machineId)));
  if (!machine) throw new ValidationError("No such computer.");
  const [row] = await db
    .insert(storageScopes)
    .values({ orgId, machineId: input.machineId, root, mode: input.mode ?? "shadow", createdByUserId: userId })
    .onConflictDoUpdate({
      target: [storageScopes.orgId, storageScopes.machineId, storageScopes.root],
      set: { mode: input.mode ?? "shadow", createdByUserId: userId },
    })
    .returning();
  return row;
}

export async function removeStorageScope(db: Database, userId: string, orgId: string, scopeId: string) {
  await requirePermission(db, userId, orgId, "configure");
  await db.delete(storageScopes).where(and(eq(storageScopes.orgId, orgId), eq(storageScopes.id, scopeId)));
}

export type ReviewAction = "keep" | "protect" | "archive" | "delete" | "restore";

/**
 * A person's decision on review items (§10), one or many. `delete` approves removal: the collector still checks the
 * file again on the computer and refuses a protected path, a deliverable or evidence. `restore` undoes a decision
 * on a file that is still there; a removed file's bytes come back only from a copy (the Drive), never from here.
 */
export async function decideStorageReview(
  db: Database,
  userId: string,
  orgId: string,
  itemIds: string[],
  action: ReviewAction,
) {
  await requirePermission(db, userId, orgId, "configure");
  if (itemIds.length === 0 || itemIds.length > 500) throw new ValidationError("Choose 1 to 500 items.");
  const items = await db
    .select()
    .from(storageReviewItems)
    .where(and(eq(storageReviewItems.orgId, orgId), inArray(storageReviewItems.id, itemIds)));
  const status = { keep: "kept", protect: "protected", archive: "archive", delete: "delete", restore: "restored" }[
    action
  ] as "kept" | "protected" | "archive" | "delete" | "restored";
  const results: { id: string; ok: boolean; note?: string }[] = [];
  const machinesToRun = new Set<string>();
  for (const item of items) {
    const [file] = await db.select().from(runFiles).where(eq(runFiles.id, item.runFileId));
    if (!file) continue;
    if (file.state === "deleted" && action !== "keep") {
      results.push({ id: item.id, ok: false, note: "already removed: restore it from its Drive copy" });
      continue;
    }
    await db
      .update(storageReviewItems)
      .set({
        status,
        decidedByUserId: userId,
        decidedAt: new Date(),
        history: sql`${storageReviewItems.history} || ${JSON.stringify([
          { at: new Date().toISOString(), by: userId, action },
        ])}::jsonb`,
      })
      .where(eq(storageReviewItems.id, item.id));
    const actor = `person:${userId}`;
    if (action === "protect") await transition(db, file, "protected", actor, "person_protected");
    else if (action === "keep") await transition(db, file, "kept", actor, "person_kept");
    else if (action === "archive") await transition(db, file, "kept", actor, "person_archive_requested");
    else if (action === "restore") await transition(db, file, "sealed", actor, "person_restored");
    else if (action === "delete" && file.machineId) machinesToRun.add(file.machineId);
    results.push({ id: item.id, ok: true });
  }
  for (const m of machinesToRun) await scheduleGc(db, orgId, m);
  return { results };
}

/** The review queue with each file's facts and history (§10). */
export async function storageReview(db: Database, userId: string, orgId: string, limit = 200) {
  await requirePermission(db, userId, orgId, "configure");
  const rows = await db
    .select({ item: storageReviewItems, file: runFiles })
    .from(storageReviewItems)
    .innerJoin(runFiles, eq(runFiles.id, storageReviewItems.runFileId))
    .where(eq(storageReviewItems.orgId, orgId))
    .orderBy(desc(storageReviewItems.createdAt))
    .limit(limit);
  return rows.map(({ item, file }) => ({
    id: item.id,
    status: item.status,
    code: item.code,
    reason: item.reason,
    history: item.history,
    createdAt: item.createdAt.toISOString(),
    file: {
      id: file.id,
      path: file.path,
      kind: file.kind,
      role: file.role,
      state: file.state,
      size: file.size,
      sha256: file.sha256,
      agentId: file.agentId,
      machineId: file.machineId,
      capturedBy: file.capturedBy,
    },
  }));
}

/**
 * The dashboard's figures (§14), each from its own source and never added to another: `logicalBytes` (sizes the
 * agents registered for removed files), `allocatedBytes` (blocks the computer measured before removing them),
 * `unlinked` (files removed), `freeDelta` (each round's free space after minus before, counted once per round),
 * `shadowBytes` (what shadow mode would have removed), and counts of files relocated or archived.
 */
export async function storageGuardianView(db: Database, userId: string, orgId: string) {
  await requirePermission(db, userId, orgId, "configure");
  const settings = await settingsOf(db, orgId);
  const scopes = await db.select().from(storageScopes).where(eq(storageScopes.orgId, orgId));
  const computers = await db
    .select({ id: machines.id, name: machines.name, load: machines.load })
    .from(machines)
    .where(eq(machines.orgId, orgId));
  const states = await db
    .select({ state: runFiles.state, n: sql<number>`count(*)::int`, bytes: sql<number>`coalesce(sum(size),0)::float8` })
    .from(runFiles)
    .where(eq(runFiles.orgId, orgId))
    .groupBy(runFiles.state);
  const [removed] = await db
    .select({
      unlinked: sql<number>`count(*)::int`,
      allocated: sql<number>`coalesce(sum(${fileCleanups.bytes}),0)::float8`,
      logical: sql<number>`coalesce(sum(f.size),0)::float8`,
    })
    .from(fileCleanups)
    .leftJoin(sql`${runFiles} f`, sql`f.id = ${fileCleanups.runFileId}`)
    .where(and(eq(fileCleanups.orgId, orgId), eq(fileCleanups.status, "done"), eq(fileCleanups.shadow, false)));
  const rounds = (await db.execute(sql`
    select coalesce(sum(free_after - free_before), 0)::float8 as delta, count(*)::int as rounds from (
      select distinct machine_id, free_before, free_after, executed_at from ${fileCleanups}
      where org_id = ${orgId} and status = 'done' and shadow = false and free_before is not null and free_after is not null
    ) r`)) as unknown as { rows: { delta: number; rounds: number }[] };
  const [shadow] = await db
    .select({ n: sql<number>`count(*)::int`, bytes: sql<number>`coalesce(sum(${fileCleanups.bytes}),0)::float8` })
    .from(fileCleanups)
    .where(and(eq(fileCleanups.orgId, orgId), eq(fileCleanups.shadow, true)));
  const [openReview] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(storageReviewItems)
    .where(and(eq(storageReviewItems.orgId, orgId), eq(storageReviewItems.status, "open")));
  const recent = await db
    .select()
    .from(fileCleanups)
    .where(and(eq(fileCleanups.orgId, orgId), inArray(fileCleanups.source, ["auto", "review"])))
    .orderBy(desc(fileCleanups.executedAt))
    .limit(50);
  const count = (s: string) => states.find((x) => x.state === s)?.n ?? 0;
  const round = rounds.rows?.[0] ?? { delta: 0, rounds: 0 };
  return {
    enabled: settings.enabled,
    modeOverride: settings.modeOverride,
    computers: computers.map((m) => {
      const p = pressureOf(m.load);
      return { id: m.id, name: m.name, ...p, mode: gcMode(p.level, settings.modeOverride) };
    }),
    scopes: scopes.map((s) => ({ id: s.id, machineId: s.machineId, root: s.root, mode: s.mode })),
    states: Object.fromEntries(states.map((s) => [s.state, s.n])),
    figures: {
      unlinked: removed?.unlinked ?? 0,
      logicalBytes: removed?.logical ?? 0,
      allocatedBytes: removed?.allocated ?? 0,
      freeDeltaBytes: round.delta,
      measuredRounds: round.rounds,
      shadowFiles: shadow?.n ?? 0,
      shadowBytes: shadow?.bytes ?? 0,
      relocated: count("relocated"),
      archived: count("archived"),
      openReview: openReview?.n ?? 0,
    },
    recent: recent.map((c) => ({
      path: c.path,
      status: c.status,
      source: c.source,
      shadow: c.shadow,
      reason: c.reason,
      bytes: c.bytes,
      freeBefore: c.freeBefore,
      freeAfter: c.freeAfter,
      executedAt: c.executedAt?.toISOString() ?? null,
    })),
  };
}
