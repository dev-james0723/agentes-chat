# Designer Team Native Upgrade — Engineering Specification
Revision: DT-2026-11-20-r1
PRD: ./PRD.md

## Verified baseline and selected architecture
Use a separate worktree at live base 6455f240d7ce817de173aaf73e13ad5dc6af42dd.
Extend the native skill runtime; no changes to the server image, database schema, UI or model gateway.
Keep private deployment snapshots and native IDs outside tracked source.
Package source: examples/skills/james-design-team/.
Deployment utility and tests: scripts/design-team/.
Skill name: james-design-team. Release: 1.0.0.

## Runtime interfaces
scripts/design_team.py:
- plan --input PATH or --request-json JSON -> JSON plan, exit 0; invalid input -> error JSON, exit 2.
- validate --input PATH --workspace PATH or --request-json JSON --workspace PATH -> JSON validation, exit 0 when verified, exit 1 when incomplete/invalid evidence, exit 2 for invalid input.
- catalog -> capabilities and provenance summary.
Input to plan: taskId, brand, surface, brief, languages, deliverables, stack (optional), requestedCapabilities/requestedSkills (optional), brandContexts (optional), overrides (optional).
Supported surfaces: web, native, social, motion, brand, data, presentation, print, email, conversation, spatial.
Plan fields: taskId, brand, surface, stack, languages, requiredDeliverables, coordinator, owner, collaborators, reviewer, selectedCapabilities, selectedSkills, references, brandContext, warnings, evidenceRequirements.
Explicit requestedSkills remain discoverable even outside default role selections; this planner does not grant or revoke access.
Brand aliases normalize identity only, never dictate stack/platform or invented colors/fonts.
Current overrides are layered over the selected brand's context only.

Validation input: plan plus delivery manifest.
Manifest: status, contentVersion, artifacts (deliverable/path/contentVersion), review (reviewerId/result/platform/evidence), publication (only for scheduled/published/unverified).
Required artifacts must exist under the supplied task workspace; image/video expectations cannot be satisfied by prompt/text files. Validate signatures where supported and report their limits.
All required exports use the requested version; independent review references inspected artifacts and the actual target platform.
Published requires account/channel/postId/permalink, matching contentVersion and positive readback evidence. Missing/ambiguous publication returns unverified, with read-back-before-retry guidance.
The validator checks supplied evidence and local files; it does not claim independent aesthetic judgment or authenticate a remote platform by itself.

## Files
- examples/skills/james-design-team/SKILL.md: lean native invocation and role workflow.
- scripts/design_team.py: CLI orchestration.
- scripts/team_core.py: pure routing/context/evidence logic.
- references/capabilities.json: canonical capabilities, existing skill mappings, pinned sources.
- references/roles.json: named roles and task ownership rules; no private native IDs.
- references/workflows/*.md: scoped product/social/native/brand/typography/motion/review/delivery/memory methods.
- references/release.json and references/provenance.json: immutable sources and release metadata.
- scripts/design-team/test_design_team.py: behavior tests.
- scripts/design-team/deploy.py: ZIP generation, dry-run/apply, native import/assignment/instruction reconciliation.
- scripts/design-team/test_deploy.py: block idempotency, concurrency and preservation tests.

## Native deployment
Read the existing signed-in localhost session only in memory; never log credentials or accept a remote auth origin.
GET current agents and skills; require the expected target names; snapshot relevant settings privately.
POST /skills/import with zipBase64 and createOnly=true for a new name. Follow the actual resource-update contract for upgrades.
PUT /agents/{id}/skills updates only the supplied assignments; add the new skill for ten designers.
PATCH /agents/{id} sends instructions only, with one managed design-team section.
Read immediately before each write; compare prior hash. If unrelated changes occurred, re-merge into the latest instructions rather than applying an old full snapshot.
No brain/model/access endpoints are written.
Targeted existing skill edits preserve IDs and unrelated content, snapshot before each change, and recheck current version/hash.
Read back every changed resource and assignment. Repeating an unchanged deployment must produce no duplicates or new skill versions.

## Requirement traceability
DT01/02/03/04/05/09 -> planner/catalog/context -> routing and isolation tests, native run receipt.
DT06 -> validator -> missing assets, mismatch, native evidence, publishing-state tests.
DT07/08 -> deploy utility and managed text -> idempotency/concurrent-update tests and live settings diff.
DT10 -> fresh native task(s) -> actual script execution, generated editable fixture and exports, independent review.

## Verification and release
Run the complete Python extension suite, Python syntax checks, package integrity/reference validation and applicable repository static boundaries.
Because core app/UI source is unchanged, do not redeploy or broaden testing to unrelated frontend screens.
Use fresh native tasks for the updated instructions and skill version; existing transcripts are not claimed to be hot-reloaded.
Produce a clearly marked bilingual TEST fixture and real exports; inspect the rendered result and relevant layout/font behavior.
Do not publish a real social post merely to test this upgrade.
Record git revision, native skill ID/version, preserved settings, execution receipts and unverified external connectors separately.

## Recovery
Keep immutable pre-change snapshots outside Git, plus expected current hashes.
Rollback only this release's managed sections and changed skills after checking for subsequent edits; never replace an entire organization snapshot.
A failed tool/account leaves the relevant capability unverified, and the rest of the upgrade continues where independent.
