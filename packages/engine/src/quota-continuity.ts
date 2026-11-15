import { and, desc, type Executor, eq, type SQL, schema, sql } from "@agenteschat/db";
import { z } from "zod";
import type { BrainPlan } from "./brains/select";

const identity = z.object({
  orgId: z.uuid(),
  agentId: z.uuid(),
  runId: z.uuid(),
  channelId: z.uuid(),
  threadId: z.uuid(),
  triggerMessageId: z.uuid(),
  workId: z.uuid().nullable(),
  issueId: z.uuid().nullable(),
  ownerUserId: z.string().max(200).nullable(),
});
const route = z.object({
  kind: z.string().max(40),
  model: z.string().max(300).nullable(),
  machineId: z.string().max(200).nullable(),
  accountId: z.string().max(200).nullable(),
  sessionId: z.string().max(200).nullable(),
});
const checkpoint = z.object({
  version: z.literal(1),
  identity,
  route,
  waitId: z.uuid(),
  code: z.enum(["plan_limit", "budget", "usage_pause"]),
  capturedAt: z.iso.datetime(),
  consumedAt: z.iso.datetime().nullable(),
  state: z.enum(["captured", "consumed"]),
  nextSafeAction: z.enum(["RECONCILE_EFFECT", "RESUME_SAME_HARNESS"]),
  goal: z.object({ messageId: z.uuid(), version: z.null() }),
  task: z.object({ issueId: z.uuid().nullable(), version: z.null() }),
  constraints: z.null(),
  reviewers: z.null(),
  dependencies: z.null(),
  quota: z.object({ usedPercent: z.number().nonnegative().nullable(), resetsAt: z.iso.datetime().nullable() }),
  lastStepSeq: z.number().int().nonnegative(),
  evidenceTruncated: z.boolean(),
  completedReceipts: z
    .array(z.object({ seq: z.number().int().positive(), outcome: z.enum(["returned", "error"]) }))
    .max(64),
  unresolvedEffects: z
    .array(
      z.object({
        seq: z.number().int().nonnegative(),
        reason: z.enum(["missing_result", "host_unknown", "truncated"]),
      }),
    )
    .max(64),
});

export type QuotaContinuity = z.infer<typeof checkpoint>;
type Run = typeof schema.agentRuns.$inferSelect;
type Agent = Pick<typeof schema.agents.$inferSelect, "ownerUserId" | "machineId" | "model">;
export const QUOTA_CONTINUITY_MAX_BYTES = 16_384;

export function quotaContinuityValue(t: { metadata?: unknown } | null | undefined): unknown {
  const m = t?.metadata;
  return m && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, unknown>).quotaContinuity : null;
}

const routeOf = (agent: Agent, plan: BrainPlan): QuotaContinuity["route"] => ({
  kind: plan.kind,
  model: (plan.kind === "model" ? agent.model : plan.model) ?? null,
  machineId: plan.session?.machineId ?? agent.machineId ?? null,
  accountId: plan.account?.id ?? null,
  sessionId: plan.session?.id ?? null,
});
const identityOf = (run: Run, agent: Agent): QuotaContinuity["identity"] => ({
  orgId: run.orgId,
  agentId: run.agentId,
  runId: run.id,
  channelId: run.channelId,
  threadId: run.threadRootId,
  triggerMessageId: run.triggerMessageId,
  workId: run.workId,
  issueId: run.issueId,
  ownerUserId: agent.ownerUserId,
});

/** Defensive reader, never a model-supplied authorization or a portable vendor session. */
export function readQuotaContinuity(value: unknown): QuotaContinuity | null {
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > QUOTA_CONTINUITY_MAX_BYTES) return null;
    const parsed = checkpoint.safeParse(value);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Native references only: no summaries, raw tools, prompt text or invented goal/task versions. */
