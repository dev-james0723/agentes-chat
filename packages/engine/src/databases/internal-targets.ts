import { isIP } from "node:net";
import { type DatabaseClient, DatabaseError } from "@agenteschat/adapters";
import { parse } from "libpg-query";
import type { ResolveHost } from "../net-guard";

/** A deliberately small, operator-provisioned view contract; never raw application tables. */
export const INTERNAL_DATABASE_VIEWS = [
  "engineering_ro.agent_inventory",
  "engineering_ro.issue_status_counts",
  "engineering_ro.run_status_counts",
] as const;

export interface InternalDatabaseTarget {
  orgId: string;
  host: string;
  port: number;
  database: string;
  username: string;
  addresses: readonly string[];
  /** Explicit operator consent to plaintext on an isolated local network; no automatic TLS downgrade. */
  transport: "isolated_local_plaintext";
}
export interface InternalDatabaseSettings {
  orgId: string;
  host: string;
  port: number;
  database: string;
  username: string;
  sslmode: string;
  wholeServer?: boolean;
}

function canonicalPrivateAddress(raw: string): string | null {
  const ip = raw.toLowerCase();
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || (a === 172 && b !== undefined && b >= 16 && b <= 31) || (a === 192 && b === 168) ? ip : null;
  }
  if (isIP(ip) !== 6) return null;
  const canonical = new URL(`http://[${ip}]`).hostname.slice(1, -1);
  // Only unique-local IPv6. Never loopback, mapped IPv4, link-local, metadata, multicast or public destinations.
  return /^(fc|fd)[0-9a-f]{2}:/.test(canonical) ? canonical : null;
}

/** Parse once at boot. An absent policy preserves the existing public-only connector exactly. */
export function parseInternalDatabaseTargets(
  raw: string,
  edition: string,
  openSignup: boolean,
): readonly InternalDatabaseTarget[] {
  const fail = () => {
    throw new Error(
      "Invalid DATABASE_INTERNAL_TARGETS: use one exact closed-selfhost target with pinned private addresses and explicit isolated_local_plaintext transport",
    );
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail();
  }
  if (!Array.isArray(parsed) || parsed.length > 1) return fail();
  if (parsed.length === 0) return [];
  if (edition !== "selfhost" || openSignup) return fail();
  const value: unknown = parsed[0];
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const v = value as Record<string, unknown>;
  const fields = new Set(["orgId", "host", "port", "database", "username", "addresses", "transport"]);
  if (Object.keys(v).some((k) => !fields.has(k))) return fail();
  const identifier = /^[a-z_][a-z0-9_]{0,62}$/;
  const host = typeof v.host === "string" ? v.host.toLowerCase() : "";
  if (
    typeof v.orgId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.orgId) ||
    !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(host) ||
    host.includes("..") ||
    !Number.isInteger(v.port) ||
    Number(v.port) < 1 ||
    Number(v.port) > 65535 ||
    typeof v.database !== "string" ||
    !identifier.test(v.database) ||
    typeof v.username !== "string" ||
    !identifier.test(v.username) ||
    ["postgres", "agentes"].includes(v.username) ||
    v.transport !== "isolated_local_plaintext" ||
    !Array.isArray(v.addresses) ||
    v.addresses.length < 1 ||
    v.addresses.length > 4
  )
    return fail();
  const addresses = v.addresses.map((ip) => (typeof ip === "string" ? canonicalPrivateAddress(ip) : null));
  if (addresses.some((ip) => !ip)) return fail();
  return Object.freeze([
    Object.freeze({
      orgId: v.orgId.toLowerCase(),
      host,
      port: Number(v.port),
      database: v.database,
      username: v.username,
      addresses: Object.freeze([...new Set(addresses as string[])]),
      transport: v.transport,
    }),
  ]);
}

export const isInternalDatabaseHost = (targets: readonly InternalDatabaseTarget[], host: string) =>
  targets.some((t) => t.host === host.toLowerCase());

export function internalDatabaseProfile(
  targets: readonly InternalDatabaseTarget[],
  s: InternalDatabaseSettings,
): InternalDatabaseTarget | null {
  return (
    targets.find(
      (t) =>
        t.orgId === s.orgId &&
        t.host === s.host.toLowerCase() &&
        t.port === s.port &&
        t.database === s.database &&
        t.username === s.username &&
        s.sslmode === "disable" &&
        !s.wholeServer,
    ) ?? null
  );
}

/** One checked resolution, and the socket uses this address instead of resolving again. */
export async function internalDatabaseAddress(
  targets: readonly InternalDatabaseTarget[],
  s: InternalDatabaseSettings,
  resolve: ResolveHost,
): Promise<string | null> {
  const profile = internalDatabaseProfile(targets, s);
  if (!profile) return null;
  let addresses: string[];
  try {
    addresses = isIP(s.host) ? [s.host] : await resolve(s.host);
  } catch {
    return null;
  }
  const checked = addresses.map(canonicalPrivateAddress);
  if (checked.length === 0 || checked.some((ip) => !ip || !profile.addresses.includes(ip))) return null;
  return checked[0] ?? null;
}

