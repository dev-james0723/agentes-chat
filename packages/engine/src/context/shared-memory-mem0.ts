import { randomUUID } from "node:crypto";
import { MEM0_SYNTHETIC_CASES, type Mem0SyntheticCase, type Mem0SyntheticStep } from "./shared-memory-mem0-cases";

/** Supplied by the backend's validated config. No environment or credentials are read by this module. */
export interface SharedMemoryMem0Config {
  MEM0_ENABLED?: boolean;
  MEM0_API_KEY?: string;
  MEM0_REQUEST_TIMEOUT_MS?: number;
}

export interface SharedMemoryMem0Readiness {
  provider: "mem0";
  readiness: "disabled" | "missing_key" | "configured_unverified";
  configured: boolean;
  mode: "synthetic_only";
  privateProjectionEnabled: false;
}

/** Safe for a client: configuration presence is not authentication or retrieval evidence. */
export function getSharedMemoryMem0Readiness(config: SharedMemoryMem0Config): SharedMemoryMem0Readiness {
  const configured = Boolean(config.MEM0_API_KEY?.trim());
  return {
    provider: "mem0",
    readiness: !config.MEM0_ENABLED ? "disabled" : configured ? "configured_unverified" : "missing_key",
    configured,
    mode: "synthetic_only",
    privateProjectionEnabled: false,
  };
}

export interface Mem0SyntheticCaseResult {
  id: string;
  category: Mem0SyntheticCase["category"];
  status: "passed" | "failed" | "unavailable" | "skipped";
  reason: string | null;
  elapsedMs: number;
  matchedFactIds: string[];
  suppressedInputs: number;
}

