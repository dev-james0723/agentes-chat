import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { ApiError, type SharedMemoryAction, type SharedMemoryMem0Report, sharedMemoryKey } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { SharedMemoryPage } from "@/pages/SharedMemoryPage";
import { ORG_ID } from "./fake-api";
import { renderApp, renderPage, screen, settle, showIn } from "./render";
import { MEMORY_ID, memoryEntry, NEW_DESTINATION_ID, sharedMemoryFixture } from "./shared-memory-fixture";

afterEach(cleanup);
function first<T>(values: T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}
async function click(element: Element) {
  await act(async () => {
    if (element.getAttribute("role") === "tab") fireEvent.mouseDown(element, { button: 0 });
    else fireEvent.click(element);
  });
  await settle(4);
}
async function change(element: Element, value: string) {
  await act(async () => fireEvent.change(element, { target: { value } }));
  await settle(2);
}
async function page(f = sharedMemoryFixture()) {
  const rendered = await renderPage(<SharedMemoryPage />, { api: f.api, org: true });
  await showIn(rendered.services, "en");
  await settle(5);
  return { ...f, ...rendered };
}

test("the portal is discoverable in the real organization navigation", async () => {
  const f = sharedMemoryFixture();
  const rendered = await renderApp(`/org/${ORG_ID}/shared-memory`, { api: f.api });
  await showIn(rendered.services, "en");
  await settle(5);
  expect(screen().getByRole("heading", { name: "My memory", level: 1 })).toBeTruthy();
  expect(screen().getByRole("link", { name: "My memory" }).getAttribute("href")).toContain("/shared-memory");
});

test("a correction retains its opening revision after refresh and keeps a rejected draft", async () => {
  const f = sharedMemoryFixture();
  const writes: SharedMemoryAction[] = [];
  if (!f.api.sharedMemory) throw new Error("Missing memory API");
  f.api.sharedMemory.act = async (_orgId, action) => {
    writes.push(action);
    throw new ApiError(409, "shared_memory.version_conflict", "Memory changed");
  };
  const rendered = await page(f);
  await click(screen().getByRole("button", { name: "Read memory" }));
  await click(screen().getByRole("button", { name: "Correct memory" }));
  await change(screen().getByRole("textbox", { name: "Memory" }), "A release needs three reviewers.");
  f.state.snapshot.entries[0] = { ...first(f.state.snapshot.entries), version: 8, content: "A concurrent correction." };
  await act(async () => {
    await rendered.services.queryClient.invalidateQueries({ queryKey: sharedMemoryKey(ORG_ID) });
  });
  await settle(4);
  await click(screen().getByRole("button", { name: "Save correction" }));
  expect(writes).toEqual([
    {
      type: "correct",
      entryId: MEMORY_ID,
      expectedVersion: 7,
      title: "Release review",
      content: "A release needs three reviewers.",
    },
  ]);
  expect((screen().getByRole("textbox", { name: "Memory" }) as HTMLTextAreaElement).value).toBe(
    "A release needs three reviewers.",
  );
  expect(screen().getByRole("alert").textContent).toContain("Your draft is kept");
});

test("candidate decisions are explicit and include the displayed revision", async () => {
  const f = await page();
  await click(screen().getByRole("tab", { name: /Review/ }));
  expect(screen().getByText("Agent inference")).toBeTruthy();
  await click(screen().getByRole("button", { name: "Accept memory" }));
  expect(f.writes).toEqual([
    { type: "decide", entryId: first(f.state.snapshot.candidates).id, expectedVersion: 2, decision: "accept" },
  ]);
});

