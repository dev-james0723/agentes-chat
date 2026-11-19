# 0200. A Claude API credit route for a subscription at its limit

- Status: Proposed
- Date: 2026-11-19
- Builds on: ADR 0005 (PostgreSQL only), ADR 0007 (provider keys behind the Model Gateway), ADR 0032 (brains and the fallback by what exists), ADR 0059 (plan usage and limits), ADR 0097 (how every turn ends)
- Code: `packages/db/src/schema/credit-route.ts` (migration `0282`), `packages/engine/src/credit-route.ts` (refusals, failure classes), `credit-ledger.ts` (qualification, holds, settlement), the gateway's `credit` call (`gateway.ts`), the executor's `moveToCreditRoute`, `leaveCreditRoute` and `returnToSource` (`executor.ts`), tests `credit-route.test.ts`, `credit-gateway.test.ts`, `credit-route-executor.test.ts`

## Context

A workspace's agents on a Claude subscription stop when the subscription reaches its usage limit. A workspace may also hold Claude API credits that its provider grants with the plan. Using them when the subscription is out is what the owner wants; spending money that was never granted is what must never happen.

Three facts shape this, and none is ours to assume:

- An API call that succeeds does not show which balance paid for it. A workspace that also holds purchased credits, auto-reload or invoicing would pay for a call it believed was free.
- The provider gives no per-call spending cap and no balance we can read while a call is in flight. Our own estimate of a call's cost is a guess and says nothing about the provider's balance.
- The existing quota policy (owner policy 2026-11-14) lets a plan at its limit move only to another subscription route, or to a local model. It deliberately keeps a paid cloud API out of that fallback.

## Decision

### 1. A route exists only where the provider stops at an empty grant

An operator registers a pool with the evidence they read at the provider: the provider's own organization, that the billing there is a prepaid grant with no purchased balance, no auto-reload and no invoicing (`enforcement: prepaid_grant_only`), a reference to the evidence (never the evidence itself), when it was read and until when it is trusted, and the grant's window when the provider gave one. Where that cannot be shown, no pool is registered and nothing changes: the subscription's existing choices stand. This is a condition on the account, not a per-request promise: what protects the money is that the provider has nothing else to charge.

`allocationNanoUsd` is our own ceiling on what this server spends in the pool. It is a defensive ledger for the traffic we see, never the provider's balance, and no message, status or setting calls it that.

A route is one credential at one exact version (the digest of its sealed row and configuration), on the provider's own endpoint, for one model. Each credential belongs to one pool, and one upstream organization is one pool across every workspace (`unique(upstream_namespace, upstream_account)`): two workspaces cannot each spend the same grant.

Routes and pools are off when registered. Switching one on needs evidence that is still valid. Nothing here has an HTTP surface or a screen: an operator registers and switches routes from a script, so no screen can imply more than the evidence shows.

### 2. Off in the server, and again off per workspace

`CREDIT_FALLBACK_ENABLED` (default `false`) wires the qualifier and tells the gateway to guard credit keys. With it off, no call checks anything and a call that asks for a route is refused. With it on and no registered, enabled route, the run behaves as before.

### 3. When a run may move

Only on a genuine, account-wide `plan_limit` of a Claude subscription: not a usage warning (a reserve reading), not one model's own limit (`scope`), not a 429, an authentication error or an outage. And only where the existing moves to another subscription are allowed: no tool of unknown outcome, no pending call, no checkpoint hold, no mission, not a right hand, an agent that may fall back, a context under the portable limit and free of credential-like text. A turn cut after tools already ran stays on its computer's session.

The order is: the subscription; the credit route; another subscription (ADR 0032 and the 2026-11-14 policy); the local model; the wait for the reset. The agent's own default brain and model never change: the run's effective brain does, in one transaction that compares the run's state (still running, no unknown effect, no hold) before anything is sent. Mid-run, the model starts from the same portable record a new harness would read (what was asked, what was done, a note not to repeat finished work), so completed tool receipts are not lost.

### 4. Every call is admitted again, at the last moment

Qualification is a look. The gateway admits each call on the route (the pre-warm and every retry included) under row locks taken in a fixed order (credential, route, pool): the credential's exact version, revocation, endpoint, the route's tools and prompt size, the pool's evidence window, grant window, status and room. A hold for the call's worst-case cost is added to the pool in the same transaction, so two calls racing for the last of the allocation never both get it. A refusal sends nothing and returns the agent's budget reservation.

A credential that belongs to a route is reserved: when the server has credit routes on, no other call may spend it (the agent's own key, an organization call, a key probe), whoever it is for. The key stays in the gateway; it is never given to a computer, a runner's environment or the transcript.

### 5. What a failed call leaves behind

The only refusals that charged nothing are an HTTP 4xx answered before any output. Everything else may have charged.

| What the provider said | What it means | What happens |
| --- | --- | --- |
| Credit balance too low | the grant is empty | hold returned, pool `exhausted` until an operator's new evidence; the run leaves the route |
| 402 | a billing problem | hold returned, pool `billing_blocked`; the run leaves the route |
| 401, 403 | the credential or its access | hold returned, route switched off; the run leaves the route |
| 429 | throughput, never money | hold returned; the call is tried again by the usual retry |
| another 4xx | refused before generating | hold returned; the usual failure |
| timeout, 5xx, 529, a dropped connection, a stream that began | it may have run and charged | the hold stays; the run stops with a reason and the call is never sent again |

A hold of unknown outcome is not freed by time or by a restart. Only a person's reconciliation closes it (`settleCreditAttempt` with `settled` or `released`). A call that cost more than its hold pauses the pool.

### 6. Leaving the route

When the route cannot go on, the run goes back to a new session of its subscription with the whole conversation as portable context, never into the old session, which has not seen the turns the route made. The usual choices follow: another subscription, or the wait for the reset. It does not come back to the route in the same run (`creditRoute.ended`). A run that resumes after a restart is qualified again on exactly its route; a rotated key, expired evidence or an exhausted pool sends it back the same way. The next message of the agent starts on the subscription again, so the route returns to the subscription at the next run, not in the middle of one.

### 7. What people see

One line in the task when the run moves, one when it leaves, one when a call's outcome is unknown. None names a balance, since nobody here can read one. Run steps record the route's state (`selected`, `skipped` with the refusal's reason, `ended`) and whether eligibility was verified.

## Consequences

- A workspace that registers nothing, or whose server leaves the switch off, is unchanged.
- The route does not make the grant spendable by anything but the credential qualified for it, at the version qualified.
- An unknown outcome costs a failed run and a held amount until someone looks, which is the price of never charging twice without knowing.
- The allocation can drift from the provider's real balance; the provider's refusal is the authority and ends the route.
- Registering, enabling and reconciling are operator scripts. A screen for them needs its own ADR and the visual and accessibility work that goes with one.
