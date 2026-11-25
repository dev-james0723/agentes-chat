import { and, type Database, desc, type Executor, eq, inArray, schema, sql } from "@agenteschat/db";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { issueKey } from "./issue-key";
import {
  askAgentToImplement,
  getIssue,
  type IssueDeps,
  type IssueStatus,
  nameableIn,
  publishToTaskReaders,
  setCriterion,
} from "./issues";
import { tellSession } from "./missions";
import { personBehindCall } from "./requester";
import type { ToolContext } from "./tools/types";
import { recordDeliveryClaim, recordDeliveryVerdict } from "./verification";

const { issues, issueActivity, agentRuns, missions, missionEvents, missionDeliveries } = schema;
type Task = typeof issues.$inferSelect;
type Contract = {
  id: string;
  parentId: string;
  implementationId: string;
  reviewId: string;
  managerId: string;
  implementerId: string;
  reviewerId: string;
  missionId: string | null;
};
type Submission = {
  id: string;
  contractId: string;
  revision: string;
  preview: string;
  paths: string[];
  checks: string[];
  summary: string;
  implementationCriteria: string;
  retryReason?: string;
};
type Review = {
  submissionId: string;
  revision: string;
  verdict: "passed" | "changes_requested";
  evidence: string[];
  summary: string;
  reviewCriteria: string;
};
export type DeliveryReceipt = { parentId: string; contractId: string; submissionId: string };

const CONTRACT = "delivery_contract";
const SUBMITTED = "delivery_submitted";
const REVIEWED = "delivery_reviewed";

// JSONB does not preserve object insertion order; retries compare values, not transport key order.
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );

/** Existing task activity is the receipt. No separate task, release authority or scheduler is created. */
async function latest<T>(db: Executor, orgId: string, taskId: string, event: string) {
  const [row] = await db
    .select({ data: issueActivity.data })
    .from(issueActivity)
    .where(and(eq(issueActivity.orgId, orgId), eq(issueActivity.issueId, taskId), eq(issueActivity.event, event)))
    .orderBy(desc(issueActivity.createdAt), desc(issueActivity.id))
    .limit(1);
  return row ? (row.data as T) : null;
}

async function event(db: Executor, task: Task, agentId: string, kind: string, text: string, data: object) {
  await db.insert(issueActivity).values({
    orgId: task.orgId,
    issueId: task.id,
    kind: "event",
    authorType: "agent",
    authorId: agentId,
    event: kind,
    text,
    data: data as Record<string, unknown>,
    // After acquiring task locks: transaction-start now() can reorder concurrent receipts.
    createdAt: sql`clock_timestamp()`,
  });
}

async function status(db: Executor, task: Task, agentId: string, next: IssueStatus, text: string) {
  await db
    .update(issues)
    .set({ status: next, blocked: null, columnId: null, updatedAt: new Date() })
    .where(eq(issues.id, task.id));
  if (task.status !== next)
    await event(db, task, agentId, "status_changed", text, { from: task.status, to: next, auto: true });
}

function text(value: unknown, name: string, max = 1000) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new ValidationError(`Delivery ${name} is required (at most ${max} characters).`);
  return value.trim();
}

function list(value: unknown, name: string) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20)
    throw new ValidationError(`Delivery ${name} needs 1–20 actual references or observed checks.`);
  return [...new Set(value.map((v) => text(v, name, 500)))];
}

function revision(value: unknown) {
  const result = text(value, "revision", 71);
  if (!/^(?:[0-9a-f]{40}|sha256:[0-9a-f]{64})$/i.test(result))
    throw new ValidationError(
      "Use the full Git SHA or sha256:<64 hex digits> of the reviewed snapshot, not a branch name.",
    );
  return result.toLowerCase();
}

