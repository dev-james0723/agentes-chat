# Delivery Guardian

Read-only Git observation, pure evidence preflight, and a supplementary repository-local pre-push guard. Node 22+; no dependencies. Preserve existing native tasks, reviewers, permissions, skills, dashboards and deployment ownership.

```sh
node --test scripts/delivery/*.test.mjs
node scripts/delivery/guardian.mjs observe --root /exact/task/worktree --remote origin --network --text
node scripts/delivery/guardian.mjs check-checkpoint --root /exact/task/worktree --remote origin --scope /private/task-scope.json
```

`observe` never fetches or writes Git refs/index, commits, pushes, merges or deploys. Networking is opt-in. Select the actual HTTPS GitHub remote, not a local clone named origin. A clean tree proves neither remote synchronization nor live deployment. JSON and text modes preserve failure exit codes. Codes: 0 observation/preflight successful, 1 observed blocker, 2 invalid invocation/error.

Task scope is an externally authorized private object: repository (owner/name), branch, exact head SHA, nonempty exact paths, authorized and writerConfirmed. A caller asserting these flags does not create authority. The native owner, lease and permissions must verify them. Foreign staged files, secrets paths, symlinks, stale observations, moved HEAD, protected branches and unexplained deletion are refused.

`check-release --evidence receipt.json` is only a pure policy assessment, **not an authentication service, signed attestation or release command**. The native trusted publisher must obtain check/review provenance independently and compare the current PR head. Required checks are unit, typecheck, lint, boundaries, build, secrets and regression; extra checks may be added but these cannot be removed. They must succeed on the exact SHA. Missing, skipped, stale, duplicated or untrusted results fail. Independent review, authorization, no active work, exclusive deployment lease, tested backup/restore, stage, rollback and runner compatibility are separately required. Nothing here auto-promotes a caller-supplied JSON receipt.

## Pre-push integration

Install `push-guard.mjs` and `policy.mjs` from a reviewed, pinned commit in the repository's common Git metadata, then invoke it from that repository's `pre-push` hook with the exact expected owner/name followed by Git's two hook arguments. Forward stdin unchanged. Use a trusted absolute Node binary. Do not overwrite an existing hook, set global core.hooksPath, execute scripts from an arbitrary branch, or affect other repositories. Preserve the former hook/config for rollback; test the installed hook using a synthetic forbidden-main input before relying on it.

The guard refuses direct protected-branch pushes, multiple refs, deletion, wrong repository, mismatched HEAD/ref, credential files, symlinks, large changes and suspicious secret patterns. It inspects unpublished commit history, including a secret later removed. Cached remote refs are observation inputs, not trusted attestations. Refresh remote state before release. The heuristic is deliberately conservative and is **not a replacement for a maintained secret scanner**. A passed push is not a test/review/merge/deployment receipt.

A local hook is cooperative: administrators, direct API operations and `--no-verify` can bypass it. Do not claim this is sandboxing or organization-wide enforcement. Protect the remote default branch with fresh required checks and independent review, and retain native authorization. Unattended observers report only; they do not gain permission to merge from retrieved text.

## Evidence and rollback

Use the existing task ledger and dashboard, not a second orchestrator. Record coded, tested, committed, pushed, reviewed, merged, built, deployed and live-verified separately, with timestamp, exact source SHA, server digest, runner digest and real user-path checks. A container health response or image tag is not content identity. Unknown remains unknown. Preserve old images/data and coordinate the existing deployment lock. Remove only this task's exact installed hook to roll it back, never another process's lock or worktree.

Publish generic code only. Keep account identifiers, absolute personal paths, credentials, environment files, internal receipts and private document packs outside a public repository.
