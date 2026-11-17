# Dual-Mac Local CI operation — no additional subscription

## Current implementation
- Reuses Delivery Guardian's `guardian.mjs` and SHA checks.
- `local-ci.mjs` is a bounded local smoke verifier, **not a background daemon**, release controller or GitHub check by itself.
- `local-ci-status.mjs` provides cryptographic release-attestation validation and optional scoped GitHub App publishing. A signed JSON by itself never establishes independent authority; trusted signer must be isolated from code writers.
- M3 Max: trusted primary for scoped local checks. Kingston: reserve second CI worker only after sufficient disk/tools availability. Current Kingston shared APFS free space was about 12 GiB, so do **not** run a heavyweight application suite there.
- Do not install an extra orchestrator, CI SaaS, Model Gateway fallback, scheduled worker, duplicate task, or daemon while the existing James Engineering OS/Guardian is authoritative.

## Smoke procedure
1. Use a clean isolated worktree from the **exact reviewed SHA**. Confirm branch, commit identity, GitHub remote and writer ownership. Never run in the dirty active workspace.
2. With Node 22+ available, after pushing the branch execute:
   `node scripts/delivery/local-ci.mjs --root /absolute/clean/worktree --sha FULL40CHAR_SHA --repository dev-james0723/agentes-chat --remote gh --destination /absolute/private/evidence-folder --mode smoke`
3. Inspect exit code and private `local-ci-*.json` / `*.log`; `tested_partial` means a smoke check passed, **not** full acceptance or deploy. Any missing status is unknown, not green.
4. `node --test scripts/delivery/*.test.mjs` exercises all Guardian and local CI policy tests. Keep logs by exact SHA and hash. No user credentials or production DB should enter candidate test process env.

## Full release CI — staged until prerequisites
- Existing repository `scripts/ci-local.sh` includes commands that may modify/clean generated `packages/db/migrations`. Execute it **only in a disposable worktree** and after verifying required runtime (Bun 1.4.4, Node 22+, shellcheck, gitleaks, pinned dependencies, memory/disk). Preserve other task worktrees.
- Run every required step (incl. lint, types, boundaries, licenses, migrations, full backend/web/mobile/desktop suites, Docker boot, secret scan, backup/restore) on the **same immutable candidate**. Record nonzero/timeouts; do not convert historical known failures into success.
- A deterministic single publisher, under separate owner-controlled trust, signs complete evidence; GitHub App with minimal statuses-write reports that exact SHA. A code-writing agent must not have signer private key, installation token or the ability to forge statuses.
- From PR/head to runtime: explicit independent approval and status checks, merge by exact head, build pinned image and runner, backup and rollback receipt, staged user-path test, actual live path. Keep existing current image if any gate is missing.
- Kingston provisioning: inspect tools and APFS free space. Until at least 30 GiB is available and Bun/Node/checkers match exact approved versions, do not start heavy CI, transfer secrets, reformat or delete its personal data.
- Restore the original GitHub protected-branch settings if the external check rollout fails; **never** temporarily remove all checks to merge.

## Status words for James
`written` ≠ `tested` ≠ `committed` ≠ `pushed` ≠ `merged` ≠ `deployed` ≠ `live_verified`. Founder-facing status in Hong Kong Traditional Chinese includes exact current stage, visible change, blocker owner and next safe action.

## Remaining manual setup
Owner must configure the free GitHub App credential and independent signer custody before an external success check can be accepted. Github billing lock may still restrict features; use official GitHub Support if its API refuses read/write, but do not purchase extra CI capacity solely to unblock testing.

## Complete-suite policy — fail closed

The `local-ci/full` bridge requires **all 22 separately named outcomes** corresponding to every stage in `scripts/ci-local.sh`, plus actual isolated Docker image boot. The earlier seven-step Guardian-oriented subset does NOT qualify. The mandatory set is `REQUIRED_RELEASE_STEPS` in `local-ci-status.mjs`. A successful signed mock in tests is **not a production verifier or status**. Current Local CI CLI runs *smoke only*; the complete-suite runner, independently isolated signer, GitHub App, required-check migration and production deployment are not installed or verified. The owner must not activate success publishing without those separate gates.
