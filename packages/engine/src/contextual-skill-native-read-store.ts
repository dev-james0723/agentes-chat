import { and, asc, type Database, eq, inArray, rowsOf, schema, sql } from "@agenteschat/db";
import { decideSkillAdmission, type SkillActivationEnvelopeV1 } from "./contextual-skill-admission";
import { nativeSkillReadBinding, nativeSkillReadSurface } from "./contextual-skill-native-read";
import { nativeSkillSourceFacts, readNativeSkillSourceProof } from "./contextual-skill-native-read-proof";
import { sha256 } from "./crypto";
import { canonicalJson } from "./tools/json-schema";
import { WHY_MAX_CHARS, WHY_MIN_CHARS } from "./tools/run-policy";
import type { ToolContext } from "./tools/types";

const POLICY = "native-skill-read/1";
/** The native audit keeps raw `why`; load/read schemas never own that field. Do not mutate that receipt or
 * discard unknown semantic arguments. Match Gateway takeWhy's bounded, trimmed metadata separately. */
function recordedNativeReadInput(tool: "load_skill" | "read_skill_file", raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  const fields = tool === "load_skill" ? ["name", "why"] : ["name", "path", "why"];
  if (
    Object.keys(input).some((k) => !fields.includes(k)) ||
    typeof input.name !== "string" ||
    input.name.length < 1 ||
    input.name.length > 64 ||
    (tool === "read_skill_file" && typeof input.path !== "string")
  )
    return null;
  if (
    Object.hasOwn(input, "why") &&
    (typeof input.why !== "string" ||
      input.why.trim().length < WHY_MIN_CHARS ||
      input.why.trim().length > WHY_MAX_CHARS ||
      input.why.length > WHY_MAX_CHARS)
  )
    return null;
  return { name: input.name, ...(tool === "read_skill_file" ? { path: input.path } : {}) };
}
const digest = (v: unknown) => sha256(canonicalJson(v));
export interface NativeSkillReadReceipt {
  activationId: string;
  runId: string;
  toolUseId: string;
  stepId: string;
  skillId: string;
  skillVersion: number;
  contentHash: string;
  state: "completed";
}
export type NativeSkillReadClaim =
  | { status: "claimed"; receipt: NativeSkillReadReceipt }
  | { status: "refused" | "replay"; reason: string; receipt?: NativeSkillReadReceipt };
interface Activation {
  id: string;
  org_id: string;
  agent_id: string;
  run_id: string;
  server_step_id: string;
  tool_use_id: string;
  binding_hash: string;
  skill_id: string;
  skill_version: number;
  content_hash: string;
  purpose_hash: string;
  source_proof_hash: string;
  surface_hash: string;
  envelope: SkillActivationEnvelopeV1;
  issued_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  used_count: number;
  state: string;
  completed_at: Date | null;
  result_hash: string | null;
}
const no = (reason: string): NativeSkillReadClaim => ({ status: "refused", reason });
const receipt = (a: Activation): NativeSkillReadReceipt => ({
  activationId: a.id,
  runId: a.run_id,
  toolUseId: a.tool_use_id,
  stepId: a.server_step_id,
  skillId: a.skill_id,
  skillVersion: a.skill_version,
  contentHash: a.content_hash,
  state: "completed",
});

/**
 * Only the actual native Gateway's private per-call handles enter. No IO/blob/model callbacks in the transaction.
 * Preliminary reads locate native identities only. Locks: reader+source runs (UUID order) -> activation ->
 * native publication approval -> skill -> org/agents/channels/member/role/scope/source rows, matching the native
 * publisher's run -> approval -> skill -> ACL/source order. Final proof runs AFTER the clock await; CAS checks
 * native mutable admission predicates again. This is not universal serializable ACL/phantom qualification.
 * No registration, issuing endpoint or automatic DDL.
 */
