import { z } from "zod";
import {
  type DeliveryStage,
  DeliveryStageSchema,
  type EvidenceRef,
  EvidenceRefSchema,
  type FounderUpdate,
  FounderUpdateSchema,
  type ValidationIssue,
} from "./communication-contracts";

export type FounderPreferences = { locale: string; style: "simple" | "technical"; timeZone?: string };
type Owner = { type: "person" | "agent"; id: string };
type Checks = FounderUpdate["checks"];
export type TaskSnapshot = {
  orgId: string;
  projectId: string | null;
  taskId: string;
  revision: number;
  runId: string | null;
  audience: string;
  owner: Owner | null;
  artifactRef: string | null;
  artifactRevision: string | null;
  artifactKind: "code" | "document" | "unknown";
  environment: string | null;
  lifecycle: string;
  generatedAt: string;
  checks: Checks | null;
  remaining: string[];
  blocker: { summary: string; ownerRef: string | null; nextAdmissibleAction: string } | null;
  decisionNeeded: boolean;
  howToTry: string | null;
};

const issuerKinds = [
  "source_inspector",
  "build_runner",
  "test_runner",
  "release_controller",
  "live_probe",
  "benchmark_runner",
] as const;
export type NativeFounderReceipt = {
  reference: EvidenceRef;
  taskId: string;
  taskRevision: number;
  artifactRef: string;
  artifactRevision: string;
  stage: DeliveryStage;
  issuer: { id: string; kind: (typeof issuerKinds)[number] };
};
const receiptSchema = z.strictObject({
  reference: EvidenceRefSchema,
  taskId: z.string().min(1),
  taskRevision: z.number().int().nonnegative(),
  artifactRef: z.string().min(1),
  artifactRevision: z.string().min(1),
  stage: DeliveryStageSchema,
  issuer: z.strictObject({ id: z.string().min(1), kind: z.enum(issuerKinds) }),
});
const nativeEvidence = Symbol("native-founder-evidence");
export type ResolvedFounderEvidence = NativeFounderReceipt & { readonly [nativeEvidence]: true };
export type NativeFounderEvidenceResolver = {
  /** Native lookup must authorize this viewer for every reference and resolve its eligible issuer. No URL fetching. */
  resolve(
    ref: string,
    scope: { orgId: string; projectId: string | null; taskId: string; viewerId: string },
  ): Promise<NativeFounderReceipt | null>;
};

/** Only the authenticated server adapter supplies this resolver. Model JSON cannot create the symbol brand. */
export async function resolveFounderEvidence(
  task: TaskSnapshot,
  refs: readonly string[],
  resolver: NativeFounderEvidenceResolver,
): Promise<ResolvedFounderEvidence[]> {
  const result: ResolvedFounderEvidence[] = [];
  for (const ref of [...new Set(refs)].slice(0, 100)) {
    const receipt = await resolver.resolve(ref, {
      orgId: task.orgId,
      projectId: task.projectId,
      taskId: task.taskId,
      viewerId: task.audience,
    });
    const parsed = receiptSchema.safeParse(receipt);
    if (
      parsed.success &&
      parsed.data.reference.id === ref &&
      parsed.data.reference.scope.orgId === task.orgId &&
      parsed.data.reference.scope.projectId === task.projectId
    ) {
      result.push({ ...parsed.data, [nativeEvidence]: true });
    }
  }
  return result;
}

const stages = ["SOURCE_INSPECTED", "CODED", "TESTED", "DEPLOYED", "LIVE_VERIFIED", "MEASURED_IMPROVEMENT"] as const;
const producers: Record<DeliveryStage, readonly [EvidenceRef["kind"], NativeFounderReceipt["issuer"]["kind"]]> = {
  SOURCE_INSPECTED: ["source_inspection", "source_inspector"],
  CODED: ["tool_receipt", "build_runner"],
  TESTED: ["test_result", "test_runner"],
  DEPLOYED: ["deployment_receipt", "release_controller"],
  LIVE_VERIFIED: ["live_check", "live_probe"],
  MEASURED_IMPROVEMENT: ["benchmark_result", "benchmark_runner"],
};
function supports(task: TaskSnapshot, receipt: ResolvedFounderEvidence): boolean {
  if (receipt[nativeEvidence] !== true) return false;
  const ref = receipt.reference;
  const producer = producers[receipt.stage];
  return (
    !!producer &&
    ref.status === "valid" &&
    ["authorized_system", "independent_review"].includes(ref.trust) &&
    ref.scope.orgId === task.orgId &&
    ref.scope.projectId === task.projectId &&
    receipt.taskId === task.taskId &&
    receipt.taskRevision === task.revision &&
    task.artifactRef !== null &&
    receipt.artifactRef === task.artifactRef &&
    task.artifactRevision !== null &&
    receipt.artifactRevision === task.artifactRevision &&
    ref.sourceRevision === task.artifactRevision &&
    task.environment !== null &&
    ref.environment === task.environment &&
    ref.kind === producer[0] &&
    receipt.issuer.kind === producer[1] &&
    (receipt.stage === "SOURCE_INSPECTED" || task.artifactKind === "code") &&
    Date.parse(ref.observedAt) <= Date.parse(task.generatedAt)
  );
}

