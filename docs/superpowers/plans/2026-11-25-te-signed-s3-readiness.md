# Te signed S3 readiness repair

## Spec

James authorizes fixing release blockers and completing the native Te MCP release with independent review and genuine local CI. This task repairs the observed S3 readiness failure; it does not activate production or grant OAuth.

## Global Constraints

- Work only in the existing isolated feature worktree at base `8c0e433236c3bd28d1504b4ba6f6ae1226983660`; preserve all other changes. Commit with `[skip ci]`. No GitHub Actions, pushes, merges or deployment from the implementer.
- Change only `scripts/delivery/container-boot.sh`, `scripts/delivery/container-boot.test.mjs`, and this plan. Keep application, backup service, dependency, timeout and unrelated test behavior unchanged.
- Use the existing fixture endpoint and backup image/client. Readiness must be a successful authenticated, read-only S3 root ListBuckets, without requiring a particular bucket or object and without accepting anonymous 400/403 as readiness.
- Create one short-lived `compose run --rm --no-deps -T` backup client on the existing project network. It must not start a backup scheduler, app, migrations or unrelated services. Credentials stay in environment variables, never command arguments or diagnostics; use the same S3 configuration/defaults as `deploy/backup/backup.sh` and `RCLONE_CONFIG=/dev/null`.
- Retain at most 30 attempts, a hard two-second process bound per actual rclone operation and one-second delay between failed attempts only. Disable rclone high/low-level retries. No unbounded subprocess or increased retry/deadline budget. No fixed sleep as the readiness decision.
- Failure must stop before `backup now`, retain the original failure status through cleanup, and clean up the run-once fixture plus project resources. Keep real backup/fetch/restore assertions intact.
- Local-only targeted tests are authorized. Do not start full CI, Docker fixtures, production services, UI, OAuth or provider calls; root separately coordinates a genuine isolated container boot/backup/restore and full22 after review.
- Preserve failed receipts. Source or mock test approval is not a successful container boot or release acceptance.

## Task 1: Replace anonymous status probing with bounded signed root readiness

Read these existing sources first: `scripts/delivery/container-boot.sh`, its test, `deploy/backup/backup.sh`, and the backup service in `docker-compose.yml`. The current anonymous Bun GET fails after 30 attempts with final HTTP400 in the actual717 fullCI, before backup. The actual response body was not recorded, so do not claim a specific historical S3 error code.

Implement the narrow signed readiness change under the Global Constraints. Execute the actual inline client shell through meaningful fixture stubs that assert the supplied environment/config, root S3 operation and timing controls, rather than replacing the readiness block itself with a synthetic pass. Cover a successful signed empty-root listing, transient connection/auth failure then success, persistent authentication/service failure, and process timeout/exhaustion. Verify exact bounded attempts/backoffs, backup happens only after success, and cleanup preserves failures. Retain the inherited-S3 isolation and backup-failure cleanup regressions.

First demonstrate a relevant new regression failing on the old implementation and preserve the log. Then run covering tests on the new implementation under both macOS Bash3.2 and Homebrew Bash5.3, the existing delivery script test suite once, shell syntax/ShellCheck and formatting/diff checks that apply. No retry loop on an unchanged failing SHA. Prefer the existing tests and fixtures; avoid new dependencies or general-purpose abstractions for this single probe.

Self-review and commit the scoped change. Record exact commands, tool versions, test output paths, hashes and results, files changed, and any uncertainty. The real fixture diagnostic is a separate read-only session; use its confirmed command/evidence when root provides it, but do not misrepresent an unobserved result.

### Acceptance

The signed request succeeds for an available authenticated S3 service even when no backup objects exist. Connection/auth failures remain bounded and fail closed; cleanup runs; actual backup and restore are still required by the canonical container test. The task's source acceptance requires independent Spec PASS and Quality Approved. Root will then validate real container boot and the final exact-head full22.
