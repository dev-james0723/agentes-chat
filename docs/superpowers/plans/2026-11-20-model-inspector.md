# Model Inspector Implementation Plan

> **For agentic workers:** Use the current plan task by task with independent source review. Checkboxes record verified progress.

**Goal:** Run continuous account-aware model inspection and preserve active and future work while switching to JEV-selected available models.

**Architecture:** A deterministic native worker refreshes and inspects quota. A shared bounded JEV selector chooses only qualified routes. Idle agents use atomic settings updates; active runs and missions use existing portable handoffs at completed boundaries.

**Tech Stack:** Bun, TypeScript, Hono, Drizzle/PostgreSQL, existing JEV Judge and native Claude/Codex/Grok adapters.

**Spec:** `docs/superpowers/specs/2026-11-20-model-inspector-engineering.md`; requirements in the adjacent PRD.

## Global Constraints

- Enable only explicitly configured organization IDs.
- 95% proactive threshold; 60-second poll; five-minute freshness; 15-minute cooldown; four idle migrations per rolling minute.
- Missing/stale readings are unknown, never zero or exhausted.
- Never reuse a foreign provider session; never replay uncertain tool effects.
- Preserve existing roles, access, audience, work directory and billing limits.
- One writer per source path; isolated worktree; preserve live Foundry overlay and reviewed Claude fixes.

## Review Focus

- Another person changes a brain/account while JEV is choosing: discard the stale decision.
- A mission's next run or a restarted server resolves its replacement route and native session.
- Grok is authenticated but supplies no usage percentage: retain explicit unknown state.
- Shared account pressure and timer overlap cannot cause duplicate or oscillating migrations.
- An unavailable inspector model or JEV does not stop polling or falsely claim a migration.

### Task 1: Bounded routing and active continuity

**Files:** Create `packages/engine/src/model-inspector-routing.ts` and its tests; modify `executor.ts`, `brains/select.ts` and the mission turn resolver as required.

**Interfaces:** Consumes existing Judge, BrainPlan and quota qualification. Produces `chooseModelInspectorRoute`, enabled policy hooks, and durable mission-compatible portable handoff.

- [x] Add failing tests for qualified-candidate-only JEV selection, invalid advice fallback, 95/unknown semantics and mission continuity with new sessions.
- [x] Implement typed selector and exact route revalidation, then safe boundary/missions integration.
- [x] Run relevant engine tests; verify same task/session ownership and no uncertain-effect replay.
- [x] Commit the coherent active-continuity change.

### Task 2: Fleet service, status and scheduling

**Files:** Create `packages/engine/src/model-inspector.ts`, status tool/route and tests; modify engine exports, typed configuration, `apps/server/src/engine.ts`, `start.ts`, `workers.ts` and the app route mount.

**Interfaces:** Consumes Task 1 selector; produces `createModelInspector({…}).sweep()` and `.report(orgId)` for worker/API/tool.

- [x] Add failing tests for all-agent coverage, per-org isolation, fresh account refresh, idle configuration CAS, cooldown and in-flight no-mutation.
- [x] Implement the service, periodic worker and status surfaces, preserving existing runtime settings.
- [x] Add 95% runner event crossing and test it.
- [x] Run affected tests, lint, TypeScript and boundaries; commit the service change.

### Task 3: Live installation and verification

**Files:** Runtime image recipe and private activation/verification receipts outside the public source; the spec/plan verification state.

- [ ] Build the candidate from the actual live image, include the scoped changes and retain existing web/Foundry behavior.
- [ ] Verify source identity and smoke in an isolated container without production data or external model calls.
- [ ] Recheck deployment ownership and current runs; deploy the tested image while retaining rollback image.
- [ ] Create exactly one visible Model Inspector agent, enable the requested organization and verify automatic worker operation.
- [ ] Refresh real usage; verify available-model and Grok execution separately; record exact completed versus unavailable claims.
- [ ] Record final independent review, relevant test evidence, live agent/worker state and remaining limitations.

## Verified implementation gates

- Final isolated suites: 290 passed, 4 environment-dependent skips, 0 failed, 1,520 assertions across 18 files. The supervisor suite runs in a separate Bun process to release the engine fixtures' memory before real-worker checks.
- Config, engine and server TypeScript checks passed with zero diagnostics.
- Changed TypeScript files passed Biome after safe formatting/import ordering. One existing host-ACP optional-chain warning remains outside the feature logic.
- Native runner candidate remains protocol 57, preserves the phone-disable chain, and was independently checked against the source model-forwarding changes.
- Core live deployment and real Grok-refusal-to-Codex continuation were verified. The final owner personal-route revision and its post-deploy proof are tracked in Task 4.


### Task 4: Close observed reconnect and personal-route gaps

**Authority:** MI-10 and the engineering specification's personal-route revision above. This continues the original full-team requirement after production inspection identified an effective personal binding omitted by the initial fleet path.

**Files and ownership:** `machine-hub.ts` and reconnect tests; DB `schema/agents.ts`, one appended migration and journal entry; `brain-settings.ts`, `right-hand.ts` and affected input schema/tests; `model-inspector.ts`, observations if needed and focused personal-route tests. Writers own disjoint paths.

- [x] Prove own Grok reconnect loss with failing regressions; preserve the current database usage during metadata replacement and reuse existing usage CAS. Verify empty/invalid/stale reads and a concurrent newer refusal.
- [x] Add the nullable personal account and explicit personal machine schema, preserving named rows; verify migration ordering, FK behavior and supported record shapes. Commit the coherent schema change.
- [x] Extend the existing personal API and effective resolver for validated own subscriptions while retaining reset semantics, account ownership and billing settings. Test ownership, reset and effective route resolution. Commit the API change.
- [x] Inspect the owner's effective personal binding, choose through JEV, and apply only personal settings after locked CAS and idle checks. Test another member's isolation, concurrent edits and ordinary-agent regressions. Commit the Inspector change.
- [ ] Run affected suites, DB/engine/server type checks and boundaries on the exact combined release, including existing Colab changes.
- [ ] Build the compatibility rollback image and final image; verify their source identities. Back up affected production state, recheck deployment ownership/idle state and activate through normal migration-on-boot.
- [ ] Verify the owner right-hand route with the ordinary worker and an actual bounded run as needed; recheck whole-team reporting, routine/authority invariants, migration identity and runtime health. Record completed versus unavailable provider claims.