function preview(value: unknown) {
  const result = text(value, "preview", 1000);
  let url: URL;
  try {
    url = new URL(result);
  } catch {
    throw new ValidationError("Delivery preview must be an http(s) URL.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new ValidationError("Delivery preview must be an http(s) URL without credentials.");
  return result;
}

function assigned(task: Task, agentId: string) {
  if (task.assigneeType !== "agent" || task.assigneeId !== agentId)
    throw new ForbiddenError(`Only the current assigned agent can perform this delivery step for #${task.number}.`);
  if (task.status === "canceled") throw new ConflictError(`Task #${task.number} is canceled.`);
}

function sharesAudience(tasks: Task[]) {
  const key = (t: Task) => JSON.stringify([t.channelId, t.restricted, [...t.audienceUserIds].sort()]);
  return tasks.length > 0 && tasks.every((t) => key(t) === key(tasks[0]!));
}

function sameAudience(tasks: Task[]) {
  if (!sharesAudience(tasks))
    throw new ValidationError("Delivery tasks must share the same audience. This handoff cannot widen access.");
}

async function missionEvidenceNameable(
  db: Executor,
  mission: Pick<typeof missions.$inferSelect, "orgId" | "channelId" | "ownerId">,
  tasks: Task[],
) {
  if (!mission.ownerId) return false;
  for (const task of tasks) {
    try {
      const view = await getIssue(db as Database, { type: "person", userId: mission.ownerId }, mission.orgId, {
        id: task.id,
      });
      if (!(await nameableIn(db as Database, mission.channelId, view))) return false;
    } catch (error) {
      if (error instanceof ForbiddenError || error instanceof NotFoundError) return false;
      throw error;
    }
  }
  return true;
}

function acceptedCriteria(task: Task) {
  if (task.criteria.length === 0 || task.criteria.some((c) => !c.done))
    throw new ValidationError(`Task #${task.number} needs explicit, checked acceptance criteria before this step.`);
}

const criteriaKey = (task: Task) =>
  new Bun.CryptoHasher("sha256")
    .update(JSON.stringify(task.criteria.map(({ id, text }) => ({ id, text }))))
    .digest("hex");

async function currentDelivery(db: Executor, orgId: string, contract: Contract) {
  const submission = await latest<Submission>(db, orgId, contract.implementationId, SUBMITTED);
  const review = await latest<Review>(db, orgId, contract.implementationId, REVIEWED);
  const current = submission?.contractId === contract.id ? submission : null;
  return {
    submission: current,
    review: current && review?.submissionId === current.id && review.revision === current.revision ? review : null,
  };
}

/** Guard all normal status writes and background completion; only the reviewed revision may finish a child. */
export async function deliveryAllowsDone(db: Executor, orgId: string, taskId: string): Promise<boolean> {
  const contract = await latest<Contract>(db, orgId, taskId, CONTRACT);
  if (!contract) return true;
  if (taskId === contract.parentId) return false; // Owner acceptance remains a person's decision.
  const { submission, review } = await currentDelivery(db, orgId, contract);
  if (!submission || review?.verdict !== "passed") return false;
  const rows = await db
    .select()
    .from(issues)
    .where(and(eq(issues.orgId, orgId), inArray(issues.id, [contract.implementationId, contract.reviewId])));
  const impl = rows.find((r) => r.id === contract.implementationId);
  const qa = rows.find((r) => r.id === contract.reviewId);
  return (
    !!impl &&
    !!qa &&
    impl.assigneeType === "agent" &&
    qa.assigneeType === "agent" &&
    impl.status !== "canceled" &&
    qa.status !== "canceled" &&
    impl.criteria.length > 0 &&
    qa.criteria.length > 0 &&
    impl.criteria.every((c) => c.done) &&
    qa.criteria.every((c) => c.done) &&
    impl.assigneeId === contract.implementerId &&
    qa.assigneeId === contract.reviewerId &&
    criteriaKey(impl) === submission.implementationCriteria &&
    criteriaKey(qa) === review.reviewCriteria
  );
}

export async function issueDeliveryBrief(db: Executor, orgId: string, taskId: string) {
  const contract = await latest<Contract>(db, orgId, taskId, CONTRACT);
  if (!contract) return "";
  // A readable parent can be shared without its children. Never project those children's private receipts
  // into the parent's task detail or worker context after an audience change or a linked task's deletion.
  const tasks = await db
    .select()
    .from(issues)
    .where(
      and(
        eq(issues.orgId, orgId),
        inArray(issues.id, [contract.parentId, contract.implementationId, contract.reviewId]),
      ),
    );
  if (tasks.length !== 3 || !sharesAudience(tasks))
    return "Delivery details are unavailable because the linked tasks' visibility changed or a task is missing. The manager must reconcile the existing delivery contract before continuing.";
  const { submission, review } = await currentDelivery(db, orgId, contract);
  const stage = !submission
    ? "implementation not submitted"
    : !review
      ? "independent QA pending"
      : review.verdict === "passed"
        ? "ready for manager/owner review; release is not approved"
        : "changes requested; implementation must submit a new revision";
  return [
    `Delivery: ${stage}. Parent ${contract.parentId}; implementation ${contract.implementationId}; QA ${contract.reviewId}.`,
    submission
      ? `Submission: ${submission.id}\nRevision: ${submission.revision}\nPreview: ${submission.preview}\nArtifacts: ${submission.paths.join("; ")}`
      : "",
    review ? `QA ${review.verdict}: ${review.summary}\nQA evidence: ${review.evidence.join("; ")}` : "",
    "Use update_issue.delivery: submit on the implementation task, review on the existing QA task. Report actual observed checks and paths; inaccessible or untested items cannot pass. Never infer product completion from a finished turn. The manager supplies the final review packet; a person decides acceptance and release separately.",
  ]
    .filter(Boolean)
    .join("\n");
}

export const ISSUE_DELIVERY_FIELD = {
  type: "object",
  description:
    "Opt-in engineering delivery using existing tasks. Manager configures the parent once; implementer submits the actual revision/preview; independent QA records its observed verdict. Handoffs happen automatically. Does not approve commit, push, merge or deploy.",
  properties: {
    action: { enum: ["configure", "submit", "review"] },
    implementation_issue: { type: "string", maxLength: 64 },
    review_issue: { type: "string", maxLength: 64 },
    revision: { type: "string", maxLength: 71 },
    submission_id: {
      type: "string",
      maxLength: 36,
      description: "QA must name the exact submission receipt it inspected, as shown by list_issues and the handoff.",
    },
    preview: { type: "string", maxLength: 1000 },
    paths: { type: "array", items: { type: "string", maxLength: 500 }, minItems: 1, maxItems: 20 },
    checks: { type: "array", items: { type: "string", maxLength: 500 }, minItems: 1, maxItems: 20 },
    evidence: { type: "array", items: { type: "string", maxLength: 500 }, minItems: 1, maxItems: 20 },
    summary: { type: "string", maxLength: 1000 },
    verdict: { enum: ["passed", "changes_requested"] },
    retry_reason: {
      type: "string",
      maxLength: 500,
      description:
        "Only after changes_requested: why the same immutable content can now be rechecked (for example the preview is accessible again). Repeating the same receipt never sends another handoff.",
    },
  },
  required: ["action"],
  additionalProperties: false,
};

/**
 * Uses the ordinary task handoff with the person derived from this real run, never a caller-supplied owner.
 * The existing outbox, handoff receipt and lifecycle events commit together under task row locks. Retrying the
 * same submission/verdict observes the receipt and starts nothing again. No model, network or filesystem I/O.
 */
export async function applyIssueDelivery(
  deps: IssueDeps,
  ctx: ToolContext,
  taskId: string,
  input: Record<string, unknown>,
  doneCriteria: number[] = [],
) {
  if (!deps.pubsub) throw new ValidationError("Task handoff is unavailable: pub/sub is required.");
  const actor = { type: "agent" as const, agentId: ctx.agentId, channelId: ctx.channelId, runId: ctx.runId };
  const person = await personBehindCall(ctx);
  const [run] = await deps.db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.id, ctx.runId), eq(agentRuns.orgId, ctx.orgId), eq(agentRuns.agentId, ctx.agentId)));
  if (!person || !run)
    throw new ForbiddenError("Delivery handoffs need the real person's delegated run. No authority was inferred.");
  const selected = await getIssue(deps.db, actor, ctx.orgId, { id: taskId });
  const action = input.action;
  if (!["configure", "submit", "review"].includes(String(action)))
    throw new ValidationError("Unknown delivery action.");
  const existing = await latest<Contract>(deps.db, ctx.orgId, taskId, CONTRACT);
  const implementation =
    action === "configure"
      ? await getIssue(
          deps.db,
          actor,
          ctx.orgId,
          issueKey(text(input.implementation_issue, "implementation_issue", 64)),
        )
      : null;
  const qa =
    action === "configure"
      ? await getIssue(deps.db, actor, ctx.orgId, issueKey(text(input.review_issue, "review_issue", 64)))
      : null;
  const ids =
    action === "configure"
      ? [selected.id, implementation!.id, qa!.id]
      : existing
        ? [existing.parentId, existing.implementationId, existing.reviewId]
        : [];
  if (new Set(ids).size !== 3)
    throw new ValidationError("Configure three distinct existing parent, implementation and QA tasks first.");
  // Check the normal task ACL for every participant before taking locks or writing anything.
  for (const id of ids) await getIssue(deps.db, actor, ctx.orgId, { id });
  const result = await deps.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    const d = { ...deps, db };
    const [hereMission] =
      action === "configure"
        ? await tx
            .select()
            .from(missions)
            .where(
              and(
                eq(missions.orgId, ctx.orgId),
                eq(missions.threadRootId, ctx.threadRootId),
                eq(missions.agentId, ctx.agentId),
              ),
            )
        : [];
    if (existing?.missionId && hereMission && existing.missionId !== hereMission.id)
      throw new ConflictError(
        "Keep the existing canonical Mission binding. Do not redirect this delivery to another thread.",
      );
    const boundId = existing?.missionId ?? hereMission?.id;
    // Mission binding set first, then sorted task rows: configure, handoffs and acceptance use this lock order.
    const [boundMission] = boundId
      ? await tx
          .select()
          .from(missions)
          .where(and(eq(missions.orgId, ctx.orgId), eq(missions.id, boundId)))
          .for("update")
      : [];
    if (boundId) {
      const [accepted] = await tx
        .select({ id: missionDeliveries.id })
        .from(missionDeliveries)
        .where(and(eq(missionDeliveries.missionId, boundId), eq(missionDeliveries.status, "accepted")))
        .limit(1);
      if (!boundMission || !["active", "paused", "awaiting_close"].includes(boundMission.status) || accepted)
        throw new ConflictError(
          "The canonical Mission is not open for another delivery. Reconcile the existing Mission first.",
        );
    }
    const rows = await tx
      .select()
      .from(issues)
      .where(and(eq(issues.orgId, ctx.orgId), inArray(issues.id, ids)))
      .orderBy(issues.id)
      .for("update");
    if (rows.length !== 3) throw new ConflictError("A delivery task is no longer available.");
    const byId = new Map(rows.map((r) => [r.id, r]));
    const parent = byId.get(ids[0]!)!;
    const impl = byId.get(ids[1]!)!;
    const reviewTask = byId.get(ids[2]!)!;
    sameAudience(rows);
    if (boundMission && !(await missionEvidenceNameable(tx, boundMission, rows)))
      throw new ForbiddenError("The delivery evidence cannot be shared with the canonical Mission audience.");
    const latestContract = await latest<Contract>(tx, ctx.orgId, selected.id, CONTRACT);
    if (action === "configure") {
      assigned(parent, ctx.agentId);
      if (
        impl.assigneeType !== "agent" ||
        !impl.assigneeId ||
        reviewTask.assigneeType !== "agent" ||
        !reviewTask.assigneeId ||
        impl.assigneeId === reviewTask.assigneeId
      )
        throw new ValidationError("Implementation and independent QA need different named agent assignees.");
      if ([impl, reviewTask].some((t) => t.parentIssueId && t.parentIssueId !== parent.id))
        throw new ValidationError("A selected task already belongs to a different parent.");
      for (const task of rows) {
        const old = await latest<Contract>(tx, ctx.orgId, task.id, CONTRACT);
        if (old && (old.parentId !== parent.id || old.implementationId !== impl.id || old.reviewId !== reviewTask.id))
          throw new ConflictError(
            "Reuse the tasks already bound by this delivery contract. Do not create a competing workflow.",
          );
      }
      if (latestContract?.missionId && latestContract.missionId !== boundMission?.id)
        throw new ConflictError("The canonical Mission binding changed. Read the task again.");
      const contract: Contract = {
        id: Bun.randomUUIDv7(),
        parentId: parent.id,
        implementationId: impl.id,
        reviewId: reviewTask.id,
        managerId: ctx.agentId,
        implementerId: impl.assigneeId,
        reviewerId: reviewTask.assigneeId,
        missionId: boundMission?.id ?? null,
      };
      if (
        latestContract &&
        ["parentId", "implementationId", "reviewId", "managerId", "implementerId", "reviewerId", "missionId"].every(
          (key) => latestContract[key as keyof Contract] === contract[key as keyof Contract],
        )
      )
        return {
          ids,
          content: "Delivery contract already configured; existing task IDs retained. No new work dispatched.",
        };
      for (const task of rows)
        await event(
          tx,
          task,
          ctx.agentId,
          CONTRACT,
          `Delivery: #${parent.number} → implementation #${impl.number} → independent QA #${reviewTask.number} → manager and owner review. Release approval is separate.`,
          contract,
        );
      return {
        ids,
        content:
          "Delivery contract configured on the three existing tasks. Implementation submits its actual revision, preview, artifacts and observed checks; submission automatically hands it to independent QA.",
      };
    }
    if (!latestContract || latestContract.id !== existing?.id)
      throw new ConflictError("The delivery contract changed. Read the task again.");
    const contract = latestContract;
    assigned(parent, contract.managerId);
    if (parent.status === "done")
      throw new ConflictError(
        "The owner already accepted this delivery. Reopen the existing parent explicitly before starting another delivery.",
      );
    assigned(impl, contract.implementerId);
    assigned(reviewTask, contract.reviewerId);
    if (contract.implementerId === contract.reviewerId)
      throw new ValidationError("The implementer cannot independently review their own work.");
    const subject = action === "submit" ? impl : reviewTask;
    if (selected.id !== subject.id)
      throw new ValidationError(
        `Use the existing ${action === "submit" ? "implementation" : "QA"} task #${subject.number} for this step.`,
      );
    assigned(subject, ctx.agentId);
    for (const n of [...new Set(doneCriteria)]) {
      const criterion = subject.criteria[n - 1];
      if (!Number.isInteger(n) || !criterion) throw new ValidationError("Unknown acceptance criterion number.");
      if (!criterion.done) await setCriterion(d, actor, ctx.orgId, subject.id, criterion.id, true);
    }
    const [freshSubject] = await tx.select().from(issues).where(eq(issues.id, subject.id));
    const prior = await currentDelivery(tx, ctx.orgId, contract);
    const rev = revision(input.revision);
    const summary = text(input.summary, "summary");
    const hand = async (target: Task, targetAgent: string, instruction: string) => {
      await askAgentToImplement(d, person, ctx.orgId, target.id, targetAgent, {
        agentId: ctx.agentId,
        runId: run.id,
        hop: run.hop,
        instruction,
      });
    };
    if (action === "submit") {
      acceptedCriteria(freshSubject!);
      const submission: Submission = {
        id: Bun.randomUUIDv7(),
        contractId: contract.id,
        revision: rev,
        preview: preview(input.preview),
        paths: list(input.paths, "artifact paths"),
        checks: list(input.checks, "observed checks"),
        summary,
        implementationCriteria: criteriaKey(freshSubject!),
        ...(input.retry_reason ? { retryReason: text(input.retry_reason, "retry_reason", 500) } : {}),
      };
      if (submission.paths.some((path) => !path.startsWith("/") && !/^artifact:[0-9a-f-]{36}$/i.test(path)))
        throw new ValidationError("Artifact paths must be exact absolute paths or artifact:<id> references.");
      if (prior.submission?.revision === rev) {
        const { id: _id, ...receipt } = prior.submission;
        const { id: _new, ...requested } = submission;
        if (canonical(receipt) === canonical(requested))
          return {
            ids,
            content:
              "This exact revision was already submitted. The existing QA handoff is retained; no duplicate was sent.",
          };
        if (
          (prior.review?.verdict !== "changes_requested" &&
            prior.submission.implementationCriteria === submission.implementationCriteria) ||
          !submission.retryReason ||
          submission.retryReason === prior.submission.retryReason
        )
          throw new ConflictError(
            "This revision already has a submission receipt. Use a new content revision for content changes. After changes_requested or changed acceptance criteria an unchanged snapshot needs a specific new retry_reason.",
          );
      }
      await event(
        tx,
        impl,
        ctx.agentId,
        SUBMITTED,
        `Submitted ${rev} for independent QA; this is not accepted or released.\n${summary}\nPreview: ${submission.preview}\nArtifacts: ${submission.paths.join("; ")}\nObserved checks: ${submission.checks.join("; ")}`,
        submission,
      );
      // The submission is the implementer's claim of done; independent QA's verdict confirms or rejects it (ADR 0211).
      await recordDeliveryClaim(tx, impl, ctx.agentId, submission.id, ctx.runId);
      // New content invalidates old QA checks; the reviewer must inspect this snapshot again.
      await tx
        .update(issues)
        .set({ criteria: reviewTask.criteria.map((c) => ({ id: c.id, text: c.text, done: false })) })
        .where(eq(issues.id, reviewTask.id));
      await status(tx, impl, ctx.agentId, "in_review", "Implementation submitted for independent QA.");
      await status(tx, reviewTask, ctx.agentId, "todo", "New revision queued for independent QA.");
      await status(tx, parent, ctx.agentId, "in_progress", "Delivery awaits independent QA of the submitted revision.");
      await hand(
        reviewTask,
        contract.reviewerId,
        `Independently review existing task #${reviewTask.number} for implementation #${impl.number}, parent #${parent.number}.\nSubmission: ${submission.id}\nRevision: ${rev}\nPreview: ${submission.preview}\nArtifacts: ${submission.paths.join("; ")}\nImplementation checks (claims to verify): ${submission.checks.join("; ")}\nInspect the actual artifacts and functional preview. Do not pass inaccessible or untested requirements. Record checked criteria and update_issue.delivery action review, submission_id ${submission.id}, revision ${rev}, verdict passed or changes_requested, summary and exact evidence paths/checks. This is internal QA, not human acceptance or release approval.`,
      );
      return {
        ids,
        content: `Submitted ${rev}; existing QA task #${reviewTask.number} was handed to its assigned independent reviewer. It is queued/running according to the actual run, not declared complete. No release approved.`,
      };
    }
    if (!prior.submission || prior.submission.revision !== rev || prior.submission.id !== input.submission_id)
      throw new ConflictError(
        "QA must name the latest exact submission_id and content revision. This result is missing or stale.",
      );
    if (criteriaKey(impl) !== prior.submission.implementationCriteria)
      throw new ConflictError(
        "Implementation acceptance criteria changed after submission. Submit the current snapshot and criteria again before reviewing it.",
      );
    if (input.verdict !== "passed" && input.verdict !== "changes_requested")
      throw new ValidationError("QA verdict must be passed or changes_requested.");
    const review: Review = {
      submissionId: prior.submission.id,
      revision: rev,
      verdict: input.verdict,
      evidence: list(input.evidence, "independent QA evidence"),
      summary,
      reviewCriteria: criteriaKey(freshSubject!),
    };
    if (prior.review) {
      if (canonical(prior.review) !== canonical(review))
        throw new ConflictError("This revision already has a QA verdict. Submit corrected content as a new revision.");
      return { ids, content: "This QA verdict was already recorded; its existing next-owner handoff is retained." };
    }
    if (review.verdict === "passed") {
      acceptedCriteria(freshSubject!);
      acceptedCriteria(impl);
    }
    for (const task of [impl, reviewTask])
      await event(
        tx,
        task,
        ctx.agentId,
        REVIEWED,
        `Independent QA ${review.verdict} for ${rev}.\n${summary}\nEvidence: ${review.evidence.join("; ")}`,
        review,
      );
    // Independent QA is the implementation's verifier (ADR 0211 §6): its pass is a verdict only over a met contract.
    await recordDeliveryVerdict(tx, {
      impl,
      reviewerId: ctx.agentId,
      implementerId: contract.implementerId,
      verdict: review.verdict,
      summary,
      submissionId: prior.submission.id,
      revision: rev,
      runId: ctx.runId,
      channelId: ctx.channelId,
    });
    if (review.verdict === "changes_requested") {
      await status(
        tx,
        impl,
        ctx.agentId,
        "in_progress",
        "Independent QA requested changes; the original implementer owns the next action.",
      );
      await status(tx, reviewTask, ctx.agentId, "todo", "QA waits for a corrected revision.");
      await hand(
        impl,
        contract.implementerId,
        `Continue existing implementation #${impl.number} for parent #${parent.number}. Independent QA #${reviewTask.number} requested changes to ${rev}: ${summary}\nEvidence: ${review.evidence.join("; ")}\nCorrect the scoped findings and submit a new content revision with the actual preview and checks through update_issue.delivery. Preserve the existing tasks; do not deploy.`,
      );
      return {
        ids,
        content: `QA requested changes; existing implementation #${impl.number} was handed back to its original owner with evidence.`,
      };
    }
    await status(tx, impl, ctx.agentId, "done", "Independent QA passed this implementation revision.");
    await status(
      tx,
      reviewTask,
      ctx.agentId,
      "done",
      "Independent QA completed with evidence for the current revision.",
    );
    await status(
      tx,
      parent,
      ctx.agentId,
      "in_review",
      "Ready for the manager's final evidence packet and the owner's review; release is not approved.",
    );
    const packet = packetOf(prior.submission, review);
    await event(tx, parent, ctx.agentId, "delivery_ready", packet, {
      contractId: contract.id,
      submissionId: prior.submission.id,
      revision: rev,
    });
    const instruction = `Prepare the final review packet for existing parent #${parent.number} in its canonical project thread.\n${packet}\nShow the actual product/preview, exact source revision and artifact paths, independent QA evidence and any remaining limits. Use complete_mission for the owner's review when the linked Mission's remaining requirements are met. Human acceptance and any commit/push/merge/deploy approval remain separate. Do not call submitted accepted.`;
    if (contract.missionId) {
      const [mission] = await tx
        .select()
        .from(missions)
        .where(
          and(
            eq(missions.orgId, ctx.orgId),
            eq(missions.id, contract.missionId),
            eq(missions.agentId, contract.managerId),
          ),
        );
      if (!mission || !["active", "paused", "awaiting_close"].includes(mission.status))
        throw new ConflictError(
          "The bound Mission is no longer open for this delivery. The manager must reconcile its existing Mission first.",
        );
      // Wake/steer the existing canonical main session; never create a competing manager conversation.
      const sent = await tellSession(d, mission, { sessionId: mission.mainSessionId }, instruction, {
        requestedBy: person,
        from: `independent QA for task #${reviewTask.number}`,
        kind: "system",
      });
      if (sent.runId)
        await tx
          .update(agentRuns)
          .set({ issueId: parent.id })
          .where(
            and(
              eq(agentRuns.id, sent.runId),
              eq(agentRuns.orgId, ctx.orgId),
              eq(agentRuns.agentId, contract.managerId),
              sql`${agentRuns.issueId} is null`,
            ),
          );
    } else await hand(parent, contract.managerId, instruction);
    return {
      ids,
      content: `Independent QA passed ${rev}; parent #${parent.number} is In review. Its manager's final packet is delivered or queued in the existing canonical conversation. Awaiting owner review, not release approval.`,
    };
  });
  for (const id of result.ids) {
    const view = await getIssue(deps.db, actor, ctx.orgId, { id });
    await publishToTaskReaders(deps, ctx.orgId, view, { type: "issue.updated", issue: view });
  }
  return result.content;
}

