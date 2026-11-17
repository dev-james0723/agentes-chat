import type { FoundryQualification, PubSub } from "@agenteschat/adapters";
import { and, type Database, eq, inArray, isNull, schema } from "@agenteschat/db";
import { recordAudit } from "../audit";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { publishMessageCreated } from "../events";
import { getIssue } from "../issues";
import { insertMessageWithRuns, messageView } from "../messages";
import { enqueueRunJob } from "../mission-runs";
import { getMembership, requireActiveMembership } from "../organizations";
import { ACTIVE_RUN_STATUSES } from "../run-inbox";
import { workRefusal } from "../standing";
import { ensureTaskConversation } from "../task-conversation";
import type { FoundryBuilderRunPin } from "./execution-policy";

export interface FoundryEnrollmentResult {
  runId: string;
  taskId: string;
  phaseRef: string;
  expiresAt: string;
}
/** Owner opt-in to a LIMITED existing task. Does not grant scopes, change a
 * model/provider, approve activation, create agents/tasks or duplicate jobs.
 * Uses native message idempotency and native run/outbox creation atomically. */
export async function startFoundryTaskRun(
  deps: { db: Database; pubsub: PubSub; qualify(): Promise<FoundryQualification> },
  userId: string,
  orgId: string,
  taskId: string,
  input: { requestId: string; phaseFromRunId?: string },
): Promise<FoundryEnrollmentResult> {
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if (!uuid.test(input.requestId) || (input.phaseFromRunId && !uuid.test(input.phaseFromRunId)))
    throw new ValidationError("Invalid request identity");
  const owner = await requireActiveMembership(deps.db, userId, orgId);
  if (owner.role !== "owner" || workRefusal(owner.standing))
    throw new ForbiddenError("Only the active owner can enroll a limited Foundry task");
  const visible = await getIssue(deps.db, { type: "person", userId }, orgId, { id: taskId });
  if (visible.assignee?.type !== "agent")
    throw new ValidationError("Keep an existing assigned task; do not create a second task");
  const qualified = await deps.qualify();
  if (!qualified.qualified) throw new ValidationError("The isolated runtime is not currently qualified");
  const conversation = await ensureTaskConversation(deps.db, taskId);
  const result = await deps.db.transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(schema.issues)
      .where(and(eq(schema.issues.id, taskId), eq(schema.issues.orgId, orgId)))
      .for("update");
    const membership = await getMembership(tx, userId, orgId);
    if (!membership || membership.role !== "owner" || workRefusal(membership.standing)) throw new ForbiddenError();
    if (
      !task ||
      task.assigneeType !== "agent" ||
      !task.assigneeId ||
      !["todo", "in_progress", "in_review"].includes(task.status)
    )
      throw new ValidationError("Task ownership or state changed");
    const [agent] = await tx
      .select()
      .from(schema.agents)
      .where(
        and(eq(schema.agents.id, task.assigneeId), eq(schema.agents.orgId, orgId), isNull(schema.agents.archivedAt)),
      )
      .for("update");
    if (!agent || agent.brain !== "model" || agent.operatorHoldAt)
      throw new ValidationError("Use the existing authorized model agent; no CLI or paid fallback is enrolled");
    const phase = {
      phaseRef: `foundry-task:${crypto.randomUUID()}`,
      expiresAt: new Date(Math.min(Date.now() + 3600000, Date.parse(qualified.expiresAt))).toISOString(),
    };
    if (input.phaseFromRunId) {
      const [old] = await tx
        .select()
        .from(schema.agentRuns)
        .where(and(eq(schema.agentRuns.id, input.phaseFromRunId), eq(schema.agentRuns.orgId, orgId)));
      const p = old?.foundryPolicy as unknown as FoundryBuilderRunPin | null;
      if (
        !old ||
        !p ||
        old.agentId !== agent.id ||
        old.issueId !== taskId ||
        p.taskId !== taskId ||
        p.agentId !== agent.id ||
        p.orgId !== orgId ||
        !p.runIds.includes(old.id) ||
        Date.parse(p.expiresAt) <= Date.now()
      )
        throw new ValidationError("Original phase is unavailable or expired; no silent renewal");
      phase.phaseRef = p.phaseRef;
      phase.expiresAt = p.expiresAt;
    }
    if (Date.parse(phase.expiresAt) <= Date.now() + 120000)
      throw new ValidationError("Requalify the runtime before starting this phase");
    const written = await insertMessageWithRuns(
      tx,
      {
        orgId,
        channelId: conversation.channelId,
        threadId: conversation.rootId,
        author: { type: "person", userId },
        clientId: `foundry:${input.requestId}`,
        body: "請喺呢個任務建立並驗證 receipt-normalizer/v1，用嚟整理合成任務收據（normalize synthetic task receipts）。先搜尋可重用能力；只用原生 Foundry 工具。建立後交獨立驗收，再提出限定任務、次數及期限嘅批准，未獲批准唔好啟用。用簡單香港繁體中文報告真正完成同待批准嘅部分。",
        meta: { issueId: taskId, foundryRequestId: input.requestId },
      },
      { startRuns: false, deliver: false },
    );
    if (written.message.channelId !== conversation.channelId || written.message.authorUserId !== userId)
      throw new ValidationError("Request identity belongs to a different task");
    if (written.duplicate) {
      const [r] = await tx
        .select()
        .from(schema.agentRuns)
        .where(
          and(
            eq(schema.agentRuns.orgId, orgId),
            eq(schema.agentRuns.triggerMessageId, written.message.id),
            eq(schema.agentRuns.issueId, taskId),
          ),
        );
      const p = r?.foundryPolicy as unknown as FoundryBuilderRunPin | null;
      if (!r || !p) throw new ValidationError("Original request did not enroll a run");
      return { value: { runId: r.id, taskId, phaseRef: p.phaseRef, expiresAt: p.expiresAt }, message: null };
    }
    const [busy] = await tx
      .select({ id: schema.agentRuns.id })
      .from(schema.agentRuns)
      .where(
        and(
          eq(schema.agentRuns.orgId, orgId),
          eq(schema.agentRuns.issueId, taskId),
          inArray(schema.agentRuns.status, [...ACTIVE_RUN_STATUSES]),
        ),
      );
    if (busy) throw new ValidationError("This task already has active work; do not duplicate or replace it");
    const { run, steered } = await enqueueRunJob(tx, written.message, agent.id);
    if (!run || steered) throw new ValidationError("Existing work owns this conversation");
    const pin: FoundryBuilderRunPin = { ...phase, orgId, taskId, agentId: agent.id, runIds: [run.id] };
    await tx
      .update(schema.agentRuns)
      .set({ issueId: taskId, brain: "model", foundryPolicy: { ...pin } })
      .where(eq(schema.agentRuns.id, run.id));
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: userId },
      action: "foundry.task_run_enrolled",
      target: { type: "issue", id: taskId },
      details: {
        runId: run.id,
        phaseRef: phase.phaseRef,
        expiresAt: phase.expiresAt,
        scope: "native_builder_run_only",
      },
    });
    return { value: { runId: run.id, taskId, ...phase }, message: written.message };
  });
  if (result.message) await publishMessageCreated(deps.pubsub, messageView(result.message));
  return result.value;
}
