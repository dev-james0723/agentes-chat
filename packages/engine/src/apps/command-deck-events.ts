import { rowsOf, type SQL, schema, sql } from "@agenteschat/db";
import { z } from "zod";
import { sha256 } from "../crypto";
import { ValidationError } from "../errors";
import { followsThreadSql } from "../follows";
import { landedAfterSql } from "../message-place";
import { readableBody } from "../message-preview";
import { quietNoticeSql } from "../notices";
import { notificationSnippet } from "../notifications";
import { requirePermission } from "../organizations";
import type { AppPrincipal } from "./grants";
import type { AppsToolDeps, RegisterTool } from "./tools";
import { appsUrls } from "./urls";

const eventsInput = z
  .object({
    cursor: z.string().max(400).optional().describe("The previous cursor; omit it to start quietly without history"),
    limit: z.number().int().min(1).max(100).optional().describe("New events per page, 1 to 100 (default 100)"),
    tracked_message_ids: z
      .array(z.uuid())
      .max(100)
      .optional()
      .describe("Up to 100 recent message ids to revalidate independently of the cursor; drop omitted results"),
  })
  .strict();

const cursorShape = z
  .object({
    v: z.literal(1),
    s: z.string().length(64),
    a: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
  })
  .strict();

const encodeCursor = (scope: string, after: string) =>
  Buffer.from(JSON.stringify({ v: 1, s: scope, a: after })).toString("base64url");

function decodeCursor(cursor: string, scope: string) {
  try {
    if (!/^[\w-]+$/.test(cursor)) throw new Error();
    const parsed = cursorShape.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    if (parsed.s !== scope) throw new Error();
    return parsed.a;
  } catch {
    throw new ValidationError("This cursor belongs to another command deck or is invalid. Start again without cursor.");
  }
}

/** UUIDv7's first 48 bits are the insertion clock, independent of a message's display placement. */
const postedAt = (id: string) => new Date(Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16));
const iso = (value: Date | string) => new Date(value).toISOString();

type EventRow = {
  id: string;
  channel_id: string;
  thread_id: string | null;
  agent_id: string;
  agent_name: string;
  agent_handle: string;
  body: string;
  meta: Record<string, unknown> | string;
  created_at: Date | string;
  kind: "channel" | "dm";
  dm_agent_id: string | null;
  dm_user_id: string | null;
  unread: boolean;
  last_read_at: Date | string | null;
  thread_last_read_at: Date | string | null;
};

/**
 * Both cursor pages and tracked-message refreshes pass this same reader. A directory-visible channel does not
 * subscribe someone to its activity: even administrators must have joined it. DMs are participants only.
 */
