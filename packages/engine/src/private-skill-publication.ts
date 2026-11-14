import { and, type Database, eq, isNull, schema, sql } from "@agenteschat/db";
import { readableChannelIds } from "./channels";
import { personMayRead } from "./context/items";
import { sha256 } from "./crypto";
import { ConflictError, ForbiddenError, ValidationError } from "./errors";
import { can, getMembership } from "./organizations";
import { workRefusal } from "./standing";
import { actionHash } from "./tools/gateway";
import { canonicalJson } from "./tools/json-schema";
import { freshGrantedKeys, isAllowed, toolAccess } from "./tools/scopes";
import type { ToolContext, ToolDefinition } from "./tools/types";

/** The v1 support module stays unregistered/non-authorizing; this is the native runtime contract. */
export const PRIVATE_PUBLICATION = "skill-publication-v1:native-v2";
export const PRIVATE_PUBLICATION_TITLE = "Review sharing a private draft";
export const PRIVATE_PUBLICATION_DEFER =
  "This change needs a source review before it can be shared. Provide a version that is safe to share, or ask its original owner to start a fresh direct request. No shared draft was created.";
const TOOL = { name: "update_skill", scope: "skills:read", connectionId: null };
const hash = (value: unknown) => sha256(canonicalJson(value));
export type PublicationCapture = {
  version: 2;
  complete: boolean;
  channelId: string;
  triggerMessageId: string;
  configurationHash: string;
  sources: { id: string; hash: string }[];
};
export const publicationConfigurationHash = (
  org: { context: string },
  agent: { instructions: string; role: string; ownerUserId?: string | null },
) => hash([org.context, agent.instructions, agent.role, agent.ownerUserId ?? null]);
export const publicationMessageHash = (message: {
  body: string;
  meta: Record<string, unknown>;
  authorType: string;
  authorUserId?: string | null;
  authorAgentId?: string | null;
  channelId: string;
  threadId: string | null;
}) =>
  hash({
    body: message.body,
    meta: message.meta,
    authorType: message.authorType,
    authorUserId: message.authorUserId ?? null,
    authorAgentId: message.authorAgentId ?? null,
    channelId: message.channelId,
    threadId: message.threadId,
  });
const freshCaptures = new WeakSet<object>();
export function capturePublicationContext(input: Omit<PublicationCapture, "version">): PublicationCapture {
  const capture: PublicationCapture = { version: 2, ...input };
  freshCaptures.add(capture);
  return capture;
}
/** JSON/model flags and resumed legacy values cannot initialize server source coverage. */
export const isFreshPublicationCapture = (capture: unknown) =>
  !!capture && typeof capture === "object" && freshCaptures.has(capture);
const nativeSkillUpdaters = new WeakSet<ToolDefinition>();
const nativeSourceReaders = new WeakSet<ToolDefinition>();
export function registerNativePublicationReader(tool: ToolDefinition) {
  nativeSourceReaders.add(tool);
}
export const isNativePublicationReader = (tool: ToolDefinition) => nativeSourceReaders.has(tool);
/** Content and authority delivered by native expand. Retrieval counters are not source revisions. */
export function publicationItemHash(item: typeof schema.contextItems.$inferSelect) {
  const { useCount: _used, relevance: _rank, lastUsedAt: _last, ...source } = item;
  return hash(JSON.parse(JSON.stringify(source)));
}
/** Registered only by the native skill source; a connected/custom tool cannot self-assert this authority. */
export function registerNativeSkillUpdater(tool: ToolDefinition) {
  nativeSkillUpdaters.add(tool);
}
export const isNativeSkillUpdater = (tool: ToolDefinition) => nativeSkillUpdaters.has(tool);
type Approval = typeof schema.approvals.$inferSelect;
export type NativePublicationEnvelope = {
  contract: typeof PRIVATE_PUBLICATION;
  input: { name: string; body: string };
  publication: {
    orgId: string;
    agentId: string;
    runId: string;
    channelId: string;
    threadRootId: string;
    triggerMessageId: string;
    toolUseId: string;
    ownerUserId: string;
    skillId: string;
    baseVersion: number;
    baseHash: string;
    resourcesHash: string;
    sourcesHash: string;
    audienceHash: string;
    captureHash: string;
    purpose: "publish_to_org_skill_library";
    issuedAt: string;
    expiresAt: string;
  };
};
export const isNativePrivatePublication = (a: { params?: unknown }) =>
  !!a.params && typeof a.params === "object" && (a.params as { contract?: unknown }).contract === PRIVATE_PUBLICATION;
