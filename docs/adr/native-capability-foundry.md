# Native Foundry: current design and integration boundaries

## Current status

This change implements a task-scoped Foundry control path for one allowlisted pure-tool contract, `receipt-normalizer/v1`. It uses the existing agent run, task, permissions, Tool Gateway, approval, blob storage and outbox infrastructure.

The feature is **off by default**. The current server wiring does not supply a concrete qualified isolated executor or an authenticated protected evaluation store. Enabling discovery alone does not make candidate execution available: the lifecycle falls back to `createUnavailableFoundryExecutor()`, and evaluation or execution remains blocked.

The implementation and its integration tests must be distinguished from a live candidate release. Native database and Gateway paths have been exercised with PGlite and simulated external services. No production isolation, real candidate execution, mobile/keyboard approval UI, deployment or R4 completion follows from those tests. Release-specific test counts and execution receipts belong in the verification record, not this design document.

## Components and ownership

| Component | Responsibility |
|---|---|
| Native tasks and agent runs | Provide the existing task, person, agent, trigger and foreground run context. Foundry does not create another agent, task or schedule. |
| Native permissions and Tool Gateway | Filter tools by scope, validate calls, apply native policy, open exact approval requests, resume approved calls and frame external data. |
| `packages/engine/src/foundry/packages.ts` | Validate and freeze inert package bytes, derive immutable identity and re-verify stored bundles. |
| `packages/engine/src/foundry/service.ts` | Check native ownership, perform bounded draft intake, reuse supported native metadata, deduplicate candidates and stage private blobs. |
| `packages/engine/src/foundry/receipt-contract.ts` | Define the fixed input/output contracts, strict data validation and ordinary-call applicability rules. It does not implement or execute the generated transform. |
| `packages/engine/src/foundry/tools.ts` | Expose management and scoped pure tools as one native `ToolSource`. It is not a separate invocation pipeline. |
| `packages/engine/src/foundry/lifecycle.ts` | Bind evaluation, approval, version, runtime, budget, invocation, canary, revocation and recovery decisions to native authority. |
| `FoundryExecutor` in `packages/adapters` | Define the subordinate runner boundary, qualification and receipt validation, bounded control calls, cancellation and read-only reconciliation. |
| Native DB schema and blob resolver | Store candidate/version/binding/invocation metadata and private frozen package objects. These tables do not replace the Skills registry. |
| Native outbox and task activity | Persist recovery work and truthful lifecycle events without introducing another queue, scheduler or orchestrator. |

Existing model routing remains the route for an agent's model calls. This layer adds no provider client or alternative model router. Existing Skills and learning infrastructure remain available; this change does not implement an autonomous learning or promotion loop.

## Admission and task scope

The server resolves identity from the native run and person behind it. The current path requires a running foreground run associated with a visible, active native task assigned to the calling agent, and observes native operator holds. Candidate ownership binds organization, task, person and agent.

A context revision covers the task's title, description, criteria, audience, restrictions, assignment and project/channel context. Changing the relevant task context invalidates an older candidate's authority rather than expanding it.

Package authors may request a scope or describe effects. Those fields are advisory input to admission; they do not grant permissions. This intake accepts only the fixed pure receipt tool at task scope, with the exact native receipt contracts, no dependencies, no private data, no network or secrets, and no external or nested capability actions.

The ToolSource returns no tools and performs no discovery I/O when disabled. When enabled, every call still rechecks current native context. Native Gateway scope checks and lifecycle checks remain required after a tool has been listed.

| Tool or operation | Native scope | Applicability requirement |
|---|---|---|
| `propose_foundry_capability`, `stage_foundry_package` | `skills:read` | Persisted trigger must explicitly describe the supported synthetic receipt work. |
| `evaluate_foundry_capability`, `prepare_foundry_activation` | `sandbox:run` | Fresh native task authority; no normalization phrase required for control work. |
| `activate_foundry_capability` | `sandbox:run`, sensitive | Fresh native authority plus the exact native approval. |
| `run_foundry_canary`, `revoke_foundry_capability` | `sandbox:run` | Fresh native authority. Recovery remains available on a request such as revoking the tool. |
| Ordinary pure-tool invocation | `sandbox:run` | Fresh authority, current active binding and positive receipt applicability. |

