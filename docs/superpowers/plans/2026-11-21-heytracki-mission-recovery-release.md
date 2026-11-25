# HeyTracki Mission Recovery Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update the live Engineering app and recover existing HeyTracki missions through supported owner controls.
**Architecture:** Extend the existing plan card with a narrowly scoped repository editor. Reuse the normal mission API and ship an exact-image overlay, then repair existing bindings through Agent Desktop and resume their original tasks.
**Tech Stack:** TypeScript, React, React Query, Bun, Vite, Docker Compose, native Tauri WebView, Kynlo Agent Desktop.
**Spec:** /Users/jamesau0723/Agentes-Worktrees/heytracki-mission-recovery-20261121/docs/superpowers/specs/2026-11-21-heytracki-mission-recovery-release.md

## Global Constraints
- Preserve server authorization, folder limits and runner protections.
- No duplicate mission, direct database write or generated status-file edit.
- No new dependencies; build/test on M3 Max, with no added GitHub Actions.
- Keep current task IDs and owners #182 Max, #183 Nathan, #184 Noah, #185 Jacob.
- Preserve the three original dirty HeyTracki files and existing .agentes-only directories.
- Root is the sole GUI writer; code workers do not interact with the desktop.
- Release only the app service with graceful shutdown, unchanged data volumes and immutable rollback.
- A code commit, merge or deployment does not establish product completion.

## Review Focus
1. Server mission changes while a folder draft is open: stale edits must not target a different mission.
2. An owner clicks Start with unsaved/pending/invalid folder text: no start request is emitted.
3. Save is rejected or machine disconnects: draft remains, error is visible, status stays proposed.
4. A non-owner or another task views the card: repository editing and Start remain unavailable.
5. Reload/release and narrow dialog layout: existing conversation/ownership persists and controls stay reachable.

## Task 1: Complete supported repository recovery UI

**Files:**
- Modify: apps/web/src/components/missions/MissionCards.tsx
- Create: apps/web/src/components/missions/MissionRepositoryFolder.tsx if needed to keep the large card file focused
- Modify/Test: apps/web/test/task-mission-plan.test.tsx
- Modify only required existing locale entries and a narrow mission style rule if needed.
- Existing API: packages/client/src/api/client.ts; cache helper: packages/client/src/api/missions.ts.
- Existing validated server: packages/engine/src/missions.ts.

**Interfaces:**
- Consumes MissionPlanCard's fresh useMission(org.id, meta.missionId).data and its current machine.
- Consumes api.missions.setMachine(orgId, missionId, machineId, repoDir).
- Produces a saved Mission via cacheMission(queryClient, orgId, result), and a boolean Start-blocked state for dirty/invalid/pending edits.
- Start continues through useMissionControl with the existing exact missionId and action start.

- [x] Existing PR69 persistent review, owner Start, path validation and focus recovery are implemented at fd1c57c3.
- [ ] Add regression cases to task-mission-plan.test.tsx: owner saves repos/dev-james0723/heytracki-finish-20261121 to the exact existing mission and machine; returned path is shown; no create/control call is made by Save.
- [ ] Add tests that Start is disabled for dirty and deferred pending saves, a server error retains the draft and never starts, absolute/traversal input does not mutate binding, and non-owner/active/wrong-task cases remain inaccessible.
- [ ] Add a mission-change case proving a previously open draft cannot be applied to the next bound mission.
- [ ] Run the focused UI file and observe the expected missing-editor failures before implementation.
- [ ] Implement the owner/proposed/machine/idle-only labeled editor, 300-character maximum, relative-path hint and existing error handling; reset on mission identity changes.
- [ ] Wire existing API/cache and dirty/pending/invalid state to both Start variants in MissionPlanCard. Saving must not call control/start.
- [ ] Run the focused UI file and the existing mission-header/mission-ui suites; run the engine missions suite and both package TypeScript checks once on final code.
- [ ] Run Biome on touched files and git diff --check; inspect the final diff and commit the focused extension.

Expected: every named behavioral assertion passes, no unauthorized or duplicate mutation is possible, and the ordinary owner Start path is unchanged after a valid saved folder.

## Task 2: Build and validate an exact release candidate

**Files:**
- Read proven pattern: /Users/jamesau0723/Library/Application Support/Agents Chat Operations/releases/model-inspector-20261120/build-image-continuity.py
- Create task-specific release scripts/receipts under /Users/jamesau0723/Library/Application Support/Agents Chat Operations/releases/heytracki-mission-recovery-20261121/
- Build: apps/web/dist from this worktree.
- Runtime source overlay: packages/engine/src/missions.ts and every intended changed web/runtime source file from the reviewed commit range.
- Evidence: docs/evidence/heytracki-mission-recovery-20261121/ within this worktree.

**Interfaces:**
- Consumes the reviewed Task 1 commit and immutable existing image sha256:eca2db282d334ffa46c273558972b8c202f12b282c458733b2c7d5e14c443bb7.
- Produces immutable candidate image ID, source-digest receipt, web asset hashes and rollback identity for Task 3.

