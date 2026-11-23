import type { PubSub } from "@agenteschat/adapters";
import { and, eq, inArray, isNull, schema, sql } from "@agenteschat/db";
import { canTalkTo, speakerFor, viaAgent } from "../audience";
import { recordAudit } from "../audit";
import { callableAgents } from "../brakes";
import { sendNote } from "../consultations";
import { sha256 } from "../crypto";
import { ForbiddenError, ValidationError } from "../errors";
import { personBehindCall } from "../requester";
import { grantKey, isAllowed, toolAccess } from "../tools/scopes";
import type { ToolContext } from "../tools/types";
import { createWikiPage } from "../wiki";
import { insertContextItem, looksLikeSecret, normalizeSubject } from "./items";
import { publicPromotionNotes } from "./learned-skills";
import { autoSkillSharingEnabled } from "./learning-auto-approval";

const { skills, skillFiles, agentSkills, agents, agentRuns, agentActions, contextItems, organizationSettings } = schema;
export const MAX_SKILL_EXCHANGE_PEERS = 3;

// Mirror the Tool Gateway's *effective* native load_skill permission:
// a scoped grant, all-tools wildcard or tool-specific grant permits loading,
// while an explicit deny:load_skill always overrides them.
const LOAD_GRANT_SCOPES = ["skills:read", "*", "tool:load_skill", "deny:load_skill"] as const;
const hasNativeLoadAccess = (rows: Array<{ agentId: string; scope: string }>, recipientIds: string[]) => {
  const byAgent = new Map<string, Set<string>>();
  for (const row of rows) {
    const current = byAgent.get(row.agentId) ?? new Set<string>();
    current.add(grantKey(null, row.scope));
    byAgent.set(row.agentId, current);
  }
  return recipientIds.every((id) =>
    isAllowed(toolAccess(byAgent.get(id) ?? new Set(), { name: "load_skill", scope: "skills:read" })),
  );
};

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

// Automatic sharing accepts only plain procedural prose. Reject code-looking
// text anywhere, including descriptions that reach public Wiki and Memory.
// Technical Skills containing commands must use the existing human review.
const COMMAND_WORD =
  /(?:^|[^\p{L}\p{N}_])(?:sudo|curl|wget|bash|zsh|sh|fish|python(?:\d+(?:\.\d+)?)?|node(?:js)?|npm|npx|bun|docker|rm|git|powershell|pwsh|osascript|perl|ruby|php|chmod|chown|dd|eval|exec|scp|ssh|kubectl|pip(?:\d+)?|uvx|awk|sed|xargs|launchctl|systemctl)\b/iu;