export interface Mem0SyntheticEvaluationReport {
  provider: "mem0";
  suite: "synthetic_projection_v1";
  evidenceMode: "provider_live" | "injected_transport" | "not_run";
  readiness: SharedMemoryMem0Readiness;
  status: "passed" | "failed" | "partial" | "unavailable";
  providerVerified: boolean;
  nativeAuthority: true;
  privateMemoriesSent: false;
  modelAnswersTested: false;
  runId: string | null;
  observedAt: string;
  cases: Mem0SyntheticCaseResult[];
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

/** Durable progress contains identifiers and counts only. A checkpoint never certifies provider success. */
export interface Mem0SyntheticCheckpoint {
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

export interface Mem0SyntheticEvaluationOptions {
  config: SharedMemoryMem0Config;
  /** Supplying a transport always labels the evidence as injected, even when it forwards to a live server. */
  transport?: typeof fetch;
  signal?: AbortSignal;
  now?: () => number;
  /** Lower limits are useful in tests. The fixed upper bounds cannot be increased by callers. */
  maxCalls?: number;
  maxDurationMs?: number;
  pollDelayMs?: number;
  /** Awaited before outbound mutations and after observing their IDs. Failure stops further unjournaled writes. */
  onCheckpoint?: (checkpoint: Mem0SyntheticCheckpoint) => Promise<void>;
}

const BASE = "https://api.mem0.ai";
const MAX_BYTES = 262_144;
const MAX_CALLS = 256;
const MAX_DURATION_MS = 180_000;
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const bounded = (value: number | undefined, fallback: number, low: number, high: number) =>
  Number.isFinite(value) ? Math.max(low, Math.min(high, Math.floor(value ?? fallback))) : fallback;
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

class EvaluationError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

interface OwnedMemory {
  id: string;
  caseId: string;
  userId: string;
}

interface ProjectedFact {
  id: string;
  step: Mem0SyntheticStep;
}

const failureCode = (error: unknown) => (error instanceof EvaluationError ? error.code : "transport_error");

/**
 * Fixed fabricated fixtures only: no arbitrary text, native-memory read, database, or automatic writer.
 * V3 extraction is additive. This evaluates an explicitly curated, verbatim projection and its retrieval,
 * not Mem0's fact-admission algorithm or an agent/model's response quality.
 */
export async function runMem0SyntheticEvaluation(
  options: Mem0SyntheticEvaluationOptions,
): Promise<Mem0SyntheticEvaluationReport> {
  const started = Date.now();
  const now = options.now ?? Date.now;
  const readiness = getSharedMemoryMem0Readiness(options.config);
  const report: Mem0SyntheticEvaluationReport = {
    provider: "mem0",
    suite: "synthetic_projection_v1",
    evidenceMode: "not_run",
    readiness,
    status: "unavailable",
    providerVerified: false,
    nativeAuthority: true,
    privateMemoriesSent: false,
    modelAnswersTested: false,
    runId: null,
    observedAt: new Date(now()).toISOString(),
    cases: [],
    totals: { passed: 0, failed: 0, unavailable: 0, skipped: 0 },
    metrics: { requests: 0, elapsedMs: 0, searchP95Ms: null, cost: null },
    cleanup: { status: "not_needed", deleted: 0, remainingIds: [], unresolvedOperations: [], eventIds: [], issues: [] },
  };
  if (readiness.readiness !== "configured_unverified") {
    report.cases = MEM0_SYNTHETIC_CASES.map((item) => ({
      id: item.id,
      category: item.category,
      status: "unavailable",
      reason: readiness.readiness,
      elapsedMs: 0,
      matchedFactIds: [],
      suppressedInputs: 0,
    }));
    report.totals.unavailable = report.cases.length;
    return report;
  }

  const apiKey = options.config.MEM0_API_KEY?.trim();
  if (!apiKey || /[\r\n]/.test(apiKey)) throw new EvaluationError("invalid_configuration");
  const runId = `agentes-synthetic-${randomUUID()}`;
  report.runId = runId;
  report.evidenceMode = options.transport ? "injected_transport" : "provider_live";
  const http = options.transport ?? fetch;
  const maxCalls = bounded(options.maxCalls, MAX_CALLS, 1, MAX_CALLS);
  const deadline = started + bounded(options.maxDurationMs, MAX_DURATION_MS, 100, MAX_DURATION_MS);
  const requestMs = bounded(options.config.MEM0_REQUEST_TIMEOUT_MS, 5_000, 100, 30_000);
  const owned = new Map<string, OwnedMemory>();
  const unresolved = new Set<string>();
  const events = new Set<string>();
  const searchLatencies: number[] = [];
  let checkpointSequence = 0;
  const checkpoint = async (phase: Mem0SyntheticCheckpoint["phase"]) => {
    if (!options.onCheckpoint) return;
    const value: Mem0SyntheticCheckpoint = {
      provider: "mem0",
      suite: "synthetic_projection_v1",
      runId,
      observedAt: new Date(now()).toISOString(),
      sequence: ++checkpointSequence,
      evidenceMode: options.transport ? "injected_transport" : "provider_live",
      phase,
      providerVerified: false,
      privateMemoriesSent: false,
      modelAnswersTested: false,
      requests: report.metrics.requests,
      completedCases: report.cases.filter((item) => item.status !== "skipped").length,
      ownedMemoryIds: [...owned.keys()],
      eventIds: [...events],
      unresolvedOperations: [...unresolved],
      cleanupDeleted: report.cleanup.deleted,
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        options.onCheckpoint(value),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new EvaluationError("checkpoint_unavailable")),
            Math.min(5_000, Math.max(1, deadline - Date.now())),
          );
        }),
      ]);
    } catch {
      // Audit callbacks must not leak database errors, credentials or arbitrary thrown values into a report.
      throw new EvaluationError("checkpoint_unavailable");
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const request = async (path: string, method: "GET" | "POST" | "PUT" | "DELETE", body?: unknown, allow404 = false) => {
    if (options.signal?.aborted) throw new EvaluationError("cancelled");
    if (report.metrics.requests >= maxCalls) throw new EvaluationError("request_budget_exhausted");
    if (Date.now() >= deadline) throw new EvaluationError("evaluation_deadline");
    report.metrics.requests += 1;
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          const response = await http(`${BASE}${path}`, {
            method,
            redirect: "error",
            signal,
            headers: { Authorization: `Token ${apiKey}`, "Content-Type": "application/json" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
          if (response.url && new URL(response.url).origin !== BASE) throw new EvaluationError("unexpected_origin");
          if (response.status === 404 && allow404) {
            await response.body?.cancel();
            return { status: 404, data: {} };
          }
          if (!response.ok) {
            await response.body?.cancel();
            throw new EvaluationError(
              response.status === 401 || response.status === 403
                ? "authentication_unavailable"
                : response.status === 429
                  ? "rate_limited"
                  : "provider_http_error",
            );
          }
          if (Number(response.headers.get("content-length") ?? 0) > MAX_BYTES) {
            await response.body?.cancel();
            throw new EvaluationError("response_too_large");
          }
          const reader = response.body?.getReader();
          if (!reader) throw new EvaluationError("invalid_response");
          const decoder = new TextDecoder();
          let length = 0;
          let text = "";
          try {
            for (;;) {
              const chunk = await reader.read();
              if (chunk.done) break;
              length += chunk.value.byteLength;
              if (length > MAX_BYTES) {
                await reader.cancel();
                throw new EvaluationError("response_too_large");
              }
              text += decoder.decode(chunk.value, { stream: true });
            }
          } finally {
            reader.releaseLock();
          }
          text += decoder.decode();
          let data: Record<string, unknown> | null;
          try {
            data = object(JSON.parse(text));
          } catch {
            throw new EvaluationError("invalid_response");
          }
          if (!data) throw new EvaluationError("invalid_response");
          return { status: response.status, data };
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => {
              controller.abort();
              reject(new EvaluationError("request_timeout"));
            },
            Math.min(requestMs, Math.max(1, deadline - Date.now())),
          );
        }),
      ]);
    } catch (error) {
      // Provider bodies and errors can echo credentials or payloads. Only fixed reason codes leave this module.
      throw error instanceof EvaluationError
        ? error
        : new EvaluationError(options.signal?.aborted ? "cancelled" : "transport_error");
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const requireOwned = async (entry: OwnedMemory) => {
    const answer = await request(`/v1/memories/${entry.id}/`, "GET", undefined, true);
    if (answer.status === 404) return null;
    const meta = object(answer.data.metadata);
    if (
      answer.data.id !== entry.id ||
      answer.data.user_id !== entry.userId ||
      meta?.evaluation_run_id !== runId ||
      meta?.evaluation_case_id !== entry.caseId
    )
      throw new EvaluationError("ownership_not_verified");
    return answer.data;
  };

  const deleteOwned = async (entry: OwnedMemory, phase: Mem0SyntheticCheckpoint["phase"] = "running") => {
    if (await requireOwned(entry)) {
      await checkpoint(phase);
      await request(`/v1/memories/${entry.id}/?delete_linked=false`, "DELETE");
      const after = await request(`/v1/memories/${entry.id}/`, "GET", undefined, true);
      if (after.status !== 404) throw new EvaluationError("deletion_not_verified");
      report.cleanup.deleted += 1;
    }
    owned.delete(entry.id);
    await checkpoint(phase);
  };

  const addResult = async (data: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (Array.isArray(data.results)) return data;
    if (typeof data.event_id !== "string" || !idPattern.test(data.event_id) || data.event_id === apiKey)
      throw new EvaluationError("invalid_add_receipt");
    const eventId = data.event_id;
    events.add(eventId);
    await checkpoint("running");
    for (let attempt = 0; attempt < 4; attempt++) {
      const event = (await request(`/v1/event/${eventId}/`, "GET")).data;
      if (event.status === "FAILED") throw new EvaluationError("provider_processing_failed");
      if (event.status === "SUCCEEDED") {
        events.delete(eventId);
        return event;
      }
      if (event.status !== "PENDING" && event.status !== "RUNNING") throw new EvaluationError("invalid_event_status");
      if (attempt < 3)
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(1_000, options.pollDelayMs ?? 250))));
    }
    throw new EvaluationError("provider_processing_pending");
  };

  let stopReason: string | null = null;
  try {
    await checkpoint("started");
  } catch (error) {
    stopReason = failureCode(error);
  }
  for (const item of MEM0_SYNTHETIC_CASES) {
    const caseStart = Date.now();
    const result: Mem0SyntheticCaseResult = {
      id: item.id,
      category: item.category,
      status: "skipped",
      reason: stopReason,
      elapsedMs: 0,
      matchedFactIds: [],
      suppressedInputs: 0,
    };
    report.cases.push(result);
    if (stopReason) continue;
    const projected = new Map<string, ProjectedFact>();
    const tombstones = new Set<string>();
    const userId = (owner: "owner" | "other") => `${runId}:${item.id}:${owner}`;
    try {
      for (const step of item.steps) {
        const existing = projected.get(step.factId);
        if (step.operation === "forget") {
          tombstones.add(step.factId);
          if (existing) {
            const entry = owned.get(existing.id);
            if (!entry) throw new EvaluationError("ownership_not_verified");
            await deleteOwned(entry);
            projected.delete(step.factId);
          }
          continue;
        }
        // These gates exercise the fixture's already-curated projection, never infer authority from text.
        if (
          tombstones.has(step.factId) ||
          step.origin === "agent_claim" ||
          step.origin === "derived_export" ||
          (existing && step.revision <= existing.step.revision)
        ) {
          result.suppressedInputs += 1;
          continue;
        }
        const metadata = {
          evaluation_run_id: runId,
          evaluation_case_id: item.id,
          canonical_fact_id: step.factId,
          source_id: step.sourceId,
          source_kind: step.origin,
          revision: step.revision,
          visibility: step.visibility,
          fact_status: step.status,
          synthetic: true,
        };
        const operation = `${item.id}:${step.factId}:${step.revision}`;
        if (existing) {
          const entry = owned.get(existing.id);
          if (!entry || !(await requireOwned(entry))) throw new EvaluationError("ownership_not_verified");
          unresolved.add(operation);
          await checkpoint("running");
          const changed = (await request(`/v1/memories/${entry.id}/`, "PUT", { text: step.text, metadata })).data;
          if (changed.id !== entry.id) throw new EvaluationError("invalid_update_receipt");
          const verified = await requireOwned(entry);
          if (verified?.memory !== step.text) throw new EvaluationError("update_not_verified");
          unresolved.delete(operation);
          projected.set(step.factId, { id: entry.id, step });
          await checkpoint("running");
        } else {
          unresolved.add(operation);
          await checkpoint("running");
          const receipt = await addResult(
            (
              await request("/v3/memories/add/", "POST", {
                user_id: userId(step.owner),
                run_id: runId,
                infer: false,
                messages: [{ role: "user", content: step.text }],
                metadata,
              })
            ).data,
          );
          if (!Array.isArray(receipt.results) || receipt.results.length !== 1)
            throw new EvaluationError("invalid_add_receipt");
          const added = object(receipt.results[0]);
          if (typeof added?.id !== "string" || !idPattern.test(added.id) || added.id === apiKey || owned.has(added.id))
            throw new EvaluationError("invalid_add_receipt");
          const entry = { id: added.id, caseId: item.id, userId: userId(step.owner) };
          owned.set(entry.id, entry);
          await checkpoint("running");
          const verified = await requireOwned(entry);
          if (verified?.memory !== step.text) throw new EvaluationError("projection_not_verified");
          unresolved.delete(operation);
          projected.set(step.factId, { id: entry.id, step });
          await checkpoint("running");
        }
      }

      const filters = {
        AND: [
          { user_id: userId(item.queryOwner ?? "owner") },
          { run_id: runId },
          { "metadata.evaluation_case_id": item.id },
          { "metadata.visibility": item.queryVisibility === "private" ? { in: ["public", "private"] } : "public" },
          { "metadata.fact_status": item.queryStatus ?? "current" },
        ],
      };
      const search = async (showExpired: boolean) => {
        const searchStart = Date.now();
        const data = (
          await request("/v3/memories/search/", "POST", {
            query: item.query,
            filters,
            top_k: 10,
            threshold: 0,
            show_expired: showExpired,
          })
        ).data;
        searchLatencies.push(Date.now() - searchStart);
        if (!Array.isArray(data.results) || data.results.length > 100)
          throw new EvaluationError("invalid_search_response");
        const matched: string[] = [];
        for (const value of data.results) {
          const memory = object(value);
          const meta = object(memory?.metadata);
          const factId = meta?.canonical_fact_id;
          const expected = typeof factId === "string" ? projected.get(factId) : undefined;
          if (
            !memory ||
            !meta ||
            !expected ||
            memory.id !== expected.id ||
            meta.evaluation_run_id !== runId ||
            meta.evaluation_case_id !== item.id ||
            memory.user_id !== userId(item.queryOwner ?? "owner") ||
            meta.visibility !== expected.step.visibility ||
            meta.fact_status !== (item.queryStatus ?? "current") ||
            (item.queryVisibility !== "private" && meta.visibility !== "public")
          )
            throw new EvaluationError("scope_or_provenance_mismatch");
          if (
            memory.memory !== expected.step.text ||
            meta.source_id !== expected.step.sourceId ||
            meta.revision !== expected.step.revision
          )
            throw new EvaluationError("stale_or_changed_projection");
          matched.push(String(factId));
        }
        if (new Set(matched).size !== matched.length) throw new EvaluationError("duplicate_projection");
        if (JSON.stringify([...matched].sort()) !== JSON.stringify([...item.expectedFactIds].sort()))
          throw new EvaluationError("retrieval_expectation_failed");
        return matched;
      };
      result.matchedFactIds = await search(false);
      if (item.category === "forget") await search(true); // Expiration is not deletion.
      result.status = "passed";
      result.reason = null;
    } catch (error) {
      const code = failureCode(error);
      const observedFailure = [
        "scope_or_provenance_mismatch",
        "stale_or_changed_projection",
        "duplicate_projection",
        "retrieval_expectation_failed",
        "update_not_verified",
        "deletion_not_verified",
        "projection_not_verified",
      ].includes(code);
      result.status = observedFailure ? "failed" : "unavailable";
      result.reason = code;
      if (!observedFailure) stopReason = code;
    } finally {
      for (const entry of [...owned.values()].filter((entry) => entry.caseId === item.id)) {
        try {
          await deleteOwned(entry, "cleanup");
        } catch (error) {
          report.cleanup.issues.push(`${item.id}:${failureCode(error)}`);
        }
      }
      result.elapsedMs = Date.now() - caseStart;
    }
  }

  if (report.metrics.requests > 0) {
    try {
      await checkpoint("cleanup");
    } catch (error) {
      report.cleanup.issues.push(`journal:${failureCode(error)}`);
    }
  }
  for (const result of report.cases) report.totals[result.status] += 1;
  report.cleanup.remainingIds = [...owned.keys()];
  report.cleanup.unresolvedOperations = [...unresolved];
  report.cleanup.eventIds = [...events];
  report.cleanup.status =
    owned.size || unresolved.size || events.size || report.cleanup.issues.length ? "incomplete" : "complete";
  report.metrics.elapsedMs = Date.now() - started;
  searchLatencies.sort((a, b) => a - b);
  report.metrics.searchP95Ms = searchLatencies.length
    ? (searchLatencies[Math.ceil(searchLatencies.length * 0.95) - 1] ?? null)
    : null;
  report.status =
    report.totals.unavailable || report.totals.skipped || report.cleanup.status === "incomplete"
      ? "partial"
      : report.totals.failed
        ? "failed"
        : "passed";
  report.providerVerified = report.evidenceMode === "provider_live" && report.status === "passed";
  if (!report.metrics.requests) {
    report.evidenceMode = "not_run";
    report.status = "unavailable";
  }
  return report;
}
