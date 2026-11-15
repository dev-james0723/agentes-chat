# 0177. Disabled-by-default Paperclip routine compatibility

- Status: Candidate; no live cutover is implied
- Date: 2026-11-13
- Baseline: agentes.chat `4c68d91d08fa38372bbd2bb1a1ab7096dd9ab7d9`
- Extends: ADR 0053 (native routine background authority), ADR 0015 (tool permissions and approvals), ADR 0151 (task audience)

## Decision

Use the existing PostgreSQL transaction, outbox and native `routine.run` worker. Add authenticated,
organization-scoped migration mappings and durable invocation receipts. Do not add a separate scheduler,
a SQLite runtime bridge, a second model executor, or a production dependency.
`PAPERCLIP_ROUTINE_COMPATIBILITY=off` is the installation default. Both ingress and the worker require the
explicit opt-in. All mappings start disabled. A new native definition starts paused, with reports and files
in the creator's private DM. Creating a mapping queues no work.

A caller may instead adopt their existing paused native definition with its exact config fingerprint.
Adoption preserves that row unchanged and records `unverified_import`. Such a mapping cannot be enabled
until the explicit preparation endpoint compares both fingerprints, owner, paused/idle state and the PC1
source/trigger marker. Preparation preserves the complete original native row (all overwritten trigger/target/report/action fields),
original prompt and source template hash in the binding, retains the source template verbatim in a bounded native execution wrapper, moves it to the
internal receipt event and private DM, and records the new config hash atomically. Both sides stay paused
and disabled. Mail/connector definitions and an over-limit complete template are rejected; preparation
performs no model turn or external registration. The existing plain-webhook row is verified unchanged
and its fingerprint recorded; credential material is never copied into the client-readable binding.
Audit records retain the normal before/after history. The receipt is sufficient to reconstruct original
routine fields; this candidate exposes no automatic restore action. Enabling remains separate.

## Invocation and authority

Only the mapping creator, still holding `manage_routines`, can dispatch it or enable its authority.
The same session, CSRF, organization membership, audience and standing checks as the app apply. An org
routine manager may disable it. Unknown input fields and unimplemented overrides fail before writes.
The immutable config hash binds the source snapshot and native config. Native edits invalidate dispatch.

One outer transaction locks the source routine identity, rechecks the binding, resolves variables, and
writes the receipt, native task, activity, search work, UI publication job, distinct native routine run and
outbox job. A failed queue insertion rolls these back together. Attachment moves are deliberately outside
this transactional helper and are rejected. UI publication does not masquerade as a human-created task
or trigger `issue.created` loops.

Receipts have no age cutoff. The idempotency scope is mapping/source-kind/nullable-trigger/key. A valid
replay returns its original receipt even if its payload changed. Variable validation still precedes replay,
as in the inspected source. No raw idempotency key is stored. Requests without a key remain distinct.
After an ambiguous response, the authenticated lookup endpoint reconciles the key without dispatching.
Do not repeat an unkeyed ambiguous invocation.

Canonical JSON, resolved variables, rendered text, original source agent/revision IDs and the environment
fingerprint determine active-work matching. `always_enqueue` creates a distinct task and run for each
unkeyed invocation. `coalesce_if_active` and `skip_if_active` create only a receipt pointing at matching
active work. They do not create another native job. Do not pass these through native `queueEventRun`,
which merges events and has different semantics.

The normal native worker claims and starts background work, retaining tool permissions, approvals,
budgets, attendance restrictions and routine isolation. Native Run Now rejects mapped definitions;
receipt-free jobs cannot bypass this gate. A final start check holds the mapping row lock through native
agent-run insertion. Disabling the mapping takes that same lock: a start either commits before disable,
or observes disable and creates no agent run. The native definition and receipt-bound task are reread under
shared locks at this boundary; assignment or active-status changes serialize with the start. Already-started
work still needs the native Stop/Pause controls when stopping is intended.
The env flag is process configuration, not a distributed hot-revocation mechanism; all workers must be
restarted/configured consistently before cutover.

A receipt grants its exact background agent run access only to its linked private task, with matching
org, agent, channel and run IDs. It grants no access to the creator's other private tasks. Closing or
reassigning the task revokes this additional reach; the ordinary task audience rules still apply. The model
receives a server-verified task pointer separately from `external_data`; invocation payload cannot select
a different task or grant permissions. Existing issue tools and scopes still govern reading and writing.

Native event deferral replaces a queued row. It moves every receipt pointer in the same transaction.
If all replacement inserts fail, it throws so deletion rolls back and the existing job can retry; it never
commits a dangling pointer merely because the timestamp range was full.

## Supported subset and unresolved work

This is an operator-controlled source snapshot, not live synchronization. Source status, trigger enablement
and revision fields are captured provenance; later Paperclip changes do not automatically revoke target
work. The operator must verify fresh source state and arrange a single ingress before enabling anything.
There is no Paperclip HTTP listener, source mutation, automatic export, live cutover or schedule import here.

