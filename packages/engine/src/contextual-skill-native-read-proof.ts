import { and, type Database, eq, isNotNull, isNull, schema, sql } from "@agenteschat/db";
import { seesAgentDetails } from "./audience";
import { runAuthority, steeredByOf } from "./authority";
import { requireChannelAccess } from "./channels";
import {
  type NativeSkillReadEpoch,
  nativeSkillReadAuthorityFingerprint,
  nativeSkillReadEpoch,
  nativeSkillReadEpochFingerprint,
} from "./contextual-skill-native-read";
import { sha256 } from "./crypto";
import { requireActiveMembership } from "./organizations";
import { PRIVATE_PUBLICATION, privatePublicationBinding } from "./private-skill-publication";
import { taskReadersAmong } from "./task-access";
import { canonicalJson } from "./tools/json-schema";
import { freshGrantedKeys, isAllowed, toolAccess } from "./tools/scopes";
import type { ToolContext } from "./tools/types";

export const NATIVE_PUBLICATION_EXECUTION = "native-private-publication-executed/1";
export interface NativeSkillSourceSelection {
  orgId: string;
  skillId: string;
  version: number;
  operation: "load_skill" | "stored_text" | "folder_listing";
  path: string | null;
  rawSelectedBytesHash: string | null;
}
export interface NativeSkillSourceFacts {
  kind: "native_executed_org_publication";
  originalSourcePrivacy: "private";
  approvedReadAudience: "org_skill_library";
  approvalId: string;
  actionId: string;
  orgId: string;
  skillId: string;
  skillVersion: number;
  bodyHash: string;
  publisherAgentId: string;
  sourceOwnerId: string;
  originalRunId: string;
  sourceChannelId: string;
  sourceTriggerMessageId: string;
  sourceItemIds: readonly string[];
  readerAgentId: string;
  readerRunId: string;
  readerPersonId: string;
  readerAuthorityFingerprint: string;
  readerAuthorityEpoch: Readonly<NativeSkillReadEpoch>;
  readerAuthorityEpochFingerprint: string;
  readerVendorContext: "unknown_vendor_context" | "no_vendor_pointer";
  readerSteeredBy: string | null;
  taskId: string | null;
  sourceFingerprint: string;
  contextFingerprint: string;
  capabilityFingerprint: string;
}
declare const proofBrand: unique symbol;
export type NativeSkillSourceProof = { readonly [proofBrand]: true };
const proofs = new WeakMap<NativeSkillSourceProof, Readonly<NativeSkillSourceFacts>>();
export function nativeSkillSourceFacts(proof: unknown): Readonly<NativeSkillSourceFacts> | null {
  return proof && typeof proof === "object" ? (proofs.get(proof as NativeSkillSourceProof) ?? null) : null;
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const uuid = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);
const hash = (v: unknown) => sha256(canonicalJson(v));
const no = (reason: string) => ({ status: "unqualified" as const, reason });

