import type { SharedMemoryAction, SharedMemoryEntry, SharedMemorySnapshot } from "@agenteschat/client";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";

export const MEMORY_ID = "10000000-0000-4000-8000-000000000001";
export const DESTINATION_ID = "20000000-0000-4000-8000-000000000001";
export const NEW_DESTINATION_ID = "20000000-0000-4000-8000-000000000002";
export const MEMORY_DATE = "2026-01-10T12:00:00.000Z";

export function memoryEntry(patch: Partial<SharedMemoryEntry> = {}): SharedMemoryEntry {
  return {
    id: MEMORY_ID,
    key: "orion.release-process",
    itemId: "30000000-0000-4000-8000-000000000001",
    sourceOrgId: ORG_ID,
    title: "Release review",
    content: "A release needs two reviewers.",
    kind: "fact",
    status: "active",
    readable: true,
    blockedReason: null,
    version: 7,
    itemVersion: 4,
    sensitivity: "workspace",
    assertion: "owner_correction",
    originId: "source:review",
    sourceId: "source-1",
    sourceIds: ["native-source-note"],
    sourceRevision: "1",
    observedAt: null,
    recordedAt: MEMORY_DATE,
    validFrom: null,
    validTo: null,
    forgottenAt: null,
    externalOutstanding: [],
    replicas: [
      {
        orgId: DESTINATION_ID,
        itemId: "30000000-0000-4000-8000-000000000002",
        state: "current",
        appliedVersion: 7,
        checkedAt: MEMORY_DATE,
        reason: null,
      },
    ],
    history: [
      {
        itemId: "30000000-0000-4000-8000-000000000003",
        version: 3,
        title: "Earlier release review",
        content: "A release needs one reviewer.",
        status: "archived",
        recordedAt: "2026-01-08T12:00:00.000Z",
      },
    ],
    ...patch,
  };
}

export function memorySnapshot(): SharedMemorySnapshot {
  return {
    profile: {
      id: "40000000-0000-4000-8000-000000000001",
      name: "Orion memory",
      ownerUserId: "owner",
      canonicalOrgId: ORG_ID,
      version: 3,
      availabilityRevision: "availability-fixture-1",
      updatedAt: MEMORY_DATE,
    },
    canManage: true,
    entries: [memoryEntry()],
    candidates: [
      memoryEntry({
        id: "10000000-0000-4000-8000-000000000002",
        title: "Release day suggestion",
        content: "The agent inferred that releases happen on Fridays.",
        status: "candidate",
        assertion: "inference",
        version: 2,
        replicas: [],
        history: [],
      }),
    ],
    destinations: [
      {
        orgId: DESTINATION_ID,
        name: "Research workspace",
        enabled: true,
        state: "active",
        allowedSensitivity: ["workspace"],
        lastSyncedAt: MEMORY_DATE,
        reason: null,
        current: 1,
        pending: 0,
        conflicts: 0,
      },
    ],
    sources: [
      {
        id: "source-1",
        name: "Review notes",
        provider: "file",
        reference: "https://example.com/review",
        originId: "source:review",
        revision: "1",
        capturedAt: MEMORY_DATE,
        observedAt: null,
        refreshAfter: null,
        coverage: "Two review notes read in full",
        recordCount: 2,
        status: "snapshot",
      },
    ],
    consumers: [
      {
        id: "claude",
        name: "Claude",
        kind: "claude",
        status: "snapshot",
        revision: 2,
        checkedAt: MEMORY_DATE,
        reason: null,
        writable: false,
      },
    ],
    verification: {
      status: "not_run",
      checkedAt: null,
      runId: null,
      verifiedEntryIds: [],
      missingEntryIds: [],
      detail: "",
    },
    availableItems: [],
    eligibleDestinations: [{ orgId: NEW_DESTINATION_ID, name: "Studio workspace" }],
    pagination: { nextCursor: null, complete: true, total: 2 },
    graph: {
      nodes: [
        { id: "entry-1", kind: "entry", label: "Release review", entryId: MEMORY_ID },
        { id: "source-1", kind: "source", label: "Review notes", sourceId: "source-1" },
        { id: "workspace-1", kind: "workspace", label: "Research workspace", orgId: DESTINATION_ID },
      ],
      edges: [
        { from: "entry-1", to: "source-1", kind: "derived_from" },
        { from: "entry-1", to: "workspace-1", kind: "replicated_to" },
      ],
    },
  };
}

export function sharedMemoryFixture() {
  const state = { snapshot: memorySnapshot() };
  const writes: SharedMemoryAction[] = [];
  const api = createFakeApi(seedState());
  api.sharedMemory = {
    mem0Readiness: async () => ({
      provider: "mem0",
      readiness: "disabled",
      configured: false,
      mode: "synthetic_only",
      privateProjectionEnabled: false,
      canEvaluate: true,
    }),
    mem0Latest: async () => ({ report: null, checkpoint: null }),
    evaluateMem0: async () => {
      throw new Error("Evaluation is not configured in this fixture");
    },
    snapshot: async () => structuredClone(state.snapshot),
    act: async (_orgId, action) => {
      writes.push(action);
      return { snapshot: structuredClone(state.snapshot), action: { state: "applied" } };
    },
  };
  return { api, state, writes };
}
