# Te CI S3 readiness

## Spec
The user requested all release blockers fixed and an independent OpenRouter review. The current container harness sleeps a fixed three seconds before backup. Replace this timing assumption with bounded observed readiness on the same private Docker network. Do not change mission behavior or mask the separately diagnosed full-CI timeouts.

## Global Constraints
- Worktree `/Volumes/James 4TB SSD/James-M3Max/AgentStorage/Workspaces/ac-mcp-free-agent-model-20261124`, branch `feat/ac-mcp-free-agent-model-20261124`, base `67b2b86febcfce484ab9e960c5b38c7ec9ad379f`. Root-created plan is the only initial untracked file.
- One writer. Change only `scripts/delivery/container-boot.sh`, its focused `container-boot.test.mjs`, and this plan. Preserve all daemon identity, exact-source, fixture-env, ownership and cleanup guards.
- No live Docker operations or production changes in this task. Existing full22 continues in a distinct worktree; do not cancel or edit it. No model/provider calls, credentials, GitHub Actions, global settings, signed statuses or subagents.
- Scoped commit with [skip ci]; no push. Root handles review, final exact-head CI and OpenRouter follow-up.
- Bun is `/Users/jamesau0723/.local/bin/bun`; Bash 5.3 is `/opt/homebrew/bin/bash`; macOS /bin/bash 3.2 compatibility must remain.

### Task 1: Observe S3 readiness before starting a backup
1. Read applicable AGENTS instructions and the current harness/tests. Use the already running isolated application container to probe `http://$s3_container:8080` from the Compose network. A host curl cannot resolve this Docker-only name and the fixture publishes no S3 host port.
2. Replace the fixed sleep with bounded retries and a per-request HTTP timeout. Use the application's existing Bun runtime, pass the exact generated endpoint as an argument, and accept a defined successful/expected unauthenticated S3 response. Refuse persistent transport/5xx failures. No fallback endpoint, host port, or additional background service/container.
3. Use a small fixed retry count and delay with a clear upper bound (for example 30 attempts, 2-second request deadline and 1-second backoff). Exhaustion must fail before `backup now`, retain the existing exit/cleanup behavior, and provide a useful bounded diagnostic.
4. Add behavioral regressions to the existing fake-command harness: delayed readiness retries before any backup; permanent unavailability never starts backup and fails with owned cleanup; immediate readiness still backs up/restores. Keep prior inherited-S3 and scratch-cleanup regressions. Demonstrate new regressions fail on the old fixed-sleep code and pass after repair. Do not add retry-on-test-failure behavior or change test assertion coverage.
5. Run the focused harness tests and relevant delivery tests, ShellCheck, both Bash syntax checks, scoped formatting and git diff checks. No full CI rerun or real image build here; root's final full22 includes the real container/backup path.
6. Commit only scoped code/tests/plan and write task-1-report.md beside this task's brief with exact commands/results, bound, red/green evidence, commit and limitations. Return concise status/commit/test summary.

## Acceptance
- Backup starts only after observed readiness inside the actual Docker network.
- Delayed and never-ready paths are covered, cleanup preserves the original failure, and no unrelated runtime changes occur.
