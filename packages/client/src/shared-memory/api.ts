import { enc, type Requester } from "../api/http";
import type {
  SharedMemoryAction,
  SharedMemoryActionResult,
  SharedMemoryMem0Latest,
  SharedMemoryMem0Readiness,
  SharedMemoryMem0Report,
  SharedMemorySnapshot,
} from "./types";

/** Personal memory controls. The server resolves the signed-in owner, including across workspaces. */
export interface SharedMemoryApi {
  snapshot(orgId: string, options?: { cursor?: string | null; limit?: number }): Promise<SharedMemorySnapshot>;
  act(orgId: string, action: SharedMemoryAction): Promise<SharedMemoryActionResult>;
  mem0Readiness(orgId: string): Promise<SharedMemoryMem0Readiness>;
  mem0Latest(orgId: string): Promise<SharedMemoryMem0Latest>;
  evaluateMem0(orgId: string): Promise<SharedMemoryMem0Report>;
}

export function createSharedMemoryApi(request: Requester): SharedMemoryApi {
  const base = (orgId: string) => `/api/app/organizations/${enc(orgId)}/shared-memory`;
  return {
    snapshot: (orgId, options) => request<SharedMemorySnapshot>(base(orgId), { query: options }),
    act: (orgId, action) => request<SharedMemoryActionResult>(`${base(orgId)}/actions`, { json: action }),
    mem0Readiness: (orgId) => request<SharedMemoryMem0Readiness>(`${base(orgId)}/mem0`),
    mem0Latest: (orgId) => request<SharedMemoryMem0Latest>(`${base(orgId)}/mem0/evaluations/latest`),
    evaluateMem0: (orgId) => request<SharedMemoryMem0Report>(`${base(orgId)}/mem0/evaluate`, { json: {} }),
  };
}
