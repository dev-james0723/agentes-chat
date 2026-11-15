import { and, type Database, eq, isNull, schema } from "@agenteschat/db";
import { readableChannelIds } from "./channels";
import { personMayRead } from "./context/items";
import { runCalls } from "./continuation";
import { sha256 } from "./crypto";
import { can, getMembership } from "./organizations";
import { workRefusal } from "./standing";
import { actionHash } from "./tools/gateway";
import { canonicalJson, validateJson } from "./tools/json-schema";
import { freshGrantedKeys, isAllowed, toolAccess } from "./tools/scopes";
import type { ToolContext } from "./tools/types";

/** An unregistered, read-only contract. Existing approval views MUST NOT receive these private params. */
export const PUBLICATION_CONTRACT = "skill-publication-v1";
const PURPOSE = "publish_to_org_skill_library";
const COVERAGE = "current-dm-and-recorded-expand-only";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TTL_MS = 10 * 60_000;
const TOOL = { name: "update_skill", scope: "skills:read", connectionId: null };
const inputSchema = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1, maxLength: 64 },
    body: { type: "string", minLength: 1, maxLength: 50_000 },
  },
  required: ["name", "body"],
  additionalProperties: false,
};
export type PublicationChange = {
  skillId: string;
  input: { name: string; body?: string; files?: { path: string; content: string }[] };
};
type Defer = { kind: "defer"; reason: "unsupported_or_invalid"; mayPublish: false };
const defer = (): Defer => ({ kind: "defer", reason: "unsupported_or_invalid", mayPublish: false });
const hash = (value: unknown) => sha256(canonicalJson(value));
type Source = { kind: "message" | "context_item"; id: string; hash: string; channels: string[] };

/** Exact future issuer wire contract. This module neither returns raw params nor inserts an approval. */
export interface SkillPublicationParameters extends Record<string, unknown> {
  contract: typeof PUBLICATION_CONTRACT;
  input: PublicationChange["input"];
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
    purpose: typeof PURPOSE;
    sourceCoverage: typeof COVERAGE;
    issuedAt: string;
    expiresAt: string;
  };
}

/**
 * Only a fresh direct single-person DM and its recorded native expand reads are presently supported.
 * Non-null transcript (untracked preloaded context), background/consultation, resources, other reads or owners
 * defer. This does NOT establish a general private-read ledger or change existing public/manual workflows.
 */
