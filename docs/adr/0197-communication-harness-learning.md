# 0197 — Scoped communication, recovery and verified learning

Status: implementation and isolated verification in progress; disabled by default. This document is not a release receipt.

## Decision

Keep native issues, consultations, quota continuity, context items, usage and outbox authoritative. Add contracts, conservative projections and scoped verification at their existing boundaries. The communication pilot requires explicit organization, task and feature allowlists in validated server configuration. It does not change grants.

A task needs a database-owned revision before receipts can bind the current task. Migration 0274 adds a positive generation (initially 1), maintained for every insert/update including legacy writers. This generation begins at migration and is not historical evidence. A new adapter must still compare the expected revision and current owner atomically; the counter itself is not a resource lease.

Nullable issues.communication and context_items.lesson_verification carry versioned references. They do not supply permissions, trusted receipts or a second lifecycle. Unknown versions fail closed in new adapters. Legacy null metadata keeps native behavior. Native issue_activity records the handoff admission, with a unique organization/task/operation key for the declared event/version. Ordinary comments retain their existing behavior.

## Evidence and availability

Task lifecycle completion, an agent's positive prose, a context outcome kind and an arbitrary URL do not establish a passed test or live deployment. Each claimed stage needs eligible native evidence at the exact task and artifact revision and environment, visible to the reader. No extra model call is needed for an ordinary update. Missing required native IDs or check data yields an explicit unavailable/unknown projection, never a fabricated v1 envelope.

## Recovery and learning constraints

Existing continuation, quota pools, model selection, delivery and retry limits remain in control. Unknown external effects require reconciliation before retry. Bridge-effect epochs are run fencing, not resource/worktree writer leases. A new write-capable delegation must fail closed without the required real fencing primitive.

New candidate learning must remain inactive until independent evidence, source lineage, native consent and scope checks pass. Enrolled candidate/shadow/revoked/expired items must never become instructions because a flag was disabled or an older binary was restored. Activation and rollback require native archive/search/cache handling; no candidate enrollment is authorized by the nullable schema alone. Existing authorized human memory remains governed by its native protections.

## Compatibility and rollout

New feature flags default off and require both exact organization and task scopes. No new model service, queue, vector store, scheduler or billing ledger is introduced. Pricing quotes, metered cash, subscription use and local estimates remain separate; missing coverage and zero verified outcomes produce unknown ratios.

Migration 0274 was generated from the current integration base's 0271 snapshot; concurrently authored foundry migrations 0272/0273 were observed in a separate worktree and avoided. The integration owner must reconcile the snapshot chain on the combined authorized branch before release. Do not edit an applied migration. The source branch has not migrated or restarted the serving service.

Production enablement remains subject to the current task/release owners, effective-access verification, exact released artifact, admitted preview/canary and live-path evidence. Isolated fixtures and source commits are not production verification or measured improvement.