async function readEvents(deps: AppsToolDeps, p: AppPrincipal, where: SQL, limit: number, origin: string) {
  const m = { id: sql`m.id`, createdAt: sql`m.created_at` };
  const channelReadAt = sql`case when c.kind = 'dm' then cr.last_read_at
    else coalesce(cr.last_read_at, cm.created_at) end`;
  const unread = sql`${landedAfterSql(m, sql`coalesce(${channelReadAt}, 'epoch'::timestamptz)`)}
    and (c.kind = 'dm' or m.thread_id is null
      or ((${p.userId} = any(m.mentioned_user_ids)
        or ${followsThreadSql(p.orgId, p.userId, sql`m.thread_id`)})
        and ${landedAfterSql(m, sql`coalesce(tr.last_read_at, '-infinity'::timestamptz)`)}))`;
  const rows = rowsOf<EventRow>(
    await deps.db.execute(sql`select m.id, m.channel_id, m.thread_id, m.author_agent_id as agent_id,
        a.name as agent_name, a.handle as agent_handle, m.body, m.meta, m.created_at, c.kind,
        other.agent_id as dm_agent_id, other.user_id as dm_user_id,
        (${unread}) as unread, ${channelReadAt} as last_read_at, tr.last_read_at as thread_last_read_at
      from ${schema.messages} m
      join ${schema.channels} c on c.org_id = m.org_id and c.id = m.channel_id
      join ${schema.channelMembers} cm on cm.org_id = c.org_id and cm.channel_id = c.id and cm.user_id = ${p.userId}
      join ${schema.agents} a on a.org_id = m.org_id and a.id = m.author_agent_id
      left join ${schema.channelReads} cr
        on cr.org_id = c.org_id and cr.channel_id = c.id and cr.user_id = ${p.userId}
      left join ${schema.threadReads} tr
        on tr.org_id = m.org_id and tr.channel_id = c.id and tr.root_message_id = m.thread_id and tr.user_id = ${p.userId}
      left join ${schema.threadFollows} tf
        on tf.org_id = m.org_id and tf.channel_id = c.id and tf.root_message_id = m.thread_id and tf.user_id = ${p.userId}
      left join lateral (
        select peer.agent_id, peer.user_id from ${schema.channelMembers} peer
        where c.kind = 'dm' and peer.org_id = c.org_id and peer.channel_id = c.id
          and (peer.user_id is null or peer.user_id <> ${p.userId})
        order by peer.id limit 1
      ) other on true
      where m.org_id = ${p.orgId}::uuid and m.author_type = 'agent' and m.deleted_at is null
        and c.kind in ('channel', 'dm') and c.archived_at is null and c.deleted_at is null
        and coalesce(cr.muted, false) = false and tf.following is distinct from false
        and not ${quietNoticeSql(sql`m.meta`)} and m.meta->>'mediaAfter' is null
        and (c.kind = 'channel' or other.agent_id is not null or other.user_id is not null)
        and ${where}
      order by m.id asc limit ${limit}`),
  );
  return rows.map((row) => {
    const base = `${origin}/org/${p.orgId}`;
    const target = row.thread_id
      ? `threads/${row.thread_id}`
      : row.kind === "channel"
        ? `c/${row.channel_id}`
        : row.dm_agent_id
          ? `dm/agent/${row.dm_agent_id}`
          : `dm/person/${encodeURIComponent(row.dm_user_id ?? "")}`;
    const meta = typeof row.meta === "string" ? (JSON.parse(row.meta) as Record<string, unknown>) : row.meta;
    return {
      id: row.id,
      kind: "message.created" as const,
      messageId: row.id,
      channelId: row.channel_id,
      threadId: row.thread_id,
      agentId: row.agent_id,
      agentName: row.agent_name,
      agentHandle: row.agent_handle,
      preview: notificationSnippet(readableBody(row.body, meta), 280),
      createdAt: iso(row.created_at),
      postedAt: postedAt(row.id).toISOString(),
      url: `${base}/${target}?m=${row.id}`,
      unread: row.unread === true,
      lastReadAt: row.last_read_at ? iso(row.last_read_at) : null,
      threadLastReadAt: row.thread_last_read_at ? iso(row.thread_last_read_at) : null,
    };
  });
}

/** Bounded reads of committed agent messages, including unmentioned replies; not a durable event log (ADR 0119). */
export function registerCommandDeckEventsTool(deps: AppsToolDeps, p: AppPrincipal, tool: RegisterTool) {
  tool(
    "get_command_deck_events",
    {
      scope: "read",
      title: "Read command deck conversation updates",
      description:
        "New committed agent messages in joined channels and the person's DMs, including thread replies. Omit cursor for a quiet start; then page until hasMore is false. Tracked ids refresh current visibility and unread state without advancing the cursor. This is not an edit, delete or token stream.",
      input: eventsInput,
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: false,
      untrustedContent: true,
    },
    async (args) => {
      await requirePermission(deps.db, p.userId, p.orgId, "read");
      const origin = new URL(appsUrls(deps.publicUrl).issuer).origin;
      const scope = sha256(JSON.stringify([origin, p.orgId, p.userId]));
      const seeded = args.cursor === undefined;
      const after = args.cursor === undefined ? Bun.randomUUIDv7() : decodeCursor(args.cursor, scope);
      const limit = args.limit ?? 100;
      const trackedIds = [...new Set(args.tracked_message_ids ?? [])];
      // UUIDv7 orders insertion, while the existing placement bound keeps the channel/time index useful.
      // An in-flight transaction committing behind a delivered cursor is not a durable-log guarantee.
      const [page, trackedEvents] = await Promise.all([
        seeded
          ? Promise.resolve([])
          : readEvents(
              deps,
              p,
              sql`m.id > ${after}::uuid and ${landedAfterSql(
                { id: sql`m.id`, createdAt: sql`m.created_at` },
                postedAt(after),
              )}`,
              limit + 1,
              origin,
            ),
        trackedIds.length === 0
          ? Promise.resolve([])
          : readEvents(
              deps,
              p,
              sql`m.id in (${sql.join(
                trackedIds.map((id) => sql`${id}::uuid`),
                sql`, `,
              )})`,
              trackedIds.length,
              origin,
            ),
      ]);
      const events = page.slice(0, limit);
      return {
        schemaVersion: 1,
        observedAt: new Date().toISOString(),
        viewerId: p.userId,
        workspace: { id: p.orgId, origin },
        seeded,
        events,
        trackedEvents,
        cursor: encodeCursor(scope, events.at(-1)?.id ?? after),
        hasMore: page.length > limit,
      };
    },
  );
}