const EXECUTABLE_MARKUP =
  /(?:\x60|~{3,}|<[^>]+>|(?:https?|ftp|file):\/\/|www\.|\$\(|\$\{|&&|\|\||;\s*(?:[a-z$]{1,18})\b|\\u(?:200b|200c|200d|2060))/iu;
// Do not rely on enumerating interpreter binaries: newer/aliased commands
// can appear with their own short switches. Heredocs, numeric switches,
// unquoted paths, file extensions and soft-hyphen evasions all require
// explicit human review.
const COMMAND_SHAPE =
  /(?:<<|(?:^|\s)--?\d|(?:^|\s)\/[A-Za-z0-9._~/-]+|\s--?[a-zA-Z]|\.(?:py|sh|js|ts|rb|ps1|lua|php|pl|bat|cmd|exe)(?:\s|$)|[\u00ad\u2010-\u2015]|\x22[^\x22]+\x22|\x27[^\x27]+\x27)/iu;
// Fail-closed low-risk prose gate for unattended public Skill sharing.
// Unlike a filename/interpreter denylist, refuse command verbs, executable
// language runtimes, non-http schemes and code punctuation. Technical guides
// that require a command, URI or expression remain installable only by a
// human-reviewed Skill path. This is not a semantic safety classifier.
const EXECUTION_LANGUAGE =
  /(?:^|[^\p{L}\p{N}_])(?:run|execute|launch|install|download|watch|spawn|invoke|compile|interpret|terminal|shell|command|script|program|runtime|pythonw?|py|deno|tsx|ts-node|tsnode|bunx|ruby|nodejs|java|javascript|vbscript|applescript|cscript|wscript|powershell|pwsh|cmd|busybox|bash|dash|ksh|zsh|fish|perl|lua|awk|sed|npm|npx|pip|uv|uvx|chmod|chown|eval|git|docker|curl|wget)\b/iu;
const EXECUTABLE_URI = /\b[a-z][a-z0-9+.-]{1,30}:\S/iu;
// Reject every combining mark, including U+034F, before the word match.
// A mark must not split deno, tsx, py, a heredoc or javascript into a passing body.
const COMBINING_MARK = /\p{M}/u;
// A line made only of letter or letter-digit tokens is a command. This is not
// an extension of the name list: rustc is absent from that list and still fails.
const BARE_LETTER_COMMAND_LINE = /^(?:[a-z][a-z0-9]*)(?:\s+[a-z][a-z0-9]*)*$/i;
const ALNUM_COMMAND_TOKEN = /(?:^|[^\p{L}\p{N}_])\p{L}+\d/u;
const PROSE_ONLY = /[^\p{L}\p{N}\p{Zs}\n.,:!?*#-]/u;
const hasBareLetterCommand = (text: string) =>
  text.split(/\r?\n/).some((line) => BARE_LETTER_COMMAND_LINE.test(line.trim()));
// A denylist cannot enumerate arbitrary executable names. Unattended sharing
// is restricted to a small, auditable procedural-language grammar. Unknown
// imperatives, headings and command-looking fragments go to human review.
const SAFE_PROCEDURE_START =
  /^(?:check|verify|validate|compare|identify|record|retain|preserve|review|confirm|summarize|explain|report|assess|ensure|avoid|prefer|treat|keep|consider|describe|note|reconcile|inspect|repeat|verified|when|if|for|before|after|during|this|each|every|only|never|always|use when|do not)(?:\s|[.!?:])/iu;
const SAFE_HEADING =
  /^#{1,3}\s+(?:when to use|steps|method|pitfalls|verification|checklist|notes|overview|scope|purpose|safeguards)$/iu;
const PROCEDURE_OPENER =
  /^(?:use when|do not|check|verify|validate|compare|identify|record|retain|preserve|review|confirm|summarize|explain|report|assess|ensure|avoid|prefer|treat|keep|consider|describe|note|reconcile|inspect|repeat|verified|when|if|for|before|after|during|this|each|every|only|never|always)\b/iu;
// Closed vocabulary for every token after the opener. The golden sentence
// contributes the, release, readiness, and twice. The promoted description
// contributes the rest. A dotted token such as main.rs or hello.c cannot match.
const PROCEDURAL_PROSE_WORD =
  /^(?:a|after|changes|checklist|independently|readiness|release|tested|the|twice)$/iu;
const proseSentences = (item: string) => {
  const parts = item
    .split(/(?<=[.!?])\s+/u)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0 || parts.some((part) => !/[.!?]$/u.test(part))) return null;
  return parts;
};
const sentenceUsesClosedVocabulary = (sentence: string) => {
  if (!SAFE_PROCEDURE_START.test(sentence)) return false;
  const opener = PROCEDURE_OPENER.exec(sentence);
  if (!opener) return false;
  const words = sentence.replace(/[.!?]$/u, "").trim().split(/\s+/u);
  const openerCount = opener[0].split(/\s+/u).length;
  if (words.length < openerCount) return false;
  const leading = words.slice(0, openerCount).join(" ");
  if (!PROCEDURE_OPENER.test(leading)) return false;
  return words.slice(openerCount).every((token) => PROCEDURAL_PROSE_WORD.test(token));
};
const structuredSafeProse = (text: string) =>
  text.split(/\r?\n/).every((line) => {
    const trimmed = line.trim();
    if (!trimmed || SAFE_HEADING.test(trimmed)) return true;
    const item = trimmed.replace(/^(?:[-*]\s+|[0-9]+[.)]\s+)/u, "");
    const sentences = proseSentences(item);
    return sentences !== null && sentences.every(sentenceUsesClosedVocabulary);
  });
const safeProse = (value: string, maxLength: number) => {
  const text = value.normalize("NFKC");
  if (
    value.trim().length === 0 ||
    value.length > maxLength ||
    looksLikeSecret(value) ||
    COMBINING_MARK.test(value) ||
    COMBINING_MARK.test(text)
  )
    return false;
  return (
    !/[\u200b-\u200f\u202a-\u202e\u2060-\u206f]/u.test(text) &&
    !hasBareLetterCommand(text) &&
    structuredSafeProse(text) &&
    !ALNUM_COMMAND_TOKEN.test(text) &&
    !COMMAND_WORD.test(text) &&
    !EXECUTION_LANGUAGE.test(text) &&
    !EXECUTABLE_URI.test(text) &&
    !PROSE_ONLY.test(text) &&
    !COMMAND_SHAPE.test(text) &&
    !EXECUTABLE_MARKUP.test(text)
  );
};
const safeBody = (body: string, description: string) => safeProse(body, 12_000) && safeProse(description, 200);

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
  if (!candidate || !safeBody(candidate.body, candidate.description))
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
  // Audit provenance must bind to exactly the v1 model-generated contents.
  // A first-version row can otherwise be edited in place to inject an
  // unknown executable phrase and still pass its old promotion receipt.
  const expectedDigest = creation.after?.contentDigest;
  if (
    typeof expectedDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(expectedDigest) ||
    expectedDigest !== sha256(JSON.stringify([candidate.description, candidate.body]))
  )
    throw new ForbiddenError("Skill text no longer matches its verified creation receipt.");
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
    .select({ agentId: schema.agentScopes.agentId, scope: schema.agentScopes.scope })
    .from(schema.agentScopes)
    .where(
      and(
        eq(schema.agentScopes.orgId, orgId),
        inArray(
          schema.agentScopes.agentId,
          peers.map((p) => p.id),
        ),
        inArray(schema.agentScopes.scope, LOAD_GRANT_SCOPES),
        isNull(schema.agentScopes.connectionId),
      ),
    );
  if (
    !hasNativeLoadAccess(
      readable,
      peers.map((p) => p.id),
    )
  )
    throw new ForbiddenError("Every recipient needs effective native load_skill access; only a manager may change it.");
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
      locked.description !== candidate.description ||
      sha256(JSON.stringify([locked.description, locked.body])) !== expectedDigest ||
      !safeBody(locked.body, locked.description)
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
      .select({ agentId: schema.agentScopes.agentId, scope: schema.agentScopes.scope })
      .from(schema.agentScopes)
      .where(
        and(
          eq(schema.agentScopes.orgId, orgId),
          inArray(
            schema.agentScopes.agentId,
            peers.map((p) => p.id),
          ),
          inArray(schema.agentScopes.scope, LOAD_GRANT_SCOPES),
          isNull(schema.agentScopes.connectionId),
        ),
      )
      .for("share");
    if (
      !hasNativeLoadAccess(
        lockedScopes,
        peers.map((p) => p.id),
      )
    )
      throw new ForbiddenError("The recipient's native load_skill access changed during sharing.");
    // Lock BOTH the caller and peers, in stable ID order. The inter-agent
    // call grant is stored on the caller; holding only recipient locks left
    // a revoke window between the authority read and the assignment.
    const participantIds = [...new Set([agentId, ...peers.map((p) => p.id)])].sort();
    const participants = await tx
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.orgId, orgId),
          inArray(agents.id, participantIds),
          isNull(agents.archivedAt),
          isNull(agents.deletedAt),
        ),
      )
      .orderBy(agents.id)
      .for("share");
    const currentCreator = participants.find((p) => p.id === agentId);
    const recipients = participants.filter((p) => p.id !== agentId);
    if (
      participants.length !== participantIds.length ||
      !currentCreator ||
      currentCreator.ownerUserId !== personId ||
      recipients.length !== peers.length ||
      recipients.some((p) => p.ownerUserId !== personId)
    )
      throw new ForbiddenError("Caller or recipient authority changed while sharing.");
    // Recheck the current audience and the live inter-agent call permission
    // with recipients locked, not only at the earlier preflight.
    const refreshedAudience = viaAgent(await speakerFor(tx, orgId, personId));
    const refreshedCallable = await callableAgents(
      tx,
      orgId,
      agentId,
      recipients.map((p) => p.id),
    );
    if (recipients.some((p) => !refreshedCallable.has(p.id) || !canTalkTo(p, personId, refreshedAudience)))
      throw new ForbiddenError("Recipient audience or agent communication permission changed during sharing.");
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
    // Filter by this exact Skill in SQL instead of fetching every Wiki.
    const [existingPage] = await db
      .select({ id: schema.wikiPages.id })
      .from(schema.wikiPages)
      .where(
        and(
          eq(schema.wikiPages.orgId, orgId),
          isNull(schema.wikiPages.deletedAt),
          sql`${schema.wikiPages.source}->>'type' = 'skill'`,
          sql`${schema.wikiPages.source}->>'id' = ${candidate.id}`,
        ),
      )
      .limit(1);
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
  // Record an incomplete exchange for BOTH automatic promotion and an
  // explicit native share_learned_skill call. The durable Skill grant may
  // already exist; do not let a failed Wiki or peer handoff disappear from
  // audit history, or report it as fully delivered.
  const pendingWiki = receipt.wiki.status === "failed";
  const pendingPeers = receipt.peerNotes
    .filter((n) => n.status === "failed" || n.status === "deduplicated")
    .map((n) => ({ handle: n.handle, status: n.status }));
  if (pendingWiki || pendingPeers.length > 0)
    await recordAudit(db, {
      orgId,
      actor: { type: "agent", id: agentId },
      action: "skill.exchange_unverified",
      target: { type: "skill", id: receipt.skillId },
      runId,
      channelId: ctx.channelId,
      onBehalfOfUserId: personId,
      details: {
        reason: "partial_delivery",
        wikiStatus: receipt.wiki.status,
        pendingPeers,
        assignedCount: receipt.assigned.length,
      },
    });
  return receipt;
}
