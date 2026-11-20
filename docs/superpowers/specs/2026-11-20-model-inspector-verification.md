# Model Inspector Verification

Date: 2026-11-20 (UTC)

## Release and acceptance state

The scoped Model Inspector implementation and active personal-continuity correction are deployed and passed their deployment acceptance checks. Automated gates, runtime identity checks, a bounded live personal same-run handoff, automatic private-route restoration and final isolation checks passed. Recovery of an earlier failed message is recorded separately.

Hosted CI is blocked before execution by a GitHub account-billing issue; its status and run links are recorded separately below.

Implementation and acceptance requirements are defined in the [engineering specification](2026-11-20-model-inspector-engineering.md), [PRD](2026-11-20-model-inspector-prd.md) and [implementation plan](../plans/2026-11-20-model-inspector.md).

| Deployed artifact | Verified identity |
| --- | --- |
| Release commit | `4122e298a6572f271f7af93439c689d11259a14b` |
| Container image digest | `sha256:eca2db282d334ffa46c273558972b8c202f12b282c458733b2c7d5e14c443bb7` |
| Application source digest | `d082298a5c8a2380a319d99fc711c8a138bff6392d010f5e61f32b8816bbee35` |
| Source inventory | 3,306 files |
| Deployment scope | Application only; the existing native runner remains in place |
| Post-deploy health | Application healthy; database check passed; live image and source identities matched |

The active-continuity image was built from the verified personal-route image. Existing web assets, Foundry behavior and concurrent Colab changes were retained. No additional database migration or native-runner update was needed for this correction.

## Automated verification

### Final active personal-continuity gate

The exact combined release passed:

| Gate | Result |
| --- | --- |
| Focused personal executor, existing Inspector executor and right-hand plan suites | 37 passed, 0 failed, 201 assertions across 3 files |
| Engine TypeScript | Passed, zero diagnostics |
| Server TypeScript | Passed, zero diagnostics |
| Module boundaries, pinned Bun 1.4.4 | Passed: `boundaries ok` |
| Changed-file Biome | Passed; one existing host-ACP optional-chain warning remains outside this feature logic |
| Diff whitespace check | Passed |
| Release checkout identity | Expected commit unchanged; worktree clean before building |

The three test files are:

- [Personal executor regressions](../../../packages/engine/test/model-inspector-personal-executor.test.ts): seven cases using the real qualifier and brain resolver.
- [Inspector executor regressions](../../../packages/engine/test/model-inspector-executor.test.ts): fifteen ordinary-agent, mission, quota and route-revalidation cases.
- [Right-hand plan regressions](../../../packages/engine/test/right-hand-plans.test.ts): fifteen existing plan, ownership, refusal and locked-profile cases.

The new suite reproduced four missing-continuity failures before the correction. It then verified actual no-effect provider refusal, known-limit startup before source dispatch, private edits during JEV, target-session resume after waiting for room, unknown-effect refusal, disabled-Inspector behavior and a durable hold after a private binding changes.

Its fixture deliberately gives the subscription and machine to a member other than the global right-hand owner. Assertions preserve the actual person, same task/run, fresh target-provider session, explicit effort, builtin identity, global AI settings and both members' independent private bindings.

### Earlier feature and personal-route gates

Earlier isolated feature suites passed 290 tests, with four environment-dependent skips, zero failures and 1,520 assertions across eighteen files. Config, engine and server TypeScript also passed. The native supervisor suite ran separately to release engine-fixture memory before its real-worker checks.

The personal-route extension was additionally checked through focused own-subscription/API and existing named-route regressions: 36 passed, zero failed and 211 assertions. The appended migration test passed with eight assertions against actual legacy and new SQL, covering preserved named rows, explicit own routes, foreign keys, the route constraint, deletion behavior and legacy writer compatibility. Reconnect regression tests verified that an empty or inconclusive hello cannot erase an actual Grok refusal, including a concurrent newer refusal.

These earlier counts describe separate gates. They are not added to the final 37-test count as though they were one nonoverlapping run.

## Hosted CI status

