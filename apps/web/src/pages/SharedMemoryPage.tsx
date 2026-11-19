import {
  ApiError,
  availableMemoryVerification,
  type SharedMemoryAction,
  type SharedMemoryEntry,
  type SharedMemorySensitivity,
  type SharedMemorySnapshot,
  useSharedMemory,
  useSharedMemoryAction,
} from "@agenteschat/client";
import type { MemoryGraphNode } from "@agenteschat/client/lib/shared-memory-graph";
import {
  Button,
  Card,
  CardHeader,
  Checkbox,
  Chip,
  Dialog,
  DialogBody,
  DialogFooter,
  EmptyState,
  Field,
  Icon,
  Input,
  PageHeader,
  SearchField,
  Select,
  TabPanel,
  Tabs,
  Toolbar,
} from "@agenteschat/ui";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorState, LoadingPage } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import {
  MemoryActionError,
  MemoryBadges,
  MemoryBlockedNotice,
  MemoryDate,
  MemoryMeta,
  SourceDetails,
} from "@/components/shared-memory/MemoryBits";
import {
  CorrectMemoryDialog,
  DestinationMemoryDialog,
  EntryMemoryDialog,
  ForgetMemoryDialog,
  type MemoryMutation,
  ScopeMemoryDialog,
  VerifyMemoryDialog,
} from "@/components/shared-memory/MemoryDialogs";
import { MemoryEvaluation } from "@/components/shared-memory/MemoryEvaluation";
import { MemoryGraph } from "@/components/shared-memory/MemoryGraph";
import { MemoryPrivacy, MemorySyncStatus } from "@/components/shared-memory/MemoryStatus";
import "./shared-memory.css";

export type SharedMemoryTab = "current" | "candidates" | "graph" | "sync" | "privacy" | "history";
export const SHARED_MEMORY_TABS: SharedMemoryTab[] = ["current", "candidates", "graph", "sync", "privacy", "history"];
type Opened =
  | { type: "detail" | "correct" | "forget" | "scope"; entry: SharedMemoryEntry }
  | { type: "destination"; orgId?: string }
  | { type: "verify" }
  | { type: "source"; sourceId: string };

export function filterSharedMemories(
  entries: SharedMemoryEntry[],
  query: string,
  sensitivity: "all" | SharedMemorySensitivity,
  snapshot: SharedMemorySnapshot,
) {
  const q = query.trim().toLocaleLowerCase();
  return entries.filter((entry) => {
    if (sensitivity !== "all" && entry.sensitivity !== sensitivity) return false;
    const sourceNames = snapshot.sources
      .filter((source) => entry.sourceId === source.id)
      .map((source) => source.name)
      .join(" ");
    const readableText = entry.readable === true ? `${entry.title} ${entry.content}` : "";
    return !q || `${readableText} ${entry.key} ${sourceNames}`.toLocaleLowerCase().includes(q);
  });
}

function MemorySetup({ snapshot, mutation }: { snapshot: SharedMemorySnapshot; mutation: MemoryMutation }) {
  const { t } = useTranslation();
  const [name, setName] = useState(t("sharedMemory.defaultName"));
  const [adopt, setAdopt] = useState<string[]>([]);
  return (
    <Card padded className="sm-setup">
      <CardHeader icon="book" title={t("sharedMemory.setupTitle")} subtitle={t("sharedMemory.setupText")} />
      <Field label={t("sharedMemory.profileName")}>
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={150}
          disabled={mutation.isPending}
        />
      </Field>
      <fieldset className="sm-options">
        <legend>{t("sharedMemory.adopt")}</legend>
        <p className="small muted">{t("sharedMemory.adoptHelp")}</p>
        {snapshot.availableItems.length ? (
          snapshot.availableItems.map((item) => (
            <label className="sm-checkline" htmlFor={`sm-adopt-${item.itemId}`} key={item.itemId}>
              <Checkbox
                id={`sm-adopt-${item.itemId}`}
                checked={adopt.includes(item.itemId)}
                onCheckedChange={(checked) =>
                  setAdopt((current) =>
                    checked ? [...current, item.itemId] : current.filter((id) => id !== item.itemId),
                  )
                }
                disabled={mutation.isPending}
              />
              <span>{item.title}</span>
            </label>
          ))
        ) : (
          <p className="small muted">{t("sharedMemory.noAdopt")}</p>
        )}
      </fieldset>
      <p className="small muted">{t("sharedMemory.setupScope")}</p>
      <MemoryActionError error={mutation.error} />
      {mutation.data?.action.state === "blocked" && (
        <p className="sm-notice" role="status">
          {mutation.data.action.reason || t("sharedMemory.blocked")}
        </p>
      )}
      <div className="ac-acts">
        <Button
          variant="primary"
          loading={mutation.isPending}
          disabled={!name.trim()}
          onClick={() =>
            void mutation
              .mutateAsync({
                type: "configure",
                name: name.trim(),
                destinations: [],
                adopt: adopt.map((itemId) => ({ itemId, key: `memory.${itemId}`, sensitivity: "personal" })),
              })
              .catch(() => {})
          }
        >
          {t("sharedMemory.configure")}
        </Button>
      </div>
    </Card>
  );
}