export function deriveDeliveryStage(
  task: TaskSnapshot,
  evidence: readonly ResolvedFounderEvidence[],
): DeliveryStage | null {
  let highest: DeliveryStage | null = null;
  for (const receipt of evidence) {
    if (supports(task, receipt) && (highest === null || stages.indexOf(receipt.stage) > stages.indexOf(highest)))
      highest = receipt.stage;
  }
  return highest;
}
function availabilityOf(
  task: TaskSnapshot,
  evidence: readonly ResolvedFounderEvidence[],
): FounderUpdate["availability"] {
  const deployed = evidence.some(
    (receipt) => supports(task, receipt) && ["DEPLOYED", "LIVE_VERIFIED"].includes(receipt.stage),
  );
  return deployed && ["local", "preview", "production"].includes(task.environment ?? "")
    ? (task.environment as "local" | "preview" | "production")
    : "unknown";
}

export type ClaimSupport = { ok: boolean; issues: ValidationIssue[] };
export function validateClaimSupport(
  update: FounderUpdate,
  task: TaskSnapshot,
  evidence: readonly ResolvedFounderEvidence[],
): ClaimSupport {
  const issues: ValidationIssue[] = [];
  const reject = (path: string) =>
    issues.push({ code: "unsupported_claim", path, message: "Claim lacks current native support" });
  if (
    update.taskId !== task.taskId ||
    update.taskRevision !== task.revision ||
    update.runId !== task.runId ||
    update.audience !== task.audience
  )
    reject("taskId");
  if (
    update.deliveryStage !== null &&
    !evidence.some((receipt) => receipt.stage === update.deliveryStage && supports(task, receipt))
  )
    reject("deliveryStage");
  if (update.availability !== availabilityOf(task, evidence)) reject("availability");
  if (
    task.checks === null ||
    ["passed", "failed", "notRun", "scope"].some(
      (key) => update.checks[key as keyof Checks] !== task.checks?.[key as keyof Checks],
    )
  )
    reject("checks");
  const validRefs = new Set(
    evidence.filter((receipt) => supports(task, receipt)).map((receipt) => receipt.reference.id),
  );
  for (const ref of [...update.evidenceRefs, ...update.claims.flatMap((claim) => claim.evidenceRefs)])
    if (!validRefs.has(ref)) reject("evidenceRefs");
  return { ok: issues.length === 0, issues };
}

export const FounderProjectionSchema = z.strictObject({
  taskId: z.string(),
  taskRevision: z.number().int().nonnegative(),
  lifecycle: z.string(),
  locale: z.string(),
  timeZone: z.string(),
  style: z.enum(["simple", "technical"]),
  outcome: z.string(),
  deliveryStage: DeliveryStageSchema.nullable(),
  availability: z.enum(["not_available", "local", "preview", "production", "unknown"]),
  checks: z.object({ passed: z.number(), failed: z.number(), notRun: z.number(), scope: z.string() }).nullable(),
  howToTry: z.string().nullable(),
  remaining: z.array(z.string()),
  blocker: z
    .object({ summary: z.string(), ownerRef: z.string().nullable(), nextAdmissibleAction: z.string() })
    .nullable(),
  nextOwner: z.object({ type: z.enum(["person", "agent"]), id: z.string() }).nullable(),
  decisionNeeded: z.boolean(),
  evidence: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      status: z.enum(["valid", "expired", "revoked", "unknown"]),
      environment: z.string(),
      sourceRevision: z.string().nullable(),
      stage: DeliveryStageSchema.nullable(),
    }),
  ),
  generatedAt: z.string(),
  contract: FounderUpdateSchema.nullable(),
  contractUnavailable: z.array(z.string()),
});
export type FounderProjection = z.infer<typeof FounderProjectionSchema>;