An expense/invoice explanation must not expose or run the ordinary receipt transform. That negative control does not remove an authorized task owner's control/recovery tools.

## Immutable packages and the fixed receipt contract

`freezePackage` processes supplied bytes as data. It does not read a supplied filesystem path, follow a link, extract an archive, fetch a dependency, import a candidate or start a process.

Raw manifest parsing rejects duplicate decoded JSON keys. Package paths are normalized to NFC and slash separators, sorted and checked for traversal, absolute paths, links, non-files, empty paths, case-fold collisions and file/directory conflicts. Current bounds include a 64 KiB manifest, 100 files, 1 MiB per file and 8 MiB expanded file bytes.

The package digest covers the canonical manifest and the sorted path/hash/byte-count inventory. The stored bundle retains the bytes in canonical base64. `verifyPackage` rebuilds identity from stored bytes and rejects changed content or metadata. A digest proves content identity; native authority still has to bind that exact digest to evaluation and approval.

Staging reserves a bounded version record before blob upload. Successful upload is read back and verified before the version becomes a usable draft. Lost or failed storage acknowledgement leaves a bounded blocked/staging record, not an assumed successful package. Referenced evidence is retained; retirement is restricted.

The receipt input is exactly `{ records: [{ status, tokens, note? }] }`:

- Status is one of `succeeded`, `failed`, `cancelled`, `unknown` or `unverified`.
- At most 1,000 records are accepted.
- Each token count is a safe integer from zero to 1,000,000,000.
- A note contains at most 4,096 Unicode scalars, with no unpaired surrogate.
- Serialized input is bounded to 1 MiB.
- Extra, inherited, hidden, accessor or unexpected-prototype fields are rejected.

Output is exactly `{ total, counts, tokens }`. All five counts are present, nonnegative and sum to total. Total is at most 1,000; the token sum is a safe integer bounded by total times the per-record limit. Notes remain inert data. The shape validator does not prove that an output is the correct aggregation of a particular input; independent evaluation supplies that evidence.

The native JSON Schema string-length check counts Unicode code points, so the Gateway's note length check agrees with the contract for astral characters.

## Reuse: implemented behavior and remaining limitation

Draft intake has a server-only optional `nativeReuse(ctx, contract)` dependency. A result can identify an already-authorized native tool and its version. **The current server wiring does not supply that callback. An absent callback is not a completed search returning no matches.**

The implemented fallback checks enabled native Skills assigned to the current agent in the same organization, excluding deleted Skills, and matches the exact `metadata.foundryContract` value. It returns the Skill's identifier and version. This is exact metadata discovery, not independent proof that the Skill implements an executable pure-tool contract.

Candidate fingerprint and context deduplication also exist. Neither that deduplication nor a stub returning `null` constitutes a production native-tool inventory search.

The Gateway can enumerate authorization-filtered tool definitions, but those definitions generally expose a name, description, input schema, scope and connector identity. They do not establish the trusted output contract, complete effect contract and immutable implementation version needed for safe substitution. Name/description similarity or an input-schema match must not be treated as equivalence.

Accordingly, R1 pre-draft native-tool search remains **partial**. A later completion should resolve reviewed contract/version metadata through the existing authorized inventory, without creating another registry or using fuzzy substitution.

This intake limitation is separate from scoped fresh-session reuse. An already-active Foundry binding is discovered through the native lifecycle and exposed through the existing ToolSource/Gateway with its pinned version identity. That control path is implemented and covered by native integration tests using simulated external services.

## Exact approval and version identity