test("forget records a scoped operation and removes old body from the displayed cache", async () => {
  const f = sharedMemoryFixture();
  if (!f.api.sharedMemory) throw new Error("Missing API");
  f.api.sharedMemory.act = async (_org, action) => {
    f.writes.push(action);
    f.state.snapshot.entries[0] = {
      ...first(f.state.snapshot.entries),
      status: "forgotten",
      content: "",
      history: [],
      version: 8,
      forgottenAt: "2026-01-12T12:00:00Z",
      externalOutstanding: ["Claude"],
    };
    return { snapshot: structuredClone(f.state.snapshot), action: { state: "queued" } };
  };
  await page(f);
  await click(screen().getByRole("button", { name: "Read memory" }));
  await click(screen().getByRole("button", { name: "Forget memory" }));
  expect(screen().getByText(/Source archives and external imports/)).toBeTruthy();
  await click(screen().getByRole("button", { name: "Forget in selected destinations" }));
  expect(f.writes).toEqual([{ type: "forget", entryId: MEMORY_ID, expectedVersion: 7, scope: "profile" }]);
  expect(screen().queryByText("A release needs two reviewers.")).toBeNull();
  expect(screen().getByText(/Change queued/)).toBeTruthy();
  await click(screen().getByRole("tab", { name: "History" }));
  expect(screen().getByText(/Still needs removal: Claude/)).toBeTruthy();
});

test("blocked writes keep the dialog open and show the server reason", async () => {
  const f = sharedMemoryFixture();
  if (!f.api.sharedMemory) throw new Error("Missing API");
  f.api.sharedMemory.act = async () => ({
    snapshot: f.state.snapshot,
    action: { state: "blocked", reason: "The source is no longer readable." },
  });
  await page(f);
  await click(screen().getByRole("button", { name: "Read memory" }));
  await click(screen().getByRole("button", { name: "Forget memory" }));
  await click(screen().getByRole("button", { name: "Forget in selected destinations" }));
  expect(within(screen().getByRole("dialog")).getByRole("alert").textContent).toContain("source is no longer readable");
});

test("enrolling a workspace defaults to work scope, never all personal data", async () => {
  const f = await page();
  await click(screen().getByRole("tab", { name: "Privacy" }));
  await click(screen().getByRole("button", { name: "Enroll workspace" }));
  const dialog = within(screen().getByRole("dialog"));
  expect(dialog.getByRole("checkbox", { name: "Work" }).getAttribute("aria-checked")).toBe("true");
  expect(dialog.getByRole("checkbox", { name: "Personal" }).getAttribute("aria-checked")).toBe("false");
  expect(dialog.getByRole("checkbox", { name: "Sensitive" }).getAttribute("aria-checked")).toBe("false");
  await click(dialog.getByRole("button", { name: "Save sharing choices" }));
  expect(f.writes).toEqual([
    { type: "destination", orgId: NEW_DESTINATION_ID, enabled: true, allowedSensitivity: ["workspace"] },
  ]);
});

test("sync receipts and one-time consumer imports do not claim retrieval verification", async () => {
  await page();
  await click(screen().getByRole("tab", { name: "Sync" }));
  expect(screen().getByText("One-time snapshot")).toBeTruthy();
  expect(screen().getByText("No continuous write connection")).toBeTruthy();
  expect(screen().queryByText("Verified for this run")).toBeNull();
  expect(screen().getAllByText("Not verified").length).toBeGreaterThan(0);
});

test("the graph uses actual connections, supports search and has an equivalent list", async () => {
  await page();
  await click(screen().getByRole("tab", { name: "Graph" }));
  expect(screen().getByText("3 nodes · 2 connections")).toBeTruthy();
  await click(screen().getByRole("button", { name: "Zoom in" }));
  expect(screen().getByText("Zoom 100%")).toBeTruthy();
  await change(screen().getByRole("searchbox", { name: "Find a graph node" }), "does not exist");
  expect(screen().getByText(/No source-backed connections/)).toBeTruthy();
  await click(screen().getByRole("button", { name: "Clear search" }));
  await click(screen().getByRole("button", { name: "Show connection list" }));
  expect(screen().getByText("Has source")).toBeTruthy();
  expect(screen().getByText("Copied to")).toBeTruthy();
});

test("owner-only denial renders no memory content or mutation buttons", async () => {
  const f = sharedMemoryFixture();
  f.state.snapshot.canManage = false;
  f.state.snapshot.profile = null;
  f.state.snapshot.entries = [];
  f.state.snapshot.candidates = [];
  await page(f);
  expect(screen().getByText(/not available to your account/)).toBeTruthy();
  expect(screen().queryByText("Release review")).toBeNull();
  expect(screen().queryByRole("button", { name: "Create my memory" })).toBeNull();
});

