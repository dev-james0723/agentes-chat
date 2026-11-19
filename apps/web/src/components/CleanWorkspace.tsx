import type { CleanWorkspaceReport } from "@agenteschat/client";
import { useApproveCleanup, useCleanWorkspace } from "@agenteschat/client";
import { formatBytes } from "@agenteschat/client/lib/files";
import { can } from "@agenteschat/client/lib/permissions";
import { Button, Card, CardHeader, Chip } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { LoadingCards } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";

/**
 * Clean workspace (ADR 0200): each computer's disk level, and what every ended task left on agents' computers.
 * Deliverables, evidence and unexplained files are only listed; a person approves cleaning the temporary ones, and
 * each removal's receipt (or the reason it was kept) shows under its task.
 */
export function CleanWorkspaceSection() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const admin = can(org, "configure");
  const view = useCleanWorkspace(org.id, admin);
  if (!admin) return null;
  if (view.isLoading) return <LoadingCards count={1} />;
  const data = view.data;
  if (!data) return null;
  return (
    <Card aria-labelledby="clean-workspace">
      <CardHeader
        id="clean-workspace"
        icon="trash"
        title={t("storage.clean.title")}
        subtitle={t("storage.clean.intro")}
      />
      <div className="stack-4">
        {data.computers.length > 0 && (
          <ul className="stack-2" aria-label={t("storage.clean.computers")}>
            {data.computers.map((c) => (
              <li key={c.id} className="row gap-2 wrap">
                <span>{c.name}</span>
                <Chip tone={c.level === "critical" || c.level === "low" ? "waiting" : "neutral"}>
                  {t(`storage.clean.level.${c.level}`, { free: c.freeGb ?? "" })}
                </Chip>
              </li>
            ))}
          </ul>
        )}
        {data.reports.length === 0 ? (
          <p className="text-muted">{t("storage.clean.none")}</p>
        ) : (
          <div className="stack-3">
            {data.reports.map((r) => (
              <ReportRow key={r.id} report={r} />
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

function ReportRow({ report }: { report: CleanWorkspaceReport }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const approve = useApproveCleanup(org.id);
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const size = (n: number) => formatBytes(i18n.language, n);
  const decided = new Set(report.cleanups.map((c) => c.path));
  const waiting = report.items.filter(
    (i) => i.where === "computer" && i.decision === "candidate" && !decided.has(i.path),
  ).length;
  const freed = report.cleanups.find((c) => c.freeBefore !== null && c.freeAfter !== null);
  return (
    <div className="stack-2">
      <div className="row gap-2 wrap">
        <strong>{t(report.subjectType === "issue" ? "storage.clean.task" : "storage.clean.mission")}</strong>
        <Chip>{t(`storage.clean.ended.${report.outcome}`)}</Chip>
        <span className="text-muted">{t("storage.clean.kept", { count: report.kept })}</span>
        {report.candidates > 0 && (
          <span>{t("storage.clean.candidates", { count: report.candidates, size: size(report.candidateBytes) })}</span>
        )}
        {report.duplicates > 0 && (
          <span className="text-muted">{t("storage.clean.duplicates", { count: report.duplicates })}</span>
        )}
      </div>
      {report.snapshot && (
        <span className="text-muted">
          {t("storage.clean.restorable", {
            restorable: report.snapshot.restorable,
            manifestOnly: report.snapshot.manifestOnly,
          })}
        </span>
      )}
      {freed && (
        <span>
          {t("storage.clean.freed", { before: size(freed.freeBefore ?? 0), after: size(freed.freeAfter ?? 0) })}
        </span>
      )}
      <div className="row gap-2">
        {waiting > 0 && (
          <Button
            size="sm"
            loading={approve.isPending}
            onClick={() =>
              approve.mutate(
                { reportId: report.id },
                { onSuccess: (r) => toast.show(t("storage.clean.approved", { count: r.approved })) },
              )
            }
          >
            {t("storage.clean.approve")}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => setOpen(!open)}>
          {t(open ? "storage.clean.hide" : "storage.clean.show")}
        </Button>
      </div>
      {open && (
        <ul className="stack-2">
          {report.items.map((i) => {
            const receipt = report.cleanups.find((c) => c.path === i.path);
            return (
              <li key={`${i.where}:${i.path}`} className="stack-1">
                <div className="row gap-2 wrap">
                  <code>{i.path}</code>
                  {receipt ? (
                    <Chip tone={receipt.status === "done" ? "done" : "neutral"}>
                      {t(`storage.clean.status.${receipt.status}`, { reason: receipt.reason ?? "" })}
                    </Chip>
                  ) : (
                    i.size !== null && <span className="text-muted">{size(i.size)}</span>
                  )}
                </div>
                <span className="text-muted">{i.why}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
