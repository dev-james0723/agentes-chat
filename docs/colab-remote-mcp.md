# Google Colab remote MCP

Related: [product requirements](colab-remote-mcp-prd.md), [engineering specification](colab-remote-mcp-spec.md), [job playbook](colab-job-playbook.md), [implementation plan](superpowers/plans/2026-11-20-colab-remote-mcp.md).

The Google Colab connector lets agents manage cloud runtimes and run Python through
`https://colaboratory.googleapis.com/mcp`. It uses the Google-hosted API, not the older
local browser bridge. The agents' coordinator and this server remain where they already run.

## Configure the server

1. In the Google project used for this integration, enable the Colab API
   (`colaboratory.googleapis.com`).
2. Configure the OAuth consent screen for the intended account. Create an OAuth **Web application**
   client and register this exact redirect URI, substituting this installation's `PUBLIC_URL`:

   ```text
   ${PUBLIC_URL}/api/app/connectors/oauth/callback
   ```

3. Add the client values to the server's protected environment:

   ```dotenv
   CONNECTOR_COLAB_CLIENT_ID=your-google-oauth-client-id
   CONNECTOR_COLAB_CLIENT_SECRET=your-google-oauth-client-secret
   ```

   These are an application registration, not the person's Colab access token. Keep the secret
   out of chat, repository commits, agent instructions and browser code. No other connector's
   login is reused. Google does not offer dynamic client registration for this endpoint.
4. Deploy the connector code and configuration through this installation's usual release process.
   The catalog lists Google Colab as unavailable until both values are present.
5. In **Settings → Connectors**, choose **Google Colab**, sign in with the Google account whose
   Colab subscription should be used, and allow the Colab permission. The requested scope is
   `https://www.googleapis.com/auth/colaboratory`. The authorization uses PKCE and offline
   access; refresh tokens are encrypted using the existing connector credential store.
6. Grant the intended agents `colab:read` and, when they should run work, `colab:run`.
   `colab:delete` is separate and permanently deletes runtime files and sessions.
   Runtime details and listings require `colab:run`: Google returns a proxy token with those
   results that also permits writes to runtime files.
   Connecting creates no new agent-specific grants; existing explicit All tools access follows
   the installation's normal policy.

Pasting the official MCP URL into the custom-connector dialog starts this same Google OAuth flow.
A pasted access token is refused because it cannot provide a lasting refreshed sign-in. A
previous custom connection must be disconnected or handled explicitly; this integration does not
silently migrate its grants or credentials.

A Google OAuth application in Testing may have time-limited refresh credentials under Google's
rules. Configure its audience/publishing status for the intended use before relying on unattended
jobs. A provider refusal is shown as a reconnect requirement by the existing connector flow.

## Personal OAuth application

For an integration used only by the person creating it, Google's [Personal audience](https://support.google.com/cloud/answer/15544987?hl=en) can create a single-creator project without the seven-day Testing refresh expiry. Its audience choice cannot later be converted. Follow the [Personal client setup](https://support.google.com/cloud/answer/15549945?hl=en), select AI-agent usage when offered, and use the intended Colab account. Console acceptance still needs a live check.

Register exactly ${PUBLIC_URL}/api/app/connectors/oauth/callback and enable the Colab API. The user handles required Google sign-in. After returning to the connector screen, inspect its state and run the authenticated checks below. An expired or already-used OAuth state needs a fresh sign-in flow; do not replay its callback.

## Import the downloaded Web client

The optional [credential import helper](../scripts/colab/import-google-oauth.mjs) validates a downloaded Google Web-client JSON against the server's current PUBLIC_URL. First validate without changing configuration:

```bash
node scripts/colab/import-google-oauth.mjs \
  --oauth-json /absolute/path/client.json \
  --env-file /absolute/path/runtime/.env \
  --public-url "${PUBLIC_URL}" \
  --check
```

