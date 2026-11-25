import { z } from "zod";
import { listAgentGroups } from "../agent-groups";
import { listChannels } from "../channels";
import { listDms } from "../dms";
import { listNotifications } from "../notifications";
import { getTeam } from "../team";
import type { AppPrincipal } from "./grants";
import type { AppsToolDeps, RegisterTool } from "./tools";
import { appsUrls } from "./urls";

const snapshotInput = z
  .object({
    notification_cursor: z.string().max(400).optional().describe("nextCursor from the previous notification page"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Notification items in this page, 1 to 100 (default 100)"),
  })
  .strict();

/** Read-only control surfaces use the same personal directory and inbox as the apps (ADR 0119). */
export function registerCommandDeckTool(deps: AppsToolDeps, p: AppPrincipal, tool: RegisterTool) {
  tool(
    "get_command_deck_snapshot",
    {
      scope: "read",
      title: "Read workspace command deck",
      description:
        "The workspace's visible agents, teams, channels, direct conversations and a page of the person's notification inbox, with unread counts and navigation metadata.",
      input: snapshotInput,
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: false,
      untrustedContent: true,
    },
    async (args) => {
      const [team, groups, channels, dms, notifications] = await Promise.all([
        getTeam(deps.db, p.userId, p.orgId),
        listAgentGroups(deps.db, p.userId, p.orgId),
        listChannels(deps.db, p.userId, p.orgId),
        listDms(deps.db, p.userId, p.orgId),
        listNotifications(deps, p.userId, p.orgId, {
          filter: "all",
          cursor: args.notification_cursor,
          limit: args.limit ?? 100,
        }),
      ]);
      const origin = new URL(appsUrls(deps.publicUrl).issuer).origin;
      return {
        schemaVersion: 1,
        viewerId: p.userId,
        observedAt: new Date().toISOString(),
        workspace: { id: p.orgId, name: p.orgName, origin, url: `${origin}/org/${p.orgId}/team` },
        agents: team.agents.map((agent) => ({
          id: agent.id,
          name: agent.name,
          handle: agent.handle,
          role: agent.role,
          appearance: agent.appearance,
          reportsToAgentId: agent.reportsToAgentId,
          busy: agent.busy,
          channelIds: agent.channelIds,
        })),
        teams: groups.map((group) => ({
          id: group.id,
          name: group.name,
          agentIds: group.agentIds,
          color: group.color,
          icon: group.icon,
        })),
        channels: channels.map((channel) => ({
          id: channel.id,
          name: channel.name,
          visibility: channel.visibility,
          categoryId: channel.categoryId,
          position: channel.position,
          isMember: channel.isMember,
          seenAsAdmin: channel.seenAsAdmin,
          unreadCount: channel.unreadCount,
          mentionCount: channel.mentionCount,
          lastReadAt: channel.lastReadAt?.toISOString() ?? null,
          muted: channel.muted,
          lastMessage: channel.lastMessage
            ? {
                id: channel.lastMessage.id,
                authorType: channel.lastMessage.authorType,
                authorId: channel.lastMessage.authorId,
                authorName: channel.lastMessage.authorName,
                preview: channel.lastMessage.preview,
                mediaKind: channel.lastMessage.mediaKind,
                createdAt: channel.lastMessage.createdAt.toISOString(),
              }
            : null,
        })),
        dms: dms.map((dm) => ({
          channelId: dm.channelId,
          with: dm.with,
          unread: dm.unread,
          lastReadAt: dm.lastReadAt?.toISOString() ?? null,
          everRead: dm.everRead,
          openedAt: dm.openedAt.toISOString(),
          lastMessage: dm.lastMessage
            ? {
                id: dm.lastMessage.id,
                authorType: dm.lastMessage.authorType,
                createdAt: dm.lastMessage.createdAt.toISOString(),
              }
            : null,
        })),
        notifications,
        coverage: { directoryComplete: true, notificationsComplete: notifications.nextCursor === null },
      };
    },
  );
}