export async function claimNativeSkillRead(
  ctx: ToolContext,
  call: unknown,
  sealedSurface: unknown,
): Promise<NativeSkillReadClaim> {
  const b = nativeSkillReadBinding(ctx, call),
    s = nativeSkillReadSurface(ctx, call, sealedSurface);
  if (
    !b ||
    !s ||
    ctx.signal?.aborted ||
    s.selected.orgId !== ctx.orgId ||
    !s.flags.complete ||
    s.flags.truncated ||
    s.flags.omitted ||
    s.flags.sanitized ||
    b.toolName !== "load_skill" ||
    s.selected.operation !== "load_skill" ||
    s.selected.path !== null ||
    b.input.path !== undefined
  )
    return no("native_capture_unqualified");
  try {
    return await ctx.db.transaction(async (tx) => {
      const db = tx as unknown as Database;
      // Preliminary discovery only: do not acquire a reader-run lock before knowing the source run order.
      const [run] = await db
        .select()
        .from(schema.agentRuns)
        .where(and(eq(schema.agentRuns.orgId, ctx.orgId), eq(schema.agentRuns.id, ctx.runId)));
      if (!run || run.status !== "running" || run.agentId !== ctx.agentId || ctx.signal?.aborted)
        return no("run_unqualified");
      const [step] = await db
        .select()
        .from(schema.agentRunSteps)
        .where(
          and(
            eq(schema.agentRunSteps.orgId, ctx.orgId),
            eq(schema.agentRunSteps.runId, ctx.runId),
            eq(schema.agentRunSteps.id, b.stepId),
          ),
        );
      const recordedInput = step && recordedNativeReadInput(b.toolName, step.data.input);
      if (
        !step ||
        step.kind !== "tool_call" ||
        step.data.toolUseId !== b.toolUseId ||
        step.data.name !== b.toolName ||
        !recordedInput ||
        digest(recordedInput) !== b.inputHash
      )
        return no("native_step_mismatch");
      const [skill] = await db
        .select()
        .from(schema.skills)
        .where(and(eq(schema.skills.orgId, ctx.orgId), eq(schema.skills.id, s.selected.skillId)));
      if (!skill || skill.slug !== b.input.name.trim().toLowerCase()) return no("selected_skill_mismatch");
      // Preliminary fresh proof locates the actual native approval, never a model-selected approval ID.
      const selection = { ...s.selected, rawSelectedBytesHash: s.rawSelectedBytesHash };
      const preliminary = await readNativeSkillSourceProof(db, ctx, selection);
      if (preliminary.status !== "verified") return no("native_source_unqualified");
      const pf = nativeSkillSourceFacts(preliminary.proof);
      if (!pf) return no("native_source_unqualified");
      if (
        pf.readerAuthorityFingerprint !== b.authorityFingerprint ||
        pf.readerAuthorityEpochFingerprint !== b.nativeEpochFingerprint ||
        canonicalJson(pf.readerAuthorityEpoch) !== canonicalJson(b.nativeEpoch)
      )
        return no("native_authority_changed");
      // Both native run identities are DB-derived; deterministic order avoids opposing reader/source locks.
      const runIds = [...new Set([ctx.runId, pf.originalRunId])].sort();
      const lockedRuns = await db
        .select({ id: schema.agentRuns.id })
        .from(schema.agentRuns)
        .where(and(eq(schema.agentRuns.orgId, ctx.orgId), inArray(schema.agentRuns.id, runIds)))
        .orderBy(asc(schema.agentRuns.id))
        .for("update");
      if (lockedRuns.length !== runIds.length) return no("native_run_changed");
      await db
        .select({ id: schema.agentRunSteps.id })
        .from(schema.agentRunSteps)
        .where(and(eq(schema.agentRunSteps.orgId, ctx.orgId), eq(schema.agentRunSteps.id, b.stepId)))
        .for("share");
      const existing = rowsOf<Activation>(
        await db.execute(sql`select * from skill_read_activations
    where org_id=${ctx.orgId}::uuid and run_id=${ctx.runId}::uuid and tool_use_id=${b.toolUseId} for update`),
      )[0];
      // Native publication writer order is approval -> skill; do not invert it here.
      await db
        .select({ id: schema.approvals.id })
        .from(schema.approvals)
        .where(and(eq(schema.approvals.orgId, ctx.orgId), eq(schema.approvals.id, pf.approvalId)))
        .for("update");
      await db
        .select({ id: schema.skills.id })
        .from(schema.skills)
        .where(and(eq(schema.skills.orgId, ctx.orgId), eq(schema.skills.id, skill.id)))
        .for("update");
      // Native current ACL/source locks only; no new policy or model-supplied authority. This follows the
      // original publication claim's org -> agent -> channel -> member/role -> grants -> sources ordering.
      const agentIds = [...new Set([ctx.agentId, pf.publisherAgentId])].sort();
      const channelIds = [...new Set([ctx.channelId, pf.sourceChannelId])].sort();
      const personIds = [...new Set([pf.readerPersonId, pf.sourceOwnerId])].sort();
      await db
        .select({ id: schema.organizations.id })
        .from(schema.organizations)
        .where(eq(schema.organizations.id, ctx.orgId))
        .for("share");
      await db
        .select({ id: schema.agents.id })
        .from(schema.agents)
        .where(and(eq(schema.agents.orgId, ctx.orgId), inArray(schema.agents.id, agentIds)))
        .orderBy(asc(schema.agents.id))
        .for("share");
      await db
        .select({ id: schema.channels.id })
        .from(schema.channels)
        .where(and(eq(schema.channels.orgId, ctx.orgId), inArray(schema.channels.id, channelIds)))
        .orderBy(asc(schema.channels.id))
        .for("share");
      await db
        .select({ id: schema.channelMembers.id })
        .from(schema.channelMembers)
        .where(and(eq(schema.channelMembers.orgId, ctx.orgId), inArray(schema.channelMembers.channelId, channelIds)))
        .orderBy(asc(schema.channelMembers.id))
        .for("share");
      await db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(inArray(schema.users.id, personIds))
        .orderBy(asc(schema.users.id))
        .for("share");
      await db
        .select({ userId: schema.organizationMembers.userId })
        .from(schema.organizationMembers)
        .where(
          and(eq(schema.organizationMembers.orgId, ctx.orgId), inArray(schema.organizationMembers.userId, personIds)),
        )
        .orderBy(asc(schema.organizationMembers.userId))
        .for("share");
      for (const personId of personIds)
        await db.execute(
          sql`select 1 from organization_member_roles where org_id=${ctx.orgId}::uuid and user_id=${personId} order by role_id for share`,
        );
      await db.execute(sql`select 1 from org_roles where org_id=${ctx.orgId}::uuid order by id for share`);
      await db
        .select({ id: schema.agentScopes.id })
        .from(schema.agentScopes)
        .where(and(eq(schema.agentScopes.orgId, ctx.orgId), inArray(schema.agentScopes.agentId, agentIds)))
        .orderBy(asc(schema.agentScopes.id))
        .for("share");
      await db
        .select({ id: schema.agentSkills.id })
        .from(schema.agentSkills)
        .where(
          and(
            eq(schema.agentSkills.orgId, ctx.orgId),
            inArray(schema.agentSkills.agentId, agentIds),
            eq(schema.agentSkills.skillId, skill.id),
          ),
        )
        .orderBy(asc(schema.agentSkills.id))
        .for("share");
      // The native private binder checks the entire original DM horizon, not only a guessed latest message.
      await db
        .select({ id: schema.messages.id })
        .from(schema.messages)
        .where(and(eq(schema.messages.orgId, ctx.orgId), eq(schema.messages.channelId, pf.sourceChannelId)))
        .orderBy(asc(schema.messages.id))
        .for("share");
      if (pf.sourceItemIds.length)
        await db
          .select({ id: schema.contextItems.id })
          .from(schema.contextItems)
          .where(and(eq(schema.contextItems.orgId, ctx.orgId), inArray(schema.contextItems.id, [...pf.sourceItemIds])))
          .orderBy(asc(schema.contextItems.id))
          .for("share");
      if (pf.taskId)
        await db
          .select({ id: schema.issues.id })
          .from(schema.issues)
          .where(and(eq(schema.issues.orgId, ctx.orgId), eq(schema.issues.id, pf.taskId)))
          .for("share");
      const clock = rowsOf<{ now: number }>(
        await db.execute(sql`select floor(extract(epoch from clock_timestamp()) * 1000)::float8 as now`),
      )[0];
      const now = clock?.now;
      if (typeof now !== "number" || !Number.isSafeInteger(now)) return no("native_clock_unknown");
      // Last full native source/owner/reader check is after ALL lock and clock awaits. No borrowed earlier
      // allowed flag can survive a same-TX membership/source mutation at that boundary.
      const current = await readNativeSkillSourceProof(db, ctx, selection);
      if (current.status !== "verified") return no("native_source_changed");
      const f = nativeSkillSourceFacts(current.proof);
      if (!f || digest(f) !== digest(pf) || ctx.signal?.aborted) return no("native_source_changed");
      if (
        f.readerAuthorityFingerprint !== b.authorityFingerprint ||
        f.readerAuthorityEpochFingerprint !== b.nativeEpochFingerprint ||
        canonicalJson(f.readerAuthorityEpoch) !== canonicalJson(b.nativeEpoch)
      )
        return no("native_authority_changed");
      // Retry step UUID may differ; the first call keeps its UUID and no retry gets bytes again.
      const bindingHash = digest({
        orgId: b.orgId,
        agentId: b.agentId,
        runId: b.runId,
        toolUseId: b.toolUseId,
        toolName: b.toolName,
        inputHash: b.inputHash,
        authorityFingerprint: b.authorityFingerprint,
        nativeEpochFingerprint: b.nativeEpochFingerprint,
      });
      const sourceHash = digest(f),
        surfaceHash = digest(s);
      const purposeHash = digest({
        tool: b.toolName,
        input: b.input,
        selected: s.selected,
        manifestDigest: s.manifestDigest,
      });
      const authority = {
        kind: "person" as const,
        personId: f.readerPersonId,
        routineId: null,
        fingerprint: f.readerAuthorityFingerprint,
      };
      const initial: SkillActivationEnvelopeV1 = {
        schemaVersion: 1,
        id: Bun.randomUUIDv7(),
        orgId: ctx.orgId,
        agentId: ctx.agentId,
        runId: ctx.runId,
        taskId: f.taskId,
        sessionId: null,
        authority,
        skillId: skill.id,
        skillVersion: s.selected.version,
        contentHash: s.contentHash,
        scope: { kind: "run", id: ctx.runId },
        approvalId: null,
        purposeHash,
        contextVersion: f.contextFingerprint,
        capabilityVersion: f.capabilityFingerprint,
        policyVersion: POLICY,
        issuedAt: now,
        expiresAt: now + 300_000,
        revokedAt: null,
        maxUses: 1,
        usedCount: 0,
      };
      if (
        existing &&
        (existing.agent_id !== ctx.agentId ||
          existing.binding_hash !== bindingHash ||
          existing.skill_id !== skill.id ||
          existing.skill_version !== s.selected.version ||
          existing.content_hash !== s.contentHash ||
          existing.purpose_hash !== purposeHash ||
          existing.source_proof_hash !== sourceHash ||
          existing.surface_hash !== surfaceHash)
      )
        return no("logical_call_conflict");
      if (existing && (existing.revoked_at !== null || new Date(existing.expires_at).getTime() <= now))
        return no("activation_unavailable");
      // Completed/unknown-delivery means receipt only. Never reinterpret uses exhaustion as permission to remint.
      if (existing?.state === "completed") {
        if (existing.used_count !== 1 || existing.result_hash !== s.contentHash) return no("activation_corrupt");
        return { status: "replay", reason: "already_consumed_no_content", receipt: receipt(existing) };
      }
      const e = existing?.envelope ?? initial;
      if (
        existing &&
        (e.id !== existing.id ||
          e.issuedAt !== new Date(existing.issued_at).getTime() ||
          e.expiresAt !== new Date(existing.expires_at).getTime() ||
          e.usedCount !== existing.used_count ||
          e.revokedAt !== null ||
          existing.state !== "issued")
      )
        return no("activation_corrupt");
      const decision = decideSkillAdmission(e, {
        schemaVersion: 1,
        serverNow: now,
        checkedAt: now,
        maxAgeMs: 1,
        envelopeVerified: true,
        orgId: ctx.orgId,
        agentId: ctx.agentId,
        runId: ctx.runId,
        taskId: f.taskId,
        sessionId: null,
        authority,
        runStatus: "running",
        taskState: f.taskId ? "open" : "none",
        sessionState: "none",
        actorAllowed: true,
        agentArchived: false,
        assignmentEnabled: true,
        skillDeleted: false,
        skillId: skill.id,
        skillVersion: s.selected.version,
        contentHash: s.contentHash,
        purposeHash,
        underlyingAuthority: "allowed",
        contextVersion: f.contextFingerprint,
        capabilityVersion: f.capabilityFingerprint,
        policyVersion: POLICY,
        requiresOwnerApproval: false,
        approval: null,
      });
      if (decision.decision !== "ALLOW") return no(`admission_${decision.reason}`);
      if (!existing)
        await db.execute(sql`insert into skill_read_activations
    (id,org_id,agent_id,run_id,server_step_id,tool_use_id,binding_hash,skill_id,skill_version,content_hash,purpose_hash,
      source_proof_hash,surface_hash,envelope,issued_at,expires_at)
    values (${e.id}::uuid,${ctx.orgId}::uuid,${ctx.agentId}::uuid,${ctx.runId}::uuid,${b.stepId}::uuid,${b.toolUseId},
      ${bindingHash},${skill.id}::uuid,${s.selected.version},${s.contentHash},${purposeHash},${sourceHash},${surfaceHash},
      ${JSON.stringify(e)}::jsonb,to_timestamp(${e.issuedAt}/1000.0),to_timestamp(${e.expiresAt}/1000.0))`);
      const [claimed] = rowsOf<Activation>(
        await db.execute(sql`update skill_read_activations
    set used_count=1,state='completed',completed_at=clock_timestamp(),result_hash=content_hash
    where id=${e.id}::uuid and used_count=0 and state='issued' and revoked_at is null and expires_at>clock_timestamp()
      and binding_hash=${bindingHash} and content_hash=${s.contentHash} and purpose_hash=${purposeHash}
      and exists (select 1 from agent_runs r where r.org_id=${ctx.orgId}::uuid and r.id=${ctx.runId}::uuid
        and r.agent_id=${ctx.agentId}::uuid and r.status='running'
        and r.channel_id=${ctx.channelId}::uuid and r.thread_root_id=${ctx.threadRootId}::uuid
        and r.trigger_message_id=${ctx.triggerMessageId}::uuid
        and r.background=${b.nativeEpoch.background}
        and r.work_id is not distinct from ${b.nativeEpoch.workId}::uuid
        and r.issue_id is not distinct from ${b.nativeEpoch.issueId}::uuid
        and r.brain_session_id is not distinct from ${b.nativeEpoch.brainSessionId}
        and coalesce(r.transcript ? 'steeredBy',false)=${b.nativeEpoch.steeredByPresent}
        and r.transcript->>'steeredBy' is not distinct from ${b.nativeEpoch.steeredBy}
        and to_jsonb(r.pending_message_ids)=${JSON.stringify(b.nativeEpoch.pendingMessageIds)}::jsonb)
      and exists (select 1 from agents a where a.org_id=${ctx.orgId}::uuid and a.id=${ctx.agentId}::uuid
        and a.deleted_at is null and a.archived_at is null and a.operator_hold_at is null)
      and exists (select 1 from organization_members m where m.org_id=${ctx.orgId}::uuid and m.user_id=${f.readerPersonId})
      and exists (select 1 from organization_members m where m.org_id=${ctx.orgId}::uuid and m.user_id=${f.sourceOwnerId})
      and exists (select 1 from messages m where m.org_id=${ctx.orgId}::uuid and m.id=${f.sourceTriggerMessageId}::uuid
        and m.channel_id=${f.sourceChannelId}::uuid and m.deleted_at is null)
      and exists (select 1 from agent_skills a where a.org_id=${ctx.orgId}::uuid and a.agent_id=${ctx.agentId}::uuid
        and a.skill_id=${skill.id}::uuid and a.enabled=true)
      and exists (select 1 from skills k where k.org_id=${ctx.orgId}::uuid and k.id=${skill.id}::uuid
        and k.version=${s.selected.version} and k.deleted_at is null)
      and exists (select 1 from approvals p join agent_actions a on a.org_id=p.org_id and a.id=${f.actionId}::uuid
        where p.org_id=${ctx.orgId}::uuid and p.id=${f.approvalId}::uuid and p.status='approved' and p.executed_at is not null
          and a.undone_at is null and a.target_id=${skill.id})
    returning *`),
      );
      if (!claimed) return no("claim_lost");
      const updated = await db
        .update(schema.skills)
        .set({ useCount: sql`${schema.skills.useCount}+1`, lastUsedAt: sql`clock_timestamp()` })
        .where(
          and(
            eq(schema.skills.orgId, ctx.orgId),
            eq(schema.skills.id, skill.id),
            eq(schema.skills.version, s.selected.version),
          ),
        )
        .returning({ id: schema.skills.id });
      if (updated.length !== 1 || ctx.signal?.aborted) throw new Error("The admitted read changed before commit.");
      return { status: "claimed", receipt: receipt(claimed) };
    });
  } catch {
    return no("native_claim_unavailable");
  }
}

