import type { Executor } from "@agenteschat/db";
import { openPersonAgentDm } from "./dms";
import { insertMessage } from "./messages";
import { enqueue } from "./outbox";

/**
 * A message an agent starts in its DM with a person, outside any run (a report of work done in the background), and
 * the notification for it. Run it in the transaction that claims the report, so it is sent once.
 */
export async function postAgentReport(
  tx: Executor,
  input: { orgId: string; agentId: string; userId: string; body: string; meta: Record<string, unknown> },
) {
  const dm = await openPersonAgentDm(tx, input.orgId, input.userId, input.agentId);
  const message = await insertMessage(tx, {
    orgId: input.orgId,
    channelId: dm.id,
    threadId: null,
    author: { type: "agent", agentId: input.agentId, runId: null, hop: 0, stretchId: null },
    body: input.body,
    // `agentDm`: started by the agent, so the person is notified as for `send_dm`.
    meta: { agentDm: { fromChannelId: null, fromMessageId: null, fromThreadId: null }, ...input.meta },
  });
  await enqueue(tx, {
    orgId: input.orgId,
    kind: "notifications.message",
    payload: { messageId: message.id },
    dedupeKey: `notifications.message:${message.id}`,
    maxAttempts: 4,
  });
  return message;
}
