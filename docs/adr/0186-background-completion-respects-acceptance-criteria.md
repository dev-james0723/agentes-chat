# 0186. Background completion respects acceptance criteria

Status: Proposed (source candidate; not deployed)

## Context

ADR 0121 makes a task card follow its background work. A normally ended turn can still have unfinished acceptance criteria, including when a folder permission request is pending. Mapping every successful work ending to task `done` falsely completes that card. The previous implementation also read the issue before entering its update transaction, so a criteria or status edit committed in that gap could be ignored.

## Decision

In `setWorkIssueState`, read and lock the issue row inside the transaction before choosing and writing its automatic state. Status and acceptance criteria are on that same row. The existing `SELECT FOR UPDATE` pattern serializes this decision with writes to that row; the function acquires no work or run locks inside that transaction, and its callers end their work-update transactions before calling it.

A successful background ending completes the task only when all its existing criteria are checked. With any unchecked criterion it retains the current stage. Empty criteria retain the prior automatic-completion behavior. Review remains review, a canceled task remains canceled, and an explicitly completed task remains done. Failed and stopped work retain their previous badge/stage behavior. Work completion and its report still occur; this guard changes only the linked task's automatic state. Progress updates remain activity events, and no automatic `done` event is emitted when the guard keeps the current stage.

This is a guard on one automatic transition, not a new permission or verification system. Explicit status changes by a person or an authorized agent retain their current behavior, including explicit `done` with unchecked criteria. A later manual uncheck can leave a previously completed task done. Checked criteria are not independent proof of acceptance. This change does not infer pending approvals, resume a parked permission request, enforce child-task completion, or turn all existing `done` tasks into verified results.

## Verification and limits

The regression suite drives the existing background-work lifecycle with isolated database fixtures and a fake provider: unchecked, mixed, all-checked and empty criteria; todo, working, review, canceled and explicit done; failed/stopped work; and explicit authorized-agent completion. Transaction-entry edits deterministically verify that a newly committed unchecked criterion or explicit review/canceled/done status is read afresh. A later manual uncheck documents the guard's boundary.

Two additional tests are gated on `TEST_DATABASE_URL`: a writer holds an uncommitted criterion/review edit until the automatic transition enters its transaction, then commits. They have a bounded writer watchdog and always release/settle their transactions. They are skipped by the local PGlite run; the existing PostgreSQL integration owner must execute them. The deterministic local fixtures do not prove real cross-connection locking or installed-runner acceptance. Those remain integration-owner validation gates. The source change adds no schema, migration, dependency, service, tool, permission, or new status. Reverting it restores the prior automatic transition without changing stored criteria.
