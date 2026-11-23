# AC Agent Skill Exchange Implementation Plan

For agentic workers: REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans.

Goal: Enable a verified agent-origin Skill to flow securely from creator A to explicitly selected same-owner peers C/D/E, Wiki and Memory, with native-use receipts.
Architecture: Reuse AC original promotion Skill, skill.created origin run receipt, Context Items and publicPromotionNotes, existing agentSkills, wiki create, tell_agent native consultation and Tool Gateway. No new table or parallel queue.
Tech stack: Bun / TypeScript / Drizzle / PGlite / AC native ToolSource.
Spec: docs/adr/0209-agent-skill-exchange.md

Global constraints: one integration writer; separate isolated worktree; owner authorization for release; no automatic executable grants or private data; no fabricated test or production proof.
Review focus: forged provenance, source reclassification, denied audiences, disabled recipient, duplicate sends and stale Skill version.

Task 1 — RED tests
Files: packages/engine/test/agent-skill-exchange.test.ts.
[ ] Seed public How-to, run real native promotion with fake summary inference, then request sharing to three named peers.
[ ] Verify negative private and wrong-owner and duplicate cases; ensure RED before code.

Task 2 — Server-only safe sharing
Files: packages/engine/src/context/skill-exchange.ts; packages/engine/src/context/learned-skills.ts.
Produces shareLearnedSkill(deps, ctx, input) and a receipt of version/grant/notice/wiki statuses.
[ ] Validate exact owner, org, source notes, skill.created evidence, public channel status and script absence.
[x] Check callableAgents, canTalkTo, explicit skills:read and separate manager opt-in, cap three recipients and preserve disabled rows.
[ ] Insert only permitted new agentSkills grants, record actual audit, leave other recipients unchanged.

Task 3 — Tool, Wiki, communication
Files: packages/engine/src/skill-tools.ts and new integration test.
[ ] Register share_learned_skill behind the existing skills:read ToolSource and an explicit recipients list.
[ ] Use native createWikiPage with agent actor; keep original archived note provenance.
[ ] Use existing sendNote/consultation for bounded peer notices; report partial delivery if a downstream effect fails.
[ ] Verify C/D/E real native load_skill and exact Skill body/version; negative and replay tests.

Task 4 — Independent owner-controlled sharing opt-in
Files: packages/db/src/schema/agents.ts, migration 0283, packages/engine/src/context/learning-auto-approval.ts, apps/server/src/routes/app/knowledge.ts, packages/client/src/api/types.ts, apps/web/src/components/Skills.tsx, i18n 14 locales.
[ ] Add default-off, audited autoShareLearnedSkills manager setting separate from autoApproveLearning. Test unauthorized actor, default-off and existing-workspace behavior.
[ ] Expose clear Settings → Skills manager switch and review its actual locale fields.
[ ] Read policy under DB lock in every Skill grant; never use old auto-approve setting as permission for peer sharing.

Task 5 — Verification and integration
[ ] Check code with TypeScript/Biome, targeted engine tests, local CI and independent review at exact SHA.
[ ] Push isolated branch into a stacked Draft PR, preserving owner-controlled PR #78 and its release review.
[ ] Production Golden Journey only after Summary Model is authorized, new image compatible, approvals/migrations applied.
[ ] Mark DONE only after real production A/C/D/E run IDs, Wiki, Memory and audits can be inspected.
