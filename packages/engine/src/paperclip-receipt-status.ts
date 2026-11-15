/** Receipt-bound execution observations (ADR 0184), never outcome evidence or execution authority. */
import { and, type Executor, eq, schema, sql } from "@agenteschat/db";
import { UUID } from "./authority";
import { canonical, nativeHash } from "./paperclip-routine-state";
import { assertMappingWorkspace } from "./paperclip-workspaces";

const { paperclipRoutineReceipts: receipts, routineRuns, agentRuns, issues } = schema;
type Mapping = typeof schema.paperclipRoutineMappings.$inferSelect;
type Native = typeof schema.routines.$inferSelect;
type Selection = typeof receipts.$inferSelect.workspaceSelection;
export const PAPERCLIP_RECEIPT_STATUS_CONTRACT = "agents_chat_receipt_status_v1";
const ROUTINE_STATUSES = [
  "queued",
  "starting",
  "started",
  "reported",
  "silent",
  "failed",
  "canceled",
  "superseded",
  "missed",
  "skipped",
] as const;
type RoutineStatus = (typeof ROUTINE_STATUSES)[number];
type AgentStatus = (typeof schema.agentRunStatusEnum.enumValues)[number];
type IssueStatus = (typeof schema.issueStatusEnum.enumValues)[number];
const digest = (value: string | null) => (value && /^[a-f0-9]{64}$/.test(value) ? value : null);
function workspaceView(selection: Selection) {
  if (
    !selection ||
    [selection.bindingId, selection.sourceProjectId, selection.sourceWorkspaceId, selection.generation].some(
      (value) => typeof value !== "string" || !UUID.test(value),
    ) ||
    !digest(selection.bindingDigest)
  )
    return null;
  return {
    bindingId: selection.bindingId,
    projectId: selection.sourceProjectId,
    projectWorkspaceId: selection.sourceWorkspaceId,
    generation: selection.generation,
    bindingDigest: selection.bindingDigest,
  };
}
function sameSelection(a: Selection, b: Selection) {
  try {
    return canonical(a) === canonical(b);
  } catch {
    return false;
  }
}

/**
 * Called only within the authenticated hook transaction. One joined statement observes the current receipt
 * pointer and all execution links together: deferral commits its replacement atomically. No execution-row locks
 * are added after the hook's native-routine lock (the worker may already hold its firing); no work is started.
 */
