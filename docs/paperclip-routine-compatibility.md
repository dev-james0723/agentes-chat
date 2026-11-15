# Paperclip routine compatibility candidate

This optional API preserves a controlled source snapshot and connects supported invocations to native
background work. It is off by default. Read [ADR 0177](adr/0177-paperclip-routine-compatibility.md) before
enabling it. It does not connect to Paperclip, import schedules, or perform a live cutover.

Routes use the normal signed-in app API under `/api/app/organizations/{orgId}`:

| Method and path | Effect |
| --- | --- |
| `GET /paperclip-routines` | List the caller's bindings, even while ingress is off. |
| `GET /paperclip-routine-candidates/{routineId}` | Read the caller's native config/prompt fingerprints and paused status. |
| `POST /paperclip-routines` | Create a disabled binding; creates one paused native definition unless `adopt` is supplied. |
| `POST /paperclip-routines/{mappingId}/prepare` | Compare source/native fingerprints, preserve source text and install the receipt wrapper; stays paused. |
| `PUT /paperclip-routines/{mappingId}/activation` | Compare `expectedConfigHash` and explicitly enable/disable. |
| `POST /paperclip-routines/{mappingId}/invocations` | Validate and atomically enqueue supported work; returns a durable receipt. |
| `POST /paperclip-routines/{mappingId}/lookup` | Reconcile source, nullable trigger and idempotency key without replay. |

Mapping input names are defined by `paperclipMappingSchema`: source company/routine/revision, status,
activity/catch-up policies, triggers (`kind`, not `type`), source and target agent IDs, concurrency policy,
title, description, variable definitions and optional execution metadata. Unknown fields fail. A source
snapshot adapter must populate the actual source fields; it must not replace unsupported policy with a
default. For adoption, send `adopt: {routineId, expectedConfigHash}` from the inspected native candidate.
The existing definition must be the caller's, paused, undeleted, on the same target agent and unchanged.
Adoption writes no native changes, queues no work and remains execution-unverified. Then call `prepare`
with `expectedConfigHash` and `expectedNativeConfigHash`; review the returned changed hashes before any
activation. The original native prompt remains in `definition.preparedNative`, and the source template stays
verbatim in the execution wrapper. A PC1 marker matching the source routine and API trigger is required.

Source projects remain unsupported and are rejected, including at preparation. They affect actual cwd in
Paperclip. A separate operator-signed snapshot/runner identity design is required; a supplied path,
lexical comparison or folder list is not proof of physical separation. No project-binding request override
is accepted in this release. See ADR 0177 for the concrete follow-on and deployment topology limit.

Invocation input takes `expectedConfigHash`, `source` (`manual` or `api`), optional nullable `triggerId`,
`idempotencyKey`, JSON `payload` and explicit `variables`. There is no API key ingress here. Both mapping
creation and dispatch require the installation opt-in. Source overrides outside this schema are rejected.
Use a stable delivery key. If the HTTP response is lost, query `lookup` first. An unkeyed timeout has an
unknown result; do not automatically replay it. Receipt status describes the dispatch decision; read the linked native routine run and task for execution progress and outcome.

Before any live enablement, verify source revision/ownership, target agent/tool/model permissions and
all unsupported fields; qualify the actual PostgreSQL worker, computer and provider; stop duplicate source
ingress through the owning system; and record a reviewed cutover. Keep imported UI definitions paused
while those checks remain incomplete. Merely showing a routine in the app proves its definition exists,
not that trigger semantics or provider execution work.
