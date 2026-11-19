import { and, type Database, eq, isNotNull, schema, sql } from "@agenteschat/db";

type MachineLoadRecord = schema.MachineLoadRecord;

/**
 * How full a computer's disk is, as three levels (ADR 0200), from the free space its runner last measured
 * (`machines.load`, every 5 minutes):
 *
 * - `ok`: room enough.
 * - `low`: under 30 GB free, or 95% used. Captures still work, and their answer says space is short.
 * - `critical`: under 15 GB free, or 98% used. New screenshots and recordings are refused: they are optional,
 *   and a full disk stops every agent on the computer. Nothing is deleted to make room.
 *
 * A computer that never measured (an older runner, a reading over a day old) is `unknown`: captures go on as before.
 */
export type StoragePressure = "ok" | "low" | "critical" | "unknown";

export const PRESSURE = { lowGb: 30, lowUse: 0.95, criticalGb: 15, criticalUse: 0.98 } as const;
const STALE_MS = 24 * 60 * 60 * 1000;

export function pressureOf(
  load: Pick<MachineLoadRecord, "diskFreeGb" | "diskUse" | "at"> | null | undefined,
  now = Date.now(),
) {
  if (!load || typeof load.diskFreeGb !== "number" || typeof load.diskUse !== "number")
    return { level: "unknown" as StoragePressure, freeGb: null, use: null };
  const at = Date.parse(load.at);
  if (!Number.isFinite(at) || now - at > STALE_MS)
    return { level: "unknown" as StoragePressure, freeGb: null, use: null };
  const { diskFreeGb: freeGb, diskUse: use } = load;
  const level: StoragePressure =
    freeGb < PRESSURE.criticalGb || use >= PRESSURE.criticalUse
      ? "critical"
      : freeGb < PRESSURE.lowGb || use >= PRESSURE.lowUse
        ? "low"
        : "ok";
  return { level, freeGb, use };
}

/** A computer's level now, read from its row in this workspace. */
export async function machinePressure(db: Database, orgId: string, machineId: string | null | undefined) {
  if (!machineId) return pressureOf(null);
  const [row] = await db
    .select({ load: schema.machines.load })
    .from(schema.machines)
    .where(and(eq(schema.machines.orgId, orgId), eq(schema.machines.id, machineId)));
  return pressureOf(row?.load ?? null);
}

/** The words a capture gets back when it is refused or space is short; null when there is room. */
export function pressureLine(p: ReturnType<typeof pressureOf>, what: "screenshot" | "recording"): string | null {
  if (p.level === "critical")
    return `Not taken: the computer's disk is nearly full (${p.freeGb} GB free). A ${what} is optional: finish the work without it, or ask a person to make room.`;
  if (p.level === "low")
    return `Space is short on this computer (${p.freeGb} GB free): take only the ${what}s the work needs.`;
  return null;
}

/** Counts this run's captures so far, from what it registered (ADR 0200). */
export async function capturesInRun(db: Database, orgId: string, runId: string, kind: "image" | "video") {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.runFiles)
    .where(
      and(
        eq(schema.runFiles.orgId, orgId),
        eq(schema.runFiles.runId, runId),
        eq(schema.runFiles.kind, kind),
        isNotNull(schema.runFiles.capturedBy),
      ),
    );
  return row?.n ?? 0;
}

/** A run's screenshot budget (ADR 0200): enough for every check that matters, not a frame per step. */
export const MAX_SCREENSHOTS_PER_RUN = 60;

/**
 * Before a screenshot or recording: refused on a nearly full disk, or past the run's screenshot budget; otherwise
 * a warning line when space is short (null when there is room).
 */
export async function captureGate(
  db: Database,
  ctx: { orgId: string; runId?: string | null },
  machineId: string | null | undefined,
  what: "screenshot" | "recording",
): Promise<{ refused: string } | { warning: string | null }> {
  const pressure = await machinePressure(db, ctx.orgId, machineId);
  const line = pressureLine(pressure, what);
  if (pressure.level === "critical" && line) return { refused: line };
  if (what === "screenshot" && ctx.runId) {
    const taken = await capturesInRun(db, ctx.orgId, ctx.runId, "image");
    if (taken >= MAX_SCREENSHOTS_PER_RUN)
      return {
        refused: `Not taken: this work has ${taken} screenshots already. Keep the ones that prove a check; to know what a page or screen says, read it instead.`,
      };
  }
  return { warning: line };
}
