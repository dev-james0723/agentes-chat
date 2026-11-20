# Model Inspector Engineering Specification

Date: 2026-11-20

## Baseline and architecture

The running native server uses the 6455f240d base plus the existing Foundry text-file fix. The implementation branch starts from c2d9cccd2, which incorporates that base and the reviewed Claude model-specific quota fixes. Preserve the Foundry overlay when building the candidate image. Do not deploy a broad upstream update or replace another workstream's files.

Use a native engine service and the server's existing periodic worker. No new external queue or model polling process is needed. Enable it with typed configuration containing an explicit organization allowlist, 95% threshold, 60-second sweep, five-minute observation age, 15-minute switch cooldown and four idle migrations per sweep. Configuration is durable; decisions are recorded in the existing audit log. Status can be recomputed after restart, and no control instruction is hidden in an in-memory transcript flag.

## Interfaces

`packages/engine/src/model-inspector-routing.ts` defines bounded candidates, task facts and an async `chooseModelInspectorRoute(judge, input)` result. Candidates contain provider kind, model, account and machine identity, quota observation/state and current pool pressure. Output references one supplied candidate and records tier, effort, source and reason. Use the existing Judge abstraction and AutoModel conventions. Do not accept a free-form provider or model from JEV.

`packages/engine/src/model-inspector.ts` exports `createModelInspector(deps)` with `sweep()` and `report(orgId)` methods. It reads nondeleted/nonarchived agents, active run/mission status and enabled routines; deduplicates usage refreshes; resolves source/candidates normally; uses the routing module only when action is needed; updates idle agents through audited settings under a checked snapshot; and reports running agents as awaiting their boundary. An enabled organization is checked at each effect. There is no change to another organization's agents.

`EngineDeps` exposes the enabled inspector policy to the executor's existing quota continuation. The executor obtains current quota before a subsequent turn, using fresh model-specific semantics. It invokes the same route selector, revalidates the chosen concrete model and account, and reuses portable context. It never switches with pending, interrupted or uncertain effects.

For missions, carry a qualified override only inside quota continuation. Persist the mission's replacement brain/model/main session and the existing run's new native session in one transaction with owner/source-session checks. Normal mission model selection and manual settings retain their existing semantics. Resume verifies the committed mission route; later turns and restart cannot fall back to the old provider session.

`apps/server/src/engine.ts` wires one shared inspector and JEV judge; `apps/server/src/workers.ts` schedules its deterministic sweep. Expose an authenticated, organization-scoped status endpoint and an agent status tool. A visible inspector agent uses the tool on demand. Its own model failure cannot stop the worker. No new SQL schema is required unless implementation proves a durable fact cannot be represented in existing state/audit structures; record any such revision before changing it.

## Concurrency and recovery

Use a per-organization database advisory lock to prevent concurrent sweeps. Never hold an agent row lock during a provider/JEV call. Before applying idle changes, acquire a row lock, recheck the original agent configuration and absence of a running run/active mission, and apply settings in the same transaction. Preserve the current audience and all access settings; do not remember this as the organization-wide default. A failed CAS is a skipped decision, not a retry over newer settings.

Active work does not receive an asynchronous transcript patch, which could be overwritten by the executor. It reads enabled policy and fresh stored telemetry at a completed boundary. Existing run/session CAS remains authoritative. Cooldown and per-sweep migration limits avoid fleet oscillation; current target load participates in selection. Switching must not reserve nonexistent tokens or claim estimated remaining task cost is known.

## Provider semantics

Claude assessment must filter the current model's binding windows. Codex uses all applicable reported windows and epoch-second reset values. Grok retains its actual CLI-authenticated account; missing usage remains unknown and is ranked below proven healthy routes unless a task requires that route. Distinguish account login, installed adapter, known quota and successful real execution in status. Preserve existing no-paid-extra-usage policies and all configured API budget limits.

## Verification and release

Use PGlite/fake-provider tests for threshold semantics, JEV output validation, stale data, per-org coverage, cooldown, same-pool sharing, idle CAS, safe-boundary handoff, mission persistence and unresolved-effect refusal. Add 95 to runner crossing tests. Run affected tests, formatting/lint, affected TypeScript checks and module boundary checks; record any unrelated baseline failures. Build a candidate from the exact running image with the scoped source delta and existing web assets. Verify it in a disposable isolated environment before replacing the live server only after rechecking no active runs/missions and deployment ownership. Keep the previous image available for rollback. Do not restart the native runner to deploy server-only behavior.

Post-deploy: read health and release identity; verify the inspector agent, enabled configuration, minute worker evidence, current account refresh and observed route decisions. Perform a bounded real smoke using an available route and a safe Grok smoke only when its account is usable. Distinguish implementation tests from real quota-triggered migrations. Do not fabricate live 95% usage by altering production telemetry.


## Verified scope revision: personal right-hand routes

Live inspection found that the built-in right-hand agent uses a per-user `right_hand_brains` binding. Its generic agent row is not its actual model configuration. The existing binding requires a named account, while the currently available Codex subscription is the computer's own sign-in. Completing MI-01/MI-10 therefore requires a durable schema extension rather than manufacturing a named account or changing a workspace-wide default.

Make `brain_account_id` nullable and add nullable `machine_id` with the established machine foreign-key behavior. Existing named-account rows remain unchanged. Through the existing personal brain API, `scope: mine`, explicit `machineId` and `account: null` represent a validated own subscription; `account: null` without an explicit machine keeps its existing reset meaning. Reuse normal machine access, ownership, provider authentication and billing validation. Resolve the effective personal machine/account/model in `thinkingAgent`.

The inspector resolves only the built-in row owner's personal binding in an enabled organization. Its reporting and quota reads use that effective route. A personal migration holds the relevant row lock, revalidates the original personal binding and agent authority, checks for active work, then invokes the personal API. It never copies personal settings onto the shared agent row, chooses another member's binding, enables paid fallback, or overwrites a concurrent personal edit.

Append an immutable migration and verify both legacy named rows and new own-sign-in rows. Before production activation, back up the affected bindings and migration ledger and prepare a source-verified compatibility image that understands the new schema and personal route. The old unmodified image is not a rollback target after the migration guard records the new migration. Preserve the concurrent Colab release and existing native runner.


## Live acceptance correction: active personal quota continuity

A real right-hand run exposed an older `no_ai` short circuit after an actual Grok plan refusal. Default migration and new own-Codex runs succeeded, but the current message must also receive the requested continuation. The enabled Inspector policy must attempt qualified personal quota continuation before that older no-AI terminal path, both for known exhaustion at startup and for a no-effect refusal during a turn.

Keep the right hand's builtin identity, locked tools, actual DM person, source owner/machine/session, normal authentication and target quota checks. An internal qualified-personal-handoff resolver option may resolve the selected target without reapplying the source personal binding; it must be bound to the actual run/person/session and cannot be a public setting or an authority bypass. Compare both the raw global authority and the effective personal source when committing or resuming the durable handoff. Reject changed personal choices and unresolved effects.

Regressions must use the real resolver/candidate admission for a personal source binding, including known-limit startup, actual refusal, concurrent edits, and continuation/resume. In production, preserve the failed no-work message's evidence and use the existing answer-now recovery only where its native no-work guard permits it. That API preserves the message but intentionally creates a new run ID and records the previous run in its audit; never describe that recovery as preserving the failed run ID.
