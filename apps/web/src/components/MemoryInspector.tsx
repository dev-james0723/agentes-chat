import type { Memory } from "@agenteschat/client";
import { useMemoryHistory } from "@agenteschat/client";
import { relativeTime } from "@agenteschat/client/lib/format";
import { messagePath } from "@agenteschat/client/lib/message-links";
import { Button, Dialog, DialogBody, DialogFooter } from "@agenteschat/ui";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ErrorState, LoadingLine } from "@/components/Loading";
import { useOrg } from "@/components/org-context";

const SCOPES = ["agent", "channel", "thread", "org", "person", "entity"] as const;
type Scope = (typeof SCOPES)[number] | "other";
const scopeOf = (type: string): Scope => SCOPES.find((s) => s === type) ?? "other";

const day = (language: string, iso: string) =>
  new Date(iso).toLocaleDateString(language, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** Where a memory applies, how far it is trusted, whether it is in use, when it holds and the message it came from. */
export function MemoryFacts({ m }: { m: Memory }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  if (!m.scope && !m.trust && !m.status) return null;
  const facts = [
    m.scope && t("memory.inspect.scope", { scope: t(`memory.inspect.scopes.${scopeOf(m.scope.type)}`) }),
    m.trust && t(m.trust === "low" ? "memory.inspect.trustLow" : "memory.inspect.trustHigh"),
    m.status && t(m.status === "archived" ? "memory.inspect.statusArchived" : "memory.inspect.statusActive"),
    m.validFrom && t("memory.inspect.validFrom", { date: day(i18n.language, m.validFrom) }),
    m.validTo && t("memory.inspect.validTo", { date: day(i18n.language, m.validTo) }),
  ].filter(Boolean);
  const source = m.sourceMessage;
  const href = source
    ? messagePath(org.id, { id: source.messageId, channelId: source.channelId, threadId: source.threadId })
    : null;
  return (
    <p className="memory-item__facts small muted" style={{ margin: 0 }}>
      {facts.join(" · ")}
      {href && (
        <>
          {" · "}
          <a
            href={href}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey) return;
              e.preventDefault();
              void navigate({ href });
            }}
          >
            {t("memory.inspect.source")}
          </a>
        </>
      )}
    </p>
  );
}

/** "Histórico e uso": the versions the viewer reads and the newest runs that received this memory. */
export function MemoryHistoryPanel({ id }: { id: string }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const history = useMemoryHistory(org.id, id);
  if (history.isError) return <ErrorState error={history.error} onRetry={() => void history.refetch()} />;
  if (!history.data) return <LoadingLine />;
  const { versions, runs } = history.data;
  return (
    <section className="memory-item__history small" aria-label={t("memory.inspect.toggle")}>
      <h4 className="muted" style={{ margin: 0 }}>
        {t("memory.inspect.versions")}
      </h4>
      <ol>
        {versions.map((v) => (
          <li key={v.id} aria-current={v.current || undefined}>
            <strong>{t("memory.inspect.version", { version: v.version })}</strong>
            {v.current && ` (${t("memory.inspect.current")})`} {v.text}
            {v.supersededAt && (
              <span className="muted">
                {" · "}
                {t("memory.inspect.replaced", { when: relativeTime(t, i18n.language, v.supersededAt) })}
              </span>
            )}
          </li>
        ))}
      </ol>
      <h4 className="muted" style={{ margin: 0 }}>
        {t("memory.inspect.runs")}
      </h4>
      {runs.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>
          {t("memory.inspect.noRuns")}
        </p>
      ) : (
        <ul>
          {runs.map((r) => (
            <li key={r.runId}>
              {t("memory.inspect.run", {
                agent: r.agentName ?? "—",
                channel: r.channelName ?? "—",
                when: relativeTime(t, i18n.language, r.createdAt),
              })}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Asks before going back to the previous version (the current one is archived, both stay in the history). */
export function RevertMemoryDialog({
  memory,
  pending,
  onClose,
  onRevert,
}: {
  memory: Memory | null;
  pending: boolean;
  onClose: () => void;
  onRevert: (m: Memory) => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog
      open={memory !== null}
      onOpenChange={(open) => !open && onClose()}
      title={t("memory.inspect.revertTitle")}
      closeLabel={t("common.close")}
      width={440}
    >
      <DialogBody>
        <p style={{ margin: 0 }}>{t("memory.inspect.revertText")}</p>
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="danger" loading={pending} onClick={() => memory && onRevert(memory)}>
          {t("memory.inspect.revert")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
