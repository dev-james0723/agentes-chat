# Claude Model Quota Scope Repair Implementation Plan

> **For agentic workers:** Execute this bounded repair with superpowers:executing-plans and an independent whole-branch review. Track each task below; current explicit immediate-fix authorization covers implementation and the normal reversible local deployment.

**Goal:** Restore eligible Claude models while retaining actual shared/model limits.
**Architecture:** Share a model-window predicate in plan-state; use filtered snapshots only for Claude execution/presence/reset decisions. Reconcile parked runs against fresh per-model usage without changing account overview meters or provider authentication.
**Tech Stack:** TypeScript, Bun1.4.4, Hono, Drizzle, in-memory PGlite tests, existing Docker deployment.
**Spec:** docs/superpowers/specs/2026-11-19-claude-model-quota.md

## Global Constraints
- No new dependencies, migrations, credentials or paid fallback.
- Keep80/90/95 thresholds.
- Unknown actual provider refusals remain restrictive; do not infer rejection scope from a coincident full Fable meter.
- Use the isolated branch initially based on97dae0412 and rebased onto currentmain bd7f72945; preserve live runtime overlays and unrelated work.
- Test with fake providers/PGlite and no production environment values.

## Review Focus
- Default/auto/full model aliases must select the right windows (Task1).
- Unattributed refusal must not be silently removed by filtering (Task1).
- A newer cached refusal survives an older arriving probe (Task2).
- More than100 blocked rows must not hide an eligible wait (Task2).
- Same-percent fresh probe must repair old waiting work without reviving terminal/held work (Task2).

### Task1: Scope admission, resets and presence
**Files:** packages/ui/src/plan-state.ts; packages/engine/src/brains/select.ts; packages/engine/src/executor.ts; packages/engine/src/out-of-office.ts; relevant engine presence projections; new packages/ui/test/plan-model-scope.test.ts; engine-brains/out-of-office/usage-pause regression tests.
**Interfaces:** pure planWindowAppliesToModel(window,model):boolean and planUsageForModel<T extends PlanMeterUsage>(usage:T,model?:string|null):T; optional model on bindingReset/storedPlanLimit/planLimitOf; existing brainModelFor resolves defaults.
- [x] Add failing exact81/Fable100 tests and full shared/refusal/alias/reset tests; run in isolated Bun container, expect existing admission mismatch.
- [x] Implement the pure filter without mutating usage or clearing limited:true; reuse applicability in planBinding while preserving its non-model exclusions.
- [x] Thread selected/effective Claude model through gate, wait reset and presence; preserve other-provider behavior and actual cache refusal.
- [x] Run focused tests, expect pass.
- [x] Commit coherent admission fix.

### Task2: Reconcile waiting work safely
**Files:** packages/engine/src/usage-pause.ts; packages/engine/src/machine-accounts.ts; packages/engine/src/brains/select.ts cache-clear timestamp; packages/engine/test/usage-pause.test.ts; machine-accounts tests as needed.
**Interfaces:** wakePlanWaits room includes optional kind; model applicability helper fromTask1; forgetPlanLimit accepts optional not-newer-than timestamp.
- [x] Add failing same-probe Sonnet/Fable wait and stale-cache cases, plus crowded waiting queue case.
- [x] Fresh Claude probes without shared/unknown refusal may reconcile per-model waits. Preserve scoped refusals and existing fencing, dedupe, stagger and steady behavior.
- [x] Paginate candidate waits before selecting eligible rows; resolve legacy model from agent/default.
- [x] Invoke reconciliation for fresh readings even if usageMoved reports no display change; reject stale/newer-cache clearing.
- [x] Run usage-pause, long-work-pause, engine-brains and relevant account/presence tests; expect pass.
- [x] Commit coherent queue fix and reviewed plan updates.

### Task3: Verify, review and deploy
**Files:** relevant ADR0059/0118 addendum if needed; private release receipt and overlay Dockerfile outside public source.
- [x] Run lint, typecheck, boundaries, existing runner warning/refusal tests and isolated build. Inspect every result.
- [x] Independent whole-branch review, address substantive findings with targeted tests.
- [ ] Push fix branch and integrate via normal repository strategy with fresh main check; never force-push another branch.
- [ ] Build a pinned overlay of the exact existing runtime with only verified changed source; retain unrelated mobile/web overlays. Record base identity and rollback image.
- [ ] Confirm current runtime still matches baseline, then normal compose app-only graceful replacement; no database/runner reset.
- [ ] Verify health/source identity, fresh usage, scoped admission and queue recovery; switch Oliver back to authorized Sonnet with compare-and-swap and execute a bounded real smoke.
- [ ] Record concrete outcome and remaining gates; no UI layout changes so viewport/layout gates are not applicable.


## Independent review and final verification

The fresh whole-branch review (bd7f72945..5a5c85dac) found two Important issues and no Critical or Minor issues. Both were fixed in one pass without a second review:

1. Concurrent usage writers could overwrite a newer reading. Account and own-sign-in updates now compare their observed JSON snapshot in the database and retry on conflict. Real PGlite writes injected between the read and update reproduce the old failure for both paths; the tests also retain a concurrent other-brain reading and prevent stale wakeups.
2. A JavaScript Date cursor lost PostgreSQL microseconds. Wait pagination now selects and compares the exact timestamp text plus UUID. A bounded mixed-eligibility fixture reproduces duplicate selection in the old implementation and passes after the fix.

The complete ten related test files passed after these fixes:454pass,1pre-existing skip,0fail. All15workspace typechecks passed using native Node because the isolated Docker VM could not hold the TypeScript compiler's heap. Whole repository lint exited0 with existing warnings; changed files have only the two pre-existing executor warnings. Full1569-file monorepo testing is deferred for this urgent bounded repair; these results do not claim that unrun integration tests pass.

Production deployment and the live provider check are separate acceptance gates below; a running HTTP server alone is not proof of the correct source or a successful Claude request.