Activation parameters bind the candidate revision, package digest, contract/effects digests, task, agent, person, evaluation reference, runtime/profile digests, expiry, call budget and previous binding.

The sensitive activation tool uses the existing native approval card and decision machinery. The lifecycle checks the persisted approval, its action hash, decided identity, execution claim, scope and exact parameters. A model-provided `approved` field is rejected. A manually supplied `ctx.approved` flag is insufficient without the matching consumed native approval record.

A PGlite integration test exercises the real native sequence:

1. `Gateway.invoke` creates a pending activation approval and no binding.
2. Native `decideApproval` records the person's decision.
3. `Gateway.executeApproved` claims and resumes the exact action.
4. One binding enters `CANARY`; replay returns the saved native result without another binding or candidate dispatch.

This proves that native API/database path under test. It does not verify the browser/mobile/keyboard presentation of the card or an actual deployed instance.

Activation permits the bounded canary; it does not immediately make ordinary reuse available. A verified canary must move the binding to `ACTIVE`.

Pure-tool names contain both candidate identity and a 20-hex digest suffix, within the native 64-character limit. This prevents a delayed model call from silently selecting a replacement version when the Gateway refreshes tool definitions. Each closure also pins candidate, binding and digest, and re-discovers current authorization on both check and execution. Scope checks preserve relevant denies across known versions and the earlier candidate-only name, so upgrading a version does not erase an existing tool-off decision.

## Qualified execution and protected evaluation

The default executor is unavailable. The qualified wrapper is an admission and receipt-validation boundary, not a concrete isolation implementation.

A concrete runner must provide an immutable runtime identity and complete enforced profile, including mounts, environment, network/DNS/metadata restrictions, host-secret/socket exclusion, tenant isolation, fresh scratch, process-tree cancellation and resource limits. Protected probe evidence must bind that identity and profile, remain unexpired and unrevoked, and come from the configured trusted qualification authority.

The global pure-tool ceilings are 10 seconds wall/CPU time, 256 MiB memory, 32 MiB scratch, 32 processes, 64 KiB per log stream and 1 MiB input/result. A manifest may request stricter limits. Admission must honor those stricter limits; a broader global profile is not sufficient.

The trusted runner must verify package and input identity at dispatch, enforce limits at their source, and produce receipts tied to organization, invocation, fence, package/input digest, runner, runtime/profile and qualification. A timeout or a stopped current process does not prove that delayed work cannot start later. Cancellation requires a durable cancel-before-dispatch tombstone and independently verified behavior across restart.

Evaluation is a separate protected dependency. Its evidence binds the exact candidate/version and runtime/profile to an independent evaluator, protected artifacts, expiry and trusted canary expectation. Author-supplied tests, a different evaluator label, or a self-reported PASS do not establish that separation.

Because the builder never reads the protected scorer, the public contract it is given (`foundry/guidance.ts`) must state everything the scorer checks: the meaning of each output field (`total` is the number of records), that a malformed input is refused by an Error whose own `code` is `SCHEMA_INVALID`, that note limits count Unicode scalar values, and that nothing is written to stdout. `packages/adapters/test/foundry-receipt-conformance.test.ts` runs the unchanged scorer against an implementation written from that contract, and against each of those mistakes. A failed evaluation is final for its digest and is not run again; its result carries the way forward, a checklist in the contract's words and how many corrected versions remain (four per candidate, the first included), never a holdout, expected output or verdict detail. Repair is therefore bounded, not a loop.

A draft JavaScript module with a proposed JSON-string-to-JSON-string export is still a draft. The current profile does not define an ESM loader, entrypoint ABI, stdio/RPC framing or bootstrap. Those must be reviewed and implemented inside the qualified runtime. No host loader, shell command or existing unrestricted application container is a fallback.

## Durable invocation, revocation and recovery

