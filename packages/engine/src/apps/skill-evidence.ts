import { and, type Database, eq, schema, sql } from "@agenteschat/db";
import { z } from "zod";
import { NotFoundError, ValidationError } from "../errors";
import { listRuns } from "../management";
import { getMessage } from "../messages";
import { agentSkillList, getSkill } from "../skills";
import type { AppPrincipal } from "./grants";
import { cleanUntrusted } from "./tools";

const ids = z
  .array(z.uuid())
  .min(1)
  .max(8)
  .refine((v) => new Set(v).size === v.length, "Duplicate id");
export const skillEvidenceInput = z
  .object({ skill_id: z.uuid(), agent_ids: ids, run_ids: ids.optional(), task_ids: ids.optional() })
  .strict()
  .refine((v) => !!v.run_ids !== !!v.task_ids, "Give run_ids or task_ids");

function exactText(raw: string, limit: number) {
  const cleaned = cleanUntrusted(raw, limit);
  if (cleaned.truncated || cleaned.text !== raw)
    throw new ValidationError("Evidence text exceeds the limit or contains unsupported control characters.");
  return { untrusted_text: raw };
}

/** Only the grant's own directly-triggered runs, in conversations the person can still read. */
async function smokeRun(
  db: Database,
  p: AppPrincipal,
  id: string,
  byTask: boolean,
  agentIds: string[],
  skillId: string,
  workspaceUrl: string,
) {
  const { agentRuns: r, appSends: a, agentRunSteps: s } = schema;
  const records = await db
    .select({
      runId: r.id,
      agent: r.agentId,
      channel: r.channelId,
      triggerId: r.triggerMessageId,
      replyId: r.replyMessageId,
    })
    .from(r)
    .innerJoin(
      a,
      and(
        eq(a.messageId, r.triggerMessageId),
        eq(a.agentId, r.agentId),
        eq(a.channelId, r.channelId),
        eq(a.orgId, r.orgId),
        eq(a.grantId, p.grantId),
        eq(a.userId, p.userId),
      ),
    )
    .where(and(eq(r.orgId, p.orgId), byTask ? eq(r.triggerMessageId, id) : eq(r.id, id)))
    .limit(2);
  const [record] = records;
  if (records.length !== 1 || !record || !agentIds.includes(record.agent))
    throw new NotFoundError("No readable smoke run.");
  const runId = record.runId;
  const [run] = await listRuns(db, p.userId, p.orgId, { agentId: record.agent, runId });
  if (!run || run.private) throw new NotFoundError("No readable smoke run.");
  const trigger = await getMessage(db, p.orgId, record.triggerId);
  if (
    !trigger ||
    trigger.deletedAt ||
    trigger.editedAt ||
    trigger.channelId !== record.channel ||
    trigger.authorType !== "person" ||
    trigger.authorUserId !== p.userId
  )
    throw new NotFoundError("No readable original trigger.");
  const reply = record.replyId ? await getMessage(db, p.orgId, record.replyId) : null;
  if (
    reply &&
    (reply.deletedAt ||
      reply.editedAt ||
      reply.channelId !== record.channel ||
      reply.authorType !== "agent" ||
      reply.authorAgentId !== record.agent ||
      reply.agentRunId !== runId)
  )
    throw new NotFoundError("No readable original reply.");
  // Project only publication-safe metadata. Never select raw tool contents or model steps.
  const versionValue = sql`${s.data}->'data'->'skill'->'version'`;
  const rows = await db
    .select({
      seq: s.seq,
      version: sql<number>`(${versionValue} #>> '{}')::integer`,
    })
    .from(s)
    .where(
      and(
        eq(s.orgId, p.orgId),
        eq(s.runId, runId),
        eq(s.kind, "tool_result"),
        sql`${s.data}->>'name' = 'load_skill' AND ${s.data}->'isError' = 'false'::jsonb
        AND (${s.data}->'external' IS NULL OR ${s.data}->'external' = 'false'::jsonb)
        AND ${s.data}->'data'->'skill'->>'id' = ${skillId}
        AND jsonb_typeof(${versionValue}) = 'number'
        AND ${versionValue} BETWEEN '1'::jsonb AND '2147483647'::jsonb
        AND (${versionValue} #>> '{}') ~ '^[1-9][0-9]{0,9}$'`,
      ),
    )
    .orderBy(s.seq)
    .limit(33);
  if (rows.length > 32) throw new ValidationError("Too many skill loads in the smoke run.");
  return {
    run: { id: run.id, agentId: run.agentId, status: run.status, triggerMessageId: trigger.id },
    steps: rows.map(({ seq, version }) => ({
      seq,
      kind: "tool_result",
      data: { name: "load_skill", isError: false, data: { skill: { id: skillId, version } } },
    })),
    trigger: {
      id: trigger.id,
      url: `${workspaceUrl}/c/${record.channel}?m=${trigger.id}`,
      ...exactText(trigger.body, 8192),
    },
    reply: reply
      ? { id: reply.id, url: `${workspaceUrl}/c/${record.channel}?m=${reply.id}`, ...exactText(reply.body, 8192) }
      : null,
  };
}

export async function readSkillEvidence(
  db: Database,
  p: AppPrincipal,
  args: z.infer<typeof skillEvidenceInput>,
  workspaceUrl: string,
) {
  return db.transaction(
    async (tx) => {
      const snapshot = tx as unknown as Database;
      const skill = await getSkill(snapshot, p.userId, p.orgId, args.skill_id);
      if (skill.files.length > 128) throw new ValidationError("Too many files for this evidence response.");
      const assignments: Record<string, { skills: { id: string; version: number; enabled: boolean }[] }> = {};
      for (const id of args.agent_ids) {
        const list = await agentSkillList(snapshot, p.userId, p.orgId, id);
        const row = list.find((r) => r.id === skill.id);
        assignments[id] = { skills: row ? [{ id: row.id, version: row.version, enabled: row.enabled }] : [] };
      }
      const runs: Record<string, Awaited<ReturnType<typeof smokeRun>>> = {};
      for (const id of args.run_ids ?? args.task_ids ?? []) {
        const detail = await smokeRun(snapshot, p, id, !!args.task_ids, args.agent_ids, skill.id, workspaceUrl);
        runs[detail.run.id] = detail;
      }
      return {
        skill: {
          id: skill.id,
          name: skill.name,
          version: skill.version,
          body: exactText(skill.body, 32768),
          files: skill.files.map((f) => ({
            path: exactText(f.path, 300),
            size: f.size,
            mime: f.mime,
            status: f.status,
          })),
        },
        assignments,
        runs,
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
