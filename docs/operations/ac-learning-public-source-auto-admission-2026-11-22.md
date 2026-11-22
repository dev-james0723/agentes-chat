# AC automatic-learning source-visibility gate — isolated security patch

**Date:** 2026-11-22. **Base:** PR #78 at `b27553d122a4da32ae78660b1275691e6510460b`.
**Branch:** `fix/ac-learning-private-source-20261122`. **Release:** NOT DEPLOYED.

## Issue and threat
The initial reviewed PR #78 accepts some authenticated owner messages or independently verified CI outcomes into an agent's global instructions. The two proof paths revalidate identity and content, but did not require the original source channels to be public. An owner message from a private channel, or a CI outcome with a private `channel_id`, could therefore become a reusable global instruction, widening the audience even when the instruction text looks harmless. A private message embedded as an additional context source could also be laundered through a public CI receipt.

## Fix
`verifiedLearningEvidence` now admits automatic instructions only when every declared source channel, currently linked message channel, and linked outcome channel is an active ordinary public channel with no DM key and no restricted role audience. Channel-free independent CI results may qualify under the existing same-subject trusted-proof policy. The check runs before independent semantic judgment and again inside the existing acceptance transaction; the channel rows receive share locks, preventing channel reclassification while a transaction is accepting the lesson. Existing manual-review cases remain pending and no permission rules/skills/credentials/roles are changed.

## Evidence and test coverage
- RED: a true owner-authored message from a private channel was incorrectly `accepted`; expected `pending`. Proof: `pr78-private-evidence-red.log`.
- GREEN: the same regression passes with the public-source gate. Proof: `pr78-private-evidence-green.log`.
- Private linked message cannot be laundered by a legitimate external CI outcome; public-to-private reclassification during judge evaluation forces `pending`. Proof: `pr78-source-privacy-golden.log` (3 passed).
- RED: an independent CI outcome from private channel was incorrectly `accepted` when the item did not declare its channel. Proof: `pr78-private-outcome-red.log`.
- RED/GREEN: a missing or deleted extra source ID could previously be ignored while a legitimate public owner message passed the gate. Every linked UUID source must now resolve to an extant, non-deleted, same-organization message or outcome, with read locks; unrecognized/opaque sources retain manual review. Proof: `pr79-source-identity-red.log` and `pr79-source-identity-green.log`.
- GREEN: outcome source-channel verification makes that case pending. Proof: `pr78-private-outcome-green.log`.
- Full current-branch feature suite: **24 passed, 0 failed, 47 assertions** on the amended security patch; TypeScript exits 0. Final exact-code test receipt: `pr79-identity-final.receipt`; regression RED/GREEN: `pr79-source-identity-red.log` and `pr79-source-identity-green.log`; TypeScript and Module Boundaries both exit 0 at base `b27553d`. Evidence: `pr78-privacy-all-tests.log`, `pr78-privacy-tsc.log`, `pr78-privacy-boundaries.log`, and SHA256 receipt `pr78-privacy-all-gates.receipt`. These are PGlite/native fixture tests, not a production canary.

Evidence folder: `~/Documents/Agentes-Handoffs/ac-self-creating-skills-20261122/`.

## Scope exclusions and release gates
This is not executable-Skill auto-approval, not cross-agent specialist assignment, not a restoration of the revoked Qwen Summary endpoint, and not production verification. PR #78 remains governed by its independent reviewer, local CI, required `release/independent-review` protected check, final mainline integration, migration and production rollout. Leave the feature OFF by default until actual end-to-end canary and owner-authorized activation. Do not replace the stacked production image with a stripped build.

Private data already written into a public source is outside this provenance-only gate; it still relies on the existing sensitive-content checks. Source channel reclassification **after** a successful acceptance requires a separate revocation policy; this patch prevents reclassification races **during** admission but makes no retroactive removal claim.

## Follow-up hardening: CI must attest exact instruction

A passing CI status does not itself validate a proposed instruction. Until a trusted, content-bound independent attestor is available, the security-hardening branch keeps CI-only learning proposals pending human review, even when the CI event and source channels are valid. The public-source gate remains enforced for all sources.
