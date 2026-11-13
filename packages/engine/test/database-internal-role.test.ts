import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createFakeDatabaseDriver, DatabaseError, type DatabaseTarget } from "@agenteschat/adapters";
import { PGlite } from "@electric-sql/pglite";
import {
  createDatabaseConnection,
  createDatabaseToolSource,
  createLocalKeyWrapper,
  dropClient,
  setAgentDatabase,
  type ToolSource,
} from "../src";
import {
  attestInternalDatabaseReader,
  INTERNAL_DATABASE_VIEWS,
  type InternalDatabaseTarget,
} from "../src/databases/internal-targets";
import { type Fixture, SECRET, setup } from "./fixtures";
import { runContext } from "./mail-fixtures";

let pg: PGlite;
let fixture: Fixture | undefined;
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
  await pg?.close();
});
const org = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
async function prepared(orgId = org, enums = false, recovery = false) {
  pg = new PGlite();
  await pg.exec(`
 ${enums ? "create type channel_visibility as enum ('public','private'); create type channel_kind as enum ('channel','dm');" : ""}
 create table agents(id uuid,org_id uuid,name text,handle text,role text,model text,brain text,brain_model text,deleted_at timestamptz,instructions text);
 create table channels(id uuid,org_id uuid,visibility ${enums ? "channel_visibility" : "text"},kind ${enums ? "channel_kind" : "text"},deleted_at timestamptz);
 create table issues(org_id uuid,status text,priority text,restricted boolean,channel_id uuid,description text);
 create table agent_runs(org_id uuid,status text,channel_id uuid,transcript jsonb);
 create table accounts(password text); create table connector_connections(secret_ciphertext text);
 insert into accounts values('synthetic auth secret'); insert into connector_connections values('synthetic sealed credential');
 insert into agents values('${orgId}','${orgId}','Test','test','Test','test','model',null,null,'not readable'),('${other}','${other}','Other','other','Other','test','model',null,null,'not readable');
 insert into channels values('${orgId}','${orgId}','public','channel',null),('${other}','${orgId}','private','dm',null);
 insert into issues values('${orgId}','todo','normal',false,'${orgId}','private description'),('${orgId}','todo','normal',false,'${other}','private channel'),('${orgId}','todo','normal',true,null,'restricted'),('${other}','todo','normal',false,null,'other org');
 insert into agent_runs values('${orgId}','done','${orgId}','{}'),('${orgId}','done','${other}','{}'),('${other}','done','${other}','{}');`);
  const db = String((await pg.query<{ name: string }>("select current_database() as name")).rows[0]?.name);
  const template = readFileSync(
    new URL("../../../docs/operations/internal-database-metrics.sql", import.meta.url),
    "utf8",
  )
    .split("\n")
    .filter((l) => !l.startsWith("\\"))
    .join("\n")
    .replaceAll(":'organization_id'", `'${orgId}'`)
    .replaceAll(':"database_name"', `"${db}"`)
    .replaceAll(":'database_name'", `'${db}'`);
  if (recovery) {
    // Reconstruct only what --no-owner --no-privileges restores: views owned by the restore user, no roles/grants.
    await pg.exec(
      `create schema engineering_ro;${template.slice(template.indexOf("CREATE VIEW"), template.indexOf("ALTER VIEW"))}`,
    );
    const recovered = readFileSync(
      new URL("../../../docs/operations/recover-internal-database-metrics.sql", import.meta.url),
      "utf8",
    )
      .split("\n")
      .filter((line) => !line.startsWith("\\"))
      .join("\n")
      .replaceAll(":'organization_id'", `'${orgId}'`)
      .replaceAll(':"database_name"', `"${db}"`)
      .replaceAll(":'database_name'", `'${db}'`);
    await pg.exec(recovered);
  } else await pg.exec(template);
  await pg.exec("set role ac_engineering_reader");
  const profile: InternalDatabaseTarget = {
    orgId,
    host: "postgres",
    port: 5432,
    database: db,
    username: "ac_engineering_reader",
    addresses: ["172.18.0.2"],
    transport: "isolated_local_plaintext",
  };
  const client = await createFakeDatabaseDriver({ db: pg }).open({
    ...profile,
    password: "synthetic",
    address: "172.18.0.2",
    sslmode: "disable",
  });
  return { profile, client };
}
test("review template creates only org-filtered metrics views and a nonprivileged reader", async () => {
  const { profile, client } = await prepared();
  await attestInternalDatabaseReader(client, profile);
  expect((await pg.query("select handle from engineering_ro.agent_inventory")).rows).toEqual([{ handle: "test" }]);
  expect((await pg.query("select total from engineering_ro.issue_status_counts")).rows).toEqual([{ total: 1 }]);
  expect((await pg.query("select total from engineering_ro.run_status_counts")).rows).toEqual([{ total: 1 }]);
  for (const table of [
    "public.agents",
    "public.issues",
    "public.agent_runs",
    "public.accounts",
    "public.connector_connections",
  ])
    await expect(pg.query(`select * from ${table}`)).rejects.toThrow(/permission denied/);
  const attrs = await pg.query(
    "select rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolinherit from pg_roles where rolname=current_user",
  );
  expect(Object.values(attrs.rows[0] ?? {})).toEqual([false, false, false, false, false, false]);
  await pg.exec(
    "reset role; alter table agents add column future_secret text; create table future_credentials(token text); set role ac_engineering_reader",
  );
  expect(Object.keys((await pg.query("select * from engineering_ro.agent_inventory")).rows[0] ?? {})).not.toContain(
    "future_secret",
  );
  await expect(pg.query("select * from future_credentials")).rejects.toThrow(/permission denied/);
  await attestInternalDatabaseReader(client, profile);
  expect(INTERNAL_DATABASE_VIEWS).toHaveLength(3);
});
test("privilege drift and missing approved views fail role attestation", async () => {
  const { profile, client } = await prepared();
  await pg.exec("reset role; grant select on accounts to ac_engineering_reader; set role ac_engineering_reader");
  await expect(attestInternalDatabaseReader(client, profile)).rejects.toThrow("read-only view profile");
  await pg.exec(
    "reset role; revoke select on accounts from ac_engineering_reader; revoke select on engineering_ro.run_status_counts from ac_engineering_reader; set role ac_engineering_reader",
  );
  await expect(attestInternalDatabaseReader(client, profile)).rejects.toThrow("read-only view profile");
});
test("internal metrics attestation and column inspection work with scalar-only driver bindings", async () => {
  const f = await setup();
  fixture = f;
  const { profile } = await prepared(f.org.id);
  const bound: unknown[][] = [];
  const databases = createFakeDatabaseDriver({
    db: pg,
    answer: (_statement, params) => {
      if (params.some(Array.isArray)) throw new DatabaseError("Array parameter cannot be serialized", "query", "22P02");
      bound.push(params);
      return null;
    },
  });
  const result = await createDatabaseConnection(
    {
      db: f.db,
      keyWrappers: [createLocalKeyWrapper(SECRET)],
      databases,
      internalTargets: [profile],
      resolveHost: async () => ["172.18.0.2"],
    },
    f.owner.id,
    f.org.id,
    {
      label: "Scalar metrics",
      host: "postgres",
      port: 5432,
      database: profile.database,
      username: profile.username,
      password: "synthetic",
      sslmode: "disable",
    },
  );
  expect(result.ok).toBe(true);
  const introspection = bound.filter((params) => params.includes(INTERNAL_DATABASE_VIEWS[0]));
  expect(introspection).toHaveLength(3);
  expect(introspection.every((params) => params.every((value) => !Array.isArray(value)))).toBe(true);
});

