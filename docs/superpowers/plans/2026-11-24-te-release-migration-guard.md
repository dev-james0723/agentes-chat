# Te Release Migration Guard Plan

**Goal:** A failed migration generator must fail local CI before checking or cleaning migration drift.

**Context:** Independent review reproduced premature shell expansion of the generator exit status in the actual local CI command. Prior successful generator execution remains valid; release requires the corrected guard and fresh validation.

## Global constraints

- Preserve all existing CI stages, ordering, migration drift behavior and production code.
- Do not use GitHub Actions or bypass branch protection.
- Tests evaluate the actual migration step extracted from scripts/ci-local.sh, with shell functions replacing bun and git. No real migration cleanup or repository mutation occurs in tests.
- One implementation writer; independent review follows implementation.

### Task 1: Preserve migration failure status

Files: scripts/ci-local.sh, scripts/delivery/local-ci-full.test.mjs.
- [x] Escape the deferred `$?` in the double-quoted migration step so the inner generator status is propagated.
- [x] Add regression coverage extracting the actual two-line step. Use `spawnSync` and Bash functions to simulate generator exit 23; assert status 23 and no git calls.
- [x] Cover successful generation with no drift (exit 0) and fake drift (exit 1, expected status/checkout/clean calls). Stub every git call.
- [x] Demonstrate the generator-failure test fails before the fix and all cases pass after it.
- [x] Run Node delivery tests, shellcheck and Biome on changed files. Do not launch full CI; the integration owner runs the exact final revision once review is settled.
- [x] Commit only this plan and the two scoped source/test files. Do not push, merge or deploy.

### Release follow-through

The integration owner obtains OpenRouter independent review of the final candidate, runs exact-head local CI and isolated Docker boot, and proceeds only through legitimate review publishing and protected merge. Existing live overlays must be preserved or integrated with their own evidence. Management OAuth, Te creation and actual free-model inference remain separate acceptance gates.
