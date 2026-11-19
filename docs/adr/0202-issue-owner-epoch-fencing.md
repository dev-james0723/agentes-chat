# 0202 — Issue owner epoch, fenced at the Tool Gateway

Status: accepted (source; not deployed). Extends ADR 0015 (Tool Gateway), ADR 0121 (background work and its card) and ADR 0145 (a task's conversation).

## Problem

A task changes hands: a person reassigns it, an agent hands it to another, it is canceled, or its background work is stopped. The run that was working on it may still be alive (a long model turn, a computer brain, a paused run resumed later). Until now nothing stopped that run from writing the task afterwards: it could set the status to done, tick criteria or post progress over the new owner's work. Two agents taking an unassigned task at the same moment also both "won": the last write decided the assignee. A timeout cannot fix this, since a paused process can outlive any lease and still write; the write itself has to refuse a token that is no longer current.

## Decision

1. **Every issue has an owner epoch** (`issues.owner_epoch`, integer, default 0). An issue made with an assignee starts at 1 (its first claim). The epoch moves on, by one, on:
   - a change of assignee (a person's reassignment, an agent's handoff with `update_issue`, `askAgentToImplement` giving it to another agent),
   - a claim (`claimIssue`, or `update_issue` assigning it to the calling agent),
   - a cancellation (status `canceled`), and stopped background work (`setWorkIssueState` with `ended: "canceled"`).
   Other edits (title, priority, criteria, labels, comments) leave it as it is.

2. **Moving the epoch is a compare-and-set.** `updateIssue` decides the move on the epoch it read (or on `expectedOwnerEpoch`, which `claimIssue` passes) and writes `owner_epoch = owner_epoch + 1 … where owner_epoch = expected`. Zero rows means someone else moved it first: a `ConflictError` with code `issue.owner_epoch_conflict`, and the caller reads the task again rather than retrying over the winner. Two claims on the same epoch: one owner.

3. **A run carries the epoch it was tied under** (`agent_runs.issue_epoch`, nullable). A run is tied to one issue the way it already was (`agent_runs.issue_id`: asked to implement it, the first issue tool call on it, its background work's card), and now also keeps that issue's epoch at that moment. The run that claims a task is moved onto the new epoch; any other run that writes during a handoff is tied at the epoch it wrote under, so its own handoff leaves it stale.

4. **The fence is at the execution boundary, twice.**
   - At the Tool Gateway: every `issues:write` call goes through a connector-wide per-call check (`tools/checks.ts`, the same place that holds GitHub calls to the agent's repositories). When the issue a call names is the one the run is tied to and the issue's epoch is past the run's, the call is refused before the tool runs, with `data.code = "issue.owner_epoch_stale"`, recorded as `refused` in the audit log. The tool list is not filtered: the run still sees and may call the tools; the call is what is refused.
   - At the write: `updateIssue` reads the issue's epoch under its row lock (`for update`) in the same transaction as the write when the actor is an agent's run, and `commentIssue` and `setCriterion` check before writing. A run that passed the gateway just before a handoff is still refused (`ConflictError`, same code), and the issue tools keep the code on their result.

5. **Scope: one task, nothing else waits.** Only the issue a run is tied to is fenced for that run. Other issues, and child tasks (each has its own epoch, untouched when its parent changes hands), are not. People's own writes (the app, the API) are not fenced. Runs tied before this change have no epoch (`issue_epoch` null) and are never fenced. No lock is held beyond one short transaction, so unrelated work is never serialized.

## What it does not cover

- Writes that don't go through our task code: a computer brain's shell, a connected app or a person's other tools. Those are collaboration, not enforcement, as before.
- Effects outside the task itself (a pull request opened, a deploy) before the refusal. The fence stops the task's own state from being overwritten by a stale run; it cannot undo something already sent.
- `commentIssue` and `setCriterion` check without holding the row lock across the post; a handoff that lands between the check and the post can let one last comment through. `updateIssue`, which changes status and owner, checks under the lock.
- No lease or heartbeat: the epoch moves only when a person or an agent changes the owner, so a run that is merely slow is never fenced on its own.

## Alternatives considered

- **Filtering the tool list for stale runs.** Rejected: a computer brain's harness may keep the list it started with, and a list is advice, not a check at the write.
- **A lease with expiry on each task.** Rejected for now: it needs heartbeats from every brain and still needs a fencing token at the write to be safe; the epoch is that token, and a lease can be added on top later.
- **Advisory locks per task.** Rejected: held across a model turn they would serialize unrelated work and do nothing for a process that resumes after the lock is gone.

## Migration

Additive only: `issues.owner_epoch integer not null default 0`, `agent_runs.issue_epoch integer`. Existing tasks start at 0 and existing runs stay unfenced.
