/** Native shared-memory control metadata. Memory text remains in context_items. */
export type SharedMemorySensitivity = "personal" | "workspace" | "sensitive";
export type SharedMemoryStatus = "active" | "candidate" | "disputed" | "rejected" | "forgotten";
export type SharedMemoryAssertion = "owner_statement" | "owner_correction" | "observation" | "inference" | "import";

export interface SharedMemorySource {
  id: string;
  name: string;
  provider: "native" | "file" | "chatgpt" | "claude" | "other";
  reference: string | null;
  originId: string;
  revision: string | null;
  capturedAt: string;
  observedAt: string | null;
  refreshAfter: string | null;
  coverage: string;
  recordCount: number | null;
  status: "snapshot" | "current" | "stale" | "blocked";
}

export interface SharedMemoryConsumer {
  id: string;
  name: string;
  kind: "file" | "chatgpt" | "claude" | "mem0" | "other";
  status: "not_connected" | "snapshot" | "current" | "pending" | "blocked";
  revision: number | null;
  /** The whole-profile source/readability digest checked by a file consumer. */
  availabilityRevision?: string | null;
  checkedAt: string | null;
  reason: string | null;
  /** An acknowledgement is not a connector: native consumer stores remain snapshots unless an adapter proves a write. */
  writable: boolean;
}

export interface SharedMemoryReplica {
  orgId: string;
  itemId: string | null;
  state: "current" | "pending" | "conflict" | "blocked" | "forgotten";
  appliedVersion: number | null;
  checkedAt: string | null;
  reason: string | null;
}

export interface SharedMemoryEntry {
  id: string;
  key: string;
  itemId: string | null;
  sourceOrgId: string;
  title: string;
  content: string;
  kind: string;
  status: SharedMemoryStatus;
  readable: boolean;
  blockedReason: string | null;
  /** Control revision captured when an editor opens; independent of the native item revision. */
  version: number;
  itemVersion: number | null;
  sensitivity: SharedMemorySensitivity;
  assertion: SharedMemoryAssertion;
  originId: string;
  sourceId: string | null;
  sourceIds: string[];
  sourceRevision: string | null;
  observedAt: string | null;
  recordedAt: string;
  validFrom: string | null;
  validTo: string | null;
  forgottenAt: string | null;
  externalOutstanding: string[];
  replicas: SharedMemoryReplica[];
  history: { itemId: string; version: number; title: string; content: string; status: string; recordedAt: string }[];
}

export interface SharedMemoryDestination {
  orgId: string;
  name: string;
  enabled: boolean;
  state: "active" | "blocked" | "paused";
  allowedSensitivity: SharedMemorySensitivity[];
  lastSyncedAt: string | null;
  reason: string | null;
  current: number;
  pending: number;
  conflicts: number;
}

export interface SharedMemoryVerification {
  status: "not_run" | "passed" | "failed";
  checkedAt: string | null;
  runId: string | null;
  verifiedEntryIds: string[];
  missingEntryIds: string[];
  detail: string;
}

export interface SharedMemorySnapshot {
  profile: {
    id: string;
    name: string;
    ownerUserId: string;
    canonicalOrgId: string;
    version: number;
    availabilityRevision: string;
    updatedAt: string;
  } | null;
  canManage: boolean;
  entries: SharedMemoryEntry[];
  candidates: SharedMemoryEntry[];
  destinations: SharedMemoryDestination[];
  sources: SharedMemorySource[];
  consumers: SharedMemoryConsumer[];
  verification: SharedMemoryVerification;
  /** Adoption is explicit; only these current, readable native items may be selected. */
  availableItems: { itemId: string; title: string; kind: string; version: number }[];
  eligibleDestinations: { orgId: string; name: string }[];
  pagination: { nextCursor: string | null; complete: boolean; total: number };
  graph: {
    nodes: {
      id: string;
      kind: "entry" | "source" | "workspace";
      label: string;
      entryId?: string;
      sourceId?: string;
      orgId?: string;
    }[];
    edges: { from: string; to: string; kind: "derived_from" | "replicated_to" | "conflicts_with" }[];
  };
}