/** Checks actual privileges, not a reassuring role name. This runs only as the new dedicated reader. */
export const INTERNAL_READER_SQL = `select current_user::text = $1::text and current_database()::text = $3::text
 and exists (select 1 from pg_roles where rolname = current_user
   and not rolsuper and not rolcreatedb and not rolcreaterole and not rolreplication and not rolbypassrls and not rolinherit)
 and not exists (select 1 from pg_auth_members m join pg_roles r on r.oid = m.member where r.rolname = current_user)
 and not exists (select 1 from pg_namespace n where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
   and has_schema_privilege(n.oid, 'CREATE'))
 and not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where c.relkind in ('r','p','v','m','f') and n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
   and (has_table_privilege(c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     or has_any_column_privilege(c.oid, 'INSERT,UPDATE,REFERENCES')
     or ((has_table_privilege(c.oid, 'SELECT') or has_any_column_privilege(c.oid, 'SELECT'))
       and (c.relkind <> 'v' or not (n.nspname || '.' || c.relname = any($2::text[]))))))
 and (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where c.relkind = 'v' and n.nspname || '.' || c.relname = any($2::text[]) and has_table_privilege(c.oid, 'SELECT'))
   = cardinality($2::text[]) as permitted`;

/** Fixed semantic definitions, compared as PostgreSQL parse trees, with the configured org embedded. */
function expectedViewDefinitions(orgId: string): Record<string, string> {
  if (!/^[0-9a-f-]{36}$/i.test(orgId)) return {};
  const org = `'${orgId}'::uuid`;
  return {
    "engineering_ro.agent_inventory": `select id,name,handle,role,model,brain,brain_model from public.agents where org_id=${org} and deleted_at is null`,
    "engineering_ro.issue_status_counts": `select status,priority,count(*) as total from public.issues i where org_id=${org} and not restricted and (channel_id is null or exists (select 1 from public.channels c where c.id=i.channel_id and c.org_id=${org} and c.visibility='public' and c.kind='channel' and c.deleted_at is null)) group by status,priority`,
    "engineering_ro.run_status_counts": `select r.status,count(*) as total from public.agent_runs r join public.channels c on c.id=r.channel_id and c.org_id=r.org_id where r.org_id=${org} and c.visibility='public' and c.kind='channel' and c.deleted_at is null group by r.status`,
  };
}

function normalizedDefinition(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizedDefinition);
  if (!value || typeof value !== "object") return value;
  const node = value as Record<string, unknown>;
  const cast = node.TypeCast as Record<string, unknown> | undefined;
  if (cast && typeof cast === "object") {
    const type = cast.typeName as { names?: { String?: { sval?: string } }[] } | undefined;
    const name = (type?.names ?? []).map((n) => n.String?.sval ?? "").join(".");
    const arg = cast.arg as { A_Const?: { sval?: { sval?: string } } } | undefined;
    // The decompiler makes implicit text/enum coercions explicit. Do not erase arbitrary casts or functions.
    if (
      [
        "text",
        "pg_catalog.text",
        "channel_visibility",
        "public.channel_visibility",
        "channel_kind",
        "public.channel_kind",
      ].includes(name) &&
      typeof arg?.A_Const?.sval?.sval === "string"
    )
      return normalizedDefinition(cast.arg);
  }
  return Object.fromEntries(
    Object.keys(node)
      .filter((k) => !["location", "stmt_location", "stmt_len"].includes(k))
      .sort()
      .map((k) => [k, normalizedDefinition(node[k])]),
  );
}

const INTERNAL_VIEW_DEFINITIONS_SQL = `select n.nspname || '.' || c.relname,pg_get_viewdef(c.oid,true),
 coalesce(c.reloptions @> array['security_barrier=true'],false),
 not r.rolcanlogin and not r.rolsuper and not r.rolcreatedb and not r.rolcreaterole and not r.rolreplication and not r.rolbypassrls
 from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_roles r on r.oid=c.relowner
 where c.relkind='v' and n.nspname || '.' || c.relname = any($1::text[]) order by 1`;

export async function attestInternalDatabaseReader(
  client: DatabaseClient,
  profile: InternalDatabaseTarget,
): Promise<void> {
  const ok = await client.readOnly({ statementTimeoutMs: 10_000, searchPath: "pg_catalog" }, async (run) => {
    if (
      (await run(INTERNAL_READER_SQL, [profile.username, [...INTERNAL_DATABASE_VIEWS], profile.database]))
        .rows[0]?.[0] !== true
    )
      return false;
    const definitions = (await run(INTERNAL_VIEW_DEFINITIONS_SQL, [[...INTERNAL_DATABASE_VIEWS]])).rows;
    if (definitions.length !== INTERNAL_DATABASE_VIEWS.length) return false;
    const expected = expectedViewDefinitions(profile.orgId);
    for (const row of definitions) {
      const name = String(row[0]);
      const sql = row[1];
      if (!expected[name] || typeof sql !== "string" || sql.length > 20_000 || row[2] !== true || row[3] !== true)
        return false;
      try {
        if (
          JSON.stringify(normalizedDefinition(await parse(sql))) !==
          JSON.stringify(normalizedDefinition(await parse(expected[name])))
        )
          return false;
      } catch {
        return false;
      }
    }
    return true;
  });
  if (!ok)
    throw new DatabaseError(
      "The dedicated database reader does not match its approved read-only view profile.",
      "auth",
    );
}
