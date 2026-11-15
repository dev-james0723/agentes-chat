# 0188. Private how-tos do not become unscoped skills

Status: Proposed (source candidate; not deployed)

## Context

Memory has source-channel and person visibility. Skills are organization records with agent assignments, not source-audience ACLs: an enabled agent can load a skill in another conversation, and a member with organization read can read its details. Automatic how-to promotion previously dropped memory visibility. Asking the summary model to omit private details and rejecting credential-like strings does not enforce that boundary.

A synthetic engine fixture reproduced a private-channel how-to denied by `expand` in a public run, then automatically promoted and disclosed by `load_skill` in that public run. An unassigned agent was correctly denied, while an organization-read member could read the promoted body. This establishes a source path defect, not an installed incident. Native issue projects group tasks; they are not private-project ACLs. Registered execution workspaces are a separate authority and are not skill-content ACLs.

## Decision

Until skills have source-audience enforcement, automatic promotion accepts only an agent-scoped note with a matching agent scope and complete nonempty actual message provenance. Every declared source channel and actual message source must currently resolve in the same organization to an active, ordinary public channel, with no role audience or DM key. Missing/deleted sources, private channels, DMs, task channels, person scopes and unknown provenance stay memory. An empty declared channel list is insufficient by itself; complete public actual sources are still required.

Filter notes before clustering and before summary inference, so a private sibling cannot be summarized with a qualifying public note. Before publication, lock and compare the current notes and recheck their current sources in the insertion transaction. Channel then message share locks keep their classification/deletion stable through publication; notes are locked in ID order and compared against the summarized input. A changed note or classification aborts publication, preserving the notes instead of archiving them. No proposal containing the private payload is created.

No schema, permission, assignment, tool, service, dependency or existing manual-sharing API changes. Explicit human publishing/importing/assigning of shared skills, including an authorized shared library, is unchanged. Private notes remain usable through their existing memory ACLs. Older notes without complete provenance stop automatic promotion and can be deliberately reviewed through existing authorized human flows; this change does not fabricate provenance.

## Boundaries

This prevents one future automatic widening path. It does not retrospectively classify, archive or sanitize existing agent-made skills, add project privacy, implement source-taint tracking, or prevent someone from putting confidential text into an otherwise public source. A later explicit source-channel reclassification does not revoke already published skill content; no full revocation invariant is claimed.

The separate private-run `update_skill` disclosure is still open. A person's `ownWords` and permission identify the actor, not exact consent to share private content. Conversely, a DM location alone cannot prove that an explicitly requested shared-skill update is unauthorized. Fixing that path needs a scoped content-provenance/exact-sharing contract and safe private decision display; this patch does not impose a blanket private-DM refusal or change existing proposals.

## Verification

Local PGlite/fake-inference regressions cover the real private-save/memory/load gateway path, public promotion, mixed private/public subjects, missing/deleted/unknown sources, person/DM/task scopes, and source/note classification changes while inference is held. Existing public promotion, memory privacy, assignment/tenant denial and project-visible-count controls remain required. No real model, native app write, production database, background-reflection activation or new PostgreSQL server is used. Independent review, combined checks and deployed acceptance remain integration-owner gates; this is not complete PRD AT-13 acceptance.
