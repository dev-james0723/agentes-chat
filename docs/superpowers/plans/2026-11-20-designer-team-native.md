# Designer Team Native Upgrade Implementation Plan
> For agentic workers: use superpowers:executing-plans to implement this plan task by task. Current user explicitly authorized immediate Kynlo implementation and Finish.

**Goal:** Deploy a code-backed native design capability layer to the existing ten designers and prove its real execution.
**Architecture:** Package a deterministic planner, context selector, artifact validator and scoped references as one versioned native skill. Reconcile role instructions and narrow legacy skill corrections through existing authenticated native APIs.
**Tech Stack:** Python 3 standard library, JSON/Markdown, existing Agentes native skill runtime.
**Spec:** docs/specs/2026-11-20-designer-team-native/ENGINEERING-SPEC.md

## Global Constraints
- Preserve ten identities, models, permissions, current enabled skills and unrelated concurrent edits.
- No server image rebuild, schema migration or unrelated UI change.
- Current user requests take precedence over stored taste and upstream defaults.
- Real required images/videos and publication states need matching evidence; no prompt-only completion.
- No new telemetry, paid report service, mandatory repeated human confirmation or parallel coordinator.
- Private session credentials and deployment snapshots stay outside Git.

## Review Focus
1. Same brand with different surface/stack selects different valid methods (Task 1).
2. Unknown/custom brands and explicit skills remain usable without context leakage (Task 1).
3. Missing or wrong-format artifacts and self-review cannot pass completion (Task 2).
4. Uncertain publication cannot become published or trigger a duplicate retry (Task 2).
5. Concurrent instruction changes and repeat deployment preserve unrelated settings (Task 4).

### Task 1: Capability planning and scoped context
Files: examples/skills/james-design-team/scripts/team_core.py; scripts/design_team.py; references/capabilities.json; references/roles.json; scripts/design-team/test_design_team.py.
Interfaces: plan_task(request: dict, catalog: dict, roles: dict) -> dict. select_brand_context(request: dict) -> dict.
- [x] Write behavior tests for platform routing, task ownership, bilingual/multi-format preservation, explicit skills and context isolation.
- [x] Run tests and observe missing implementation failure.
- [x] Implement planner and CLI; use structured input instead of unreliable automatic classification.
- [x] Run extension suite and compare expected outputs.
- [x] Commit planner and catalog.

### Task 2: Evidence-backed delivery validation
Files: team_core.py; design_team.py; test_design_team.py.
Interfaces: validate_delivery(plan: dict, manifest: dict, workspace: Path) -> dict; publication_key(fields: dict) -> str.
- [x] Add failing tests for missing visual, version mismatch, outside-workspace path, self-review, native/web mismatch, scheduled/published/unverified states.
- [x] Implement local artifact checks, independent review requirements and publication receipt validation.
- [x] Verify positive and negative fixtures and exact CLI exit codes.
- [x] Commit validator.

### Task 3: Scoped skill guidance and provenance
Files: SKILL.md; references/workflows/*.md; references/provenance.json; references/release.json; applicable LICENSE/NOTICE files.
Interfaces: planner reference paths must exist in the imported package; native load/read/run names must match current runtime.
- [x] Write concise product, social, native, typography, brand, motion, review, delivery and memory guidance using researched methods.
- [x] Preserve actual upstream source revisions and paths; distinguish adapted guidance from installed upstream engines.
- [x] Verify file references and bundle integrity; keep scripts executable through native import.
- [x] Commit native skill payload.

### Task 4: Native deployment and legacy compatibility
Files: scripts/design-team/deploy.py; test_deploy.py.
Interfaces: merge_managed_block(text: str, block: str) -> str; reconcile(snapshot, fresh, desired) preserves unrelated fields; native payload uses instructions-only PATCH and additive skills PUT.
- [x] Write failing idempotency/concurrency/preservation tests.
- [x] Implement dry-run/apply, private snapshots, actual import/update contracts and readback receipts.
- [x] Replace legacy design-review telemetry/report body with local adapter; fix director precedence/references, visual QA references and narrowly identified native/motion/brand conflicts.
- [x] Run complete extension tests and read the resulting diff.
- [x] Apply via Kynlo and verify all ten assignments, managed blocks and unchanged model/access state.
- [x] Commit deployment tooling and non-private verification documentation.

### Task 5: Production-native canary and real artifacts
- [x] Start isolated fresh native verification tasks using inspected endpoints, not existing conversations.
- [x] Observe actual load_skill/run_skill_script receipts and selected plan.
- [x] Produce editable bilingual TEST content and real required exports in a dedicated task workspace.
- [x] Have independent review inspect actual artifacts and record tested scope.
- [x] Correct any concrete implementation defect and re-run affected tests and native path.

### Task 6: Review and finish
- [x] Fresh independent whole-branch review using the plan/spec and actual diff; resolve material findings.
- [x] Run final complete extension suite and relevant repository static checks.
- [x] Commit coherent changes; push the feature branch to the verified user repository.
- [ ] Complete source merge after hosted CI can execute. PR 67 is open; native package installation is already the verified production release. Hosted jobs did not start due to an account-level execution restriction.
- [x] Save final production receipt, exact completion/unverified states, and brief user-facing result.

## Execution rulings
- James has explicitly approved immediate implementation of the reviewed blueprint; continue without another plan-approval question.
- Use the Agentes-native skill package and its existing import/runtime, not the separate ChatGPT personal-skill installation workflow.
- Reuse completed research; preserve the unrelated concurrent Colab worktree and current Foundry runtime.

## Final release state
Native package 1.0.1 / revision 2 is installed and verified. All 52 extension tests pass. Oliver, Noah and Lily completed the isolated canary; independent review and native delivery validation passed for the actual bilingual exports. See ../../specs/2026-11-20-designer-team-native/VERIFICATION.md for evidence scope. Source is pushed and PR 67 is open; hosted CI and source merge remain blocked externally. No additional implementation approval is required for the installed native package.
