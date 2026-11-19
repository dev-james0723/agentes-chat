import { expect, test } from "bun:test";
import { createRequester } from "../src/api/http";
import {
  filterMemoryGraph,
  layoutMemoryGraph,
  type MemoryGraph,
  memorySourceHref,
} from "../src/lib/shared-memory-graph";
import { createSharedMemoryApi } from "../src/shared-memory/api";
import { availableMemoryConsumerStatus, availableMemoryVerification } from "../src/shared-memory/availability";
import { mergeSharedMemoryPages } from "../src/shared-memory/hooks";
import type { SharedMemoryConsumer, SharedMemorySnapshot } from "../src/shared-memory/types";

const graph: MemoryGraph = {
  nodes: [
    { id: "fact", kind: "entry", label: "Release policy", entryId: "entry" },
    { id: "source", kind: "source", label: "Review notes", sourceId: "s" },
    { id: "workspace", kind: "workspace", label: "Research" },
  ],
  edges: [
    { from: "fact", to: "source", kind: "derived_from" },
    { from: "fact", to: "workspace", kind: "replicated_to" },
    { from: "missing", to: "fact", kind: "conflicts_with" },
  ],
};

test("graph filtering preserves only recorded connections and one-hop evidence", () => {
  expect(filterMemoryGraph(graph, "Review notes", "all")).toEqual({
    nodes: graph.nodes.slice(0, 2),
    edges: graph.edges.slice(0, 1),
  });
  expect(filterMemoryGraph(graph, "absent", "all")).toEqual({ nodes: [], edges: [] });
  expect(filterMemoryGraph(graph, "", "all").edges).toEqual(graph.edges.slice(0, 2));
});

test("layout includes complete long labels and is stable across input order", () => {
  const long = {
    ...graph,
    nodes: [...graph.nodes, { id: "long", kind: "entry" as const, label: "Long label ".repeat(100) }],
  };
  const layout = layoutMemoryGraph(long);
  const reversed = layoutMemoryGraph({ ...long, nodes: [...long.nodes].reverse() });
  expect([...layout.positions]).toEqual([...reversed.positions]);
  expect(layout.positions.get("long")?.height).toBeGreaterThan(1000);
  expect(layout.height).toBeGreaterThan(layout.positions.get("long")?.height ?? 0);
});

test("source data never becomes a script, credentials URL or protocol-relative link", () => {
  for (const href of [
    "javascript:alert(1)",
    "data:text/html,hello",
    "//outside.example/private",
    "https://user:pass@example.com",
    "file:///private/source",
    "/\\outside.example",
    "https://example.com\n/secret",
  ])
    expect(memorySourceHref(href)).toBeNull();
  expect(memorySourceHref("/org/example/wiki?source=one")).toBe("/org/example/wiki?source=one");
  expect(memorySourceHref("https://example.com/source")).toBe("https://example.com/source");
});

test("HTTP memory actions use the existing same-origin JSON transport and preserve the control fence", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const request = createRequester({
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ action: { state: "applied" } }), {
        headers: { "content-type": "application/json" },
      });
    },
  });
  const api = createSharedMemoryApi(request);
  await api.act("org/one", { type: "forget", entryId: "entry-1", expectedVersion: 7, scope: "profile" });
  expect(calls[0]?.url).toBe("/api/app/organizations/org%2Fone/shared-memory/actions");
  expect(calls[0]?.init.credentials).toBe("same-origin");
  expect(JSON.parse(calls[0]?.init.body as string)).toEqual({
    type: "forget",
    entryId: "entry-1",
    expectedVersion: 7,
    scope: "profile",
  });
});

test("page merging replaces a candidate with its newer active revision and never crosses profiles", () => {
  const page = {
    profile: { id: "profile-1" },
    entries: [],
    candidates: [{ id: "entry", status: "candidate", version: 1 }],
    graph: { nodes: [], edges: [] },
    pagination: { complete: false, nextCursor: "two", total: 1 },
  } as unknown as SharedMemorySnapshot;
  const later = {
    ...page,
    candidates: [],
    entries: [{ id: "entry", status: "active", version: 2 }],
    pagination: { complete: true, nextCursor: null, total: 1 },
  } as unknown as SharedMemorySnapshot;
  const other = {
    ...later,
    profile: { id: "profile-2" },
    entries: [{ id: "private", status: "active", version: 99 }],
  } as unknown as SharedMemorySnapshot;
  const merged = mergeSharedMemoryPages([page, later]);
  expect(merged?.entries.map((entry) => entry.id)).toEqual(["entry"]);
  expect(merged?.candidates).toEqual([]);
  expect(mergeSharedMemoryPages([page, later, other])).toBeUndefined();
});

test("pagination never presents mixed profile revisions as complete", () => {
  const page = {
    profile: { id: "profile-1", version: 3 },
    entries: [{ id: "known", status: "active", version: 1 }],
    candidates: [],
    graph: { nodes: [], edges: [] },
    pagination: { complete: false, nextCursor: "two", total: 2 },
  } as unknown as SharedMemorySnapshot;
  const later = {
    ...page,
    profile: { ...page.profile, version: 4 },
    entries: [{ id: "changed", status: "active", version: 1 }],
    pagination: { complete: true, nextCursor: null, total: 2 },
  } as unknown as SharedMemorySnapshot;
  const merged = mergeSharedMemoryPages([page, later]);
  expect(merged).toBeUndefined();
});

test("availability-only pagination changes discard all prior bodies and receipts", () => {
  const before = {
    profile: { id: "profile-1", version: 3, availabilityRevision: "before" },
    entries: [{ id: "entry", status: "active", version: 7, readable: true, content: "Old body" }],
    candidates: [],
    graph: { nodes: [], edges: [] },
    consumers: [{ id: "file", status: "current" }],
    pagination: { complete: false, nextCursor: "next", total: 1 },
  } as unknown as SharedMemorySnapshot;
  const after = {
    ...before,
    profile: { ...before.profile, availabilityRevision: "after" },
    entries: [],
    pagination: { complete: true, nextCursor: null, total: 1 },
  } as unknown as SharedMemorySnapshot;
  expect(mergeSharedMemoryPages([before, after])).toBeUndefined();
});

test("file receipts require a matching availability digest and unavailable records are never verified", () => {
  const profile = { id: "profile", version: 3, availabilityRevision: "current" } as NonNullable<
    SharedMemorySnapshot["profile"]
  >;
  const consumer = { kind: "file", status: "current", revision: 3 } as SharedMemoryConsumer;
  expect(availableMemoryConsumerStatus(consumer, profile)).toBe("pending");
  expect(availableMemoryConsumerStatus({ ...consumer, availabilityRevision: "old" }, profile)).toBe("pending");
  expect(availableMemoryConsumerStatus({ ...consumer, availabilityRevision: "current" }, profile)).toBe("current");
  const snapshot = {
    entries: [{ id: "entry", status: "active", readable: false }],
    pagination: { complete: true },
    verification: {
      status: "passed",
      verifiedEntryIds: ["entry"],
      missingEntryIds: [],
      detail: "Old successful receipt",
    },
  } as unknown as SharedMemorySnapshot;
  expect(availableMemoryVerification(snapshot)).toMatchObject({ status: "not_run", verifiedEntryIds: [], detail: "" });
});
