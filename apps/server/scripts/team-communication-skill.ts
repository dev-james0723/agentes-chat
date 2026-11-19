/**
 * Installs the team communication skill (ADR 0199) in one workspace, for the people who run the server: on for every
 * active agent and marked "default for new agents". Running it again changes nothing already there.
 *
 *   bun run skills:team-communication --org <workspace id> [--as <user id>]
 *
 * `--as`: who installs it (audited as them; they need to manage agents). An owner of the workspace by default.
 * In the server's container: `docker compose exec agentes bun run skills:team-communication --org <id>`.
 */
import { parseArgs } from "node:util";
import { loadConfig } from "@agenteschat/config";
import { and, createDatabase, eq, schema } from "@agenteschat/db";
import { installTeamCommunicationSkill } from "@agenteschat/engine";

const { values } = parseArgs({ options: { org: { type: "string" }, as: { type: "string" } } });
if (!values.org || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(values.org)) {
  console.error("--org takes a workspace's id");
  process.exit(2);
}
const orgId = values.org;

const config = loadConfig();
const database = createDatabase({ url: config.DATABASE_URL, poolMax: 1 });
try {
  const { db } = database;
  let actorId = values.as;
  if (!actorId) {
    const [owner] = await db
      .select({ userId: schema.organizationMembers.userId })
      .from(schema.organizationMembers)
      .where(and(eq(schema.organizationMembers.orgId, orgId), eq(schema.organizationMembers.role, "owner")))
      .limit(1);
    if (!owner) {
      console.error("No owner found for that workspace: pass --as <user id>");
      process.exit(2);
    }
    actorId = owner.userId;
  }
  const out = await installTeamCommunicationSkill({ db }, actorId, orgId);
  console.log(
    `${out.installed ? "Installed" : "Already installed"} (skill ${out.skillId}); turned on for ${out.enabledFor.length} agent(s).`,
  );
} finally {
  await database.close();
}