test("worst-case long titles remain complete in cards, details and graph", async () => {
  const f = sharedMemoryFixture();
  const title = "International release coordination and accessibility evidence ".repeat(8);
  first(f.state.snapshot.entries).title = title;
  first(f.state.snapshot.graph.nodes).label = title;
  const rendered = await page(f);
  expect(screen().getByRole("heading", { level: 2, name: title.trim() })).toBeTruthy();
  await click(screen().getByRole("button", { name: "Read memory" }));
  expect(screen().getByRole("dialog").textContent).toContain(title.trim());
  await click(first(within(screen().getByRole("dialog")).getAllByRole("button", { name: "Close" })));
  await click(screen().getByRole("tab", { name: "Graph" }));
  await showIn(rendered.services, "de");
  expect(document.querySelector(".sm-graph__node strong")?.textContent).toBeTruthy();
});

test("pagination follows every cursor before presenting a complete graph and count", async () => {
  const f = sharedMemoryFixture();
  if (!f.api.sharedMemory) throw new Error("Missing API");
  const calls: (string | null | undefined)[] = [];
  const next = memoryEntry({ id: "10000000-0000-4000-8000-000000000004", title: "Escalation owner" });
  f.api.sharedMemory.snapshot = async (_orgId, options) => {
    calls.push(options?.cursor);
    if (!options?.cursor)
      return { ...structuredClone(f.state.snapshot), pagination: { complete: false, nextCursor: "page-2", total: 3 } };
    return {
      ...structuredClone(f.state.snapshot),
      entries: [next],
      candidates: [],
      pagination: { complete: true, nextCursor: null, total: 3 },
      graph: {
        nodes: [{ id: "entry-2", kind: "entry", label: next.title, entryId: next.id }],
        edges: [{ from: "entry-2", to: "source-1", kind: "derived_from" }],
      },
    };
  };
  await page(f);
  await settle(5);
  expect(calls).toContain("page-2");
  expect(screen().getByRole("heading", { name: "Escalation owner" })).toBeTruthy();
  expect(screen().queryByText(/cover only the records loaded/)).toBeNull();
  await click(screen().getByRole("tab", { name: "Graph" }));
  expect(screen().getByText("4 nodes · 3 connections")).toBeTruthy();
});

test("Mem0 readiness never exposes a key or offers evaluation to an ineligible account", async () => {
  const f = sharedMemoryFixture();
  if (!f.api.sharedMemory) throw new Error("Missing API");
  f.api.sharedMemory.mem0Readiness = async () => ({
    provider: "mem0",
    readiness: "configured_unverified",
    configured: true,
    mode: "synthetic_only",
    privateProjectionEnabled: false,
    canEvaluate: false,
  });
  await page(f);
  await click(screen().getByRole("tab", { name: "Sync" }));
  expect(screen().getByText("Configured, not verified")).toBeTruthy();
  expect(screen().getByText("Only the installation owner can run this evaluation.")).toBeTruthy();
  expect(screen().queryByRole("button", { name: "Run synthetic evaluation" })).toBeNull();
});

test("a changing paginated profile restarts at page one and discards old receipts", async () => {
  const f = sharedMemoryFixture();
  if (!f.api.sharedMemory) throw new Error("Missing API");
  let starts = 0;
  f.api.sharedMemory.snapshot = async (_org, options) => {
    const snapshot = structuredClone(f.state.snapshot);
    if (!snapshot.profile) throw new Error("Missing profile");
    if (!options?.cursor) starts++;
    if (starts === 1 && !options?.cursor) {
      snapshot.verification.status = "passed";
      snapshot.pagination = { complete: false, nextCursor: "changed-page", total: 3 };
      return snapshot;
    }
    snapshot.profile.version++;
    snapshot.entries = [memoryEntry({ title: "Fresh revision only" })];
    snapshot.candidates = [];
    return snapshot;
  };
  await page(f);
  await settle(10);
  expect(starts).toBe(2);
  expect(screen().getByRole("heading", { name: "Fresh revision only" })).toBeTruthy();
  expect(screen().queryByText("Release review")).toBeNull();
  expect(screen().queryByText("Verified for this run")).toBeNull();
});

