# Routine Subscription Quota Handoff — 2026-11-22

## Objective

Scheduled Agentes Chat Routines must continue on another approved subscribed model plan after the original plan returns a **hard** `plan_limit` error, rather than automatically waiting for a plan reset. Do not assume an installed CLI is a subscription, use unapproved paid API credits, repeat completed external tools, or carry native vendor sessions between providers.

## Root cause on canonical `main` (`6cda5a656`)

The engine already had a qualified cross-provider `quotaCliContinuation` pathway and persistent portable handoff receipts. However, `brainUnavailable()` required `agent.brainExtraUsage === false`, while `brainExtraUsage` defaults to true, even for an actual hard plan refusal. The qualifier recognized only the machine's own Claude sign-in or Codex usage windows, and one globally selected Grok account; it did not discover owner-shared alternate subscription sign-ins for the agent's own routines.

## Changes

- **Hard-limit eligibility:** allow a scheduled Routine with `run.background`, no long-work ID and a real routine trigger to enter the existing qualified handoff on `plan_limit` even if `brainExtraUsage` is true. Retain all existing no-unknown-effects, no-pending-tools, session ownership, no-secret-context, matching machine, explicit qualified route, and checkpoint gates. Near-limit reserve routing remains gated by `brainExtraUsage === false`.
- **Subscription discovery:** look for active, shared, `cli_login`, key-free, owner-held `machine_accounts` within the exact workspace and computer, owned by the agent's owner who remains a workspace member. Exclude API keys and key-backed vendor accounts; the executor still re-resolves and checks `planIsOwners` at actual dispatch.
- **Availability:** sort fresh recorded usage by headroom, ignore freshly exhausted accounts, and try accounts without a fresh reading only after those with verified room. Final quota limits and capabilities are rechecked by the existing `resolveBrain` path before dispatch.
- **Provider reuse:** use the already deployed `createQuotaCliQualifier` infrastructure for Claude Code, Grok and Codex. Preserve qualified `quotaCliHandoff` context, distinct session IDs, JEV model tier/effort, notifications and run ledger.

## Acceptance criteria

1. An actual Routine's Codex CLI returns a simulated hard `plan_limit` before tool side effects while extra usage is on: another authorized subscribed account finishes exactly once, the same run is marked done, and ledger records its actual brain. Covered by `routine-plan-main.test.ts`.
2. Signed-out, unshared, unauthorized, API-key, key-backed and secret-bearing contexts never route to alternative accounts. Covered by `routine-plan-qualifier.test.ts` plus existing `engine-brains.test.ts` quota policy regressions.
3. Among candidates, prefer fresh documented headroom; never claim an exhausted or unknown plan has room. Covered by `routine-plan-qualifier.test.ts`.
4. Existing handoff context, JEV effort and safety checks remain unchanged.
   Previous quota, background-run and usage-pause tests cover these protections.
5. No change to a live runner or production config until the exact release revision, tests, feature flag, rollback and controlled deployment window are verified.

## Local verification

On the isolated latest-main worktree, using the real AC Engine, actual test database and simulated provider events:

- `bun test packages/engine/test/routine-plan-main.test.ts packages/engine/test/routine-plan-qualifier.test.ts`: 4 passed / 0 failed.
- `bun test packages/engine/test/engine-brains.test.ts --test-name-pattern 'quota policy|quota qualifier'`: 17 passed / 0 failed.
- `bun test packages/engine/test/background-runs.test.ts packages/engine/test/usage-pause.test.ts`: 103 passed / 1 pre-existing skip / 0 failed.
- `bun node_modules/typescript/bin/tsc --noEmit -p packages/engine/tsconfig.json`: passed.
- Format and whitespace checks: passed on changed files. Existing executor source linter warnings are separate from this patch.

These are **not live subscription exhaustion tests**. Current production Runner and desktop remain unchanged. Real production activation still requires branch review/protected merge, release checkout/build sync, confirmation the live server has `QUOTA_HANDOFF_ENABLED` active, supervised controlled smoke run, and rollback readiness.

## Safe rollback

Revert this feature commit on the release branch, retaining the existing qualified handoff engine and unchanged `waiting_plan` behavior. This patch has no data migration, credential changes, agent brain reassignment or service restart.
