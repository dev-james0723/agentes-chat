import { and, type Database, eq, isNull, schema, sql } from "@agenteschat/db";
import { z } from "zod";
import { recordAudit } from "../audit";
import { requireChannelAccess } from "../channels";
import { sha256 } from "../crypto";
import { ConflictError, ValidationError } from "../errors";
import { createIssueInTransaction, getIssue } from "../issues";
import { requirePermission } from "../organizations";
import { ensureTaskConversation } from "../task-conversation";
import type { AppPrincipal } from "./grants";
import type { AppsToolDeps, RegisterTool } from "./tools";

const { auditLog, issues, messages } = schema;
const BINDING = "apps.source_task.bound";
const REQUEST = "apps.source_task.ensured";

export const sourceTaskReadInput = z
  .object({
    source_url: z.string().min(1).max(2048),
    expected_issue_id: z.uuid().optional(),
  })
  .strict();

export const sourceTaskEnsureInput = sourceTaskReadInput
  .extend({
    idempotency_key: z.string().min(1).max(64),
  })
  .strict();

type Source = { key: string; url: string };
type ReadInput = z.infer<typeof sourceTaskReadInput>;
type EnsureInput = z.infer<typeof sourceTaskEnsureInput>;
type Binding = typeof auditLog.$inferSelect;

/** Source identity only: this does not fetch a URL or authorize adoption. */
function sourceOf(raw: string): Source {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError("Source URL is invalid.");
  }
  if (url.protocol !== "https:" || url.username || url.password)
    throw new ValidationError("Source URL requires HTTPS without credentials.");
  url.hash = "";
  const host = url.hostname.toLowerCase();
  if (["x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"].includes(host) && url.port)
    throw new ValidationError("X source URLs require the default HTTPS port.");
  const post = /^\/(?:i\/web|i|[^/]+)\/status\/([0-9]{1,30})(?:\/(?:photo|video)\/[0-9]+)?\/?$/.exec(url.pathname);
  if (["x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"].includes(host) && post)
    return { key: `x:${post[1]}`, url: `https://x.com/i/status/${post[1]}` };
  return { key: `url:${sha256(url.href)}`, url: url.href };
}

async function bindingFor(db: Database, p: AppPrincipal, source: Source) {
  // No grant filter or TTL: token/app re-authorization keeps the same owner's source task.
  const rows = await db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.orgId, p.orgId),
        eq(auditLog.actorType, "person"),
        eq(auditLog.actorId, p.userId),
        eq(auditLog.action, BINDING),
        sql`${auditLog.details}->>'sourceKey' = ${source.key}`,
      ),
    )
    .limit(2);
  if (rows.length > 1) throw new ConflictError("Canonical source binding needs reconciliation.");
  const row = rows[0];
  if (
    row &&
    (row.targetType !== "issue" ||
      row.details.schemaVersion !== 1 ||
      row.details.sourceUrl !== source.url ||
      !row.targetId)
  )
    throw new ConflictError("Canonical source binding needs reconciliation.");
  return row ?? null;
}

async function boundView(db: Database, p: AppPrincipal, source: Source, bound: Binding, expected?: string) {
  if (expected && expected !== bound.targetId)
    throw new ConflictError("Canonical source task does not match the expected native issue.");
  // The immutable binding remains a tombstone if the issue is deleted. No replacement is created.
  if (!bound.targetId) throw new ConflictError("Canonical source binding needs reconciliation.");
  const issue = await getIssue(db, { type: "person", userId: p.userId }, p.orgId, { id: bound.targetId });
  const [stored] = await db
    .select({
      channelId: issues.conversationChannelId,
      rootId: issues.conversationRootId,
    })
    .from(issues)
    .where(and(eq(issues.orgId, p.orgId), eq(issues.id, issue.id)));
  if (
    !stored?.channelId ||
    !stored.rootId ||
    stored.channelId !== bound.details.channelId ||
    stored.rootId !== bound.details.rootId
  )
    throw new ConflictError("Canonical task conversation needs reconciliation.");
  const { channel } = await requireChannelAccess(db, p.userId, p.orgId, stored.channelId);
  const [root] = await db
    .select({ id: messages.id, meta: messages.meta })
    .from(messages)
    .where(
      and(
        eq(messages.orgId, p.orgId),
        eq(messages.id, stored.rootId),
        eq(messages.channelId, stored.channelId),
        isNull(messages.threadId),
        isNull(messages.deletedAt),
      ),
    );
  const task = root?.meta?.taskConversation as { issueId?: unknown } | undefined;
  if (channel.kind !== "task" || task?.issueId !== issue.id)
    throw new ConflictError("Canonical task conversation needs reconciliation.");
  return {
    state: "bound",
    schema_version: 1,
    source_key: source.key,
    source_url: source.url,
    workspace_id: p.orgId,
    owner_user_id: p.userId,
    binding_id: bound.id,
    bound_at: bound.createdAt.toISOString(),
    issue_id: issue.id,
    issue_number: issue.number,
    channel_id: stored.channelId,
    channel_kind: "task",
    thread_id: stored.rootId,
  };
}

