# 0180 — Opt-in Paperclip migration ingress using native hook credentials

Status: source-only candidate, 2026-11-13. No caller switch or deployment.

The session-only migration API cannot safely receive unattended producer requests. Reusing the generic webhook receiver would merge event calls and shorten lifetime idempotency to its 24-hour history window. Prepared mappings intentionally change the native event to `paperclip.received`, so the generic receiver must continue returning 404.

Add only `POST /api/hooks/{token}/paperclip/invocations` and `/lookup`. A nullable `paperclip_routine_mappings.hook_ingress` is an independent owner opt-in, not inferred from an existing enabled mapping. Its enabled API trigger and approved config hash are persisted together. The session API's `PUT .../paperclip-routines/{mappingId}/hook-ingress` uses compare-and-set and requires the creator's current `manage_routines` permission and a supported, prepared native execution contract. Turning this permission on starts no work.

The invocation body contains exactly `expectedConfigHash`, a nonblank lifetime `idempotencyKey`, optional `variables`, and optional `payload`. Lookup contains only the key. The server derives organization, mapping, native routine, agent, owner and the sole enabled API trigger. Source is always `api`. Caller-selected source, trigger, identity, environment, project, workspace or execution overrides are rejected. A header key must exactly match the body key. JSON remains bounded by the existing native 256 KiB body limit and compatibility's 64,000-character canonical payload limit; it is never truncated into a generic call excerpt.

Reuse native credential hashes, master-secret derivation, optional raw-body HMAC, method policy and IP/routine rate-limit namespaces. Buffer the bounded network body before taking locks. The durable admission order is the existing source advisory lock, mapping row, native/organization rows, then hook row. Under these locks re-read opt-in, scope, ownership, current token and current signing secret, and require current owner permission. Rotation or opt-out that commits first prevents admission; an admitted transaction holds the relevant rows until the existing receipt/issue/run/outbox transaction finishes. No credential cache extends authority.

`dispatchPaperclipRoutine` remains the only queue path. `findPaperclipInvocation` remains the only reconciliation path. Generic `liveHook`, `accept`, and `managedWebhookRoutine` keep their existing guards. Separate creator-only mapping hook view/address/signing routes call the existing native credential lifecycle because relaxing the generic manager would also expose its generic Test action. There is deliberately no mapped generic Test action. Successful invocation/lookup add no `routine_hook_calls` rows and store no credential/body history.

The response is explicitly tagged `backend=agents_chat`, with `receiptId`, `mappingId`, `sourceRoutineId`, `sourceRevisionId`, `configHash`, status, `routineRunId` and `issueId`. These are not Paperclip run/issue IDs. Lookup still works while native, mapping or global dispatch is paused; explicit ingress opt-out, credential revocation, owner/permission loss, closed organization or native deletion still refuse it. Lookup performs no data mutations.

## Research and dependency decision

This adapts installed/project-approved AGPL-3.0-only modules, introducing no dependency or license change. The frozen local baseline is `da529ebaed5bc5a42bc8c62908f5f6312d85e42b`, whose native hook implementation (`routine-hooks.ts`, `routes/webhooks.ts`) and durable mapping/receipt implementation (`paperclip-routines.ts`, `paperclip-routine-state.ts`) were inspected directly. Both have focused executable tests.

Prior research receipt `work/routine-compat/RESEARCH.md` in the operator workspace compared [AWS transactional outbox](https://github.com/aws-samples/transactional-outbox-pattern) at `6c2a614c13e0e2a155294ef3756c947461530ec1` (MIT-0) and [Gruelbox transaction-outbox](https://github.com/gruelbox/transaction-outbox) at `062cf2e110004850365f40d850aa107dee313357` (Apache-2.0), dated 2026-11-12. Their duplicate-consumer/atomic-outbox patterns support the already-selected seam; neither is installed or copied. Maintenance/advisory notes are historical, not refreshed findings. A new framework would add maintenance and compatibility cost without solving this application's mapping-bound authorization.

Agent Reach 1.6.1 was checked: `doctor --json` is unsupported; ordinary `doctor` succeeded but reports GitHub unverified. The installed package has no `references/dev.md`. No install, login, cookie access or external mutation occurred.

## Verification and remaining gates

The focused server fixture exercises distinct opt-in, generic-hook refusal, persistent keys older than 24 hours, concurrent changed-payload repeats, paused read-only lookup, strict fields and size/content-type/key checks, HMAC, method restrictions, rotation, routine limits, cross-organization joins, changed/lost owner, permission loss, changed fingerprints, unprepared contracts, foreign tokens, and revocation while the body arrives. Existing native/Paperclip tests retain worker receipt scope and `always`, `risky`, and `never` approval behavior.

These checks use synthetic fixtures and PGlite. They do not establish PostgreSQL row-lock behavior, a deployed runtime, source-reference access, completed target evidence, or an end-to-end producer cutover. Migration 0265 is additive and default-null. Its candidate snapshot was made on baseline 0263 and must be regenerated on the combined 0264/0265 migration chain before release.

The installed source companion remains unchanged. Its source discovery/revalidation/completion reads must stay on the source API. A future isolated companion adapter must persist backend and typed target IDs before reservation, retain legacy/unknown rows and stable keys, use target lookup after uncertain target delivery, and never send target IDs to source issue/run APIs or fall back to source dispatch after an unknown target effect. Native execution completion is not a verified `engineering-outcome` document. Target continuation stays held until an equivalent receipt-bound author/revision/time/head/base/evidence-hash contract is implemented and qualified.

All dynamic project/workspace overrides still fail closed. The real source split remains six without a required repository override, twelve dynamic, and seven fixed Design Studio definitions. A fixed binding does not qualify the dynamic producers. ENG-R07's existing source producer revision mismatch remains an unresolved source gate. Source issue staging and paused routines are not activation authority.

Local validation (Bun 1.4.4 at the operator's existing runtime; no dependency install):

- Initial regression run failed 6/6 because the distinct persisted ingress opt-in did not exist.
- `bun test apps/server/test/paperclip-hook-ingress.test.ts`: 9 passed, 0 failed, 129 assertions. The fixture also follows an HTTP receipt into the fake native worker and checks the trusted private issue reference and unchanged `never` approvals instructions.
- `bun test packages/engine/test/paperclip-routines.test.ts packages/engine/test/routine-hooks.test.ts apps/server/test/paperclip-routines.test.ts apps/server/test/routine-hooks.test.ts`: 50 passed, 0 failed, 606 assertions.
- Engine/server/database package typechecks: passed. Targeted Biome check: passed without warnings. Migration compatibility check, package-boundary check, and `git diff --check`: passed.
- Bare `bun run check:migrations` and `check:boundaries` initially failed because `bun` was absent from shell PATH. Both checks then passed by invoking the existing runtime with the original script directly.
- Independent exact-SHA review and real PostgreSQL qualification on the combined integration revision: pending. No live producer, installed service, deployment or source completion evidence was changed or claimed.