Text and textarea variables support required/default values, explicit variables overriding payload.variables,
JSON-to-text conversion and escaped underscores in placeholders. Built-in time/date variables and other
variable types are rejected. The inspected Paperclip `runRoutine` authentic manual/API path bypasses
activity and catch-up gates; their only evaluator call is in `tickScheduledTriggers` (`services/routines.js`
1042, 2362, 2757 in the inspected installed version). This adapter therefore preserves the known source
policy values and permits explicit manual/API calls without inventing schedule events. `source=schedule`
is rejected. No source schedule, project-paused schedule suppression, catch-up, public trigger/worktree
eligibility or external-activity scheduler has been ported.

Projects remain fail-closed in this candidate, including preparation, enabling and dispatch. Paperclip
uses a project's default/primary workspace to choose execution cwd (`services/issues.js` 6689–6744 and
`services/heartbeat.js` 2334–2395 in the inspected version); a label or a prompt path is not equivalent.
An isolated experiment demonstrated the existing native CodeSetup path and required-cwd failures, but
its lexical path comparison did not prove physical snapshot separation or trusted source provenance.
It is not part of this release. In particular, a Linux server container cannot inspect unmounted Mac paths.

The concrete follow-on requires an operator-signed immutable Mac snapshot registry, scoped to source
company/project/workspace, target org/agent/machine and snapshot manifest. Only the explicit registry
would be mounted into the server; no broad source or home mount. A runner-supported identity check must
confirm actual target cwd and reject symlink/case/physical aliases or overlap against the attested source.
Native grants must already permit the target folder; no source-path grants or permission expansion are
implied. The real CodeSetup/BrainTurnRequest path must fail closed on model/machine/grant/proof drift,
without default-folder or API fallback. That provenance design and protocol qualification remain separate
work, not a flag operators can bypass through request JSON.

Goals, parent tasks, nonempty environment, source execution overrides and unverified imported wrappers
cannot be enabled. Preserving their metadata does not implement them. Source medium priority maps to native normal; source critical maps to native high
and retains its source-priority label, so the native board does not gain a new priority level.

Receipts persist for the binding lifetime without TTL; explicit binding/native/organization purges follow
normal deletion and privacy rules. A deleted linked task does not erase a retained receipt. There is no
claim of exactly-once external side effects: a worker or provider may fail after an external action.
Normal approval, uncertain-delivery reconciliation and native outbox retry behavior still apply.

Qualification still required: real PostgreSQL concurrent workers, forced process termination/recovery,
rolling deployments and rollback; source-to-target ID/tool/permission adaptation; real provider and computer
execution; organization-specific workflows; source snapshot freshness and controlled cutover. PGlite SQL
fixtures and fake-provider tests are not evidence that these deployment gates passed.

## Research receipt

The installed Paperclip server package inspected was `2026.1023.0` (MIT; exact installed commit unavailable),
including `services/routines.js` and shared `routine-variables.js`. The source repository is
[paperclipai/paperclip](https://github.com/paperclipai/paperclip). The target's existing Drizzle/PostgreSQL,
outbox, task audience and native routine worker were inspected at the baseline above. The target is
AGPL-3.0-only. No third-party code was copied and no license or dependency changed.

Two comparable outbox patterns were reviewed in the preceding local research and rechecked for current
maintenance metadata on 2026-11-13:

- [AWS transactional-outbox-pattern](https://github.com/aws-samples/transactional-outbox-pattern),
  `6c2a614c13e0e2a155294ef3756c947461530ec1`, recorded 2026-11-11, LICENSE MIT-0 (GitHub metadata
  reports NOASSERTION). Non-archived, last push 2026-11-11, 8 open issues at recheck. The README explains
  dual-write and duplicate-consumer hazards; this infrastructure demo is not a compatible runtime dependency.
- [Gruelbox transaction-outbox](https://github.com/gruelbox/transaction-outbox),
  `062cf2e110004850365f40d850aa107dee313357`, recorded 2026-11-09, LICENSE Apache-2.0. Non-archived,
  last push 2026-11-11, 42 open issues at recheck. It has acceptance/testing modules, but its Java framework
  and extra operational/dependency surface do not fit this TypeScript/Bun integration.

The earlier research recorded zero published repository advisories at that time, not an absence of security
risks. Maintainer responsiveness and dependency-license audits were not established for either candidate;
neither was installed or adopted. Reusing the project-approved native infrastructure avoids their additional
maintenance and licensing surface. The selected strategy adapts only the transactional-outbox pattern.

Agent Reach 1.6.1 was present; `doctor --json` was unsupported and `references/dev.md` absent. Its text
health check reported GitHub available and X unavailable. Public GitHub API metadata was the authorized
fallback. No login, cookie extraction, installer or external data upload was involved.

## Verification

The candidate includes SQL-fixture tests for disabled creation/adoption, authenticated HTTP/CSRF boundaries,
strict overrides, indefinite keyed reconciliation, each concurrency policy, variable rendering, queue failure
rollback, background claim idempotency, exact-task reach, deferral pointer moves and rollback, manual-gate
bypass refusal, final-start disable fencing and real context/Tool Gateway execution with a fake model.
The textarea support, manual gate, deferral failure, start/disable barrier and context-pointer tests
were observed failing before their fixes. The final check receipt accompanies this candidate's handoff;
only the commands and outcomes actually recorded there should be treated as passed.
