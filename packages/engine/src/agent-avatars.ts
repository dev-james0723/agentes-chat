import type { BlobStore, PubSub } from "@agenteschat/adapters";
import { and, type Database, eq, isNull, schema } from "@agenteschat/db";
import { validAgentImage } from "./agent-avatar-image";
import { recordAudit } from "./audit";
import { readAvatarImage } from "./avatars";
import { caches } from "./cache";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { publishAgentsChanged } from "./events";
import { imageSize } from "./image-size";
import { publishMachineAgentsChanged } from "./machines";
import { can, getMembership, requirePermission } from "./organizations";

const { agents } = schema;
const FILE = /^[0-9a-f]{16}\.(jpg|png|webp)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const pathFor = (orgId: string, agentId: string, file: string) => `/api/app/agent-avatars/${orgId}/${agentId}/${file}`;
const keyFor = (orgId: string, agentId: string, file: string) => `agent-avatars/${orgId}/${agentId}/${file}`;

interface AgentAvatarDeps {
  db: Database;
  blobs: BlobStore;
  pubsub?: PubSub;
}

/** Reuse the profile-photo checks, and reject incomplete files and unreasonable dimensions before storing. */
function readAgentImage(input: { data: string; contentType: string }) {
  const image = readAvatarImage({ imageBase64: input.data, contentType: input.contentType }, "avatar");
  const size = imageSize(image.body);
  if (!size || size.width > 8192 || size.height > 8192 || !validAgentImage(image.body, image.type, size))
    throw new ValidationError(
      "Use a complete static JPEG, PNG or WebP image up to 8192 pixels on each side",
      "avatar.invalid",
    );
  return image;
}

/** The same owner/admin rule as the pixel appearance, including the team's right hand. */
async function changeAgentAvatar(
  deps: AgentAvatarDeps,
  actorId: string,
  orgId: string,
  agentId: string,
  input: { data: string; contentType: string } | null,
) {
  const membership = await requirePermission(deps.db, actorId, orgId, "read");
  const changed = await deps.db.transaction(async (tx) => {
    const [agent] = await tx
      .select()
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId), isNull(agents.deletedAt)))
      .for("update");
    if (!agent || agent.archivedAt) throw new NotFoundError("Agent not found");
    if (!can(membership, "manage_agents") && !(agent.ownerUserId && agent.ownerUserId === actorId))
      throw new ForbiddenError("Only the agent's owner or an admin can change its portrait");
    const image = input ? readAgentImage(input) : null;
    const avatarUrl = image ? pathFor(orgId, agentId, image.file) : null;
    if (image) await deps.blobs.put(keyFor(orgId, agentId, image.file), image.body, { contentType: image.type });
    await tx
      .update(agents)
      .set({ avatarUrl, updatedAt: new Date() })
      .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)));
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: image ? "agent.avatar_changed" : "agent.avatar_removed",
      target: { type: "agent", id: agentId },
      details: { from: agent.avatarUrl, to: avatarUrl },
    });
    return { avatarUrl, before: agent.avatarUrl, machineId: agent.machineId };
  });
  caches.agents.delete(`${orgId}:${agentId}`);
  caches.agents.delete(`${orgId}:team`);
  caches.agents.delete(`${orgId}:archived`);
  await publishAgentsChanged(deps.pubsub, orgId);
  if (changed.machineId) await publishMachineAgentsChanged(deps.pubsub, orgId);
  await removePrevious(deps, orgId, agentId, changed.before);
  return changed.avatarUrl;
}

/** Rechecks under the same row lock: a concurrent upload may have restored the previous content. */
async function removePrevious(deps: AgentAvatarDeps, orgId: string, agentId: string, before: string | null) {
  if (!before) return;
  const file = before.split("/").at(-1);
  if (!file || !FILE.test(file) || before !== pathFor(orgId, agentId, file)) return;
  await deps.db
    .transaction(async (tx) => {
      const [current] = await tx
        .select({ avatarUrl: agents.avatarUrl })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)))
        .for("update");
      if (current?.avatarUrl !== before) await deps.blobs.delete(keyFor(orgId, agentId, file));
    })
    .catch(() => undefined); // The committed portrait stays usable if cleanup is temporarily unavailable.
}

/** A persistent, server-owned portrait; only this field changes, and the pixel look remains its fallback. */
export async function setAgentAvatar(
  deps: AgentAvatarDeps,
  actorId: string,
  orgId: string,
  agentId: string,
  input: { data: string; contentType: string },
): Promise<{ avatarUrl: string }> {
  const avatarUrl = await changeAgentAvatar(deps, actorId, orgId, agentId, input);
  if (!avatarUrl) throw new Error("An uploaded portrait must have an address");
  return { avatarUrl };
}

export async function removeAgentAvatar(deps: AgentAvatarDeps, actorId: string, orgId: string, agentId: string) {
  await changeAgentAvatar(deps, actorId, orgId, agentId, null);
}

/** Only organization members can read the current portrait; archived/deleted authors retain their identity. */
export async function agentAvatarFile(
  deps: Pick<AgentAvatarDeps, "db" | "blobs">,
  viewerId: string,
  orgId: string,
  agentId: string,
  file: string,
) {
  if (!UUID.test(orgId) || !UUID.test(agentId) || !FILE.test(file)) throw new NotFoundError("Not found");
  if (!(await getMembership(deps.db, viewerId, orgId))) throw new NotFoundError("Not found");
  const [agent] = await deps.db
    .select({ avatarUrl: agents.avatarUrl })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)));
  if (agent?.avatarUrl !== pathFor(orgId, agentId, file)) throw new NotFoundError("Not found");
  const object = await deps.blobs.get(keyFor(orgId, agentId, file));
  if (!object) throw new NotFoundError("Not found");
  return object;
}
