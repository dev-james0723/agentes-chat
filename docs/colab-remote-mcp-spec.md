# Google Colab remote compute — engineering specification

Date: 2026-11-20
Implements: [product requirements](colab-remote-mcp-prd.md)
Architecture authority: [ADR 0200](adr/0200-colab-remote-mcp.md)
Operator procedure: [setup guide](colab-remote-mcp.md)
Reusable guidance: [job playbook](colab-job-playbook.md)

## Architecture

Reuse the fixed OAuth connector, encrypted credential store, refresh leases, MCP client and tool gateway. Colab supplies a remote runtime; orchestration stays in the current server. The catalog/code remain authoritative for names, scopes and timeout behavior.

## Global constraints

- Use only https://colaboratory.googleapis.com/mcp for the built-in Colab connector.
- Request only https://www.googleapis.com/auth/colaboratory for this connector.
- Store CONNECTOR_COLAB_CLIENT_ID and CONNECTOR_COLAB_CLIENT_SECRET only in protected server configuration.
- Preserve existing models, credentials, grants, approvals, enabled skills and non-Colab connectors.
- Add no package dependency, database migration, scheduler or automatic purchase.
- Use 660000 ms only for create_runtime and execute_code on the exact official Colab endpoint.
- Dispatch each MCP call once; do not automatically replay an uncertain execution.
- Do not claim authenticated operation before a real tool call and token-refresh check succeed.

## Files and interfaces

| File | Responsibility |
| --- | --- |
| packages/config/src/schema.ts | Optional OAuth variables and secret metadata |
| packages/config/src/connectors.ts | Maps the configured client pair |
| packages/engine/src/connectors/colab.ts | Endpoint/scope, exact endpoint predicate, timeout and guidance |
| packages/engine/src/connectors/catalog.ts | OAuth endpoints and tool scopes |
| packages/engine/src/connectors/connections.ts | Existing OAuth lifecycle plus Colab refresh/scope checks |
| packages/engine/src/connectors/custom.ts | Routes the official pasted URL to fixed OAuth before probing |
| packages/engine/src/connectors/mcp.ts | SDK timeout and prepended task guidance |
| packages/config/src/colab.test.ts | Optional configuration and secret handling |
| packages/engine/test/colab-mcp.test.ts | OAuth, refresh, scope, URL-routing and timeout regressions |
| apps/web/src/components/ConnectorCatalog.tsx | Accurate OAuth-only and unconfigured connector presentation |

Helper contracts:

- isColabMcpEndpoint(value: string): boolean
- colabCallTimeoutMs(serverUrl: string | undefined, tool: string): number | undefined
- colabToolGuidance(tool: string): string
- mcpSessionOver(transport: Transport, serverUrl?: string): Promise<McpSession>

Accept the canonical endpoint and its trailing slash. Reject URL credentials, queries, fragments, non-default ports and other hosts. URL normalization can normalize the default HTTPS port.

## OAuth prerequisites and handoff

The Google account must own the intended Colab entitlement and be eligible for the selected runtime. Register a Web application client with the exact callback:

```text
${PUBLIC_URL}/api/app/connectors/oauth/callback
```

Derive this from the actual server PUBLIC_URL; the concrete instance callback belongs in its protected deployment handoff. Enable the Colab API for the project. The user's required sign-in is a handoff; do not extract browser cookies or mint a user login session.

Google's Personal audience flow is appropriate when the client serves only its creator. Official guidance describes a new single-creator project without the seven-day Testing expiry; audience selection cannot later be converted. Choose it deliberately. In the console flow, select the AI-agent use option when offered. Console acceptance is a live check, not established by documentation alone.

Authorization endpoint: https://accounts.google.com/o/oauth2/v2/auth with access_type=offline and prompt=consent. Token endpoint: https://oauth2.googleapis.com/token. The existing flow adds state, PKCE S256, redirect URI and client ID; the backend exchanges the code using the protected client secret.

A callback missing refresh access, or a returned scope string omitting the Colab scope, creates no connection. Google does not provide dynamic client registration for this endpoint. Keep OAuth credentials, codes, cookies and runtime proxy tokens out of chat, source and build output.

After handoff, return to the connector screen and inspect the secret-free connection state. The existing single-use OAuth state is valid for ten minutes; if expired or already used, start a new flow. Do not replay a used callback. A connected card does not replace the authenticated tool checks below.

## Tool access

| Scope | Tools |
| --- | --- |
| colab:read | get_subscription, list_runtime_specs, list_sessions |
| colab:run | get_runtime, list_runtimes, create_runtime, create_session, execute_code, delete_session |
| colab:delete | delete_runtime, marked sensitive |

Runtime reads return a proxy token that authorizes file writes, so they require run access.

An existing global * grant covers these tools. Preserve it. Deletion follows the current approval level. Do not grant everything again, disable approvals or silently narrow existing access.

For narrower agents, grant connection-specific colab:read and colab:run only when needed. The access PUT replaces the full submitted set: merge with existing grants and preserve per-tool allow/deny entries. Never send only the new scopes over a populated configuration.

