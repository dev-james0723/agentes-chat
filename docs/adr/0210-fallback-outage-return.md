# ADR 0210 — Return a stalled API fallback to its configured Codex subscription

Status: proposed for review
Date: 2026-11-22

## Context

A conversation that falls back from a computer brain to an API model deliberately stays on that model when it resumes. Its transcript contains API-model tool calls and results. Simply resolving the agent's default brain again would start a native harness from the original trigger and could repeat completed work.

That pin also prevents a legacy fallback from returning to the agent's configured subscription after an API provider outage. The outage ladder is healthy: it claims the same run and retries the same wait generation. Repeated successful claims do not themselves make the original native route eligible.

Changing agent settings or starting another run is not a safe substitute for recovering this run. Recovery must retain its identity and completed work, qualify the target again, and create a fresh target session without importing a source native session.

## Decision

Permit one narrow return at a claimed provider-outage wake. The ordinary fallback pin remains unchanged.

The return applies only to an ordinary foreground conversation whose agent still selects its own Codex subscription, with no named or lent account and paid extra usage disabled. The transcript must record a previous Codex-to-model fallback. Model Inspector and quota continuation must be enabled for the organization, and Codex must remain in the configured continuation targets. Personal bindings, routines, arbitrary model changes, and other native providers are outside this change.

The executor reuses the subscription qualifier, normal brain resolver, portable conversation builder, native session machinery, and Mission route transaction. It does not introduce another authentication path or change the agent's settings.

### Admission

The currently owned job must be the real execute job for this run. Its wake must match the transcript's exact outage wait generation. A resumed approval, generic recovery claim, stale timer, or unowned invocation cannot trigger the return.

The configured route is resolved normally before qualification. Qualification must identify the same machine, the computer's own Codex sign-in, an actual model, distinct source and target pools, and no paid extra usage or credential-bearing portable context.

Both live and stored subscription readings must have measured plan windows from a probe or turn, a timestamp within the configured freshness interval that is not in the future, and normal reserve. A freshly created qualification receipt does not make an old usage reading fresh.

Normal native admission is repeated using both live and locked stored machine capabilities: ownership, online state, pause, command access, Codex access, runner protocol, installed CLI, and quota restrictions continue to apply. The target continues to use the existing Tool Gateway and native permission controls.

### Atomic boundary

The transaction locks the owned outbox claim, follows the existing Mission queue lock order, and locks the agent, machine, and source run. It rechecks current identity and settings, active policy, lease validity, source session association, run and task identity, wait generation, and completed step sequence.

An approval, open question or secret, unknown bridge effect, uncertain executed approval, interrupted turn, reconciliation checkpoint, manual hold, unmatched tool operation, or changed ownership prevents the return. The completed API tool ledger is checked conservatively with the existing effect-evidence helper.

A post-qualification identity, ownership, policy, or hold race aborts this attempt without dispatching either brain or overwriting the concurrent state. This path does not approve decisions or clear holds. If only qualification or usage freshness expired, the executor first proves that the source identity, wait, effects, and claimed lease are unchanged, then continues the existing API outage retry/park path. It does not leave an unchanged running row behind a completed job. A Mission route write is rolled back if freshness expires while waiting on its locks. An ineligible route otherwise leaves ordinary fallback behavior in place.

### Continuation and receipt

On admission, the same run ID and task references receive a new Codex session ID, selected actual model, and a portable text checkpoint. The previous native association is used only as a compare-and-swap anchor. It is never resumed or imported.

The target receives the task's goal, bounded prior conversation, and completed work log, together with instructions to verify the current working state and continue remaining work without repeating completed actions. The engine does not replay prior tool calls.

The existing handoff record is extended with reason `provider_outage` and an outage-return receipt containing the wait generation, completed step sequence, portable-context digest, and byte count. The audit records the original run and task references, source and target route, new session, measured usage timestamp, and qualification evidence. The historical fallback record stays available; completed replies no longer incorrectly say the API model supplied the answer.

A Mission, when present, uses the existing Mission route CAS in the same transaction. Its identity is preserved; already launched native child sessions are not replayed or rewritten. Only children that the existing helper proves unstarted may be retargeted.

A subsequent pause or restart uses the committed target handoff and its target session through the existing resume path. A returned target that has no room waits there; it cannot revive the old API transcript through legacy fallback again. A stale original outage wake cannot produce another return.

## Verification

Regression tests use PGlite, fake provider responses, fake native brains, and the real outbox claim path. The main case starts with an actual legacy native-plan refusal, executes a synthetic API tool operation once, encounters a retryable provider outage, and resumes only the existing matching wake. It checks retained run identity, a fresh target session, portable goal and completed-work evidence, and no replay or extra product run.

Additional tests exercise disabled policy or targets, stale and future live or stored readings, missing native capabilities, changed settings or ownership, pending decisions and uncertain effects, lost job claims, changed wait generations, duplicate wakes, and target pauses/resumption. The current test output is the evidence for coverage; this ADR does not claim a live provider or product has completed.

## Consequences

This closes a specific liveness gap without weakening the fallback pin or turning it into arbitrary cross-provider retry. It can recover only when the configured own-Codex route produces current eligible evidence. If that evidence is missing or a genuine permission/effect hold remains, the existing wait stays authoritative.

The checkpoint is a bounded text transfer, not a native session import or a guarantee that a language model can never independently choose a repeated action. Existing tool permissions, effect fencing, and application semantics remain necessary. Actual deployment and product completion require separate runtime receipts and reviewed product evidence.