function EntryCard({
  entry,
  snapshot,
  onOpen,
  onDecide,
  pending,
}: {
  entry: SharedMemoryEntry;
  snapshot: SharedMemorySnapshot;
  onOpen: () => void;
  onDecide: (decision: "accept" | "reject") => void;
  pending: boolean;
}) {
  const { t } = useTranslation();
  const sources = snapshot.sources.filter((source) => entry.sourceId === source.id);
  return (
    <Card padded as="article" className="sm-entry" aria-labelledby={`sm-entry-${entry.id}`}>
      <div className="sm-entry__heading">
        <Icon name="bulb" />
        <h2 id={`sm-entry-${entry.id}`}>
          {entry.readable === true || entry.status === "forgotten" ? entry.title : t("sharedMemory.copyStates.blocked")}
        </h2>
      </div>
      <MemoryBadges entry={entry} />
      <MemoryBlockedNotice entry={entry} />
      <MemoryMeta
        items={[
          { label: t("sharedMemory.recorded"), value: <MemoryDate value={entry.recordedAt} /> },
          {
            label: t("sharedMemory.source"),
            value: sources.length ? sources.map((source) => source.name).join(", ") : t("sharedMemory.noSource"),
          },
        ]}
      />
      {entry.status === "forgotten" && entry.externalOutstanding.length > 0 && (
        <p className="sm-notice">
          {t("sharedMemory.outstanding")}: {entry.externalOutstanding.join(", ")}
        </p>
      )}
      <div className="ac-acts">
        <Button variant="link" onClick={onOpen}>
          {t("sharedMemory.details")}
        </Button>
        {snapshot.canManage && (entry.status === "candidate" || entry.status === "disputed") && (
          <>
            <Button size="sm" onClick={() => onDecide("accept")} disabled={pending || entry.readable !== true}>
              {t("sharedMemory.accept")}
            </Button>
            <Button variant="link" onClick={() => onDecide("reject")} disabled={pending}>
              {t("sharedMemory.reject")}
            </Button>
          </>
        )}
      </div>
    </Card>
  );
}

