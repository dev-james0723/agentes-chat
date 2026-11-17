# ADR 0198: Synthetic delivery evidence evaluation

- Status: proposed; development slice only
- Scope: pure fixture data → native evidence resolution → completion classification → zh-HK report
- Production integration: not enabled
- Publication and model trials: not admitted by this change

## Context

The committed communication implementation already provides the evidence reference schema,
a resolver-owned evidence brand, exact task/revision/artifact/source/environment/issuer
matching, a delivery-stage projection, and a founder update renderer. Replacing that
implementation would duplicate policy and risk divergence.

Source inspection and deterministic fixture tests confirmed three gaps relevant to an
evaluation harness:

1. Current-state receipts have no configurable age limit beyond rejecting future timestamps.
2. A test receipt can raise the native projected stage to TESTED while required check counts
   contain failures or checks that have not run.
3. A resolver exception can abort the whole projection instead of preserving other useful
   per-reference evidence.

These are source findings, not a claim that the current production service has the new
communication implementation or this adapter installed.

## Decision

Add a development-only adapter in `packages/engine/src/harness-evaluation/evidence.ts`.
Reuse `communication-contracts` and `founder-updates` directly. Keep their native
authority model, grant handling, production entry points and persistence unchanged.

A follow-on native correctness repair now puts required-test-check classification in
`classifyFounderEvidence`. Native stage projection accepts only supported classifications;
failed, unrun, missing, zero or malformed check telemetry cannot produce TESTED. The synthetic
adapter consumes the same classifier, so it preserves failed/not_run diagnostics without
introducing a bypass flag or a duplicate authority policy. Other delivery-stage meanings do
not change. Deploying this source still requires the existing integration/release gates.

The caller supplies a synthetic task snapshot, requested delivery stages, a bounded list of
evidence IDs, a fixture resolver, and a revisioned freshness policy. Data is snapshotted
before awaiting resolution. A maximum of 100 references is enforced before any resolver call;
duplicates are resolved once. Native schema validation remains the reference-ID authority.

Each reference is passed through the native resolver and matching logic. The adapter records
supported, failed, stale, unknown, unavailable, or not_run. Resolver errors are caught per
reference with a static reason; exception payloads are not copied into reports. Supporting
references alone enter the native founder projection.

A TESTED claim requires valid required-check telemetry, at least one pass, zero failures and
zero unrun checks. The reported counters retain mixed results. This adapter does not
independently authenticate the caller's check counts: they are synthetic fixture data, and
production adapters must obtain them from trustworthy native receipts.

A pinned policy may reuse immutable SOURCE_INSPECTED, CODED or TESTED evidence without an age
limit when the native subject and revision still match. DEPLOYED, LIVE_VERIFIED and
MEASURED_IMPROVEMENT require a finite positive maximum age. This is an explicit fixture
policy input, not a production grant or a universal TTL.

For an explicitly expired receipt, a temporary shallow copy with valid status is used solely
to ask the native matching function whether its subject and issuer would otherwise match.
The copy is never included in support or projected; the original remains expired. An
expired receipt for a different target remains unknown at the claim level.

## Honest output boundary

Every result has mode=synthetic. The fixture delivery stage is distinct from the product
delivery stage. Product availability is always not_available, product delivery stage is
always null, and product improvement is always not_measured—even when the fixture contains
a matching mock live receipt.

The deterministic Hong Kong Traditional Chinese report lists each requested claim, preserves
test counts, identifies unsupported work and states the synthetic limitation. It does not
consume an LLM rewrite or claim semantic-rewrite verification.

The supplied resolver is a trusted test callback. This module does not make arbitrary
callback code safe, authenticate a human principal, verify issuer signatures, enforce
production ACLs, or qualify an evaluator. It is not exposed through a server route.

## Native integration ownership

- Authority, standing grants, routing, shared memory and scheduling remain native.
- Granular commit/push/merge/build/deployment/live evidence remains Delivery Guardian's remit.
- This adapter neither copies an uncommitted Guardian implementation nor publishes a second
  release truth source.
- The candidate prompt remains an inactive draft until an effective native profile, task,
  budget and independent evaluator have been verified.
- Production wiring requires a committed native integration dependency, authenticated
  receipt ingress, real task/owner binding, required-check provenance and the existing
  release process.

## Validation

The accompanying tests exercise matching and mismatched receipts, forged worker assertions,
issuer trust, current-state age, explicit expiry, future timestamps, mixed and unrun checks,
missing telemetry, per-reference resolver failure, document-only endpoints, synthetic live
receipts, bounded input, duplicate references, benign technical text, Unicode IDs and
caller mutation during async resolution.

These public deterministic fixtures are development tests. They do not establish holdout
performance, model improvement, a qualified execution sandbox, independent grading, native
task authorization or live availability. Whole-product acceptance remains separate.

## Consequences

The first slice is small, reviewable and reusable by a later admitted harness while keeping
production behavior unchanged. It depends on the committed communication source selected
for the isolated worktree; promotion must reconcile that dependency with the eventual
authoritative integration checkout. No package installation, database migration, background
job, grant, model request or runtime rollout is introduced.
