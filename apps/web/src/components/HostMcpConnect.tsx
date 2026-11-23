import { createRequester, keys, useAgents, useMachines } from "@agenteschat/client";
import { saveLevels } from "@agenteschat/client/lib/access-levels";
import { Button } from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useApi } from "@/api/context";
import { useOrg } from "@/components/org-context";
import {
  bindReviewedHostMcp,
  hostMcpEndpoint,
  type ReviewedHostProfile,
  type ReviewedHostProfiles,
} from "@/lib/host-mcp-admin";

/**
 * Native, signed-in human-admin Host MCP bridge.
 * No bearer token, cookie scraping, local file access or SSRF workaround.
 * Binding creates zero agent grants; only the selected agent gets READ via
 * the normal granular access API, preserving all unrelated permissions.
 */
type HostProfile = ReviewedHostProfile;
type HostProfiles = ReviewedHostProfiles;
type PendingAccess = { connectionId: string; agentId: string };

const request = createRequester();

export function HostMcpConnect() {
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const machines = useMachines(org.id);
  const agents = useAgents(org.id);
  const [machineId, setMachineId] = useState("");
  const [profileId, setProfileId] = useState("");
  const [agentId, setAgentId] = useState("");
  const [profiles, setProfiles] = useState<HostProfile[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [pending, setPending] = useState<PendingAccess | null>(null);

  const activeProfiles = useMemo(
    () => profiles.filter((profile) => profile.enabled && profile.kind === "general"),
    [profiles],
  );

  useEffect(() => {
    let cancelled = false;
    setProfiles([]);
    setProfileId("");
    setError("");
    setPending(null);
    if (!machineId) return;
    setLoading(true);
    void request<HostProfiles>(hostMcpEndpoint(org.id) + "/" + encodeURIComponent(machineId) + "/profiles")
      .then((response) => {
        if (!cancelled) setProfiles(response.profiles ?? []);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "Could not list Host MCP profiles");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [org.id, machineId]);

  async function grantRead(connectionId: string, targetAgent: string) {
    // Read fresh grants before updating. No unrelated access is overwritten.
    await saveLevels(api, org.id, targetAgent, { ["connector:" + connectionId]: "read" });
    setPending(null);
    await Promise.all([
      qc.invalidateQueries({ queryKey: keys.customServers(org.id) }),
      qc.invalidateQueries({ queryKey: keys.connections(org.id) }),
      qc.invalidateQueries({ queryKey: keys.agentAccess(org.id, targetAgent) }),
    ]);
  }

  async function connect() {
    if (!machineId || !agentId || !profileId || busy) return;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      if (pending) {
        if (pending.agentId !== agentId) {
          throw new Error("Finish the previous agent permission review first");
        }
        await grantRead(pending.connectionId, pending.agentId);
        setStatus("Permission granted. A real agent tool call is still required for acceptance.");
        return;
      }
      const bound = await bindReviewedHostMcp(request, { orgId: org.id, machineId, profileId, agentId });
      setPending({ connectionId: bound.id, agentId });
      try {
        await grantRead(bound.id, agentId);
        setStatus(bound.label + " is bound with READ access. Real agent test pending.");
      } catch (reason) {
        throw new Error(
          "Profile bound; access review incomplete. Retry the permission step only. " +
            (reason instanceof Error ? reason.message : String(reason)),
        );
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Host MCP binding failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="stack" aria-label="Local Host MCP" data-testid="host-mcp-connect">
      <p className="small muted">
        Connect a reviewed MCP profile from an authorized computer. No private URL or API key is needed. New connections
        grant nothing until you choose an agent below.
      </p>
      <label>
        <span>Computer</span>
        <select
          aria-label="Host MCP computer"
          value={machineId}
          disabled={busy || !!pending}
          onChange={(e) => setMachineId(e.target.value)}
        >
          <option value="">Choose a computer</option>
          {(machines.data ?? []).map((machine) => (
            <option key={machine.id} value={machine.id}>
              {machine.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Reviewed local MCP profile</span>
        <select
          aria-label="Host MCP profile"
          value={profileId}
          disabled={busy || loading || !!pending}
          onChange={(e) => setProfileId(e.target.value)}
        >
          <option value="">Choose a reviewed profile</option>
          {activeProfiles.map((profile) => (
            <option key={profile.id + ":" + profile.revision} value={profile.id}>
              {profile.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Agent (read-only grant)</span>
        <select
          aria-label="Host MCP agent"
          value={agentId}
          disabled={busy || !!pending}
          onChange={(e) => setAgentId(e.target.value)}
        >
          <option value="">Choose one authorized agent</option>
          {(agents.data ?? []).map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
      </label>
      <Button
        size="sm"
        disabled={busy || loading || !machineId || !profileId || !agentId}
        onClick={() => void connect()}
      >
        {busy ? "Checking native permissions…" : pending ? "Finish read access" : "Connect and grant read"}
      </Button>
      {loading && (
        <p role="status" className="small muted">
          Reading reviewed profiles…
        </p>
      )}
      {status && (
        <p role="status" className="small">
          {status}
        </p>
      )}
      {error && (
        <p role="alert" className="small">
          {error}
        </p>
      )}
      <p className="small muted">
        Only the selected agent gets read access. The machine SHA-pinned allowlist still applies. Verify the tool in a
        real agent conversation before marking it accepted.
      </p>
    </section>
  );
}
