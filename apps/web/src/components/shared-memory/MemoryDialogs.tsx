import type {
  SharedMemoryAction,
  SharedMemoryActionResult,
  SharedMemoryEntry,
  SharedMemorySensitivity,
  SharedMemorySnapshot,
} from "@agenteschat/client";
import { Button, Checkbox, Dialog, DialogBody, DialogFooter, Field, Input, Select, Textarea } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  MemoryActionError,
  MemoryBadges,
  MemoryBlockedNotice,
  MemoryDate,
  MemoryMeta,
  SourceDetails,
} from "./MemoryBits";

export interface MemoryMutation {
  isPending: boolean;
  error: unknown;
  data?: SharedMemoryActionResult;
  mutateAsync: (action: SharedMemoryAction) => Promise<SharedMemoryActionResult>;
}

function MutationFeedback({ mutation }: { mutation: MemoryMutation }) {
  const { t } = useTranslation();
  return (
    <>
      <MemoryActionError error={mutation.error} />
      {mutation.data?.action.state === "blocked" && (
        <p className="sm-notice" role="alert">
          {t("sharedMemory.blocked")} {mutation.data.action.reason}
        </p>
      )}
    </>
  );
}

const sensitivities: SharedMemorySensitivity[] = ["workspace", "personal", "sensitive"];
const dateInput = (value: string | null) => value?.slice(0, 10) ?? "";
export const validMemoryDate = (value: string) =>
  !value ||
  (/^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value);

async function save(action: SharedMemoryAction, mutation: MemoryMutation, close: () => void) {
  try {
    const result = await mutation.mutateAsync(action);
    if (result.action.state !== "blocked") close();
  } catch {
    /* The inline error keeps the draft. */
  }
}