const outcomes: Record<string, readonly [string, string, string]> = {
  todo: ["The task is queued.", "A tarefa está na fila.", "任務等待處理。"],
  in_progress: ["Work is in progress.", "A tarefa está em andamento.", "任務正在處理。"],
  in_review: ["The task is awaiting review.", "A tarefa aguarda revisão.", "任務等待審核。"],
  done: [
    "The task is marked complete. Delivery verification is shown separately.",
    "A tarefa foi marcada como concluída. A verificação da entrega aparece separadamente.",
    "任務已標記完成。交付驗證另行顯示。",
  ],
  canceled: ["The task was canceled.", "A tarefa foi cancelada.", "任務已取消。"],
};
export function projectFounderUpdate(
  task: TaskSnapshot,
  evidence: readonly ResolvedFounderEvidence[],
  preferences: FounderPreferences,
): FounderProjection {
  const column = preferences.locale.startsWith("zh") ? 2 : preferences.locale.startsWith("pt") ? 1 : 0;
  const outcome =
    outcomes[task.lifecycle]?.[column] ??
    ["Task status is unknown.", "O estado da tarefa é desconhecido.", "任務狀態未明。"][column];
  const stage = deriveDeliveryStage(task, evidence);
  const availability = availabilityOf(task, evidence);
  const supported = evidence.filter((receipt) => supports(task, receipt));
  const unavailable = [
    !task.projectId && "missing_project",
    !task.runId && "missing_run",
    !task.owner && "missing_owner",
    task.checks === null && "checks",
  ].filter((reason): reason is string => typeof reason === "string");
  const candidate = unavailable.length
    ? null
    : {
        schemaVersion: "1.0",
        taskId: task.taskId,
        taskRevision: task.revision,
        runId: task.runId,
        audience: task.audience,
        locale: preferences.locale,
        outcome,
        claims: [
          { text: outcome, confidence: "certain", evidenceRefs: [], rationale: "Current native task lifecycle only" },
        ],
        deliveryStage: stage,
        checks: task.checks,
        availability,
        ...(task.howToTry ? { howToTry: task.howToTry } : {}),
        remaining: task.remaining,
        blocker: task.blocker,
        nextOwner: task.owner?.id,
        decisionNeeded: task.decisionNeeded,
        evidenceRefs: supported.map((receipt) => receipt.reference.id),
        generatedAt: task.generatedAt,
      };
  const parsed = FounderUpdateSchema.safeParse(candidate);
  if (candidate !== null && !parsed.success) unavailable.push("invalid_native_contract");
  return {
    taskId: task.taskId,
    taskRevision: task.revision,
    lifecycle: task.lifecycle,
    locale: preferences.locale,
    timeZone: preferences.timeZone ?? "UTC",
    style: preferences.style,
    outcome,
    deliveryStage: stage,
    availability,
    checks: task.checks,
    howToTry: task.howToTry,
    remaining: [...task.remaining],
    blocker: task.blocker ?? null,
    nextOwner: task.owner,
    decisionNeeded: task.decisionNeeded,
    generatedAt: task.generatedAt,
    evidence: evidence
      .filter((receipt) => receipt[nativeEvidence] === true)
      .map((receipt) => ({
        id: receipt.reference.id,
        kind: receipt.reference.kind,
        status: receipt.reference.status,
        environment: receipt.reference.environment,
        sourceRevision: receipt.reference.sourceRevision ?? null,
        stage: supports(task, receipt) ? receipt.stage : null,
      })),
    contract: parsed.success ? parsed.data : null,
    contractUnavailable: unavailable,
  };
}

export type NativeIssueForFounder = {
  id: string;
  revision: number;
  status: string;
  project?: { id: string } | null;
  assignee: Owner | null;
  work?: { runId: string | null; state: string } | null;
  blocked?: { reason: string; text?: string } | null;
  criteria: { text: string; done: boolean }[];
  updatedAt: string;
};
/** Call only after getIssueDetail has authorized the actor. Raw communication/tool metadata is deliberately ignored. */
export function projectNativeIssueUpdate(
  issue: NativeIssueForFounder,
  scope: FounderPreferences & { orgId: string; audience: string },
): FounderProjection {
  const owner = issue.assignee;
  return projectFounderUpdate(
    {
      orgId: scope.orgId,
      projectId: issue.project?.id ?? null,
      taskId: issue.id,
      revision: issue.revision,
      runId: issue.work?.runId ?? null,
      audience: scope.audience,
      owner,
      artifactRef: null,
      artifactRevision: null,
      artifactKind: "unknown",
      environment: null,
      lifecycle: issue.status,
      generatedAt: issue.updatedAt,
      checks: null,
      remaining: issue.criteria
        .filter((criterion) => !criterion.done)
        .map((criterion) => criterion.text)
        .slice(0, 20),
      blocker: issue.blocked
        ? {
            summary: issue.blocked.text ?? issue.blocked.reason,
            ownerRef: owner?.id ?? null,
            nextAdmissibleAction: scope.locale.startsWith("zh")
              ? "請在任務對話查看下一個所需步驟"
              : scope.locale.startsWith("pt")
                ? "Abra a conversa da tarefa para ver o próximo passo necessário"
                : "Open the task conversation for the required next step",
          }
        : null,
      decisionNeeded: issue.work?.state === "waiting_input" || issue.work?.state === "waiting_approval",
      howToTry: null,
    },
    [],
    scope,
  );
}

export function clarificationFor(
  known: Readonly<Record<string, string>>,
  gap: { key: string; question: string; material: boolean } | null,
): string | null {
  return gap?.material && !Object.hasOwn(known, gap.key) ? gap.question : null;
}
export type FounderUpdateEvent = {
  orgId: string;
  taskId: string;
  revision: number;
  eventKind: string;
  audience: string;
  at: number;
  urgent?: boolean;
};
/** Stateless decision for the existing event/outbox caller. No timer, scheduler or second event ledger. */
export function shouldEmitFounderUpdate(previous: FounderUpdateEvent | null, next: FounderUpdateEvent): boolean {
  return (
    next.urgent === true ||
    ["decision", "safety"].includes(next.eventKind) ||
    previous === null ||
    ["orgId", "taskId", "revision", "eventKind", "audience"].some(
      (key) => previous[key as keyof FounderUpdateEvent] !== next[key as keyof FounderUpdateEvent],
    ) ||
    next.at - previous.at >= 60000
  );
}