/** Privacy follows the envelope marker even if another binding was corrupted. Unknown versions stay hidden. */
export const isPrivatePublication = (a: { params?: unknown }) => {
  const contract = a.params && typeof a.params === "object" ? (a.params as { contract?: unknown }).contract : null;
  return typeof contract === "string" && contract.startsWith("skill-publication-");
};
export function privatePublicationSql() {
  return sql<boolean>`coalesce((${schema.approvals.params}->>'contract') like 'skill-publication-%',false)`;
}
const defer = () => ({ kind: "defer" as const });

/** Read only; source coverage is captured by native context assembly, never by model arguments. */
async function readPrivatePublicationFacts(ctx: ToolContext, input: Record<string, unknown>, viewOnly = false) {
  if (
    typeof input.name !== "string" ||
    (input.body !== undefined && typeof input.body !== "string") ||
    Object.keys(input).some((k) => k !== "name" && k !== "body" && k !== "files") ||
    !ctx.runId ||
    ctx.bridge
  )
    return null;
  const db = ctx.db;
  const [[run], [agent], [org], [channel], [trigger], [skill]] = await Promise.all([
    db
      .select()
      .from(schema.agentRuns)
      .where(and(eq(schema.agentRuns.orgId, ctx.orgId), eq(schema.agentRuns.id, ctx.runId))),
    db
      .select()
      .from(schema.agents)
      .where(and(eq(schema.agents.orgId, ctx.orgId), eq(schema.agents.id, ctx.agentId))),
    db.select().from(schema.organizations).where(eq(schema.organizations.id, ctx.orgId)),
    db
      .select()
      .from(schema.channels)
      .where(and(eq(schema.channels.orgId, ctx.orgId), eq(schema.channels.id, ctx.channelId))),
    db
      .select()
      .from(schema.messages)
      .where(and(eq(schema.messages.orgId, ctx.orgId), eq(schema.messages.id, ctx.triggerMessageId))),
    db
      .select()
      .from(schema.skills)
      .where(
        and(
          eq(schema.skills.orgId, ctx.orgId),
          eq(schema.skills.slug, input.name.trim().toLowerCase()),
          isNull(schema.skills.deletedAt),
        ),
      ),
  ]);
  if (
    !run ||
    !agent ||
    !org ||
    !channel ||
    !trigger ||
    !skill ||
    run.agentId !== ctx.agentId ||
    run.channelId !== ctx.channelId ||
    (ctx.threadRootId !== undefined && run.threadRootId !== ctx.threadRootId) ||
    run.triggerMessageId !== ctx.triggerMessageId ||
    run.background ||
    run.workId ||
    run.brainSessionId ||
    run.pendingMessageIds.length ||
    agent.operatorHoldAt ||
    agent.deletedAt ||
    agent.archivedAt ||
    channel.archivedAt ||
    trigger.deletedAt ||
    trigger.meta.readOutside === true
  )
    return null;
  const capture = (run.transcript as { publicationCapture?: PublicationCapture } | null)?.publicationCapture;
  if (
    !capture ||
    capture.version !== 2 ||
    !capture.complete ||
    capture.channelId !== channel.id ||
    capture.triggerMessageId !== trigger.id ||
    capture.configurationHash !== publicationConfigurationHash(org, agent) ||
    !Array.isArray(capture.sources) ||
    capture.sources.length > 100
  )
    return null;
  const captured = await db
    .select()
    .from(schema.messages)
    .where(and(eq(schema.messages.orgId, ctx.orgId), eq(schema.messages.channelId, channel.id)));
  for (const source of capture.sources) {
    const row = captured.find((m) => m.id === source.id);
    if (!row || row.deletedAt || publicationMessageHash(row) !== source.hash || row.meta.readOutside === true)
      return null;
  }
  // New human input is a new source. Only this flow's fixed server card may join the original horizon.
  if (captured.some((m) => m.authorType !== "agent" && !capture.sources.some((s) => s.id === m.id))) return null;
  if (captured.some((m) => m.authorType === "agent" && m.authorAgentId !== ctx.agentId)) return null;
  const [assignment] = await db
    .select()
    .from(schema.agentSkills)
    .where(
      and(
        eq(schema.agentSkills.orgId, ctx.orgId),
        eq(schema.agentSkills.agentId, ctx.agentId),
        eq(schema.agentSkills.skillId, skill.id),
        eq(schema.agentSkills.enabled, true),
      ),
    );
  if (!assignment || !isAllowed(toolAccess(await freshGrantedKeys(db, ctx.orgId, ctx.agentId), TOOL))) return null;
  const resources = await db
    .select()
    .from(schema.skillFiles)
    .where(
      and(
        eq(schema.skillFiles.orgId, ctx.orgId),
        eq(schema.skillFiles.skillId, skill.id),
        eq(schema.skillFiles.version, skill.version),
      ),
    );
  const steps = await db
    .select()
    .from(schema.agentRunSteps)
    .where(and(eq(schema.agentRunSteps.orgId, ctx.orgId), eq(schema.agentRunSteps.runId, ctx.runId)))
    .orderBy(schema.agentRunSteps.seq)
    .limit(513);
  if (steps.length > 512) return null;
  const calls = steps
    .filter((s) => s.kind === "tool_call")
    .map((s) => ({
      id: s.data.toolUseId,
      name: s.data.name,
      input: s.data.input,
      result: steps.find(
        (r) =>
          r.kind === "tool_result" &&
          r.seq > s.seq &&
          r.data.toolUseId === s.data.toolUseId &&
          r.data.name === s.data.name,
      )?.data,
    }));
  let loaded = false;
  const sources: unknown[] = [...capture.sources];
  for (const call of calls) {
    if (call.name === TOOL.name && call.id === ctx.toolUseId) continue;
    if (
      !call.result ||
      call.result.external ||
      (call.result.data as { outside?: unknown } | undefined)?.outside === true
    )
      return null;
    if (call.result.isError) {
      if (
        channel.kind === "channel" &&
        channel.visibility === "public" &&
        ["load_skill", "read_skill_file", "update_skill"].includes(String(call.name))
      )
        continue;
      return null;
    }
    const params = call.input as Record<string, unknown>;
    if (call.name === "load_skill" && params.name === skill.slug) {
      const loadedSkill = (call.result.data as { skill?: { id?: string; version?: number } } | undefined)?.skill;
      if (loadedSkill?.id !== skill.id || (channel.kind === "dm" && !viewOnly && loadedSkill.version !== skill.version))
        return null;
      loaded = true;
      continue;
    }
    if (call.name === "update_skill" && channel.kind === "channel" && channel.visibility === "public") continue;
    if (
      call.name === "read_skill_file" &&
      params.name === skill.slug &&
      channel.kind === "channel" &&
      channel.visibility === "public"
    )
      continue;
    if (call.name === "expand" && typeof params.item_id === "string") {
      const [item] = await db
        .select()
        .from(schema.contextItems)
        .where(and(eq(schema.contextItems.orgId, ctx.orgId), eq(schema.contextItems.id, params.item_id)));
      const delivered = (call.result.data as { publicationSource?: { id?: unknown; hash?: unknown } } | undefined)
        ?.publicationSource;
      if (
        !item?.content ||
        item.status !== "active" ||
        item.supersededBy ||
        item.trust !== "high" ||
        !item.verified ||
        item.disputed ||
        delivered?.id !== item.id ||
        delivered.hash !== publicationItemHash(item)
      )
        return null;
      sources.push({ id: item.id, hash: delivered.hash });
      if (
        channel.kind !== "dm" ||
        item.createdByKind !== "person" ||
        item.createdById !== trigger.authorUserId ||
        !personMayRead(item, trigger.authorUserId!, ctx.agentId) ||
        item.channelIds.length !== 1 ||
        item.channelIds[0] !== channel.id ||
        item.sourceIds.some((id) => id !== trigger.id)
      )
        return null;
      continue;
    }
    return null;
  }
  if (!loaded) return null;
  if (channel.kind === "channel" && channel.visibility === "public") return { kind: "public" as const, skill };
  if (
    (!viewOnly && !["running", "waiting_approval"].includes(run.status)) ||
    !ctx.toolUseId ||
    agent.builtin ||
    skill.locked ||
    (skill.origin === "agent" && skill.ownerAgentId !== ctx.agentId) ||
    typeof input.body !== "string" ||
    !input.body.trim() ||
    (Array.isArray(input.files) && input.files.length) ||
    channel.kind !== "dm" ||
    trigger.authorType !== "person" ||
    !trigger.authorUserId ||
    trigger.threadId ||
    ctx.threadRootId !== trigger.id ||
    capture.sources.length !== 1 ||
    capture.sources[0]?.id !== trigger.id ||
    resources.length
  )
    return null;
  const owner = trigger.authorUserId;
  const members = await db
    .select()
    .from(schema.channelMembers)
    .where(and(eq(schema.channelMembers.orgId, ctx.orgId), eq(schema.channelMembers.channelId, channel.id)));
  if (
    members.filter((m) => m.userId).length !== 1 ||
    !members.some((m) => m.userId === owner) ||
    members.filter((m) => m.agentId).length !== 1 ||
    !members.some((m) => m.agentId === ctx.agentId)
  )
    return null;
  const membership = await getMembership(db, owner, ctx.orgId);
  if (
    !membership ||
    workRefusal(membership.standing) ||
    !can(membership, "manage_agents") ||
    !(await readableChannelIds(db, ctx.orgId, owner, [channel.id])).has(channel.id)
  )
    return null;
  return {
    kind: "private" as const,
    owner,
    skill,
    captureHash: hash(capture),
    sourcesHash: hash(sources),
    audienceHash: hash([channel.id, owner, ctx.agentId]),
    resourcesHash: hash([]),
  };
}