Before dispatch, the native transaction reserves the call budget and persists invocation identity, input digest, binding generation, fence, lease and pinned runtime metadata. Organization/run/tool-use identity provides idempotency; changing the input or binding under the same invocation identity is refused.

One dispatch claim may transition a reservation to execution. Recovery has its own durable revision, so a stale original dispatcher or an older recovery worker cannot overwrite a newer result.

The existing outbox carries `foundry.reconcile` work with a deduplication key. Recovery does not call execute again, regenerate input, refund an ambiguous attempt into an automatic retry, or release recovered output to another model run. It checks current authority and the outbox ownership predicate before persisting or promoting results.

Canary uncertainty remains pending until evidence resolves it. A duplicate in-flight canary is not a canary failure and must not trigger rollback. Durable terminal canary evidence permits recovery after a process crash between receipt storage and binding promotion.

Revocation increments binding generation and removes discovery eligibility. A never-dispatched reservation can be cancelled atomically. Dispatched or uncertain work requires the executor's bounded cancellation path; missing termination proof remains unknown. A previously cached definition and a late result must not restore revoked authority.

A failed canary quarantines the new version. A previous binding is restored only after current checks of its package, evaluator/runtime evidence, scope, approval, expiry and revocation state. If the previous version is no longer eligible, the capability remains unavailable. Rollback is not permission to reactivate revoked or expired code.

Recovery is intentionally incomplete as a parent-continuation system. It currently requires the original native run to remain active, performs one bounded outbox reconciliation attempt and does not wake or resume a checkpointed parent. Evaluation is synchronous; an interrupted evaluation remains blocked instead of being automatically replayed. Native parent delivery/resumption and durable asynchronous evaluation recovery remain separate implementation gates before AT-42 can pass.

## Status vocabulary and the next integration gates

| Status | Meaning in this change |
|---|---|
| Drafted | Source/manifest or frozen bytes exist; this conveys no functional or isolation proof. |
| Tested control path | Native engine/Gateway/DB code was exercised under a test environment. External executor/evaluator results may be simulations. |
| Evaluated version | A particular package/runtime identity has qualifying independent evidence. No real candidate has acquired that status merely through harness tests. |
| Activated binding | Exact native approval created a bounded `CANARY` binding. Ordinary reuse still waits for a verified canary. |
| Live verified | Requires actual execution and fresh-session reuse on the authorized deployed environment, with the required negative, revocation and rollback evidence. |
| R4 | Unavailable. No autonomous learning/promotion or broader-scope rollout is implemented or authorized by this slice. |

Before a live pilot, complete these concrete gates:

1. Finish the branch's native schema, type, lint and integration gates, then verify the intended deployed revision and feature configuration under the existing task authorization. Keep the feature off until the runtime dependencies below exist.
2. Provision a concrete isolated runner and protected qualification store. Define the transport/entrypoint, verify immutable runtime/profile identity, and run the full independent isolation, limit, cancellation, restart and reconciliation probes. Satisfy the candidate's actual effect and process/thread requirements without silently widening them.
3. Provide a protected independent evaluation service/store with genuine builder/evaluator separation. Evaluate the exact frozen candidate, including baseline, adversarial and held-out cases; do not treat harness simulation receipts as candidate evidence.
4. Complete an authorized native-tool reuse adapter based on explicit trusted contract/version metadata, or record the R1 intake search as limited. Do not substitute by keyword similarity.
5. Through the native Gateway, obtain the exact task-scoped decision and run a real canary, a fresh native-session invocation, an unrelated-task negative control, explicit revocation, and a failed-upgrade rollback. Verify stale names, cached definitions, changed permissions/context and late results remain denied.
6. Consider R4 only as separate subsequent work after that evidence exists. Reuse native learning/model routing and task infrastructure, preserve stop authority and budgets, and require fresh authorization for any wider scope.

The acceptance record should retain actual evidence references and distinguish simulated tests, real isolated execution, activation and deployment observations. This document describes source boundaries; it is not a release certificate.