async function facts(ctx: ToolContext, change: PublicationChange) {
  if (
    !ctx.toolUseId ||
    ![ctx.orgId, ctx.agentId, ctx.runId, ctx.channelId, ctx.threadRootId, ctx.triggerMessageId, change.skillId].every(
      (id) => UUID.test(id),
    ) ||
    validateJson(inputSchema, change.input).length
  )
    return null;
  const db = ctx.db;
  const [[run], [agent], [skill], [channel], [trigger]] = await Promise.all([
    db
      .select()
      .from(schema.agentRuns)
      .where(and(eq(schema.agentRuns.orgId, ctx.orgId), eq(schema.agentRuns.id, ctx.runId))),
    db
      .select()
      .from(schema.agents)
      .where(
        and(eq(schema.agents.orgId, ctx.orgId), eq(schema.agents.id, ctx.agentId), isNull(schema.agents.archivedAt)),
      ),
    db
      .select()
      .from(schema.skills)
      .where(
        and(eq(schema.skills.orgId, ctx.orgId), eq(schema.skills.id, change.skillId), isNull(schema.skills.deletedAt)),
      ),
    db
      .select()
      .from(schema.channels)
      .where(
        and(
          eq(schema.channels.orgId, ctx.orgId),
          eq(schema.channels.id, ctx.channelId),
          isNull(schema.channels.archivedAt),
        ),
      ),
    db
      .select()
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.orgId, ctx.orgId),
          eq(schema.messages.id, ctx.triggerMessageId),
          isNull(schema.messages.deletedAt),
        ),
      ),
  ]);
  if (
    !run ||
    !agent ||
    !skill ||
    !channel ||
    !trigger ||
    run.agentId !== ctx.agentId ||
    run.channelId !== ctx.channelId ||
    run.threadRootId !== ctx.threadRootId ||
    run.triggerMessageId !== ctx.triggerMessageId
  )
    return null;
  if (
    agent.operatorHoldAt ||
    agent.deletedAt ||
    ctx.bridge ||
    run.brainSessionId ||
    trigger.meta.readOutside === true ||
    run.background ||
    run.transcript !== null ||
    run.pendingMessageIds.length ||
    !["running", "waiting_approval"].includes(run.status)
  )
    return null;
  if (
    channel.kind !== "dm" ||
    trigger.channelId !== channel.id ||
    trigger.authorType !== "person" ||
    !trigger.authorUserId ||
    trigger.threadId !== null ||
    ctx.threadRootId !== trigger.id
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
  if (!isAllowed(toolAccess(await freshGrantedKeys(db, ctx.orgId, ctx.agentId), TOOL))) return null;
  if (
    skill.slug !== change.input.name ||
    skill.locked ||
    (skill.origin === "agent" && skill.ownerAgentId !== ctx.agentId)
  )
    return null;
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
  // No blob metadata is misrepresented as a content hash. Nonempty resources need a future byte-reading adapter.
  if (!assignment || resources.length) return null;
  const results = await db
    .select()
    .from(schema.agentRunSteps)
    .where(
      and(
        eq(schema.agentRunSteps.orgId, ctx.orgId),
        eq(schema.agentRunSteps.runId, ctx.runId),
        eq(schema.agentRunSteps.kind, "tool_result"),
      ),
    );
  const loadedVersion = results.some(({ data }) => {
    const value = data.data as { skill?: { id?: string; version?: number } } | undefined;
    return (
      data.name === "load_skill" &&
      data.isError === false &&
      value?.skill?.id === skill.id &&
      value.skill.version === skill.version
    );
  });
  if (!loadedVersion) return null;
  const conversation = await db
    .select()
    .from(schema.messages)
    .where(and(eq(schema.messages.orgId, ctx.orgId), eq(schema.messages.channelId, channel.id)));
  if (conversation.length !== 1 || conversation[0]?.id !== trigger.id) return null;
  const sources: Source[] = [{ kind: "message", id: trigger.id, hash: sha256(trigger.body), channels: [channel.id] }];
  let loaded = false;
  const calls = await runCalls(db, { orgId: ctx.orgId, id: ctx.runId });
  for (const call of calls) {
    const input = call.input as Record<string, unknown> | null;
    if (!call.result || call.result.isError || call.result.external) return null;
    if (call.name === "load_skill" && input?.name === skill.slug) {
      loaded = true;
      continue;
    }
    if (call.name !== "expand" || typeof input?.item_id !== "string" || !UUID.test(input.item_id)) return null;
    const [item] = await db
      .select()
      .from(schema.contextItems)
      .where(and(eq(schema.contextItems.orgId, ctx.orgId), eq(schema.contextItems.id, input.item_id)));
    if (
      !item?.content ||
      !call.result.content.includes(item.content) ||
      item.createdByKind !== "person" ||
      item.createdById !== owner ||
      item.status !== "active" ||
      item.supersededBy ||
      !personMayRead(item, owner, ctx.agentId) ||
      item.channelIds.length !== 1 ||
      item.channelIds[0] !== channel.id ||
      item.sourceIds.some((id) => id !== trigger.id)
    )
      return null;
    sources.push({
      kind: "context_item",
      id: item.id,
      hash: hash({
        content: item.content,
        version: item.version,
        sourceIds: item.sourceIds,
        agentId: item.agentId,
        scopeType: item.scopeType,
        scopeId: item.scopeId,
      }),
      channels: [channel.id],
    });
  }
  if (!loaded) return null;
  return {
    owner,
    skill,
    sourcesHash: hash(sources.sort((a, b) => a.id.localeCompare(b.id))),
    audienceHash: hash({ channelId: channel.id, ownerUserId: owner, agentId: ctx.agentId }),
  };
}

async function parameters(
  ctx: ToolContext,
  change: PublicationChange,
  issued: Date,
): Promise<SkillPublicationParameters | null> {
  if (!Number.isFinite(issued.getTime())) return null;
  const found = await facts(ctx, change);
  if (!found || !ctx.toolUseId) return null;
  return {
    contract: PUBLICATION_CONTRACT,
    input: change.input,
    publication: {
      orgId: ctx.orgId,
      agentId: ctx.agentId,
      runId: ctx.runId,
      channelId: ctx.channelId,
      threadRootId: ctx.threadRootId,
      triggerMessageId: ctx.triggerMessageId,
      toolUseId: ctx.toolUseId,
      ownerUserId: found.owner,
      skillId: found.skill.id,
      baseVersion: found.skill.version,
      baseHash: sha256(found.skill.body),
      resourcesHash: hash([]),
      sourcesHash: found.sourcesHash,
      audienceHash: found.audienceHash,
      purpose: PURPOSE,
      sourceCoverage: COVERAGE,
      issuedAt: issued.toISOString(),
      expiresAt: new Date(issued.getTime() + TTL_MS).toISOString(),
    },
  };
}
const fingerprint = (params: SkillPublicationParameters) =>
  actionHash({ tool: TOOL.name, scope: TOOL.scope, connectionId: null, params });