export interface NativeSkillReadRevocationBinding {
  orgId: string;
  agentId: string;
  runId: string;
}
/** Internal narrowing hook, never a model tool. Native settings/run-end services own the caller and scope.
 * It can only revoke existing matching rows: no new envelope, no content, no resurrection/usage reset.
 * Hook registration is a separate source-owner responsibility; this export alone does not qualify revocation UX.
 */
export async function revokeNativeSkillReads(
  db: Database,
  binding: NativeSkillReadRevocationBinding,
): Promise<{ revoked: number }> {
  const uuid = (v: unknown) => typeof v === "string" && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);
  if (![binding.orgId, binding.agentId, binding.runId].every(uuid)) return { revoked: 0 };
  return db.transaction(async (tx) => {
    const [run] = await tx
      .select({ id: schema.agentRuns.id })
      .from(schema.agentRuns)
      .where(
        and(
          eq(schema.agentRuns.orgId, binding.orgId),
          eq(schema.agentRuns.agentId, binding.agentId),
          eq(schema.agentRuns.id, binding.runId),
        ),
      )
      .for("update");
    if (!run) return { revoked: 0 };
    const rows = rowsOf<{ id: string }>(
      await tx.execute(sql`update skill_read_activations set revoked_at=clock_timestamp()
   where org_id=${binding.orgId}::uuid and agent_id=${binding.agentId}::uuid and run_id=${binding.runId}::uuid
    and revoked_at is null returning id`),
    );
    return { revoked: rows.length };
  });
}
