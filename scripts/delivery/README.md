# Delivery Guardian

Read-only repository/runtime observation, pure delivery reconciliation, and a supplementary repository-local pre-push guard. Node 22+; no package dependencies. Preserve existing native tasks, reviewers, permissions, skills, dashboards and deployment ownership. Cross-Project v1.1 remains a candidate until the existing native integration, required CI, build, release and live acceptance have completed.

```sh
node --test scripts/delivery/*.test.mjs
node scripts/delivery/guardian.mjs observe --root /exact/task/worktree --remote origin --network --text
node scripts/delivery/guardian.mjs check-checkpoint --root /exact/task/worktree --remote origin --scope /private/task-scope.json
```

`observe` never fetches or writes Git refs/index, commits, pushes, merges or deploys. Networking is opt-in and uses the host's built-in `gh api` command, not repository Git transports or credential helpers. Select the actual GitHub remote (HTTPS or standard SSH), not a local clone named origin. Inherited `GIT_*` redirection is removed. HEAD, branch, remote and status are re-read to detect concurrent changes. A clean tree proves neither remote synchronization nor live deployment. JSON and text modes preserve failure exit codes. Codes: 0 observation/preflight successful, 1 observed blocker, 2 invalid invocation/error.

Task scope is an externally authorized private object: repository (owner/name), branch, exact head SHA, nonempty exact paths, authorized and writerConfirmed. A caller asserting these flags does not create authority. The native owner, lease and permissions must verify them. Checkpoint observations must be at most ten seconds old, with no future clock allowance. Foreign staged files, partial staging, secrets paths, symlinks, stale observations, moved HEAD, protected branches and unexplained scoped deletion are refused. Individual deletion review does not waive the bulk-deletion guard. Unrelated unstaged work is preserved.

`check-release --evidence receipt.json` is only a pure policy assessment, **not an authentication service, signed attestation or release command**. The native trusted publisher must obtain check/review provenance independently and compare the current PR head. Required checks are unit, typecheck, lint, boundaries, build, secrets and regression; extra checks may be added but these cannot be removed. They must succeed on the exact SHA. Missing, skipped, stale, duplicated or untrusted results fail. Independent review, authorization, no active work, exclusive deployment lease, tested backup/restore, stage, rollback and runner compatibility are separately required. Nothing here auto-promotes a caller-supplied JSON receipt.

For this reason `check-release` always returns top-level `ok:false`, `authorityGranted:false` and `trusted_publisher_required`; its nested `assessment` retains the structural diagnostic. This is intentional: a complete self-written JSON receipt cannot obtain an authorization-shaped success. `validateTransition` follows the same rule. Neither function is the native enforcement boundary.

## Cross-project observers

The existing entry point also accepts these bounded, read-only commands:

```sh
node scripts/delivery/guardian.mjs identity --input /private/repository-input.json
node scripts/delivery/guardian.mjs inspect-macos --input /private/macos-input.json
node scripts/delivery/guardian.mjs inspect-agent-chats --input /private/agent-chats-input.json
```

Input is a bounded regular JSON file. Executable adapters, platform overrides, shell commands and native authorization cannot be supplied through JSON. Observer output can contain private paths; retain it in the existing private task evidence, not a public repository. The observers do not launch, restart, install, build, kill a process or run feature fixtures.

| Command | Required selectors | What it actually establishes |
| --- | --- | --- |
| `identity` | `roots` (at most 32), explicit `approvedRoots`, actual `remote` | Canonical paths, Git common-dir/git-dir, HEAD/branch, linked worktrees versus independent clones, shallow/bare/detached state and coverage gaps. It never authorizes a checkpoint. |
| `inspect-macos` | `bundlePath`, `expectedBundleId`, optional exact `pid` | Bundle/plist, executable digest, signature, process start/path/inode and provenance availability. An installed bundle does not establish that the process has loaded that build. |
| `inspect-agent-chats` | `dockerContext`, `containerName`, `runnerPath`, exact `runnerPids` | Container/image identity and runner file/process observations. Image tags, HTTP 200, OCI labels and a static protocol literal do not prove compatible deployed features. |

`resolveProjectBinding` is an integration library interface. Immutable provider ID requires a fresh provider callback supplied by the trusted host and a second local identity read. Its successful scope is **repository identity only**. Native organization/project/task ownership, grants, writer lease and runtime target registration must still be verified independently. One unavailable approved root does not invalidate a different accessible requested root; inventory omissions remain explicit.