test("real gateway connects only the pinned target and enforces views even with a broad agent policy", async () => {
  let actual: ToolSource | undefined;
  const f = await setup({
    toolSources: [{ name: "internal-database", tools: async (ctx) => (actual ? actual.tools(ctx) : []) }],
  });
  fixture = f;
  const tools = f.tools;
  if (!tools) throw new Error("Missing test gateway");
  const { profile } = await prepared(f.org.id);
  await pg.exec(`reset role;
    create function public."SUM"(text) returns text language sql security definer set search_path=pg_catalog as 'select password from public.accounts limit 1';
    create function public.sum(text) returns text language sql security definer set search_path=pg_catalog as 'select password from public.accounts limit 1';
    create schema "PG_CATALOG"; grant usage on schema "PG_CATALOG" to public;
    create function "PG_CATALOG".sum(text) returns text language sql security definer set search_path=pg_catalog as 'select password from public.accounts limit 1';
    set role ac_engineering_reader;`);
  expect((await pg.query(`select public."SUM"('x') as value`)).rows).toEqual([{ value: "synthetic auth secret" }]);
  const opened: DatabaseTarget[] = [];
  let addresses = ["172.18.0.2"];
  const deps = {
    db: f.db,
    keyWrappers: [createLocalKeyWrapper(SECRET)],
    databases: createFakeDatabaseDriver({ db: pg, opened }),
    internalTargets: [profile],
    resolveHost: async () => addresses,
  };
  actual = createDatabaseToolSource(deps);
  const result = await createDatabaseConnection(deps, f.owner.id, f.org.id, {
    label: "Metrics",
    host: "postgres",
    port: 5432,
    database: profile.database,
    username: profile.username,
    password: "synthetic",
    sslmode: "disable",
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.connection.canWrite).toBe(false);
  expect(JSON.stringify(result.connection)).not.toContain("public.accounts");
  expect(JSON.stringify(result.connection)).not.toContain("public.connector_connections");
  expect(opened[0]?.address).toBe("172.18.0.2");
  const ctx = await runContext(f);
  expect((await tools.list(ctx)).some((t) => t.name.startsWith("pg_"))).toBe(false);
  await setAgentDatabase(f.db, f.owner.id, f.org.id, f.agent.id, result.connection.id, {
    level: "read",
    policy: { tables: [], hiddenColumns: [], dailyQueryCap: null, timeoutSeconds: 60 },
  });
  const call = (sql: string) =>
    tools.invoke(ctx, { toolUseId: crypto.randomUUID(), name: "pg_metrics_query", input: { sql } });
  const good = await call("select handle from engineering_ro.agent_inventory");
  expect(good.type).toBe("result");
  if (good.type === "result") expect(good.output.content).toContain("test");
  for (const sql of [
    "select status,priority,total from engineering_ro.issue_status_counts order by total desc limit 10",
    "select status,total from engineering_ro.run_status_counts limit 10",
  ]) {
    const aggregate = await call(sql);
    expect(aggregate.type).toBe("result");
    if (aggregate.type === "result") expect(aggregate.output.isError).not.toBe(true);
  }

  for (const sql of [`select "SUM"('x')`, `select "PG_CATALOG".sum('x')`, "select sum('x')"]) {
    const unsafe = await call(sql);
    expect(JSON.stringify(unsafe)).not.toContain("synthetic auth secret");
    if (unsafe.type === "result") expect(unsafe.output.isError).toBe(true);
  }

  for (const sql of ["select * from accounts", "select * from pg_catalog.pg_class", "select pg_get_functiondef(1)"]) {
    const blocked = await call(sql);
    expect(blocked.type).not.toBe("approval");
    expect(JSON.stringify(blocked)).toContain("Not allowed");
  }
  const description = await tools.invoke(ctx, {
    toolUseId: crypto.randomUUID(),
    name: "pg_metrics_describe_table",
    input: { table: "public.accounts" },
  });
  expect(JSON.stringify(description)).toContain("Not allowed");
  const listed = await tools.invoke(ctx, {
    toolUseId: crypto.randomUUID(),
    name: "pg_metrics_list_tables",
    input: {},
  });
  expect(JSON.stringify(listed)).not.toContain("public.accounts");
  const query = (await tools.list(ctx)).find((t) => t.name === "pg_metrics_query");
  expect(query?.description).toContain("10 s");
  const attempts = opened.length;
  dropClient(result.connection.id);
  addresses = ["172.18.0.3"];
  const rebound = await call("select handle from engineering_ro.agent_inventory");
  expect(JSON.stringify(rebound)).toContain("not allowed");
  expect(opened).toHaveLength(attempts);
});

test("view attestation binds the exact org and filters, not just approved relation names", async () => {
  const { profile, client } = await prepared();
  await pg.exec(
    `reset role; create or replace view engineering_ro.agent_inventory with (security_barrier=true) as select id,name,handle,role,model,brain,brain_model from public.agents where org_id='${other}'::uuid and deleted_at is null; alter view engineering_ro.agent_inventory owner to ac_engineering_view_owner; set role ac_engineering_reader`,
  );
  await expect(attestInternalDatabaseReader(client, profile)).rejects.toThrow("view profile");
  await pg.exec(
    `reset role; create or replace view engineering_ro.agent_inventory with (security_barrier=true) as select id,name,handle,role,model,brain,brain_model from public.agents where org_id='${org}'::uuid or true; alter view engineering_ro.agent_inventory owner to ac_engineering_view_owner; set role ac_engineering_reader`,
  );
  await expect(attestInternalDatabaseReader(client, profile)).rejects.toThrow("view profile");
});
test("fixed view contract matches the application's enum-typed channel columns", async () => {
  const { profile, client } = await prepared(org, true);
  await attestInternalDatabaseReader(client, profile);
  expect((await pg.query("select total from engineering_ro.issue_status_counts")).rows).toEqual([{ total: 1 }]);
});

test("separate recovery script reuses restored views and reconstructs only restricted roles and grants", async () => {
  const { profile, client } = await prepared(org, true, true);
  await attestInternalDatabaseReader(client, profile);
  expect((await pg.query("select total from engineering_ro.issue_status_counts")).rows).toEqual([{ total: 1 }]);
  await expect(pg.query("select * from public.accounts")).rejects.toThrow(/permission denied/);
  const recovery = readFileSync(
    new URL("../../../docs/operations/recover-internal-database-metrics.sql", import.meta.url),
    "utf8",
  );
  expect(recovery).not.toMatch(/CREATE VIEW/i);
});
