import { createHash } from "node:crypto";
import {
  type BlobStoreResolver,
  FOUNDRY_VERSION_FILE,
  type FoundryCapabilityExport,
  type FoundryCapabilitySyncPort,
} from "@agenteschat/adapters";
import { and, asc, type Database, type Executor, eq, isNull, schema } from "@agenteschat/db";
import { postAgentReport } from "./agent-report";
import { skillMarkdown } from "./exports";
import { enqueue, PermanentJobError } from "./outbox";
import { skillFolderFiles } from "./skills";

/** SF-19 for native skills: a version an agent made or changed is saved to the skills repository, and a person told. */
export const SKILL_SYNC_JOB = "skill.sync";

const { skillSyncs, skills, agents, organizationMembers } = schema;
type Via = "update_skill" | "proposal" | "promotion";
const UNCONFIGURED = "No skills repository is connected to this server.";
const oneLine = (text: string, max: number) => text.replace(/\s+/g, " ").trim().slice(0, max);
const VIA_WHY: Record<Via, string> = {
  update_skill: "it changed the skill while using it",
  proposal: "a person accepted its proposed change",
  promotion: "it learned the same how-to often enough to make it a skill",
};

/**
 * In the transaction that writes the version: one row and one job, never more for the same version. A version
 * published from a private DM (ADR 0191) is recorded as private: it is never copied out, only reported.
 */
