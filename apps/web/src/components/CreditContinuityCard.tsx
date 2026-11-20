import { createRequester } from "@agenteschat/client";
import { formatUsd } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import { Button, Card, CardHeader } from "@agenteschat/ui";
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

export function CreditContinuityView({
  status,
  locale = "en-US",
}: {
  status: CreditContinuityViewStatus;
  locale?: string;
}) {
  const money = (nano: number | null) =>
    nano === null || !Number.isFinite(nano) ? "Unknown" : formatUsd(locale, nano / 1e9);
  const date = (value: string | null) =>
    value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(locale) : "Unknown";
  const state = (p: CreditContinuityViewStatus["pools"][number]) => {
    if (p.evidenceStatus === "unavailable") return "Unavailable";
    if (p.evidenceStatus !== "verified") return p.evidenceStatus === "unverified" ? "Not verified" : p.evidenceStatus;
    if (!status.enabled || !p.enabled) return "Disabled";
    if (p.paused) return "Paused";
    if (p.pricingStatus !== "verified")
      return p.pricingStatus === "expired"
        ? "Pricing expired"
        : p.pricingStatus === "changed"
          ? "Pricing changed"
          : "Pricing not verified";
    if (p.eligibleRouteCount < 1) return "No eligible API route";
    if (p.automaticAvailableNanoUsd <= 0 && p.approvedEmergencyAvailableNanoUsd <= 0) return "Budget unavailable";
    return p.status === "available"
      ? p.automaticAvailableNanoUsd > 0
        ? "Ready"
        : "Owner reserve available"
      : p.status;
  };
  return (
    <>
      <p className="small muted">
        Suitable subscriptions are used first. API fallback uses verified grants within the shared cycle limits.
      </p>
      <p className="small" role="status">
        {status.state === "unavailable"
          ? "Credit status is unavailable; automatic spending is not verified."
          : !status.enabled
            ? "Automatic API fallback is disabled. Recorded spending and pending costs remain shown."
            : status.state === "unverified"
              ? "No eligible API grants have been verified. Automatic allowance is $0."
              : status.state === "blocked"
                ? "API fallback is waiting for current evidence, budget or reconciliation."
                : "API fallback is available within the recorded grant limits."}
      </p>
      <TableBox>
        <table>
          <caption>API grants and cycle budgets</caption>
          <thead>
            <tr>
              <th scope="col">Provider</th>
              <th scope="col">State</th>
              <th scope="col">Automatic available / limit</th>
              <th scope="col">Spent / pending</th>
              <th scope="col">Owner reserve</th>
              <th scope="col">Safety buffer</th>
              <th scope="col">Grant expires</th>
              <th scope="col">Historical p95</th>
            </tr>
          </thead>
          <tbody>
            {status.pools.map((p) => (
              <tr key={p.provider}>
                <th scope="row">{p.provider === "openai" ? "OpenAI API" : "Claude API"}</th>
                <td>
                  {state(p)}
                  <br />
                  <span className="small muted">Evidence: {date(p.verifiedAt)}</span>
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
                        Approved available: {money(p.approvedEmergencyAvailableNanoUsd)}
                        <br />
                        {p.activeReserveApprovalCount} active owner{" "}
                        {p.activeReserveApprovalCount === 1 ? "approval" : "approvals"}
                      </>
                    ) : (
                      "Owner approval"
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
                        {p.forecast.sampleCount} settled units; {p.forecast.uncertainty} uncertainty
                      </span>
                    </>
                  ) : (
                    "Insufficient history"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableBox>
      <p className="small muted">
        {status.unresolvedCount} API calls have reserved or unresolved costs. Emergency reserves require owner approval;
        this feature does not enable paid top-ups.
      </p>
      <p className="small muted">
        Grant eligibility uses owner-recorded provider billing evidence. Historical forecasts do not authorize spending.
        Status read: {date(status.observedAt)}.
      </p>
    </>
  );
}

/** The existing AI and usage screen reads stored status; opening or refreshing this card never probes a provider. */
export function CreditContinuityCard() {
  const { org } = useOrg();
  const { i18n } = useTranslation();
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
        title="API credit continuity"
        action={
          <Button size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}>
            Refresh status
          </Button>
        }
      />
      {query.isLoading && <LoadingList count={2} avatar={false} trailing />}
      {query.isError && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
      {query.data?.credits && <CreditContinuityView status={query.data.credits} locale={i18n.language} />}
      {!query.isLoading && !query.isError && !query.data?.credits && (
        <p className="small muted">Credit status is unavailable. No grant allowance has been verified here.</p>
      )}
    </Card>
  );
}
