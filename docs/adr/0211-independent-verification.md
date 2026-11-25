# 0211. Independent verification of a task against its completion contract

- Status: Proposed
- Date: 2026-11-25
- Builds on: ADR 0017 (outcomes), ADR 0056 (operator API), ADR 0186 (unchecked criteria stop auto-done), ADR 0202 (owner epoch), ADR 0209 (evidence-bearing task delivery), ADR 0204 (founder status from evidence), ADR 0206 (traceability), ADR 0207 (cost per verified success)
- Code: `packages/engine/src/completion-contract.ts` (`contractOf`, `contractHash`, `assessCompletion`, `verdictOf`, pure), `packages/engine/src/verification.ts` (`setCompletionContract`, `verifyTask`, `implementersOf`, `writesImplementation`, `recordTestReceipt`), `founder-status.ts` (`verification`, `taskEvidenceRows`, `taskContract`), `cost-per-success.ts` (successes and `claims`), `issues.ts` (the `issue_closed` claim), migration `packages/db/migrations/0285_issue_completion_contract.sql`; routes `PUT …/issues/{issueId}/completion-contract`, `POST …/issues/{issueId}/verification` (`apps/server/src/routes/app/issues.ts`), operator `POST /orgs/{orgId}/test-receipts` (`apps/server/src/operator/deploys.ts`); tests `packages/engine/test/verification.test.ts`, `founder-status.test.ts`, `cost-per-success.test.ts`, `apps/server/test/founder-status.test.ts`, `apps/server/test/operator.test.ts`

## Context

ADR 0204 made a task's founder status honest about delivery: merged code is not "available" until this server runs a deploy that holds it. Verification stayed weaker. A task read "verified" when people had ticked every criterion, and nothing named a verifier, nothing checked that the person ticking was not the one who did the work, and nothing said what evidence "done" needed beyond the ticks. ADR 0186 only stops one automatic move to Done. So an agent saying it finished, or a screen showing Done, was still the closest thing to proof for most work, and the usage report's "cost per verified success" (ADR 0207) inherited that.

## Decision

### 1. A completion contract per task

`issues.completion_contract` (jsonb, null by default) says which evidence a "verified" needs, from a fixed list:

- `criteria`: every acceptance criterion checked (by anyone; the verifier confirms them).
- `person_vouched`: a `criteria_met` outcome with every criterion checked by a person, not reopened since.
- `pr_merged`: a `pr_merged` outcome with its merge commit for one of the task's pull requests, not reverted.
- `deploy_running`: the founder status's delivery is `available`: a deploy record holds the merge commit and this server's own source digest equals that deploy's now. A stale deploy (digest mismatch), a rollback or a server that can't say what it runs fails it.
- `tests_passed`: a test receipt (§3) for the merge commit, the suite the contract names and the test files' digest the contract pinned.

A task with no contract gets the default, `criteria`. Only people set a contract, never one of the task's implementers (§2), and every change is audited (`task.contract_set`). A claim of done (`status = done`) is required for every contract; it is never itself evidence.

### 2. An independent verifier

`verifyTask` records a verdict, `task_verified` or `task_rejected`, as an outcome (source `issue`) and an audit row (`task.verified`, `task.rejected`). The verifier is a person or an agent who is none of the task's implementers: its assignee, an agent that created it, any agent with a run on it (`agent_runs.issue_id`), and whoever claimed it done. An agent verifier must also have no write access to the implementation: no `sandbox:run`, `ci:run`, `connector:*` or GitHub scope beyond `github:read`. Either refusal is 403 `self_verification` / `verifier_can_write`, and nothing is written.

"Verified" is accepted only when the server's own check of the stored evidence meets the contract at that moment (the running digest included); otherwise 409 `evidence_missing` with the missing reasons, and nothing is written. A verifier can reject anything, but needs reasons. A verdict carries the hash of the contract and the criteria's words it was given against, the evidence rows it rests on, the implementers it was independent of, and the digest the server ran.

### 3. Test receipts come from CI, not from agents

The operator API gains `POST /orgs/{orgId}/test-receipts` (`{ repo, commit, suite, testsDigest, passed }`), written as `tests_passed` / `tests_failed` with source `operator`: only a holder of the operator token (CI) can write one. A contract's `tests_passed` reads only operator-sourced receipts. A receipt an agent's tool or run recorded (`tests_receipt_untrusted`), one about another commit (`tests_wrong_commit`), one whose test files' digest differs from the pinned one (`tests_changed`, the grader-edit case) or a newer failure (`tests_failed`) never passes.

### 4. Who reads it

- **Founder status (ADR 0204).** Verified only when the verdict in force is `task_verified`, it was given against the current contract and criteria, it is not by an implementer, and the evidence still meets the contract now. A later reopen or a new claim of done clears the verdict; a later deploy that the server no longer runs makes it `stale`. A rejection shows its reasons and sends the next step to the assignee. People's ticks alone (`criteria_met`) are evidence, no longer verification.
- **Cost per verified success (ADR 0207).** A success is a task whose verdict in force is `task_verified` against its current contract. It does not recheck the running digest: the report prices what was verified when it was.
- **False-pass counts.** The same report returns `claims`: tasks claimed done in the window (`issue_closed`, now recorded for every move to Done, by whoever made it), how many are verified now, how many a verifier rejected after the claim, how many are unverified, and `falseClaimRate` = rejected after claim / claimed. Read only, under `view_usage`.

### 5. Nothing new to look at or be notified by

No dashboard, no notification kind, no new approval. The verdict is an outcome and an audit row; the founder status line and the usage report read it. Outcomes already feed learning (ADR 0017): a person's verdict counts as an outcome a person stands behind, an agent's does not.

### 6. Beside ADR 0209's delivery contract

ADR 0209 is an opt-in workflow across three tasks (a parent, its implementation and an independently owned QA task) that ends in a person accepting the parent. This decision is per task and applies to every task: whatever closes a task, its "verified" is a verdict over stored evidence. The two don't conflict: a QA pass under ADR 0209 is a claim about a submission, and the QA agent may then be the task's verifier here if it is independent by §2; making a QA pass also record `task_verified` is a later change.

## Consequences

- A task closed by an agent reads "done, not verified" until someone independent confirms it, including tasks that people ticked: that is the honest answer, and the next step names the verifier.
- `deploy_running` and `tests_passed` stay unmet until the deployer posts deploy records (ADR 0204) and CI posts test receipts. Contracts that require them make that the visible blocker.
- The test files' digest is computed by the caller (CI) and pinned by the person who sets the contract; the server compares, it does not compute either. A changed suite is a new contract, set by a person.
- Agents can be verifiers in the engine; exposing that as an agent tool is a later, separate change.

## Rejected

- **A `VERIFIED_COMPLETE` task status.** A second status to keep in step with the board and its automation; the verdict as an outcome, re-read against live evidence, can't drift.
- **A verifications table.** Outcomes are already the append-only ground-truth log every reader joins (ADR 0017); a second log would need the same reads twice.
- **Letting a person's ticks stay "verified".** The person ticking may be the one who did the work, and ticks say nothing about a deploy or tests.
- **Accepting test outcomes from the GitHub connector or agents' tools.** Anything an implementer can call, it can call with the answer it wants.