export async function queueSkillSync(
  tx: Executor,
  input: {
    orgId: string;
    skillId: string;
    version: number;
    agentId: string | null;
    notifyUserId: string | null;
    via: Via;
    private?: boolean;
  },
) {
  const [row] = await tx
    .insert(skillSyncs)
    .values({
      orgId: input.orgId,
      skillId: input.skillId,
      version: input.version,
      agentId: input.agentId,
      notifyUserId: input.notifyUserId,
      via: input.via,
      private: input.private ?? false,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) return;
  await enqueue(tx, {
    orgId: input.orgId,
    kind: SKILL_SYNC_JOB,
    payload: { syncId: row.id },
    dedupeKey: `skill.sync:${row.id}`,
  });
}

export function createSkillSync(deps: {
  db: Database;
  blobs?: BlobStoreResolver;
  capabilitySync?: FoundryCapabilitySyncPort;
  now?: () => Date;
}) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  async function exported(
    skill: typeof skills.$inferSelect,
    agent: typeof agents.$inferSelect | null,
    via: Via,
  ): Promise<FoundryCapabilityExport> {
    const files = deps.blobs ? await skillFolderFiles({ db, blobs: deps.blobs }, skill) : [];
    const markdown = skillMarkdown(skill);
    const hash = createHash("sha256");
    hash.update(`${skill.id}\n${skill.version}\n${markdown}`);
    for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path)))
      hash.update(`\n${f.path}\n`).update(f.data);
    const digest = hash.digest("hex");
    const marker = { digest, skillId: skill.id, version: skill.version, via };
    return {
      digest,
      name: skill.slug,
      kind: "skill",
      agent: oneLine(agent ? (agent.role ? `${agent.name} | ${agent.role}` : agent.name) : "an agent", 200),
      why: oneLine(`${skill.description} (${VIA_WHY[via]})`, 500),
      use: oneLine(`Agents load it with load_skill when a task matches: ${skill.description}`, 1000),
      files: [
        ...files
          .filter((f) => f.path !== "SKILL.md" && f.path !== FOUNDRY_VERSION_FILE)
          .map((f) => ({ path: f.path, base64: Buffer.from(f.data).toString("base64") })),
        { path: "SKILL.md", base64: Buffer.from(markdown, "utf8").toString("base64") },
        { path: FOUNDRY_VERSION_FILE, base64: Buffer.from(`${JSON.stringify(marker, null, 2)}\n`).toString("base64") },
      ],
    };
  }

  async function settle(id: string, state: string, detail: { commit?: string; reason?: string } = {}) {
    await db
      .update(skillSyncs)
      .set({ state, commit: detail.commit ?? null, reason: detail.reason ?? null })
      .where(and(eq(skillSyncs.id, id), isNull(skillSyncs.reportedAt)));
  }

  async function recipient(row: typeof skillSyncs.$inferSelect, agent: typeof agents.$inferSelect | null) {
    if (row.notifyUserId) return row.notifyUserId;
    if (agent?.ownerUserId) return agent.ownerUserId;
    const [owner] = await db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, row.orgId), eq(organizationMembers.role, "owner")))
      .orderBy(asc(organizationMembers.createdAt))
      .limit(1);
    return owner?.userId ?? null;
  }

  /** Once, in one transaction with its claim. A version with no agent or nobody to tell is closed unreported. */
  async function report(
    row: typeof skillSyncs.$inferSelect,
    skill: typeof skills.$inferSelect,
    agent: typeof agents.$inferSelect | null,
    capability: Pick<FoundryCapabilityExport, "agent" | "why" | "use">,
    url: string | null,
  ) {
    const to = await recipient(row, agent);
    await db.transaction(async (tx) => {
      const [claimed] = await tx
        .update(skillSyncs)
        .set({ reportedAt: now() })
        .where(and(eq(skillSyncs.id, row.id), isNull(skillSyncs.reportedAt)))
        .returning();
      if (!claimed || !agent || !to) return;
      const path = `skills/${skill.slug}`;
      const where =
        claimed.state === "SYNCED" && claimed.commit
          ? `In the skills repository: ${url ? `${url}/tree/main/${path}` : path} (commit ${claimed.commit.slice(0, 12)})`
          : claimed.state === "PRIVATE"
            ? "Not copied to the skills repository: it came from a private conversation, so it stays in this workspace's skill library only."
            : claimed.state === "REFUSED"
              ? `Not saved to the skills repository: ${claimed.reason}. It is still in use.`
              : `Could not save it to the skills repository: ${claimed.reason}. It is still in use.`;
      await postAgentReport(tx, {
        orgId: row.orgId,
        agentId: agent.id,
        userId: to,
        body: [
          `Skill ${row.via === "promotion" ? "created" : "updated"}: ${skill.name} (version ${row.version})`,
          `Made by: ${capability.agent}`,
          `Why: ${capability.why}`,
          `How it will be used from now on: ${capability.use}`,
          where,
        ].join("\n"),
        meta: { skillSync: { syncId: row.id, skillId: skill.id, version: row.version, state: claimed.state } },
      });
    });
  }

  return {
    /** Native outbox handler. A throw retries; the remote is always read before any second sync. */
    async run(orgId: string, payload: Record<string, unknown>, options: { finalAttempt: boolean }) {
      const id = payload.syncId;
      if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id))
        throw new PermanentJobError("Invalid skill sync reference");
      const [row] = await db
        .select()
        .from(skillSyncs)
        .where(and(eq(skillSyncs.orgId, orgId), eq(skillSyncs.id, id)));
      if (!row || row.reportedAt) return;
      const [skill] = await db
        .select()
        .from(skills)
        .where(and(eq(skills.orgId, orgId), eq(skills.id, row.skillId)));
      const [agent] = row.agentId ? await db.select().from(agents).where(eq(agents.id, row.agentId)) : [];
      // Gone, or a newer version came first: that version's own job saves and reports it.
      if (!skill || skill.deletedAt || skill.version !== row.version) {
        await settle(row.id, "SUPERSEDED");
        await db.update(skillSyncs).set({ reportedAt: now() }).where(eq(skillSyncs.id, row.id));
        return;
      }
      const capability = await exported(skill, agent ?? null, row.via as Via);
      let url: string | null = null;
      if (row.private) await settle(row.id, "PRIVATE");
      else if (!["SYNCED", "REFUSED", "FAILED"].includes(row.state)) {
        const port = deps.capabilitySync;
        if (!port) await settle(row.id, "FAILED", { reason: UNCONFIGURED });
        else {
          try {
            const found = await port.lookup(capability);
            const result = found ? ({ state: "SYNCED", ...found } as const) : await port.sync(capability);
            if (result.state === "SYNCED") {
              url = result.url;
              await settle(row.id, "SYNCED", { commit: result.commit });
            } else await settle(row.id, "REFUSED", { reason: oneLine(result.reason, 500) });
          } catch (error) {
            if (!options.finalAttempt) {
              await settle(row.id, "UNKNOWN");
              throw error;
            }
            await settle(row.id, "FAILED", { reason: "the push did not finish and was not found on GitHub" });
          }
        }
      }
      const [current] = await db.select().from(skillSyncs).where(eq(skillSyncs.id, row.id));
      await report(current ?? row, skill, agent ?? null, capability, url);
    },
  };
}
