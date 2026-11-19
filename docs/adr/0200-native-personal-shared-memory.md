# 0200. Personal shared memory uses native bodies, explicit destinations and durable reconciliation

- Status: Accepted
- Date: 2026-11-19
- Builds on: ADR 0005 (Postgres outbox), 0006 (tenancy), 0017 (context), 0085 (roles), 0088 (deletion), 0120 (personal memory)
- Code: `packages/engine/src/shared-memory.ts`, `shared-memory-store.ts`, `shared-memory-types.ts`; migration `0281_shared_memory.sql`

## Context

A person may own several independent workspaces and want their agents to use the same reviewed memories. Copying Markdown into each workspace leaves corrections, source identity, membership changes and deletion outside the native lifecycle. Copying a model's inference into several places also risks making one source appear to be several independent confirmations.

The application already has versioned `context_items`, source visibility, native producer event receipts, a durable Postgres outbox, context-usage records and membership locks. These remain the storage and execution mechanisms. A separate vector memory database is not the authority for this feature.

## Decision

### One owner and explicit enrollment

One profile belongs to one authenticated user, with one canonical organization. Enrollment requires that user to be the sole human owner of the canonical organization and every selected destination. Agents are not members for this test. A new workspace receives nothing until explicitly enrolled; a new agent uses the existing native context-reading path without a separate copy per agent.

The profile, destinations, stable entry bindings, replica baselines and source receipts are metadata-only tenant tables. Memory bodies and their history remain in `context_items`. The first migration binds existing organization-wide current items and all their same-organization predecessors. It preserves their IDs, titles and bodies. Existing destination copies are adopted by explicit ID, or by one unambiguous exact title/body match; differing copies become conflicts.

### Capture and correction authority

Native inserts and edits capture the source organization, item and original source IDs, source revision, observation/validity dates when known, assertion type and review state. New automatic capture requires a native person scope bound to the profile owner, a direct authenticated owner memory write, or a live owner source with explicit positive remember/correct intent. Existing managed IDs, their derived sources and exact echoes remain tracked. Unrelated operational notes retain their existing native scope and local availability; the application does not guess that every note is personal. An agent-derived personal claim becomes a candidate. A model-provided `verified` flag is not owner authority.

Direct authenticated owner writes can become active. An agent saving the owner's explicit memory instruction can do so only when every cited source is a live owner-authored message, the intent is positive and unambiguous, and the saved claim equals the complete payload of a top-level remember/correct directive. All qualifiers must survive; matching a substring is insufficient. Questions, negative instructions, quoted or fenced examples, connected-app content and invented extra claims remain candidates. Current and historical exact echoes are recorded as rejected metadata and their redundant native bodies are archived. An intentional owner correction to an existing entry may return to an earlier value.

Accepted person- or agent-scoped native records receive an organization-wide canonical head while retaining their actual source item, organization and source IDs. A subsequent authenticated correction to the retained original updates the same stable entry when its baseline still matches. Projection copies do not create independent evidence.

Native supersession advances the stable entry binding and a separate control revision. Portal edits and decisions use that revision for compare-and-swap; the native item revision remains visible separately. A current replica's direct owner correction may update the canonical binding. A stale or inferred replica change is preserved as a conflict and a review candidate. It cannot be accepted as an unrelated duplicate fact: the owner corrects the current canonical entry and resolves the proposal explicitly.

### Native events and repair

Each tracked mutation enqueues `memory.shared.reconcile` in the same transaction, using the existing outbox's deduplication, leases and retry behavior. A worker tick also enqueues one repair per profile per UTC day. Reconciliation reads all entry pages, locks the canonical and target membership fences in stable order, and rechecks membership and allowed sensitivity before writing.

The reconciler compares the stored destination baseline before a superseding native write. A divergent destination is held as a conflict, never silently overwritten. A memory whose canonical body or source is no longer readable is marked blocked and its active projection is archived; the scan continues for other entries and destinations. It always carries the native title and pin state. A retry of an already applied revision changes no body. Generic semantic consolidation and housekeeping do not rewrite managed heads; those have their own correction and review lifecycle.

Both native item listing and the portal support stable ID cursors. The portal revision also advances for source metadata changes. A separate `availabilityRevision` is computed over the complete profile's live native body/source availability, including entries outside the current page. Withdrawing a source changes this digest even if no memory control revision changes. Exporters bind both values on every page, the final read and their receipt; consumer acknowledgements do not advance the revision they acknowledge.

### Read boundaries and membership changes

The managed-owner guard is stricter than `review_memory`: a new administrator or co-owner does not become the profile owner. Human inspection, search, native mutation responses, migration exports, learned proposals and source closure enforce that boundary for current and historical bodies. The native rules path, own-words prompt exception and mission search also enforce managed availability. Generic native deletion requires the managed owner. Portal records whose sources are unavailable retain control metadata but withhold current and historical bodies, native body IDs and item versions; they are not counted or exported as current facts.

