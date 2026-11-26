import { and, type Database, eq, schema, sql } from "@agenteschat/db";
import { z } from "zod";
import { requireChannelAccess } from "../channels";
import { NotFoundError, ValidationError } from "../errors";
import { listRuns } from "../management";
import { getMessage } from "../messages";
import type { AppPrincipal } from "./grants";
import { directReply } from "./tools";

export const appExerciseInput = z
  .object({
    task_id: z.uuid(),
    run_id: z.uuid(),
    agent_id: z.uuid(),
    reply_id: z.uuid(),
    machine: z.string().trim().min(1).max(200),
    target: z.string().min(1).max(300),
    output_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const witness = z
  .object({
    machineId: z.uuid(),
    surface: z.enum(["desktop", "browser"]),
    target: z.string().max(300),
    operation: z.enum(["click", "press", "select", "double_click"]),
    outputHash: digest,
    snapshotHash: digest,
    size: z
      .number()
      .int()
      .positive()
      .max(16 * 1024 * 1024),
  })
  .strict();

export async function readAppExercise(db: Database, p: AppPrincipal, args: z.infer<typeof appExerciseInput>) {
  return db.transaction(
    async (tx) => {
      const d = tx as unknown as Database;
      const { agentRuns: r, agentRunSteps: s, machines: m } = schema;
      const [run] = await d
        .select()
        .from(r)
        .where(
          and(
            eq(r.orgId, p.orgId),
            eq(r.id, args.run_id),
            eq(r.agentId, args.agent_id),
            eq(r.triggerMessageId, args.task_id),
            eq(r.replyMessageId, args.reply_id),
            eq(r.status, "done"),
          ),
        );
      if (!run) throw new NotFoundError("No readable original app exercise.");
      const [readable] = await listRuns(d, p.userId, p.orgId, { agentId: args.agent_id, runId: run.id });
      if (!readable || readable.private) throw new NotFoundError("No readable original app exercise.");
      await requireChannelAccess(d, p.userId, p.orgId, run.channelId);
      const trigger = await getMessage(d, p.orgId, args.task_id),
        reply = await getMessage(d, p.orgId, args.reply_id);
      const direct = trigger && reply && (await directReply(d, p, trigger, run, reply));
      if (!direct) throw new NotFoundError("No readable original app exercise.");
      const machine = await d
        .select({ id: m.id })
        .from(m)
        .where(
          and(
            eq(m.orgId, p.orgId),
            z.uuid().safeParse(args.machine).success ? eq(m.id, args.machine) : eq(m.name, args.machine),
          ),
        )
        .limit(2);
      const observations: {
        id: string;
        seq: number;
        machine_id: string;
        surface: string;
        target: string;
        operation: string;
        output_sha256: string;
        snapshot_sha256: string;
        snapshot_bytes: number;
      }[] = [];
      if (machine.length === 1 && machine[0]) {
        const machineId = machine[0].id;
        const w = sql`${s.data}->'data'->'appExercise'`;
        const rows = await d
          .select({ id: s.id, seq: s.seq, stamp: w })
          .from(s)
          .where(
            and(
              eq(s.orgId, p.orgId),
              eq(s.runId, run.id),
              eq(s.kind, "tool_result"),
              sql`${s.data}->'isError' = 'false'::jsonb AND (${s.data}->'external' IS NULL OR ${s.data}->'external' = 'false'::jsonb)
    AND ((${s.data}->>'name'='desktop_do' AND ${w}->>'surface'='desktop') OR (${s.data}->>'name'='browser_do' AND ${w}->>'surface'='browser'))
    AND ${w}->>'machineId'=${machineId} AND ${w}->>'target'=${args.target} AND ${w}->>'outputHash'=${args.output_sha256}
    AND pg_column_size(${w})<4096`,
            ),
          )
          .orderBy(s.seq)
          .limit(9);
        if (rows.length > 8) throw new ValidationError("Too many matching native observations.");
        for (const row of rows) {
          const data = witness.safeParse(row.stamp);
          if (!data.success) continue;
          const x = data.data;
          observations.push({
            id: row.id,
            seq: row.seq,
            machine_id: machineId,
            surface: x.surface,
            target: x.target,
            operation: x.operation,
            output_sha256: x.outputHash,
            snapshot_sha256: x.snapshotHash,
            snapshot_bytes: x.size,
          });
        }
      }
      return { direct_reply: direct, observations };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
