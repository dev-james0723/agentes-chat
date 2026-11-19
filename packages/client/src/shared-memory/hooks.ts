import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { useApi } from "../api/context";
import { ApiError } from "../api/http";
import { sameSharedMemoryRevision } from "./availability";
import type { SharedMemoryAction, SharedMemorySnapshot } from "./types";

export const sharedMemoryKey = (orgId: string) => ["shared-memory", orgId] as const;

/** Deduplicate page boundaries without dropping a newer control revision. */
export function mergeSharedMemoryPages(pages: SharedMemorySnapshot[]): SharedMemorySnapshot | undefined {
  const first = pages[0];
  if (!first) return undefined;
  const entries = new Map<string, SharedMemorySnapshot["entries"][number]>();
  const candidates = new Map<string, SharedMemorySnapshot["candidates"][number]>();
  const nodes = new Map<string, SharedMemorySnapshot["graph"]["nodes"][number]>();
  const edges = new Map<string, SharedMemorySnapshot["graph"]["edges"][number]>();
  let pagination = first.pagination;
  for (const page of pages) {
    // Never mix one person's profile with another one after an account or workspace change.
    if (!sameSharedMemoryRevision(first.profile, page.profile)) {
      return undefined;
    }
    pagination = page.pagination;
    for (const entry of [...page.entries, ...page.candidates]) {
      const target = entry.status === "candidate" || entry.status === "disputed" ? candidates : entries;
      const other = target === entries ? candidates : entries;
      if ((target.get(entry.id)?.version ?? other.get(entry.id)?.version ?? 0) > entry.version) continue;
      other.delete(entry.id);
      target.set(entry.id, entry);
    }
    for (const node of page.graph.nodes) nodes.set(node.id, node);
    for (const edge of page.graph.edges) edges.set(JSON.stringify([edge.from, edge.to, edge.kind]), edge);
  }
  return {
    ...first,
    entries: [...entries.values()],
    candidates: [...candidates.values()],
    pagination,
    graph: { nodes: [...nodes.values()], edges: [...edges.values()] },
  };
}

export function useSharedMemory(orgId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  const restarts = useRef(0);
  const restartScan = useCallback(() => {
    restarts.current = 0;
    return queryClient.resetQueries({ queryKey: sharedMemoryKey(orgId), exact: true });
  }, [queryClient, orgId]);
  const query = useInfiniteQuery({
    queryKey: sharedMemoryKey(orgId),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      if (!api.sharedMemory)
        throw new ApiError(501, "shared_memory_unavailable", "Memory is unavailable on this server");
      return api.sharedMemory.snapshot(orgId, { cursor: pageParam, limit: 200 });
    },
    getNextPageParam: (last, _pages, _lastParam, params) =>
      last.pagination.complete || !last.pagination.nextCursor || params.includes(last.pagination.nextCursor)
        ? undefined
        : last.pagination.nextCursor,
    enabled: Boolean(orgId),
    staleTime: 10_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    gcTime: 0,
  });
  const pages = query.data?.pages ?? [];
  const firstProfile = pages[0]?.profile;
  const pageRevisionChanged = pages.some((page) => !sameSharedMemoryRevision(firstProfile, page.profile));
  useEffect(() => {
    if (pageRevisionChanged && !query.isFetching && restarts.current < 3) {
      restarts.current += 1;
      void queryClient.resetQueries({ queryKey: sharedMemoryKey(orgId), exact: true });
      return;
    }
    if (!pageRevisionChanged && !query.isFetching && pages.at(-1)?.pagination.complete) restarts.current = 0;
    if (query.hasNextPage && !query.isFetching && !query.isError && !pageRevisionChanged) void query.fetchNextPage();
  }, [
    query.hasNextPage,
    query.isFetching,
    query.isError,
    query.fetchNextPage,
    pageRevisionChanged,
    queryClient,
    orgId,
    pages,
  ]);
  return {
    ...query,
    restartScan,
    pageRevisionChanged,
    // A mixed scan cannot support old "current" or "passed" receipts while it restarts.
    snapshot: pageRevisionChanged ? undefined : mergeSharedMemoryPages(pages),
  };
}

export function useSharedMemoryAction(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: SharedMemoryAction) => {
      if (!api.sharedMemory)
        throw new ApiError(501, "shared_memory_unavailable", "Memory is unavailable on this server");
      return api.sharedMemory.act(orgId, action);
    },
    retry: false,
    meta: { silent: true },
    gcTime: 0,
    onSuccess: (result) => {
      // Replace old pages at once, including forgotten text. A receipt never proves a consumer retrieved it.
      qc.setQueryData(sharedMemoryKey(orgId), { pages: [result.snapshot], pageParams: [null] });
      void qc.invalidateQueries({ queryKey: ["shared-memory"] });
    },
  });
}

export function useSharedMemoryMem0(orgId: string) {
  const api = useApi();
  return useQuery({
    queryKey: ["shared-memory-mem0", orgId],
    queryFn: () => {
      if (!api.sharedMemory?.mem0Readiness)
        throw new ApiError(501, "shared_memory_unavailable", "Evaluation is unavailable on this server");
      return api.sharedMemory.mem0Readiness(orgId);
    },
    gcTime: 0,
    staleTime: 30_000,
  });
}

export function useEvaluateSharedMemoryMem0(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => {
      if (!api.sharedMemory?.evaluateMem0)
        throw new ApiError(501, "shared_memory_unavailable", "Evaluation is unavailable on this server");
      return api.sharedMemory.evaluateMem0(orgId);
    },
    retry: false,
    gcTime: 0,
    meta: { silent: true },
    onSuccess: (report) => {
      qc.setQueryData(["shared-memory-mem0-latest", orgId], { report, checkpoint: null });
      void qc.invalidateQueries({ queryKey: ["shared-memory"] });
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ["shared-memory-mem0-latest", orgId] }),
  });
}

export function useSharedMemoryMem0Latest(orgId: string) {
  const api = useApi();
  return useQuery({
    queryKey: ["shared-memory-mem0-latest", orgId],
    queryFn: () => {
      if (!api.sharedMemory?.mem0Latest)
        throw new ApiError(501, "shared_memory_unavailable", "Saved evaluation is unavailable on this server");
      return api.sharedMemory.mem0Latest(orgId);
    },
    gcTime: 0,
    staleTime: 5_000,
    refetchInterval: 10_000,
  });
}