export async function readSourceTask(deps: AppsToolDeps, p: AppPrincipal, input: ReadInput) {
  await requirePermission(deps.db, p.userId, p.orgId, "read");
  const source = sourceOf(input.source_url);
  const bound = await bindingFor(deps.db, p, source);
  if (!bound) {
    if (input.expected_issue_id) throw new ConflictError("Expected canonical source binding is unavailable.");
    return {
      state: "unbound",
      schema_version: 1,
      source_key: source.key,
      source_url: source.url,
      workspace_id: p.orgId,
      owner_user_id: p.userId,
    };
  }
  return boundView(deps.db, p, source, bound, input.expected_issue_id);
}

export async function ensureSourceTask(deps: AppsToolDeps, p: AppPrincipal, input: EnsureInput) {
  const source = sourceOf(input.source_url);
  const digest = sha256(JSON.stringify([source.key, source.url, input.expected_issue_id ?? null]));
  return deps.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    await requirePermission(db, p.userId, p.orgId, "post");
    // Same source, different events/grants/keys: one native issue. Same request key,
    // different source: a conflict. Both locks and every native write share this transaction.
    await db.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([
        BINDING,
        p.orgId,
        p.userId,
        source.key,
      ])}, 0))`,
    );
    await db.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([
        REQUEST,
        p.grantId,
        input.idempotency_key,
      ])}, 0))`,
    );
    const requests = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.orgId, p.orgId),
          eq(auditLog.actorType, "person"),
          eq(auditLog.actorId, p.userId),
          eq(auditLog.action, REQUEST),
          sql`${auditLog.details}->>'grantId' = ${p.grantId} AND ${auditLog.details}->>'key' = ${input.idempotency_key}`,
        ),
      )
      .limit(2);
    if (requests.length > 1 || (requests[0] && requests[0].details.digest !== digest))
      throw new ConflictError("Source task request key belongs to another request.");
    let bound = await bindingFor(db, p, source);
    if (
      requests[0] &&
      (!bound || requests[0].targetId !== bound.targetId || requests[0].details.bindingId !== bound.id)
    )
      throw new ConflictError("Previously ensured source task needs reconciliation.");
    let created = false;
    if (!bound) {
      if (input.expected_issue_id) throw new ConflictError("Expected canonical source binding is unavailable.");
      const issue = await createIssueInTransaction(deps, tx, { type: "person", userId: p.userId }, p.orgId, {
        title: source.key.startsWith("x:")
          ? `Saved X post ${source.key.slice(2)}`
          : `Saved source: ${new URL(source.url).host}`,
        description: `Saved source: ${source.url}`,
        audience: { mode: "people", userIds: [p.userId] },
        source: { type: "manual" },
      });
      const conversation = await ensureTaskConversation(db, issue.id);
      await recordAudit(tx, {
        orgId: p.orgId,
        actor: { type: "person", id: p.userId },
        action: BINDING,
        target: { type: "issue", id: issue.id },
        details: {
          schemaVersion: 1,
          sourceKey: source.key,
          sourceUrl: source.url,
          grantId: p.grantId,
          channelId: conversation.channelId,
          rootId: conversation.rootId,
        },
      });
      bound = await bindingFor(db, p, source);
      if (!bound) throw new Error("Native source binding was not persisted.");
      created = true;
    }
    const result = await boundView(db, p, source, bound, input.expected_issue_id);
    if (!requests[0])
      await recordAudit(tx, {
        orgId: p.orgId,
        actor: { type: "person", id: p.userId },
        action: REQUEST,
        target: { type: "issue", id: bound.targetId },
        details: { grantId: p.grantId, key: input.idempotency_key, digest, bindingId: bound.id },
      });
    return { ...result, created, replayed: Boolean(requests[0]), idempotency_key: input.idempotency_key };
  });
}

export function registerSourceTaskTools(deps: AppsToolDeps, p: AppPrincipal, tool: RegisterTool) {
  tool(
    "ensure_source_task",
    {
      scope: "write",
      title: "Ensure a source task",
      description:
        "Creates or returns the owner's native task for a saved source and its task conversation. Repeated requests retain the binding. No agent message is sent.",
      input: sourceTaskEnsureInput,
      readOnly: false,
      destructive: false,
      idempotent: true,
      openWorld: false,
    },
    (args) => ensureSourceTask(deps, p, args),
  );
  tool(
    "read_source_task",
    {
      scope: "read",
      title: "Read a source task",
      description:
        "Reads the current native task binding for a saved source in this workspace. Returns unbound when no binding exists.",
      input: sourceTaskReadInput,
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: false,
    },
    (args) => readSourceTask(deps, p, args),
  );
}