Agent reads require an active, owner-only enrollment, an allowed sensitivity, an active canonical revision and a current replica control revision. They recheck the canonical hash and live native source visibility; a deleted source cannot remain readable merely because a destination copy has empty cross-tenant source IDs. An exact historical ID is not a current agent fact. These checks apply immediately, before a queued repair runs.

Membership admission, role changes and removal suspend relevant destinations under the existing membership transaction before another human enters. Existing current bodies, including retained person- and agent-scoped origins, are archived and histories remain owner-only. A disabled or blocked destination is not silently reactivated by the daily repair. Explicit re-enrollment after the same sole owner is restored may reactivate unchanged current heads and retained origins in the selected organization; rejected, superseded and forgotten bodies are not restored. Suspending an origin can make its dependent canonical fact unavailable until that origin is safely re-enrolled. Disabling a destination requires an existing binding of this profile and suspends only that profile, not another user's enrollments. Owner-account and canonical-workspace deletion redact foreign managed bodies before binding metadata can cascade away.

### Forget and external limits

Profile forget redacts managed current bodies and history, removes their search projections immediately, records hashes and a stable tombstone, and includes linked managed claims and exact duplicates of current or historical values. Workspace forget applies that same duplicate closure only to bodies in the selected destination, including archived echoes and candidates, and leaves destination tombstones. Canonical bodies elsewhere remain intact. The common tombstone fence runs on native ingestion and reuse of existing rows through adoption, capture or acceptance, so a pre-existing old source cannot recreate a forgotten copy. A missing row is not treated as an instruction to delete another store.

If a scoped forget erases an accepted fact's original destination body, a matching explicit destination tombstone may preserve that accepted canonical fact. This exception retains the real origin identity and rechecks its original nested source IDs; it does not treat arbitrary missing or archived sources as evidence. A later withdrawal of an underlying owner message still makes the canonical fact unavailable.

Source archives, existing conversation text, file exports and imported consumer memories are separate deletion surfaces. The response lists external removals still outstanding. A successful native forget never claims that ChatGPT, Claude, source Wiki pages or arbitrary files have also been erased.

### Evidence and consumers

The portal reports facts, candidates, native history, source freshness, destination states and a graph of recorded source/copy/conflict relationships. It adds no inferred semantic edges. Destination counts compare the actual applied control revision; changing content immediately makes an older receipt pending. A correction, forget, membership or source change invalidates prior retrieval verification.

Retrieval verification requires a real completed native run in a fresh owner-started thread, within the last day and after the checked revisions. It checks exact current IDs in native `context_usage` and their current source readability. A saved passing result is rechecked when read, so source withdrawal cannot preserve an obsolete proof. It does not grade final answers or prove that every agent has used every fact. Consumer receipts cannot enable writable connectors. Native ChatGPT and Claude stores remain snapshots without an implemented adapter; a current file receipt is limited to the acknowledged profile revision and complete-profile availability digest. A missing or stale digest makes the receipt pending.

The optional Mem0 evaluation is isolated behind configuration and installation-owner authorization. It uses a fixed synthetic dataset, preserves source identity in projection metadata, and cleans up its owned test records. It reads no personal profile bodies. Native memory remains the sole authority whether this evaluation is enabled or removed.

## Consequences and alternatives

- The feature reuses Postgres transactions, outbox workers, native memory history and native source visibility. It adds no Redis service, external personal-memory store or per-agent synchronization database.
- Joining a second human intentionally suspends sharing, even when the new person is an administrator. Supporting shared human teams would require explicit per-person audience policy; that is not implied by workspace ownership.
- Exact-source promotion is conservative. Paraphrases and ambiguous corrections remain reviewable candidates rather than silently becoming authoritative facts.
- A conflicted replica is not overwritten. This can require an owner to correct the canonical fact before all destinations become current again.
- Body availability, successful replication, recorded retrieval and answer quality remain separate claims. The UI and receipts must retain that distinction.
- A second memory service as canonical authority was rejected because it would duplicate source policy, versioning, tenant access and deletion. File-only synchronization remains an export consumer rather than the native coordinator.

## Verification

Focused PGlite suites cover adoption, supersession, current-replica correction, deliberate owner reversal, compare-and-swap conflicts, candidate capture, exact and historical echoes, unrelated invented claims, source withdrawal, scoped/global forget, blocked reimport, new co-owner read/delete attempts, sensitivity revocation and stale retrieval/file receipts. HTTP tests cover session authorization, same-origin writes, action validation, paginated listing and export behavior. The synthetic Mem0 suite is separate and does not establish production retrieval quality.
