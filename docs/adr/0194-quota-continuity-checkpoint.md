# ADR 0194: Reference-only checkpoint on existing quota waits

Status: isolated source candidate; not deployed. Full quota continuity remains outside this slice.

## Decision

Reuse native `waitForUsage`, timed outbox jobs, wait-ID fencing, same-session resume and `usageQueue`. Do not add an orchestrator, controller, queue, table, route or inference dependency.

On a plan/budget/usage pause, read at most 129 persisted step headers and retain bounded native receipt sequence references. Store version 1 under `Transcript.metadata.quotaContinuity`. Goal is the actual trigger-message ID; task is the native run issue ID. Unknown versions, constraints, reviewer/dependency references and quota readings are null. Returned/error tool-result receipts are evidence that a result was recorded, never acceptance or confirmed external persistence. A missing result, host delivery uncertainty or truncated evidence makes the next safe action `RECONCILE_EFFECT`.

The record binds the native org, agent, run, conversation, trigger, work, issue, owner, wait ID and same-harness route/session references. Existing native permission, wait-ID, run-state, job ownership and unknown-delivery fences remain authoritative. A checkpoint does not grant replay, change account/model, approve spending or revive terminal work. Resume reads this evidence only after the existing native resume gates and resolves the same route. Its namespace-only SQL update requires the current checkpoint and owner still match; it is not a new atomic job-claim/deduplication protocol.

Project only content-free counts/status through `usageQueue` after its existing `readableChannelIds` filter. Account/session/source IDs, prompts, tool output and private capture contents are not included. Existing API response adds only an optional nullable field: null means legacy/unknown/unavailable, not an invented successful checkpoint. Existing queue, timer and resume behavior remains usable when capture cannot be built.

## Persistence and integration dependency

Quota writes merge **only** `metadata.quotaContinuity` from the current SQL row. At the existing wait transition, the normal transcript save is wrapped to retain current other metadata and the top-level `publicationCapture`, including present null/malformed/revoked states. A metadata object absent from the row can be initialized; an existing non-object value is preserved and checkpoint projection is unknown. Resume changes the namespace on the current row, not an in-memory transcript replacement.

This requires the private-flow owner's serializer contract: ordinary `storedTranscript` saves preserve CURRENT row `metadata` and top-level `publicationCapture`; stale copies cannot restore/overwrite them. Quota does not edit that serializer, source capture, envelopes or context construction. The initial `eb999ff878bd8067795a0ebbfc2500d66326c622` baseline lacks that contract: fault tests preserve the actual failures until the owner's exact serializer port is available. No end-to-end preservation claim is valid before their combined tests pass.

## Boundaries and verification

The defensive reader validates the version and field shapes and caps UTF-8 JSON at 16 KiB. SQL evidence errors leave the existing wait/timer intact; no summary/JEV call is needed to capture or project. Native API 429/key-line handling is not reclassified as plan exhaustion. Nothing here changes fallback, extra usage, accounts, credentials, budgets, grants, resets or deployment authority.

Focused native fixtures cover two recorded receipts, unknown delivery, recreated handlers and natural recovery, stale/canceled jobs, changed owner/harness non-consumption, current audience ACL, unknown readings, real routine waits, legacy waits, injected SQL read failure, SQL rollback, malformed metadata and concurrent current publication capture. Existing usage-pause/key-line suites cover the reused queue and admission behavior. These are source/PGlite/fake-adapter tests; live provider/native acceptance, real PostgreSQL concurrency, cross-harness transfer, qualified route admission, shared pool budget and manual reset/spend approval are NOT covered. Manual resets, including free entitlements, still require James's approval; existing flags are not spending consent.
