# 0204. A task's founder status, derived only from stored evidence

- Status: Proposed
- Date: 2026-11-19
- Builds on: ADR 0017 (outcomes), ADR 0056 (operator API), ADR 0121 (blocked work on a card), ADR 0126 (who decides an approval), ADR 0156 (GitHub App events), ADR 0173 (approve always)
- Code: `packages/engine/src/founder-status.ts` (`deriveFounderStatus`, `founderStatus`, `recordMergeEvidence`, `recordDeploy`, `mergeDetailsOf`), `git/github-events.ts` (`queueGitHubAppEvent`), `connectors/mcp.ts` (a merge's commit), routes `GET /api/app/organizations/{orgId}/issues/{issueId}/founder-status` (`apps/server/src/routes/app/issues.ts`) and operator `POST /orgs/{orgId}/deploys` (`apps/server/src/operator/deploys.ts`), web `apps/web/src/components/FounderStatus.tsx` on the task page; tests `packages/engine/test/founder-status.test.ts`, `apps/server/test/founder-status.test.ts`, `apps/server/test/operator.test.ts`, `apps/web/test/founder-status.test.tsx`

## Context

A founder reading a task wants six answers: what changed and why it matters, whether it is in the app people use now, what is verified and what is only built, what blocks it, who acts next, and whether they must decide anything. Today those answers are spread over the task's status, its criteria, the agent's words in the conversation and approval cards, and the most fluent of them (an agent's summary) is the least reliable: a task shows "done" when its work ended with every criterion ticked, even by the agent itself, and a merged pull request reads like a delivered feature although nothing says the running server has it.

The server can now say which source it runs (its own source identity, reported by `/api/health`), and outcomes (ADR 0017) already hold merges, reverts, deploys, rollbacks, CI and `criteria_met` (which only people's ticks record). What was missing is a projection that joins them, and the two facts nobody stored: a merge's commit, and which commit a deploy holds.

## Decision

### 1. A pure projection, words from templates

`deriveFounderStatus(evidence)` takes the task's row, the outcomes about it, the reader's pending decisions and the server's identity, and returns codes plus one Hong Kong Traditional Chinese line per answer, from fixed templates. No model writes or rewrites any of it. What no evidence says stays unknown, and is said to be unknown. It is pure, so every rule is a unit test.

- **What changed, why.** The task's title and linked pull requests. "Why it matters" is the first paragraph of the description only when a person created the task: an agent's description is no reason, and the line says none was written.
- **Available in the running app.** Only when all hold: a `pr_merged` outcome for one of the task's pull requests carries its merge commit; a `deploy_succeeded` record names that commit (or lists it among the commits it holds); no revert after the merge and no rollback after the deploy; and that deploy's source digest equals the digest this server computes of itself now. A merge without a deploy, a deploy the server no longer runs, and a server that cannot say what it runs each have their own state, none of them available.
- **Verified versus implemented.** Verified only with a persisted `criteria_met` outcome, no `issue_reopened` since, and every criterion still checked by a person. A task marked done without that is "done, not verified". CI and test outcomes are listed as supporting checks and never make a task verified. A task with no criteria has nothing to verify against, and says so.
- **Blockers.** The task's own `blocked` record (ADR 0121), and a run that failed on a tool effect nobody knows (`run_effect_unknown`) until a later run of the task ends cleanly.
- **Next action and owner.** The first that applies: the reader's decision; checking an unknown effect; unblocking; implementing or merging (the assignee); recording the merge commit, deploying or checking the runtime (owner unknown: no record names who deploys); verifying (the person who created the task); nothing.
- **Needs me.** Only a pending, unexpired approval on one of the task's runs that the reader may decide (`listApprovals`' own `canDecide`, covers included). A blocked card, a waiting run or failing CI is never a decision. A pending request for an action already approved and not yet run (the same action hash) is left out: it is already authorized.

### 2. Two writers for the missing facts

- **The merge commit.** A merged `pull_request` webhook of a bound installation records `pr_merged` with `merge_commit_sha`, once per subject and commit, whoever merged, the app's own bot included (agents never hear that event, but the merge is still ground truth). An agent's own merge through the GitHub connector keeps the commit from GitHub's answer.
- **The deploy.** `POST /api/operator/v1/orgs/{orgId}/deploys` with `{ repo, commit, commits?, sourceDigest }`. The caller (whoever deploys, e.g. a release script that computed the digest with `scripts/runtime-identity.ts rev`) vouches commit to digest; the server writes the record only when that digest is its own running identity, else 409 `deploy_not_running`. So no record can claim a deploy that is not the one serving, and the status rechecks the digest at every read, so a later deploy makes the old one read as no longer running.

Both are ordinary `outcomes` rows (source `webhook` and `operator`): no new table, no migration.

### 3. No new notifications, no new asks

The status is read on the task page, under the agent's work, as one more section. "Needs you" links to the approval's existing details, where it is decided. Nothing here notifies, posts or asks: the approval already notified whoever decides it once, so there is nothing to duplicate. A phone screen and a push digest can read the same route later.

## Consequences

- A merged-but-not-deployed task never reads as available, a task marked done without a persisted outcome never reads as verified, and "Needs you" appears only with a real pending decision. Each is a negative-control test.
- Until a deploy record is posted after each deploy, every merged task reads "merged, not deployed". That is the honest answer, not a bug: posting it is part of deploying.
- A deploy record lists the commits it holds as its caller vouches them; the server checks the digest, not the history. A merge older than the deploy but missing from `commits` reads as not deployed, the safe side.
- The words are Hong Kong Chinese for every reader, by decision for this workspace's founder. The codes beside them let another language word them later without changing what they mean.

## Rejected

- **A model summary over the same data.** Fluent text over stale or partial evidence makes a wrong "done" more convincing. Templates are fixed and tested.
- **Comparing the running digest with the merge commit's own digest.** Any later merge changes the digest, so a delivered task would read unknown after the next deploy. A deploy record with the commits it holds keeps the answer.
- **A separate founder dashboard and its own notifications.** A second place to look and a second notice per decision. The task page and the approval card already exist.
