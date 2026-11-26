# 0213 — TREG through the shared MCP connector

Status: Accepted for implementation; live activation is verified separately.

## Context

TREG exposes a team MCP gateway for catalog discovery and external tool execution. Its generic
`call` and `call_media` tools can invoke endpoints with different effects and prices, so a remote
read-only annotation is not sufficient authority to execute them. Routine and interactive agents
must use the same credential, scope, approval and evidence boundaries.

## Decision

Add the official `https://treg.to/mcp/` preset to the existing organization-scoped custom MCP path.
Reuse encrypted credentials, native OAuth/key connection flows, tool pins, agent scopes and the
Tool Gateway. No provider, scheduler, production dependency or database migration is added.

A reviewed list of discovery/status/result tools is read access; other tools require write access
and native sensitivity. Dynamic executors cannot receive a remembered blanket grant or an
approval ahead of a routine. A positive TREG ceiling additionally needs an exact approved native
call; an agent's broad “never ask” setting does not supply that positive budget.

The backend inserts `X-Treg-Route-Max-Cost` in executor argument headers, defaulting to zero.
It sends safe attribution IDs in transport `X-Treg-Meta`, strips model-supplied authentication
and attribution headers, and generates idempotency keys from organization, connection, agent,
run and native call identity. The official endpoint is fixed and does not follow redirects.

A zero ceiling limits TREG reservations, not a provider's own BYOK charges. This feature makes
no promise of zero total cost, no global concurrent budget ledger and no automatic top-ups.
TREG Hub publishing is blocked because its live checks have no caller budget ceiling.

Calls dispatch once. Uncertain transport outcomes require reconciliation, especially for media
that the upstream service cannot replay. Top-level protocol errors, HTTP failures and provider
success-rule failures are native failures even when the MCP envelope succeeds; reported costs
remain evidence on failed calls.

Preserve structured MCP metadata. TREG inline audio/image/resource bytes are kept as native
untrusted file artifacts in the originating run's context, limited to eight files and 50 MB total.
Media execution requires native storage before dispatch. Retention failure never retries
generation. The current upstream native-media adapter provides audio; arbitrary binary
image/video responses are not made lossless by this integration.

## Consequences

The same tool source is usable by every authorized agent and routine without copying tokens
to their machines or changing model routing. Connecting an account does not create grants.
Current-agent rollout and the policy for new agents must be read back in each intended workspace.

An authenticated account inventory and representative real calls remain activation conditions.
Fake-provider tests, a merged preset and stored OAuth configuration are not live acceptance.

See [operation and activation guide](../operations/treg-shared-tools.md).
