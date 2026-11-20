# Claude model quota scope repair
Date: 2026-11-19
## Approved outcome
Repair the deployed application's false Claude plan-limit classification: a fresh probe with shared weekly usage81 and Fable100 must permit Sonnet/Opus/Haiku while continuing to block Fable. James explicitly requested immediate implementation and live repair.
## Design
Keep account overview meters complete. Add a pure model-applicability filter for execution decisions; only Claude uses this filtering in engine gates. Resolve absent Claude model through the existing Sonnet default, and retain supported full identifiers and automatic model resolution. Apply the same scoped reading to reset selection and out-of-office. Do not add a database migration, dependency, credential, paid fallback or provider bypass.
Unattributed limited:true and cached actual provider refusals remain restrictive. The probe defect can be repaired without inventing refusal attribution or changing the runner protocol. A fresh probe can clear a prior cached refusal only when it postdates that refusal and its shared windows permit retry; the normal run gate rechecks all applicable windows.
Repair waiting work through the existing waitId/dedupe/staggered execution path. Reconcile fresh unchanged usage readings; filter each run by its stored effective model (legacy rows use current agent model/default), retain explicit model/region/off/inactive holds, canceled/terminal states, continuity holds and steady-repark protections. Paginate candidates so blocked Fable rows cannot starve Sonnet.
Keep80% display warning,90% notice and95% long-work pause unchanged. Preserve all current runtime overlays and unrelated tasks. Build/test isolated from production credentials and data. Deployment uses the normal graceful app restart and leaves database/file volumes and runners intact.
## Acceptance
1 Weekly81+Fable100 probe: Sonnet/default/fullID passes; Fable blocked.
2 Shared100 or Sonnet-specific100 blocks relevant requests.
3 Unattributed limited:true remains blocked; irrelevant reset never determines Sonnet wait.
4 Cached refusal newer than a probe cannot be cleared.
5 Fresh unchanged readings recheck old Sonnet waits without waking Fable/scoped or terminal holds; more than100 excluded rows does not starve eligible rows.
6 Presence uses the effective Claude model.
7 Longwork94/95 behavior and other-provider model gates unchanged.
8 Targeted tests, lint, typecheck, boundaries and build pass or a verified unrelated baseline is identified.
9 Deployed identity/health verified and a real authorized Sonnet smoke succeeds before claiming restored operation.