/** Opaque server-side preparation only. NEVER hand its corresponding raw draft to the existing broad approval API. */
export async function prepareSkillPublication(ctx: ToolContext, change: PublicationChange, now = new Date()) {
  const params = await parameters(ctx, change, now);
  return params
    ? {
        kind: "approval_required" as const,
        fingerprint: fingerprint(params),
        expiresAt: params.publication.expiresAt,
        mayPublish: false as const,
        wiring: "NOT_IMPLEMENTED" as const,
      }
    : defer();
}

async function boundRow(ctx: ToolContext, change: PublicationChange, id: string) {
  if (!UUID.test(id)) return null;
  const [row] = await ctx.db
    .select()
    .from(schema.approvals)
    .where(and(eq(schema.approvals.orgId, ctx.orgId), eq(schema.approvals.id, id)));
  if (
    !row ||
    row.agentId !== ctx.agentId ||
    row.runId !== ctx.runId ||
    row.channelId !== ctx.channelId ||
    row.threadRootId !== ctx.threadRootId ||
    row.toolUseId !== ctx.toolUseId ||
    row.tool !== TOOL.name ||
    row.scope !== TOOL.scope ||
    row.connectionId !== null ||
    row.missionId ||
    row.missionTaskId ||
    row.routineId ||
    row.runAt ||
    row.approveAlways
  )
    return null;
  const params = await parameters(ctx, change, row.createdAt);
  if (
    !params ||
    canonicalJson(row.params) !== canonicalJson(params) ||
    row.actionHash !== fingerprint(params) ||
    row.expiresAt.toISOString() !== params.publication.expiresAt
  )
    return null;
  const owner = params.publication.ownerUserId;
  const required = {
    userIds: [owner],
    label: "source owner",
    requestedBy: owner,
    requesterDecides: true,
    required: true,
  };
  if (
    canonicalJson(row.approvers) !== canonicalJson(required) ||
    row.ownerUserId !== owner ||
    row.requestedByUserId !== owner
  )
    return null;
  return { row, owner };
}

/**
 * Read the actual native DB row, not a model boolean or caller-supplied ApprovalRow. Even positive evidence never
 * authorizes execution: privacy-safe issuing/views/claim+skill-write transaction remain unimplemented.
 */
export async function verifySkillPublicationApproval(
  ctx: ToolContext,
  change: PublicationChange,
  approvalId: string,
  now = new Date(),
) {
  const found = await boundRow(ctx, change, approvalId);
  if (!found || !Number.isFinite(now.getTime())) return defer();
  const { row, owner } = found;
  if (
    row.status !== "approved" ||
    row.decidedByUserId !== owner ||
    row.decidedForUserId ||
    !row.decidedAt ||
    row.decidedAt < row.createdAt ||
    row.decidedAt > now ||
    row.createdAt > now ||
    row.expiresAt <= now ||
    row.executedAt !== null
  )
    return defer();
  return {
    kind: "verified_bounded_proof" as const,
    approvalId: row.id,
    fingerprint: row.actionHash,
    mayPublish: false as const,
    wiring: "NOT_IMPLEMENTED" as const,
  };
}

/** Opt-in future view predicate only. Does not change existing list/get/event/notification permissions. */
export async function mayViewSkillPublicationApproval(
  db: Database,
  orgId: string,
  approvalId: string,
  viewerId: string,
) {
  if (!UUID.test(orgId) || !UUID.test(approvalId)) return false;
  const [row] = await db
    .select()
    .from(schema.approvals)
    .where(and(eq(schema.approvals.orgId, orgId), eq(schema.approvals.id, approvalId)));
  if (!row?.runId || !row.params || typeof row.params !== "object" || Array.isArray(row.params)) return false;
  const p = row.params as Partial<SkillPublicationParameters>;
  if (
    p.contract !== PUBLICATION_CONTRACT ||
    !p.publication ||
    !p.input ||
    p.publication.ownerUserId !== viewerId ||
    typeof p.publication.skillId !== "string"
  )
    return false;
  const [run] = await db
    .select()
    .from(schema.agentRuns)
    .where(and(eq(schema.agentRuns.orgId, orgId), eq(schema.agentRuns.id, row.runId)));
  if (!run) return false;
  const ctx: ToolContext = {
    db,
    orgId,
    agentId: row.agentId,
    runId: run.id,
    channelId: run.channelId,
    threadRootId: run.threadRootId,
    triggerMessageId: run.triggerMessageId,
    toolUseId: row.toolUseId,
  };
  return (await boundRow(ctx, { skillId: p.publication.skillId, input: p.input }, row.id))?.owner === viewerId;
}
