import { describe, expect, test } from "bun:test";
import {
  getSharedMemoryMem0Readiness,
  type Mem0SyntheticCheckpoint,
  runMem0SyntheticEvaluation,
  type SharedMemoryMem0Config,
} from "../src/context/shared-memory-mem0";
import { MEM0_SYNTHETIC_CASES } from "../src/context/shared-memory-mem0-cases";

const config: SharedMemoryMem0Config = {
  MEM0_ENABLED: true,
  MEM0_API_KEY: "synthetic-test-key",
  MEM0_REQUEST_TIMEOUT_MS: 100,
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
type Row = { id: string; memory: string; user_id: string; run_id: string; metadata: Record<string, unknown> };
type Call = { path: string; method: string; body: Record<string, unknown>; signal: AbortSignal | null | undefined };

/** A transport contract fixture, not a model or a measurement of Mem0's semantic search quality. */
function provider(
  options: {
    async?: "complete" | "pending";
    intercept?: (call: Call, rows: Map<string, Row>) => Response | undefined;
  } = {},
) {
  let sequence = 0;
  const rows = new Map<string, Row>();
  const calls: Call[] = [];
  const events = new Map<string, string>();
  const nextId = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
  const readField = (row: Row, field: string) =>
    field.startsWith("metadata.") ? row.metadata[field.slice(9)] : row[field as keyof Row];
  const matches = (row: Row, filters: Record<string, unknown>): boolean => {
    if (Array.isArray(filters.AND)) return filters.AND.every((part) => matches(row, part));
    return Object.entries(filters).every(([field, wanted]) => {
      const value = readField(row, field);
      return wanted && typeof wanted === "object" && "in" in wanted
        ? (wanted as { in: unknown[] }).in.includes(value)
        : value === wanted;
    });
  };
  const http = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const call: Call = {
      path: `${url.pathname}${url.search}`,
      method: init?.method ?? "GET",
      body,
      signal: init?.signal,
    };
    calls.push(call);
    expect(url.origin).toBe("https://api.mem0.ai");
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Token synthetic-test-key");
    const intercepted = options.intercept?.(call, rows);
    if (intercepted) return intercepted;
    if (url.pathname === "/v3/memories/add/") {
      expect(body.infer).toBe(false);
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0].content).toStartWith("Synthetic evaluation only:");
      const id = nextId();
      rows.set(id, {
        id,
        memory: body.messages[0].content,
        user_id: body.user_id,
        run_id: body.run_id,
        metadata: structuredClone(body.metadata),
      });
      if (options.async) {
        const eventId = nextId();
        events.set(eventId, id);
        return json({ status: "PENDING", event_id: eventId });
      }
      return json({ results: [{ id, event: "ADD" }], status: "SUCCEEDED" });
    }
    const event = /^\/v1\/event\/([^/]+)\/$/.exec(url.pathname);
    if (event)
      return options.async === "pending"
        ? json({ status: "PENDING" })
        : json({ status: "SUCCEEDED", results: [{ id: events.get(event[1] ?? "") }] });
    if (url.pathname === "/v3/memories/search/") {
      expect(body.user_id).toBeUndefined();
      expect(body.filters.AND).toBeArray();
      return json({ results: [...rows.values()].filter((row) => matches(row, body.filters)).slice(0, body.top_k) });
    }
    const memory = /^\/v1\/memories\/([^/]+)\/$/.exec(url.pathname);
    const id = memory?.[1] ?? "";
    const row = rows.get(id);
    if (!row) return json({ error: "not found" }, 404);
    if (call.method === "PUT") {
      row.memory = body.text as string;
      row.metadata = structuredClone(body.metadata) as Record<string, unknown>;
      return json(row);
    }
    if (call.method === "DELETE") {
      expect(url.searchParams.get("delete_linked")).toBe("false");
      rows.delete(id);
      return json({ message: "Memory deleted successfully!" });
    }
    return json(row);
  }) as typeof fetch;
  return { http, rows, calls };
}

