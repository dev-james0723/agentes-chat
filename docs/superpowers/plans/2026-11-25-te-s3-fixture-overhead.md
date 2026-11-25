# Remove avoidable bookkeeping processes from the S3 CI fixture

## Global Constraints

- Work only in ac-te-s3-fixture-overhead-20261125 at base b632fc0d8e454a188bb93360461a9796512f6376. Allowed tracked files: scripts/delivery/container-boot.test.mjs and this plan. No production script, dependencies, CI command, guard, retry budget, watchdog, environment policy or assertion relaxation.
- Preserve 30 production attempts, 29 backoffs, separate fake-command process boundaries, exact timeout/rclone/sleep arguments, fake environment checks, killed-process simulation, trace assertions, exit-status propagation and cleanup assertions. The existing spawnSync timeout10000 stays unchanged.
- Remove only avoidable external bookkeeping commands in probeCommands: external basename becomes POSIX shell parameter expansion; grep-based probe counting becomes a shell read/case loop with equivalent matching. Correct JavaScript template-literal escaping must emit actual shell expansion, not a literal backslash. Both supported Bash paths must retain the same behavior.
- No live Docker, production, browser/UI, provider, OAuth, credentials, push or merge. Commit locally with [skip ci]. No new services or test retry loop.
- Run bounded source/fixture verification under the existing unmodified CI admission guard. Max21 is parallel slots, not load. A documented WAIT=0 admission attempt is allowed. Record refusals/failures honestly. Frozen dependency materialization is allowed if necessary, with no lockfile edits.

## Evidence and uncertainty

The b632 canonical guardian stage finished149passed/1failed in43.3seconds. The persistent-service fixture timed out at spawnSync bash with a configured10000ms watchdog; whole-case time14839.047ms can include termination/cleanup. Raw guardian.log SHA5ac4b2d0c4211db8f6d707aa604fe1cc683e2bd24c7d9ae968e321dadd37ffd7. Host observations showed broad slowdown and load197–243; a particular causal child/phase is unproven because the fixture deleted its temp trace. No real sleep is intended in this mock path.

Source accounting establishes119 unnecessary external bookkeeping calls on a complete persistent-failure path:89 basename and30 grep. Removing them is a targeted fixture efficiency improvement, not proof that the historical failure was caused solely by these calls. Actual unchanged-watchdog validation must determine the result.

## Task 1: Replace external bookkeeping with equivalent shell builtins

Inspect the current probeCommands helper and make the minimum edit described above. Preserve every existing assertion, scenario, timeout and process boundary. Keep the exact prefix matching semantics and trace behavior; temporary fixture paths and lines are controlled, but do not accidentally count other commands or mishandle a missing/empty trace. Do not broaden to refactoring Docker stubs, general harnesses, concurrency or unrelated tests.

Run the existing container-boot.test.mjs fixture file once with its original cases and watchdog, plus relevant syntax/format checks. If needed, one focused shell-output inspection may validate emitted expansion without running a production script. Do not invent a test that mirrors the implementation or run stress/retry loops. Root owns the canonical guardian and full22 runs after review.

Write .superpowers/sdd/2026-11-25-te-s3-fixture-overhead/task-1-report.md with exact commands/output, actual case counts/timings, source hashes, unchanged watchdog/assertion checks and limitations. The prior guardian failure is preserved red evidence; do not force another resource-heavy reproduction. Independent task review and OpenRouter final source review must precede acceptance.