export async function captureQuotaContinuity(
  db: Executor,
  run: Run,
  agent: Agent,
  plan: BrainPlan,
  wait: { waitId: string; code: QuotaContinuity["code"]; resetsAt?: string; usedPercent?: number },
  hostUnknown = false,
  now = new Date(),
): Promise<QuotaContinuity | null> {
  const steps = await db
    .select({
      seq: schema.agentRunSteps.seq,
      kind: schema.agentRunSteps.kind,
      toolUseId: sql<
        string | null
      >`coalesce(${schema.agentRunSteps.data}->>'toolUseId', ${schema.agentRunSteps.data}->>'id')`,
      error: sql<boolean>`${schema.agentRunSteps.data}->>'isError' = 'true'`,
    })
    .from(schema.agentRunSteps)
    .where(and(eq(schema.agentRunSteps.orgId, run.orgId), eq(schema.agentRunSteps.runId, run.id)))
    .orderBy(desc(schema.agentRunSteps.seq))
    .limit(129);
  const evidenceTruncated = steps.length > 128;
  const kept = steps.slice(0, 128);
  const results = kept.filter((s) => s.kind === "tool_result");
  const completedReceipts = results
    .slice(0, 64)
    .map((s) => ({ seq: s.seq, outcome: s.error ? ("error" as const) : ("returned" as const) }))
    .reverse();
  const missing = kept.filter(
    (s) =>
      s.kind === "tool_call" && (!s.toolUseId || !results.some((r) => r.toolUseId === s.toolUseId && r.seq > s.seq)),
  );
  const unresolvedEffects: QuotaContinuity["unresolvedEffects"] = missing
    .slice(0, 62)
    .map((s) => ({ seq: s.seq, reason: "missing_result" }));
  if (hostUnknown) unresolvedEffects.push({ seq: kept[0]?.seq ?? 0, reason: "host_unknown" });
  const truncated = evidenceTruncated || results.length > 64 || missing.length > 62;
  if (truncated) unresolvedEffects.push({ seq: kept[0]?.seq ?? 0, reason: "truncated" });
  return readQuotaContinuity({
    version: 1,
    identity: identityOf(run, agent),
    route: routeOf(agent, plan),
    waitId: wait.waitId,
    code: wait.code,
    capturedAt: now.toISOString(),
    consumedAt: null,
    state: "captured",
    nextSafeAction: unresolvedEffects.length ? "RECONCILE_EFFECT" : "RESUME_SAME_HARNESS",
    goal: { messageId: run.triggerMessageId, version: null },
    task: { issueId: run.issueId, version: null },
    constraints: null,
    reviewers: null,
    dependencies: null,
    quota: { usedPercent: wait.usedPercent ?? null, resetsAt: wait.resetsAt ?? null },
    lastStepSeq: kept[0]?.seq ?? 0,
    evidenceTruncated: truncated,
    completedReceipts,
    unresolvedEffects,
  });
}

/** Compare native current identities and exact same route; this cannot claim/dispatch/replay a job. */
export function consumeQuotaContinuity(
  value: unknown,
  run: Run,
  agent: Agent,
  plan: BrainPlan,
  waitId: string,
  now = new Date(),
): QuotaContinuity | null {
  const old = readQuotaContinuity(value);
  if (
    old?.state !== "captured" ||
    old.waitId !== waitId ||
    run.status !== "running" ||
    JSON.stringify(old.identity) !== JSON.stringify(identityOf(run, agent)) ||
    JSON.stringify(old.route) !== JSON.stringify(routeOf(agent, plan))
  )
    return null;
  return { ...old, state: "consumed", consumedAt: now.toISOString() };
}

/** Namespace-only merge from the current SQL row; a stale engine copy cannot replace other metadata/capture. */
export function quotaContinuityTranscript(base: SQL, value: QuotaContinuity): SQL {
  const current = schema.agentRuns.transcript;
  const kept = sql`(${base}
    || case when ${current} ? 'metadata' then jsonb_build_object('metadata', ${current}->'metadata') else '{}'::jsonb end
    || case when ${current} ? 'publicationCapture' then jsonb_build_object('publicationCapture', ${current}->'publicationCapture') else '{}'::jsonb end)`;
  return sql`case when ${current}->'metadata' is null or jsonb_typeof(${current}->'metadata') = 'object'
    then jsonb_set(${kept}, '{metadata}', coalesce(${current}->'metadata', '{}'::jsonb) || jsonb_build_object('quotaContinuity', ${JSON.stringify(value)}::jsonb))
    else ${kept} end`;
}

/** Call only after native viewer ACL. No source text, account/session IDs or hidden audience fields. */
export function quotaContinuityProjection(value: unknown) {
  const item = readQuotaContinuity(value);
  return item
    ? {
        version: item.version,
        state: item.state,
        capturedAt: item.capturedAt,
        nextSafeAction: item.nextSafeAction,
        completedReceipts: item.completedReceipts.length,
        unresolvedEffects: item.unresolvedEffects.length,
        evidenceTruncated: item.evidenceTruncated,
      }
    : null;
}
