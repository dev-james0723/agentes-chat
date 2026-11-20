import { useCostPerSuccess } from "@agenteschat/client";
import { formatUsd } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import { Card, CardHeader } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { ErrorState, LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";

/**
 * Cost per verified successful task (ADR 0206), measurement only: per agent, brain and model over the last 30 days.
 * Unknown money reads "Cost unknown", never 0; the total's sentence is the server's, in Hong Kong Chinese.
 */
export function CostPerSuccessCard() {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const allowed = can(org, "view_usage");
  const report = useCostPerSuccess(org.id, allowed);
  if (!allowed) return null;
  const data = report.data;
  return (
    <Card aria-labelledby="sec-cost-per-success">
      <CardHeader id="sec-cost-per-success" icon="chart" title={t("usageViews.costPerSuccess.title")} />
      <span className="small muted">{t("usageViews.costPerSuccess.intro")}</span>
      {report.isLoading && <LoadingList count={2} avatar trailing />}
      {report.isError && !data && <ErrorState error={report.error} onRetry={() => void report.refetch()} />}
      {data && data.total.runs > 0 && <span className="small">{data.total.text}</span>}
      {data && data.groups.length > 0 && (
        <div className="plan-api">
          {data.groups.map((g) => (
            <div key={`${g.agentId}:${g.brain}:${g.model ?? ""}`} className="plan-api__row plan-api__row--cps">
              <AgentAvatar agentId={g.agentId} size="sm" name={g.agentName} />
              <span className="plan-api__name">
                <b>{g.agentName}</b>
                <small>{g.model ? `${g.brain} · ${g.model}` : g.brain}</small>
              </span>
              <span className="plan-api__value">
                {g.costPerSuccessUsd !== null
                  ? t("usageViews.costPerSuccess.perSuccess", { cost: formatUsd(i18n.language, g.costPerSuccessUsd) })
                  : g.missing === "unknown_cost"
                    ? t("usageViews.costPerSuccess.unknown")
                    : t("usageViews.costPerSuccess.noSuccess")}
                <small>
                  {t("usageViews.costPerSuccess.line", {
                    runs: g.runs,
                    successes: g.verifiedSuccesses,
                    failed: g.failedRuns,
                    retries: g.retries,
                  })}
                </small>
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