function packetOf(submission: Submission, review: Review) {
  return `Ready for owner review; not accepted or released.\nRevision: ${submission.revision}\nPreview: ${submission.preview}\nArtifacts: ${submission.paths.join("; ")}\nImplementation checks: ${submission.checks.join("; ")}\nIndependent QA: ${review.summary}\nQA evidence: ${review.evidence.join("; ")}`;
}

/** Only Missions explicitly bound by the manager's canonical-thread configuration gain this additional gate. */
export async function missionDeliveryReadiness(db: Executor, orgId: string, missionId: string) {
  const bindings = await db
    .select({ issueId: issueActivity.issueId })
    .from(issueActivity)
    .where(
      and(
        eq(issueActivity.orgId, orgId),
        eq(issueActivity.event, CONTRACT),
        sql`${issueActivity.data}->>'missionId' = ${missionId}`,
      ),
    );
  if (bindings.length === 0) return null;
  const [mission] = await db
    .select()
    .from(missions)
    .where(and(eq(missions.orgId, orgId), eq(missions.id, missionId)));
  const packets: string[] = [];
  const paths: string[] = [];
  const receipts: DeliveryReceipt[] = [];
  for (const id of new Set(bindings.map((r) => r.issueId))) {
    const contract = await latest<Contract>(db, orgId, id, CONTRACT);
    if (!contract || contract.parentId !== id || contract.missionId !== missionId) continue;
    const { submission, review } = await currentDelivery(db, orgId, contract);
    const rows = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.orgId, orgId),
          inArray(issues.id, [contract.parentId, contract.implementationId, contract.reviewId]),
        ),
      );
    const impl = rows.find((t) => t.id === contract.implementationId);
    const qa = rows.find((t) => t.id === contract.reviewId);
    const manager = rows.find((t) => t.id === contract.parentId);
    if (!mission || !(await missionEvidenceNameable(db, mission, rows)))
      return {
        ready: false as const,
        summary: "Delivery evidence is no longer visible to the canonical Mission audience.",
        paths: [],
        receipts: [],
      };
    if (
      !submission ||
      review?.verdict !== "passed" ||
      !impl ||
      !qa ||
      !manager ||
      manager.status !== "in_review" ||
      impl.assigneeType !== "agent" ||
      qa.assigneeType !== "agent" ||
      manager.assigneeType !== "agent" ||
      impl.assigneeId !== contract.implementerId ||
      qa.assigneeId !== contract.reviewerId ||
      manager.assigneeId !== contract.managerId ||
      criteriaKey(impl) !== submission.implementationCriteria ||
      criteriaKey(qa) !== review.reviewCriteria ||
      impl.criteria.some((c) => !c.done) ||
      qa.criteria.some((c) => !c.done) ||
      impl.status !== "done" ||
      qa.status !== "done"
    )
      return {
        ready: false as const,
        summary:
          "The engineering delivery contract still needs the current artifact/preview submission and independent QA of that exact revision.",
        paths: [],
        receipts: [],
      };
    packets.push(
      `Task #${manager.number}: ready for owner review, not accepted or released.\nRevision: ${submission.revision}\nPreview: ${submission.preview}\nIndependent QA #${qa.number}: ${review.summary}\nFull artifact paths, observed checks and QA evidence are in the existing task's delivery receipt.`,
    );
    paths.push(...submission.paths);
    receipts.push({ parentId: id, contractId: contract.id, submissionId: submission.id });
  }
  return { ready: packets.length > 0, summary: packets.join("\n\n"), paths: [...new Set(paths)], receipts };
}

