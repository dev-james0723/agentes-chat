# 0187: Preserve nonproject brain exception semantics

Status: Proposed

## Context

Every uncertain or background origin resolves persisted project authority before a brain executes. The project brain wrapper caught exceptions from both that resolution and the delegated brain, including a native nonproject API routine. This converted a typed provider exception into a nonretryable workspace error. A transient provider outage failed the run on its first attempt instead of using the executor's bounded retry and parking policy; a permanent provider rejection lost its normal classification.

## Decision

Resolve project authority inside its own fail-closed catch first. If that resolution succeeds with no project context, delegate to the brain outside the workspace catch. The same original exception, including provider type, status and retry metadata, then reaches the existing executor and outbox policy. The resolution still occurs before delegation, even when compatibility is disabled. An authority lookup failure does not become a nonproject origin.

Mapped project execution keeps its separate catch and all existing model, agent, machine, owner, mapping, receipt, source and workspace checks. A thrown failure remains nonretryable. Native error events still become nonretryable project-turn errors with server-stop disabled. This holds before or after a possible effect, preserving reconciliation instead of authorizing replay. No caller resumes or invokes a brain around its guard.

The earlier private result association remains unchanged. This change adds no SQL, public brain contract, dependency, prototype change, schema or persisted state. It does not reset attempt counters, account state or budgets.

## Local patterns and verification

The existing `ModelBrain` passes provider failures through to the executor. The established `flow.test.ts` cases distinguish transient provider retry, outage parking, permanent rejection and account refusal. This focused change restores those existing semantics for a resolved nonproject origin instead of introducing a new retry mechanism.

Actual native Run Now fixtures reproduce transient, permanent and repeated-outage failures before the change. They verify one recovery retry, stable attempt caps and parking, usage attribution, permanent classification and refusal before an exhausted budget can call a provider. Receipt-backed project fixtures cover thrown and event failures before and after a synthetic effect, all nonretryable. Existing tests retain metadata attribution, foreground query budgets, background fallback restrictions, project API rejection, feature-off checks, current route/source checks, revocation and no-replay behavior.

All evidence is local and synthetic. It does not qualify real-provider availability, PostgreSQL concurrency, an installed runner or production acceptance. Reverting the control-flow change requires no data migration and restores the prior exception-classification regression.
