# HeyTracki mission recovery and Engineering app release
Scope revision: 2026-11-21 finish request.
Authority: James explicitly requested "Do all and finish all blockers 跟住 update 埋個 app，要做到最尾" after reviewing PR69 and the remaining blockers. This authorizes implementation, local verification, commit/push/merge, local app update and existing-task recovery. Routine choices proceed without another permission question.

## Verified starting state
- Exact isolated branch fix/heytracki-mission-recovery-20261121 at fd1c57c39e7fce01dd5151db8b7b38ba92ad5191.
- PR69 base release/model-inspector-colab-20261120 at 4122e298a6572f271f7af93439c689d11259a14b.
- Existing PR implements persistent task View plan and validates absolute/traversal paths before cleanup. Its 59 tests and two TypeScript checks passed before this extension.
- Live Docker context colima-agentes-chat-local, service agentes-chat-local-agentes-1, image sha256:eca2db282d334ffa46c273558972b8c202f12b282c458733b2c7d5e14c443bb7.
- Live source digest sha256:d082298a5c8a2380a319d99fc711c8a138bff6392d010f5e61f32b8816bbee35. The live missions.ts matches PR parent.
- Max #182 and Nathan #183 have existing proposed missions. Their current repository targets contain only generated .agentes metadata, not Git checkouts.
- Noah #184 and Jacob #185 retain their original ownership and delivery requirements.
- 100 folder roots each grant the same 36 current Engineering agents; no additional permission expansion is required for the covered HeyTracki source.
- Actual HeyTracki baseline is /Users/jamesau0723/Projects/iPadTrackpad-Agent-Actions-2026-11-20 at f3d7b42fd3124837bbe188b8c7455b22e183645f with three unrelated dirty entries to preserve.

## Requirements
R1. Keep the existing persistent View plan task control, exact mission/thread/channel matching, and unchanged owner Start authorization.
R2. Add Repository folder editing to the proposed mission plan card only for the actual owner, with an assigned machine and no running mission tasks. The field is relative to that agent's workspace and limited to 300 characters.
R3. Save through api.missions.setMachine(orgId, missionId, machineId, repoDir); refresh the existing mission cache. Do not create a duplicate mission, edit the database or edit generated status files.
R4. Invalid, unsaved or pending folder changes prevent Start. Saving never starts a mission. A server refusal preserves the draft and exposes the normal error. A changed mission binding discards stale editor state.
R5. Preserve server authorization, folder limits and runner protections. Use existing Field/Input/Button and locale conventions. No new dependencies.
R6. Produce real isolated Git checkouts before rebinding and starting existing missions. Keep .agentes-only directories intact. Preserve the original HeyTracki worktree's two modified UI tests and untracked performance evidence.
R7. Build and test locally on M3 Max. Do not add or depend on GitHub Actions. Review the final changed source, not only an earlier commit.
R8. Build an exact-image overlay containing only intended runtime source plus rebuilt web assets; preserve distributed runner assets and all unrelated live customizations. No schema migration or runner/native binary update is needed for this scope.
R9. Release only the combined app service under the existing exclusive deployment lock. Recheck zero executing/queued machine work, preserve waiting-input records, use normal graceful shutdown, retain an immutable rollback image, and change only AGENTES_IMAGE in deployment selection without exposing other environment values.
R10. Verify the updated production native interface, exact mission identity, valid repository save, ordinary Start, first successful real checkout/build action, runner reconnection and absence of new release-related errors.
R11. Verify dialog/layout and keyboard behavior at representative desktop and mobile widths in an isolated test harness and the live native surface. Record physical versus emulated evidence accurately.
R12. Keep original task IDs/owners. Resume substantive design/onboarding/acceptance work against the separate HeyTracki finishing plan; do not mark the app redesign or video complete merely because the platform release works.

## Acceptance
- New editor regression tests, related mission suites, engine/web TypeScript, formatting, web build and scoped review pass on the final branch.
- Candidate image sources and web assets match the final reviewed source; health source digest and actual served assets match after deployment.
- The real owner can reach and repair both existing proposed missions through the ordinary UI and start them after valid checkouts exist.
- All 100 existing folder entries retain their 36-agent sets.
- Existing native app window reloads the server-backed UI; no unnecessary runner or native binary replacement.
- Genuine remaining HeyTracki product work is tracked under its separate implementation plan.
