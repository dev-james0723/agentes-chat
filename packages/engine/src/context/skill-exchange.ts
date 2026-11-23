import type { PubSub } from "@agenteschat/adapters";
import { and, eq, inArray, isNull, schema } from "@agenteschat/db";
import { canTalkTo, speakerFor, viaAgent } from "../audience";
import { recordAudit } from "../audit";
import { callableAgents } from "../brakes";
import { sendNote } from "../consultations";
import { ForbiddenError, ValidationError } from "../errors";
import { personBehindCall } from "../requester";
import type { ToolContext } from "../tools/types";
import { createWikiPage } from "../wiki";
import { insertContextItem, looksLikeSecret, normalizeSubject } from "./items";
import { publicPromotionNotes } from "./learned-skills";
import { autoSkillSharingEnabled } from "./learning-auto-approval";

const { skills, skillFiles, agentSkills, agents, agentRuns, agentActions, contextItems, organizationSettings } = schema;
export const MAX_SKILL_EXCHANGE_PEERS = 3;

export interface SkillExchangeReceipt extends Record<string, unknown> {
  skillId: string;
  version: number;
  name: string;
  assigned: Array<{ id: string; handle: string }>;
  alreadyAssigned: string[];
  disabled: string[];
  sourceNoteIds: string[];
  memory: { status: "created" | "existing" | "not_needed"; id?: string };
  wiki: { status: "created" | "existing" | "failed" | "not_needed"; id?: string; reason?: string };
  peerNotes: Array<{
    handle: string;
    status: "sent" | "already_sent" | "deduplicated" | "failed";
    messageId?: string;
    reason?: string;
  }>;
}

const safeBody = (body: string) =>
  body.length > 0 &&
  body.length <= 12_000 &&
  !looksLikeSecret(body) &&
  !/\x60{3}|<script\b|https?:\/\/|(?:^|\n)\s*(?:sudo|curl|wget|bash|python|node|npm|bun|docker|rm|git)\s/iu.test(body);

/**
 * Creator-controlled sharing of public non-executable first-version agent-origin Skills.
 * Agent A chooses peers, but all sharing permissions are checked server-side.
 */
