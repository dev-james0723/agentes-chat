import type { StorageReviewAction } from "@agenteschat/client";
import { useStorageGuardian, useStorageGuardianActions, useStorageReview } from "@agenteschat/client";
import { formatBytes } from "@agenteschat/client/lib/files";
import { can } from "@agenteschat/client/lib/permissions";
import { Button, Card, CardHeader, Chip, Input, Select } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { LoadingCards } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";

const ACTIONS: StorageReviewAction[] = ["keep", "protect", "archive", "delete", "restore"];

/**
 * Storage Guardian (ADR 0214): continuous cleanup's switch, the folders a person authorized, the review queue and
 * figures. Removed files, their registered size, the blocks measured on disk and the disk's free-space change are
 * shown apart, never added together.
 */
export function StorageGuardianSection() {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const admin = can(org, "configure");
  const view = useStorageGuardian(org.id, admin);
  const review = useStorageReview(org.id, admin);
  const act = useStorageGuardianActions(org.id);
  const toast = useToast();
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [machineId, setMachineId] = useState<string | undefined>();
  const [root, setRoot] = useState("scratch/");
  const [mode, setMode] = useState<"shadow" | "enforce">("shadow");
  if (!admin) return null;
  if (view.isLoading) return <LoadingCards count={1} />;
  const data = view.data;
  if (!data) return null;
  const size = (n: number) => formatBytes(i18n.language, n);
  const fig = data.figures;
  const items = review.data ?? [];
  const open = items.filter((i) => i.status === "open");
  const toggle = (id: string) => {
    const next = new Set(chosen);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setChosen(next);
  };
  const computerName = (id: string) => data.computers.find((c) => c.id === id)?.name ?? id;
  return (
    <Card aria-labelledby="storage-guardian">
      <CardHeader
        id="storage-guardian"
        icon="trash"
        title={t("storage.guardian.title")}
        subtitle={t("storage.guardian.intro")}
      />
      <div className="stack-4">
        <div className="row gap-2 wrap">
          <Chip tone={data.enabled ? "done" : "waiting"}>
            {t(data.enabled ? "storage.guardian.on" : "storage.guardian.off")}
          </Chip>
          <Button
            size="sm"
            variant={data.enabled ? "ghost" : "primary"}
            loading={act.settings.isPending}
            onClick={() => act.settings.mutate({ enabled: !data.enabled })}
          >
            {t(data.enabled ? "storage.guardian.turnOff" : "storage.guardian.turnOn")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              act.settings.mutate({ modeOverride: data.modeOverride === "performance" ? null : "performance" })
            }
          >
            {t(data.modeOverride === "performance" ? "storage.guardian.resume" : "storage.guardian.holdBack")}
          </Button>
        </div>
        <dl className="stack-1" aria-label={t("storage.guardian.figures")}>
          <div className="row gap-2">
            <dt>{t("storage.guardian.unlinked")}</dt>
            <dd>{fig.unlinked}</dd>
          </div>
          <div className="row gap-2">
            <dt>{t("storage.guardian.logical")}</dt>
            <dd>{size(fig.logicalBytes)}</dd>
          </div>
          <div className="row gap-2">
            <dt>{t("storage.guardian.allocated")}</dt>
            <dd>{size(fig.allocatedBytes)}</dd>
          </div>
          <div className="row gap-2">
            <dt>{t("storage.guardian.freeDelta", { count: fig.measuredRounds })}</dt>
            <dd>{size(fig.freeDeltaBytes)}</dd>
          </div>
          <div className="row gap-2">
            <dt>{t("storage.guardian.shadow")}</dt>
            <dd>{t("storage.guardian.shadowValue", { count: fig.shadowFiles, size: size(fig.shadowBytes) })}</dd>
          </div>
          <div className="row gap-2">
            <dt>{t("storage.guardian.moved")}</dt>
            <dd>{t("storage.guardian.movedValue", { archived: fig.archived, relocated: fig.relocated })}</dd>
          </div>
        </dl>
        {data.computers.length > 0 && (
          <ul className="stack-2" aria-label={t("storage.guardian.computers")}>
            {data.computers.map((c) => (
              <li key={c.id} className="row gap-2 wrap">
                <span>{c.name}</span>
                <Chip tone={c.mode === "critical" || c.mode === "elevated" ? "waiting" : "neutral"}>
                  {t(`storage.guardian.mode.${c.mode}`)}
                </Chip>
              </li>
            ))}
          </ul>
        )}
        <section className="stack-2" aria-label={t("storage.guardian.folders")}>
          <strong>{t("storage.guardian.folders")}</strong>
          <p className="text-muted">{t("storage.guardian.foldersIntro")}</p>
          {data.scopes.map((s) => (
            <div key={s.id} className="row gap-2 wrap">
              <code>{s.root}</code>
              <span className="text-muted">{computerName(s.machineId)}</span>
              <Chip tone={s.mode === "enforce" ? "done" : "neutral"}>
                {s.mode === "enforce"
                  ? t("storage.guardian.scopeMode.enforce")
                  : t("storage.guardian.scopeMode.shadow")}
              </Chip>
              <Button size="sm" variant="ghost" onClick={() => act.removeScope.mutate(s.id)}>
                {t("storage.guardian.removeFolder")}
              </Button>
            </div>
          ))}
          {data.computers.length > 0 && (
            <div className="row gap-2 wrap">
              <Select
                size="sm"
                value={machineId}
                onValueChange={setMachineId}
                placeholder={t("storage.guardian.computer")}
                options={data.computers.map((c) => ({ value: c.id, label: c.name }))}
              />
              <Input
                aria-label={t("storage.guardian.folder")}
                value={root}
                onChange={(e) => setRoot(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
              <Select
                size="sm"
                value={mode}
                onValueChange={(v) => setMode(v as "shadow" | "enforce")}
                options={[
                  { value: "shadow", label: t("storage.guardian.scopeMode.shadow") },
                  { value: "enforce", label: t("storage.guardian.scopeMode.enforce") },
                ]}
              />
              <Button
                size="sm"
                disabled={!machineId || !root.trim()}
                loading={act.addScope.isPending}
                onClick={() =>
                  machineId &&
                  act.addScope.mutate(
                    { machineId, root, mode },
                    { onError: (e) => toast.show(e instanceof Error ? e.message : String(e)) },
                  )
                }
              >
                {t("storage.guardian.addFolder")}
              </Button>
            </div>
          )}
        </section>
        <section className="stack-2" aria-label={t("storage.guardian.review")}>
          <strong>{t("storage.guardian.reviewCount", { count: open.length })}</strong>
          {items.length === 0 ? (
            <p className="text-muted">{t("storage.guardian.reviewNone")}</p>
          ) : (
            <>
              <div className="row gap-2 wrap">
                {ACTIONS.map((a) => (
                  <Button
                    key={a}
                    size="sm"
                    variant={a === "delete" ? "danger" : "ghost"}
                    disabled={chosen.size === 0}
                    onClick={() =>
                      act.decide.mutate(
                        { ids: [...chosen], action: a },
                        {
                          onSuccess: () => {
                            setChosen(new Set());
                            void review.refetch();
                          },
                        },
                      )
                    }
                  >
                    {t(`storage.guardian.action.${a}`)}
                  </Button>
                ))}
              </div>
              <ul className="stack-2">
                {items.map((i) => (
                  <li key={i.id} className="stack-1">
                    <label className="row gap-2 wrap">
                      <input type="checkbox" checked={chosen.has(i.id)} onChange={() => toggle(i.id)} />
                      <code>{i.file.path}</code>
                      <Chip>{i.file.role}</Chip>
                      <Chip tone={i.status === "open" ? "waiting" : "neutral"}>{i.status}</Chip>
                      {i.file.size !== null && <span className="text-muted">{size(i.file.size)}</span>}
                    </label>
                    <span className="text-muted">{i.reason}</span>
                    {i.history.length > 0 && (
                      <span className="text-muted">{i.history.map((h) => h.action).join(" → ")}</span>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
        {data.recent.length > 0 && (
          <section className="stack-2" aria-label={t("storage.guardian.receipts")}>
            <strong>{t("storage.guardian.receipts")}</strong>
            <ul className="stack-1">
              {data.recent.map((r) => (
                <li key={`${r.path}:${r.executedAt}`} className="row gap-2 wrap">
                  <code>{r.path}</code>
                  <Chip tone={r.status === "done" ? "done" : "neutral"}>
                    {r.shadow ? t("storage.guardian.shadowReceipt") : r.status}
                  </Chip>
                  {r.reason && <span className="text-muted">{r.reason}</span>}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Card>
  );
}
