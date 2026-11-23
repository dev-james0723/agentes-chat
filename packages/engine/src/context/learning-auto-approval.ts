import { and, type Database, eq, inArray, isNull, schema } from "@agenteschat/db";
import { recordAudit } from "../audit";
import type { Judge } from "../judge";
import { triesToChangePermissions } from "../judge";
import { requirePermission } from "../organizations";
import { type ContextItem, itemWords, looksLikeSecret } from "./items";

/**
 * Opt-in, fail-closed admission of one small agent-local learning instruction.
 * Neither an LLM-provided evidence label nor an arbitrary completed task is proof.
 * Nothing in this module grants a tool permission, scope, or an approval rule.
 */
const UNSAFE_EFFECT =
  /\b(?:sudo|chmod|chown|curl|wget|exec|execute|shell|terminal|deploy(?:ment|ments|ed|s)?|publish(?:ing|ed|es)?|release|merge|push|pull|delete|remove|erase|transfer|payment|purchase|checkout|refund|email|message|send|upload|download|export|import|sync|install|copy|share|forward|move|write|modify|update|access|credential|password|secret|token|api[ _-]?key|scope|permission(?:s)?|approv(?:al|als|e|es|ed|ing)|authoriz(?:e|ed|ation)|grant|admin(?:istrator|istration)?|override|ignore|bypass|disable|unrestricted|private|confidential|sensitive|customer|client|patient|personal|financial|medical|health|record(?:s)?|database)\b|權限|授權|批准|審批|部署|合併|推送|發送|上載|下載|刪除|付款|密碼|憑證|密鑰|金鑰|繞過|忽略安全|取消限制|自動批准|无需批准|無需批准|個人資料|客戶資料|私隱|敏感資料|轉移|分享/i;
