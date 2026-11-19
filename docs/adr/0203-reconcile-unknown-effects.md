# ADR 0203: Reconciling runs held on an unknown tool outcome

Status: accepted (source and PGlite tests); not deployed.

## Context

A run is held when one of its tool calls may have acted and nothing proves whether it did. Three things hold it today:

- a computer turn's bridge epoch (ADR 0032) left `closed_unknown`, or left `open` by a worker that died mid-turn;
- an approved action that ran (`approvals.executed_at` set) without a result it can vouch for (no result, or an error,
  which can follow a commit: a reset after the provider wrote);
- the run's `effectUncertain` marker (the computer's own tools, evidence that could not be read).

The executor, the stale-run sweep and `transitionRun` all refuse such a run, which is right: replaying the call could
act twice. But nothing ever lifted the hold. A dead worker's open epoch was never even closed, so the sweep skipped
that run forever. The run sat in `running`, `queued` or `waiting_*` with no way forward but a stop.

Durable-execution engines do not remove this window: an activity can complete and lose its answer, and the caller
retries it unless the callee is idempotent. The answer is an explicit unknown state and reconciliation against the
authoritative result before any retry, not a blanket retry policy.

## Decision

Keep the native run, epoch and approval rows as the journal (no new table, no migration, no workflow engine). Add one
module, `packages/engine/src/effect-reconcile.ts`, that settles each unknown effect exactly once and then lifts the hold.

1. **Fence a dead turn.** The stale-run sweep (`recoverStaleRuns`) first finds running runs whose beat is older than
   the stale cutoff, not executed by this process, with an `open` epoch. It closes that epoch as `closed_unknown`,
   revokes its token (the computer can no longer call on it) and sets the marker `interrupted computer turn`: the turn
   may have run the computer's own tools, which the server never saw.
2. **Read back where a read-back exists.** For every held run (still `queued`, `running` or `waiting_*`), each bridge
   call answered without proof (`unknown`) is read back once with the existing deterministic read-backs
   (`effect-readback.ts`: `comment_issue`, `create_issue`). A sure `done` or `not_done` settles the call
   (`reconciled`, `by: "read_back"`); an ambiguous or missing read-back is marked as tried and left for a person. A call
   still `in_flight` is never read: another replica may still be executing it.
3. **Otherwise a person says what happened.** `GET …/runs/{runId}/unknown-effects` lists what holds the run
   (`call:<epoch>:<call>`, `approval:<id>`, `marker`); `POST …/unknown-effects/reconcile` records `done` or `not_done`
   for one of them. An approval's effect is settled by someone who may decide that approval (`decides`); the rest by
   someone who approves actions or the agent's owner. The verdict, a run step (`effect_reconciled`) and an audit row
   (`run.effect_reconciled`, with the note) are written in one transaction under the run's row lock.
4. **Fresh authority, never the checkpoint's.** Every check is made at decision time against current rows, never taken
   from when the run was held or from a restored snapshot: the person's membership and keys, the workspace and agent
   standing (`standingRefusal`), the run still held (a stopped or ended run is refused: cancellation always wins), no
   turn of the run still open, and for an approval its status still `approved` (one withdrawn since refuses the
   release). A refusal writes nothing.
5. **Release is never a replay.** When nothing unknown is left, the settled epochs close, the marker is removed, and:
   a run waiting on a decision gets the same execute job a decision gives (`enqueueResume`); a running run whose worker
   died is left to the sweep's existing rules (it resumes only when no call was cut, otherwise it ends with the
   interrupted notice); a queued one to the requeue. A reconciled approval's stored result is what the model reads when
   the run goes on (`ranBefore` in the Tool Gateway): "did happen, not run again" or "did not happen, not run again by
   itself: ask again if it is still needed". The platform never calls it again; a fresh call by the agent goes through
   the gateway and its approval again.

Stopping remains the way to end a held run (`cancelRun`), so "release or fail" is: reconcile and release, or stop.

## Consequences

- The hold predicates (executor, sweep, `transitionRun`) treat an approval whose result carries `reconciled` as
  settled; the executor's own post-execution check does too, so a `not_done` verdict does not hold the run again.
- The marker is removed with a direct SQL update: the sticky transcript write (`keepRunMarkers`) would keep it. A stale
  executor still holding the old transcript could write it back; held runs have no executor, so this is accepted.
- Read-backs exist for two tools; every other unknown effect needs a person. Adding a read-back for a tool is the way to
  make its recovery automatic.
- No app screen yet: the API serves it, and the run's existing "waiting for reconciliation" message says why it waits.

## Verification

`packages/engine/test/effect-reconcile.test.ts` covers, on PGlite with fake providers and tools: an approved send whose
answer was lost after it happened, marked done, goes on with one send and never a second (lost response, no duplicate);
marked not done, goes on without the platform sending it; a member without the right, an admin demoted since and an
approval withdrawn since are refused with nothing dispatched (revoked authority after restore); an agent on hold
releases nothing; a cancelled run stays cancelled through a decision and the sweep; a dead worker's open epoch is
fenced, its answered call read back, its native part settled by a person, then recovery ends it without replay; a call
never answered is not read back; a live turn's epoch is neither fenced nor reconciled. Real PostgreSQL concurrency,
multi-replica timing and provider-side read-backs are not covered.