export async function privatePublicationFacts(ctx: ToolContext, input: Record<string, unknown>, viewOnly = false) {
  try {
    return await readPrivatePublicationFacts(ctx, input, viewOnly);
  } catch {
    return null;
  }
}
const fingerprint = (params: Record<string, unknown>) =>
  actionHash({ tool: TOOL.name, scope: TOOL.scope, connectionId: null, params });
export async function classifySkillPublication(ctx: ToolContext, input: Record<string, unknown>) {
  const facts = await privatePublicationFacts(ctx, input);
  if (!facts) return defer();
  if (facts.kind === "public") return { kind: "ordinary" as const };
  return { kind: "private" as const, facts };
}
export async function issuePrivatePublication(ctx: ToolContext, input: Record<string, unknown>, now = new Date()) {
  const facts = await privatePublicationFacts(ctx, input);
  if (facts?.kind !== "private" || !ctx.toolUseId) throw new ValidationError(PRIVATE_PUBLICATION_DEFER);
  const [existing] = await ctx.db
    .select()
    .from(schema.approvals)
    .where(
      and(
        eq(schema.approvals.orgId, ctx.orgId),
        eq(schema.approvals.runId, ctx.runId),
        eq(schema.approvals.toolUseId, ctx.toolUseId),
      ),
    );
  const issued = existing?.createdAt ?? now;
  const envelope: NativePublicationEnvelope = {
    contract: PRIVATE_PUBLICATION,
    input: { name: facts.skill.slug, body: String(input.body).trim() },
    publication: {
      orgId: ctx.orgId,
      agentId: ctx.agentId,
      runId: ctx.runId,
      channelId: ctx.channelId,
      threadRootId: ctx.threadRootId,
      triggerMessageId: ctx.triggerMessageId,
      toolUseId: ctx.toolUseId,
      ownerUserId: facts.owner,
      skillId: facts.skill.id,
      baseVersion: facts.skill.version,
      baseHash: sha256(facts.skill.body),
      resourcesHash: facts.resourcesHash,
      sourcesHash: facts.sourcesHash,
      audienceHash: facts.audienceHash,
      captureHash: facts.captureHash,
      purpose: "publish_to_org_skill_library",
      issuedAt: issued.toISOString(),
      expiresAt: new Date(issued.getTime() + 600_000).toISOString(),
    },
  };
  const [row] = await ctx.db
    .insert(schema.approvals)
    .values({
      tool: TOOL.name,
      scope: TOOL.scope,
      connectionId: null,
      orgId: ctx.orgId,
      agentId: ctx.agentId,
      runId: ctx.runId,
      channelId: ctx.channelId,
      threadRootId: ctx.threadRootId,
      toolUseId: ctx.toolUseId,
      params: envelope,
      actionHash: fingerprint(envelope),
      title: PRIVATE_PUBLICATION_TITLE,
      detail: "",
      why: "Explicit one-time sharing decision required.",
      ownerUserId: facts.owner,
      requestedByUserId: facts.owner,
      createdAt: issued,
      expiresAt: new Date(envelope.publication.expiresAt),
      approvers: {
        userIds: [facts.owner],
        label: "original source owner",
        requestedBy: facts.owner,
        requesterDecides: true,
        required: true,
      },
      highRisk: true,
    })
    .onConflictDoNothing()
    .returning();
  if (row) return row;
  const [prior] = await ctx.db
    .select()
    .from(schema.approvals)
    .where(
      and(
        eq(schema.approvals.orgId, ctx.orgId),
        eq(schema.approvals.runId, ctx.runId),
        eq(schema.approvals.toolUseId, ctx.toolUseId),
      ),
    );
  if (!prior || !isPrivatePublication(prior) || prior.actionHash !== fingerprint(envelope))
    throw new ConflictError("The sharing request changed; start a fresh request.");
  return prior;
}