describe("optional Mem0 evaluation", () => {
  test("checkpoints precede provider writes and contain only bounded synthetic progress metadata", async () => {
    const checkpoints: Mem0SyntheticCheckpoint[] = [];
    const fake = provider({
      intercept: (call) => {
        expect(checkpoints[0]).toMatchObject({ phase: "started", requests: 0, providerVerified: false });
        if (call.method === "POST" && call.path === "/v3/memories/add/")
          expect(checkpoints.at(-1)?.unresolvedOperations.length).toBeGreaterThan(0);
        return undefined;
      },
    });
    const report = await runMem0SyntheticEvaluation({
      config,
      transport: fake.http,
      onCheckpoint: async (value) => {
        checkpoints.push(structuredClone(value));
      },
    });
    expect(report.status).toBe("passed");
    expect(checkpoints.length).toBeLessThan(256);
    expect(checkpoints.map((value) => value.sequence)).toEqual(checkpoints.map((_, index) => index + 1));
    expect(checkpoints.some((value) => value.ownedMemoryIds.length > 0)).toBe(true);
    expect(checkpoints.at(-1)).toMatchObject({ phase: "cleanup", ownedMemoryIds: [], providerVerified: false });
    const encoded = JSON.stringify(checkpoints);
    expect(encoded).not.toContain(config.MEM0_API_KEY ?? "missing-key");
    expect(encoded).not.toContain("Synthetic evaluation only:");
    expect(encoded).not.toContain("Authorization");
  });

  test("unavailable durable journaling prevents every provider request and redacts callback errors", async () => {
    const fake = provider();
    const report = await runMem0SyntheticEvaluation({
      config,
      transport: fake.http,
      onCheckpoint: async () => {
        throw new Error(`database error containing ${config.MEM0_API_KEY}`);
      },
    });
    expect(report.status).toBe("unavailable");
    expect(report.evidenceMode).toBe("not_run");
    expect(fake.calls).toHaveLength(0);
    expect(report.cases.every((item) => item.reason === "checkpoint_unavailable")).toBe(true);
    expect(JSON.stringify(report)).not.toContain(config.MEM0_API_KEY ?? "missing-key");
  });

  test("a failed receipt checkpoint keeps the known ID unresolved and does not claim cleanup", async () => {
    const fake = provider();
    const report = await runMem0SyntheticEvaluation({
      config,
      transport: fake.http,
      onCheckpoint: async (value) => {
        if (value.ownedMemoryIds.length) throw new Error("Synthetic journal failure");
      },
    });
    expect(report.status).toBe("partial");
    expect(report.providerVerified).toBe(false);
    expect(report.cleanup.status).toBe("incomplete");
    expect(report.cleanup.remainingIds).toHaveLength(1);
    expect(report.cleanup.unresolvedOperations).toHaveLength(1);
    expect(fake.calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  test("pending asynchronous event IDs are checkpointed without becoming success", async () => {
    const fake = provider({ async: "pending" });
    const checkpoints: Mem0SyntheticCheckpoint[] = [];
    const report = await runMem0SyntheticEvaluation({
      config,
      transport: fake.http,
      pollDelayMs: 0,
      onCheckpoint: async (value) => {
        checkpoints.push(value);
      },
    });
    expect(checkpoints.some((value) => value.eventIds.length === 1)).toBe(true);
    expect(report.cleanup.eventIds).toHaveLength(1);
    expect(report.providerVerified).toBe(false);
  });

  test("even a UUID-shaped key echoed as a provider identifier cannot enter a receipt", async () => {
    const key = "11111111-1111-4111-8111-111111111111";
    for (const receipt of [{ results: [{ id: key }] }, { status: "PENDING", event_id: key }]) {
      const report = await runMem0SyntheticEvaluation({
        config: { ...config, MEM0_API_KEY: key },
        transport: (async () => json(receipt)) as unknown as typeof fetch,
      });
      expect(report.providerVerified).toBe(false);
      expect(report.cases[0]?.reason).toBe("invalid_add_receipt");
      expect(JSON.stringify(report)).not.toContain(key);
    }
  });

  test("a stalled checkpoint is bounded by the whole evaluation deadline", async () => {
    const fake = provider();
    const report = await runMem0SyntheticEvaluation({
      config,
      transport: fake.http,
      maxDurationMs: 100,
      onCheckpoint: () => new Promise(() => {}),
    });
    expect(fake.calls).toHaveLength(0);
    expect(report.status).toBe("unavailable");
    expect(report.metrics.elapsedMs).toBeLessThan(1500);
  });

  test("readiness is safe and default-off, and key presence is not authentication", () => {
    expect(getSharedMemoryMem0Readiness({})).toEqual({
      provider: "mem0",
      readiness: "disabled",
      configured: false,
      mode: "synthetic_only",
      privateProjectionEnabled: false,
    });
    expect(getSharedMemoryMem0Readiness({ MEM0_ENABLED: true }).readiness).toBe("missing_key");
    const ready = getSharedMemoryMem0Readiness(config);
    expect(ready.readiness).toBe("configured_unverified");
    expect(JSON.stringify(ready)).not.toContain("synthetic-test-key");
    expect(JSON.stringify(ready)).not.toContain("API_KEY");
  });

  test("disabled and missing-key runs are unavailable with zero network requests", async () => {
    for (const unavailable of [{}, { MEM0_ENABLED: true }]) {
      const fake = provider();
      const report = await runMem0SyntheticEvaluation({ config: unavailable, transport: fake.http });
      expect(report.evidenceMode).toBe("not_run");
      expect(report.status).toBe("unavailable");
      expect(report.providerVerified).toBe(false);
      expect(report.totals).toEqual({ passed: 0, failed: 0, unavailable: 20, skipped: 0 });
      expect(fake.calls).toHaveLength(0);
    }
  });

  test("all 20 fixed cases traverse the v3/v1 contract and verify owned-ID cleanup", async () => {
    const fake = provider();
    const report = await runMem0SyntheticEvaluation({ config, transport: fake.http });
    expect(MEM0_SYNTHETIC_CASES).toHaveLength(20);
    expect(new Set(MEM0_SYNTHETIC_CASES.map((item) => item.id)).size).toBe(20);
    expect(report.cases.filter((item) => item.status !== "passed")).toEqual([]);
    expect(report.status).toBe("passed");
    expect(report.evidenceMode).toBe("injected_transport");
    expect(report.providerVerified).toBe(false);
    expect(report.modelAnswersTested).toBe(false);
    expect(report.nativeAuthority).toBe(true);
    expect(report.privateMemoriesSent).toBe(false);
    expect(report.cleanup.status).toBe("complete");
    expect(report.cleanup.remainingIds).toEqual([]);
    expect(fake.rows.size).toBe(0);
    expect(report.metrics.requests).toBe(fake.calls.length);
    expect(report.metrics.cost).toBeNull();
    expect(JSON.stringify(report)).not.toContain("synthetic-test-key");
  });

  test("agent claims and export echoes are suppressed; a duplicate source is not written twice", async () => {
    const fake = provider();
    const report = await runMem0SyntheticEvaluation({ config, transport: fake.http });
    const addBodies = fake.calls.filter((call) => call.path === "/v3/memories/add/").map((call) => call.body);
    expect(JSON.stringify(addBodies)).not.toContain("agent guessed");
    expect(JSON.stringify(addBodies)).not.toContain("old export used Port");
    for (const id of [
      "agent-claim-not-authority",
      "export-echo-not-correction",
      "duplicate-source",
      "out-of-order-source",
      "forget-blocks-stale-replay",
    ]) {
      expect(report.cases.find((item) => item.id === id)?.suppressedInputs).toBe(1);
    }
    expect(
      addBodies.filter((body) => (body.metadata as Record<string, unknown>).evaluation_case_id === "duplicate-source"),
    ).toHaveLength(1);
  });

  test("corrections use explicit owned-ID updates with the newer stable source and revision", async () => {
    const fake = provider();
    await runMem0SyntheticEvaluation({ config, transport: fake.http });
    const updates = fake.calls.filter((call) => call.method === "PUT");
    expect(updates).toHaveLength(3);
    for (const call of updates) {
      expect(call.body.metadata).toMatchObject({ revision: 2, source_kind: "user_correction", synthetic: true });
      expect((call.body.metadata as Record<string, unknown>).source_id).toMatch(/^synthetic-source:.*:2$/);
    }
  });

  test("forget is a verified delete, checks expired visibility too, and blocks old-source replay", async () => {
    const fake = provider();
    const report = await runMem0SyntheticEvaluation({ config, transport: fake.http });
    const forgetCases = report.cases.filter((item) => item.category === "forget");
    expect(forgetCases.map((item) => item.status)).toEqual(["passed", "passed"]);
    expect(
      fake.calls.filter((call) => call.path === "/v3/memories/search/" && call.body.show_expired === true),
    ).toHaveLength(2);
    expect(
      fake.calls.filter((call) => call.method === "DELETE").every((call) => call.path.includes("delete_linked=false")),
    ).toBe(true);
  });

  test("a provider scope leak fails the case instead of being filtered into a passing report", async () => {
    let injected = false;
    const fake = provider({
      intercept(call, rows) {
        if (!injected && call.path === "/v3/memories/search/") {
          injected = true;
          return json({ results: [...rows.values()].map((row) => ({ ...row, user_id: "foreign-owner" })) });
        }
      },
    });
    const report = await runMem0SyntheticEvaluation({ config, transport: fake.http });
    expect(report.cases[0]?.status).toBe("failed");
    expect(report.cases[0]?.reason).toBe("scope_or_provenance_mismatch");
    expect(report.status).toBe("failed");
    expect(report.cleanup.status).toBe("complete");
  });

  test("a stale returned revision is a failure even when the search returned the expected fact ID", async () => {
    const fake = provider({
      intercept(call, rows) {
        if (call.path === "/v3/memories/search/" && String(call.body.query).includes("response-length")) {
          return json({
            results: [...rows.values()].map((row) => ({ ...row, metadata: { ...row.metadata, revision: 1 } })),
          });
        }
      },
    });
    const report = await runMem0SyntheticEvaluation({ config, transport: fake.http });
    expect(report.cases.find((item) => item.id === "corrected-format")?.reason).toBe("stale_or_changed_projection");
  });

  test("async completion is polled and retrieval is still checked independently", async () => {
    const fake = provider({ async: "complete" });
    const report = await runMem0SyntheticEvaluation({ config, transport: fake.http, pollDelayMs: 0 });
    expect(report.status).toBe("passed");
    expect(fake.calls.some((call) => call.path.startsWith("/v1/event/"))).toBe(true);
    expect(fake.calls.some((call) => call.path === "/v3/memories/search/")).toBe(true);
    expect(report.cleanup.eventIds).toEqual([]);
  });

  test("a pending provider job is not success and never causes a repeated add", async () => {
    const fake = provider({ async: "pending" });
    const report = await runMem0SyntheticEvaluation({ config, transport: fake.http, pollDelayMs: 0 });
    expect(report.cases[0]?.reason).toBe("provider_processing_pending");
    expect(report.providerVerified).toBe(false);
    expect(report.totals.passed).toBe(0);
    expect(fake.calls.filter((call) => call.path === "/v3/memories/add/")).toHaveLength(1);
    expect(fake.calls.filter((call) => call.path.startsWith("/v1/event/"))).toHaveLength(4);
    expect(report.cleanup.status).toBe("incomplete");
    expect(report.cleanup.eventIds).toHaveLength(1);
  });

  test("provider errors and thrown errors cannot echo credentials into reports", async () => {
    const fake = provider({ intercept: () => json({ error: "synthetic-test-key" }, 401) });
    const denied = await runMem0SyntheticEvaluation({ config, transport: fake.http });
    expect(denied.cases[0]?.reason).toBe("authentication_unavailable");
    expect(JSON.stringify(denied)).not.toContain("synthetic-test-key");
    const throwing = (async () => {
      throw new Error("secret synthetic-test-key");
    }) as unknown as typeof fetch;
    const failed = await runMem0SyntheticEvaluation({ config, transport: throwing });
    expect(failed.cases[0]?.reason).toBe("transport_error");
    expect(JSON.stringify(failed)).not.toContain("synthetic-test-key");
  });

  test("an unowned ID returned by add is never updated or deleted", async () => {
    const foreignId = "00000000-0000-4000-8000-999999999999";
    const fake = provider({
      intercept(call, rows) {
        if (call.path === "/v3/memories/add/") {
          rows.set(foreignId, {
            id: foreignId,
            memory: "not this run",
            user_id: "someone-else",
            run_id: "other",
            metadata: {},
          });
          return json({ results: [{ id: foreignId }] });
        }
      },
    });
    const report = await runMem0SyntheticEvaluation({ config, transport: fake.http });
    expect(report.cases[0]?.reason).toBe("ownership_not_verified");
    expect(fake.calls.some((call) => call.method === "PUT" || call.method === "DELETE")).toBe(false);
    expect(fake.rows.has(foreignId)).toBe(true);
    expect(report.cleanup.status).toBe("incomplete");
  });

  test("malformed provider IDs never become request paths or client-visible receipts", async () => {
    const fake = provider({ intercept: () => json({ results: [{ id: "synthetic-test-key/../../private" }] }) });
    const report = await runMem0SyntheticEvaluation({ config, transport: fake.http });
    expect(report.cases[0]?.reason).toBe("invalid_add_receipt");
    expect(fake.calls).toHaveLength(1);
    expect(report.cleanup.remainingIds).toEqual([]);
    expect(JSON.stringify(report)).not.toContain("synthetic-test-key");
  });

  test("a pre-cancelled run is not reported as provider evidence", async () => {
    const fake = provider();
    const report = await runMem0SyntheticEvaluation({ config, transport: fake.http, signal: AbortSignal.abort() });
    expect(fake.calls).toHaveLength(0);
    expect(report.evidenceMode).toBe("not_run");
    expect(report.providerVerified).toBe(false);
    expect(report.status).toBe("unavailable");
  });

  test("request budgets keep unknown outcomes visible without resending a mutation", async () => {
    const fake = provider();
    const report = await runMem0SyntheticEvaluation({ config, transport: fake.http, maxCalls: 1 });
    expect(fake.calls).toHaveLength(1);
    expect(report.cases[0]?.reason).toBe("request_budget_exhausted");
    expect(report.cleanup.status).toBe("incomplete");
    expect(report.cleanup.unresolvedOperations).toHaveLength(1);
  });

  test("a transport that ignores abort is still bounded", async () => {
    let signal: AbortSignal | null | undefined;
    const hanging = (async (_input: unknown, init: RequestInit) => {
      signal = init.signal;
      return new Promise<Response>(() => {});
    }) as unknown as typeof fetch;
    const started = Date.now();
    const report = await runMem0SyntheticEvaluation({ config, transport: hanging });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(signal?.aborted).toBe(true);
    expect(report.cases[0]?.reason).toBe("request_timeout");
    expect(report.metrics.requests).toBe(1);
    expect(report.cleanup.status).toBe("incomplete");
  });

  test("oversized and malformed responses cannot produce verification", async () => {
    const large = (async () =>
      new Response("x", { headers: { "content-length": "9999999" } })) as unknown as typeof fetch;
    const malformed = (async () => new Response("not json")) as unknown as typeof fetch;
    const first = await runMem0SyntheticEvaluation({ config, transport: large });
    const second = await runMem0SyntheticEvaluation({ config, transport: malformed });
    expect(first.cases[0]?.reason).toBe("response_too_large");
    expect(second.cases[0]?.reason).toBe("invalid_response");
    expect([first.providerVerified, second.providerVerified]).toEqual([false, false]);
  });

  test("a deletion acknowledgement without observed absence is not cleanup success", async () => {
    const fake = provider({
      intercept(call) {
        if (call.method === "DELETE") return json({ message: "deleted" });
      },
    });
    const report = await runMem0SyntheticEvaluation({ config, transport: fake.http });
    expect(report.cleanup.status).toBe("incomplete");
    expect(report.cleanup.remainingIds.length).toBeGreaterThan(0);
    expect(report.cleanup.issues.some((issue) => issue.includes("deletion_not_verified"))).toBe(true);
    expect(report.cleanup.deleted).toBe(0);
    expect(report.providerVerified).toBe(false);
  });
});
