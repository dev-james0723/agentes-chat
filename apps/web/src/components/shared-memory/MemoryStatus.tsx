import {
  availableMemoryConsumerStatus,
  availableMemoryVerification,
  type SharedMemorySnapshot,
} from "@agenteschat/client";
import { Button, Card, CardHeader, Chip, EmptyState, ProviderLogo } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { MemoryDate, MemoryMeta, SourceDetails } from "./MemoryBits";

export function MemorySyncStatus({
  snapshot,
  pending,
  onReconcile,
  onVerify,
}: {
  snapshot: SharedMemorySnapshot;
  pending: boolean;
  onReconcile: () => void;
  onVerify: () => void;
}) {
  const { t } = useTranslation();
  const verification = availableMemoryVerification(snapshot);
  return (
    <div className="sm-section-stack">
      <Card padded>
        <CardHeader
          icon="refresh"
          title={t("sharedMemory.syncTitle")}
          hint={{ name: t("sharedMemory.syncTitle"), text: t("sharedMemory.syncHelp") }}
          action={
            snapshot.canManage && (
              <Button size="sm" loading={pending} onClick={onReconcile}>
                {t("sharedMemory.reconcile")}
              </Button>
            )
          }
        />
        {snapshot.destinations.length === 0 ? (
          <EmptyState size="inline">{t("sharedMemory.noDestinations")}</EmptyState>
        ) : (
          <div className="sm-destinations">
            {snapshot.destinations.map((destination) => (
              <article key={destination.orgId} className="sm-destination">
                <div className="sm-section-head">
                  <h3>{destination.name}</h3>
                  <Chip
                    icon={destination.state === "blocked" ? "alert" : destination.enabled ? "check" : "pause"}
                    tone={destination.state === "blocked" ? "waiting" : "neutral"}
                  >
                    {t(
                      destination.state === "blocked"
                        ? "sharedMemory.blockedDestination"
                        : destination.enabled
                          ? "sharedMemory.enrolled"
                          : "sharedMemory.paused",
                    )}
                  </Chip>
                </div>
                <div className="sm-chips">
                  <span>{t("sharedMemory.currentCopies", { count: destination.current })}</span>
                  <span>{t("sharedMemory.pendingCopies", { count: destination.pending })}</span>
                  <span>{t("sharedMemory.conflicts", { count: destination.conflicts })}</span>
                </div>
                <MemoryMeta
                  items={[
                    {
                      label: t("sharedMemory.synced"),
                      value: destination.lastSyncedAt ? (
                        <MemoryDate value={destination.lastSyncedAt} />
                      ) : (
                        t("sharedMemory.never")
                      ),
                    },
                  ]}
                />
                {destination.reason && <p className="sm-notice">{destination.reason}</p>}
              </article>
            ))}
          </div>
        )}
      </Card>
      <Card padded>
        <CardHeader
          icon="search"
          title={t("sharedMemory.verificationTitle")}
          hint={{ name: t("sharedMemory.verificationTitle"), text: t("sharedMemory.verificationHelp") }}
          action={
            snapshot.canManage && (
              <Button
                size="sm"
                onClick={onVerify}
                disabled={
                  pending || !snapshot.entries.some((entry) => entry.status === "active" && entry.readable === true)
                }
              >
                {t("sharedMemory.verifyAction")}
              </Button>
            )
          }
        />
        <div className="sm-chips">
          <Chip icon={verification.status === "passed" ? "check" : verification.status === "failed" ? "alert" : "info"}>
            {t(`sharedMemory.verificationStates.${verification.status}`)}
          </Chip>
          {verification.status !== "not_run" && (
            <>
              <span>{t("sharedMemory.verified", { count: verification.verifiedEntryIds.length })}</span>
              <span>{t("sharedMemory.missing", { count: verification.missingEntryIds.length })}</span>
            </>
          )}
        </div>
        {verification.detail && <p>{verification.detail}</p>}
        {verification.checkedAt && (
          <MemoryMeta
            items={[
              { label: t("sharedMemory.checked"), value: <MemoryDate value={verification.checkedAt} /> },
              ...(verification.runId ? [{ label: t("sharedMemory.runId"), value: verification.runId }] : []),
            ]}
          />
        )}
        <p className="small muted">{t("sharedMemory.verificationHelp")}</p>
      </Card>
      <Card padded>
        <CardHeader
          icon="link"
          title={t("sharedMemory.consumerTitle")}
          hint={{ name: t("sharedMemory.consumerTitle"), text: t("sharedMemory.consumerHelp") }}
        />
        {snapshot.consumers.length === 0 ? (
          <EmptyState size="inline">{t("sharedMemory.consumersEmpty")}</EmptyState>
        ) : (
          <div className="sm-destinations">
            {snapshot.consumers.map((consumer) => (
              <article className="sm-destination" key={consumer.id}>
                <div className="sm-section-head">
                  <h3 className="sm-provider">
                    {(consumer.kind === "chatgpt" || consumer.kind === "claude") && (
                      <ProviderLogo id={consumer.kind === "chatgpt" ? "openai" : "anthropic"} size="xs" />
                    )}
                    {consumer.name}
                  </h3>
                  <Chip
                    icon={availableMemoryConsumerStatus(consumer, snapshot.profile) === "blocked" ? "alert" : "book"}
                  >
                    {t(`sharedMemory.consumerStates.${availableMemoryConsumerStatus(consumer, snapshot.profile)}`)}
                  </Chip>
                </div>
                <p className="small muted">
                  {t(consumer.writable ? "sharedMemory.writable" : "sharedMemory.snapshotOnly")}
                </p>
                <MemoryMeta
                  items={[
                    {
                      label: t("sharedMemory.checked"),
                      value: consumer.checkedAt ? <MemoryDate value={consumer.checkedAt} /> : t("sharedMemory.never"),
                    },
                    ...(consumer.revision !== null
                      ? [
                          {
                            label: t("sharedMemory.currentVersion"),
                            value: t("sharedMemory.revision", { version: consumer.revision }),
                          },
                        ]
                      : []),
                  ]}
                />
                {consumer.reason && <p className="sm-notice">{consumer.reason}</p>}
              </article>
            ))}
          </div>
        )}
      </Card>
      <Card padded>
        <CardHeader icon="book" title={t("sharedMemory.sourcesTitle")} />
        {snapshot.sources.length ? (
          snapshot.sources.map((source) => <SourceDetails key={source.id} source={source} />)
        ) : (
          <EmptyState size="inline">{t("sharedMemory.sourcesEmpty")}</EmptyState>
        )}
      </Card>
    </div>
  );
}