export async function privatePublicationBinding(db: Database, row: Approval, viewerId?: string, exactBase = true) {
  if (
    !isNativePrivatePublication(row) ||
    row.tool !== TOOL.name ||
    row.connectionId !== null ||
    !row.runId ||
    row.scope !== TOOL.scope ||
    row.missionId ||
    row.missionTaskId ||
    row.routineId ||
    row.runAt ||
    row.approveAlways
  )
    return null;
  const p = row.params as unknown as NativePublicationEnvelope;
  if (!p.publication || !p.input || row.actionHash !== fingerprint(row.params)) return null;
  const b = p.publication;
  if (
    canonicalJson(row.approvers) !==
    canonicalJson({
      userIds: [b.ownerUserId],
      label: "original source owner",
      requestedBy: b.ownerUserId,
      requesterDecides: true,
      required: true,
    })
  )
    return null;
  if (
    b.orgId !== row.orgId ||
    b.agentId !== row.agentId ||
    b.runId !== row.runId ||
    b.channelId !== row.channelId ||
    b.threadRootId !== row.threadRootId ||
    b.toolUseId !== row.toolUseId ||
    b.ownerUserId !== row.ownerUserId ||
    b.ownerUserId !== row.requestedByUserId ||
    b.purpose !== "publish_to_org_skill_library" ||
    b.issuedAt !== row.createdAt.toISOString() ||
    b.expiresAt !== row.expiresAt.toISOString() ||
    (viewerId !== undefined && viewerId !== b.ownerUserId)
  )
    return null;
  const facts = await privatePublicationFacts(
    {
      db,
      orgId: row.orgId,
      agentId: row.agentId,
      runId: row.runId,
      channelId: row.channelId,
      threadRootId: row.threadRootId,
      triggerMessageId: b.triggerMessageId,
      toolUseId: row.toolUseId,
    },
    p.input,
    !exactBase,
  );
  if (
    facts?.kind !== "private" ||
    facts.owner !== b.ownerUserId ||
    facts.skill.id !== b.skillId ||
    facts.captureHash !== b.captureHash ||
    facts.sourcesHash !== b.sourcesHash ||
    facts.audienceHash !== b.audienceHash ||
    facts.resourcesHash !== b.resourcesHash ||
    (exactBase && (facts.skill.version !== b.baseVersion || sha256(facts.skill.body) !== b.baseHash))
  )
    return null;
  return { envelope: p, facts };
}
export async function mayViewPrivatePublication(db: Database, row: Approval, actorId: string) {
  return !!(await privatePublicationBinding(db, row, actorId, false));
}
export async function requirePrivatePublicationDecision(
  db: Database,
  row: Approval,
  actorId: string,
  fingerprint?: string,
) {
  const found = await privatePublicationBinding(db, row, actorId);
  if (!found || fingerprint !== row.actionHash || row.expiresAt <= new Date())
    throw new ForbiddenError("This exact sharing request is unavailable.");
  return found;
}

