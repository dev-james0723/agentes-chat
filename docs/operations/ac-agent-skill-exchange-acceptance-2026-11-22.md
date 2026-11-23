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

## Jacob PR #205 security review remediation (2026-11-23)
Independent native QA reviewer Jacob marked original PR #82 SHA
cd05596e43044eed28a2f41c204716917244dffa as **NOT APPROVED**
for four source-level issues. This code update addresses all four:

1. **P2 executable text**: automatic exchange now rejects interpreter
   vocabulary anywhere in Skill BODY or DESCRIPTION; rejects URLs, triple
   backticks, triple-tildes, HTML markup, shell substitutions and Unicode
   zero-width / compatibility-obfuscated tokens. Technical Skills with
   runnable instructions must use human-reviewed installation. A native
   Tool Gateway test checks 11 unsafe bodies and descriptions and no grants.
2. **P2 incomplete auto share**: after durable peer grants, failed Wiki or
   peer consultation is audited as skill.exchange_unverified with reason
   partial_delivery. A real isolated PGlite test renames Wiki's table to
   induce failure, checking both durable peer grant and the audit.
3. **P3 TOCTOU**: callableAgents/canTalkTo recheck inside the transaction
   after recipient rows are locked, not only at initial preflight.
4. **P3 Wiki query**: DB filters source type and exact Skill ID and LIMIT 1;
   does not fetch the workspace's entire Wiki corpus into memory.

Evidence: M3 Max directory
~/Documents/Agentes-Handoffs/ac-agent-skill-exchange-20261122.
The test receipts include pr82-review-script-red.log, pr82-review-script-green.log,
pr82-review-partial-audit.log, pr82-review-biome-final.log,
pr82-jacob-remediation-all-five.log (80 PASS, 0 fail, 351 assertions),
pr82-jacob-remediation-engine-tsc.log (Engine TypeScript success) and
pr82-jacob-remediation-final.receipt (SHA256).
All tests use isolated PGlite and simulated structured-summary model.
No production migrations or deployment, provider changes, global scope
expansion, independent GitHub approval, or branch-protection bypass occurred.
Independent re-review and protected parent merge remain REQUIRED.

## Jacob third-round regression remediation — 2026-11-23
Independent native re-review rejected a20989fe because a blacklist
of interpreter names misses aliases such as pythonw, py, dash, ksh,
cmd /c, lua -e, jruby, perl6, deno and Unicode soft-hyphen evasion.
It also found caller's agent authority was reread without a matching
share lock inside the grant transaction.

This candidate adds a general command-shape denial of shell-style
switches, slash switches, known executable file suffixes, shell quote
substrings and soft-hyphen / hyphen-variant obfuscation. New RED
regressions were observed on prior SHA; the expanded gateway
regression now has 48/48 assertions (0 fail) across bodies and
descriptions. This intentionally fail-closed checker is not a
proof that arbitrary prose has no unsafe semantic instructions:
genuine technical or executable Skills require human review.

The share transaction now selects and locks both the creator/caller
row and all recipients in stable agent-ID order before the final
callableAgents/canTalkTo and owner authority checks. Thus revoking
the caller's autonomyBrakes during grant cannot bypass the
in-transaction validation. The transaction and participant guard
do not waive a separate human permission review.

Evidence on M3 Max:
~/Documents/Agentes-Handoffs/ac-agent-skill-exchange-20261122/
pr82-round3-unsafe-red.log, pr82-round3-unsafe-green.log,
pr82-round3-biome.log, pr82-round3-tsc.log and
pr82-round3-five-suites.log with receipt (80 PASS, 0 FAIL, 375
assertions). Independent re-review is still required for the new
exact SHA; no protected CI status, merge, production migration or
autonomous Skill activation is implied.

## Victor and Jacob additional review follow-up — 2026-11-23

Both reviewers rejected the former d58d1c60 SHA; Victor identified
deno run app, tsx watch server and a javascript URI, while Jacob
demonstrated a script heredoc and path switch. Victor also found
that the common direct share_learned_skill path could return a failed
Wiki receipt without creating the skill.exchange_unverified audit.
The local 6071b765 commit had partially handled path switches and
heredocs but was not yet pushed to PR #82 when this follow-up began.

This remediation is fail-closed for unattended public sharing:
- The ordinary prose path accepts letters, numbers, whitespace,
  limited sentence punctuation and bullet/headline markers. It rejects
  file paths, URI schemes, code delimiters and symbols rather than
  trying to enumerate every possible executable.
