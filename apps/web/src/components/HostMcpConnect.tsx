import { createRequester, keys, useAgents, useMachines } from "@agenteschat/client";
import { saveLevels } from "@agenteschat/client/lib/access-levels";
import { Button } from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { useOrg } from "@/components/org-context";
import {
  assertHostMcpReadLevel,
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
      .catch(() => {
        if (!cancelled) setError(t("common.loadFailed"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [org.id, machineId, t]);

  async function grantRead(connectionId: string, targetAgent: string) {
    // A successful write does not prove permission if the new connector
    // has not appeared in the access tree. Check both write result and fresh readback.
    const changed = await saveLevels(api, org.id, targetAgent, { ["connector:" + connectionId]: "read" });
    assertHostMcpReadLevel(changed, connectionId);
    const confirmed = await api.access.get(org.id, targetAgent);
    assertHostMcpReadLevel(confirmed, connectionId);
    setPending(null);
    // Cache invalidation is UI-only; after server confirmation it must not
    // turn a real successful grant into an erroneous "permission failed".
    await Promise.allSettled([
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
        setStatus(t("common.saved"));
        return;
      }
      const bound = await bindReviewedHostMcp(request, { orgId: org.id, machineId, profileId, agentId });
      setPending({ connectionId: bound.id, agentId });
      try {
        await grantRead(bound.id, agentId);
        setStatus(t("connectFlow.done.title", { name: bound.label }));
      } catch (reason) {
        throw new Error(
          "Profile bound; access review incomplete. Retry the permission step only. " +
            (reason instanceof Error ? reason.message : String(reason)),
        );
      }
    } catch (reason) {
      setError(t("common.unknownError"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ac-form" aria-label={t("connectors.mcp.title")} data-testid="host-mcp-connect">
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
        {busy ? t("common.loading") : pending ? t("common.continue") : t("connectors.hostMcp.connectRead")}
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
          {error}
        </p>
      )}
      <p className="small muted">{t("connectors.hostMcp.note")}</p>
    </section>
  );
}