/** Called inside the person's acceptance transaction. Locks shared task rows before checking the exact card. */
export async function acceptMissionDeliveryTasks(
  db: Executor,
  orgId: string,
  missionId: string,
  deliveryId: string,
  userId: string,
) {
  await db
    .select({ id: missions.id })
    .from(missions)
    .where(and(eq(missions.orgId, orgId), eq(missions.id, missionId)))
    .for("update");
  const bindings = await db
    .select({ issueId: issueActivity.issueId })
    .from(issueActivity)
    .where(
      and(
        eq(issueActivity.orgId, orgId),
        eq(issueActivity.event, CONTRACT),
        sql`${issueActivity.data}->>'missionId' = ${missionId}`,
      ),
    );
  if (!bindings.length) return [];
  const ids = [...new Set(bindings.map((r) => r.issueId))];
  await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.orgId, orgId), inArray(issues.id, ids)))
    .orderBy(issues.id)
    .for("update");
  const readiness = await missionDeliveryReadiness(db, orgId, missionId);
  const [delivered] = await db
    .select({ data: missionEvents.data })
    .from(missionEvents)
    .where(
      and(
        eq(missionEvents.orgId, orgId),
        eq(missionEvents.missionId, missionId),
        eq(missionEvents.kind, "delivered"),
        sql`${missionEvents.data}->>'deliveryId' = ${deliveryId}`,
      ),
    )
    .limit(1);
  const expected = (delivered?.data.deliveryReceipts ?? []) as DeliveryReceipt[];
  const key = (r: DeliveryReceipt) => `${r.parentId}:${r.contractId}:${r.submissionId}`;
  if (
    !readiness?.ready ||
    JSON.stringify(expected.map(key).sort()) !== JSON.stringify(readiness.receipts.map(key).sort())
  )
    throw new ConflictError(
      "This delivery card no longer matches the independently reviewed revision. The manager must provide a current review packet.",
    );
  for (const receipt of readiness.receipts) {
    const [task] = await db
      .update(issues)
      .set({ status: "done", blocked: null, columnId: null, updatedAt: new Date() })
      .where(and(eq(issues.orgId, orgId), eq(issues.id, receipt.parentId)))
      .returning();
    if (task)
      await db.insert(issueActivity).values({
        orgId,
        issueId: task.id,
        kind: "event",
        authorType: "person",
        authorId: userId,
        event: "status_changed",
        text: "Owner accepted the reviewed delivery. Release approval remains separate.",
        data: { from: "in_review", to: "done", deliveryId, ...receipt },
      });
  }
  return readiness.receipts.map((receipt) => receipt.parentId);
}

/** Publish committed owner acceptance so the existing task board moves without a manual refresh. */
export async function publishAcceptedDeliveryTasks(deps: IssueDeps, orgId: string, userId: string, ids: string[]) {
  for (const id of ids) {
    const view = await getIssue(deps.db, { type: "person", userId }, orgId, { id });
    await publishToTaskReaders(deps, orgId, view, { type: "issue.updated", issue: view });
  }
}