- [ ] Review Task 1 independently for spec compliance and quality; resolve material findings before release.
- [ ] Recheck current live image/source, clean intended branch and no concurrent deployment lock.
- [ ] Build web in apps/web with /opt/homebrew/bin/node node_modules/vite/bin/vite.js build.
- [ ] Copy only the intended changed runtime files and built dist; preserve pre-existing distributed runner assets not regenerated by Vite.
- [ ] Build a candidate overlay from the exact pinned image with --pull=false --network=none; do not run generic deploy/deploy.sh.
- [ ] In an isolated no-network container, run the project's existing runningSourceIdentity export and verify the expected source digest; verify built asset hashes.
- [ ] Exercise the recovered dialog plus repository editor through the established isolated browser/test harness at 1440x900,390x844,430x932; inspect captured layouts, overflow, names and keyboard focus. Include WebKit when the existing harness supports it.
- [ ] Record exact source/image/asset/test identity and the previous immutable rollback image.

Expected: candidate is reproducible from reviewed code, unrelated live patches/runner assets survive, representative interactions work, and no production state was used as disposable test data.

## Task 3: Activate and verify the existing Engineering app

**Files:**
- Read prior activation pattern: /Users/jamesau0723/Library/Application Support/Agents Chat Operations/releases/model-inspector-20261120/activate-app-continuity.py
- Runtime: /Users/jamesau0723/Documents/Codex/2026-11-12/https-github-com-dev-james0723-agentes/work/agentes-runtime/docker-compose.yml
- Deployment selection: same runtime .env, only AGENTES_IMAGE; never print its contents.
- Lock: same runtime .host-deployment.lock.

**Interfaces:**
- Consumes exact reviewed candidate and rollback receipt from Task 2.
- Produces live app image/digest/health and a reloadable unchanged native shell.

- [ ] Update PR69 with exact tested scope, mark ready and merge only with expected current head SHA into its verified release branch; do not force-push or replace unrelated branch work.
- [ ] Acquire the existing exclusive-create deployment lock and compare-and-swap the captured deployment selection. Abort/reconcile if it changed.
- [ ] Recheck no actual running/queued machine tasks or executing agent runs. Proposed missions and waiting_input records are retained, not treated as active execution.
- [ ] Activate only agentes with Docker context colima-agentes-chat-local, project agentes-chat-local, current compose/env files and up -d --no-deps agentes.
- [ ] Verify health/database, immutable image ID, source digest, served web assets and runner reconnection; inspect only release-relevant logs.
- [ ] Reload the existing native app via supported Agent Desktop once guarded input is available; inspect View plan on the existing task conversations.
- [ ] If health, source or critical UI fails, restore only the old image selection under the same lock and run the same app-only activation; then diagnose and fix the candidate.
- [ ] Verify unchanged 100 folder entries and all 36 grantees; record final deployed receipt and release the owned lock.

Expected: changed UI is served by the intended release, existing workspace/task data survives, no relevant new runtime errors, and other organization runners/config remain intact.

## Task 4: Recover real checkouts and resume original task owners

**Files:**
- Source: /Users/jamesau0723/Projects/iPadTrackpad-Agent-Actions-2026-11-20
- Max workspace: /Users/jamesau0723/Documents/Codex/2026-11-12/https-github-com-dev-james0723-agentes/work/agent-computer/max-engineering-manager-dfe8c279
- Nathan workspace: /Users/jamesau0723/Documents/Codex/2026-11-12/https-github-com-dev-james0723-agentes/work/agent-computer/nathan-design-systems-engineer-19389f39
- New relative checkout for each: repos/dev-james0723/heytracki-finish-20261121.

**Interfaces:**
- Consumes normal owner Repository folder and Start controls from Task 3.
- Produces existing mission bindings to verified Git checkouts and resumed existing #182–185 delivery work.

- [ ] Verify the exact source HEAD and dirty-file hashes, then create separate legitimate linked checkouts/branches from f3d7b42 using the installed worktree workflow; never overwrite existing .agentes-only folders.
- [ ] Read back each new checkout's Git root/HEAD/branch and actual agent workspace containment.
- [ ] Via Agent Desktop, open each existing proposed mission, review its scope and use Repository folder to save the new relative path on its same machine; read back exact identity/path.
- [ ] Start those same missions through the ordinary owner control. Verify actual status change and the first successful real code/build action, not only a click acknowledgement.
- [ ] Inform original owners of the current HeyTracki finishing plan/branch and exclusive edit or review responsibilities. Preserve existing task IDs and avoid duplicate code writers.
- [ ] Verify no repeat folder-request loop, missing-repository setup failure or lost task ownership.
- [ ] Continue the separate HeyTracki app plan through implementation, signed update, real UI/video and independent acceptance; record any genuine remaining blockers.

Expected: the existing team can execute on real repositories. This completes platform recovery only; HeyTracki app completion requires its separate release acceptance.

## Self-review and execution ruling
All R1–R12 requirements map to Tasks1–4. Shared interfaces are the fresh Mission/API/cache, candidate identity, live controls and real relative checkout. Review Focus1–4 are pinned by Task1 regression tests; Focus5 by Tasks2–3 live/layout checks. Task4 consumes only the ordinary UI and verified Git checkouts.
James's current explicit finish/update instruction extends the earlier no-deploy pilot boundary for this scoped work. The plan is a concrete execution record of that authorized outcome, not a new request for permission. Root coordinates and owns GUI; fresh implementers/reviewers own bounded code tasks. Existing tested work is reused; new behavior receives targeted failing-then-passing regressions.
