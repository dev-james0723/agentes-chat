import { and, type Database, eq, inArray, schema } from "@agenteschat/db";
import { recordAudit } from "../audit";
import type { Judge } from "../judge";
import { triesToChangePermissions } from "../judge";
import { requirePermission } from "../organizations";
import { type ContextItem, itemWords, looksLikeSecret } from "./items";

/**
 * Self-learning approvals are a narrow, opt-in policy lane, NOT permission grants.
 * Only a verified, repeated, human-supported lesson for the same agent may append one
 * short non-executable bullet to that agent's own instructions. Every other proposal
 * follows the existing human review path. The model cannot change this policy.
 */
const UNSAFE_EFFECT =
  /\b(?:sudo|chmod|chown|curl|wget|exec|shell|terminal|deploy|publish|release|merge|push|delete|erase|transfer|payment|purchase|checkout|refund|email|message|send|upload|export|credential|password|secret|token|api[ _-]?key|scope|permission|approval|authorize|grant|admin|override|ignore|bypass|disable|unrestricted)\b|權限|授權|批准|審批|部署|合併|推送|發送|上載|刪除|付款|密碼|憑證|密鑰|金鑰|繞過|忽略安全|取消限制|自動批准|无需批准|無需批准/i;
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
    !item.evidence.some((e) => e.type === "human" || e.type === "outcome") ||
    (item.recurrence < 2 && item.useCount < 2)
  )
    return null;
  const { text, how } = itemWords(item);
  const line = text.trim();
  if (
    how === "refused" ||
    !line ||
    line.length > 220 ||
    /[\r\n]/.test(line) ||
    EXECUTABLE_SHAPE.test(line) ||
    UNSAFE_EFFECT.test(line) ||
    looksLikeSecret(line)
  )
    return null;
  return line;
}

/** Requiring a live independent semantic check, and failing closed if unavailable. */
export async function safeForAutomaticLearning(
  db: Database,
  item: ContextItem,
  judge: Judge | undefined,
): Promise<string | null> {
  const lesson = lowRiskLearningLesson(item);
  if (!lesson || !judge || !item.agentId) return null;
  // A real recorded successful CI/test outcome may stand in for a prior human correction.
  // Never treat agent claims, a completed chat turn, negative outcomes, or outside data as proof.
  if (!item.evidence.some((e) => e.type === "human")) {
    const ids = item.evidence.filter((e) => e.type === "outcome").map((e) => e.ref);
    if (ids.length === 0) return null;
    const [proof] = await db
      .select({ id: schema.outcomes.id })
      .from(schema.outcomes)
      .where(
        and(
          eq(schema.outcomes.orgId, item.orgId),
          eq(schema.outcomes.agentId, item.agentId),
          inArray(schema.outcomes.id, ids),
          eq(schema.outcomes.polarity, "positive"),
          inArray(schema.outcomes.kind, ["tests_passed", "ci_passed", "criteria_met"]),
          inArray(schema.outcomes.source, ["tool", "webhook", "operator"]),
        ),
      )
      .limit(1);
    if (!proof) return null;
  }
  try {
    return (await triesToChangePermissions(judge, { orgId: item.orgId, text: lesson })) ? null : lesson;
  } catch {
    return null;
  }
}

export async function autoLearningEnabled(db: Database, orgId: string): Promise<boolean> {
  const [setting] = await db
    .select({ enabled: schema.organizationSettings.autoApproveLearning })
    .from(schema.organizationSettings)
    .where(eq(schema.organizationSettings.orgId, orgId));
  return setting?.enabled ?? false;
}

export async function getLearningApprovalSettings(db: Database, actorId: string, orgId: string) {
  await requirePermission(db, actorId, orgId, "read");
  return { autoApproveLearning: await autoLearningEnabled(db, orgId) };
}

/** Only a person with manage_agents can opt the workspace in or out. */
export async function setLearningApprovalSettings(
  db: Database,
  actorId: string,
  orgId: string,
  input: { autoApproveLearning: boolean },
) {
  await requirePermission(db, actorId, orgId, "manage_agents");
  await db
    .insert(schema.organizationSettings)
    .values({ orgId, autoApproveLearning: input.autoApproveLearning })
    .onConflictDoUpdate({
      target: schema.organizationSettings.orgId,
      set: { autoApproveLearning: input.autoApproveLearning, updatedAt: new Date() },
    });
  await recordAudit(db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: input.autoApproveLearning ? "learning.auto_approval_on" : "learning.auto_approval_off",
    target: { type: "organization", id: orgId },
  });
  return input;
}
