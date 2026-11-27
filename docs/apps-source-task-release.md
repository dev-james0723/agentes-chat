# Canonical source-task release handoff

This release preparation preserves the source-task implementation at `b87c7aed6fc6138e6e1e280252a1cc2c2c36c782`, based on the existing skill and app evidence candidate `700205967c8e45618f11ec2fb05417dbbd223a38`. The implementation contract is in [apps-source-task.md](apps-source-task.md). A documentation-only qualification commit does not change those runtime or test files.

## Exact-source qualification

Run the existing `scripts/delivery/local-ci-full.mjs` on the exact qualification commit in a fresh disposable checkout. The runner must verify the same remote non-default branch before and after all 22 required stages. Use the existing `scripts/ci-lock.sh` host lock, at least 30 GiB of free disk, the repository toolchain, an environment without production credentials, and only the dedicated `colima-agentes-ci` Docker daemon. A stopped CI daemon may be started through its existing profile; neither production Docker nor the paused Social Intelligence service is a CI target.

Store the original logs, each log digest, unsigned receipt, tool/resource preflight, process identity, candidate image identity and handoff under a separate exact-head artifact directory. Preserve the original `700205967` receipt, source review, image and activation helper. Historical success is not a current-head result. A partial or failed run remains partial or failed; no status is published by this preparation.

The ordinary branch push must not start GitHub Actions. This qualification commit carries `[skip ci]` for a later protected PR update; do not remove that marker or dispatch Actions. Keep the existing PR unchanged until the new source, qualification and release helper have been independently reviewed.

## Protected release and activation

The current protected release requires `release/independent-review` from GitHub App **5880010**, followed by the normal protected merge. Independent source QA and `local-ci/full` evidence do not replace that App result. Preserve the App binding and admin enforcement; do not forge or substitute a check, relax protection, or use an administrative merge.

Prepare a separately reviewed activation helper pinned to the exact qualification commit and image. Its default operation remains read-only. Before any future activation it must require the complete matching CI receipt and original log hashes, the genuine App result, the protected merged head/tree, an unchanged base runtime, a fresh verified backup, an exclusive deployment lock, and the existing rollback safeguards. Preparing or staging an image on the isolated CI daemon is not deployment.

After an authorized deployment, reread the owner's real MCP manifest and confirm `ensure_source_task`, `read_source_task`, package installation, assignment, conditional skill updates and evidence reads. Only then can a real authenticated Share continue through its canonical source task, actual consumer use and an independent reviewer. Local tests and a successful server receipt alone do not establish phone-to-agent acceptance.

## Current boundaries

At this handoff's creation the canonical tools are not deployed. PR 93 still names the earlier `700205967` head and remains blocked by the App-bound review and protected merge. The owner-paused Social Intelligence service must remain paused unless the owner authorizes resumption. No Share event, execution grant, credential entry, native adoption task or production activation is created by release preparation.