const EXECUTABLE_SHAPE =
  /```|https?:\/\/|\$\(|\$\{|[;&|]{2}|<\/?[a-z]+\b|(?:^|\s)(?:bash|python|node|bun|npm|git|docker|rm)\s/i;

export function lowRiskLearningLesson(item: ContextItem): string | null {
  if (
    item.status !== "active" ||
    item.supersededBy ||
    item.proposedAt ||
    item.disputed ||
    item.trust !== "high" ||
    !item.verified ||
    item.kind !== "lesson" ||
    item.scopeType !== "agent" ||
    !item.agentId ||
    !item.evidence.some((e) => e.type === "human") ||
    (item.recurrence < 2 && item.useCount < 2)
  )
    return null;
  const { text, how } = itemWords(item);
  const line = text.trim();
  if (
    how === "refused" ||
    !line ||
    line.length > 220 ||
    /[\r\n\u2028\u2029]/.test(line) ||
    EXECUTABLE_SHAPE.test(line) ||
    UNSAFE_EFFECT.test(line) ||
    looksLikeSecret(line)
  )
    return null;
  return line;
}

const normalized = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/** A type:"human" label alone is never proof: verify the owner's exact live message. */
async function ownerBackedInstruction(db: Database, item: ContextItem, lesson: string) {
  if (!item.agentId || !item.channelIds.length) return false;
  const refs = item.evidence.filter((e) => e.type === "human" && item.sourceIds.includes(e.ref)).map((e) => e.ref);
  if (!refs.length) return false;
  const [agent] = await db
    .select({ ownerUserId: schema.agents.ownerUserId })
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, item.orgId), eq(schema.agents.id, item.agentId)))
    .limit(1);
  if (!agent?.ownerUserId) return false;
  const rows = await db
    .select({ channelId: schema.messages.channelId, body: schema.messages.body })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.orgId, item.orgId),
        eq(schema.messages.authorType, "person"),
        eq(schema.messages.authorUserId, agent.ownerUserId),
        isNull(schema.messages.deletedAt),
        inArray(schema.messages.id, refs),
        inArray(schema.messages.channelId, item.channelIds),
      ),
    )
    .limit(20)
    .for("share");
  return rows.some((m) => normalized(m.body.replace(/^@[\w-]+\s+/, "")) === normalized(lesson));
}

/**
 * A lesson becomes an agent-global instruction; never admit private/DM/task/role-scoped
 * source material through that narrower memory boundary, even when its wording is benign.
 * The query runs again inside the acceptance transaction before any instruction write.
 */
async function hasPublicLearningSources(db: Database, item: ContextItem): Promise<boolean> {
  // Every linked source must resolve within this organization. An unknown, deleted,
  // cross-organization, or opaque source is not evidence for global propagation.
  const sourceIds = [...new Set(item.sourceIds)];
  if (
    !sourceIds.length ||
    sourceIds.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
  )
    return false;
  const messages = await db
    .select({ id: schema.messages.id, channelId: schema.messages.channelId, deletedAt: schema.messages.deletedAt })
    .from(schema.messages)
    .where(and(eq(schema.messages.orgId, item.orgId), inArray(schema.messages.id, sourceIds)))
    .for("share");
  const outcomes = await db
    .select({ id: schema.outcomes.id, channelId: schema.outcomes.channelId })
    .from(schema.outcomes)
    .where(and(eq(schema.outcomes.orgId, item.orgId), inArray(schema.outcomes.id, sourceIds)))
    .for("share");
  // Turn-end learning records the actual agent run ID when the agent used tools.
  // Treat that ID as provenance (NOT an approval) only when its org and agent match.
  // Its original channel is part of the visibility gate, so private tool work
  // cannot be laundered into a public instruction merely through an owner quote.
  if (!item.agentId) return false;
  const runs = await db
    .select({ id: schema.agentRuns.id, channelId: schema.agentRuns.channelId })
    .from(schema.agentRuns)
    .where(
      and(
        eq(schema.agentRuns.orgId, item.orgId),
        eq(schema.agentRuns.agentId, item.agentId),
        inArray(schema.agentRuns.id, sourceIds),
      ),
    )
    .for("share");
  const resolved = new Set([...messages.map((m) => m.id), ...outcomes.map((o) => o.id), ...runs.map((r) => r.id)]);
  if (resolved.size !== sourceIds.length || messages.some((m) => m.deletedAt !== null)) return false;
  const ids = [
    ...new Set([
      ...item.channelIds,
      ...messages.map((message) => message.channelId),
      ...outcomes.flatMap((outcome) => (outcome.channelId ? [outcome.channelId] : [])),
      ...runs.map((run) => run.channelId),
    ]),
  ];
  // Channel-free sources do not bypass the separate live owner-message proof gate.
  if (ids.length === 0) return true;
  const channels = await db
    .select({
      id: schema.channels.id,
      kind: schema.channels.kind,
      visibility: schema.channels.visibility,
      dmKey: schema.channels.dmKey,
      archivedAt: schema.channels.archivedAt,
      audienceRoleIds: schema.channels.audienceRoleIds,
    })
    .from(schema.channels)
    .where(and(eq(schema.channels.orgId, item.orgId), inArray(schema.channels.id, ids)))
    .for("share");
  return (
    channels.length === ids.length &&
    channels.every(
      (channel) =>
        channel.visibility === "public" &&
        channel.kind === "channel" &&
        channel.dmKey === null &&
        channel.archivedAt === null &&
        channel.audienceRoleIds.length === 0,
    )
  );
}

/** Re-read actual proof before the independent judge and again under the write transaction. */
export async function verifiedLearningEvidence(db: Database, item: ContextItem, lesson: string) {
  if (!(await hasPublicLearningSources(db, item))) return false;
  // CI-only provenance is intentionally not an approval grant until an
  // independent test result is authenticated and bound to this exact lesson.
  return ownerBackedInstruction(db, item, lesson);
}

/** Evaluate permission changes AND non-permission data/external effects; missing answers fail closed. */
export async function safeForAutomaticLearning(
  db: Database,
  item: ContextItem,
  judge: Judge | undefined,
): Promise<string | null> {
  const lesson = lowRiskLearningLesson(item);
  if (!lesson || !judge || !item.agentId || !(await verifiedLearningEvidence(db, item, lesson))) return null;
  try {
    if (await triesToChangePermissions(judge, { orgId: item.orgId, text: lesson })) return null;
    const answers = await judge.ask({
      orgId: item.orgId,
      kind: "learning_auto_external_effect",
      state: { candidate_lesson: lesson },
      questions: {
        unsafe_effect: {
          type: "noul",
          instructions:
            "Could following this instruction modify external resources, call outside services, read/share sensitive or private data, publish, transfer or copy data, spend money, change permissions, or affect production? Treat ambiguous cases as unsafe. Allow only a harmless internal checklist, formatting rule or verification/documentation method.",
          criteria: {
            true: "It could have an external, data-sensitive, privileged, destructive or ambiguous effect.",
            false: "Only a bounded internal work-method improvement with no outside effects.",
          },
        },
      },
    });
    const risk = answers.unsafe_effect?.noul;
    return typeof risk === "number" && Number.isFinite(risk) && risk >= 0 && risk < 0.2 ? lesson : null;
  } catch {
    return null;
  }
}

export async function autoLearningEnabled(db: Database, orgId: string): Promise<boolean> {
  // Deploy-safe: if an older database has not applied migration 0282 yet,
  // do not block the existing human proposal flow. Unknown means OFF.
  try {
    const [setting] = await db
      .select({ enabled: schema.organizationSettings.autoApproveLearning })
      .from(schema.organizationSettings)
      .where(eq(schema.organizationSettings.orgId, orgId));
    return setting?.enabled ?? false;
  } catch {
    return false;
  }
}

/** Independent fail-closed sharing opt-in; ordinary learning approval never implies peer publication. */
export async function autoSkillSharingEnabled(db: Database, orgId: string): Promise<boolean> {
  try {
    const [setting] = await db
      .select({ enabled: schema.organizationSettings.autoShareLearnedSkills })
      .from(schema.organizationSettings)
      .where(eq(schema.organizationSettings.orgId, orgId));
    return setting?.enabled ?? false;
  } catch {
    return false;
  }
}

export async function getLearningApprovalSettings(db: Database, actorId: string, orgId: string) {
  await requirePermission(db, actorId, orgId, "read");
  const [autoApproveLearning, autoShareLearnedSkills] = await Promise.all([
    autoLearningEnabled(db, orgId),
    autoSkillSharingEnabled(db, orgId),
  ]);
  return { autoApproveLearning, autoShareLearnedSkills };
}

/** A managing person's policy change and its audit either both commit or both roll back. */
export async function setLearningApprovalSettings(
  db: Database,
  actorId: string,
  orgId: string,
  input: { autoApproveLearning: boolean; autoShareLearnedSkills?: boolean },
) {
  await requirePermission(db, actorId, orgId, "manage_agents");
  await db.transaction(async (tx) => {
    const [previous] = await tx
      .select({
        approve: schema.organizationSettings.autoApproveLearning,
        share: schema.organizationSettings.autoShareLearnedSkills,
      })
      .from(schema.organizationSettings)
      .where(eq(schema.organizationSettings.orgId, orgId))
      .for("update");
    const update = {
      autoApproveLearning: input.autoApproveLearning,
      ...(input.autoShareLearnedSkills === undefined ? {} : { autoShareLearnedSkills: input.autoShareLearnedSkills }),
      updatedAt: new Date(),
    };
    await tx
      .insert(schema.organizationSettings)
      .values({ orgId, ...update })
      .onConflictDoUpdate({ target: schema.organizationSettings.orgId, set: update });
    if ((previous?.approve ?? false) !== input.autoApproveLearning) {
      await recordAudit(tx, {
        orgId,
        actor: { type: "person", id: actorId },
        action: input.autoApproveLearning ? "learning.auto_approval_on" : "learning.auto_approval_off",
        target: { type: "organization", id: orgId },
      });
    }
    if (input.autoShareLearnedSkills !== undefined && (previous?.share ?? false) !== input.autoShareLearnedSkills) {
      await recordAudit(tx, {
        orgId,
        actor: { type: "person", id: actorId },
        action: input.autoShareLearnedSkills ? "learning.skill_sharing_on" : "learning.skill_sharing_off",
        target: { type: "organization", id: orgId },
      });
    }
  });
  return getLearningApprovalSettings(db, actorId, orgId);
}
