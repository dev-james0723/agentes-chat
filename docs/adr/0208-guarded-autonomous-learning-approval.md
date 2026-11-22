# ADR 0208: Guarded automatic approval of verified learning

**Date:** 2026-11-22
**Status:** Implemented in a feature worktree; not enabled in existing workspaces or released

## Problem

AC learns from conversations, outcomes, recurring technical lessons and skills, but the proposal pipeline still asks people to accept each strong change to an agent's own instructions. This can block useful, already-verified refinements. Eliminating all approvals would be unsafe: instructions can alter behavior, and an agent must not approve more tools, repository access, publication or account changes for itself.

## Decision

Add **Auto-accept verified learning improvements** to Settings → Skills, stored in `organization_settings.auto_approve_learning`, default **off**. Only a person with `manage_agents` may enable or disable it. Every change of the setting has a person-attributed audit record.

Reuse `proposeFromItem` and `context_proposals`. In the opt-in lane, accept *only* a short, verified, repeatedly observed, high-trust, undisputed **agent-local lesson** promoted to a non-executable bullet in that same agent's own instructions. The lesson must be supported by an actual human correction, or an independently persisted positive test/CI/criteria outcome (matching organization and agent). A claim that a run finished is not proof. Never auto-accept org-wide context, access, roles, settings, skills containing scripts, or executable commands.

Admission requires:
1. Existing promotion guard and a live `auto_approve_learning` setting.
2. Agent-local, active, high-trust, `verified`, non-disputed `lesson`; at least two observations/uses.
3. Human evidence, or a matching, positive and independently recorded CI/test/criteria outcome from an approved source.
4. A bounded, single-line, non-executable text; deny obvious secrets, credentials, elevated-rights instructions, external actions and code.
5. A live independent `permission_change` semantic check. Absent or errored judge: manual review (fail closed).
6. Recheck the enabled policy and original instruction SHA under database locks; a stale change becomes a pending proposal rather than overwriting newer instructions.

On success the existing proposal is persisted as `accepted` in the same transaction as the agent update, the promoted memory is archived, search is re-indexed, caches are invalidated, and an audit record with **system** actor is written (`learning.proposal_auto_accepted`). No user ID is forged in `decided_by_user_id`. All other cases retain the existing human-review process.

## Threat model and exclusions

This setting is *not* a blanket command/tool approval. It never grants or widens capabilities, alters permission rules or bypasses existing authorization, makes payments, sends external messages, deletes data, merges PRs or deploys production. A human-visible prompt or an agent assertion cannot enable the switch. Even if an agent asks another agent to accept its proposal, only this server-enforced policy may admit it automatically.

Instruction edits are reversible by restoring their previous text through the existing agent editor; every auto acceptance stores the full `proposed_text` and diff in the proposal and the item ID in its audit record. A one-click guarded Undo for automatic instruction changes is not part of this first version. Turning off the switch prevents new admissions but does not undo previously accepted lessons.

## Rollout and verification

- Deploy database migration `0282_learning_auto_approval.sql` before enabling the API and switch.
- Verify old workspaces retain `false` until an administrator opts in.
- Test both policy states, legitimate evidence, negative/claimed outcomes, unauthorized setting changes, scope isolation, dangerous lessons, absent/negative judge, and the Settings switch.
- Preserve existing CI/merge guards; run tests locally. Do not bypass branch protection or independently deploy this change.
- Once independently reviewed and integrated, an admin can activate only the intended organization and observe `learning.proposal_auto_accepted` receipts, then disable immediately if behavior degrades.

## Related

ADR 0120 (agents learn on their own), ADR 0139 (proposal decisions and right-hand attribution), ADR 0167 (evidence provenance and outside-content trust), and existing skills safety rules.
