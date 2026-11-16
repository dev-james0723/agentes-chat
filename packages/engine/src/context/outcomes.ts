import {
  and,
  type Database,
  desc,
  type Executor,
  eq,
  gte,
  inArray,
  isNull,
  notInArray,
  or,
  schema,
  sql,
} from "@agenteschat/db";

const { outcomes } = schema;

export type Outcome = typeof outcomes.$inferSelect;

/**
 * Kinds of ground truth we record about agent actions. Positive and negative
 * outcomes are the strongest evidence for lessons (docs/adr/0017).
 */
export const OUTCOME_KINDS = {
  tests_passed: "positive",
  tests_failed: "negative",
  ci_passed: "positive",
  ci_failed: "negative",
  pr_merged: "positive",
  pr_reverted: "negative",
  hotfix_after_merge: "negative",
  deploy_succeeded: "positive",
  deploy_rolled_back: "negative",
  error_spike: "negative",
  issue_closed: "positive",
  issue_reopened: "negative",
  approval_refused: "negative",
  /** How a run ended (`recordRunOutcome`): one per run, from its status, never from what the agent said. */
  run_done: "positive",
  run_failed: "negative",
  run_canceled: "negative",
  /** Failed held on a tool call whose effect nobody knows. */
  run_effect_unknown: "negative",
  /** Every acceptance criterion of a task checked. */
  criteria_met: "positive",
} as const;

export type OutcomeKind = keyof typeof OUTCOME_KINDS;

export interface OutcomeInput {
  orgId: string;
  kind: OutcomeKind;
  agentId?: string | null;
  runId?: string | null;
  stepSeq?: number | null;
  subject?: string;
  summary?: string;
  details?: Record<string, unknown>;
  source: "tool" | "approval" | "webhook" | "run" | "issue";
  channelId?: string | null;
  threadRootId?: string | null;
}

export async function recordOutcome(db: Executor, input: OutcomeInput): Promise<Outcome> {
  const [row] = await db
    .insert(outcomes)
    .values({
      orgId: input.orgId,
      agentId: input.agentId ?? null,
      runId: input.runId ?? null,
      stepSeq: input.stepSeq ?? null,
      kind: input.kind,
      polarity: OUTCOME_KINDS[input.kind],
      subject: input.subject ?? "",
      summary: (input.summary ?? "").slice(0, 1000),
      details: input.details ?? {},
      source: input.source,
      channelId: input.channelId ?? null,
      threadRootId: input.threadRootId ?? null,
    })
    .returning();
  if (!row) throw new Error("outcome insert returned nothing");
  return row;
}

type FinishedRun = Pick<
  typeof schema.agentRuns.$inferSelect,
  "id" | "orgId" | "agentId" | "channelId" | "threadRootId" | "status" | "error" | "transcript" | "issueId"
>;

/**
 * A run's terminal outcome, in the transaction that ended it (`transitionRun`): what the platform saw (its status,
 * its failure code, a hold on an unknown tool effect), so learning and routing have one per run.
 */
export async function recordRunOutcome(
  db: Executor,
  run: FinishedRun,
  failure?: { code: string | null; cause: string | null; infra?: boolean },
): Promise<void> {
  const hold = (run.transcript as { effectUncertain?: { tools?: unknown } | null } | null)?.effectUncertain;
  const kind: OutcomeKind | null =
    run.status === "done"
      ? "run_done"
      : run.status === "canceled"
        ? "run_canceled"
        : run.status === "failed"
          ? hold
            ? "run_effect_unknown"
            : "run_failed"
          : null;
  if (!kind) return;
  await recordOutcome(db, {
    orgId: run.orgId,
    kind,
    agentId: run.agentId,
    runId: run.id,
    summary: run.status === "done" ? "" : (run.error ?? ""),
    details: {
      ...(failure ? { code: failure.code, cause: failure.cause, ...(failure.infra ? { infra: true } : {}) } : {}),
      ...(hold && Array.isArray(hold.tools) ? { tools: hold.tools } : {}),
      ...(run.issueId ? { issueId: run.issueId } : {}),
    },
    source: "run",
    channelId: run.channelId,
    threadRootId: run.threadRootId,
  });
}

/**
 * The agent behind a subject (e.g. who merged `acme/app#42`), from earlier
 * outcomes: lets a webhook about a revert or an error spike be tied back to
 * the agent and run that caused it.
 */
export async function attributeSubject(db: Database, orgId: string, subject: string) {
  if (!subject) return null;
  const [row] = await db
    .select()
    .from(outcomes)
    .where(and(eq(outcomes.orgId, orgId), eq(outcomes.subject, subject)))
    .orderBy(desc(outcomes.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * Outcomes relevant to a thread: recorded in it, or by its agents since `since`. What says nothing about the work is
 * left out: a run that simply finished (`run_done`) or was canceled, and a failure of the infrastructure (a provider,
 * a plan, the computer). A run's or a task's outcome carries its own words (an error, a task's title), so one from
 * another conversation reaches this one only when it belongs to no conversation (`channelId`).
 */
export async function outcomesForThread(
  db: Database,
  orgId: string,
  input: { threadRootId: string; channelId?: string; agentIds: string[]; since: Date; limit?: number },
) {
  return db
    .select()
    .from(outcomes)
    .where(
      and(
        eq(outcomes.orgId, orgId),
        notInArray(outcomes.kind, ["run_done", "run_canceled"]),
        sql`not (${outcomes.kind} = 'run_failed' and coalesce(${outcomes.details}->>'infra', '') = 'true')`,
        or(
          notInArray(outcomes.source, ["run", "issue"]),
          isNull(outcomes.channelId),
          input.channelId ? eq(outcomes.channelId, input.channelId) : undefined,
        ),
        or(
          eq(outcomes.threadRootId, input.threadRootId),
          input.agentIds.length > 0
            ? and(inArray(outcomes.agentId, input.agentIds), gte(outcomes.createdAt, input.since))
            : undefined,
        ),
      ),
    )
    .orderBy(desc(outcomes.createdAt))
    .limit(input.limit ?? 20);
}
