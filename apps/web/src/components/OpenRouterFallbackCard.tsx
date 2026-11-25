import { createRequester, useCredentials } from "@agenteschat/client";
import { formatUsd } from "@agenteschat/client/lib/format";
import { Button, Card, CardHeader } from "@agenteschat/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorState, LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";

const request = createRequester();
type Tier = "low" | "medium" | "high" | "xhigh" | "max";
interface Policy {
  allowedModels: string[];
  costTier: Tier;
  monthlyCapUsd: number;
  maxPromptUsdPerMillion: number;
  maxCompletionUsdPerMillion: number;
}
export interface OpenRouterFallbackStatus {
  serverEnabled: boolean;
  enabled: boolean;
  blocked: boolean;
  monthlyCapNanoUsd: number;
  spentNanoUsd: number;
  heldNanoUsd: number;
  credentialId: string | null;
  revision: number;
  period: string;
  policy: Partial<Policy>;
}
type Change = { enabled: false } | { enabled: true; credentialId: string; policy: Policy };

export function OpenRouterFallbackForm({
  status,
  keys,
  save,
  pending,
}: {
  status: OpenRouterFallbackStatus;
  keys: { id: string; label: string }[];
  save: (change: Change) => void;
  pending: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [key, setKey] = useState(status.credentialId ?? "");
  const [models, setModels] = useState(status.policy.allowedModels?.join("\n") ?? "");
  const [cap, setCap] = useState(String(status.monthlyCapNanoUsd / 1e9));
  const [tier, setTier] = useState<Tier>(status.policy.costTier ?? "medium");
  const [input, setInput] = useState(String(status.policy.maxPromptUsdPerMillion ?? 5));
  const [output, setOutput] = useState(String(status.policy.maxCompletionUsdPerMillion ?? 25));
  const money = (n: number) => formatUsd(i18n.language, n / 1e9);
  const valid = key && models.trim() && Number(cap) > 0 && Number(cap) <= 50 && Number(input) > 0 && Number(output) > 0;
  return (
    <>
      <p className="small muted">{t("openRouterFallback.intro")}</p>
      <p className="small">{t("openRouterFallback.routes")}</p>
      <p role="status">
        {t(
          !status.serverEnabled
            ? "openRouterFallback.serverDisabled"
            : status.blocked
              ? "openRouterFallback.blocked"
              : status.enabled
                ? "openRouterFallback.configured"
                : "openRouterFallback.disabled",
        )}
      </p>
      <p>
        {t("openRouterFallback.spent")}: {money(status.spentNanoUsd)} / {money(status.monthlyCapNanoUsd)} ·{" "}
        {t("openRouterFallback.pending")}: {money(status.heldNanoUsd)}
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && status.serverEnabled && !status.blocked && !pending)
            save({
              enabled: true,
              credentialId: key,
              policy: {
                allowedModels: models.split(/\s+/).filter(Boolean),
                costTier: tier,
                monthlyCapUsd: Number(cap),
                maxPromptUsdPerMillion: Number(input),
                maxCompletionUsdPerMillion: Number(output),
              },
            });
        }}
      >
        <fieldset disabled={!status.serverEnabled || pending}>
          <p>
            <label>
              {t("openRouterFallback.key")}{" "}
              <select value={key} onChange={(e) => setKey(e.target.value)} required>
                <option value="">{t("openRouterFallback.chooseKey")}</option>
                {keys.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.label}
                  </option>
                ))}
              </select>
            </label>
          </p>
          <p className="small muted">{t("openRouterFallback.keyHint")}</p>
          <p>
            <label>
              {t("openRouterFallback.cap")}{" "}
              <input
                type="number"
                min="0.01"
                max="50"
                step="0.01"
                value={cap}
                onChange={(e) => setCap(e.target.value)}
                required
              />
            </label>
          </p>
          <p>
            <label>
              {t("openRouterFallback.models")}{" "}
              <textarea
                rows={4}
                value={models}
                onInput={(e) => setModels(e.currentTarget.value)}
                onChange={(e) => setModels(e.target.value)}
                required
              />
            </label>
          </p>
          <p>
            <label>
              {t("openRouterFallback.tier")}{" "}
              <select value={tier} onChange={(e) => setTier(e.target.value as Tier)}>
                {(["low", "medium", "high", "xhigh", "max"] as const).map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
          </p>
          <p>
            <label>
              {t("openRouterFallback.inputPrice")}{" "}
              <input
                type="number"
                min="0.001"
                max="10000"
                step="any"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                required
              />
            </label>
          </p>
          <p>
            <label>
              {t("openRouterFallback.outputPrice")}{" "}
              <input
                type="number"
                min="0.001"
                max="10000"
                step="any"
                value={output}
                onChange={(e) => setOutput(e.target.value)}
                required
              />
            </label>
          </p>
          <Button type="submit" disabled={!valid || status.blocked}>
            {t("openRouterFallback.enable")}
          </Button>
        </fieldset>
      </form>
      {status.enabled && (
        <Button disabled={pending} onClick={() => save({ enabled: false })}>
          {t("openRouterFallback.disable")}
        </Button>
      )}
    </>
  );
}

export function OpenRouterFallbackCard() {
  const { org } = useOrg();
  const { t } = useTranslation();
  const allowed = org.role === "owner";
  const url = `/api/app/organizations/${encodeURIComponent(org.id)}/openrouter-fallback`;
  const keys = useCredentials(org.id, allowed);
  const query = useQuery({
    queryKey: ["org", org.id, "openrouter-fallback"],
    queryFn: () => request<OpenRouterFallbackStatus>(url),
    enabled: allowed,
    retry: false,
  });
  const mutation = useMutation({
    mutationFn: (change: Change) => request<OpenRouterFallbackStatus>(url, { method: "PATCH", json: change }),
    onSuccess: () => {
      void query.refetch();
    },
  });
  if (!allowed) return null;
  return (
    <Card aria-labelledby="sec-openrouter-fallback">
      <CardHeader
        id="sec-openrouter-fallback"
        icon="chart"
        title={t("openRouterFallback.title")}
        action={
          <Button size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}>
            {t("openRouterFallback.refresh")}
          </Button>
        }
      />
      {query.isLoading && <LoadingList count={2} avatar={false} trailing />}
      {query.isError && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
      {mutation.isError && <p role="alert">{t("openRouterFallback.error")}</p>}
      {query.data && (
        <OpenRouterFallbackForm
          key={`${org.id}:${query.data.revision}`}
          status={query.data}
          keys={(keys.data ?? []).filter((k) => k.provider === "openrouter" && !k.revokedAt && !k.endpoint)}
          save={(change) => mutation.mutate(change)}
          pending={mutation.isPending}
        />
      )}
    </Card>
  );
}
