import { createRequester, useCredentials } from "@agenteschat/client";
import { formatUsd } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import { providerLabel } from "@agenteschat/client/lib/providers";
import { Button, Card, CardHeader, ProviderLogo } from "@agenteschat/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorState, LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { TableBox } from "@/components/TableBox";

const request = createRequester();

export type GlobalRouterUiState =
  | "loading"
  | "disconnected"
  | "serverDisabled"
  | "disabled"
  | "authorization_needed"
  | "stale_catalog"
  | "unverified"
  | "eligible"
  | "quota_warning"
  | "rate_limited"
  | "provider_outage"
  | "incompatible"
  | "privacy_blocked"
  | "budget_held"
  | "needs_owner"
  | "recovered";

export type RouterProviderId =
  | "openrouter"
  | "groq"
  | "cloudflare"
  | "opencode"
  | "deepseek"
  | "tencent"
  | "minimax"
  | "zai"
  | "moonshot"
  | "xiaomi"
  | "nvidia";

export type RouterLaneId = "opencode_go" | "free_api" | "paid_low_cost" | "direct_api" | "paid_dynamic";
export type RouterEntitlement = "subscription_go" | "free_only" | "paid_capped";

export interface GlobalRouterAccountView {
  id: string;
  provider: RouterProviderId;
  lane: RouterLaneId;
  entitlement: RouterEntitlement;
  credentialId: string;
  workspaceAccountRef: string | null;
  enabled: boolean;
  killSwitch: boolean;
  monthlyCapNanoUsd: number;
  spentNanoUsd: number;
  heldNanoUsd: number;
  allowedModels: string[];
  rpmLimit: number | null;
  rpdLimit: number | null;
  dailyNeuronsLimit: number;
  dayRequestsUsed: number;
  dayNeuronsUsed: number;
  zdrRequired: boolean;
  allowedRegion: string;
  healthState: string;
  uiState: GlobalRouterUiState;
  resetsAt: string | null;
  quotaObservedAt: string | null;
}

export interface GlobalRouterOfferView {
  offerId: string;
  provider: string;
  lane: RouterLaneId;
  modelId: string;
  label: string;
  freeEligible: boolean;
  qualificationStatus: "eligible" | "quarantined" | "stale" | "denied" | "requires_owner_approval";
  disabledReason: string | null;
  contextWindow: number;
  observedAt: string;
  expiresAt: string;
}

export interface GlobalRouterReceiptView {
  id: string;
  runId: string;
  routineRunId: string | null;
  agentId: string;
  turn: number;
  lane: RouterLaneId;
  provider: string;
  requestedModel: string;
  actualModel: string | null;
  reservedNanoUsd: number;
  actualNanoUsd: number | null;
  state: "held" | "settled" | "released" | "unknown";
  qualityVerified: boolean;
  latencyMs: number | null;
  failureReason: string | null;
}

export interface GlobalRouterMetricView {
  provider: string;
  lane: string;
  model: string;
  attempts: number;
  verifiedSuccesses: number;
  totalSpendNanoUsd: number;
  costPerVerifiedSuccessNanoUsd: number | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
}

export interface GlobalModelRouterStatus {
  serverEnabled: boolean;
  canManagePolicy: boolean;
  observedAt: string;
  period: string;
  policy: {
    enabled: boolean;
    killSwitch: boolean;
    optOutAgentIds: string[];
    maxEscalations: number;
    maxRetriesPerRoute: number;
    warnAt50: boolean;
    warnAt80: boolean;
    warnAt95: boolean;
    revision: number;
  };
  accounts: GlobalRouterAccountView[];
  offers: GlobalRouterOfferView[];
  recentReceipts: GlobalRouterReceiptView[];
  metrics: GlobalRouterMetricView[];
  latestBenchmark: {
    id: string;
    suiteVersion: string;
    taskCount: number;
    modelCount: number;
  } | null;
}

