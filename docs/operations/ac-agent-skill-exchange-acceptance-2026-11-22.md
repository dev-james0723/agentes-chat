# AC Agent Skill Exchange — evidence-backed acceptance

Date: 2026-11-22, United States Eastern time.
Base revision: 1eb3a2b9bb3ae47eb88f7ad571f12c89e9636c9f (PR #78).
State: ISOLATED FEATURE BRANCH, NOT PRODUCTION VERIFIED.

## Target
Agent A uses the same public validated method in multiple sessions or corrects an error, and native AC promotes it to one non-executable, first-version Skill. The trusted summary nominates specialist peers C/D/E, then native authorization independently checks same owner and organization, public provenance, valid source, explicit Skills-read access, original creator grant and enabled manager policy. Matching recipients receive native Skill assignments and messages, a Wiki page and org Memory reference the provenance, and fresh C/D/E runs actually load the exact Skill. Failures and retries leave auditable receipts, not a false success.

## Verification
- Seven distinct local targeted suites at the previously checked worktree: 118 tests passed, zero failed. Evidence root: ~/Documents/Agentes-Handoffs/ac-agent-skill-exchange-20261122/final-targeted-checks.receipt and individual final-*.log.
- A learned error is only promoted after a corrected method succeeds across subsequent distinct runs; negative test passed.
- The source simulation includes actual PGlite and native Tool Gateway transactions with fake structured summary inference, not a real production model. Final safety patch after broader regression: 12/12 native Golden Journey tests PASS, 74 assertions, 0 failed, with Engine TypeScript and Biome checks both exit 0. Exact evidence: scope-guard-final.receipt plus SHA256 of scope-guard-full-tests.log. Successful A to C/D/E load, Wiki, Memory, consultation and idempotent retry observed in Golden Journey tests.
- Native Skills-read missing-scope bug reproduced in missing-scope-red.log and fixed as missing-scope-green.log. It now refuses to assign to a peer without explicit Skills-read authorization, never granting scopes implicitly. The refreshed complete Golden Journey suite is scope-guard-full-tests.log.
- Six TypeScript projects previously exit 0 in typechecks-stage2.receipt. Relevant UI Skills tests: 22/22 pass. i18n locale tests: 22/22 pass. Migration and boundary validations pass. This change requires new final-SHA verification after the last fix.

## Production blocks (read-only)
The live AC Postgres currently contained 111 registered, 98 active agents; only 58 of the active agents had explicit built-in skills:read scope, including just 3/38 active in James Engineering OS. Zero agent-origin Skills observed. New migration 0283 has not been applied, and prior auto-learning migration 0282 also remained absent at last check. Summary-model records last observed November 16 and no active usable custom credential verified.
Native issue #165 owns Summary Model recovery and is assigned to Theodore. Issue #138 is an existing Engineering OS integration task. Do not create parallel queues.

## Release requirements
Independent review of exact commit, same-SHA full local CI, protected PR integration without overwriting PR #78, migration with manager-only OFF-by-default switch, authorized structured-output Summary Model, manager-controlled native Skills-read access roll-out to eligible active agents, and real AC runtime A-to-CDE and negative-case receipts (creator and receiver run IDs, Skill version, source memory IDs, Wiki ID, audit IDs, fresh load events). Do not describe an installed plugin, synthetic test, PR or green CI as Production Verified.


## Stronger native receiver-run proof (2026-11-22, isolated)
Additional end-to-end PGlite test directly verifies that native sendNote creates three recipient-native consultation runs, that each persisted run's agentId, channelId and trigger message match the consultation, and that each run can execute load_skill through the native Tool Gateway with exact version 1. The same test reads back Wiki, public memory, Skill use-count 3 and three audit IDs. It prints a machine-readable, per-run receipt rather than just asserting detached synthetic work sessions.

Evidence: ~/Documents/Agentes-Handoffs/ac-agent-skill-exchange-20261122/native-peer-run-proof.json with SHA256 of native-peer-run-strong-proof.log. This is NOT production model inference or autonomous agent response generation: the fixture uses a simulated summary model and invokes load_skill on the native recipient runs. It proves the engine path and state transitions only.


## Effective native Skill-read permissions (2026-11-23)
A live Charlie-to-Jacob and Charlie-to-Theodore canary exposed a misleading grant-count
metric: agents with the broad wildcard agent_scopes.scope=* can actually invoke
load_skill on ordinary Skills even without a separate exact skills:read row.
The Tool Gateway evaluates toolAccess over scoped grants, with an explicit
deny:load_skill overriding wildcard, exact read scope and tool-specific grants.
Before this correction the draft Skill Exchange demanded one literal skills:read
row and could deny valid peers while accepting explicitly denied peers.

Skill Exchange now filters four relevant grants, evaluates native toolAccess for
load_skill at both initial preflight and under transaction FOR SHARE locks,
and denies sharing to peers with an actual Tool Gateway load denial.
Wildcard and explicit-deny tests were RED (both failed) before the fix and
GREEN (both passed) after. Full isolated Skill Exchange suite: 15 PASS,
103 assertions, 0 FAIL; Engine TypeScript 0 errors.
Evidence on M3 Max:
~/Documents/Agentes-Handoffs/ac-charlie-native-acceptance-20261122/wildcard-red.log
~/Documents/Agentes-Handoffs/ac-charlie-native-acceptance-20261122/wildcard-green-v2.log
~/Documents/Agentes-Handoffs/ac-charlie-native-acceptance-20261122/wildcard-full-suite.log
~/Documents/Agentes-Handoffs/ac-charlie-native-acceptance-20261122/wildcard-tsc.log

This fixes draft source code, not live production. No production scope grants
were changed. Preserve independent security review, protected integration and
live real new-Skill peer application as explicit release gates.