/** Lock order: run -> approval -> skill -> org/agent/channel/ACL/source rows. No network or blob IO here. */
export async function claimPrivatePublication(db: Database, ctx: ToolContext, skillId: string, body: string) {
  const id = ctx.privatePublicationApprovalId;
  if (!id) throw new ForbiddenError(PRIVATE_PUBLICATION_DEFER);
  await db
    .select()
    .from(schema.agentRuns)
    .where(and(eq(schema.agentRuns.orgId, ctx.orgId), eq(schema.agentRuns.id, ctx.runId)))
    .for("update");
  const [row] = await db
    .select()
    .from(schema.approvals)
    .where(and(eq(schema.approvals.orgId, ctx.orgId), eq(schema.approvals.id, id)))
    .for("update");
  await db
    .select()
    .from(schema.skills)
    .where(and(eq(schema.skills.orgId, ctx.orgId), eq(schema.skills.id, skillId)))
    .for("update");
  if (
    !row ||
    row.runId !== ctx.runId ||
    row.agentId !== ctx.agentId ||
    row.channelId !== ctx.channelId ||
    row.threadRootId !== ctx.threadRootId ||
    row.toolUseId !== ctx.toolUseId ||
    row.status !== "approved" ||
    row.executedAt ||
    row.expiresAt <= new Date() ||
    row.decidedByUserId !== row.ownerUserId ||
    row.decidedForUserId ||
    !row.decidedAt ||
    row.decidedAt < row.createdAt ||
    row.decidedAt > new Date()
  )
    throw new ConflictError("This exact sharing approval cannot execute.");
  await db.select().from(schema.organizations).where(eq(schema.organizations.id, ctx.orgId)).for("share");
  await db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, ctx.orgId), eq(schema.agents.id, ctx.agentId)))
    .for("update");
  await db
    .select()
    .from(schema.channels)
    .where(and(eq(schema.channels.orgId, ctx.orgId), eq(schema.channels.id, ctx.channelId)))
    .for("update");
  await db
    .select()
    .from(schema.channelMembers)
    .where(and(eq(schema.channelMembers.orgId, ctx.orgId), eq(schema.channelMembers.channelId, ctx.channelId)))
    .for("share");
  await db.select().from(schema.users).where(eq(schema.users.id, row.ownerUserId!)).for("share");
  await db
    .select()
    .from(schema.organizationMembers)
    .where(
      and(eq(schema.organizationMembers.orgId, ctx.orgId), eq(schema.organizationMembers.userId, row.ownerUserId!)),
    )
    .for("share");
  await db.execute(
    sql`select 1 from organization_member_roles where org_id=${ctx.orgId}::uuid and user_id=${row.ownerUserId} for share`,
  );
  await db.execute(sql`select 1 from org_roles where org_id=${ctx.orgId}::uuid for share`);
  await db
    .select()
    .from(schema.agentScopes)
    .where(and(eq(schema.agentScopes.orgId, ctx.orgId), eq(schema.agentScopes.agentId, ctx.agentId)))
    .for("share");
  await db
    .select()
    .from(schema.agentSkills)
    .where(
      and(
        eq(schema.agentSkills.orgId, ctx.orgId),
        eq(schema.agentSkills.agentId, ctx.agentId),
        eq(schema.agentSkills.skillId, skillId),
      ),
    )
    .for("share");
  await db
    .select()
    .from(schema.messages)
    .where(and(eq(schema.messages.orgId, ctx.orgId), eq(schema.messages.channelId, ctx.channelId)))
    .for("share");
  // Bounded native expand receipts may refer only to this original owner's sources in this DM.
  await db
    .select()
    .from(schema.contextItems)
    .where(and(eq(schema.contextItems.orgId, ctx.orgId), eq(schema.contextItems.createdById, row.ownerUserId!)))
    .for("share");
  const bound = await privatePublicationBinding(db, row);
  if (!bound || bound.facts.skill.id !== skillId || bound.envelope.input.body !== body)
    throw new ConflictError("This exact sharing draft or its source changed.");
  const [claimed] = await db
    .update(schema.approvals)
    .set({ executedAt: new Date() })
    .where(
      and(eq(schema.approvals.id, id), eq(schema.approvals.status, "approved"), isNull(schema.approvals.executedAt)),
    )
    .returning({ id: schema.approvals.id });
  if (!claimed) throw new ConflictError("This sharing approval was already consumed.");
  return bound.facts.skill;
}