Use the same command without --check to write only CONNECTOR_COLAB_CLIENT_ID and CONNECTOR_COLAB_CLIENT_SECRET. Run as the protected environment file's owner. The helper refuses a Desktop client or wrong callback, preserves unrelated settings, atomically writes mode 0600 and never prints credential values. It does not restart the service.

## Verify a real connection

Tool discovery alone is not proof of authentication: Google permits initialization and
`tools/list` without credentials. After Google consent:

1. Call `get_subscription` with `{}`, `list_runtime_specs`, and `list_runtimes`.
2. Record the actual eligible specs. Reuse a suitable runtime where possible. Otherwise choose
   an eligible CPU spec for the first small check and use a new UUIDv4 `requestId`.
3. Create a separate session for the check. Run `print(1 + 1)` with that `session` and a
   new UUID `executionId`. Confirm that the result is `2`.
4. Save the result and close only the session created for this check. Do not delete another
   person's notebook, session or runtime.
5. Verify the sign-in still works after token refresh before calling the installation ready
   for unattended work.

This sequence is a deployment check, not a test the source test suite performs. Unit tests use
fake providers and an in-memory database, with no live Google account or compute usage.

## Agent job rules

- Use Colab for bounded Python/GPU work. A normal hosted-model API call, a local browser click,
  Xcode signing and native Mac application tests do not become faster simply by adding Colab.
- Check runtime eligibility and reuse an appropriate runtime before creating another. More
  agent sessions do not mean more GPU capacity; sessions on one runtime share its resources.
- Use a separate session per task. Keep the runtime, session, request IDs, code and output location
  in the task's durable record. Each new execution gets a new UUID `executionId`.
- Colab can end an `execute_code` RPC after 600 seconds while its code continues. For
  `DEADLINE_EXCEEDED` or `UNAVAILABLE`, reattach with the **identical** session, execution ID
  and code. Do not turn an uncertain result into a new execution with a new ID.
- After an execution result has returned, replaying that execution ID runs the code again.
  The connector does not automatically retry a code execution or runtime creation.
- The MCP client allows 660 seconds for Colab's `create_runtime` and `execute_code`, so its
  default one-minute timeout does not prematurely send cancellation. Other tools and endpoints
  keep the existing timeout. An explicit cancellation can interrupt the session's kernel.
- Save checkpoints and final outputs outside the runtime. Transfer file bytes with Google's
  documented runtime HTTP file API; do not fill tool calls with base64 files or expose runtime
  proxy tokens in messages.
- Close sessions this task owns when finished. Delete a runtime only when requested, or when
  an owned runtime must be freed to create another and its results have been saved.
- `get_subscription` reports the tier, **not** remaining compute units or an exact credit balance.
  This connector adds no CU meter, automatic purchase, permanent GPU reservation, shared-job
  scheduler or automatic cleanup daemon. Check account usage and runtime availability separately.

Colab runtimes have availability, idle and lifetime limits. The remote endpoint is not a guarantee
of uninterrupted 24/7 execution. If this server runs on a Mac that sleeps, new agent orchestration
stops there even when an already submitted cloud job can continue.

## Rollout and rollback

Keep an existing installation running while building and testing a candidate. Make a normal
backup and retain the previous image before release. Configure the Google application and complete
the authenticated checks above before reporting the connector operational.

No schema migration is introduced. Reverting the candidate image restores the previous connector
code; Colab records can remain in the encrypted store but an older catalog will not offer their
tools. Existing non-Colab connectors and their scopes are unchanged. Revoke Google authorization
only when disconnecting is intended.

## Official references

- [Colab MCP endpoint and tools](https://developers.google.com/colab/api/reference/mcp)
- [Google MCP authentication](https://docs.cloud.google.com/mcp/set-up-authentication-mcp-servers)
- [Enable products for Google MCP](https://docs.cloud.google.com/mcp/enable-disable-mcp-servers)
- [Google OAuth for web applications](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Colab FAQ and runtime limits](https://research.google.com/colaboratory/faq.html)
