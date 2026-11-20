import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const migrations = join(import.meta.dir, "../migrations");
function migration(name: string): string {
  const file = readdirSync(migrations).find((entry) => entry.endsWith(`_${name}.sql`));
  if (!file) throw new Error(`Missing migration: ${name}`);
  return readFileSync(join(migrations, file), "utf8");
}

test("personal own-brain migration preserves named routes and enforces scoped own routes", async () => {
  const client = new PGlite();
  const org = "00000000-0000-4000-8000-000000000001";
  const otherOrg = "00000000-0000-4000-8000-000000000002";
  const accountMachine = "00000000-0000-4000-8000-000000000101";
  const ownMachine = "00000000-0000-4000-8000-000000000102";
  const foreignMachine = "00000000-0000-4000-8000-000000000103";
  const account = "00000000-0000-4000-8000-000000000201";
  try {
    // The original migration is applied first, with a real legacy row present during the upgrade.
    await client.exec(`
      CREATE TABLE organizations (id uuid PRIMARY KEY);
      CREATE TABLE users (id text PRIMARY KEY);
      CREATE TABLE organization_members (org_id uuid, user_id text, PRIMARY KEY (org_id, user_id));
      CREATE TABLE machines (id uuid PRIMARY KEY, org_id uuid NOT NULL, UNIQUE (org_id, id));
      CREATE TABLE machine_accounts (
        id uuid PRIMARY KEY, org_id uuid NOT NULL, machine_id uuid NOT NULL, UNIQUE (org_id, id),
        FOREIGN KEY (org_id, machine_id) REFERENCES machines (org_id, id) ON DELETE CASCADE
      );
      INSERT INTO organizations VALUES ('${org}'), ('${otherOrg}');
      INSERT INTO users VALUES ('legacy'), ('old-writer'), ('own'), ('invalid');
      INSERT INTO organization_members VALUES
        ('${org}', 'legacy'), ('${org}', 'old-writer'), ('${org}', 'own'), ('${org}', 'invalid');
      INSERT INTO machines VALUES
        ('${accountMachine}', '${org}'), ('${ownMachine}', '${org}'), ('${foreignMachine}', '${otherOrg}');
      INSERT INTO machine_accounts VALUES ('${account}', '${org}', '${accountMachine}');
    `);
    await client.exec(migration("right_hand_brains"));
    await client.query(
      "INSERT INTO right_hand_brains (org_id, user_id, brain, brain_model, brain_account_id, brain_effort) VALUES ($1, 'legacy', 'grok', 'auto', $2, 'medium')",
      [org, account],
    );
    const before = (
      await client.query<Record<string, unknown>>("SELECT * FROM right_hand_brains WHERE user_id = 'legacy'")
    ).rows[0];
    expect(before).toBeDefined();

    await client.exec(migration("right_hand_own_brains"));
    const after = (await client.query("SELECT * FROM right_hand_brains WHERE user_id = 'legacy'")).rows[0];
    expect(after).toEqual({ ...before, machine_id: null });

    // The previous writer still supplies a named account and does not know the added column.
    await client.query(
      "INSERT INTO right_hand_brains (org_id, user_id, brain, brain_account_id) VALUES ($1, 'old-writer', 'grok', $2)",
      [org, account],
    );
    expect(
      (await client.query("SELECT brain_account_id, machine_id FROM right_hand_brains WHERE user_id = 'old-writer'"))
        .rows,
    ).toEqual([{ brain_account_id: account, machine_id: null }]);

    await client.query(
      "INSERT INTO right_hand_brains (org_id, user_id, brain, brain_account_id, machine_id) VALUES ($1, 'own', 'codex', NULL, $2)",
      [org, ownMachine],
    );
    expect(
      (await client.query("SELECT brain_account_id, machine_id FROM right_hand_brains WHERE user_id = 'own'")).rows,
    ).toEqual([{ brain_account_id: null, machine_id: ownMachine }]);

    await expect(
      client.query("INSERT INTO right_hand_brains (org_id, user_id, brain) VALUES ($1, 'invalid', 'codex')", [org]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      client.query(
        "INSERT INTO right_hand_brains (org_id, user_id, brain, machine_id) VALUES ($1, 'invalid', 'codex', $2)",
        [org, foreignMachine],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      client.query(
        "INSERT INTO right_hand_brains (org_id, user_id, brain, machine_id) VALUES ($1, 'invalid', 'codex', $2)",
        [org, "00000000-0000-4000-8000-000000000999"],
      ),
    ).rejects.toMatchObject({ code: "23503" });

    await client.query("DELETE FROM machines WHERE id = $1", [ownMachine]);
    expect((await client.query("SELECT user_id FROM right_hand_brains ORDER BY user_id")).rows).toEqual([
      { user_id: "legacy" },
      { user_id: "old-writer" },
    ]);
  } finally {
    await client.close();
  }
}, 30_000);
