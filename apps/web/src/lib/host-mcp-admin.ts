import type { AgentAccess } from "@agenteschat/client";
import { levelIn } from "@agenteschat/client/lib/access-levels";

/**
 * Human-admin-only native Host MCP binding contract.
 *
 * The AC server checks manage_connectors, machine identity, pinned revision
 * and agent allowlist. This module performs no authentication workaround.
 */
export type ReviewedHostProfile = {
  id: string;
  label: string;
  revision: string;
  enabled: boolean;
  kind: "general" | "phone";
};
export type ReviewedHostProfiles = { profiles?: ReviewedHostProfile[] };
export type HostBoundResult = { id: string; label: string; tools: number; grantsCreated: 0 };

type PostOptions = { method: "POST"; json: unknown };
export type HostRequester = <T>(path: string, options?: PostOptions) => Promise<T>;

/**
 * Fail closed: saveLevels() can silently preserve an unchanged tree if the
 * new connector is missing, so a successful HTTP PUT alone is not acceptance.
 * Require an actual, server-reported READ level on this exact connection.
 */
export function assertHostMcpReadLevel(access: AgentAccess, connectionId: string): void {
  if (!access.connectors.some((connection) => connection.connectionId === connectionId && connection.custom)) {
    throw new Error("Host MCP connection is not visible in the agent access tree");
  }
  if (levelIn(access, "connector:" + connectionId) !== "read") {
    throw new Error("Host MCP read permission is not confirmed by the server");
  }
}

export const hostMcpEndpoint = (orgId: string) =>
  "/api/app/organizations/" + encodeURIComponent(orgId) + "/connectors/host-mcp";

export async function bindReviewedHostMcp(
  request: HostRequester,
  input: { orgId: string; machineId: string; profileId: string; agentId: string },
): Promise<HostBoundResult> {
  const base = hostMcpEndpoint(input.orgId);
  const found = await request<ReviewedHostProfiles>(base + "/" + encodeURIComponent(input.machineId) + "/profiles");
  const profile = found.profiles?.find((p) => p.id === input.profileId && p.enabled && p.kind === "general");
  if (!profile || !/^[a-f0-9]{64}$/.test(profile.revision)) {
    throw new Error("Host MCP profile is missing, disabled or changed");
  }
  const bound = await request<HostBoundResult>(base, {
    method: "POST",
    json: {
      machineId: input.machineId,
      profileId: profile.id,
      revision: profile.revision,
      agentId: input.agentId,
    },
  });
  if (!bound.id || bound.grantsCreated !== 0) {
    throw new Error("Unexpected native Host MCP binding response; review server state");
  }
  return bound;
}
