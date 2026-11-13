# WP3-A — Contextual skill planning observations and native evidence

Status: source-only candidate under the existing work package 148. No runtime acceptance or authorization is implied.

## Context and reuse

The existing skill registry, `enabledSkills`/`agentSkillByName`, native `load_skill`, Tool Gateway, original-person visibility, `readOutside`/`ownWords`, approvals, outbox and leases remain authoritative. The reviewed self-profile candidate `4ca185906e9cde5d2011e449cfd2eefa32d1f00b` exposes observational `get_my_profile` pages. They have a five-minute expiry and separate capability/context and usage versions; pagination is not atomic and a model can fabricate JSON with the same labels.

The Master's separate admission primitive `8fa2394e6cb94febc71af8e68c92568ae77ce7eb` owns scope/actor/purpose/version/hash/approval/freshness/use decisions. Its ALLOW is not an atomic reservation or a permission grant. Duplicating that policy, a skill registry, a JEV client or a lifecycle producer would create conflicting authority.

## Decision

Add one unregistered planning module, its fixtures and this ADR. Do not modify existing exports, server wiring, jobs, gateway, skill/profile implementation, handlers, leases or migrations.

`createContextualSkillPlan` consumes a bounded existing-registry search shortlist and untrusted skills-section observations. It validates complete contiguous page coverage, one fixed native agent/context version, timestamps and expiry. Usage-only changes do not invalidate capability pagination. Limits are eight observation pages of at most twenty items, twelve input candidates and at most three explicit recommendations. Bounds fail to abstention rather than silently dropping required work.

A server-owned `readNativeEvidence` callback must obtain actual existing scope, trust, platform/tool/dependency, original-actor, task/session and approval facts. The planner invokes `decideSkillAdmission` instead of implementing another policy engine. Profile labels, JSON booleans, a claimed role, installation alone, or a model's assertion of authority cannot replace that reader. The callback's existence itself is not proof of a safe adapter: a future native handler must never populate these facts or policy from model input.

Explicit approved version mappings follow a no-model path. Other fit ambiguity abstains by default. A separately authorized native semantic policy may inject the existing calibrated Judge with one call, no retry/fallback, a 1.5-second local semantic-wait deadline (also passed to the native transport), scoped approved summary and model/question-class calibration reference. Only approved same-project egress summaries enter that request. All other profile, envelope, approval and skill contents stay local. A Choice selects one qualified candidate or `none`/`insufficient_evidence`; missing confidence/probabilities, close alternatives, unresolved/model-drifted receipts or elapsed evidence abstain. No synthetic fixture establishes real calibration or semantic benefit.

Judgment receipts must match the actual input/question digests, decision class and resolved model. Planning fingerprints bind fixed identity, context/policy/capability/purpose, native envelope digests, selected versions/hashes and relevant judgment inputs/model. They are dedupe intent, not an atomic event claim, a persistent judgment cache or authorization. The existing outbox/event owner must claim/coalesce before any model call and preserve a monotonic aggregate budget; passing a fresh `remainingCalls` number on every retry must not reset it.

Every result declares `authority:false` and `requiresExecutionRevalidation:true`. It loads or installs nothing, consumes no activation use, reserves no machine/provider/device/writer capacity, writes no store and creates no producer. The existing final native path must reread current permissions/version/hash, perform the reviewed admission decision and atomically claim any use/lease immediately before execution, including after approval/resume. A plan cannot substitute for this final gate or revoke already-running work.

## Integration and verification boundary

The integration owner retains merge/release ownership. The Master retains activation-envelope and proposed native-handler work. This module is not exported in the engine index or registered as a tool/hook. It is not an alternate way to call `load_skill`.

PRD:R-01/R-02/R-03 may later consume this planning contract through the existing task/session lifecycle; they are distinct from ENG routine IDs. Reuse work package 148 and existing tasks 143/144 evidence. Do not install another schedule, dual Paperclip/Agentes producer, profile service or registry. Runtime hook, atomic dedupe, persistent task budget, invocation TTL, actual skill usefulness and multilingual quality/value acceptance remain unverified.

Offline fixtures exercise paging/freshness, explicit no-model selection, revocation/approval/version/hash/purpose/identity failures via the existing admission primitive, bounded output, privacy before judging, calibration/model/receipt drift, uncertainty, expiry and no retry. They do not prove production grants, atomic admission, physical concurrency or savings. Real semantic calibration is intentionally absent; only synthetic test policies are supplied.

Rollback before integration is omission/revert of this three-file delta. No runtime flag, service restart, migration, publication, paid inference or permission expansion is needed for this source-only slice. A future deployment requires the existing owner's normal gate and review of the exact combined source.

## WP3-A independent review follow-up: local settlement

The original `ecd3ac831` directly awaited `Judge.ask(timeoutMs=1500)`. The shared Judge awaits usage accounting after its transport timeout scope, and an injected Judge may ignore that argument. Therefore the original planner did not bound its own semantic wait. The follow-up wraps exactly the existing one call with a local timer and monotonic elapsed-time check. Timeout returns `semantic_deadline` abstention with decisionCalls=1 and no retry, renewed budget or result publication. Promise.race retains observation of a late resolution/rejection; no continuation promotes a late answer into the returned plan. The timer is cleared on settlement or rejection.

This deadline bounds local asynchronous waiting subject to event-loop scheduling. It does not cancel a provider call or usage-accounting operation, prove that billing stopped, or globally bound native evidence IO. Underlying accounting may continue and record usage after this planner has abstained; existing usage ownership is retained. The separately owned event adapter must still claim the task-level budget before entry, including after timeout. Nonsettling-Judge, stalled shared accounting, late-answer and late-rejection fixtures exercise this distinction without real provider calls.
