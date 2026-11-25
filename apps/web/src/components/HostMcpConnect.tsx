import { createRequester, keys, useAgents, useMachines } from "@agenteschat/client";
import { saveLevels } from "@agenteschat/client/lib/access-levels";
import { Button } from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { useOrg } from "@/components/org-context";
import {
  assertHostMcpReadLevel,
  completeReviewedHostMcpRead,
  hostMcpEndpoint,
  type PendingHostMcpRead,
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
type HostMcpError = "" | "common.loadFailed" | "connectors.hostMcp.bindFailed" | "connectors.hostMcp.grantUnconfirmed";

const request = createRequester();

export function HostMcpConnect() {
  const { t } = useTranslation();
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
  const [error, setError] = useState<HostMcpError>("");
  const [status, setStatus] = useState("");
  const [pending, setPending] = useState<PendingHostMcpRead | null>(null);
  const inFlight = useRef(false);

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
    setStatus("");
    setLoading(false);
    if (!machineId) return;
    setLoading(true);
    void request<HostProfiles>(hostMcpEndpoint(org.id) + "/" + encodeURIComponent(machineId) + "/profiles")
      .then((response) => {
        if (!cancelled) setProfiles(response.profiles ?? []);
      })
      .catch(() => {
        if (!cancelled) setError("common.loadFailed");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [org.id, machineId]);

  async function grantRead(connectionId: string, targetAgent: string) {
    // A successful write does not prove permission if the new connector
    // has not appeared in the access tree. Check both write result and fresh readback.
    const changed = await saveLevels(api, org.id, targetAgent, { ["connector:" + connectionId]: "read" });
    assertHostMcpReadLevel(changed, connectionId);
    const confirmed = await api.access.get(org.id, targetAgent);
    assertHostMcpReadLevel(confirmed, connectionId);
    // Cache invalidation is UI-only; after server confirmation it must not
    // turn a real successful grant into an erroneous "permission failed".
    await Promise.allSettled([
      qc.invalidateQueries({ queryKey: keys.customServers(org.id) }),
      qc.invalidateQueries({ queryKey: keys.connections(org.id) }),
      qc.invalidateQueries({ queryKey: keys.agentAccess(org.id, targetAgent) }),
    ]);
  }

  async function connect() {
    if (!machineId || !agentId || !profileId || busy || inFlight.current) return;
    const revision = pending?.revision ?? activeProfiles.find((profile) => profile.id === profileId)?.revision;
    if (!revision) {
      setError("connectors.hostMcp.bindFailed");
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError("");
    setStatus("");
    let confirmedBinding = pending;
    try {
      const bound = await completeReviewedHostMcpRead(
        request,
        { orgId: org.id, machineId, profileId, revision, agentId },
        pending,
        (binding) => {
          confirmedBinding = binding;
          setPending(binding);
        },
        grantRead,
      );
      setPending(null);
      setStatus(t("connectFlow.done.title", { name: bound.label }));
    } catch {
      // Do not show raw server/provider messages. The binding and read-grant
      // phases have separate, localized recovery instructions.
      setError(confirmedBinding ? "connectors.hostMcp.grantUnconfirmed" : "connectors.hostMcp.bindFailed");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  function clearSelection() {
    if (inFlight.current) return;
    // Clear only UI state; a binding or read grant may already exist on the server.
    setPending(null);
    setMachineId("");
    setProfileId("");
    setAgentId("");
    setError("");
    setStatus("");
  }

  return (
    <section className="ac-form" aria-label={t("connectors.hostMcp.title")} data-testid="host-mcp-connect">
      <p className="small muted">{t("connectors.hostMcp.intro")}</p>
      <label>
        <span>{t("onboarding.stepNames.computer")}</span>
        <select
          aria-label={t("onboarding.stepNames.computer")}
          value={machineId}
          disabled={busy || !!pending}
          onChange={(e) => setMachineId(e.target.value)}
        >
          <option value="">{t("connectAi.team.choose")}</option>
          {(machines.data ?? []).map((machine) => (
            <option key={machine.id} value={machine.id}>
              {machine.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>{t("shell.profile")}</span>
        <select
          aria-label={t("shell.profile")}
          value={profileId}
          disabled={busy || loading || !!pending}
          onChange={(e) => setProfileId(e.target.value)}
        >
          <option value="">{t("connectAi.team.choose")}</option>
          {activeProfiles.map((profile) => (
            <option key={profile.id + ":" + profile.revision} value={profile.id}>
              {profile.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>{t("team.list.col.agent")}</span>
        <select
          aria-label={t("team.list.col.agent")}
          value={agentId}
          disabled={busy || !!pending}
          onChange={(e) => setAgentId(e.target.value)}
        >
          <option value="">{t("connectAi.team.choose")}</option>
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
        {busy ? t("common.loading") : pending ? t("connectors.hostMcp.retryRead") : t("connectors.hostMcp.connectRead")}
      </Button>
      {loading && (
        <p role="status" className="small muted">
          {t("common.loading")}
        </p>
      )}
      {status && (
        <p role="status" className="small">
          {status}
        </p>
      )}
      {error && (
        <p role="alert" className="small">
          {t(error)}
        </p>
      )}
      {(pending || error === "connectors.hostMcp.bindFailed") && (
        <Button size="sm" disabled={busy} onClick={clearSelection}>
          {t("connectors.hostMcp.resetSelection")}
        </Button>
      )}
      <p className="small muted">{t("connectors.hostMcp.note")}</p>
    </section>
  );
}
