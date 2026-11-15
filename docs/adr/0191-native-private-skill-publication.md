# 0191. Native one-time disclosure before private skill publication

Status: source implementation, independent review and runtime qualification pending.

## Problem

An agent can read a private conversation and call `update_skill`. The previous agent-learning path could write that draft into an organization skill or a broadly visible proposal. Existing approval administrators could also see an approval's raw parameters and narration. An ordinary `approved` context or a remembered tool rule is not the source owner's consent to disclose a private draft.

## Decision

Reuse native approvals, action hashes, authenticated decision endpoints, resume outbox and the skill writer. No dependency, schema, protocol or second approval store is introduced. The imported ADR0190 support helper remains read-only and always reports `mayPublish:false`; runtime authority comes from the separate native-v2 issuer.

The first supported private flow is one fresh direct message from one current human source owner to this agent, a body-only change to an assigned resource-free skill, and complete native context/read coverage. Native context assembly records `Transcript.publicationCapture` version2, current configuration and source hashes. Additional unqualified context, attachments, connected descriptions, external reads, missing/legacy capture, multiple owners, background/bridge runs, resources and uncertain sources defer with fixed text. No shared proposal or raw tool-call input is created for these cases. This is a bounded source capture, not a general taint or publication-authority system.

Native `load_skill` receipts bind the loaded skill/version. A same-owner `expand` may qualify only when the genuine native reader recorded the exact delivered item's content, version and authority snapshot. Retrieval counters are excluded. A changed source, including a shorter substring, invalidates the request. A private WeakSet distinguishes genuine native updater/reader objects from similarly named tools. Model flags, ordinary `ctx.approved`, remembered rules, never-ask settings and bulk decisions cannot supply disclosure authority.

The native envelope binds organization, agent, run, original channel/thread/trigger, tool-use ID, original owner, target/base version/body/resources, source/audience/capture hashes, exact normalized draft, purpose and a ten-minute expiry. Every owner GET, decision, preflight and claim rechecks current source references, membership, permissions and grants. Unknown envelope versions remain private and non-executable.

Only the original current owner receives the protected request. Lists/cards contain a fixed summary and no draft, reason, result or narration. Full protected GET supplies the current server-derived skill name, pinned base version, complete exact draft and action fingerprint. Other administrators receive neither the row nor its private count. Generic notifications, email/push/digests, home/team summaries and relocated approval cards exclude private requests. The original DM has a fixed review card and the owner receives a sanitized refresh event.

Web and mobile open the protected GET before a decision. They show the full draft as safe text, the organization skill-library destination, and an explicit one-time confirmation. Cached or failed/rechecking previews cannot display the draft or enable consent. Events/decision responses remove protected previews and never copy them into list caches. No inline, remembered or bulk consent is offered. The decision POST must echo the protected fingerprint. The existing cancel endpoint can withdraw pending or approved unclaimed private requests.

After approval, native resume reloads the stored envelope and invokes only the genuine native updater. Judge checks run before the short database transaction. The transaction locks run, approval, skill and relevant current authority/source rows, rechecks bindings, claims once, writes the skill version/action and a sanitized receipt atomically. No private blob IO or Judge call occurs under those locks. Storage failure rolls back the claim and version; error text is sanitized. A duplicate consumed receipt returns its saved result without another publication. Unknown outcomes require inspection, not automatic replay.

Proven public native calls retain existing read-before-write, scope, permission, script/proposal and agent-learning policies. Explicit owner manual UI/import paths and shared imported skills remain supported. Old synthetic tests with no native source capture were updated to capture actual context; tests that expected an unknown/private draft to become a shared proposal now expect sanitized deferral.

## Research and verification

The pinned local Agentes implementation (base2103, upstreamd7) is the maintained AGPL native solution already installed in this project. LangGraph1.2.21 (MIT, commit a054ed08dcee7ecc4105706d38c0b4aa0b3c3c32) provided primary checkpoint/interrupt/idempotency design references only. No upstream code or dependency was copied. Research evidence and executed command receipts are private under `work/private-update-native-flow` outside this worktree.

Actual native executor, Gateway, authenticated HTTP, PGlite rollback, client cache and rendered web fixtures cover protected approval/publish-once and refusal, expiry, withdrawal, ACL/grant/source/base/envelope drift, forgery, bulk/never bypass, private counts/fanout, full preview and stale/error refresh. Existing ordinary approval/skill/notification and18/24 query-budget controls remain required.

Real multi-connection PostgreSQL contention, rendered installed mobile/browser acceptance, live publication and deployment are separate gates. No live approval, model/provider call, registry change, native grant or release is authorized by this source change. This ADR must not be represented as runtime acceptance.

## Concurrent transcript controllers

`storedTranscript` preserves the current row's `bridgeEffects`, `metadata` and `publicationCapture` with presence-aware JSON object merges. Present JSON null and nested null/object/array/string values remain verbatim. In-memory copies cannot overwrite these controller-owned fields. Metadata has type `unknown` and provides no disclosure authority. A native factory brands fresh captures in a private WeakSet and may initialize only when the current row has neither a capture key nor a stored system transcript. Existing invalidation/legacy coverage wins. A metadata-only row requires actual native context assembly before it becomes a transcript. No additional query is introduced.
