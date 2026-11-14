# WP3-B1 — Native read-only skill preview under task148

Status: source-only, unregistered. Based on owner-confirmed AED `aed5b6fe2d72f18d22986a0c9edc05529e7e781f`, parent combined8dad. No existing file or runtime wiring is changed. Master and integration owner approved only this module, its tests and this unnumbered ADR.

## Gap closed and contract

WP3-A consumes a native evidence callback but does not establish that runtime boundary. This slice implements an independently testable **metadata preview**, with actual native database/authority/visibility/grant readers. It does not manufacture a qualified activation envelope to make the planner appear integrated. The immutable admission8fa and planner ecd+5b are reference dependencies for subsequent activation integration, not merged or required by this three-file preview delta.

`previewNativeSkills` accepts a fixed native ToolContext plus its captured original actor and at most three explicit ID/version references. It is not a ToolDefinition or API. A future handler must derive the context/original actor on the server, never accept them from model input. The only callback is a server-owned native gateway tool listing, preferably already available to the current run. It does not call get_my_profile or a model. Missing listing evidence is unknown; there is no fallback.

The module joins the actual run and agent in one organization, requires the exact running run/channel/thread/trigger, checks native runAuthority against the original actor, and uses current membership, agent-details visibility and channel access. Native task identity comes only from the run; a referenced task must exist in this org, remain nonterminal and be visible. A routine creator may supply visibility reach through the existing helper, never acting-person authority. There is no fallback to the agent owner. The binding/ACL checks repeat after the potentially asynchronous listing. It then re-reads grants and native load_skill dependencies and reads only the requested currently enabled, undeleted exact skill versions.

Output includes ID/version only. Names, descriptions, skill bodies, source URLs, account labels, paths, credentials, usage and route labels are never selected for output. Errors expose fixed reasons, not exception strings. An observational fingerprint binds fixed run/actor/task, returned IDs/versions and native grant keys as a digest; raw actor identifiers and grants are not returned. Five-second observation expiry is a source contract, not a runtime flag, lease or enforced skill invocation TTL. Cancellation/elapsed observation prevents returning a preview. Native DB/listing IO retains its normal caller/driver timeout contracts; no global IO cancellation or liveness guarantee is claimed.

Every result has `activation:unverified`, `authority:false`, `canExecute:false`, `readiness:metadata_only`. A preview never says ALLOW. No content is loaded, assignment changed, approval requested, use consumed, resource reserved, task dispatched or result promoted. Current metadata does not prove the skill's trust, every tool/platform dependency, suitability, execution authorization, source content hash or usefulness.

## Cost and integration boundary

The function has no caller, export in the engine index, lifecycle hook, feature flag or producer. Therefore it adds no foreground per-turn reads and no JEV calls. Do not wire it by calling get_my_profile on every turn. Preserve existing18/24 foreground SQL budget tests. An explicit future preview still performs native reads, including repeated ACL checks and the listing callback's cost; its queries are not free and must be measured separately from the normal foreground baseline.

The source owner alone integrates reviewed shared exports/registration. Master owns the native activation contract and handler. Source owner retains metadata executor/ADR0185 and statusworker/helper/server/ADR0184; Master retains issues guard/ADR0186. Release remains held pending151 and the normal owner gate. No store, schema, migration, hook, service/controller or registry is added here.

## Evidence and remaining work

Tests use the project's existing disposable PGlite database, native run authorship, membership/grants, skill assignments and actual Tool Gateway. The fixture provider is fake and uncalled. They verify metadata without writes, scope/actor/routine isolation, current assignment/deletion/version, gateway denial despite a stale listing, existing allowed gateway load, absent capability evidence, bounded input, observation expiry/cancellation, callback failure and late binding/ACL changes. The gateway load control tests the original path; it does not establish new scoped activation. Three late membership/run/actor controls failed before the final revalidation and passed afterward. Test data setup writes only to disposable fixtures, never the deployed org.

B2 remains open: real native issuer/projection contract, canonical current content hash, approval-purpose/version/scope binding, durable bounded uses/CAS, revocation/TTL on actual invocation and after wait/resume, one event/budget claim, crash/unknown-effect reconciliation, bootstrap/resume seams and all PRD:R-01–R-11 lifecycle coverage. No fixture boolean or run-step text may replace those authorities. Real PostgreSQL concurrency and deployed acceptance require separate evidence. Semantic calibration, multilingual rules/current/proposed holdouts, the known wrong-domain routing failure and measured total cost/throughput remain open. This adapter is not completion of WP3 or the PRD.

Rollback before integration is omission/revert of these three new files. No runtime setting needs changing. SOURCE_INSPECTED/source-tested is distinct from CONFIGURED/DEPLOYED/LIVE_VERIFIED; this slice changes none of the latter.


## Source-context privacy boundary

The Master is investigating whether learned-skill promotion preserves the source audience. An issue project is not a privacy ACL, and the existing agentSkillByName assignment filter does not establish current source-context authorization. This is a source-level concern under independent investigation, not a claim of an installed disclosure.

B1 labels its actual observation as `visibilityEvidence:native_assignment_and_caller_reach`; unavailable results say unverified. It always labels `sourceContextPrivacy:unverified`. These labels distinguish the checks it really performed (current native run/actor reach, assignment and version) from provenance/audience checks it did not establish. Skill metadata claiming privacyVerified/authority or a project ID is not evidence. Only IDs/versions are emitted; no source context, skill text or provenance label is exposed. No activation/load/distribution/promotion can be authorized from this preview. B2 must preserve real source audience and provenance as well as its approval/use/revocation contract before claiming a private-context-safe activation. The new fixture writes claims into an actual disposable skill row and verifies they cannot change the unverified/no-authority result.
