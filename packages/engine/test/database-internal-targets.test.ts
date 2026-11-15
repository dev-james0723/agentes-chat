import { expect, test } from "bun:test";
import { guardSql } from "../src/databases/guard";
import {
  INTERNAL_DATABASE_VIEWS,
  internalDatabaseAddress,
  parseInternalDatabaseTargets,
} from "../src/databases/internal-targets";

const orgId = "11111111-1111-4111-8111-111111111111";
const policy = {
  orgId,
  host: "postgres",
  port: 5432,
  database: "agentes",
  username: "ac_engineering_reader",
  addresses: ["172.18.0.2"],
  transport: "isolated_local_plaintext",
};
const settings = {
  orgId,
  host: "postgres",
  port: 5432,
  database: "agentes",
  username: "ac_engineering_reader",
  sslmode: "disable",
  wholeServer: false,
};
const targets = () => parseInternalDatabaseTargets(JSON.stringify([policy]), "selfhost", false);
test("operator profile is default-off and only explicit closed selfhost policy enables it", () => {
  expect(parseInternalDatabaseTargets("[]", "cloud", true)).toEqual([]);
  expect(targets()).toHaveLength(1);
  for (const [edition, open] of [
    ["cloud", false],
    ["selfhost", true],
  ] as const)
    expect(() => parseInternalDatabaseTargets(JSON.stringify([policy]), edition, open)).toThrow();
  for (const change of [
    { addresses: [] },
    { addresses: ["169.254.169.254"] },
    { addresses: ["127.0.0.1"] },
    { addresses: ["0.0.0.0/0"] },
    { host: "*.internal" },
    { username: "agentes" },
    { transport: undefined },
    { password: "must-not-accept" },
  ])
    expect(() => parseInternalDatabaseTargets(JSON.stringify([{ ...policy, ...change }]), "selfhost", false)).toThrow();
});
test("only the exact org/host/port/database/reader and explicit plaintext mode match", async () => {
  expect(await internalDatabaseAddress(targets(), settings, async () => ["172.18.0.2"])).toBe("172.18.0.2");
  for (const change of [
    { orgId: "22222222-2222-4222-8222-222222222222" },
    { host: "other" },
    { port: 5433 },
    { database: "other" },
    { username: "postgres" },
    { wholeServer: true },
    { sslmode: "require" },
  ])
    expect(await internalDatabaseAddress(targets(), { ...settings, ...change }, async () => ["172.18.0.2"])).toBeNull();
});
test("all DNS answers must be pinned and each new lookup is checked, with canonical IPv6 support", async () => {
  expect(await internalDatabaseAddress(targets(), settings, async () => ["172.18.0.2", "169.254.169.254"])).toBeNull();
  expect(await internalDatabaseAddress(targets(), settings, async () => ["172.18.0.3"])).toBeNull();
  expect(await internalDatabaseAddress(targets(), settings, async () => [])).toBeNull();
  const ipv6 = parseInternalDatabaseTargets(
    JSON.stringify([{ ...policy, addresses: ["fd00:0:0:0:0:0:0:2"] }]),
    "selfhost",
    false,
  );
  expect(await internalDatabaseAddress(ipv6, settings, async () => ["fd00::2"])).toBe("fd00::2");
});
test("internal SQL reads only approved views; catalogs, introspection and user functions cannot escape", async () => {
  const options = { internalViews: INTERNAL_DATABASE_VIEWS };
  const rules = { tables: [], hiddenColumns: [] };
  for (const sql of [
    "select id,name,handle from engineering_ro.agent_inventory",
    "select status,priority,total from engineering_ro.issue_status_counts where priority >= 1 and status <> 'done' order by total desc limit 20",
    "select status,total,1 as literal from engineering_ro.run_status_counts where status = 'running' or status is null limit 1000",
  ])
    expect((await guardSql(sql, rules, options)).ok).toBe(true);
  for (const sql of [
    "select * from public.accounts",
    "select count(*) from engineering_ro.agent_inventory",
    "select current_user,current_database(),current_setting('transaction_read_only')",
    "select name OPERATOR(public.===) ANY (select name from engineering_ro.agent_inventory) from engineering_ro.agent_inventory",
    "select name from engineering_ro.agent_inventory order by name using operator(public.===)",
    "select count(name order by name using operator(public.===)) from engineering_ro.agent_inventory",
    "select name from engineering_ro.agent_inventory where name = any (select name from engineering_ro.agent_inventory)",
    "select name from engineering_ro.agent_inventory where name = all (select name from engineering_ro.agent_inventory)",
    "select * from engineering_ro.agent_inventory",
    "select a.name from engineering_ro.agent_inventory a",
    "select name from engineering_ro.agent_inventory,engineering_ro.agent_inventory b",
    "select name from engineering_ro.agent_inventory union select name from engineering_ro.agent_inventory",
    "select name::text from engineering_ro.agent_inventory",
    "select (select name from engineering_ro.agent_inventory) from engineering_ro.agent_inventory",
    "select name from engineering_ro.agent_inventory where name collate public.secret = 'x'",
    "select name from engineering_ro.agent_inventory where name operator(public.=) 'x'",
    "select name from engineering_ro.agent_inventory group by name",
    "select distinct name from engineering_ro.agent_inventory",
    "select name from engineering_ro.agent_inventory window w as ()",
    "select name from engineering_ro.agent_inventory tablesample system(1)",
    "select name from engineering_ro.agent_inventory order by lower(name)",
    "select name from engineering_ro.agent_inventory limit 1001",
    "select name from engineering_ro.agent_inventory limit -1",
    "select name from engineering_ro.agent_inventory limit all",
    "select name from engineering_ro.agent_inventory limit 1+1",
    "select name from engineering_ro.agent_inventory offset 1",
    "select name from engineering_ro.agent_inventory fetch first 1 row with ties",
    "select row(name) from engineering_ro.agent_inventory",
    "select array[name] from engineering_ro.agent_inventory",
    "select name[1] from engineering_ro.agent_inventory",
    "select case when true then name end from engineering_ro.agent_inventory",
    "select name from engineering_ro.agent_inventory where name in ('x','y')",
    "select name from engineering_ro.agent_inventory where name between 'a' and 'z'",
    "select * from pg_catalog.pg_class",
    "select * from information_schema.columns",
    "select pg_get_viewdef('engineering_ro.agent_inventory'::regclass)",
    "select public.leak_secret()",
    "select current_setting('app.secret')",
    'select "SUM"(1)',
    'select "PG_CATALOG".sum(1)',
    "explain (verbose,format json) select * from engineering_ro.agent_inventory",
    "with accounts as (select * from accounts) select * from accounts",
  ])
    expect((await guardSql(sql, rules, options)).ok).toBe(false);
  expect(
    (
      await guardSql(
        "select name from engineering_ro.agent_inventory",
        { tables: ["engineering_ro.issue_status_counts"], hiddenColumns: [] },
        options,
      )
    ).ok,
  ).toBe(false);
});
