# 0192 — Optional conditional brain updates for an ordinary owner's own sign-in

Status: isolated source candidate, not deployed. Frozen base `aed5b6fe2d72f18d22986a0c9edc05529e7e781f`; root reviewed the guarded-subset plan before implementation. Source owner retains shared integration and release ownership. No live benchmark, native settings write, provider call, PostgreSQL server, dependency or paid-activation change.

## Problem and native API contract

A benchmark's client GET/compare/PUT can overwrite a legitimate setting changed between reads and writes. Existing brain updates can also clear a machine account's model-limit usage before their target-agent transaction, and audit/remember defaults afterward. Comparing only at the final UPDATE would be too late.

GET/PUT brain responses now add optional nullable `configHash`. PUT accepts optional 64-lowercase-hex `expectedConfigHash`. Omission follows the existing unguarded implementation and permissions; `rememberSetup:false` remains supported and unchanged. With a token, stale state including an otherwise no-op request is `409 brain.config_changed` before any mutation. An unsupported guarded scope is `409 brain.config_cas_unsupported`; malformed tokens are validation errors. The token grants no authority.

The guarded scope is deliberately narrow: ordinary non-right-hand agent, actor is its current owner, native account is null, its computer is paired by that owner, no selected/moved account and no audience change. Named/lent accounts, transfers and right-hand `mine`/`workspace` scopes are unsupported; their GET token is null. Omitted requests still use their existing supported behavior. A brain switch that would implicitly alter the audience is also refused before any mutation; the controlled benchmark must explicitly preserve its existing `onlyOwner` value.

## Hash read set

Use the existing `sha256(canonicalJson(...))` with schema `agent-brain-config/v1`, scope `ordinary-agent`, and the exact raw row fields:

`orgId, id, builtin, ownerUserId, machineId, model, credentialId, brain, brainModel, brainFallback, brainExtraUsage, brainAccountId, brainAccountLentBy, brainEffort, brainSpeed, contextTokens, planForOthers, audienceMode, audienceUserIds, audienceRoleIds`.

Nulls and array order are retained. Only the opaque digest is exposed; no credential value is read or exposed. The same raw ordinary-agent snapshot supplies the view and digest. `updatedAt`, effective/display model, online/availability, usage/quota and labels are not versions. Model/credential/account/machine **IDs** are bound; global credential contents/endpoint changes, account records, machine pairing/availability changes, organization defaults, budgets, memberships, instructions, skills and grants are not frozen by this digest. Normal current permissions/scope constraints are rechecked; a benchmark still needs its separate fresh preservation fingerprint and sole-owner window. This is not a full-organization, provider-billing or quota lock.

## Transaction and lock boundary

The exported `setAgentBrain` keeps the old apply worker when no token is supplied. The conditional branch checks normal access, validates token shape, opens one outer DB transaction and locks the target agent with `FOR UPDATE`. It rechecks native permission through the passed transaction, verifies the supported own-sign-in scope and exact locked-row hash, then invokes the shared private apply worker with that transaction. `getAgent` is a direct select: every derived setting comes from the locked current row, not a preflight object.

All database changes made by the worker, its nested savepoint and native helpers use that same passed transaction, including target update, audits, notification/outbox work and optional `rememberAgentSetup`. Conditional account/audience guards execute before the legacy usage-clear block. The supported branch cannot reach account selection/usage mutation, `releaseAgents` or another agent. It therefore never takes an account lock while holding a target-agent lock. The existing unguarded account→release-other→target order is untouched; this does not qualify general account-transfer CAS.

Cache invalidation is queued until outer commit. `onPlanOpened` is captured for commit-after execution rather than external work inside the transaction. BrainDeps carries only the transaction DB; native notification helper publication has no pubsub and therefore no external effect. The server's machine/agent change publication remains after the service returns, hence after commit. No external network I/O or live model invocation is added. A post-guard audit failure rolls back the target/default/audit state and executes no cache invalidation, covered by an instrumented native DB fixture rather than a parallel in-memory settings store.

Legacy clients without a token intentionally retain overwrite semantics; this optional CAS does not forbid later unguarded writes. Hashes describe state, not a monotonic revision: an exact A→B→A change is indistinguishable from A under this contract (ABA), and no wider history guarantee is claimed.

## Evidence and limits

TDD red: 2 PASS/4 FAIL against baseline, including absent served token, stale update acceptance, both same-token writers committing and unsupported transfer accepting. Initial fixture type/format diagnostics were corrected and retained in check history. Final focused HTTP/engine checks: 13 PASS/55 assertions. The related legacy+CAS run before the final additional round-trip case: 57 PASS/379 assertions; no production code changed afterward. Engine and server typechecks, five-file lint and architecture boundary checks exited zero.

Tests cover served OpenAPI/GET/PUT, fresh narrowing and restoration, stale/no-op mutation conservation, native permissions and plan-owner extra-usage policy, revocation between preflight and the transaction, named/right-hand scope refusal, audit rollback/cache deferral, non-null defaults with rememberSetup false, omitted legacy remembering, and same-token competing updates. Real Codex settings→API→controlled Codex→exact original settings is exercised without generation and preserves the underlying API model/defaults. Two competing requests use PGlite serialization; **no real multi-connection PostgreSQL deadlock or lock qualification is claimed**.

Native acceptance remains NOT_RUN until a reviewed normal release actually serves `configHash`, `expectedConfigHash` and `rememberSetup` together. Operational scripts must then narrow fallback/extraUsage before any generation, keep them false through both conditions and route probe, and use the latest served token for exact restoration with no generation afterward. This feature does not turn `extraUsage:false` into a provider-side zero-spend guarantee or authorize paid fallback/reset.
