# 0200 — Google Colab remote compute through a fixed OAuth connector

Status: Accepted

## Context

The official Colab MCP endpoint can provision runtimes and execute Python. Its initialization
and tool catalog are public, but its tools require a Google OAuth access token. Google does not
support dynamic client registration for these servers. Treating a successful public probe as
authentication would create a connector that discovers tools but cannot use them.

The existing MCP SDK's default timeout is 60 seconds and sends cancellation when it expires.
Colab documents a 600-second execution RPC deadline that may leave code running for reattachment.

## Decision

Add Colab to the existing fixed OAuth connector catalog. The deployment registers a Google Web
application, configured through the normal environment schema. Existing state, PKCE, encrypted
credentials and refresh leases are reused. Authorization requests offline access and consent;
a callback without a refresh token, or with a known scope that omits Colab, stores no connection.

The official URL in the custom-connector flow enters the same fixed OAuth flow. API-key and
unauthenticated catalog connects are refused. This change does not alter the discovery behavior
of unrelated custom MCP servers.

Map the ten documented tools to read, run and delete scopes. Runtime details and listings need
run access because their returned proxy token also permits runtime writes. Runtime deletion has a distinct
scope and the existing sensitive-action policy. Existing grants remain effective according to
the usual tool gateway; this feature creates no new agent-specific grants.

Only the official Colab endpoint's runtime creation and code execution receive a 660-second
client timeout. Calls are dispatched once. Tool guidance requires stable session/execution IDs
for reattachment after an uncertain server failure, and explains that replaying a completed
execution ID runs the code again.

## Consequences

This is an optional remote compute connector, not a new scheduler, permanent GPU service or CU
balance meter. Runtime ownership, checkpoints and persisted results belong to each task.
A real authenticated smoke test and token-refresh check remain deployment gates; public tool
discovery or fake-provider unit tests cannot prove Google account access.

No database migration or local GPU software is needed. See the
[setup and job guide](../colab-remote-mcp.md) for configuration, validation, lifecycle and rollback.

Sources: [Colab MCP reference](https://developers.google.com/colab/api/reference/mcp),
[Google MCP authentication](https://docs.cloud.google.com/mcp/set-up-authentication-mcp-servers).