export interface PolicyPatchInput {
  enabled: boolean;
  killSwitch: boolean;
  optOutAgentIds: string[];
  maxEscalations: number;
  maxRetriesPerRoute: number;
  warnAt50: boolean;
  warnAt80: boolean;
  warnAt95: boolean;
}

export interface AccountPutInput {
  provider: RouterProviderId;
  lane: RouterLaneId;
  entitlement: RouterEntitlement;
  credentialId: string;
  workspaceAccountRef?: string | null;
  enabled: boolean;
  monthlyCapUsd: number;
  allowedModels: string[];
  zdrRequired: boolean;
}

const ROUTER_PROVIDERS: readonly RouterProviderId[] = [
  "openrouter",
  "opencode",
  "groq",
  "cloudflare",
  "deepseek",
  "tencent",
  "minimax",
  "zai",
  "moonshot",
  "xiaomi",
  "nvidia",
];

const ROUTER_LANES: readonly RouterLaneId[] = [
  "opencode_go",
  "free_api",
  "paid_low_cost",
  "direct_api",
  "paid_dynamic",
];

export const mayReadGlobalModelRouter = (org: { role?: string; permissions?: readonly string[] }) =>
  org.role === "owner" || (can(org, "manage_agents") && can(org, "view_usage"));

export function deriveOverallRouterState(status: GlobalModelRouterStatus): GlobalRouterUiState {
  if (!status.serverEnabled) return "serverDisabled";
  if (status.policy.killSwitch || !status.policy.enabled) return "disabled";
  if (status.accounts.length === 0) return "disconnected";
  if (status.accounts.some((a) => a.uiState === "budget_held")) return "budget_held";
  if (status.accounts.some((a) => a.uiState === "authorization_needed")) return "authorization_needed";
  const eligibleOffers = status.offers.filter((o) => o.qualificationStatus === "eligible");
  const staleOffers = status.offers.filter((o) => o.qualificationStatus === "stale");
  if (eligibleOffers.length === 0 && staleOffers.length > 0) return "stale_catalog";
  if (eligibleOffers.length === 0) return "unverified";
  if (status.accounts.some((a) => a.uiState === "eligible")) {
    if (status.accounts.some((a) => a.uiState === "quota_warning")) return "quota_warning";
    return "eligible";
  }
  if (status.accounts.some((a) => a.uiState === "rate_limited")) return "rate_limited";
  if (status.accounts.some((a) => a.uiState === "provider_outage")) return "provider_outage";
  return "needs_owner";
}

