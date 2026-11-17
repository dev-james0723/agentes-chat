# Local CI GitHub App — account-owner setup (no paid CI)

GitHub Actions is **not** used for test execution. A GitHub App supplies an independently attributable `local-ci/full` commit status once the full suite, independent review and pinned candidate checks all pass. GitHub Free supports commit statuses; do not enable or purchase GitHub Actions minutes.

## One-time setup requiring the repo owner's GitHub interaction

1. Create a **private GitHub App** under GitHub Settings → Developer settings → GitHub Apps → New GitHub App. App name: `James Local CI` (or another unique name). Webhook: inactive unless a separately approved listener exists; this implementation uses polling, not inbound webhooks.
2. Permissions: Repository **Commit statuses: Read and write**, Metadata: Read. For ref readback, add **Contents: Read** only if GitHub requires it. Set installation access to **only** `dev-james0723/agentes-chat`; do not select All repositories. The app must never need administration, actions, secrets, content writes, pull-request writes, or account billing scopes.
3. Generate a private key from that app. Store it in a restricted host-owned signer identity, never in Git, `.env`, this document, agent conversations, backups shared with agents or the developer user's repo. Files must be mode 0600 and inaccessible to source-writing agents; otherwise the status cannot be considered an independent gate.
4. Record App ID and Installation ID in restricted owner-controlled local configuration. Install the app to the repository. No subscription or extra CI minutes are required.
5. Configure the trusted verifier public key **out of band** and validate a real signed full-suite receipt for the exact candidate SHA. `signReceipt` in `local-ci-status.mjs` is a signing primitive only; running it inside untrusted PR code does not establish approval.
6. Execute the explicit authorized App publisher with `publishAttestedStatus(envelope, {publicKey, now, repository, head, branch, config})`; it validates signature, timestamp, full suite, independent review, file hashes, installation token permission, and current remote head before posting a scoped `local-ci/full` success. Never use `gh auth token` as a replacement for the App token.
7. Verify GitHub's posted status issuer/expected App ID and that it was attached to the **exact head and expected target branch**. Verify the independent review context separately; the App CI result is not a replacement for review.
8. **Only after all above steps pass**, migrate protected `main` Required Checks from unreachable Actions contexts `CI result` + `Delivery Guardian tests` to the new `local-ci/full` check with pinned GitHub App source. Preserve strict head freshness, the independent review check, no force push/delete, admin enforcement and conversation resolution. Save complete before/after protection JSON privately, read back, test rejected bad/missing statuses, and keep rollback instructions.
9. Existing GitHub Actions workflows may be disabled by owner authorization after the external check has proven equivalent coverage; do **not** disable protection first or simulate a successful run to make merging possible.

## Blocking conditions
No installation/private key, mismatched App source, stale/wrong SHA, partial smoke suite, absent independent review, failed test, offline Mac, active writer, disk shortage or insufficient protected rollback evidence => **BLOCKED; do not merge/deploy.**

Official docs:
- https://docs.github.com/en/rest/commits/statuses
- https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation
- https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches
