import { and, type Database, eq, inArray, isNull, schema, sql } from "@agenteschat/db";
import { z } from "zod";
import { recordAudit } from "../audit";
import { sha256 } from "../crypto";
import { ConflictError, ValidationError } from "../errors";
import { requirePermission } from "../organizations";
import { readSelectedSkillPackage, SKILL_NAME, type SkillDeps, saveSkill, setAgentSkills } from "../skills";
import type { AppPrincipal } from "./grants";

const repoAtCommit =
  /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}\/tree\/[a-f0-9]{40}$/;
export const packageInstallInput = z
  .object({
    source_url: z
      .string()
      .regex(repoAtCommit)
      .refine((value) => {
        if (!URL.canParse(value)) return false;
        const url = new URL(value);
        return url.href === value && !url.pathname.split("/")[2]?.endsWith(".git");
      }, "Use a canonical GitHub repository tree URL pinned to a commit"),
    path: z
      .string()
      .max(300)
      .refine(
        (value) =>
          value === "" ||
          value
            .split("/")
            .every(
              (part) =>
                !!part &&
                part !== "." &&
                part !== ".." &&
                !part.includes("\\") &&
                Array.from(part).every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127),
            ),
        "Use the selected package folder relative to the repository root",
      ),
    expected_name: z.string().max(64).regex(SKILL_NAME),
    agent_ids: z
      .array(z.uuid())
      .min(1)
      .max(8)
      .refine((ids) => new Set(ids).size === ids.length),
    idempotency_key: z.string().min(1).max(64),
  })
  .strict();

type Request = z.infer<typeof packageInstallInput>;
const auditAction = "apps.skill_package_installed";

async function installedReceipt(db: Database, p: AppPrincipal, input: Request, agents: string[], digest: string) {
  const { auditLog, skills, agentSkills } = schema;
  const [old] = await db
    .select({ id: auditLog.targetId, details: auditLog.details })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.orgId, p.orgId),
        eq(auditLog.actorId, p.userId),
        eq(auditLog.action, auditAction),
        sql`${auditLog.details}->>'grantId' = ${p.grantId} AND ${auditLog.details}->>'key' = ${input.idempotency_key}`,
      ),
    )
    .limit(1);
  if (!old) return null;
  if (!old.id || old.details.digest !== digest)
    throw new ConflictError("Package install key belongs to another request.");
  const [skill] = await db
    .select({
      id: skills.id,
      name: skills.name,
      version: skills.version,
      sourceHash: skills.sourceHash,
      sourceUrl: skills.sourceUrl,
    })
    .from(skills)
    .where(and(eq(skills.orgId, p.orgId), eq(skills.id, old.id), eq(skills.source, "url"), isNull(skills.deletedAt)));
  const enabled = await db
    .select({ id: agentSkills.agentId })
    .from(agentSkills)
    .where(
      and(
        eq(agentSkills.orgId, p.orgId),
        eq(agentSkills.skillId, old.id),
        eq(agentSkills.enabled, true),
        inArray(agentSkills.agentId, agents),
      ),
    );
  if (
    !skill ||
    skill.name !== input.expected_name ||
    skill.version !== old.details.version ||
    !skill.sourceHash ||
    skill.sourceHash !== old.details.sourceHash ||
    skill.sourceUrl !== old.details.sourceUrl ||
    enabled.length !== agents.length
  )
    throw new ConflictError("Previously installed package or assignments changed. Read the current native records.");
  return {
    id: skill.id,
    name: skill.name,
    version: skill.version,
    source_url: input.source_url,
    path: input.path,
    source_hash: skill.sourceHash,
    agent_ids: agents,
    idempotency_key: input.idempotency_key,
    replayed: true,
  };
}

