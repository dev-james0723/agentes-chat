# TREG shared tools: setup, use and activation

## What this integration provides

TREG is an external tool and data gateway. In agentes.chat it is an organization-scoped MCP
connection at **https://treg.to/mcp/**. Interactive agents and routines use the same native tool
source, encrypted credential, permissions and run evidence. Model routing stays separate.

The preset supports the existing MCP OAuth and API-key flows. Prefer a team-scoped agent token
when using a key. Keep the token in the connector's secure field; never put it in an agent prompt,
skill, repository, task text or shared file.

## Connect and grant access

1. Deploy a reviewed source revision containing the TREG preset and confirm the running source identity.
2. Sign in to the intended AC workspace with permission to manage connectors and agents.
3. Inventory existing custom connections first. Reconnect a matching TREG account rather than
   creating a duplicate. Use the team endpoint above, not the catalog-only `/mcp/v2/` endpoint.
4. Connect TREG through its preset and complete its normal account authorization. A public page,
   cached OAuth configuration or a successful health check is not proof of tool authentication.
5. Review and accept tool classification. Catalog/status/result tools are reads. General executors
   and unknown tools remain sensitive, even when a remote read-only hint says otherwise.
6. Grant each intended agent the connection's read scope and, only when execution is authorized,
   its write scope. Preserve unrelated scopes, specific denials and other account grants.
7. Repeat account reconciliation and access readback in each intended workspace. A connection
   in one organization grants nothing in another.

The native API uses the existing authenticated admin routes:

| Operation | Route |
| --- | --- |
| List custom connections | `GET /api/app/organizations/{orgId}/connectors/custom` |
| Connect preset | `POST /api/app/organizations/{orgId}/connectors/presets/treg/connect` |
| Classify tools | `PUT /api/app/organizations/{orgId}/connectors/custom/{connectionId}/tools` |
| Read or update agent scopes | `GET/PUT /api/app/organizations/{orgId}/agents/{agentId}/scopes` |

Scope names are `custom:{connectionId}:read` and `custom:{connectionId}:write`. Existing
connector-wide and all-tools grants still follow normal native rules; explicit tool denials win.
The scopes PUT replaces the managed set: read current values and preserve unrelated grants.

### Current and future agents

This feature creates no automatic grants. New agents retain AC's normal built-in defaults;
there is no implicit TREG grant merely because the preset exists. Enroll new agents through
their native Tools and access settings. Any existing broader access policy must be checked
as actual stored grants, not inferred from instructions or an agent's name.

“All agents activated” requires an authenticated roster, the intended set of agents, and effective
read/write access checked for each one. A source implementation alone cannot establish that result.

## Calling tools

Search the catalog, then read `catalog_get` for current endpoint parameters, authorization and
pricing. Do not rely on a price quoted in an older skill. Tool descriptions include these instructions.

For `call` and `call_media`, AC inserts the cost ceiling into **tool argument headers**, where
TREG actually reads it. An outer MCP transport cost header would not enforce this policy.

```json
{
  "endpoint_id": "an.endpoint.from.the.current.catalog",
  "headers": {
    "X-Treg-Route-Max-Cost": "0"
  }
}
```

The backend supplies its own attribution and idempotency identity. Model-supplied bearer tokens,
team identifiers, attribution and idempotency headers do not replace that identity.

A positive ceiling, for example `"0.01"`, must be included in the exact native approval. It is
visible in the approval details. A broad tool grant or “never ask” setting does not create a new
positive TREG budget, and the executor cannot create a remembered blanket approval.

### Billing boundary

**A zero TREG ceiling does not mean zero total cost.** TREG can select a team's existing provider
credential or registered tool before a TREG-funded route. A provider may charge that credential
without any TREG reservation. `authorization_method` selects provider login strategies; it is
not a platform-versus-BYOK selector.

Before enabling execution, inventory the actual team's credentials and registered tools and
establish the authorized funding arrangement. Catalog/status discovery can be validated first.
No account balance, promotional credit, paid plan, key upload or top-up is assumed.

Reported cost is call evidence, not a settled invoice. Missing cost remains unknown. Per-call
ceilings do not constitute an atomic shared daily/monthly budget across agents.

## Results, media and failures

Native run data preserves a valid TREG call ID, reported USD/microdollar cost, HTTP status,
replay marker, backend ceiling and idempotency key when available. An HTTP failure or a
top-level provider failure is recorded as a failure even if the MCP envelope itself succeeded.
A failed provider call can still report a charge.

Native MCP audio and other supported inline file blocks are saved as untrusted AC artifacts
using the run's organization and conversation permissions. Base64 is not copied into run-step
JSON. At most eight files and 50 MB total decoded bytes are retained. A missing storage backend
refuses `call_media` before dispatch; storage failure after execution is reported without retry.

The current upstream `call_media` adapter produces native audio. Other binary image/video
responses are not lossless in that adapter. Use a documented JSON endpoint returning a URL
or structured payload and retain the provider's result through the appropriate existing file
workflow. Do not claim an image/video artifact was saved until its actual native file exists.

Unknown outcomes are not retried automatically. Reconcile using the known call ID, `call_result`
and TREG account history before another execution. Some inline media cannot be replayed even
with the same idempotency key. An artifact-retention failure is not permission to generate again.

`hub_create` and `hub_update` are refused: their live publishing checks cannot be bounded by
the executor's cost header. Tool consumption does not authorize publishing.

## Acceptance evidence

Record actual values; leave unverified entries pending:

| Gate | Required evidence |
| --- | --- |
| Source | Exact commit, focused/regression results, local CI and independent review |
| Runtime | Running source/image identity matches the delivered revision |
| Account | Authenticated TREG team and reconciled connection identity; secrets excluded |
| Agents | Intended roster and effective grants for each workspace |
| New agents | Actual enrollment/default policy readback |
| Interactive | Authenticated catalog result and an explicitly authorized representative call |
| Routine | A native routine run with the same scope/cost/evidence rules |
| Media, when used | Native artifact ID, original bytes retained and authorized access |
| Charges | Reported cost or explicit unknown, with BYOK handled separately |

No paid acceptance call is needed merely to prove catalog discovery. Do not infer success from
fake tests, a token-shaped string, seven configured MCP entries or a screenshot of a signed-in app.

## Rollback

Revoke only the affected TREG grants or disconnect that TREG connection through native
administration. Preserve unrelated connections, agents and provider credentials. Revert source
through the normal reviewed release path if needed. There is no database migration to undo.

## Primary sources

Checked against TREG's official documentation and source on 2026-11-25:

- https://treg.to/llms.txt
- https://treg.to/integrate.md
- https://treg.to/skill.md
- https://github.com/superdesigndev/treg/blob/7c549f9391651982f64f89b6157d93e02ce6cb29/src/treg/mcp.py
- https://github.com/superdesigndev/treg/blob/7c549f9391651982f64f89b6157d93e02ce6cb29/tests/test_route_cost_ceiling.py
