# 0206. Requirement traceability on existing records, and an ADR for every package

- Status: Proposed
- Date: 2026-11-19
- Builds on: ADR 0017 (outcomes), ADR 0156 (GitHub App events), ADR 0204 (founder status from evidence)
- Code: `packages/engine/src/traceability.ts` (`deriveTraceability`, `traceability`), `founder-status.ts` (`deliveryOf`), route `GET /api/app/organizations/{orgId}/traceability` (`apps/server/src/routes/app/issues.ts`), `scripts/check-boundaries.ts` (`unrecordedPackages`); tests `packages/engine/test/traceability.test.ts`, `apps/server/test/founder-status.test.ts`, `scripts/check-boundaries.test.ts`

## Context

A founder handing work to agents needs to ask two questions without reading every conversation: which of my requirements is delivered, and which change belongs to which requirement. They also need to notice when the same feature was asked for twice, or code shipped that no task asked for. The pieces exist: tasks have sub-tasks (`issues.parent_issue_id`) and labels, tasks list their pull requests, the GitHub webhook records each merge with its merge commit (ADR 0204), and the operator API records which commit a deploy holds, accepted only when this server runs it. Nothing joined them per requirement.

## Decision

### 1. A requirement is a task labelled `requirement`

No new table or column. A requirement is a task whose labels include `requirement` (any case); its tasks are its sub-tasks, or the requirement itself when it has none but lists pull requests. Reusing the label and the parent link keeps one task truth: the board, the task page and the agents' tools already read and write both.

### 2. Delivered uses the founder status's own rule

Each pull request of a task is one change, its state computed by `deliveryOf` with the rows about that pull request and its repository's deploys, the same function behind a task's founder status. A requirement is `delivered` only when it has tasks, every task is closed with at least one done, at least one change is `available` (a deploy record holds its merge commit and this server runs that deploy's source now), and no change is merged but not running (`merged_not_deployed`, `deployed_not_running`, `rolled_back`, `runtime_unknown`, `merge_commit_unknown`). Unmerged and reverted pull requests count for nothing. Otherwise it reads `no_tasks`, `in_progress`, `done_undelivered` or `canceled`.

### 3. Three flags

- `unlinked_merge`: a `pr_merged` record whose pull request no task in the workspace lists (checked over every task, so a task the reader can't see doesn't make a merge look unlinked).
- `done_without_delivery`: a requirement whose tasks are all closed but which is not delivered.
- `duplicate_requirement`: two open requirements whose titles match once case and punctuation are ignored. Exact duplicates only: a looser match would be a judgment, and this projection makes none.

### 4. One read, no new writes

`GET …/traceability` lists the requirements and tasks the reader can see (`listIssues`), with the flags. It writes nothing, notifies nobody and asks nothing.

### 5. Every package is recorded in an ADR

`bun run check:boundaries` now fails when a folder under `apps/` or `packages/` with a `package.json` is named by no ADR, by its path (`packages/engine`) or its package name (`@agenteschat/engine`), as a whole word. A new top-level package or app is an architecture decision, and its ADR is where the next agent finds why it exists before adding a second one. Every current package already passes.

## Consequences

- Until a deploy record is posted after each deploy, every requirement with merged work reads `done_undelivered`: the honest answer.
- Requirements only trace once someone labels them and files tasks under them; unlabelled work shows up only as unlinked merges, which is the nudge.
- The duplicate flag misses differently worded duplicates. Catching those needs search or a model; it can be added later beside this list without changing what `delivered` means.
- The ADR check reads names, not imports: an ADR that merely mentions a package satisfies it. It guards against silent new packages, not against wrong designs.

## Rejected

- **A requirements table and trace-edge table.** A second task truth to keep in sync with the board; the label and the parent link already say it.
- **Delivered when the tasks are done.** Done is a claim; merged code that no running server holds is not delivered.
- **Running dependency-cruiser for the architecture check.** A new dependency for a rule a few lines enforce.