- A separate execution-vocabulary check disallows programming
  runtimes, command verbs and common interpreter aliases in both
  Skill BODY and DESCRIPTION.
- Runnable or ambiguous technical Skills require human-reviewed
  publication; auto-promotion may still retain safe private how-to
  notes without publicly spreading executable instructions.
- skill.exchange_unverified partial-delivery audit is now emitted
  by shareLearnedSkill for direct native tool calls and automatic
  promotion alike; the separate auto-promotion caller no longer
  duplicates that audit.
- The caller and recipients remain locked in stable order for native
  audience/autonomy validation, including explicit deny precedence.

Evidence was run on the isolated PGlite Tool Gateway. Reviewer cases
were genuinely RED before this patch; the expanded dangerous-prose
test is GREEN with 82 assertions and a new direct-share Wiki failure
audit test is GREEN with 7 assertions. Five Engine test modules now
pass 81/81, 416 assertions, Engine TypeScript and Biome exit 0,
at the precommit source tree. Logs/receipts:
~/Documents/Agentes-Handoffs/ac-agent-skill-exchange-20261122/
pr82-thirdparty-unsafe-red.log, pr82-thirdparty-audit-red.log,
pr82-thirdparty-unsafe-green.log, pr82-thirdparty-audit-green.log,
pr82-review-final-five-suites.log, pr82-review-final-tsc.log,
pr82-review-final-gates.receipt.

No statement here is a full production release: PR #78/#82 still
require protected independent review and exact-head local CI;
migrations 0282/0283 and an authorized, AC-verified summary model
have not been installed, and the previous Charlie how-to is private
low-trust source data that cannot become a public Skill by fiat.

## Fifth reviewer executable prose regression (2026-11-23 UTC)

The independent reviewer Victor demonstrated 23 executable sentence
forms missed by a command-name denylist at an earlier SHA. Before the
fix, a new isolated native Tool Gateway test reproduced a share
acceptance for those unlisted executable imperatives (RED). Automatic
peer sharing now requires *both* the legacy safe-text checks and a
strict whitelist of non-executable procedural sentence openings and
well-known, non-executable Markdown headings. Unknown imperative
tokens and runnable source are refused for unattended publication,
even when they resemble ordinary English; a person can still
review and install a useful technical Skill via the existing manual
path. This is an intentionally conservative syntax gate, not a
semantic safety classifier.

The same 23 known reviewer cases are included in the promotion/share
test, alongside 17 additional script/fence/Unicode examples. The
positive A->C/D/E native Tool Gateway Golden Journey still passes.
Five real PGlite engine suites after repair: 82/82 PASS, 0 fail,
577 assertions; Engine TS and Biome exit 0. Receipts:
~/Documents/Agentes-Handoffs/ac-agent-skill-exchange-20261122/
pr82-reviewer-23-red.log, pr82-reviewer-23-green.log,
pr82-safe-grammar-positive-green.log,
pr82-strict-prose-five-final.log,
pr82-strict-prose-final.receipt (with SHA256).
No production migration or installation was claimed; independent
review at exact new SHA is still required.

## Immutable source-content digest (2026-11-23)

An independent review found that a previously verified first-version
agent-origin Skill could be modified in place and still borrow its
original skill.created source-memory receipt for unattended sharing,
including a prefix-concealed executable imperative. That path has
been replaced with a cryptographic content integrity check.

The original trusted promotion transaction records SHA256 of
JSON.stringify([description, body]) alongside the exact source-note IDs
in its native skill.created Agent Action. A later native peer share
fails closed unless the current first-version Skill body AND
description match that digest, both at admission and under the row lock
inside the grant transaction. A missing older digest also fails
closed, not as an implicit approval. Any owner-reviewed manual
revision has its own separate legitimate installation path.

Reproduction evidence:
~/Documents/Agentes-Handoffs/ac-agent-skill-exchange-20261122/
pr82-tamper-digest-red.log shows the former unsafe share;
pr82-tamper-digest-green.log and pr82-tamper-digest-both-green.log
show rejection of body or description tampering with no unauthorized
grant or Wiki copy. Five native Skill/Learning integration suites:
83/83 PASS, 0 fail, 584 assertions; Engine TypeScript and Biome exit
0 (pr82-sealed-promotion-gates.receipt, SHA256 logs).

This is content integrity, not semantic verification of what the
original summary model generated. The separate fail-closed syntax
filter, high-trust public source requirement, independent review, and
human-reviewed path for executable guides remain mandatory. No
production migrations, privileged DB mutation or deployment occurred.