export function SharedMemoryPage({
  initialTab = "current",
  linkedEntry,
}: {
  initialTab?: SharedMemoryTab;
  linkedEntry?: string;
}) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const query = useSharedMemory(org.id);
  const mutation = useSharedMemoryAction(org.id);
  const [tab, setTab] = useState<SharedMemoryTab>(initialTab);
  const [search, setSearch] = useState("");
  const [scope, setScope] = useState<"all" | SharedMemorySensitivity>("all");
  const [opened, setOpened] = useState<Opened | null>(null);
  const [dismissedLink, setDismissedLink] = useState(false);
  const snapshot = query.snapshot;
  useEffect(() => {
    if (!snapshot || !opened || !("entry" in opened)) return;
    const latest = [...snapshot.entries, ...snapshot.candidates].find((entry) => entry.id === opened.entry.id);
    if (!latest && snapshot.pagination.complete) setOpened(null);
    else if (latest?.readable !== true && opened.entry.readable === true && latest) {
      // Discard the cached editor body permanently. Restoring access must not reopen that old draft.
      setOpened({ type: "detail", entry: latest });
    }
  }, [snapshot, opened]);
  const act = (action: SharedMemoryAction) => {
    mutation.reset();
    void mutation.mutateAsync(action).catch(() => {});
  };
  const open = (value: Opened) => {
    mutation.reset();
    setOpened(value);
  };
  const close = () => {
    setOpened(null);
    setDismissedLink(true);
    if (mutation.error) mutation.reset();
  };
  const current = snapshot?.entries.filter((entry) => entry.status === "active") ?? [];
  const currentReadableCount = current.filter((entry) => entry.readable === true).length;
  const verification = snapshot ? availableMemoryVerification(snapshot) : undefined;
  const candidates = snapshot?.candidates ?? [];
  const historical = snapshot?.entries.filter((entry) => entry.status !== "active" || entry.history.length > 0) ?? [];
  const linked =
    !dismissedLink && linkedEntry
      ? [...(snapshot?.entries ?? []), ...candidates].find((entry) => entry.id === linkedEntry)
      : undefined;
  const requestedModal = opened ?? (linked ? { type: "detail" as const, entry: linked } : null);
  const currentModalEntry =
    requestedModal && "entry" in requestedModal
      ? [...(snapshot?.entries ?? []), ...candidates].find((entry) => entry.id === requestedModal.entry.id)
      : undefined;
  // A withdrawn source cannot leave its old body visible in an already-open editor.
  const modal =
    (requestedModal?.type === "correct" || requestedModal?.type === "scope") && currentModalEntry?.readable !== true
      ? currentModalEntry
        ? { type: "detail" as const, entry: currentModalEntry }
        : null
      : requestedModal;
  // Details follow live state. Editing/forgetting/scope dialogs retain their opening control version.
  const detail =
    modal?.type === "detail"
      ? [...(snapshot?.entries ?? []), ...candidates].find((entry) => entry.id === modal.entry.id)
      : undefined;
  const available = snapshot?.profile && snapshot.canManage;
  const source = modal?.type === "source" ? snapshot?.sources.find((item) => item.id === modal.sourceId) : undefined;
  const graphEntries = new Map([...(snapshot?.entries ?? []), ...candidates].map((entry) => [entry.id, entry]));
  const graph = snapshot && {
    ...snapshot.graph,
    nodes: snapshot.graph.nodes.map((node) => {
      const entry = node.entryId ? graphEntries.get(node.entryId) : undefined;
      return entry && entry.readable !== true && entry.status !== "forgotten"
        ? { ...node, label: t("sharedMemory.copyStates.blocked") }
        : node;
    }),
  };
  const canonicalName =
    me.organizations.find((workspace) => workspace.id === snapshot?.profile?.canonicalOrgId)?.name ?? org.name;
  const showEntries = (entries: SharedMemoryEntry[], emptyKey: "empty" | "emptyReview" | "emptyHistory") => {
    if (!snapshot) return null;
    const shown = filterSharedMemories(entries, search, scope, snapshot);
    return shown.length ? (
      <div className="sm-entries">
        {shown.map((entry) => (
          <EntryCard
            key={entry.id}
            entry={entry}
            snapshot={snapshot}
            pending={mutation.isPending}
            onOpen={() => open({ type: "detail", entry })}
            onDecide={(decision) =>
              act({ type: "decide", entryId: entry.id, expectedVersion: entry.version, decision })
            }
          />
        ))}
      </div>
    ) : (
      <EmptyState
        icon={search ? "search" : "book"}
        actions={
          search && (
            <Button
              size="sm"
              onClick={() => {
                setSearch("");
                setScope("all");
              }}
            >
              {t("sharedMemory.clear")}
            </Button>
          )
        }
      >
        {t(search || scope !== "all" ? "sharedMemory.emptySearch" : `sharedMemory.${emptyKey}`)}
      </EmptyState>
    );
  };
  const inspect = (node: MemoryGraphNode) => {
    if (!snapshot) return null;
    if (node.kind === "entry") {
      const entry = [...snapshot.entries, ...snapshot.candidates].find((item) => item.id === node.entryId);
      return entry ? (
        <>
          <MemoryBadges entry={entry} />
          <MemoryBlockedNotice entry={entry} />
          <MemoryMeta items={[{ label: t("sharedMemory.recorded"), value: <MemoryDate value={entry.recordedAt} /> }]} />
          <Button size="sm" onClick={() => open({ type: "detail", entry })}>
            {t("sharedMemory.details")}
          </Button>
        </>
      ) : null;
    }
    if (node.kind === "source") {
      const record = snapshot.sources.find((item) => item.id === node.sourceId);
      return record ? (
        <>
          <Chip icon="book">{t(`sharedMemory.sourceStates.${record.status}`)}</Chip>
          <MemoryMeta
            items={[{ label: t("sharedMemory.captured"), value: <MemoryDate value={record.capturedAt} /> }]}
          />
          <Button size="sm" onClick={() => open({ type: "source", sourceId: record.id })}>
            {t("sharedMemory.openSource")}
          </Button>
        </>
      ) : null;
    }
    const destination = snapshot.destinations.find((item) => item.orgId === node.orgId);
    return destination ? (
      <>
        <Chip icon="shield">{t(destination.enabled ? "sharedMemory.enrolled" : "sharedMemory.paused")}</Chip>
        <MemoryMeta
          items={[{ label: t("sharedMemory.synced"), value: <MemoryDate value={destination.lastSyncedAt} /> }]}
        />
        <Button size="sm" onClick={() => setTab("privacy")}>
          {t("sharedMemory.editDestination")}
        </Button>
      </>
    ) : null;
  };
  return (
    <div className="page page--full sm-page">
      <PageHeader
        title={t("sharedMemory.title")}
        meta={t("sharedMemory.subtitle")}
        actions={
          <Button
            onClick={() => void query.restartScan()}
            loading={query.isFetching && !query.isFetchingNextPage}
            icon="refresh"
          >
            {t("sharedMemory.refresh")}
          </Button>
        }
      />
      {query.isPending && <LoadingPage rows={3} />}
      {query.pageRevisionChanged && !snapshot && (
        <p className="sm-notice" role="status">
          {t("sharedMemory.changedWhileLoading")}
        </p>
      )}
      {query.isError &&
        !snapshot &&
        (query.error instanceof ApiError && query.error.status === 501 ? (
          <EmptyState icon="info">{t("sharedMemory.unavailable")}</EmptyState>
        ) : (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ))}
      {query.isError && snapshot && (
        <div className="sm-notice" role="alert">
          {t("sharedMemory.staleView")}{" "}
          <Button variant="link" onClick={() => void query.refetch()}>
            {t("common.retry")}
          </Button>
        </div>
      )}
      {snapshot && !snapshot.canManage && <EmptyState icon="lock">{t("sharedMemory.denied")}</EmptyState>}
      {snapshot?.canManage && !snapshot.profile && <MemorySetup snapshot={snapshot} mutation={mutation} />}
      {snapshot && available && (
        <>
          <div className="sm-profile-line">
            <Chip icon="lock">{t("sharedMemory.scope")}</Chip>
            <span className="small muted">
              {snapshot.profile?.name} · {t("sharedMemory.canonical", { name: canonicalName })}
            </span>
          </div>
          {!snapshot.pagination.complete && (
            <div className="sm-notice" role="status">
              <span>
                {t(query.pageRevisionChanged ? "sharedMemory.changedWhileLoading" : "sharedMemory.partial")}{" "}
                {t("sharedMemory.loaded", {
                  loaded: snapshot.entries.length + snapshot.candidates.length,
                  total: snapshot.pagination.total,
                })}
              </span>
              <Button
                size="sm"
                loading={query.isFetching}
                disabled={!query.pageRevisionChanged && !query.hasNextPage}
                onClick={() => void (query.pageRevisionChanged ? query.refetch() : query.fetchNextPage())}
              >
                {t(query.pageRevisionChanged ? "sharedMemory.refresh" : "sharedMemory.loadMore")}
              </Button>
            </div>
          )}
          <section className="sm-summary" aria-label={t("sharedMemory.title")}>
            <div>
              <span>{t("sharedMemory.activeCount")}</span>
              <strong>{currentReadableCount}</strong>
            </div>
            <div>
              <span>{t("sharedMemory.reviewCount")}</span>
              <strong>{candidates.length}</strong>
            </div>
            <div>
              <span>{t("sharedMemory.destinationCount")}</span>
              <strong>{snapshot.destinations.filter((destination) => destination.enabled).length}</strong>
            </div>
            <div>
              <span>{t("sharedMemory.verifiedCount")}</span>
              <strong className="sm-summary__status">
                {t(`sharedMemory.verificationStates.${verification?.status ?? "not_run"}`)}
              </strong>
            </div>
          </section>
          {mutation.data && (
            <p role="status" className="sm-notice">
              {t(
                mutation.data.action.state === "applied"
                  ? "sharedMemory.saved"
                  : mutation.data.action.state === "queued"
                    ? "sharedMemory.queued"
                    : "sharedMemory.blocked",
              )}
              {mutation.data.action.reason && ` ${mutation.data.action.reason}`}
            </p>
          )}
          {!modal && <MemoryActionError error={mutation.error} />}
          <Tabs
            value={tab}
            onValueChange={setTab}
            label={t("sharedMemory.tabsLabel")}
            items={SHARED_MEMORY_TABS.map((value) => ({
              value,
              label: t(`sharedMemory.tabs.${value}`),
              ...(value === "current"
                ? { count: currentReadableCount }
                : value === "candidates"
                  ? { count: candidates.length }
                  : {}),
            }))}
          >
            {(tab === "current" || tab === "candidates" || tab === "history") && (
              <Toolbar
                search={
                  <SearchField
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    onClear={() => setSearch("")}
                    clearLabel={t("sharedMemory.clear")}
                    aria-label={t("sharedMemory.search")}
                    placeholder={t("sharedMemory.searchPlaceholder")}
                  />
                }
              >
                <Select
                  value={scope}
                  onValueChange={setScope}
                  size="sm"
                  aria-label={t("sharedMemory.filter")}
                  options={[
                    { value: "all", label: t("sharedMemory.all") },
                    ...(["personal", "workspace", "sensitive"] as const).map((value) => ({
                      value,
                      label: t(`sharedMemory.sensitivity.${value}`),
                    })),
                  ]}
                />
              </Toolbar>
            )}
            <TabPanel value="current">{showEntries(current, "empty")}</TabPanel>
            <TabPanel value="candidates">
              <p className="small muted">{t("sharedMemory.reviewHelp")}</p>
              {showEntries(candidates, "emptyReview")}
            </TabPanel>
            <TabPanel value="graph">{graph && <MemoryGraph graph={graph} inspect={inspect} />}</TabPanel>
            <TabPanel value="sync">
              <MemorySyncStatus
                snapshot={snapshot}
                pending={mutation.isPending}
                onReconcile={() => act({ type: "reconcile" })}
                onVerify={() => open({ type: "verify" })}
              />
              <MemoryEvaluation orgId={org.id} />
            </TabPanel>
            <TabPanel value="privacy">
              <MemoryPrivacy
                snapshot={snapshot}
                pending={mutation.isPending}
                onDestination={(orgId) => open({ type: "destination", orgId })}
                onToggle={(orgId, enabled) => act({ type: "destination", orgId, enabled })}
              />
            </TabPanel>
            <TabPanel value="history">{showEntries(historical, "emptyHistory")}</TabPanel>
          </Tabs>
          {!snapshot.pagination.complete && !query.pageRevisionChanged && (
            <div className="sm-pagination">
              <span className="small muted">
                {t("sharedMemory.loaded", {
                  loaded: snapshot.entries.length + snapshot.candidates.length,
                  total: snapshot.pagination.total,
                })}
              </span>
              <Button
                onClick={() => void query.fetchNextPage()}
                loading={query.isFetchingNextPage}
                disabled={!query.hasNextPage}
              >
                {t("sharedMemory.loadMore")}
              </Button>
            </div>
          )}
          {modal?.type === "detail" && detail && (
            <EntryMemoryDialog
              entry={detail}
              snapshot={snapshot}
              onClose={close}
              onCorrect={() => open({ type: "correct", entry: detail })}
              onScope={() => open({ type: "scope", entry: detail })}
              onForget={() => open({ type: "forget", entry: detail })}
            />
          )}
          {modal?.type === "correct" && (
            <CorrectMemoryDialog
              key={`${modal.entry.id}:${modal.entry.version}`}
              entry={modal.entry}
              mutation={mutation}
              onClose={close}
            />
          )}
          {modal?.type === "forget" && (
            <ForgetMemoryDialog
              key={`${modal.entry.id}:${modal.entry.version}`}
              entry={{
                ...modal.entry,
                readable: currentModalEntry?.readable === true,
                blockedReason: currentModalEntry?.blockedReason ?? null,
              }}
              snapshot={snapshot}
              mutation={mutation}
              onClose={close}
            />
          )}
          {modal?.type === "scope" && (
            <ScopeMemoryDialog
              key={`${modal.entry.id}:${modal.entry.version}`}
              entry={modal.entry}
              mutation={mutation}
              onClose={close}
            />
          )}
          {modal?.type === "destination" && (
            <DestinationMemoryDialog
              key={modal.orgId ?? "new"}
              snapshot={snapshot}
              orgId={modal.orgId}
              mutation={mutation}
              onClose={close}
            />
          )}
          {modal?.type === "verify" && <VerifyMemoryDialog snapshot={snapshot} mutation={mutation} onClose={close} />}
          {source && (
            <Dialog
              open
              title={source.name}
              closeLabel={t("common.close")}
              onOpenChange={(value) => !value && close()}
              width={640}
            >
              <DialogBody>
                <SourceDetails source={source} />
              </DialogBody>
              <DialogFooter>
                <Button onClick={close}>{t("common.close")}</Button>
              </DialogFooter>
            </Dialog>
          )}
        </>
      )}
    </div>
  );
}
