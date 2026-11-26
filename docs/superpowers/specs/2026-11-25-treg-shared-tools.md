# TREG shared tools: product and engineering specification

## Outcome

Make TREG available through agentes.chat's existing organization-scoped MCP connector so every authorized agent and routine can discover and use external tools. Model providers and subscription routing remain unchanged.

## Current baseline

The inspected source revision is 4992a8efc5f47b763d0ab0854a3c034af655a4f7. The existing connector source uses Streamable HTTP, encrypted organization credentials, classified tools, agent scopes, and the common Tool Gateway. Creating a connection does not create agent grants. Native task ownership and live account authorization are not yet verified.

## Requirements

- R1: Offer a TREG preset at https://treg.to/mcp/ using the existing OAuth or Bearer-key connection flow. Only the exact HTTPS team endpoint receives TREG-specific treatment.
- R2: Keep catalog/status/result reads distinct from general executors. Treat all other TREG tools as sensitive and do not pre-authorize dynamic executors as ordinary routine actions.
- R3: Set attribution from backend organization/agent/run/tool-call identity. Never accept model-supplied attribution or authentication headers.
- R4: Inject X-Treg-Route-Max-Cost inside call/call_media arguments.headers, not only on the MCP transport. Default the TREG charge ceiling to zero. A positive ceiling needs an exact native approved call, must be a finite nonnegative amount, and is shown in the approval details.
- R5: Generate a stable idempotency key from backend call identity. Make one dispatch; never automatically retry unknown execution outcomes. An idempotency key is not an exactly-once guarantee for all providers or inline media.
- R6: Preserve structured MCP result metadata and record observed TREG call ID, reported cost, replay state, and status in native run evidence. Missing cost stays unknown, not zero. This is call evidence, not an invoicing ledger.
- R7: Reuse organization separation, encryption, tool classification, native permissions, and existing routine runs. Do not add a model provider, daemon, external key upload, paid plan, or new production dependency.
- R8: Rollout requires an authenticated workspace inventory, one reconciled connection per intended workspace/account, explicit existing-agent grants, future-agent policy readback, and representative real calls. A preset, fake test, or file on disk is not live all-agent acceptance.
- R9: Keep TREG credentials on the backend and reject endpoint redirects before credentials can follow. Preserve non-TREG behavior.

## Cost and authority boundaries

A zero TREG ceiling prevents a positive TREG reservation. It does not prove zero upstream charges when the team's own provider credential is used. Native approval policies still govern effects; broad permission to call tools does not grant a new billing budget. No promotional credit, account balance, or existing paid authorization is assumed.

Before a real call, use current catalog_get metadata. Public skill prose can contain stale pricing. Initial live acceptance uses only catalog/status reads until the account and an authorized call are known. No automatic top-ups or wallet payments.

## Interfaces and implementation

Create connectors/treg.ts for exact endpoint matching, known discovery-tool classification, sanitized dispatch policy, backend attribution/idempotency, and receipt normalization. Add the preset in presets.ts and reuse the generic connector icon. Integrate policy in mcp.ts and classification in custom.ts; no schema migration. Use existing ToolContext.approved only as supplied by the native gateway, never from model arguments.

Each authenticated call uses the connection's encrypted Bearer credential plus backend X-Treg-Meta. call and call_media receive sanitized headers and a stable idempotency_key. Unknown transport outcomes carry reconciliation guidance and native evidence; no automatic replay.

Inline native MCP media is saved through AC's untrusted artifact path with run placement and a 50 MB/eight-file bound. Missing storage refuses media execution before dispatch. Top-level protocol failures are native failures even when the MCP envelope succeeds. Hub publishing is refused because its live checks have no bounded caller cost.

## Verification

Focused fake-MCP tests must cover endpoint spoofing, encrypted credentials, per-agent scope denial, same behavior for routine contexts, immutable attribution, case-insensitive cap/auth stripping, invalid/positive-unapproved caps, deterministic idempotency, metadata preservation, and one-dispatch failures. Existing custom connector and preset regressions must pass. Local CI only. An independent reviewer checks the final change.

Live acceptance is separate: actual OAuth completion, workspace/agent inventory, native access readback, authenticated catalog call and authorized execution, then production identity and user path. If credentials are unavailable, retain BLOCKED_AUTH instead of claiming completion.

## Rollback

Disable or revoke only the TREG connection using native administration; preserve other connections and grants. Revert this feature through normal reviewed source control if needed. No existing credentials, data, or model configuration are migrated.

## Sources (checked 2026-11-25 America/Indiana/Indianapolis)

- https://treg.to/llms.txt
- https://treg.to/integrate.md
- https://treg.to/skill.md
- https://github.com/superdesigndev/treg/blob/7c549f9391651982f64f89b6157d93e02ce6cb29/src/treg/mcp.py
- https://github.com/superdesigndev/treg/blob/7c549f9391651982f64f89b6157d93e02ce6cb29/tests/test_route_cost_ceiling.py

Use the existing project MCP SDK rather than adding a TREG SDK or vendoring upstream AGPL source. This integration uses the documented protocol; upstream source was inspected to resolve protocol ambiguities.