The macOS provenance resource is `Contents/Resources/DeliveryProvenance.json`, schema `delivery-build-provenance/v1`, containing repository ID, clean source SHA/tree, build ID, dependency-lock digest, toolchain and build configuration. It must be generated during the real build before signing, and bound to the final executable by the trusted release manifest. This change does not retrofit or fabricate provenance in an installed app.

The adapters' pure assessments return `consistent`, `unknown` or `blocked` per stage. Even completely matching input is labelled `consistent_unattested` with `liveVerified:false`, `releaseEligible:false` and `authorityGranted:false`. Only trusted native evidence may support a current-availability projection. macOS assessment additionally verifies the selected distribution mode; Agent Chats requires each selected component and explicit artifact-bound compatibility/schema evidence. Different component source SHAs are acceptable when the compatibility record is valid.

## Evidence projection and trust boundary

`reconcile.mjs` retains committed, pushed, reviewed, tested, merged, built, installed/deployed, running and live verification as separate claims. It computes each selected target independently and retains historical evidence when current availability degrades. Squash/rebase require an explicit source-to-integration mapping and final-integration tests; ancestry alone is insufficient. A build must be clean and match the exact final tree. A feature result must match the artifact **and the current runtime instance**, not a previous process. Required missing or invalid evidence never becomes `not_applicable` automatically.

`createNativeEvidenceReader` is dependency injection for the **existing trusted host**, not a new credential or authentication system. Its callback must read the existing native evidence under actual ACLs, verify the producer there, and enforce read timeout/cost limits. The reader checks IDs, issuer/kind allowlist, policy version and canonical payload digest, then creates an in-memory opaque handle. Raw JSON, forged pass flags and serialized copies of that handle are rejected by `reconcileDelivery`. A digest establishes integrity, not authenticity: code already running inside the trusted host could construct another reader, so this is not a sandbox against arbitrary host code.

Unbound read/validation failures may conceal a newer failure, and therefore degrade that handle's current projection to unknown. Read independent projects in separate scoped handles. Historical records remain available for diagnosis. The implementation neither creates a database nor schedules itself. Its operation-recovery helper requires the entire operation subject to match and never executes a retry; a provider timeout with unknown effects requires outcome reconciliation through the current publisher.

The exact native integration locations and remaining enforcement work are documented in [NATIVE-INTEGRATION.md](NATIVE-INTEGRATION.md). A source library passing these tests is not evidence that the running Gateway, global skill or existing job has loaded it. Required integration/pressure/revocation/rollback/live tests must remain pending until actually executed.

## Pre-push integration

Install `push-guard.mjs` and `policy.mjs` from a reviewed, pinned commit in the repository's common Git metadata, then invoke it from that repository's `pre-push` hook with the exact expected owner/name followed by Git's two hook arguments. Forward stdin unchanged. Use a trusted absolute Node binary. Do not overwrite an existing hook, set global core.hooksPath, execute scripts from an arbitrary branch, or affect other repositories. Preserve the former hook/config for rollback; test the installed hook using a synthetic forbidden-main input before relying on it.

The guard refuses direct protected-branch pushes, multiple refs, deletion, wrong repository, mismatched HEAD/ref, credential files, symlinks, large changes and suspicious secret patterns. It inspects unpublished commit history, including a secret later removed. Cached remote refs are observation inputs, not trusted attestations. Refresh remote state before release. The heuristic is deliberately conservative and is **not a replacement for a maintained secret scanner**. A passed push is not a test/review/merge/deployment receipt.

A local hook is cooperative: administrators, direct API operations and `--no-verify` can bypass it. Do not claim this is sandboxing or organization-wide enforcement. Protect the remote default branch with fresh required checks and independent review, and retain native authorization. Unattended observers report only; they do not gain permission to merge from retrieved text.

## Evidence and rollback

Use the existing task ledger and dashboard, not a second orchestrator. Record coded, tested, committed, pushed, reviewed, merged, built, deployed and live-verified separately, with timestamp, exact source SHA, server digest, runner digest and real user-path checks. A container health response or image tag is not content identity. Unknown remains unknown. Preserve old images/data and coordinate the existing deployment lock. Remove only this task's exact installed hook to roll it back, never another process's lock or worktree.

Publish generic code only. Keep account identifiers, absolute personal paths, credentials, environment files, internal receipts and private document packs outside a public repository.