## Existing application paths

All API paths have the /api/app prefix and use the normal application session. Browser mutations require the allowed Origin and JSON content type.

| Action | Method and path | Shape |
| --- | --- | --- |
| Read catalog | GET /connectors/catalog | connectors and builtinScopes |
| Start consent | POST /organizations/{orgId}/connectors/colab/oauth/start | { returnTo?: string } -> { authorizeUrl: string } |
| Callback | GET /connectors/oauth/callback | Existing state/code handling |
| Read connections | GET /organizations/{orgId}/connectors | Secret-free views |
| Inspect access | GET /organizations/{orgId}/agents/{agentId}/access | Effective tool/scope states |
| Save access if needed | PUT /organizations/{orgId}/agents/{agentId}/access | Full all/connectors/scopes/tools allow+deny object |
| Install playbook | POST /organizations/{orgId}/skills | name, description, body, defaultForNewAgents |
| Enable this skill | PUT /organizations/{orgId}/agents/{agentId}/skills | { skills: [{ skillId, enabled: true }] } |
| Verify assignments | GET /organizations/{orgId}/agents/{agentId}/skills | Library with enabled flags |

Skill assignment upserts only the named rows. Skill creation with an existing name creates a new version: compare before updating, and skip an identical import.

A bounded, owner-authorized maintenance script may call the same exported saveSkill and setAgentSkills services from the trusted server. It must retain their permission checks and audits, default to dry-run, pin the exact organization/body/agent set for apply, create only when absent, and reuse an identical existing body. A different same-name body is a conflict, not an overwrite. No browser-cookie extraction or user-session creation is involved.

UI: /org/{orgId}/settings/connectors and /org/{orgId}/agents/{agentId}?tab=access. Correct OAuth-only copy in the existing catalog rather than add another screen. Validate configured and unconfigured states; visual review remains pending when a browser cannot be attached.

## Execution contract

Persist a job ID, input references/hashes, output destination, runtime/spec, task-owned session, requestId, exact code/executionId, status, checkpoints and output manifest. Store no proxy token in that record.

Reuse a suitable runtime. Use a separate session per task; sessions share hardware. Initially run one heavy job at a time unless available capacity is measured.

On DEADLINE_EXCEEDED or UNAVAILABLE, reattach with identical session, executionId and code according to Google's contract. Once the result has returned, that executionId can run the code again. A restart is not permission to rerun effects.

Only the two long operations receive 660000 ms. Guidance precedes vendor text so the recovery rules survive the existing 1024-character description limit.

Transfer files through the documented runtime HTTP API. Save outputs outside Colab and verify content/hash before cleanup; a printed path is not a delivered artifact. Close only owned sessions. Deletion remains subject to task authorization and existing approval policy.

## Deployment preservation

Derive from the immutable current live image, then apply only reviewed Colab changes after comparing every affected file. Preserve unrelated overlays absent from the older candidate checkout. Rebuild web assets from the actual live web source plus the narrow UI fix; do not overwrite newer live web behavior with an older source snapshot.

Validate in a disposable container with no production database, credentials or volumes. Retain previous image/configuration and a normal backup. Recheck active agent runs, machine tasks and processing outbox jobs immediately before switching.

Use graceful stop with at least the existing 40-second timeout. The app stops workers, drains runs for 20 seconds, then allows about five seconds to checkpoint. A cut tool may have effects and fail recovery rather than replay. Do not erase pending jobs to manufacture an idle queue.

After release, verify health, current image identity, pre-existing overlays and settings. Rollback restores the prior image/configuration; no Colab schema migration needs reversal.

## Acceptance evidence

1. Isolated tests and relevant static checks pass; record exact commands and exit status.
2. Configured catalog shows Colab available with correct OAuth-only labels.
3. Consent completes for the intended Google account.
4. Authenticated get_subscription and list_runtime_specs succeed.
5. A task-owned session returns 2 from print(1 + 1).
6. A 70-second Python call returns its marker without the old 60-second cancellation.
7. Retrieve a tiny generated result file outside Colab and verify its contents.
8. An authenticated call after token refresh succeeds; report any still-pending check.
9. Intended agents have effective access and the playbook enabled; previous settings are preserved.
10. Close the smoke-test session and account for any runtime created.

The 70-second test proves this path exceeds the old timeout. It does not prove unlimited execution, continuous runtime availability or a completed GPU/audio workload.

## References

- [Colab remote MCP](https://developers.google.com/colab/api/reference/mcp)
- [Google MCP authentication](https://docs.cloud.google.com/mcp/set-up-authentication-mcp-servers)
- [Google Web OAuth](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Personal OAuth audience](https://support.google.com/cloud/answer/15544987?hl=en)
- [Personal OAuth client setup](https://support.google.com/cloud/answer/15549945?hl=en)
- Existing source: apps/server/src/routes/app/{connectors,access,skills}.ts; packages/engine/src/{access,skills,cancel,recovery}.ts; apps/server/src/start.ts.