test("availability-only changes clear the previous snapshot while pagination restarts", async () => {
  const f = sharedMemoryFixture();
  if (!f.api.sharedMemory) throw new Error("Missing API");
  let starts = 0;
  const restart: { finish: () => void } = {
    finish: () => {
      throw new Error("Restart did not start");
    },
  };
  f.api.sharedMemory.snapshot = async (_org, options) => {
    const snapshot = structuredClone(f.state.snapshot);
    if (!snapshot.profile) throw new Error("Missing profile");
    if (!options?.cursor) starts++;
    if (starts === 1 && !options?.cursor) {
      snapshot.verification.status = "passed";
      snapshot.verification.verifiedEntryIds = [MEMORY_ID];
      snapshot.pagination = { complete: false, nextCursor: "availability-changed", total: 3 };
      return snapshot;
    }
    snapshot.profile.availabilityRevision = "withdrawn-source";
    snapshot.entries[0] = {
      ...first(snapshot.entries),
      readable: false,
      blockedReason: "Source access was withdrawn",
      itemId: null,
      itemVersion: null,
    };
    if (starts === 1) return snapshot;
    return new Promise((resolve) => {
      restart.finish = () => resolve(snapshot);
    });
  };
  await page(f);
  await settle(8);
  expect(starts).toBe(2);
  expect(screen().queryByText("Release review")).toBeNull();
  expect(screen().queryByText("Verified for this run")).toBeNull();
  await act(async () => restart.finish());
  await settle(5);
  expect(screen().getByText("Source access was withdrawn")).toBeTruthy();
  expect(screen().queryByText("Release review")).toBeNull();
});