export function CorrectMemoryDialog({
  entry,
  mutation,
  onClose,
}: {
  entry: SharedMemoryEntry;
  mutation: MemoryMutation;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  // Entry is the immutable opening snapshot. Background refreshes cannot authorize this draft.
  const [title, setTitle] = useState(entry.title);
  const [content, setContent] = useState(entry.content);
  const [from, setFrom] = useState(dateInput(entry.validFrom));
  const [until, setUntil] = useState(dateInput(entry.validTo));
  const datesValid = validMemoryDate(from) && validMemoryDate(until);
  const orderValid = !from || !until || until > from;
  const dirty =
    title !== entry.title ||
    content !== entry.content ||
    from !== dateInput(entry.validFrom) ||
    until !== dateInput(entry.validTo);
  return (
    <Dialog
      open
      title={t("sharedMemory.correct")}
      closeLabel={t("common.close")}
      onOpenChange={(open) => !open && onClose()}
      unsaved={dirty}
      width={720}
    >
      <DialogBody>
        <p className="small muted">{t("sharedMemory.correctionHelp")}</p>
        <MemoryBadges entry={entry} />
        <Field label={t("sharedMemory.titleField")}>
          <Input
            value={title}
            maxLength={300}
            onChange={(event) => setTitle(event.target.value)}
            disabled={mutation.isPending}
          />
        </Field>
        <Field label={t("sharedMemory.contentField")}>
          <Textarea
            value={content}
            rows={12}
            maxLength={8000}
            onChange={(event) => setContent(event.target.value)}
            disabled={mutation.isPending}
          />
        </Field>
        <div className="sm-form-pair">
          <Field
            label={t("sharedMemory.validFrom")}
            example={t("sharedMemory.dateExample")}
            error={!validMemoryDate(from) ? t("sharedMemory.invalidDate") : undefined}
          >
            <Input
              value={from}
              onChange={(event) => setFrom(event.target.value)}
              placeholder="2026-01-01"
              disabled={mutation.isPending}
            />
          </Field>
          <Field
            label={t("sharedMemory.validTo")}
            example={t("sharedMemory.dateExample")}
            error={
              !validMemoryDate(until)
                ? t("sharedMemory.invalidDate")
                : !orderValid
                  ? t("sharedMemory.dateOrder")
                  : undefined
            }
          >
            <Input
              value={until}
              onChange={(event) => setUntil(event.target.value)}
              placeholder="2026-12-31"
              disabled={mutation.isPending}
            />
          </Field>
        </div>
        <MutationFeedback mutation={mutation} />
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose} disabled={mutation.isPending}>
          {t("common.cancel")}
        </Button>
        <Button
          variant="primary"
          loading={mutation.isPending}
          disabled={!dirty || !title.trim() || !content.trim() || !datesValid || !orderValid}
          onClick={() =>
            void save(
              {
                type: "correct",
                entryId: entry.id,
                expectedVersion: entry.version,
                title: title.trim(),
                content: content.trim(),
                ...(from !== dateInput(entry.validFrom) ? { validFrom: from ? `${from}T00:00:00.000Z` : null } : {}),
                ...(until !== dateInput(entry.validTo) ? { validTo: until ? `${until}T00:00:00.000Z` : null } : {}),
              },
              mutation,
              onClose,
            )
          }
        >
          {t("sharedMemory.saveCorrection")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

export function ForgetMemoryDialog({
  entry,
  snapshot,
  mutation,
  onClose,
}: {
  entry: SharedMemoryEntry;
  snapshot: SharedMemorySnapshot;
  mutation: MemoryMutation;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [scope, setScope] = useState<"profile" | "workspace">("profile");
  const destinations = snapshot.destinations.filter((d) => d.orgId !== snapshot.profile?.canonicalOrgId);
  const [destination, setDestination] = useState(destinations[0]?.orgId ?? "");
  return (
    <Dialog
      open
      title={t("sharedMemory.forgetTitle", {
        title: entry.readable === true ? entry.title : t("sharedMemory.copyStates.blocked"),
      })}
      closeLabel={t("common.close")}
      onOpenChange={(open) => !open && onClose()}
      width={600}
    >
      <DialogBody>
        <p>{t("sharedMemory.forgetHelp")}</p>
        <Field label={t("sharedMemory.forgetScope")}>
          <Select
            value={scope}
            onValueChange={setScope}
            options={[
              { value: "profile", label: t("sharedMemory.forgetEverywhere") },
              { value: "workspace", label: t("sharedMemory.forgetWorkspace"), disabled: destinations.length === 0 },
            ]}
            disabled={mutation.isPending}
          />
        </Field>
        {scope === "workspace" && (
          <Field label={t("sharedMemory.chooseWorkspace")}>
            <Select
              value={destination}
              onValueChange={setDestination}
              options={destinations.map((d) => ({ value: d.orgId, label: d.name }))}
              disabled={mutation.isPending}
            />
          </Field>
        )}
        <p className="sm-notice">{t("sharedMemory.retained")}</p>
        <MutationFeedback mutation={mutation} />
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose} disabled={mutation.isPending}>
          {t("common.cancel")}
        </Button>
        <Button
          variant="danger"
          loading={mutation.isPending}
          disabled={scope === "workspace" && !destination}
          onClick={() =>
            void save(
              {
                type: "forget",
                entryId: entry.id,
                expectedVersion: entry.version,
                scope,
                ...(scope === "workspace" ? { destinationOrgId: destination } : {}),
              },
              mutation,
              onClose,
            )
          }
        >
          {t("sharedMemory.forgetAction")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

export function ScopeMemoryDialog({
  entry,
  mutation,
  onClose,
}: {
  entry: SharedMemoryEntry;
  mutation: MemoryMutation;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [scope, setScope] = useState<SharedMemorySensitivity>(entry.sensitivity);
  return (
    <Dialog
      open
      title={t("sharedMemory.changeScope")}
      closeLabel={t("common.close")}
      onOpenChange={(open) => !open && onClose()}
      width={520}
    >
      <DialogBody>
        <p>{entry.title}</p>
        <Field
          label={t("sharedMemory.changeScope")}
          hint={{ name: t("sharedMemory.changeScope"), text: t("sharedMemory.sensitivityHelp") }}
        >
          <Select
            value={scope}
            onValueChange={setScope}
            options={sensitivities.map((value) => ({ value, label: t(`sharedMemory.sensitivity.${value}`) }))}
            disabled={mutation.isPending}
          />
        </Field>
        <MutationFeedback mutation={mutation} />
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose} disabled={mutation.isPending}>
          {t("common.cancel")}
        </Button>
        <Button
          variant="primary"
          loading={mutation.isPending}
          disabled={scope === entry.sensitivity}
          onClick={() =>
            void save(
              { type: "sensitivity", entryId: entry.id, expectedVersion: entry.version, sensitivity: scope },
              mutation,
              onClose,
            )
          }
        >
          {t("sharedMemory.saveScope")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

export function EntryMemoryDialog({
  entry,
  snapshot,
  onClose,
  onCorrect,
  onScope,
  onForget,
}: {
  entry: SharedMemoryEntry;
  snapshot: SharedMemorySnapshot;
  onClose: () => void;
  onCorrect: () => void;
  onScope: () => void;
  onForget: () => void;
}) {
  const { t } = useTranslation();
  const ids = new Set(entry.sourceId ? [entry.sourceId] : []);
  const sources = snapshot.sources.filter((source) => ids.has(source.id));
  return (
    <Dialog
      open
      title={
        entry.readable === true || entry.status === "forgotten" ? entry.title : t("sharedMemory.copyStates.blocked")
      }
      closeLabel={t("common.close")}
      onOpenChange={(open) => !open && onClose()}
      width={800}
    >
      <DialogBody>
        <MemoryBadges entry={entry} />
        <MemoryBlockedNotice entry={entry} />
        {entry.readable === true && <div className="sm-memory-text">{entry.content}</div>}
        <MemoryMeta
          items={[
            { label: t("sharedMemory.recorded"), value: <MemoryDate value={entry.recordedAt} /> },
            { label: t("sharedMemory.observed"), value: <MemoryDate value={entry.observedAt} /> },
            { label: t("sharedMemory.validFrom"), value: <MemoryDate value={entry.validFrom} /> },
            { label: t("sharedMemory.validTo"), value: <MemoryDate value={entry.validTo} /> },
            { label: t("sharedMemory.currentVersion"), value: t("sharedMemory.revision", { version: entry.version }) },
            ...(entry.forgottenAt
              ? [{ label: t("sharedMemory.forgetDate"), value: <MemoryDate value={entry.forgottenAt} /> }]
              : []),
          ]}
        />
        <section className="sm-section">
          <h3>{t("sharedMemory.sources")}</h3>
          {sources.length ? (
            sources.map((source) => <SourceDetails key={source.id} source={source} />)
          ) : (
            <p className="small muted">{t("sharedMemory.noSource")}</p>
          )}
          <p className="small muted">{t("sharedMemory.sourceEcho")}</p>
        </section>
        {entry.replicas.length > 0 && (
          <section className="sm-section">
            <h3>{t("sharedMemory.syncTitle")}</h3>
            <ul className="sm-receipts">
              {entry.replicas.map((replica) => (
                <li key={replica.orgId}>
                  <strong>{snapshot.destinations.find((d) => d.orgId === replica.orgId)?.name ?? replica.orgId}</strong>
                  <span>
                    {t(
                      `sharedMemory.copyStates.${entry.readable !== true && replica.state !== "forgotten" ? "blocked" : replica.state}`,
                    )}
                  </span>
                  <MemoryDate value={replica.checkedAt} />
                  {replica.reason && <p>{replica.reason}</p>}
                </li>
              ))}
            </ul>
          </section>
        )}
        {entry.status === "forgotten" && (
          <section className="sm-section">
            <h3>{t("sharedMemory.outstanding")}</h3>
            {entry.externalOutstanding.length ? (
              <ul>
                {entry.externalOutstanding.map((name) => (
                  <li key={name}>{name}</li>
                ))}
              </ul>
            ) : (
              <p className="small muted">{t("sharedMemory.noOutstanding")}</p>
            )}
            <p className="small muted">{t("sharedMemory.retained")}</p>
          </section>
        )}
        {entry.readable === true && entry.history.length > 0 && (
          <section className="sm-section">
            <h3>{t("sharedMemory.previousVersions")}</h3>
            {entry.history.map((version) => (
              <details className="sm-history" key={`${version.itemId}:${version.version}`}>
                <summary>
                  {version.title}{" "}
                  <span className="small muted">
                    {t("sharedMemory.revision", { version: version.version })} ·{" "}
                    <MemoryDate value={version.recordedAt} />
                  </span>
                </summary>
                <div className="sm-memory-text">{version.content}</div>
              </details>
            ))}
          </section>
        )}
      </DialogBody>
      <DialogFooter>
        {snapshot.canManage && entry.status !== "forgotten" && (
          <div className="ac-acts">
            {entry.status === "active" && entry.readable === true && (
              <>
                <Button variant="link" onClick={onCorrect}>
                  {t("sharedMemory.correct")}
                </Button>
                <Button variant="link" onClick={onScope}>
                  {t("sharedMemory.changeScope")}
                </Button>
              </>
            )}
            <Button variant="link" onClick={onForget}>
              {t("sharedMemory.forget")}
            </Button>
          </div>
        )}
        <Button onClick={onClose}>{t("common.close")}</Button>
      </DialogFooter>
    </Dialog>
  );
}

export function DestinationMemoryDialog({
  snapshot,
  orgId,
  mutation,
  onClose,
}: {
  snapshot: SharedMemorySnapshot;
  orgId?: string;
  mutation: MemoryMutation;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const existing = snapshot.destinations.find((destination) => destination.orgId === orgId);
  const eligible = snapshot.eligibleDestinations.filter(
    (d) => !snapshot.destinations.some((present) => present.orgId === d.orgId),
  );
  const [picked, setPicked] = useState(orgId ?? eligible[0]?.orgId ?? "");
  const [allowed, setAllowed] = useState<SharedMemorySensitivity[]>(existing?.allowedSensitivity ?? ["workspace"]);
  return (
    <Dialog
      open
      title={existing ? t("sharedMemory.editDestination") : t("sharedMemory.enroll")}
      closeLabel={t("common.close")}
      onOpenChange={(open) => !open && onClose()}
      width={560}
    >
      <DialogBody>
        {existing ? (
          <h3>{existing.name}</h3>
        ) : (
          <Field
            label={t("sharedMemory.chooseWorkspace")}
            hint={{ name: t("sharedMemory.enroll"), text: t("sharedMemory.enrollHelp") }}
          >
            <Select
              value={picked}
              onValueChange={setPicked}
              options={eligible.map((d) => ({ value: d.orgId, label: d.name }))}
              disabled={mutation.isPending}
            />
          </Field>
        )}
        <fieldset className="sm-options">
          <legend>{t("sharedMemory.allowed")}</legend>
          {sensitivities.map((value) => (
            <label className="sm-checkline" htmlFor={`sm-share-${value}`} key={value}>
              <Checkbox
                id={`sm-share-${value}`}
                checked={allowed.includes(value)}
                disabled={mutation.isPending}
                onCheckedChange={(checked) =>
                  setAllowed((current) => (checked ? [...current, value] : current.filter((entry) => entry !== value)))
                }
              />
              <span>{t(`sharedMemory.sensitivity.${value}`)}</span>
            </label>
          ))}
        </fieldset>
        <p className="small muted">{t("sharedMemory.privacyHelp")}</p>
        <MutationFeedback mutation={mutation} />
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose} disabled={mutation.isPending}>
          {t("common.cancel")}
        </Button>
        <Button
          variant="primary"
          loading={mutation.isPending}
          disabled={!picked || !allowed.length}
          onClick={() =>
            void save(
              { type: "destination", orgId: picked, enabled: existing?.enabled ?? true, allowedSensitivity: allowed },
              mutation,
              onClose,
            )
          }
        >
          {t("sharedMemory.saveSharing")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

export function VerifyMemoryDialog({
  snapshot,
  mutation,
  onClose,
}: {
  snapshot: SharedMemorySnapshot;
  mutation: MemoryMutation;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [runId, setRunId] = useState("");
  const [ids, setIds] = useState<string[]>([]);
  const eligible = snapshot.entries.filter((entry) => entry.status === "active" && entry.readable === true);
  const eligibleIds = new Set(eligible.map((entry) => entry.id));
  const selected = ids.filter((id) => eligibleIds.has(id));
  return (
    <Dialog
      open
      title={t("sharedMemory.verifyAction")}
      closeLabel={t("common.close")}
      onOpenChange={(open) => !open && onClose()}
      width={640}
    >
      <DialogBody>
        <p className="small muted">{t("sharedMemory.verificationHelp")}</p>
        <Field label={t("sharedMemory.runId")}>
          <Input
            value={runId}
            onChange={(event) => setRunId(event.target.value)}
            disabled={mutation.isPending}
            autoComplete="off"
          />
        </Field>
        <fieldset className="sm-options">
          <legend>{t("sharedMemory.verifyMemories")}</legend>
          {eligible.map((entry) => (
            <label key={entry.id} className="sm-checkline" htmlFor={`sm-verify-${entry.id}`}>
              <Checkbox
                id={`sm-verify-${entry.id}`}
                checked={ids.includes(entry.id)}
                disabled={mutation.isPending}
                onCheckedChange={(checked) =>
                  setIds((current) => (checked ? [...current, entry.id] : current.filter((id) => id !== entry.id)))
                }
              />
              <span>{entry.title}</span>
            </label>
          ))}
        </fieldset>
        <MutationFeedback mutation={mutation} />
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose} disabled={mutation.isPending}>
          {t("common.cancel")}
        </Button>
        <Button
          variant="primary"
          loading={mutation.isPending}
          disabled={!runId.trim() || !selected.length}
          onClick={() => void save({ type: "verify", runId: runId.trim(), entryIds: selected }, mutation, onClose)}
        >
          {t("sharedMemory.verifySubmit")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
