import { describe, expect, test } from "bun:test";
import type { AgentAccess } from "@agenteschat/client";
import {
  assertHostMcpReadLevel,
  bindReviewedHostMcp,
  completeReviewedHostMcpRead,
  type HostRequester,
  hostMcpEndpoint,
  type PendingHostMcpRead,
} from "./host-mcp-admin";

const orgId = "11111111-1111-4111-8111-111111111111";
const machineId = "22222222-2222-4222-8222-222222222222";
const agentId = "33333333-3333-4333-8333-333333333333";
const revision = "a".repeat(64);
const path = hostMcpEndpoint(orgId);

type Call = { url: string; options?: { method: "POST"; json: unknown } };
function mockRequester(
  profile = { id: "jamesos-shared-brain", label: "Shared Brain", revision, enabled: true, kind: "general" },
) {
  const calls: Call[] = [];
  const request: HostRequester = async <T>(url: string, options?: { method: "POST"; json: unknown }) => {
    calls.push({ url, options });
    if (!options) return { profiles: [profile] } as T;
    return {
      id: "44444444-4444-4444-8444-444444444444",
      label: "Shared Brain",
      tools: 3,
      grantsCreated: 0,
    } as T;
  };
  return { request, calls };
}

/** Simulates the server's effective access tree, not only PUT success. */
function treeWithHostRead(state: "off" | "granted", connected = true): AgentAccess {
  return {
    all: false,
    builtins: [],
    connectors: connected
      ? [
          {
            connectionId: "s1",
            connector: "custom:s1",
            label: "Shared Brain",
            custom: true,
            state: "off",
            scopes: [
              {
                scope: "custom:s1:read",
                label: "Read",
                state,
                tools: [
                  {
                    name: "search_shared_brain",
                    label: "Search memory",
                    description: "",
                    readOnly: true,
                    connectionId: "s1",
                    scope: "custom:s1:read",
                    sensitive: false,
                    state,
                  },
                ],
              },
            ],
          },
        ]
      : [],
  } as AgentAccess;
}

describe("Native Host MCP admin connector", () => {
  test("read grant acceptance requires server-visible connector and actual READ level", () => {
    expect(() => assertHostMcpReadLevel(treeWithHostRead("granted"), "s1")).not.toThrow();
    expect(() => assertHostMcpReadLevel(treeWithHostRead("off"), "s1")).toThrow(
      "Host MCP read permission is not confirmed",
    );
    expect(() => assertHostMcpReadLevel(treeWithHostRead("off", false), "s1")).toThrow(
      "Host MCP connection is not visible",
    );
    expect(() => assertHostMcpReadLevel(treeWithHostRead("granted"), "other")).toThrow(
      "Host MCP connection is not visible",
    );
  });
  test("uses the signed-in native profiles API and pins the selected revision", async () => {
    const { request, calls } = mockRequester();
    const result = await bindReviewedHostMcp(request, {
      orgId,
      machineId,
      profileId: "jamesos-shared-brain",
      revision,
      agentId,
    });
    expect(result.id).toBe("44444444-4444-4444-8444-444444444444");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ url: path + "/" + machineId + "/profiles", options: undefined });
    expect(calls[1]).toEqual({
      url: path,
      options: {
        method: "POST",
        json: { machineId, profileId: "jamesos-shared-brain", revision, agentId },
      },
    });
  });

  test("never POSTs a stale or disabled profile", async () => {
    for (const p of [
      { id: "jamesos-shared-brain", label: "Shared Brain", revision: "invalid", enabled: true, kind: "general" },
      { id: "jamesos-shared-brain", label: "Shared Brain", revision: "b".repeat(64), enabled: true, kind: "general" },
      { id: "jamesos-shared-brain", label: "Shared Brain", revision, enabled: false, kind: "general" },
      { id: "jamesos-shared-brain", label: "Shared Brain", revision, enabled: true, kind: "phone" },
    ]) {
      const { request, calls } = mockRequester(p);
      await expect(
        bindReviewedHostMcp(request, { orgId, machineId, profileId: "jamesos-shared-brain", revision, agentId }),
      ).rejects.toThrow();
      expect(calls).toHaveLength(1);
      expect(calls[0]?.options).toBeUndefined();
    }
  });

  test("does not bind a profile other than the one selected", async () => {
    const { request, calls } = mockRequester();
    await expect(
      bindReviewedHostMcp(request, { orgId, machineId, profileId: "uai-daily-brain", revision, agentId }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  test("partial read-grant failure retries only the exact bound selection", async () => {
    const { request, calls } = mockRequester();
    const selection = { orgId, machineId, profileId: "jamesos-shared-brain", revision, agentId };
    let pending: PendingHostMcpRead | null = null;
    const grants: string[][] = [];
    const grantRead = async (connectionId: string, targetAgent: string) => {
      grants.push([connectionId, targetAgent]);
      if (grants.length === 1) throw new Error("readback unavailable");
    };
    const onBound = (binding: PendingHostMcpRead) => {
      pending = binding;
    };
    await expect(completeReviewedHostMcpRead(request, selection, pending, onBound, grantRead)).rejects.toThrow(
      "readback unavailable",
    );
    expect(pending).not.toBeNull();
    for (const changed of [
      { agentId: "different-agent" },
      { orgId: "different-org" },
      { revision: "b".repeat(64) },
      { machineId: "different-machine" },
      { profileId: "different-profile" },
    ]) {
      await expect(
        completeReviewedHostMcpRead(request, { ...selection, ...changed }, pending, onBound, grantRead),
      ).rejects.toThrow("pending read selection changed");
    }
    expect(grants).toHaveLength(1);
    const recovered = await completeReviewedHostMcpRead(request, selection, pending, onBound, grantRead);
    expect(calls).toHaveLength(2);
    expect(grants).toEqual([
      [recovered.connectionId, agentId],
      [recovered.connectionId, agentId],
    ]);
  });

  test("rejects unexpected server-side grant creation", async () => {
    const request: HostRequester = async <T>(_url: string, options?: { method: "POST"; json: unknown }) => {
      if (!options) {
        return {
          profiles: [{ id: "jamesos-shared-brain", label: "Shared Brain", revision, enabled: true, kind: "general" }],
        } as T;
      }
      return { id: "44444444-4444-4444-8444-444444444444", label: "Shared Brain", tools: 3, grantsCreated: 1 } as T;
    };
    await expect(
      bindReviewedHostMcp(request, { orgId, machineId, profileId: "jamesos-shared-brain", revision, agentId }),
    ).rejects.toThrow("Unexpected native Host MCP binding response");
  });
});
