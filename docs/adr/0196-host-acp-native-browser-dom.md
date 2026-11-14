# Host ACP native browser DOM tools

Status: Proposed; source integration only. Extends ADR 0040, ADR 0110 and the native result/continuation contract.

The owner-bound host ACP adapter filters its native tool catalogue by an explicit qualified name set. Machine browser availability and an agent's browser grant do not make a name absent from that set callable. Reuse the existing native browser path rather than exposing a second browser controller or raw browser CLI.

## Qualified operations

Add these native browser names: `browser_open`, `browser_back`, `browser_tabs`, `browser_read`, `browser_click`, `browser_fill`, `browser_select`, `browser_check`, `browser_press`, `browser_scroll`, `browser_wait`, `browser_ask_person`, `browser_close`, and `browser_profile`.

Add `get_my_profile` for fixed-context introspection and `create_artifact` for saving the resulting deliverable. The existing Tool Gateway still determines whether each name is offered and rechecks its exact native schema, agent/run/machine context, current grants, original requester and approvals on every call. An allowlist entry grants no permission. Artifact creation keeps the run's native conversation audience; introspection grants no authority and cannot target another agent.

Do not add browser batch, file upload, secret typing/password creation, screenshots, desktop or phone control in this slice. `browser_do` includes a secret-typing verb, so qualifying its name would also qualify operations beyond this DOM slice. Connector directories, generic tool execution and other application feature families require separate qualification.

## Observations and effects

`browser_read` and `get_my_profile` are repeat-safe observations. `browser_tabs` is repeat-safe only when its action is `list`. Opening, switching and closing tabs remain effects, as do navigation, interaction, waits, profile changes and artifact creation.

Keep the existing duplicate effect key and authenticated history fences. There is no native browser page-generation epoch in that key: an identical click/ref on a later page, or reopening the same URL in one run, can remain held. A new read, URL supplied by the model, call ID or phase label cannot authorize replay. Arbitrary repeated browser flows are not qualified by this source slice. Unknown delivery still stops the model loop for native reconciliation.

## Partial text and transient media

Add an optional, server-owned `ToolOutput.resultTruncated` observation flag. It is not model input, an authorization field or a new database column. The Tool Gateway marks its own cap and preserves an existing true flag. The bridge and mission MCP mapper carry it through to the existing protocol-67 result field with OR semantics. A native known-error or rejected-media branch must not reset that flag.

Browser page reports are bounded observations or differences; the runner caps output and a page read, selector or search is not complete rendered HTML. Conservatively mark browser page readouts and action reports as partial. A specific DOM fact may still be checked against the returned text, but no full-page or visual-inspection claim follows. Complete-only clients get a completed, non-replayable refusal for a native partial result rather than a false `complete` acknowledgement.

First delivery of validated native media remains unchanged. The text ACP loop labels omitted nontext content as not inspected. Tool images and live browser frames are not durable pixels in run steps; a repeated completed call whose transient media was lost still returns `completed_media_unavailable`. Do not reexecute an effect to reconstruct that media. No machine protocol version or authority boundary changes.

## Profiles and people

Own native browser sessions retain per-agent isolation and per-session serial command queues. Different agents can progress independently within the computer's existing admission and session capacity. A shared browser profile intentionally has one holder at a time, with fresh grants and native waiting/revocation behavior. No profiles, grants or capacity settings are created or changed here.

Native person handoff keeps the original run waiting and requires a new page read after handback. Account login, CAPTCHA and owner-controlled steps continue through that existing handoff. Personal browser authentication is not copied or read.

## Research and verification

The existing native implementation uses [agent-browser v0.39.1](https://github.com/vercel-labs/agent-browser/tree/1165952d74ceed98fdc2dd97190ad41f44dd0e24), whose transport distinguishes unknown mutating outcomes, under the app's own scopes, profiles and handoff. [Playwright MCP v0.0.85](https://github.com/microsoft/playwright-mcp/tree/4e0794dd0a0176519830a5ed27b491137cf9338f) is an alternative profile-isolation pattern, but introducing another server would require another native ownership and policy integration. No dependency or browser version changes are included. Existing notices and licenses remain in force.

Connected tests cover the real structured intent, native MCP socket/frame, run identity, Tool Gateway and browser source with synthetic machine DOM replies. They cover independent agent contexts, shared-profile serialization, handoff, profile introspection, artifact audience, partial/oversized text, known errors, rejected media and unknown-effect fences. Existing result/continuation, browser/profile/handoff and native bridge regressions remain required.

These are source and isolated-fixture results. Installed server/runner pairing, exact selected model/account evidence, two actual concurrent native browsers, human handoff, per-agent runtime qualification and durable visual/design acceptance remain separate, unperformed gates.