export type SharedMemoryAction =
  | {
      type: "configure";
      name?: string;
      destinations?: { orgId: string; allowedSensitivity?: SharedMemorySensitivity[] }[];
      adopt?: {
        itemId: string;
        key: string;
        sensitivity?: SharedMemorySensitivity;
        sourceId?: string;
        replicas?: { orgId: string; itemId: string }[];
      }[];
    }
  | { type: "destination"; orgId: string; enabled: boolean; allowedSensitivity?: SharedMemorySensitivity[] }
  | {
      type: "capture";
      itemId: string;
      sourceOrgId: string;
      key?: string;
      sourceId?: string;
      originId?: string;
      observedAt?: string | null;
    }
  | { type: "decide"; entryId: string; expectedVersion: number; decision: "accept" | "reject" }
  | {
      type: "correct";
      entryId: string;
      expectedVersion: number;
      content: string;
      title?: string;
      validFrom?: string | null;
      validTo?: string | null;
    }
  | { type: "sensitivity"; entryId: string; expectedVersion: number; sensitivity: SharedMemorySensitivity }
  | {
      type: "forget";
      entryId: string;
      expectedVersion: number;
      scope: "profile" | "workspace";
      destinationOrgId?: string;
    }
  | { type: "reconcile" }
  | {
      type: "source";
      source: Omit<SharedMemorySource, "id" | "status"> & { id?: string; status?: "snapshot" | "current" | "blocked" };
    }
  | { type: "consumer"; consumer: SharedMemoryConsumer }
  | { type: "verify"; runId: string; entryIds: string[] };

export interface SharedMemoryActionResult {
  snapshot: SharedMemorySnapshot;
  action: { state: "applied" | "queued" | "blocked"; id?: string; reason?: string };
}

/** Safe readiness only. Credentials and private native memories never enter this contract. */
export interface SharedMemoryMem0Readiness {
  provider: "mem0";
  readiness: "disabled" | "missing_key" | "configured_unverified";
  configured: boolean;
  mode: "synthetic_only";
  privateProjectionEnabled: false;
  canEvaluate: boolean;
}

export interface SharedMemoryMem0Report {
  provider: "mem0";
  suite: "synthetic_projection_v1";
  evidenceMode: "provider_live" | "injected_transport" | "not_run";
  readiness: Omit<SharedMemoryMem0Readiness, "canEvaluate">;
  status: "passed" | "failed" | "partial" | "unavailable";
  providerVerified: boolean;
  nativeAuthority: true;
  privateMemoriesSent: false;
  modelAnswersTested: false;
  runId: string | null;
  observedAt: string;
  cases: {
    id: string;
    category: string;
    status: "passed" | "failed" | "unavailable" | "skipped";
    reason: string | null;
    elapsedMs: number;
    matchedFactIds: string[];
    suppressedInputs: number;
  }[];
  totals: { passed: number; failed: number; unavailable: number; skipped: number };
  metrics: { requests: number; elapsedMs: number; searchP95Ms: number | null; cost: null };
  cleanup: {
    status: "complete" | "incomplete" | "not_needed";
    deleted: number;
    remainingIds: string[];
    unresolvedOperations: string[];
    eventIds: string[];
    issues: string[];
  };
}

export interface SharedMemoryMem0Checkpoint {
  provider: "mem0";
  suite: "synthetic_projection_v1";
  runId: string;
  observedAt: string;
  sequence: number;
  evidenceMode: "provider_live" | "injected_transport";
  phase: "started" | "running" | "cleanup";
  providerVerified: false;
  privateMemoriesSent: false;
  modelAnswersTested: false;
  requests: number;
  completedCases: number;
  ownedMemoryIds: string[];
  eventIds: string[];
  unresolvedOperations: string[];
  cleanupDeleted: number;
}

export interface SharedMemoryMem0Latest {
  report: SharedMemoryMem0Report | null;
  checkpoint: SharedMemoryMem0Checkpoint | null;
}
