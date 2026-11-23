import { describe, expect, test } from "bun:test";
import { bindReviewedHostMcp, type HostRequester, hostMcpEndpoint } from "./host-mcp-admin";

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

describe("Native Host MCP admin connector", () => {
  test("uses the signed-in native profiles API and pins the selected revision", async () => {
    const { request, calls } = mockRequester();
    const result = await bindReviewedHostMcp(request, { orgId, machineId, profileId: "jamesos-shared-brain", agentId });
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
      { id: "jamesos-shared-brain", label: "Shared Brain", revision, enabled: false, kind: "general" },
      { id: "jamesos-shared-brain", label: "Shared Brain", revision, enabled: true, kind: "phone" },
    ]) {
      const { request, calls } = mockRequester(p);
      await expect(
        bindReviewedHostMcp(request, { orgId, machineId, profileId: "jamesos-shared-brain", agentId }),
      ).rejects.toThrow();
      expect(calls).toHaveLength(1);
      expect(calls[0]?.options).toBeUndefined();
    }
  });

  test("does not bind a profile other than the one selected", async () => {
    const { request, calls } = mockRequester();
    await expect(
      bindReviewedHostMcp(request, { orgId, machineId, profileId: "uai-daily-brain", agentId }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(1);
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
      bindReviewedHostMcp(request, { orgId, machineId, profileId: "jamesos-shared-brain", agentId }),
    ).rejects.toThrow("Unexpected native Host MCP binding response");
  });
});
