# Te release CI: deterministic browser preparation evidence

## Global Constraints

- Work only in the isolated ac-te-browser-ci-clock-20261125 worktree at base e02f78b18b45f0f073d44475d23919f2e11b6e93. Allowed tracked files are apps/server/test/runner/browser.test.ts and this plan. No production source, dependency, test-budget, assertion, CI guard, workflow or release-policy changes.
- Preserve the exact expected setup keys and existing command behavior, including the first preparation report and later empty report. Fix the inherited real-clock dependency with the existing BrowserManagerOptions.now injection. No sleeps, retries, skipped tests or unconditional-success stubs.
- Keep ordinary production filesystem operations and browser manager code unchanged. Test clocks must deterministically exercise both fast preparation and threshold-crossing evidence when the existing case contracts require them. Do not erase meaningful coverage or replace real local manager/session behavior with a mock of the expected result.
- No live browser, UI, provider, OAuth, production Docker/DB/launchd or credential actions. No push/merge from the implementer. Commit locally with [skip ci].
- Only focused local validation; use the existing unmodified CI admission guard before Bun work. This guard enforces worktree ownership and parallel slots, not load average. Do not bypass or expand it. If admission fails, record that actual refusal. Root has paused heavy full22 retries under currently severe host contention; a single bounded focused test is allowed under normal admission, with any timeout reported honestly. Preserve exact command, exit/output and evidence.

## Evidence and scope

The e02 full22 run was stopped after five actual server failures under rising host load (02:52 load117 on16logicalCPUs). Four failures were timeouts; source causality is still unproven. This task does not change those unrelated cases or their budgets.

The distinct browser assertion expected [desktop, launch] but observed [desktop, install, launch]. In runner/browser.ts, ensureSession records install if preparation took at least10ms. With the test opts.command, ensureReady resolves without installing, but asynchronous session-directory/file setup can exceed10ms on the real clock. The existing now injection is the appropriate deterministic test boundary. Preserve source/test evidence and do not label this a Te runtime defect.

## Task 1: Remove wall-clock dependence from browser setup evidence tests

Inspect the named command setup reporting case and directly adjacent cases consuming the same now seam. Make the minimum scoped change to provide deterministic timestamps and preserve the exact setup-key expectations. Cover a deliberate threshold crossing if the same test contract is otherwise untested, using the real manager with an injected clock; avoid broad test refactoring.

Read the final diagnosis in the e02 CI evidence directory before editing. Run the smallest focused Bun test selection, then relevant source formatting/type checks only as warranted. No full22, package-wide test sweep or repeated stress loop in this task. If admission is blocked or focused validation cannot complete under actual load, finish source preparation and return DONE_WITH_CONCERNS with test evidence explicitly unavailable or failed, not a passing result. Root will schedule guarded verification before source acceptance.

Write .superpowers/sdd/2026-11-25-te-browser-ci-clock/task-1-report.md with commit, diff summary, exact checks/output, actual red/green evidence if safely available, limitations and any remaining uncertainty. Fresh independent review must return Spec and Quality verdicts.
