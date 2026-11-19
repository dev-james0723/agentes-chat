import { ApiError, type SharedMemoryEntry, type SharedMemorySource } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { memorySourceHref } from "@agenteschat/client/lib/shared-memory-graph";
import { Button, Chip, Icon } from "@agenteschat/ui";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

export function MemoryDate({ value }: { value: string | null | undefined }) {
  const { t, i18n } = useTranslation();
  if (!value || !Number.isFinite(new Date(value).getTime())) return <span>{t("sharedMemory.unknownDate")}</span>;
  return (
    <time dateTime={value} title={value}>
      {new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))}
    </time>
  );
}

export function MemoryMeta({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="sm-meta">
      {items.map(({ label, value }) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function MemoryBadges({ entry }: { entry: SharedMemoryEntry }) {
  const { t } = useTranslation();
  const blocked = entry.readable !== true && entry.status !== "forgotten";
  return (
    <div className="sm-chips">
      <Chip
        icon={
          blocked ? "lock" : entry.status === "active" ? "check" : entry.status === "forgotten" ? "archive" : "info"
        }
        tone={entry.status === "candidate" || entry.status === "disputed" ? "waiting" : "neutral"}
      >
        {t(blocked ? "sharedMemory.copyStates.blocked" : `sharedMemory.status.${entry.status}`)}
      </Chip>
      <Chip icon={entry.sensitivity === "workspace" ? "members" : "lock"}>
        {t(`sharedMemory.sensitivity.${entry.sensitivity}`)}
      </Chip>
      <Chip icon={entry.assertion === "inference" ? "agent" : "book"}>
        {t(`sharedMemory.assertion.${entry.assertion}`)}
      </Chip>
    </div>
  );
}

export function MemoryBlockedNotice({ entry }: { entry: SharedMemoryEntry }) {
  const { t } = useTranslation();
  if (entry.readable === true || entry.status === "forgotten") return null;
  return (
    <p className="sm-notice" role="status">
      {entry.blockedReason || t("sharedMemory.copyStates.blocked")}
    </p>
  );
}

export function MemoryActionError({ error }: { error: unknown }) {
  const { t, i18n } = useTranslation();
  if (!error) return null;
  const stale = error instanceof ApiError && error.status === 409 && /version|stale/i.test(error.code);
  return (
    <p role="alert" className="sm-error">
      <Icon name="alert" />
      {stale ? t("sharedMemory.stale") : errorText(t, error, i18n.language)}
    </p>
  );
}

export function SourceDetails({ source }: { source: SharedMemorySource }) {
  const { t } = useTranslation();
  const href = memorySourceHref(source.reference);
  return (
    <div className="sm-source">
      <div className="sm-section-head">
        <h3>{source.name}</h3>
        <Chip icon={source.status === "blocked" || source.status === "stale" ? "alert" : "book"}>
          {t(`sharedMemory.sourceStates.${source.status}`)}
        </Chip>
      </div>
      <MemoryMeta
        items={[
          { label: t("sharedMemory.captured"), value: <MemoryDate value={source.capturedAt} /> },
          { label: t("sharedMemory.observed"), value: <MemoryDate value={source.observedAt} /> },
          { label: t("sharedMemory.coverage"), value: source.coverage || t("sharedMemory.unknownDate") },
          { label: t("sharedMemory.origin"), value: source.originId },
          ...(source.revision ? [{ label: t("sharedMemory.sourceRevision"), value: source.revision }] : []),
          ...(source.refreshAfter
            ? [{ label: t("sharedMemory.refreshAfter"), value: <MemoryDate value={source.refreshAfter} /> }]
            : []),
        ]}
      />
      {href ? (
        <Button variant="link" asChild>
          <a href={href} target="_blank" rel="noopener noreferrer">
            <Icon name="link" />
            {t("sharedMemory.openSource")}
          </a>
        </Button>
      ) : (
        source.reference && <p className="small muted sm-reference">{source.reference}</p>
      )}
    </div>
  );
}
