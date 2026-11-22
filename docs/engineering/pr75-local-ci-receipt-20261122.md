# PR #75 — Local CI Verification Receipt (2026-11-22)

**Project:** dev-james0723/agentes-chat, feature branch `fix/routine-plan-fallback-main-20261122`.  
**Method:** M3 Max local Bun/TypeScript tests and headless browser checks. GitHub Actions were **not** used as test execution. This report distinguishes tests on the earlier feature head from retests on the updated head.

## Verified feature and safety checks

- Real AC Engine and isolated database with synthetic quota failures: **4 passed, 0 failed** for Codex to owner-authorized Claude subscription, same-run completion, usage ranking, denied keys, revoked permissions and context secrecy.
- Existing quota-policy regressions on initial feature commit: **17 passed, 0 failed**.
- Existing background/usage regressions on initial feature commit: **103 passed, 1 pre-existing skip, 0 failed**.
- Latest desktop look test file: **24 passed, 0 failed**. Uses native Bun PTY to verify prompt history persistence; look version was bumped to 8.
- Linux Chromium installer test file: **29 passed, 1 skip, 0 failed**. The fake Linux environment no longer sees macOS Chrome from the host.
- Spanish Intl fallback targeted: **3 passed, 0 failed**. Co-author test rerun: **10 passed, 1 skip, 0 failed**.
- Latest full workspace `bun run typecheck`: exit 0. Geometry unit tests: **14 passed, 0 failed**. Changed files formatted, `git diff --check` clean, Gitleaks on feature commits found no leaks.
- Geometry startup timeout tested with a simulated stalled Chrome process: rejected at 30 seconds, fake child no longer alive. Mac geometry now defaults to one isolated Playwright headless browser and guards CDP requests and child cleanup.

## Full local CI and visual caveats

- The original all-repo local CI was run on feature SHA `c0dee254b` and **was not a full PASS**. It reached the final boundary check; backend shard 2 had one Spanish ordinal failure and backend shard 3 seven failures (installer simulation, process timing, terminal history). Those cases were addressed/retested separately; a fresh complete all-shard run on the newest head has not been claimed.
- Original Web/UI capture: 4,643 passed, 6 skipped, 0 failed. Phone/desktop tests: 1,842 passed, 0 failed.
- Historical Geometry snapshot: 3,401 captures, 837 measured structures, one new `squarecol` alert in Lodi's settings row. This used another workflow's pre-existing capture, so it is **not** fresh-version proof. A fresh capture of 24 related states from the current code was measured at 17 structures and **zero new alerts**. Do not silently modify the visual baseline to disguise a failing historical finding.
- The original `ci:local` Geometry invocation became stuck using macOS system Chrome; it was stopped only after verifying the precise test subprocess. The repaired headless browser route now exits normally on the historical set, and test startup has a bounded timer.

## Release gates (unverified)

- GitHub branch protection requires `release/independent-review`; there is **no successful signed independent-review result** for this head. This is distinct from GitHub Actions, which cannot start because the account reports a billing lock.
- Independent Codex and Claude reviews were blocked by subscription limits, Gemini personal OAuth by unsupported client, Grok by an unresponsive reviewer process that was stopped with its own child processes. None may be claimed as an independent approval.
- PR #75 is ready for review, but **not merged, deployed or live-provider smoke-tested**. Do not claim that the local tests establish a production auto-plan transition. Production rollout requires the protected review gate, verification of the exact release checkout, backup/rollback and supervised, authorized routine smoke test.

## On-Mac evidence files

- Original complete CI: `/var/folders/7n/6llqzp0j1sl7xlylccldtbb80000gn/T/agentes-ci-local.6R94Pq`; SHA-256 `ad48a925c9891f657d4cb325bee20a14bddc6f031752e92d15f2536c4f2ae288`
- Latest Routine targeted: `/tmp/ac-routine-current-regression.log`; SHA-256 `420a8e1b9c6fe1c797cf41f72961b6982d974200ef93bb8143034ffa8e3c7116`
- Desktop look complete: `/tmp/ac-current-desktop-look.log`; SHA-256 `b0b5464e9fa7a368172d7231cea4a1462ea7bff4e95e36738bf6fb9dff6a3ad4`
- Geometry unit: `/tmp/ac-geom-unit-post.log`; SHA-256 `40362e8e4eb73522ec50f7161c2442aadc0997e6b44f68b8dd1bc27c3945be16`
- Geometry historic capture: `/tmp/ac-routine-geometry-full.log`; SHA-256 `b5803669e3fcfc051e0361e40ff1c45da9f2d076b331f67cca974fb38fb77520`
- Current UI capture geometry: `/tmp/ac-settings-geometry.log`; SHA-256 `6cad54f669f971bd6d5f06307b11ade8948be81f171d466eb7c0c3facfa7ad01`
- Full TypeScript: `/tmp/ac-headless-final-typecheck.log`; SHA-256 `2a8373402e7f83c449e516146b5962c68f3c8576a00ab76fc984a5dc2034ed6b`
- Feature commit secret scan: `/tmp/ac-pr75-new-leaks.log`; SHA-256 `88417c1c1c24d141cec211511d3c44c64a15e37937ac5f95848ba781f1c68cfb`
- Startup watchdog cleanup: `/tmp/ac-fake-chrome-test.log`; SHA-256 `75bb5ab6e1e5fbc58b02af91ae0f05c8c35600bb188f0eda7fd83be19b28f1c3`
