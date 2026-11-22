# ADR 0209 — Evidence-bearing task delivery

Date: 2026-11-21

Status: Accepted for explicitly configured delivery contracts.

## Context

A completed model turn, a checked task and a usable product are different events. Ordinary task completion
does not identify the exact implementation snapshot, dispatch an independent reviewer or give the manager a
reviewable product. A hierarchy of tasks alone does not establish those transitions. Provider-outage waits
also depend on a durable retry job; a missing job must not require a second run or transcript replay.

## Decision

Use the existing task activity ledger for an opt-in contract between one parent task, one implementation task
and one independently assigned QA task. Add an optional `delivery` object to `update_issue` with
`configure`, `submit` and `review` actions. Reuse existing task conversations, consultation runs, Mission
sessions and delivery cards. No schema migration, replacement task, second scheduler or release authority is created.

Only the parent's current assigned manager configures the contract. The two child tasks must have different
current agent owners and the same audience as the parent. The server derives an existing canonical Mission
binding from the caller's context and checks the owner's visibility; the caller cannot supply another owner
or an arbitrary Mission. A contract without a Mission reports back to its existing parent task conversation.
Task detail and worker brief reads recheck all three current audiences before projecting any child receipt;
changed visibility or a missing linked task yields a generic reconciliation message.

The implementer explicitly submits a full Git revision or SHA-256 snapshot digest, an HTTP(S) preview without
credentials, actual artifact references, observed checks and a summary. All implementation criteria must be
checked. Submission moves the existing implementation task to review and hands the existing QA task to its
current independent owner. An ordinary turn ending does not submit a product.

QA names the exact submission receipt and content revision it inspected. A pass requires unchanged criteria,
current owners, required checked criteria and the same active snapshot. It completes the children, moves the
parent to review and returns the packet to the canonical manager session. Changes requested return scoped
corrections to the original implementation task. Identical retries are idempotent. A specific retry reason may
create a fresh receipt for unchanged content after an access failure; the old QA receipt cannot accept it.

A configured parent cannot be completed by an agent status update or background-turn completion. The Mission
delivery card includes its current receipts. Card creation and human acceptance recheck current revision, QA,
criteria, ownership, cancellation and visibility. The person's acceptance closes the parent; deployment
authorization remains a separate decision. A lost board notification after durable acceptance does not prevent
Mission closure. Unconfigured task and Mission behavior remains unchanged.

## Concurrency and recovery

Lock the Mission before its task rows, and lock task rows in a stable order. Write receipt timestamps after
acquiring the task locks, using database statement time rather than transaction-start time. Recheck proposed
state in the same transaction so an ownership or criteria edit cannot race an old approval into completion.

Extend the existing recovery sweep to repair overdue provider-outage waits whose current-generation execution
job is missing or failed. Requeue the same run and wait generation, under its row lock, without changing its
transcript. Preserve live leases, pending approvals, uncertain effects, manual holds, computer waits and
brain-switch waits. Recheck eligibility under the lock and skip execution already owned by this process.

## Verification and limits

Regression coverage exercises receipt identity, idempotency, independent ownership, current criteria,
audience restrictions, cancellation, stale delivery cards and failed publication. Disposable PostgreSQL tests
use separate connections and observed lock contention to test receipt ordering, simultaneous submissions and
both acceptance/configuration winners. Recovery tests cover missing jobs and the exclusions above.

The server validates evidence structure and authority. It does not inspect pixels, open the supplied preview
or prove an agent's QA statement true. Reviewers must inspect actual artifacts and run the relevant checks;
unavailable or untested evidence cannot become a pass. Runtime tests establish the mechanism, while an actual
product delivery must separately demonstrate the end-to-end behavior.