/** Generic counts exclude private rows; the owner's count is derived only from fresh protected views. */
export async function privatePublicationPendingCount(db: Database, orgId: string, actorId: string) {
  const rows = await db
    .select()
    .from(schema.approvals)
    .where(
      and(
        eq(schema.approvals.orgId, orgId),
        eq(schema.approvals.ownerUserId, actorId),
        eq(schema.approvals.status, "pending"),
        privatePublicationSql(),
      ),
    )
    .limit(501);
  if (rows.length > 500) return 0;
  let count = 0;
  for (const row of rows)
    if (row.expiresAt > new Date() && (await mayViewPrivatePublication(db, row, actorId))) count++;
  return count;
}

/** Internal callers cannot turn an ordinary ctx.approved or a forged approval id into publication consent. */
export async function preflightPrivatePublication(ctx: ToolContext, name: string, body: unknown) {
  if (!ctx.privatePublicationApprovalId || typeof body !== "string")
    throw new ForbiddenError(PRIVATE_PUBLICATION_DEFER);
  const [row] = await ctx.db
    .select()
    .from(schema.approvals)
    .where(and(eq(schema.approvals.orgId, ctx.orgId), eq(schema.approvals.id, ctx.privatePublicationApprovalId)));
  if (
    !row ||
    row.status !== "approved" ||
    row.executedAt ||
    row.expiresAt <= new Date() ||
    row.runId !== ctx.runId ||
    row.agentId !== ctx.agentId ||
    row.channelId !== ctx.channelId ||
    row.threadRootId !== ctx.threadRootId ||
    row.toolUseId !== ctx.toolUseId ||
    row.decidedByUserId !== row.ownerUserId ||
    row.decidedForUserId
  )
    throw new ForbiddenError(PRIVATE_PUBLICATION_DEFER);
  const bound = await privatePublicationBinding(ctx.db, row);
  if (
    !bound ||
    bound.envelope.input.name !== name ||
    bound.envelope.input.body !== body.trim() ||
    bound.envelope.publication.triggerMessageId !== ctx.triggerMessageId
  )
    throw new ForbiddenError(PRIVATE_PUBLICATION_DEFER);
}

/** Error messages from storage/Judge may contain query parameters; never echo them for a private draft. */
export async function privatePublicationFailure(ctx: ToolContext) {
  try {
    const [row] = await ctx.db
      .select()
      .from(schema.approvals)
      .where(
        and(
          eq(schema.approvals.id, ctx.privatePublicationApprovalId!),
          eq(schema.approvals.orgId, ctx.orgId),
          eq(schema.approvals.runId, ctx.runId),
          eq(schema.approvals.agentId, ctx.agentId),
        ),
      );
    if (
      row?.executedAt &&
      isNativePrivatePublication(row) &&
      (row.result as { content?: unknown } | null)?.content === "The exact approved skill draft was published."
    )
      return { content: "The exact approved skill draft was published." };
  } catch {
    /* Missing receipt is an unknown result, never permission to replay. */
  }
  return {
    content: "The sharing result could not be confirmed. Inspect the original approval before retrying.",
    isError: true,
  };
}
