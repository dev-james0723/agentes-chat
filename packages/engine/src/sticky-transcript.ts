import { type SQL, schema, sql } from "@agenteschat/db";
import { pgSafeStringify } from "./format";

/**
 * A persisted uncertainty marker cannot be silently replaced by an executor's stale transcript.
 * Clearing it requires a separate, authorized, versioned reconciliation protocol (not implemented here).
 * This protects this row only; it does not fence another run or external side effects.
 */
export function keepRunMarkers(proposed: Record<string, unknown> | SQL): SQL {
  const isSql = typeof (proposed as { getSQL?: unknown }).getSQL === "function";
  const value = isSql ? (proposed as SQL) : sql`${pgSafeStringify(proposed)}::jsonb`;
  const current = schema.agentRuns.transcript;
  return sql`((${value} - 'continuityCheckpoint' - 'effectUncertain') || jsonb_strip_nulls(jsonb_build_object(
    'continuityCheckpoint', coalesce(nullif(${current}->'continuityCheckpoint', 'null'::jsonb), nullif((${value})->'continuityCheckpoint', 'null'::jsonb)),
    'effectUncertain', coalesce(nullif(${current}->'effectUncertain', 'null'::jsonb), nullif((${value})->'effectUncertain', 'null'::jsonb))
  )))`;
}