/** Fresh native actor/assignment plus exact executed disclosure delta; original private sources never become public. */
export async function readNativeSkillSourceProof(db: Database, ctx: ToolContext, selected: NativeSkillSourceSelection) {
  try {
    if (
      ctx.signal?.aborted ||
      selected.orgId !== ctx.orgId ||
      ![ctx.orgId, ctx.agentId, ctx.runId, ctx.channelId, ctx.triggerMessageId, selected.skillId].every(uuid) ||
      selected.operation !== "load_skill" ||
      selected.path !== null ||
      !Number.isSafeInteger(selected.version) ||
      selected.version < 2 ||
      typeof selected.rawSelectedBytesHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(selected.rawSelectedBytesHash)
    )
      return no("selection_unqualified");
    const [[run], [agent], [skill], [assignment]] = await Promise.all([
      db
        .select()
        .from(schema.agentRuns)
        .where(and(eq(schema.agentRuns.orgId, ctx.orgId), eq(schema.agentRuns.id, ctx.runId))),
      db
        .select()
        .from(schema.agents)
        .where(and(eq(schema.agents.orgId, ctx.orgId), eq(schema.agents.id, ctx.agentId))),
      db
        .select()
        .from(schema.skills)
        .where(
          and(
            eq(schema.skills.orgId, ctx.orgId),
            eq(schema.skills.id, selected.skillId),
            isNull(schema.skills.deletedAt),
          ),
        ),
      db
        .select()
        .from(schema.agentSkills)
        .where(
          and(
            eq(schema.agentSkills.orgId, ctx.orgId),
            eq(schema.agentSkills.agentId, ctx.agentId),
            eq(schema.agentSkills.skillId, selected.skillId),
            eq(schema.agentSkills.enabled, true),
          ),
        ),
    ]);
    if (
      !run ||
      !agent ||
      !skill ||
      !assignment ||
      run.status !== "running" ||
      run.agentId !== ctx.agentId ||
      run.channelId !== ctx.channelId ||
      run.threadRootId !== ctx.threadRootId ||
      run.triggerMessageId !== ctx.triggerMessageId ||
      agent.deletedAt ||
      agent.archivedAt ||
      agent.operatorHoldAt ||
      skill.version !== selected.version ||
      sha256(skill.body) !== selected.rawSelectedBytesHash
    )
      return no("current_binding_changed");
    const actor = await runAuthority(db, run);
    const authorityEpoch = nativeSkillReadEpoch(run);
    const authorityEpochFingerprint = nativeSkillReadEpochFingerprint(run);
    if (!authorityEpoch || !authorityEpochFingerprint) return no("authority_epoch_unknown");
    if (actor.kind !== "person") return no("actor_unqualified");
    const membership = await requireActiveMembership(db, actor.personId, ctx.orgId);
    if (!seesAgentDetails(agent, actor.personId, membership)) return no("actor_unqualified");
    await requireChannelAccess(db, actor.personId, ctx.orgId, ctx.channelId);
    let taskState: unknown = null;
    if (run.issueId) {
      const [task] = await db
        .select({ id: schema.issues.id, status: schema.issues.status, updatedAt: schema.issues.updatedAt })
        .from(schema.issues)
        .where(and(eq(schema.issues.orgId, ctx.orgId), eq(schema.issues.id, run.issueId)));
      if (
        !task ||
        ["done", "canceled"].includes(task.status) ||
        !(await taskReadersAmong(db, task.id, [actor.personId])).includes(actor.personId)
      )
        return no("task_unqualified");
      taskState = task;
    }
    const keys = await freshGrantedKeys(db, ctx.orgId, ctx.agentId);
    if (!isAllowed(toolAccess(keys, { name: "load_skill", scope: "skills:read", connectionId: null })))
      return no("read_scope_denied");
    const resources = await db
      .select({ id: schema.skillFiles.id })
      .from(schema.skillFiles)
      .where(
        and(
          eq(schema.skillFiles.orgId, ctx.orgId),
          eq(schema.skillFiles.skillId, skill.id),
          eq(schema.skillFiles.version, skill.version),
        ),
      )
      .limit(1);
    if (resources.length) return no("resources_unqualified");
    // A legacy same-body publication or generic approved row is insufficient. The native writer must link both ways.
    const approvals = await db
      .select()
      .from(schema.approvals)
      .where(
        and(
          eq(schema.approvals.orgId, ctx.orgId),
          eq(schema.approvals.status, "approved"),
          isNotNull(schema.approvals.executedAt),
          sql`${schema.approvals.params}->>'contract' = ${PRIVATE_PUBLICATION}`,
          sql`${schema.approvals.params}->'publication'->>'skillId' = ${skill.id}`,
          sql`${schema.approvals.params}->'publication'->>'baseVersion' = ${String(skill.version - 1)}`,
        ),
      )
      .limit(2);
    if (approvals.length !== 1) return no("publication_execution_unknown");
    const approval = approvals[0]!;
    const result = approval.result;
    const data = object(result) && object(result.data) ? result.data : null;
    const link = data && object(data.nativePublicationExecution) ? data.nativePublicationExecution : null;
    if (
      !link ||
      link.contract !== NATIVE_PUBLICATION_EXECUTION ||
      link.approvalId !== approval.id ||
      !uuid(link.actionId) ||
      link.orgId !== ctx.orgId ||
      link.agentId !== approval.agentId ||
      link.runId !== approval.runId ||
      link.toolUseId !== approval.toolUseId ||
      link.skillId !== skill.id ||
      link.version !== skill.version ||
      link.bodyHash !== sha256(skill.body) ||
      data?.version !== skill.version ||
      !approval.executedAt ||
      !approval.decidedAt ||
      !approval.ownerUserId ||
      approval.decidedByUserId !== approval.ownerUserId ||
      approval.decidedForUserId ||
      approval.decidedAt < approval.createdAt ||
      approval.executedAt < approval.decidedAt ||
      approval.executedAt > approval.expiresAt
    )
      return no("publication_execution_unknown");
    const [action] = await db
      .select()
      .from(schema.agentActions)
      .where(and(eq(schema.agentActions.orgId, ctx.orgId), eq(schema.agentActions.id, link.actionId)));
    if (
      !action ||
      action.kind !== "skill.updated" ||
      action.targetType !== "skill" ||
      action.targetId !== skill.id ||
      action.runId !== approval.runId ||
      action.agentId !== approval.agentId ||
      action.channelId !== approval.channelId ||
      action.requestedByUserId !== approval.ownerUserId ||
      action.undoneAt ||
      !object(action.state.nativePublicationExecution) ||
      canonicalJson(action.state.nativePublicationExecution) !== canonicalJson(link) ||
      action.before?.version !== skill.version - 1 ||
      action.after?.version !== skill.version ||
      typeof action.after?.body !== "string" ||
      sha256(action.after.body) !== sha256(skill.body)
    )
      return no("execution_link_mismatch");
    // Historical publish completed: exactBase=false is required. It still checks the original source/capture/owner/ACL live.
    const binding = await privatePublicationBinding(db, approval, approval.ownerUserId, false);
    if (
      !binding ||
      binding.facts.skill.id !== skill.id ||
      binding.envelope.publication.baseVersion + 1 !== skill.version ||
      sha256(binding.envelope.input.body.trim()) !== sha256(skill.body)
    )
      return no("source_binding_changed");
    // Return source IDs only, not private bodies, for the claim's native row locks. The native binder above
    // already verified every expanded read and its current owner/source ACL; aliases/unknown reads defer there.
    const expanded = await db
      .select({ id: sql<string>`${schema.agentRunSteps.data}->'input'->>'item_id'` })
      .from(schema.agentRunSteps)
      .where(
        and(
          eq(schema.agentRunSteps.orgId, ctx.orgId),
          eq(schema.agentRunSteps.runId, approval.runId!),
          eq(schema.agentRunSteps.kind, "tool_call"),
          sql`${schema.agentRunSteps.data}->>'name' = 'expand'`,
        ),
      )
      .limit(513);
    if (expanded.length > 512 || expanded.some((row) => !uuid(row.id))) return no("source_binding_changed");
    const sourceItemIds = [...new Set(expanded.map((row) => row.id))].sort();
    const facts: NativeSkillSourceFacts = {
      kind: "native_executed_org_publication",
      originalSourcePrivacy: "private",
      approvedReadAudience: "org_skill_library",
      approvalId: approval.id,
      actionId: action.id,
      orgId: ctx.orgId,
      skillId: skill.id,
      skillVersion: skill.version,
      bodyHash: sha256(skill.body),
      publisherAgentId: approval.agentId,
      sourceOwnerId: approval.ownerUserId,
      originalRunId: approval.runId!,
      sourceChannelId: approval.channelId,
      sourceTriggerMessageId: binding.envelope.publication.triggerMessageId,
      sourceItemIds: Object.freeze(sourceItemIds),
      readerAgentId: ctx.agentId,
      readerRunId: run.id,
      readerPersonId: actor.personId,
      readerAuthorityFingerprint: nativeSkillReadAuthorityFingerprint(actor),
      readerAuthorityEpoch: authorityEpoch,
      readerAuthorityEpochFingerprint: authorityEpochFingerprint!,
      readerVendorContext: run.brainSessionId === null ? "no_vendor_pointer" : "unknown_vendor_context",
      readerSteeredBy: steeredByOf(run.transcript),
      taskId: run.issueId,
      sourceFingerprint: hash({
        approvalId: approval.id,
        actionId: action.id,
        execution: link,
        binding: binding.envelope.publication,
      }),
      contextFingerprint: hash({
        orgId: ctx.orgId,
        runId: run.id,
        channelId: run.channelId,
        threadId: run.threadRootId,
        triggerId: run.triggerMessageId,
        actor,
        taskState,
      }),
      capabilityFingerprint: hash({
        keys: [...keys].sort(),
        assignment: { id: assignment.id, enabled: assignment.enabled },
        agent: {
          id: agent.id,
          audienceMode: agent.audienceMode,
          userIds: agent.audienceUserIds,
          roleIds: agent.audienceRoleIds,
          archivedAt: agent.archivedAt,
          operatorHoldAt: agent.operatorHoldAt,
        },
      }),
    };
    const proof = Object.freeze({}) as NativeSkillSourceProof;
    proofs.set(proof, Object.freeze(facts));
    return { status: "verified" as const, kind: facts.kind, originalSourcePrivacy: "private" as const, proof };
  } catch {
    return no("native_source_unavailable");
  }
}
