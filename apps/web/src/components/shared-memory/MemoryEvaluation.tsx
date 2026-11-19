import {
  ApiError,
  useEvaluateSharedMemoryMem0,
  useSharedMemoryMem0,
  useSharedMemoryMem0Latest,
} from "@agenteschat/client";
import { Button, Card, CardHeader, Chip, EmptyState } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { ErrorState, LoadingLine } from "@/components/Loading";
import { MemoryActionError, MemoryDate, MemoryMeta } from "./MemoryBits";

export function MemoryEvaluation({ orgId }: { orgId: string }) {
  const { t } = useTranslation();
  const readiness = useSharedMemoryMem0(orgId);
  const evaluation = useEvaluateSharedMemoryMem0(orgId);
  const latest = useSharedMemoryMem0Latest(orgId);
  const ready = readiness.data;
  const storedReport = latest.data?.report;
  const completedReport = evaluation.data;
  const report = !storedReport
    ? completedReport
    : completedReport && Date.parse(completedReport.observedAt) >= Date.parse(storedReport.observedAt)
      ? completedReport
      : storedReport;
  const checkpoint = latest.data?.checkpoint;
  const unfinished = Boolean(evaluation.isPending || (checkpoint && checkpoint.runId !== report?.runId));
  return (
    <Card padded>
      <CardHeader
        title={t("sharedMemory.mem0Title")}
        hint={{ name: t("sharedMemory.mem0Title"), text: t("sharedMemory.mem0Help") }}
      />
      {readiness.isPending && <LoadingLine />}
      {readiness.isError &&
        (readiness.error instanceof ApiError && [404, 501].includes(readiness.error.status) ? (
          <EmptyState size="inline">{t("sharedMemory.evaluationUnavailable")}</EmptyState>
        ) : (
          <ErrorState error={readiness.error} onRetry={() => void readiness.refetch()} />
        ))}
      {ready && (
        <>
          <div className="sm-section-head">
            <Chip icon="info">{t(`sharedMemory.mem0States.${ready.readiness}`)}</Chip>
            {ready.canEvaluate && ready.readiness === "configured_unverified" && (
              <Button
                size="sm"
                loading={evaluation.isPending}
                onClick={() => void evaluation.mutateAsync().catch(() => {})}
              >
                {t("sharedMemory.evaluate")}
              </Button>
            )}
          </div>
          <p className="small muted">{t("sharedMemory.mem0Help")}</p>
          {!ready.canEvaluate && <p className="small muted">{t("sharedMemory.evaluationOwner")}</p>}
        </>
      )}
      <MemoryActionError error={evaluation.error} />
      {latest.isError && <ErrorState error={latest.error} onRetry={() => void latest.refetch()} />}
      {unfinished && (
        <div className="sm-notice" role="status">
          <p>{t("sharedMemory.evaluationPending")}</p>
          {checkpoint && (
            <MemoryMeta
              items={[
                { label: t("sharedMemory.checked"), value: <MemoryDate value={checkpoint.observedAt} /> },
                { label: t("sharedMemory.requests"), value: checkpoint.requests },
                { label: t("sharedMemory.evaluationCases"), value: checkpoint.completedCases },
              ]}
            />
          )}
        </div>
      )}
      {report && (
        <section className="sm-section" aria-label={t("sharedMemory.evaluationResult")}>
          <h3>{t(unfinished ? "sharedMemory.previousEvaluation" : "sharedMemory.evaluationResult")}</h3>
          <div className="sm-chips">
            <Chip icon={report.status === "passed" ? "check" : "info"}>
              {t(`sharedMemory.evaluationStates.${report.status}`)}
            </Chip>
            <Chip icon="book">{t(`sharedMemory.evidenceMode.${report.evidenceMode}`)}</Chip>
            <MemoryDate value={report.observedAt} />
          </div>
          <p>{t("sharedMemory.evaluationTotals", report.totals)}</p>
          <p className="small muted">{t("sharedMemory.evaluationLimit")}</p>
          <MemoryMeta
            items={[
              { label: t("sharedMemory.requests"), value: report.metrics.requests },
              { label: t("sharedMemory.elapsed"), value: `${(report.metrics.elapsedMs / 1000).toFixed(1)} s` },
              {
                label: t("sharedMemory.latency"),
                value:
                  report.metrics.searchP95Ms === null
                    ? t("sharedMemory.notMeasured")
                    : `${Math.round(report.metrics.searchP95Ms)} ms`,
              },
              { label: t("sharedMemory.cost"), value: t("sharedMemory.notMeasured") },
              { label: t("sharedMemory.cleanup"), value: t(`sharedMemory.cleanupStates.${report.cleanup.status}`) },
            ]}
          />
          {report.cleanup.status === "incomplete" && (
            <div role="alert" className="sm-notice">
              {t("sharedMemory.cleanupOutstanding")}
              {report.cleanup.issues.length > 0 && (
                <ul>
                  {[...new Set(report.cleanup.issues)].map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <details className="sm-history">
            <summary>{t("sharedMemory.evaluationCases")}</summary>
            <ul className="sm-evaluation-cases">
              {report.cases.map((item) => (
                <li key={item.id}>
                  <span>{item.id.replaceAll("-", " ")}</span>
                  <Chip icon={item.status === "passed" ? "check" : "info"}>
                    {t(`sharedMemory.evaluationStates.${item.status}`)}
                  </Chip>
                  {item.reason && <span className="small muted">{item.reason}</span>}
                </li>
              ))}
            </ul>
          </details>
        </section>
      )}
      {(report || checkpoint) && (
        <details className="sm-history">
          <summary>{t("sharedMemory.evaluationResult")} · JSON</summary>
          <pre className="sm-memory-text">
            {JSON.stringify({ report: report ?? null, checkpoint: checkpoint ?? null }, null, 2)}
          </pre>
        </details>
      )}
    </Card>
  );
}