The hosted CI and Delivery Guardian jobs for [PR #68](https://github.com/dev-james0723/agentes-chat/pull/68) did not start. GitHub's API annotations reported:

> The job was not started because your account is locked due to a billing issue.

Both inspected runs stopped before execution and had no execution logs:

- [GitHub Actions run 44725184646](https://github.com/dev-james0723/agentes-chat/actions/runs/44725184646)
- [GitHub Actions run 44725185635](https://github.com/dev-james0723/agentes-chat/actions/runs/44725185635)

Hosted CI therefore remains unverified. The passing 37-test gate, TypeScript checks, boundaries and runtime evidence in this record are isolated/local and deployed verification results. They do not imply that the hosted jobs ran successfully. The external account-billing block requires resolution before those hosted checks can execute.

## Live evidence

| Observation | Verified result and limit of the claim |
| --- | --- |
| Visible Inspector and periodic service | The enabled organization's visible agent and ordinary minute worker were observed operating. Polling is deterministic and does not depend on a model responding. |
| Grok authentication and refusal | The real CLI account returned an actual subscription-limit refusal. That refusal was stored and used as evidence. Grok's numeric remaining allowance was not reported and remains unknown. |
| Ordinary-agent quota continuity | A real Grok refusal followed by qualified Codex continuation was verified for the ordinary-agent path. This preceded discovery of the separate personal right-hand short circuit. |
| Owner's personal default | The ordinary worker migrated the right hand's owner-specific binding from the limited named Grok route to the available own-Codex subscription. The shared agent row and other members' choices remained independent. |
| Real own-Codex execution | A bounded personal request completed through the native Codex subscription route. It did not rely on an API-model fallback or the frame's primary Grok account. |
| Earlier failed no-work message | The existing native answer-now recovery path was used for the original message. It preserves that message and creates a replacement run under its normal no-work guard; it does not preserve the failed run ID. |
| Active personal continuity after this release | A bounded known-limit startup check completed at 11:14:21 UTC on the same run after JEV selected own Codex, using `gpt-6.1-sol`. The run completed one turn billed to the subscription plan. Its source remained the personal Grok binding while active, and the durable handoff recorded the qualified target. |
| Automatic restoration after verification | At 11:15:16 UTC, the ordinary Inspector worker restored the owner's private default to its JEV-selected own-Codex route. A guarded manual restoration attempt rolled back without writing; no forced restoration was used. |
| Final isolation and runtime snapshot | Global right-hand AI settings, original fleet authority/routine invariants and other members' private bindings held. Exactly one visible Inspector remained. The intended image/source, migration identity and native protocol-57/task-model capability matched; application/database health passed, the native runner was online and unpaused, and no active work remained at that snapshot. |

The failed personal run's evidence was preserved before recovery. Its provider refusal and terminal `no_ai` outcome established why the additional active-personal correction was necessary. The answer-now recovery audit links the replacement run to the prior run. Message recovery is not described as a same-run handoff.

The final log review found no Inspector, continuity or migration error. Two database-connector/table-listing requests returned HTTP 500 with `This server is not allowed` through existing routes whose source was unchanged by this release. The scoped health checks passed; the record does not claim globally error-free application logs.

The final same-run check used the already-stored genuine Grok turn refusal. It did not make a fresh Grok quota probe or manufacture another provider refusal. No production quota reading was fabricated or cleared to obtain a success result. Successful Codex execution proves that the tested subscription route answered; it does not establish a guaranteed future capacity or a numeric remaining allowance.

## Continuity and authority checks

The active personal path attempts a qualified subscription continuation before the right hand's terminal no-AI response. It retains the builtin's locked chat profile and its actual person's authority. The resolver override is internal and tied to the actual person, owned subscription, machine and stored run session.

A handoff locks and compares the global authority row and explicit private binding, rechecks current ownership and authentication, and retains the existing unresolved-effect guards. It stores the personal identity and binding fingerprint with the route. Resume requires the same binding and exact target session, machine, model and account; a changed choice holds for reconciliation.

Idle personal migration and active continuation have different persistence rules. The worker updates the owner's private default through the normal personal settings API after its idle/CAS checks. Active continuation changes only the run's qualified route and session; it does not overwrite private or workspace defaults.

Active mission route persistence, later-turn resolution, resumed target sessions and owner-change rejection passed regression tests. No production mission was interrupted or manufactured for acceptance, so mission continuity is recorded as regression coverage rather than a live mission claim.

## Rollback compatibility

The personal-route migration is append-only. It preserves named-account bindings and adds an explicit own-machine route. Production activation retained a verified compatibility image that understands both the migrated schema and the personal route shape.

After that migration is recorded, the old unmodified image is not a valid rollback target: it neither understands the new route representation nor satisfies the migration guard. Use the retained compatible image and the recorded application/source identity. The active-personal correction itself is application-only and introduces no further schema or native-runner change. Database and affected-binding backups were taken before the schema activation; rollback must not casually remove the migration or rewrite users' private choices.

## Final live acceptance

- [x] Complete the bounded personal known-limit continuity check against the deployed release using existing real refusal evidence, with no quota-telemetry edits.
- [x] Verify that the new run remains the same run through the qualified personal Grok-to-Codex handoff and completes its requested reply through the subscription plan.
- [x] Finish guarded cleanup of the temporary private verification choice and verify global/other-member isolation, the ordinary worker, release identity and runtime health.

Scoped live acceptance is complete. The ordinary worker performed the final private-route restoration, and the independent post-run snapshot verified the isolation and runtime invariants. Normal agent status fields changed as the verification run executed; global AI/authority invariants were checked rather than claiming a byte-for-byte match of the entire agent row. Public documentation intentionally omits organization, person, agent, machine, account, message and run identifiers; account-specific usage readings; credentials; and private operational paths.
