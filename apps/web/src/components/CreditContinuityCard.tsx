import { createRequester } from "@agenteschat/client";
import { formatUsd } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import { Button, Card, CardHeader, ProviderLogo } from "@agenteschat/ui";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ErrorState, LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { TableBox } from "@/components/TableBox";

/** This small view type deliberately contains no account identifiers, credentials or task transcripts. */
export interface CreditContinuityViewStatus {
  enabled: boolean;
  state: "disabled" | "unverified" | "available" | "blocked" | "unavailable";
  observedAt: string;
  unresolvedCount: number;
  pools: {
    provider: "openai" | "anthropic";
    enabled: boolean;
    paused: boolean;
    status: string;
    evidenceStatus: string;
    pricingStatus: "verified" | "expired" | "changed" | "unverified";
    eligibleRouteCount: number;
    verifiedAt: string | null;
    validUntil: string | null;
    grantExpiresAt: string | null;
    grantAmountNanoUsd: number | null;
    automaticLimitNanoUsd: number;
    emergencyLimitNanoUsd: number;
    safetyBufferNanoUsd: number;
    automaticAvailableNanoUsd: number;
    approvedEmergencyAvailableNanoUsd: number;
    activeReserveApprovalCount: number;
    spentNanoUsd: number | null;
    heldNanoUsd: number | null;
    forecast: { sampleCount: number; p95NanoUsd: number | null; uncertainty: string };
  }[];
}
const requester = createRequester();
export const mayReadCreditContinuity = (org: { permissions?: readonly string[] }) =>
  can(org, "manage_agents") && can(org, "view_usage");