export async function paperclipReceiptExecutionStatus(
  db: Executor,
  mapping: Mapping,
  native: Native,
  receiptId: string,
) {
  const canonicalReceipt = db
    .select({
      id: receipts.id,
      issueId: receipts.issueId,
      routineRunId: receipts.routineRunId,
      dispatchFingerprint: receipts.dispatchFingerprint,
      workspaceSelection: receipts.workspaceSelection,
      acceptedConfigHash: receipts.acceptedConfigHash,
    })
    .from(receipts)
    .where(and(eq(receipts.orgId, mapping.orgId), eq(receipts.mappingId, mapping.id), eq(receipts.status, "queued")))
    .as("canonical_receipt");
  const [row] = await db
    .select({
      receipt: receipts,
      firing: {
        id: routineRuns.id,
        agentRunId: routineRuns.agentRunId,
        status: routineRuns.status,
        trigger: routineRuns.trigger,
        eventType: sql<string | null>`${routineRuns.event}->>'type'`,
        eventIssueId: sql<string | null>`${routineRuns.event}->>'issueId'`,
        eventConfigHash: sql<string | null>`${routineRuns.event}->>'configHash'`,
      },
      worker: { id: agentRuns.id, status: agentRuns.status, background: agentRuns.background },
      issue: { id: issues.id, status: issues.status, assigneeType: issues.assigneeType, assigneeId: issues.assigneeId },
      canonical: {
        id: canonicalReceipt.id,
        issueId: canonicalReceipt.issueId,
        routineRunId: canonicalReceipt.routineRunId,
        dispatchFingerprint: canonicalReceipt.dispatchFingerprint,
        workspaceSelection: canonicalReceipt.workspaceSelection,
        acceptedConfigHash: canonicalReceipt.acceptedConfigHash,
      },
    })
    .from(receipts)
    .leftJoin(
      routineRuns,
      and(
        eq(routineRuns.id, receipts.routineRunId),
        eq(routineRuns.orgId, mapping.orgId),
        eq(routineRuns.routineId, mapping.routineId),
      ),
    )
    .leftJoin(
      agentRuns,
      and(
        eq(agentRuns.id, routineRuns.agentRunId),
        eq(agentRuns.orgId, mapping.orgId),
        eq(agentRuns.agentId, mapping.agentId),
      ),
    )
    .leftJoin(issues, and(eq(issues.id, receipts.issueId), eq(issues.orgId, mapping.orgId)))
    .leftJoin(canonicalReceipt, sql`${canonicalReceipt.id}::text = ${routineRuns.event}->>'receiptId'`)
    .where(and(eq(receipts.id, receiptId), eq(receipts.orgId, mapping.orgId), eq(receipts.mappingId, mapping.id)));
  if (!row) return null;
  const r = row.receipt;
  const accepted = digest(r.acceptedConfigHash);
  const selection = r.workspaceSelection;
  const result = {
    contract: PAPERCLIP_RECEIPT_STATUS_CONTRACT,
    backend: "agents_chat" as const,
    receiptId: r.id,
    mappingId: mapping.id,
    sourceCompanyId: mapping.sourceCompanyId,
    sourceRoutineId: mapping.sourceRoutineId,
    sourceRevisionId: mapping.sourceRevisionId,
    configHash: accepted,
    acceptedConfigHash: accepted,
    currentConfigHash: mapping.configHash,
    admissionConfigStatus: accepted ? ("recorded" as const) : ("unknown_legacy" as const),
    admissionStatus: ["queued", "coalesced", "skipped"].includes(r.status) ? r.status : null,
    dispatchFingerprint: digest(r.dispatchFingerprint),
    // A tenant-local join is insufficient: publish execution IDs only after the complete relation checks.
    issueId: null as string | null,
    routineRunId: null as string | null,
    executionReceiptId: null as string | null,
    sharedExecution: r.status === "coalesced",
    observation: "held" as "linked" | "held" | "unknown_legacy" | "not_started",
    reason: null as string | null,
    scopeQualification: "unknown" as "qualified" | "not_required" | "unknown" | "changed",
    workspace: null as ReturnType<typeof workspaceView>,
    routineStatus: null as RoutineStatus | null,
    agentStatus: null as AgentStatus | null,
    issueStatus: null as IssueStatus | null,
    evidenceQualified: false,
  };
  const held = (reason: string) => ({ ...result, reason });
  if (!result.admissionStatus) return held("admission_state_unknown");
  if (!accepted) return { ...result, observation: "unknown_legacy" as const, reason: "admission_config_unknown" };
  if (accepted !== mapping.configHash || nativeHash(native) !== mapping.nativeConfigHash)
    return held("configuration_changed");
  try {
    const project = mapping.definition.workspaceScope != null || Boolean(mapping.definition.workspaceBindingId);
    if (project && !selection) return held("accepted_workspace_unknown");
    await assertMappingWorkspace(db, mapping, true, selection);
    result.scopeQualification = selection ? "qualified" : "not_required";
    result.workspace = workspaceView(selection);
  } catch {
    return { ...held("workspace_changed"), scopeQualification: "changed" as const };
  }
  // A skip names existing active work for reconciliation; that work did not execute this admission.
  if (r.status === "skipped") return { ...result, observation: "not_started" as const, reason: "admission_skipped" };
  const { firing, issue, worker, canonical: queued } = row;
  if (
    !firing ||
    !issue ||
    !queued ||
    !result.dispatchFingerprint ||
    !["queued", "coalesced"].includes(r.status) ||
    (r.status === "queued" && queued.id !== r.id) ||
    queued.issueId !== issue.id ||
    queued.routineRunId !== firing.id ||
    queued.dispatchFingerprint !== r.dispatchFingerprint ||
    queued.acceptedConfigHash !== accepted ||
    !sameSelection(queued.workspaceSelection, selection) ||
    firing.trigger !== "event" ||
    firing.eventType !== "paperclip.received" ||
    firing.eventIssueId !== issue.id ||
    firing.eventConfigHash !== accepted ||
    issue.assigneeType !== "agent" ||
    issue.assigneeId !== mapping.agentId ||
    (firing.agentRunId !== null && !worker?.background) ||
    (firing.agentRunId === null && ["started", "reported", "silent"].includes(firing.status))
  )
    return held("execution_link_changed");
  if (
    !(ROUTINE_STATUSES as readonly string[]).includes(firing.status) ||
    (worker && !schema.agentRunStatusEnum.enumValues.includes(worker.status)) ||
    !schema.issueStatusEnum.enumValues.includes(issue.status)
  )
    return held("execution_state_unknown");
  return {
    ...result,
    observation: "linked" as const,
    issueId: issue.id,
    routineRunId: firing.id,
    executionReceiptId: queued.id,
    routineStatus: firing.status as RoutineStatus,
    agentStatus: worker?.status ?? null,
    issueStatus: issue.status,
  };
}
