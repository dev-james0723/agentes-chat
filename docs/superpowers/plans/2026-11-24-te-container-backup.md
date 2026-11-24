# Te container backup acceptance repair

## Spec

Complete the user's authorized Te release using full exact-head local CI, including a real isolated image boot and S3 backup/restore. The corrected precursor reached backup, then failed Docker DNS because its run-once container name and S3 endpoint disagreed. Its cleanup also left the project network until that container was removed.

## Global Constraints

- Work only in the existing feature worktree and branch; base is `5ff305e1f69fb1ee5dc9618b82fbfc2cb784cb9c`.
- No production mutations, GitHub Actions, new credentials, provider inference or changes to branch protection.
- Preserve the dedicated CI daemon, SHA-scoped project, loopback port, fixture credentials, real backup/restore and nonzero failures.
- Preserve unrelated code and live overlays. No broad Docker prune, process kills or lock removal.
- Stage only task-owned files and use `[skip ci]` in the commit subject. Root controls push and full CI.

### Task 1: Fix the isolated backup service address and cleanup order

Files: `scripts/delivery/container-boot.sh`, a focused shell-harness regression within `scripts/delivery/`, and this plan.

1. Make `S3_ENDPOINT` resolve the exact run-once S3 container created by the harness: `http://$project-s3:8080`, with correct shell expansion and quoting. Keep its explicit SHA-scoped name.
2. Remove the exact run-once S3 container before `compose down -v --remove-orphans`, so the owned project network can disappear. Preserve the original process exit status and failure diagnostics.
3. Add a meaningful bounded regression against the actual script with Docker/Compose/network operations stubbed, proving the configured endpoint matches the created container and removal precedes Compose teardown on success and backup failure. Do not merely mirror implementation text.
4. Demonstrate the regression fails before the patch and passes after. Run the focused delivery tests, ShellCheck and Bash syntax checks relevant to changed files.
5. Commit the scoped repair and plan. Write the report with exact base/head, files, tests, evidence and remaining real-image verification.

## Acceptance

- [ ] Task regression is red before and green after; scoped source review approved.
- [ ] Exact repaired head passes real isolated boot, S3 upload/fetch/restore and full 22-stage local CI.
- [ ] OpenRouter review updated for the repaired head; protected issuer, production, OAuth and native Te gates remain explicit.
