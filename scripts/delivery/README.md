# Delivery Guardian

Read-only Git observation, pure evidence preflight, and a supplementary repository-local pre-push guard. Node 22+; no dependencies. Preserve existing native tasks, reviewers, permissions, skills, dashboards and deployment ownership.

```sh
node --test scripts/delivery/*.test.mjs
node scripts/delivery/guardian.mjs observe --root /exact/task/worktree --remote origin --network --text
node scripts/delivery/guardian.mjs check-checkpoint --root /exact/task/worktree --remote origin --scope /private/task-scope.json
node scripts/delivery/guardian.mjs observe --root /exact/task/worktree --remote origin --runtime-url https://your-server --text
```

`observe` never fetches or writes Git refs/index, commits, pushes, merges or deploys. Networking is opt-in. Select the actual HTTPS GitHub remote, not a local clone named origin. A clean tree proves neither remote synchronization nor live deployment. JSON and text modes preserve failure exit codes. Codes: 0 observation/preflight successful, 1 observed blocker, 2 invalid invocation/error.

Task scope is an externally authorized private object: repository (owner/name), branch, exact head SHA, nonempty exact paths, authorized and writerConfirmed. A caller asserting these flags does not create authority. The native owner, lease and permissions must verify them. Foreign staged files, secrets paths, symlinks, stale observations, moved HEAD, protected branches and unexplained deletion are refused.

`check-release --evidence receipt.json` is only a pure policy assessment, **not an authentication service, signed attestation or release command**. The native trusted publisher must obtain check/review provenance independently and compare the current PR head. Required checks are unit, typecheck, lint, boundaries, build, secrets and regression; extra checks may be added but these cannot be removed. They must succeed on the exact SHA. Missing, skipped, stale, duplicated or untrusted results fail. Independent review, authorization, no active work, exclusive deployment lease, tested backup/restore, stage, rollback and runner compatibility are separately required. Nothing here auto-promotes a caller-supplied JSON receipt.

## Is the server running this commit (`--runtime-url`)

`observe --runtime-url <base>` reads `<base>/api/health` once (GET, no redirects, 10 s) and compares the server's `source` (`{digest, files}`, worked out by the server from the files it actually has) with the observed HEAD's tree. `deployment.status` is then `match`, `mismatch`, or `unknown` with a reason (`unreachable`, `health_status_<n>`, `no_source_identity`, `empty_source_identity`, `too_large`). The base address takes no credentials, query or fragment, and a response over 64 KiB is not read. No files on either side is no evidence: a wrong root hashes to the same empty digest, so it is unknown, never a match. Only `match` counts: a mismatch adds `runtime_mismatch` and anything else adds `runtime_unverified`, both blockers (exit 1). Without the flag nothing is asked and deployment stays unknown.

The digest is the one `apps/server/src/source-identity.ts` reports and `scripts/runtime-identity.ts` checks: each app's and package's `src`, the server's `runner`, the migrations, every package manifest and the lockfile, each as its path and git blob id. `runtime-identity.mjs` is a plain-Node copy so the Guardian keeps no dependencies; `apps/server/test/runtime-identity-parity.test.ts` fails if the copies ever disagree. A match proves the server's source only: the runner on each computer and real user paths still need their own evidence. It does not see a file's mode (a `chmod +x` alone), symlinks, or files outside the scope (scripts, config, build output such as `apps/web/dist`), and the identity is the server's own report, read once per process (a failed first scan is retried after five minutes, so files patched after start can show then). Use `scripts/runtime-identity.ts diff --dir` to name the files of a mismatch.

## Pre-push integration

Install `push-guard.mjs` and `policy.mjs` from a reviewed, pinned commit in the repository's common Git metadata, then invoke it from that repository's `pre-push` hook with the exact expected owner/name followed by Git's two hook arguments. Forward stdin unchanged. Use a trusted absolute Node binary. Do not overwrite an existing hook, set global core.hooksPath, execute scripts from an arbitrary branch, or affect other repositories. Preserve the former hook/config for rollback; test the installed hook using a synthetic forbidden-main input before relying on it.

The guard refuses direct protected-branch pushes, multiple refs, deletion, wrong repository, mismatched HEAD/ref, credential files, symlinks, large changes and suspicious secret patterns. It inspects unpublished commit history, including a secret later removed. Cached remote refs are observation inputs, not trusted attestations. Refresh remote state before release. The heuristic is deliberately conservative and is **not a replacement for a maintained secret scanner**. A passed push is not a test/review/merge/deployment receipt.

A local hook is cooperative: administrators, direct API operations and `--no-verify` can bypass it. Do not claim this is sandboxing or organization-wide enforcement. Protect the remote default branch with fresh required checks and independent review, and retain native authorization. Unattended observers report only; they do not gain permission to merge from retrieved text.

## Evidence and rollback

Use the existing task ledger and dashboard, not a second orchestrator. Record coded, tested, committed, pushed, reviewed, merged, built, deployed and live-verified separately, with timestamp, exact source SHA, server digest, runner digest and real user-path checks. A container health response or image tag is not content identity. Unknown remains unknown. Preserve old images/data and coordinate the existing deployment lock. Remove only this task's exact installed hook to roll it back, never another process's lock or worktree.

Publish generic code only. Keep account identifiers, absolute personal paths, credentials, environment files, internal receipts and private document packs outside a public repository.

## Observation trust hardening

Git reads clear inherited repository/index/config-injection variables, suppress replacement objects, hooks and external content filters without changing repository configuration. A configured filter makes the working-tree observation explicitly unverified instead of certifying potentially different filtered content. Observation never runs a commit or other write command. Existing-branch push checks use the server-advertised previous commit and require fast-forward ancestry, even if a cached tracking ref already contains the candidate. New-branch history still uses cached remote refs as a bounded supplementary scan, not an authenticated full-history secret guarantee. A maintained secret scanner and independent release checks remain required.

A JSON file supplied to the CLI cannot authenticate its own checks: `check-release` is always an assessment-only, untrusted-file result. Its caller-provided `trustedChecks` flag is ignored. The pure policy function is for a future trusted native integration, not proof that such an integration is installed.