export async function installGithubSkill(deps: SkillDeps, p: AppPrincipal, input: Request, allow: () => Promise<void>) {
  const agents = [...input.agent_ids].sort();
  const digest = sha256(JSON.stringify([input.source_url, input.path, input.expected_name, agents]));
  const checkReplay = async (db: Database) => {
    await requirePermission(db, p.userId, p.orgId, "manage_agents");
    // Global uniqueness by grant/key, even for two requests naming different packages.
    await db.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([p.grantId, input.idempotency_key])}, 0))`,
    );
    await activeTargets(db, p, agents);
    return installedReceipt(db, p, input, agents, digest);
  };
  // Do no remote work for an exact retry; download outside the database transaction.
  const replay = await deps.db.transaction((tx) => checkReplay(tx as unknown as Database));
  if (replay) return replay;
  await allow();
  const parsed = await readSelectedSkillPackage(
    deps,
    p.userId,
    p.orgId,
    input.source_url,
    input.path,
    input.expected_name,
  );
  const location = await deps.blobs.forOrg(p.orgId);
  return deps.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    const race = await checkReplay(db);
    if (race) return race;
    // Resolving a workspace bucket can query the outer connection; the save itself writes on this transaction.
    const blobs = { forOrg: async () => location, forConfig: deps.blobs.forConfig.bind(deps.blobs) };
    const created = await saveSkill({ ...deps, db, blobs }, p.userId, p.orgId, {
      ...parsed,
      createOnly: true,
      requireAllFiles: true,
    });
    for (const agent of agents)
      await setAgentSkills(db, p.userId, p.orgId, agent, [{ skillId: created.id, enabled: true }]);
    await recordAudit(db, {
      orgId: p.orgId,
      actor: { type: "person", id: p.userId },
      action: auditAction,
      target: { type: "skill", id: created.id },
      details: {
        grantId: p.grantId,
        key: input.idempotency_key,
        digest,
        version: created.version,
        sourceHash: parsed.sourceHash,
        sourceUrl: parsed.sourceUrl,
        agentIds: agents,
      },
    });

    return {
      id: created.id,
      name: created.name,
      version: created.version,
      source_url: input.source_url,
      path: input.path,
      source_hash: parsed.sourceHash,
      agent_ids: agents,
      idempotency_key: input.idempotency_key,
      replayed: false,
    };
  });
}

async function activeTargets(db: Database, p: AppPrincipal, agents: string[]) {
  const members = await db
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, p.orgId), inArray(schema.agents.id, agents), isNull(schema.agents.archivedAt)))
    .orderBy(schema.agents.id)
    .for("share");
  if (members.length !== agents.length)
    throw new ValidationError("Every target must be an active agent of this workspace.");
}

export const version = z.number().int().positive().max(2147483647);
export const bodyDigest = z.string().regex(/^[a-f0-9]{64}$/);
export const assignmentInput = z
  .object({
    skill_id: z.uuid(),
    agent_ids: packageInstallInput.shape.agent_ids,
    expected_version: version,
    expected_body_sha256: bodyDigest,
  })
  .strict();
export async function assignSkill(db: Database, p: AppPrincipal, input: z.infer<typeof assignmentInput>) {
  const agents = [...input.agent_ids].sort();
  return db.transaction(async (tx) => {
    const d = tx as unknown as Database;
    await requirePermission(d, p.userId, p.orgId, "manage_agents");
    await activeTargets(d, p, agents);
    const { skills, agentSkills } = schema;
    const [s] = await d
      .select({ id: skills.id, name: skills.name, body: skills.body, version: skills.version })
      .from(skills)
      .where(and(eq(skills.id, input.skill_id), eq(skills.orgId, p.orgId), isNull(skills.deletedAt)))
      .for("update");
    if (!s || s.version !== input.expected_version || sha256(s.body) !== input.expected_body_sha256)
      throw new ConflictError("Skill identity, version or body changed.");
    const current = await d
      .select({ id: agentSkills.agentId, enabled: agentSkills.enabled })
      .from(agentSkills)
      .where(and(eq(agentSkills.orgId, p.orgId), eq(agentSkills.skillId, s.id), inArray(agentSkills.agentId, agents)))
      .for("update");
    const enabled = new Set(current.filter((row) => row.enabled).map((row) => row.id));
    for (const id of agents)
      if (!enabled.has(id)) await setAgentSkills(d, p.userId, p.orgId, id, [{ skillId: s.id, enabled: true }]);
    return { id: s.id, name: s.name, version: s.version, body_sha256: input.expected_body_sha256, agent_ids: agents };
  });
}