test("blocked records have no current or retrieval claims and keep safe owner forgetting", async () => {
  const f = sharedMemoryFixture();
  const entry = first(f.state.snapshot.entries);
  entry.readable = false;
  entry.blockedReason = "Source access was withdrawn";
  entry.itemId = null;
  entry.itemVersion = null;
  f.state.snapshot.verification.status = "passed";
  f.state.snapshot.verification.verifiedEntryIds = [entry.id];
  const candidate = first(f.state.snapshot.candidates);
  candidate.readable = false;
  candidate.blockedReason = "Candidate source is unavailable";
  f.state.snapshot.consumers = [
    {
      id: "local-export",
      name: "Local files",
      kind: "file",
      status: "current",
      revision: f.state.snapshot.profile?.version ?? 3,
      availabilityRevision: "older-source-state",
      checkedAt: "2026-01-10T12:00:00Z",
      reason: null,
      writable: false,
    },
  ];
  await page(f);
  const card = screen().getByRole("article");
  expect(within(card).getByRole("heading", { name: "Blocked" })).toBeTruthy();
  expect(within(card).queryByText("Current")).toBeNull();
  expect(screen().getByText("Current memories").parentElement?.querySelector("strong")?.textContent).toBe("0");
  expect(screen().queryByText("Verified for this run")).toBeNull();
  await click(screen().getByRole("button", { name: "Read memory" }));
  const dialog = screen().getByRole("dialog");
  expect(dialog.textContent).toContain("Source access was withdrawn");
  expect(dialog.textContent).not.toContain("A release needs two reviewers.");
  expect(dialog.textContent).not.toContain("A release needs one reviewer.");
  expect(within(dialog).queryByRole("button", { name: "Correct memory" })).toBeNull();
  await click(within(dialog).getByRole("button", { name: "Forget memory" }));
  await click(screen().getByRole("button", { name: "Forget in selected destinations" }));
  expect(f.writes).toEqual([{ type: "forget", entryId: MEMORY_ID, expectedVersion: 7, scope: "profile" }]);
  await click(screen().getByRole("tab", { name: "Sync" }));
  expect((screen().getByRole("button", { name: "Check a completed run" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen().queryByText("Found: 1")).toBeNull();
  expect(screen().queryByText("Current receipt")).toBeNull();
  expect(screen().getByText("Pending")).toBeTruthy();
  await click(screen().getByRole("tab", { name: /Review/ }));
  expect((screen().getByRole("button", { name: "Accept memory" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen().getByRole("button", { name: "Reject suggestion" }) as HTMLButtonElement).disabled).toBe(false);
  await click(screen().getByRole("button", { name: "Reject suggestion" }));
  expect(f.writes.at(-1)).toEqual({
    type: "decide",
    entryId: candidate.id,
    expectedVersion: candidate.version,
    decision: "reject",
  });
});

test("withdrawal clears an open editor and removes a previously selected verification entry", async () => {
  const f = sharedMemoryFixture();
  const other = memoryEntry({ id: "10000000-0000-4000-8000-000000000005", title: "Available policy" });
  f.state.snapshot.entries.push(other);
  const rendered = await page(f);
  await click(first(screen().getAllByRole("button", { name: "Read memory" })));
  await click(screen().getByRole("button", { name: "Correct memory" }));
  first(f.state.snapshot.entries).readable = false;
  first(f.state.snapshot.entries).blockedReason = "Withdrawn while editing";
  if (f.state.snapshot.profile) f.state.snapshot.profile.availabilityRevision = "withdrawn-during-edit";
  await act(async () => rendered.services.queryClient.invalidateQueries({ queryKey: sharedMemoryKey(ORG_ID) }));
  await settle(5);
  expect(screen().queryByRole("textbox", { name: "Memory" })).toBeNull();
  expect(screen().getByRole("dialog").textContent).toContain("Withdrawn while editing");
  expect(screen().getByRole("dialog").textContent).not.toContain("A release needs two reviewers.");
  first(f.state.snapshot.entries).readable = true;
  first(f.state.snapshot.entries).content = "The restored source has a new readable body.";
  if (f.state.snapshot.profile) f.state.snapshot.profile.availabilityRevision = "restored-after-edit";
  await act(async () => rendered.services.queryClient.invalidateQueries({ queryKey: sharedMemoryKey(ORG_ID) }));
  await settle(5);
  expect(screen().queryByRole("textbox", { name: "Memory" })).toBeNull();
  expect(screen().getByRole("dialog").textContent).toContain("The restored source has a new readable body.");
  first(f.state.snapshot.entries).readable = false;
  if (f.state.snapshot.profile) f.state.snapshot.profile.availabilityRevision = "withdrawn-again";
  await act(async () => rendered.services.queryClient.invalidateQueries({ queryKey: sharedMemoryKey(ORG_ID) }));
  await settle(5);
  await click(first(within(screen().getByRole("dialog")).getAllByRole("button", { name: "Close" })));
  await click(screen().getByRole("tab", { name: "Sync" }));
  await click(screen().getByRole("button", { name: "Check a completed run" }));
  expect(screen().queryByRole("checkbox", { name: "Release review" })).toBeNull();
  await click(screen().getByRole("checkbox", { name: "Available policy" }));
  await change(screen().getByRole("textbox", { name: "Completed run ID" }), "40000000-0000-4000-8000-000000000002");
  other.readable = false;
  other.blockedReason = "Withdrawn during verification";
  if (f.state.snapshot.profile) f.state.snapshot.profile.availabilityRevision = "withdrawn-during-verify";
  await act(async () => rendered.services.queryClient.invalidateQueries({ queryKey: sharedMemoryKey(ORG_ID) }));
  await settle(5);
  expect(screen().queryByRole("checkbox", { name: "Available policy" })).toBeNull();
  expect((screen().getByRole("button", { name: "Verify retrieval" }) as HTMLButtonElement).disabled).toBe(true);
  expect(f.writes).toEqual([]);
});

test("saved Mem0 evidence survives reload and an unfinished attempt cannot claim the previous pass", async () => {
  const f = sharedMemoryFixture();
  if (!f.api.sharedMemory) throw new Error("Missing API");
  let evaluations = 0;
  const report: SharedMemoryMem0Report = {
    provider: "mem0",
    suite: "synthetic_projection_v1",
    evidenceMode: "injected_transport",
    readiness: {
      provider: "mem0",
      readiness: "configured_unverified",
      configured: true,
      mode: "synthetic_only",
      privateProjectionEnabled: false,
    },
    status: "passed",
    providerVerified: false,
    nativeAuthority: true,
    privateMemoriesSent: false,
    modelAnswersTested: false,
    runId: "completed-run",
    observedAt: "2026-01-10T12:00:00Z",
    cases: [],
    totals: { passed: 1, failed: 0, unavailable: 0, skipped: 0 },
    metrics: { requests: 3, elapsedMs: 1000, searchP95Ms: 10, cost: null },
    cleanup: { status: "complete", deleted: 1, remainingIds: [], unresolvedOperations: [], eventIds: [], issues: [] },
  };
  f.api.sharedMemory.evaluateMem0 = async () => {
    evaluations++;
    return { ...report, status: "failed", runId: "new-terminal", observedAt: "2026-01-12T12:00:00Z" };
  };
  f.api.sharedMemory.mem0Readiness = async () => ({ ...report.readiness, canEvaluate: true });
  f.api.sharedMemory.mem0Latest = async () => ({
    report,
    checkpoint: {
      provider: "mem0",
      suite: "synthetic_projection_v1",
      runId: "unfinished-run",
      observedAt: "2026-01-11T12:00:00Z",
      sequence: 2,
      evidenceMode: "injected_transport",
      phase: "cleanup",
      providerVerified: false,
      privateMemoriesSent: false,
      modelAnswersTested: false,
      requests: 2,
      completedCases: 0,
      ownedMemoryIds: ["synthetic-only"],
      eventIds: [],
      unresolvedOperations: ["delete_pending"],
      cleanupDeleted: 0,
    },
  });
  await page(f);
  await click(screen().getByRole("tab", { name: "Sync" }));
  expect(screen().getByRole("heading", { name: "Previous completed evaluation" })).toBeTruthy();
  expect(screen().getByText(/has no confirmed completion/)).toBeTruthy();
  expect(screen().getByText("Test transport")).toBeTruthy();
  expect(evaluations).toBe(0);
  expect(document.querySelector("pre.sm-memory-text")?.textContent).toContain("delete_pending");
  await click(screen().getByRole("button", { name: "Run synthetic evaluation" }));
  expect(evaluations).toBe(1);
  expect(screen().getByText("Failed")).toBeTruthy();
  expect(document.querySelector("pre.sm-memory-text")?.textContent).toContain("new-terminal");
});

test("Mem0 synthetic result states its evidence limit and incomplete cleanup", async () => {
  const f = sharedMemoryFixture();
  if (!f.api.sharedMemory) throw new Error("Missing API");
  let evaluations = 0;
  const readiness = {
    provider: "mem0" as const,
    readiness: "configured_unverified" as const,
    configured: true,
    mode: "synthetic_only" as const,
    privateProjectionEnabled: false as const,
    canEvaluate: true,
  };
  f.api.sharedMemory.mem0Readiness = async () => readiness;
  f.api.sharedMemory.evaluateMem0 = async () => {
    evaluations++;
    return {
      provider: "mem0",
      suite: "synthetic_projection_v1",
      evidenceMode: "injected_transport",
      readiness,
      status: "partial",
      providerVerified: false,
      nativeAuthority: true,
      privateMemoriesSent: false,
      modelAnswersTested: false,
      runId: "synthetic-test",
      observedAt: "2026-01-10T12:00:00Z",
      cases: [],
      totals: { passed: 1, failed: 0, unavailable: 1, skipped: 0 },
      metrics: { requests: 4, elapsedMs: 1200, searchP95Ms: 20, cost: null },
      cleanup: {
        status: "incomplete",
        deleted: 1,
        remainingIds: ["synthetic"],
        unresolvedOperations: [],
        eventIds: [],
        issues: ["delete_pending"],
      },
    };
  };
  await page(f);
  await click(screen().getByRole("tab", { name: "Sync" }));
  await click(screen().getByRole("button", { name: "Run synthetic evaluation" }));
  expect(evaluations).toBe(1);
  expect(screen().getByText("Test transport")).toBeTruthy();
  expect(screen().getByText(/does not grade agent answers/)).toBeTruthy();
  expect(screen().getByRole("alert").textContent).toContain("still need cleanup");
  expect(screen().queryByText("Verified for this run")).toBeNull();
});