export function GlobalModelRouterView({
  status,
  keys,
  locale,
  pending,
  syncing,
  onSavePolicy,
  onSaveAccount,
  onSyncCatalog,
  onReleaseHold,
}: {
  status: GlobalModelRouterStatus;
  keys: { id: string; provider: string; label: string }[];
  locale?: string;
  pending: boolean;
  syncing: boolean;
  onSavePolicy?: (input: PolicyPatchInput) => void;
  onSaveAccount?: (input: AccountPutInput) => void;
  onSyncCatalog?: () => void;
  onReleaseHold?: (attemptId: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const language = locale ?? i18n.language;
  const overallState = deriveOverallRouterState(status);

  const [enabled, setEnabled] = useState(status.policy.enabled);
  const [killSwitch, setKillSwitch] = useState(status.policy.killSwitch);
  const [maxEscalations, setMaxEscalations] = useState(String(status.policy.maxEscalations));
  const [maxRetries, setMaxRetries] = useState(String(status.policy.maxRetriesPerRoute));
  const [optOutText, setOptOutText] = useState(status.policy.optOutAgentIds.join("\n"));
  const [warnAll, setWarnAll] = useState(status.policy.warnAt50 && status.policy.warnAt80 && status.policy.warnAt95);

  const [provider, setProvider] = useState<RouterProviderId>("openrouter");
  const [lane, setLane] = useState<RouterLaneId>("free_api");
  const [entitlement, setEntitlement] = useState<RouterEntitlement>("free_only");
  const [credentialId, setCredentialId] = useState("");
  const [cloudflareRef, setCloudflareRef] = useState("");
  const [capUsd, setCapUsd] = useState("0");
  const [allowedModelsText, setAllowedModelsText] = useState("");
  const [zdrRequired, setZdrRequired] = useState(false);

  const money = (nano: number | null) =>
    nano === null || !Number.isFinite(nano) ? t("globalModelRouter.unknown") : formatUsd(language, nano / 1e9);
  const dateText = (value: string | null) =>
    value && Number.isFinite(Date.parse(value))
      ? new Date(value).toLocaleString(language)
      : t("globalModelRouter.unknown");

  const providerKeys = keys.filter((k) => k.provider === provider);
  const isZeroCapMode = entitlement === "free_only" || entitlement === "subscription_go";
  const effectiveCap = isZeroCapMode ? 0 : Number(capUsd);
  const capValid = isZeroCapMode
    ? effectiveCap === 0
    : Number.isFinite(effectiveCap) && effectiveCap > 0 && (provider !== "openrouter" || effectiveCap <= 50);
  const cfValid = provider !== "cloudflare" || /^[a-f0-9]{32}$/i.test(cloudflareRef.trim());
  const parsedModels = allowedModelsText
    .split(/\s+/)
    .map((m) => m.trim())
    .filter(Boolean);
  const laneFormValid = Boolean(credentialId) && parsedModels.length > 0 && capValid && cfValid;

  const eligibleOffersCount = status.offers.filter((o) => o.qualificationStatus === "eligible").length;

  return (
    <>
      <p className="small muted">{t("globalModelRouter.intro")}</p>
      <p className="small">{t("globalModelRouter.cascade")}</p>
      <p role="status">{t(`globalModelRouter.states.${overallState}`)}</p>

      <p className="small muted">
        {t("globalModelRouter.catalog.summary", {
          eligible: eligibleOffersCount,
          total: status.offers.length,
        })}
        {status.latestBenchmark
          ? ` · ${t("globalModelRouter.benchmarkSummary", {
              tasks: status.latestBenchmark.taskCount,
              models: status.latestBenchmark.modelCount,
            })}`
          : ""}
      </p>

      {status.canManagePolicy && onSyncCatalog && (
        <p>
          <Button size="sm" type="button" disabled={syncing || pending} onClick={onSyncCatalog}>
            {t(syncing ? "globalModelRouter.syncing" : "globalModelRouter.syncCatalog")}
          </Button>
        </p>
      )}

      {status.canManagePolicy && onSavePolicy && (
        <form
          aria-label={t("globalModelRouter.policy.heading")}
          onSubmit={(e) => {
            e.preventDefault();
            if (!status.serverEnabled || pending) return;
            onSavePolicy({
              enabled,
              killSwitch,
              optOutAgentIds: optOutText
                .split(/\s+/)
                .map((s) => s.trim())
                .filter(Boolean),
              maxEscalations: Math.min(2, Math.max(0, Number.parseInt(maxEscalations, 10) || 0)),
              maxRetriesPerRoute: Math.min(1, Math.max(0, Number.parseInt(maxRetries, 10) || 0)),
              warnAt50: warnAll,
              warnAt80: warnAll,
              warnAt95: warnAll,
            });
          }}
        >
          <fieldset disabled={!status.serverEnabled || pending}>
            <legend className="small">{t("globalModelRouter.policy.heading")}</legend>
            <p>
              <label>
                <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />{" "}
                {t("globalModelRouter.policy.enabledLabel")}
              </label>
            </p>
            <p>
              <label>
                <input type="checkbox" checked={killSwitch} onChange={(e) => setKillSwitch(e.target.checked)} />{" "}
                {t("globalModelRouter.policy.killSwitchLabel")}
              </label>
            </p>
            <p>
              <label>
                <input type="checkbox" checked={warnAll} onChange={(e) => setWarnAll(e.target.checked)} />{" "}
                {t("globalModelRouter.policy.warnThresholds")}
              </label>
            </p>
            <p>
              <label>
                {t("globalModelRouter.policy.maxEscalations")}{" "}
                <input
                  type="number"
                  min="0"
                  max="2"
                  step="1"
                  value={maxEscalations}
                  onChange={(e) => setMaxEscalations(e.target.value)}
                />
              </label>
            </p>
            <p>
              <label>
                {t("globalModelRouter.policy.maxRetries")}{" "}
                <input
                  type="number"
                  min="0"
                  max="1"
                  step="1"
                  value={maxRetries}
                  onChange={(e) => setMaxRetries(e.target.value)}
                />
              </label>
            </p>
            <p>
              <label>
                {t("globalModelRouter.policy.optOutAgents")}{" "}
                <textarea
                  rows={2}
                  value={optOutText}
                  onInput={(e) => setOptOutText(e.currentTarget.value)}
                  onChange={(e) => setOptOutText(e.target.value)}
                />
              </label>
            </p>
            <Button type="submit" size="sm">
              {t("globalModelRouter.policy.enable")}
            </Button>
          </fieldset>
        </form>
      )}

      {status.accounts.length === 0 ? (
        <p className="small muted">{t("globalModelRouter.accounts.empty")}</p>
      ) : (
        <TableBox>
          <table>
            <caption>{t("globalModelRouter.accounts.caption")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("globalModelRouter.accounts.columns.provider")}</th>
                <th scope="col">{t("globalModelRouter.accounts.columns.lane")}</th>
                <th scope="col">{t("globalModelRouter.accounts.columns.state")}</th>
                <th scope="col">{t("globalModelRouter.accounts.columns.budget")}</th>
                <th scope="col">{t("globalModelRouter.accounts.columns.quota")}</th>
                <th scope="col">{t("globalModelRouter.accounts.columns.reset")}</th>
              </tr>
            </thead>
            <tbody>
              {status.accounts.map((acct) => (
                <tr key={acct.id}>
                  <th scope="row">
                    <span className="ac-iconline">
                      <ProviderLogo id={acct.provider} size="sm" />
                      {providerLabel(acct.provider)}
                    </span>
                  </th>
                  <td>{t(`globalModelRouter.lanes.${acct.lane}`)}</td>
                  <td>{t(`globalModelRouter.states.${acct.uiState}`)}</td>
                  <td className="tabular">
                    {acct.monthlyCapNanoUsd === 0
                      ? t("globalModelRouter.freeCap")
                      : `${money(acct.spentNanoUsd)} / ${money(acct.monthlyCapNanoUsd)}`}
                  </td>
                  <td className="tabular">
                    {acct.provider === "cloudflare"
                      ? `${acct.dayNeuronsUsed} / ${acct.dailyNeuronsLimit} neurons`
                      : acct.rpdLimit
                        ? `${acct.dayRequestsUsed} / ${acct.rpdLimit} RPD`
                        : `${acct.dayRequestsUsed}`}
                  </td>
                  <td>{dateText(acct.resetsAt ?? acct.quotaObservedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableBox>
      )}

      {status.canManagePolicy && onSaveAccount && (
        <form
          aria-label={t("globalModelRouter.accounts.configureHeading")}
          onSubmit={(e) => {
            e.preventDefault();
            if (!status.serverEnabled || !laneFormValid || pending) return;
            onSaveAccount({
              provider,
              lane,
              entitlement,
              credentialId,
              ...(provider === "cloudflare" ? { workspaceAccountRef: cloudflareRef.trim().toLowerCase() } : {}),
              enabled: true,
              monthlyCapUsd: effectiveCap,
              allowedModels: parsedModels,
              zdrRequired,
            });
          }}
        >
          <fieldset disabled={!status.serverEnabled || pending}>
            <legend className="small">{t("globalModelRouter.accounts.configureHeading")}</legend>
            <p>
              <label>
                {t("globalModelRouter.accounts.provider")}{" "}
                <select
                  value={provider}
                  onChange={(e) => {
                    const next = e.target.value as RouterProviderId;
                    setProvider(next);
                    setCredentialId("");
                    if (next === "opencode") {
                      setLane("opencode_go");
                      setEntitlement("subscription_go");
                      setCapUsd("0");
                    } else if (next === "groq" || next === "cloudflare") {
                      setLane("free_api");
                      setEntitlement("free_only");
                      setCapUsd("0");
                    } else if (next !== "openrouter") {
                      setLane("direct_api");
                      setEntitlement("paid_capped");
                      setCapUsd("10");
                    }
                  }}
                >
                  {ROUTER_PROVIDERS.map((p) => (
                    <option key={p} value={p}>
                      {providerLabel(p)}
                    </option>
                  ))}
                </select>
              </label>
            </p>
            <p>
              <label>
                {t("globalModelRouter.accounts.lane")}{" "}
                <select value={lane} onChange={(e) => setLane(e.target.value as RouterLaneId)}>
                  {ROUTER_LANES.map((l) => (
                    <option key={l} value={l}>
                      {t(`globalModelRouter.lanes.${l}`)}
                    </option>
                  ))}
                </select>
              </label>
            </p>
            <p>
              <label>
                {t("globalModelRouter.accounts.entitlement")}{" "}
                <select
                  value={entitlement}
                  onChange={(e) => {
                    const next = e.target.value as RouterEntitlement;
                    setEntitlement(next);
                    if (next === "free_only" || next === "subscription_go") setCapUsd("0");
                    else if (Number(capUsd) <= 0) setCapUsd("10");
                  }}
                >
                  {(["subscription_go", "free_only", "paid_capped"] as const).map((ent) => (
                    <option key={ent} value={ent}>
                      {t(`globalModelRouter.entitlements.${ent}`)}
                    </option>
                  ))}
                </select>
              </label>
            </p>
            <p>
              <label>
                {t("globalModelRouter.accounts.key")}{" "}
                <select value={credentialId} onChange={(e) => setCredentialId(e.target.value)} required>
                  <option value="">{t("globalModelRouter.accounts.chooseKey")}</option>
                  {providerKeys.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.label}
                    </option>
                  ))}
                </select>
              </label>
            </p>
            {provider === "cloudflare" && (
              <p>
                <label>
                  {t("globalModelRouter.accounts.cloudflareAccount")}{" "}
                  <input
                    type="text"
                    value={cloudflareRef}
                    onChange={(e) => setCloudflareRef(e.target.value)}
                    required
                  />
                </label>
              </p>
            )}
            <p>
              <label>
                {t("globalModelRouter.accounts.cap")}{" "}
                <input
                  type="number"
                  min={isZeroCapMode ? "0" : "0.01"}
                  max={provider === "openrouter" ? "50" : "10000"}
                  step="0.01"
                  value={isZeroCapMode ? "0" : capUsd}
                  disabled={isZeroCapMode}
                  onChange={(e) => setCapUsd(e.target.value)}
                />
              </label>
            </p>
            <p>
              <label>
                <input type="checkbox" checked={zdrRequired} onChange={(e) => setZdrRequired(e.target.checked)} />{" "}
                {t("globalModelRouter.accounts.zdr")}
              </label>
            </p>
            <p>
              <label>
                {t("globalModelRouter.accounts.models")}{" "}
                <textarea
                  rows={3}
                  value={allowedModelsText}
                  onInput={(e) => setAllowedModelsText(e.currentTarget.value)}
                  onChange={(e) => setAllowedModelsText(e.target.value)}
                  required
                />
              </label>
            </p>
            <Button type="submit" size="sm" disabled={!laneFormValid}>
              {t("globalModelRouter.accounts.save")}
            </Button>
          </fieldset>
        </form>
      )}

      {status.offers.length > 0 && (
        <TableBox>
          <table>
            <caption>{t("globalModelRouter.catalog.caption")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("globalModelRouter.catalog.columns.model")}</th>
                <th scope="col">{t("globalModelRouter.catalog.columns.provider")}</th>
                <th scope="col">{t("globalModelRouter.catalog.columns.lane")}</th>
                <th scope="col">{t("globalModelRouter.catalog.columns.status")}</th>
                <th scope="col">{t("globalModelRouter.catalog.columns.context")}</th>
              </tr>
            </thead>
            <tbody>
              {status.offers.slice(0, 12).map((offer) => (
                <tr key={offer.offerId}>
                  <th scope="row">{offer.modelId}</th>
                  <td>{providerLabel(offer.provider)}</td>
                  <td>{t(`globalModelRouter.lanes.${offer.lane}`)}</td>
                  <td>
                    {offer.qualificationStatus}
                    {offer.disabledReason ? ` (${offer.disabledReason})` : ""}
                  </td>
                  <td className="tabular">{offer.contextWindow.toLocaleString(language)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableBox>
      )}

      {status.recentReceipts.length === 0 ? (
        <p className="small muted">{t("globalModelRouter.receipts.empty")}</p>
      ) : (
        <TableBox>
          <table>
            <caption>{t("globalModelRouter.receipts.caption")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("globalModelRouter.receipts.columns.requested")}</th>
                <th scope="col">{t("globalModelRouter.receipts.columns.actual")}</th>
                <th scope="col">{t("globalModelRouter.receipts.columns.lane")}</th>
                <th scope="col">{t("globalModelRouter.receipts.columns.cost")}</th>
                <th scope="col">{t("globalModelRouter.receipts.columns.quality")}</th>
                <th scope="col">{t("globalModelRouter.receipts.columns.state")}</th>
              </tr>
            </thead>
            <tbody>
              {status.recentReceipts.map((rec) => (
                <tr key={rec.id}>
                  <th scope="row">{rec.requestedModel}</th>
                  <td>{rec.actualModel ?? t("globalModelRouter.unknown")}</td>
                  <td>{t(`globalModelRouter.lanes.${rec.lane}`)}</td>
                  <td className="tabular">
                    {money(rec.actualNanoUsd)} / {money(rec.reservedNanoUsd)}
                  </td>
                  <td>
                    {rec.state === "settled"
                      ? t(
                          rec.qualityVerified
                            ? "globalModelRouter.receipts.verified"
                            : "globalModelRouter.receipts.unverified",
                        )
                      : t("globalModelRouter.unknown")}
                  </td>
                  <td>{rec.state}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableBox>
      )}
      {/* Under the table, not in its last column: on a phone that column is scrolled out of sight. */}
      {status.canManagePolicy &&
        onReleaseHold &&
        status.recentReceipts
          .filter((rec) => rec.state === "unknown")
          .map((rec) => (
            <p key={`hold-${rec.id}`} className="small">
              {rec.requestedModel}{" "}
              <Button size="sm" type="button" disabled={pending} onClick={() => onReleaseHold(rec.id)}>
                {t("globalModelRouter.receipts.reconcileNoSend")}
              </Button>
            </p>
          ))}

      {status.metrics.length > 0 && (
        <TableBox>
          <table>
            <caption>{t("globalModelRouter.metrics.caption")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("globalModelRouter.metrics.columns.model")}</th>
                <th scope="col">{t("globalModelRouter.metrics.columns.successes")}</th>
                <th scope="col">{t("globalModelRouter.metrics.columns.costPerSuccess")}</th>
                <th scope="col">{t("globalModelRouter.metrics.columns.latency")}</th>
              </tr>
            </thead>
            <tbody>
              {status.metrics.map((m) => (
                <tr key={`${m.provider}:${m.model}`}>
                  <th scope="row">{m.model}</th>
                  <td className="tabular">
                    {m.verifiedSuccesses} / {m.attempts}
                  </td>
                  <td className="tabular">{money(m.costPerVerifiedSuccessNanoUsd)}</td>
                  <td className="tabular">
                    {m.p50LatencyMs ?? 0} ms / {m.p95LatencyMs ?? 0} ms
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableBox>
      )}
    </>
  );
}

export function GlobalModelRouterCard() {
  const { org } = useOrg();
  const { t, i18n } = useTranslation();
  const allowed = mayReadGlobalModelRouter(org);
  const isOwner = org.role === "owner";
  const baseUrl = `/api/app/organizations/${encodeURIComponent(org.id)}/global-model-router`;
  const keys = useCredentials(org.id, isOwner);

  const query = useQuery({
    queryKey: ["org", org.id, "global-model-router"],
    queryFn: () => request<GlobalModelRouterStatus>(baseUrl),
    enabled: allowed,
    staleTime: 15_000,
    retry: false,
  });

  const policyMutation = useMutation({
    mutationFn: (input: PolicyPatchInput) =>
      request<GlobalModelRouterStatus>(`${baseUrl}/policy`, { method: "PATCH", json: input }),
    onSuccess: () => void query.refetch(),
  });

  const accountMutation = useMutation({
    mutationFn: (input: AccountPutInput) =>
      request<GlobalModelRouterStatus>(`${baseUrl}/accounts`, { method: "PUT", json: input }),
    onSuccess: () => void query.refetch(),
  });

  const syncMutation = useMutation({
    mutationFn: () =>
      request<{ status: GlobalModelRouterStatus }>(`${baseUrl}/sync-catalog`, { method: "POST", json: {} }),
    onSuccess: () => void query.refetch(),
  });

  const reconcileMutation = useMutation({
    mutationFn: (attemptId: string) =>
      request<GlobalModelRouterStatus>(`${baseUrl}/reconcile`, {
        method: "POST",
        json: {
          attemptId,
          kind: "proven_no_send",
          note: "Owner verified no upstream inference occurred",
        },
      }),
    onSuccess: () => void query.refetch(),
  });

  if (!allowed) return null;

  const anyPending = policyMutation.isPending || accountMutation.isPending || reconcileMutation.isPending;
  const anyError =
    policyMutation.isError || accountMutation.isError || syncMutation.isError || reconcileMutation.isError;

  return (
    <Card aria-labelledby="sec-global-model-router">
      <CardHeader
        id="sec-global-model-router"
        icon="chart"
        title={t("globalModelRouter.title")}
        action={
          <Button size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}>
            {t("globalModelRouter.refresh")}
          </Button>
        }
      />
      {query.isLoading && <LoadingList count={2} avatar={false} trailing />}
      {query.isError && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
      {anyError && <p role="alert">{t("globalModelRouter.error")}</p>}
      {query.data && (
        <GlobalModelRouterView
          key={`${org.id}:${query.data.policy.revision}:${query.data.accounts.length}`}
          status={query.data}
          keys={(keys.data ?? [])
            .filter((k) => !k.revokedAt && !k.endpoint)
            .map((k) => ({ id: k.id, provider: k.provider, label: k.label }))}
          locale={i18n.language}
          pending={anyPending}
          syncing={syncMutation.isPending}
          onSavePolicy={(input) => policyMutation.mutate(input)}
          onSaveAccount={(input) => accountMutation.mutate(input)}
          onSyncCatalog={() => syncMutation.mutate()}
          onReleaseHold={(id) => reconcileMutation.mutate(id)}
        />
      )}
    </Card>
  );
}