export function CreditContinuityView({ status, locale }: { status: CreditContinuityViewStatus; locale?: string }) {
  const { t, i18n } = useTranslation();
  const language = locale ?? i18n.language;
  const money = (nano: number | null) =>
    nano === null || !Number.isFinite(nano) ? t("creditContinuity.unknown") : formatUsd(language, nano / 1e9);
  const date = (value: string | null) =>
    value && Number.isFinite(Date.parse(value))
      ? new Date(value).toLocaleString(language)
      : t("creditContinuity.unknown");
  const state = (p: CreditContinuityViewStatus["pools"][number]) => {
    if (p.evidenceStatus === "unavailable") return t("creditContinuity.state.unavailable");
    if (p.evidenceStatus === "expired") return t("creditContinuity.state.expired");
    if (p.evidenceStatus === "stale") return t("creditContinuity.state.stale");
    if (p.evidenceStatus !== "verified") return t("creditContinuity.state.unverified");
    if (!status.enabled || !p.enabled) return t("creditContinuity.state.disabled");
    if (p.paused) return t("creditContinuity.state.paused");
    if (p.pricingStatus !== "verified")
      return p.pricingStatus === "expired"
        ? t("creditContinuity.state.pricingExpired")
        : p.pricingStatus === "changed"
          ? t("creditContinuity.state.pricingChanged")
          : t("creditContinuity.state.pricingUnverified");
    if (p.status === "reconciliation_required") return t("creditContinuity.state.reconciliation");
    if (p.status === "billing_blocked") return t("creditContinuity.state.billingBlocked");
    if (p.status === "expired") return t("creditContinuity.state.expired");
    if (p.eligibleRouteCount < 1) return t("creditContinuity.state.noRoute");
    if (p.automaticAvailableNanoUsd <= 0 && p.approvedEmergencyAvailableNanoUsd <= 0)
      return t("creditContinuity.state.budgetUnavailable");
    return p.status === "available"
      ? p.automaticAvailableNanoUsd > 0
        ? t("creditContinuity.state.ready")
        : t("creditContinuity.state.reserveAvailable")
      : t("creditContinuity.state.blocked");
  };
  return (
    <>
      <p className="small muted">{t("creditContinuity.intro")}</p>
      <p className="small" role="status">
        {status.state === "unavailable"
          ? t("creditContinuity.status.unavailable")
          : !status.enabled
            ? t("creditContinuity.status.disabled")
            : status.state === "unverified"
              ? t("creditContinuity.status.unverified")
              : status.state === "blocked"
                ? t("creditContinuity.status.blocked")
                : t("creditContinuity.status.available")}
      </p>
      <TableBox>
        <table>
          <caption>{t("creditContinuity.caption")}</caption>
          <thead>
            <tr>
              <th scope="col">{t("creditContinuity.columns.provider")}</th>
              <th scope="col">{t("creditContinuity.columns.state")}</th>
              <th scope="col">{t("creditContinuity.columns.automatic")}</th>
              <th scope="col">{t("creditContinuity.columns.costs")}</th>
              <th scope="col">{t("creditContinuity.columns.reserve")}</th>
              <th scope="col">{t("creditContinuity.columns.buffer")}</th>
              <th scope="col">{t("creditContinuity.columns.expires")}</th>
              <th scope="col">{t("creditContinuity.columns.forecast")}</th>
            </tr>
          </thead>
          <tbody>
            {status.pools.map((p) => (
              <tr key={p.provider}>
                <th scope="row">
                  <span className="ac-iconline">
                    <ProviderLogo id={p.provider} size="sm" />
                    {t(
                      p.provider === "openai"
                        ? "creditContinuity.provider.openai"
                        : "creditContinuity.provider.anthropic",
                    )}
                  </span>
                </th>
                <td>
                  {state(p)}
                  <br />
                  <span className="small muted">{t("creditContinuity.evidence", { date: date(p.verifiedAt) })}</span>
                </td>
                <td className="tabular">
                  {money(p.automaticAvailableNanoUsd)} / {money(p.automaticLimitNanoUsd)}
                </td>
                <td className="tabular">
                  {money(p.spentNanoUsd)} / {money(p.heldNanoUsd)}
                </td>
                <td className="tabular">
                  {money(p.emergencyLimitNanoUsd)}
                  <br />
                  <span className="small muted">
                    {p.activeReserveApprovalCount > 0 ? (
                      <>
                        {t("creditContinuity.approvedAvailable", {
                          amount: money(p.approvedEmergencyAvailableNanoUsd),
                        })}
                        <br />
                        {t("creditContinuity.approvals", { count: p.activeReserveApprovalCount })}
                      </>
                    ) : (
                      t("creditContinuity.ownerApproval")
                    )}
                  </span>
                </td>
                <td className="tabular">{money(p.safetyBufferNanoUsd)}</td>
                <td>{date(p.grantExpiresAt)}</td>
                <td>
                  {p.forecast.sampleCount > 0 && p.forecast.p95NanoUsd !== null ? (
                    <>
                      {money(p.forecast.p95NanoUsd)}
                      <br />
                      <span className="small muted">
                        {t(
                          p.forecast.uncertainty === "high"
                            ? "creditContinuity.historyHigh"
                            : p.forecast.uncertainty === "medium"
                              ? "creditContinuity.historyMedium"
                              : "creditContinuity.historyUnknown",
                          { count: p.forecast.sampleCount },
                        )}
                      </span>
                    </>
                  ) : (
                    t("creditContinuity.insufficientHistory")
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableBox>
      <p className="small muted">{t("creditContinuity.obligations", { count: status.unresolvedCount })}</p>
      <p className="small muted">{t("creditContinuity.evidenceNote", { date: date(status.observedAt) })}</p>
    </>
  );
}

/** The existing AI and usage screen reads stored status; opening or refreshing this card never probes a provider. */
export function CreditContinuityCard() {
  const { org } = useOrg();
  const { t, i18n } = useTranslation();
  const allowed = mayReadCreditContinuity(org);
  const query = useQuery({
    queryKey: ["org", org.id, "model-inspector-credit-status"],
    queryFn: () =>
      requester<{ credits?: CreditContinuityViewStatus }>(
        `/api/app/organizations/${encodeURIComponent(org.id)}/model-inspector`,
      ),
    enabled: allowed,
    staleTime: 15_000,
    refetchInterval: 60_000,
    retry: false,
  });
  if (!allowed) return null;
  return (
    <Card aria-labelledby="sec-credit-continuity">
      <CardHeader
        id="sec-credit-continuity"
        icon="chart"
        title={t("creditContinuity.title")}
        action={
          <Button size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}>
            {t("creditContinuity.refresh")}
          </Button>
        }
      />
      {query.isLoading && <LoadingList count={2} avatar={false} trailing />}
      {query.isError && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
      {query.data?.credits && <CreditContinuityView status={query.data.credits} locale={i18n.language} />}
      {!query.isLoading && !query.isError && !query.data?.credits && (
        <p className="small muted">{t("creditContinuity.unavailable")}</p>
      )}
    </Card>
  );
}
