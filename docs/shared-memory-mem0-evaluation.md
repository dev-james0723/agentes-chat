# Optional Mem0 evaluation

Native memory is the authority. This adapter is a removable, manually invoked evaluation of a
verbatim projection. It never reads native memories, files, source archives, or conversations.
Its input is a fixed set of 20 fabricated cases committed with the code. Enabling it does not
start a worker, create a second canonical store, or synchronize a person's memories externally.

## Configuration and running

`MEM0_ENABLED` defaults to false. `MEM0_API_KEY` is a server-only secret. The optional
`MEM0_REQUEST_TIMEOUT_MS` defaults to 5000 and permits 100–30000 milliseconds.
All three variables are declared in `packages/config/src/schema.ts` and documented in `.env.example`.

Read readiness without a request:

```sh
bun packages/engine/eval/shared-memory-mem0.ts
```

After configuring a test project's key, explicitly run the fabricated cases:

```sh
bun --env-file=.env packages/engine/eval/shared-memory-mem0.ts --live
```

No API key is accepted as a command-line argument or returned in a report. An absent key produces
`unavailable` for every case, with zero provider requests. Configuration presence is reported as
`configured_unverified`; it is not an authentication or retrieval check.

The CLI prints its report as JSON. Save that output when an inspectable CLI receipt is needed:

```sh
(umask 077; bun --env-file=.env packages/engine/eval/shared-memory-mem0.ts --live > mem0-evaluation.json)
```

## Durable server receipts

The installation owner can manually invoke the server evaluation at
`POST /api/app/organizations/{orgId}/shared-memory/mem0/evaluate`. The request accepts an empty
object only. The server permits two starts per hour and rejects an overlapping evaluation in
the same process. The adapter's request and time limits also apply.

Before the first provider request, the server records the random synthetic run namespace in
the existing audit log. It checkpoints write intentions, returned memory IDs, pending event
IDs, and cleanup counts. These records contain identifiers and counts, never memory bodies or
API keys. A checkpoint has `providerVerified: false`. If journaling fails or exceeds its bounded
wait, the adapter stops further unjournaled mutations and reports the unresolved work.

The terminal report is saved before the HTTP response. The owner-only
`GET /api/app/organizations/{orgId}/shared-memory/mem0/evaluations/latest` returns the last terminal
report and the most recent attempt's checkpoint. If their run IDs differ, the report belongs to
an earlier attempt and the newer attempt has no confirmed completion. A process restart or
closed page never turns an unfinished checkpoint into a successful evaluation. Checkpoint
sequence numbers prevent a late audit write from moving progress backward.

These receipts make interrupted work inspectable. They do not automatically replay writes,
resume an evaluation, or delete an unknown provider record. An interrupted add may have no
returned memory ID, so the run namespace and unresolved operation must remain visible for
reconciliation. A missing native key still produces a durable unavailable report with no
provider request.

## What the 20 cases establish

The suite covers six basic retrieval cases, four corrections, two historical/current distinctions,
three source/echo cases, three privacy scopes, and two forget cases. Each run has a random synthetic
namespace; the scopes and source IDs are explicit. A new search request receives the query and
scope, not the preceding conversation. This tests retrieval, not a new model session or the quality
of an agent's answer.

The fixture projection accepts explicit source records, preserves their stable fact and source IDs,
uses an explicit update for a newer correction, suppresses repeated/derived/agent-claimed inputs,
and rejects stale input after a forget marker. These are application projection gates. Passing them
does not prove that Mem0 independently infers authority, corrections, or consent from a conversation.
Native capture and permission tests exercise the authoritative service separately.

The default test transport is injected and reports `injected_transport`. Those tests validate the
HTTP contract, failure handling, and application gates; they are not live retrieval measurements.
Only the default real transport can report `provider_live`, and `providerVerified` requires all
20 cases and cleanup to pass. No model answer is graded. Cost is `null`, since these responses do
not establish a monetary charge. Search latency is measured and labeled with the transport mode.

All thresholds are acceptance criteria for this suite, not a claim of general recall accuracy or
proof that every deployed agent uses memory correctly. Do not use a simulated pass to enable
automatic personal-data export.

## Provider contract and limits

The adapter uses the hosted Platform API, not the differently shaped open-source REST server:

| Operation | Endpoint |
| --- | --- |
| Add verbatim synthetic text (`infer: false`) | `POST /v3/memories/add/` |
| Scoped retrieval | `POST /v3/memories/search/` |
| Observe an asynchronous operation | `GET /v1/event/{event_id}/` |
| Inspect or explicitly update an owned record | `GET` / `PUT /v1/memories/{memory_id}/` |
| Delete only an owned record, without linked deletion | `DELETE /v1/memories/{memory_id}/?delete_linked=false` |

Add accepts entity IDs at the top level; search requires them inside `filters`. Requests are pinned
to `https://api.mem0.ai`, reject redirects, cap bodies at 256 KiB, and have per-request and whole-run
deadlines. A run cannot exceed 256 requests or 180 seconds. Pending events have at most four polls;
a pending receipt never counts as successful retrieval. Unknown mutation outcomes are not retried.

Before any update or deletion, the record is read back and its synthetic run, case and owner are
verified. Cleanup targets only IDs created by that run, then checks that each ID is absent. A
provider acknowledgement alone is insufficient. Failed cleanup, unknown writes, and pending event
IDs remain visible in the report. The forget cases also search with `show_expired: true` because
expiration hides data by default but does not delete it.

No broad entity deletion, project deletion, private export, automatic writeback, or native ChatGPT/
Claude write is exposed. A native provider's submitted correction stays unverified until the
specific target is read back; local tests do not change native status.

## Primary references

- [V3 migration and additive extraction](https://docs.mem0.ai/migration/platform-v2-to-v3)
- [Add memory and asynchronous receipt schema](https://docs.mem0.ai/api-reference/memory/add-memories)
- [Search filters and response schema](https://docs.mem0.ai/api-reference/memory/search-memories)
- [Event status and delayed temporal enrichment](https://docs.mem0.ai/api-reference/events/get-event)
- [Explicit update](https://docs.mem0.ai/api-reference/memory/update-memory)
- [Deletion and linked-delete scope](https://docs.mem0.ai/api-reference/memory/delete-memory)

The current migration guide says extraction is additive and can retain agent-originated facts.
Therefore source authority, correction precedence, and forget decisions remain in the native
application. Provider ranking is not a replacement for those decisions.