export function MemoryPrivacy({
  snapshot,
  pending,
  onDestination,
  onToggle,
}: {
  snapshot: SharedMemorySnapshot;
  pending: boolean;
  onDestination: (orgId?: string) => void;
  onToggle: (orgId: string, enabled: boolean) => void;
}) {
  const { t } = useTranslation();
  const eligible = snapshot.eligibleDestinations.filter(
    (d) =>
      d.orgId !== snapshot.profile?.canonicalOrgId &&
      !snapshot.destinations.some((destination) => destination.orgId === d.orgId),
  );
  return (
    <Card padded>
      <CardHeader
        icon="shield"
        title={t("sharedMemory.privacyTitle")}
        hint={{ name: t("sharedMemory.privacyTitle"), text: t("sharedMemory.privacyHelp") }}
        action={
          snapshot.canManage &&
          eligible.length > 0 && (
            <Button size="sm" onClick={() => onDestination()} disabled={pending}>
              {t("sharedMemory.enroll")}
            </Button>
          )
        }
      />
      <p className="small muted">{t("sharedMemory.canonicalPrivacy")}</p>
      {snapshot.destinations.length ? (
        <div className="sm-destinations">
          {snapshot.destinations.map((destination) => (
            <article className="sm-destination" key={destination.orgId}>
              <div className="sm-section-head">
                <h3>{destination.name}</h3>
                <Chip icon={destination.state === "blocked" ? "alert" : "shield"}>
                  {t(
                    destination.state === "blocked"
                      ? "sharedMemory.blockedDestination"
                      : destination.enabled
                        ? "sharedMemory.enrolled"
                        : "sharedMemory.paused",
                  )}
                </Chip>
              </div>
              <div className="sm-chips">
                {destination.allowedSensitivity.map((scope) => (
                  <Chip key={scope} icon={scope === "workspace" ? "members" : "lock"}>
                    {t(`sharedMemory.sensitivity.${scope}`)}
                  </Chip>
                ))}
              </div>
              {destination.reason && <p className="sm-notice">{destination.reason}</p>}
              {snapshot.canManage && destination.orgId !== snapshot.profile?.canonicalOrgId && (
                <div className="ac-acts">
                  <Button variant="link" onClick={() => onDestination(destination.orgId)} disabled={pending}>
                    {t("sharedMemory.editDestination")}
                  </Button>
                  <Button
                    variant="link"
                    onClick={() => onToggle(destination.orgId, !destination.enabled)}
                    disabled={pending}
                  >
                    {t(destination.enabled ? "sharedMemory.pause" : "sharedMemory.resume")}
                  </Button>
                </div>
              )}
            </article>
          ))}
        </div>
      ) : (
        <EmptyState size="inline">{t("sharedMemory.noDestinations")}</EmptyState>
      )}
      {eligible.length === 0 && <p className="small muted">{t("sharedMemory.noEligible")}</p>}
    </Card>
  );
}