export async function shareLearnedSkill(
  deps: { pubsub?: PubSub },
  ctx: ToolContext,
  input: { name: string; handles: string[] },
): Promise<SkillExchangeReceipt> {
  const { db, orgId, agentId, runId } = ctx;
  const handles = [...new Set(input.handles.map((h) => h.trim().replace(/^@/, "").toLowerCase()))];
  if (!runId || handles.length < 1 || handles.length > MAX_SKILL_EXCHANGE_PEERS)
    throw new ValidationError("Select one to three peers in a real agent run.");
  if (handles.some((h) => !/^[a-z][a-z0-9_-]{1,31}$/.test(h))) throw new ValidationError("Invalid recipient handle.");
  const personId = await personBehindCall(ctx);
  if (!personId) throw new ForbiddenError("Unattended runs cannot borrow owner authority.");
  const [creator] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.orgId, orgId), eq(agents.id, agentId), isNull(agents.archivedAt), isNull(agents.deletedAt)));
  if (!creator || creator.ownerUserId !== personId)
    throw new ForbiddenError("Only this agent's owner may authorize its sharing.");
  const [policy] = await db
    .select({ on: organizationSettings.agentsImproveSkills })
    .from(organizationSettings)
    .where(eq(organizationSettings.orgId, orgId));
  if (policy?.on !== true || !(await autoSkillSharingEnabled(db, orgId)))
    throw new ForbiddenError("An owner must enable verified automatic learning before skills can be shared.");
  const [candidate] = await db
    .select()
    .from(skills)
    .where(
      and(
        eq(skills.orgId, orgId),
        eq(skills.slug, input.name),
        eq(skills.ownerAgentId, agentId),
        eq(skills.origin, "agent"),
        eq(skills.version, 1),
        isNull(skills.deletedAt),
      ),
    );
  if (!candidate || !safeBody(candidate.body))
    throw new ForbiddenError("Only a verified, first-version, text-only Skill may be shared.");
  const [hasOriginal] = await db
    .select({ id: agentSkills.id })
    .from(agentSkills)
    .where(
      and(
        eq(agentSkills.orgId, orgId),
        eq(agentSkills.agentId, agentId),
        eq(agentSkills.skillId, candidate.id),
        eq(agentSkills.enabled, true),
      ),
    );
  if (!hasOriginal) throw new ForbiddenError("The creator does not have this Skill enabled.");
  const [creation] = await db
    .select()
    .from(agentActions)
    .where(
      and(
        eq(agentActions.orgId, orgId),
        eq(agentActions.agentId, agentId),
        eq(agentActions.kind, "skill.created"),
        eq(agentActions.targetId, candidate.id),
      ),
    )
    .limit(1);
  const rawNoteIds = creation?.after?.noteIds;
  const noteIds =
    Array.isArray(rawNoteIds) && rawNoteIds.every((x) => typeof x === "string")
      ? [...new Set(rawNoteIds as string[])]
      : [];
  if (!creation || !noteIds.length) throw new ForbiddenError("Native source memory receipts are missing.");
  const peers = await db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.orgId, orgId),
        inArray(agents.handle, handles),
        isNull(agents.archivedAt),
        isNull(agents.deletedAt),
      ),
    );
  if (peers.length !== handles.length || peers.some((p) => p.id === agentId || p.ownerUserId !== personId))
    throw new ForbiddenError("Recipients must be active peers of the same human owner and organization.");
  // A Skill assignment does not grant the built-in scope required to load it.
  // Deny instead of claiming a successful share to an agent that cannot use it.
  const readable = await db
    .select({ agentId: schema.agentScopes.agentId })
    .from(schema.agentScopes)
    .where(
      and(
        eq(schema.agentScopes.orgId, orgId),
        inArray(
          schema.agentScopes.agentId,
          peers.map((p) => p.id),
        ),
        eq(schema.agentScopes.scope, "skills:read"),
        isNull(schema.agentScopes.connectionId),
      ),
    );
  if (new Set(readable.map((row) => row.agentId)).size !== peers.length)
    throw new ForbiddenError(
      "Every recipient needs an existing native skills:read grant; only a manager may grant it.",
    );
  const callable = await callableAgents(
    db,
    orgId,
    agentId,
    peers.map((p) => p.id),
  );
  const audience = viaAgent(await speakerFor(db, orgId, personId));
  if (peers.some((p) => !callable.has(p.id) || !canTalkTo(p, personId, audience)))
    throw new ForbiddenError("A recipient is outside this agent's allowed communication audience.");
  const [sourceRun] = await db
    .select({ hop: agentRuns.hop })
    .from(agentRuns)
    .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.id, runId), eq(agentRuns.agentId, agentId)));
  if (!sourceRun) throw new ForbiddenError("Originating agent run is unavailable.");
  const changed = await db.transaction(async (tx) => {
    const [currentPolicy] = await tx
      .select({
        learn: organizationSettings.agentsImproveSkills,
        share: organizationSettings.autoShareLearnedSkills,
      })
      .from(organizationSettings)
      .where(eq(organizationSettings.orgId, orgId))
      .for("share");
    if (!currentPolicy?.learn || !currentPolicy.share)
      throw new ForbiddenError("The owner disabled the learning or sharing policy.");
    const [locked] = await tx
      .select()
      .from(skills)
      .where(and(eq(skills.orgId, orgId), eq(skills.id, candidate.id)))
      .for("update");
    if (
      !locked ||
      locked.version !== 1 ||
      locked.ownerAgentId !== agentId ||
      locked.origin !== "agent" ||
      locked.deletedAt ||
      locked.body !== candidate.body ||
      !safeBody(locked.body)
    )
      throw new ForbiddenError("Skill identity changed while sharing.");
    const [stillEnabled] = await tx
      .select({ id: agentSkills.id })
      .from(agentSkills)
      .where(
        and(
          eq(agentSkills.orgId, orgId),
          eq(agentSkills.agentId, agentId),
          eq(agentSkills.skillId, candidate.id),
          eq(agentSkills.enabled, true),
        ),
      );
    if (!stillEnabled) throw new ForbiddenError("The creator's Skill assignment was disabled.");
    const fileRows = await tx
      .select({ id: skillFiles.id })
      .from(skillFiles)
      .where(and(eq(skillFiles.orgId, orgId), eq(skillFiles.skillId, candidate.id)));
    if (fileRows.length) throw new ForbiddenError("Skills with files need explicit human review.");
    const notes = await tx
      .select()
      .from(contextItems)
      .where(and(eq(contextItems.orgId, orgId), inArray(contextItems.id, noteIds)))
      .orderBy(contextItems.id)
      .for("update");
    if (
      notes.length !== noteIds.length ||
      notes.some(
        (n) =>
          n.agentId !== agentId ||
          n.scopeType !== "agent" ||
          n.scopeId !== agentId ||
          n.status !== "archived" ||
          n.trust !== "high" ||
          n.disputed,
      )
    )
      throw new ForbiddenError("Original memory items are not verified.");
    const publicNotes = await publicPromotionNotes(tx, orgId, notes, true);
    if (publicNotes.length !== notes.length)
      throw new ForbiddenError("A learning source became private, missing or restricted.");
    const current = await tx
      .select()
      .from(agentSkills)
      .where(
        and(
          eq(agentSkills.orgId, orgId),
          eq(agentSkills.skillId, candidate.id),
          inArray(
            agentSkills.agentId,
            peers.map((p) => p.id),
          ),
        ),
      );
    const grants = new Map(current.map((r) => [r.agentId, r.enabled]));
    const targets = peers.filter((p) => !grants.has(p.id));
    // Serialize against concurrent revocation of an existing Skill-read grant.
    const lockedScopes = await tx
      .select({ agentId: schema.agentScopes.agentId })
      .from(schema.agentScopes)
      .where(
        and(
          eq(schema.agentScopes.orgId, orgId),
          inArray(
            schema.agentScopes.agentId,
            peers.map((p) => p.id),
          ),
          eq(schema.agentScopes.scope, "skills:read"),
          isNull(schema.agentScopes.connectionId),
        ),
      )
      .for("share");
    if (new Set(lockedScopes.map((row) => row.agentId)).size !== peers.length)
      throw new ForbiddenError("The recipient's native Skill-read grant changed during sharing.");
    const recipients = await tx
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.orgId, orgId),
          inArray(
            agents.id,
            peers.map((p) => p.id),
          ),
          isNull(agents.archivedAt),
          isNull(agents.deletedAt),
        ),
      )
      .for("share");
    if (recipients.length !== peers.length || recipients.some((p) => p.ownerUserId !== personId))
      throw new ForbiddenError("Recipient status changed while sharing.");
    const inserted = targets.length
      ? await tx
          .insert(agentSkills)
          .values(
            targets.map((p) => ({
              orgId,
              agentId: p.id,
              skillId: candidate.id,
              enabled: true,
            })),
          )
          .onConflictDoNothing()
          .returning({ agentId: agentSkills.agentId })
      : [];
    const actual = peers.filter((p) => inserted.some((a) => a.agentId === p.id));
    let memory: SkillExchangeReceipt["memory"] = { status: "not_needed" };
    if (actual.length > 0) {
      // Record the skill's public, independently checked provenance as ordinary
      // org-scoped memory. Never erase the creator's archived original notes.
      const subject = "skill-exchange " + locked.id;
      const [previous] = await tx
        .select({ id: contextItems.id })
        .from(contextItems)
        .where(
          and(
            eq(contextItems.orgId, orgId),
            eq(contextItems.scopeType, "org"),
            eq(contextItems.kind, "note"),
            eq(contextItems.subjectKey, normalizeSubject(subject)),
            eq(contextItems.status, "active"),
          ),
        )
        .limit(1);
      if (previous) {
        memory = { status: "existing", id: previous.id };
      } else {
        const published = await insertContextItem(tx, {
          orgId,
          kind: "note",
          scopeType: "org",
          scopeId: orgId,
          subject,
          title: "Learned skill: " + locked.slug,
          content:
            "Public, verified workflow learned by @" +
            creator.handle +
            ": " +
            locked.name +
            " (v1). Use load_skill with name " +
            locked.slug +
            " when the role and task match. " +
            locked.description,
          sourceIds: [...new Set(notes.flatMap((n) => n.sourceIds))],
          channelIds: [...new Set(notes.flatMap((n) => n.channelIds))],
          trust: "high",
          evidence: [{ type: "agent", agentId, ref: creation.id, at: new Date().toISOString() }],
          createdByKind: "agent",
          createdById: agentId,
          confidence: 0.95,
        });
        memory = { status: "created", id: published.id };
      }
    }
    for (const peer of actual)
      await recordAudit(tx, {
        orgId,
        actor: { type: "agent", id: agentId },
        action: "skill.shared_by_agent",
        target: { type: "agent", id: peer.id },
        runId,
        channelId: ctx.channelId,
        onBehalfOfUserId: personId,
        details: { skillId: candidate.id, version: 1, sourceNoteIds: noteIds },
      });
    return {
      assigned: actual.map((p) => ({ id: p.id, handle: p.handle })),
      alreadyAssigned: peers.filter((p) => grants.get(p.id) === true).map((p) => p.handle),
      disabled: peers.filter((p) => grants.get(p.id) === false).map((p) => p.handle),
      memory,
    };
  });
  const receipt: SkillExchangeReceipt = {
    skillId: candidate.id,
    name: candidate.slug,
    version: 1,
    ...changed,
    sourceNoteIds: noteIds,
    wiki: { status: "not_needed" },
    peerNotes: [],
  };
  // Reconcile previous grants from this exact creator's own Skill audit.
  // A recipient manually enabled by someone else must not receive unsolicited notes.
  const previous = await db
    .select({ targetId: schema.auditLog.targetId, details: schema.auditLog.details })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.orgId, orgId),
        eq(schema.auditLog.actorType, "agent"),
        eq(schema.auditLog.actorId, agentId),
        eq(schema.auditLog.action, "skill.shared_by_agent"),
        inArray(
          schema.auditLog.targetId,
          peers.map((p) => p.id),
        ),
      ),
    );
  const recoverable = peers.filter(
    (peer) =>
      changed.alreadyAssigned.includes(peer.handle) &&
      previous.some(
        (row) => row.targetId === peer.id && row.details.skillId === candidate.id && row.details.version === 1,
      ),
  );
  const deliver = [...changed.assigned, ...recoverable.map((p) => ({ id: p.id, handle: p.handle }))];
  if (!deliver.length) return receipt;
  const body =
    "Verified public Skill shared by @" +
    creator.handle +
    ": " +
    candidate.slug +
    " (v1). Use load_skill with name " +
    candidate.slug +
    " when relevant, apply it in your own task and report evidence.";
  try {
    const recordedPages = await db
      .select({ id: schema.wikiPages.id, source: schema.wikiPages.source })
      .from(schema.wikiPages)
      .where(and(eq(schema.wikiPages.orgId, orgId), isNull(schema.wikiPages.deletedAt)));
    const existingPage = recordedPages.find((page) => page.source?.type === "skill" && page.source.id === candidate.id);
    if (existingPage) {
      receipt.wiki = { status: "existing", id: existingPage.id };
    } else {
      const page = await createWikiPage(
        { db, pubsub: deps.pubsub },
        { type: "agent", agentId, requestedByUserId: personId, channelId: ctx.channelId },
        orgId,
        {
          title: "Learned skill: " + candidate.name,
          folder: "Agent Learning",
          body:
            "Skill: " +
            candidate.slug +
            "\nVersion: 1\nCreator: " +
            creator.handle +
            "\n\n" +
            candidate.description +
            "\n\n" +
            candidate.body +
            "\n\nSource memory IDs: " +
            noteIds.join(", "),
          tags: ["learned-skill", "agent-exchange"],
          source: { type: "skill", id: candidate.id },
        },
      );
      receipt.wiki = { status: "created", id: page.id };
    }
  } catch (error) {
    receipt.wiki = { status: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
  for (const peer of deliver) {
    try {
      const [priorNote] = await db
        .select({ messageId: schema.agentConsultations.messageId })
        .from(schema.agentConsultations)
        .where(
          and(
            eq(schema.agentConsultations.orgId, orgId),
            eq(schema.agentConsultations.askerAgentId, agentId),
            eq(schema.agentConsultations.targetAgentId, peer.id),
            eq(schema.agentConsultations.kind, "note"),
            eq(schema.agentConsultations.question, body),
          ),
        )
        .limit(1);
      if (priorNote) {
        receipt.peerNotes.push({ handle: peer.handle, status: "already_sent", messageId: priorNote.messageId });
        continue;
      }
      const note = await sendNote(db, {
        orgId,
        agentId,
        runId,
        hop: sourceRun.hop,
        targetAgentId: peer.id,
        chain: [],
        body,
      });
      receipt.peerNotes.push({
        handle: peer.handle,
        status: note ? "sent" : "deduplicated",
        ...(note ? { messageId: note.message.id } : {}),
      });
    } catch (error) {
      receipt.peerNotes.push({
        handle: peer.handle,
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return receipt;
}
