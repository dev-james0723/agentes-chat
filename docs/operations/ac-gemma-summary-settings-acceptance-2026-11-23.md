# AC Gemma Summary Model — Admin UI + Validation Acceptance

Evidence date: 2026-11-23 UTC, separate isolated branch stacked on
feat/ac-agent-skill-exchange-20261122 (PR #82). This work does NOT modify
PR #82 or the running production service until protected integration.

## Problem reproduced

James Engineering OS had a null organization_settings.summary_model and
zero active model credentials after the owner explicitly revoked the
previous local Qwen custom endpoint. The M3 Max has a distinct
Ollama model, gemma3:4b, proven capable of valid JSON-schema output
through OpenAI-compatible /v1/chat/completions. The actual AC Docker
container can reach the existing Ollama server through
host.docker.internal:11434. These direct probes are NOT AC credential
registration or production verification.

The native backend supports verified structured-output custom
models, but EndpointForm did not expose the existing
EndpointModelDraft.structuredOutput control. There was no visible control
in the workspace provider-key panel to select a verified custom model for
organization_settings.summary_model.

## New feature behavior

1. EndpointForm offers an explicit checkbox for structured JSON per
   selected custom model (OFF by default). Saving invokes the existing
   credential/model API, which independently tests schema output. Results
   show both the existing tool-use check and the JSON-schema check.
2. A pure verifiedSummaryModels(credentials) helper only returns
   non-revoked custom endpoint models that have explicit
   structuredOutput=true and server-stored structuredOutputCheck=ok.
   A failed agent Tool Calling test does not disqualify a dedicated JSON
   Summary Model. Neither a host curl response nor a checkbox is proof.
3. In Workspace Settings / AI provider keys, members with existing
   configure authority may explicitly select a passing custom model
   as summaryModel through the native useUpdateSettings mutation.
   The native server's org settings route is still authoritative.
4. The setting does not touch existing agent brains, model fallback,
   default credential, Qwen key, subscription routing, or per-agent model.
5. The UI labels are present in all fourteen runtime locales.

## Validation evidence (M3 Max)

Evidence folder:
~/Documents/Agentes-Handoffs/ac-agent-skill-exchange-20261122/

- gemma-summary-ui-client-i18n-final.log: 30/30, 205 assertions
- gemma-summary-ui-endpoint-regression.log: 30/30, 127 assertions
- gemma-summary-ui-web-tsc-final.log: Web TypeScript exit 0
- gemma-summary-ui-client-tsc-final.log: Client TypeScript exit 0
- gemma-summary-ui-i18n-tsc.log: i18n TypeScript exit 0
- gemma-summary-ui-dom-red.log: UI tests, 6/6 PASS, 38 assertions

The full UI regression, exact committed checks, and protected independent
review must pass before release.

## Production acceptance — NOT YET DONE

1. Pass upstream PR #78 and PR #82 independent/protected review and local
   CI; merge sequentially, then this UI PR.
2. Confirm production backups, migration 0282/0283 and rollback.
3. Authorized owner adds a NEW keyless OpenAI-compatible Gemma endpoint,
   base URL http://host.docker.internal:11434/v1, model gemma3:4b,
   structured-output checkbox ON. Official AC server independently
   returns a completed schema check, not failed or unchecked.
4. Owner clicks verified model's Use for summaries action. Native settings
   readback returns the corresponding custom model, with
   summaryModelReady=true and an actual authorized summary call.
5. Keep the old Qwen credential revoked and fallback settings unchanged.
6. Then apply owner-managed learning toggles; only verified high-trust
   public how-tos with recurrence and completed independent source runs
   may auto-promote. Charlie's original DM How-to is LOW trust and does
   not qualify; do NOT flip trust manually or fabricate a Skill.
7. Verify a NEW official origin=agent Skill ID/version, agent-scoped
   assignment to qualified peers, native consultations, independent
   receiver model runs with successful load_skill, actual application,
   and linked Wiki/Memory/audit receipts.

## Real Gemma edge case reconciled (2026-11-23)
The owner-approved native AC credential was created by legitimate application
flow (ID 1569a1a0-b29b-4cd5-9e8d-378a6a5f8b4a), with a completed,
server-verified JSON schema check recorded as ok but its separate tool-use
check failed because gemma3:4b does not support agent tool calls. The AC
backend distinguishes these checks: its ModelInfo is structured-output
capable after a server schema pass, regardless of a tool-use failure;
summaryModelReady only requires usable credential and verified schema.
Therefore the selector now intentionally includes an endpoint with
structuredOutputCheck=ok even when check=failed. A dedicated summary
model never becomes an agent tool-calling model by this selection.
Source note: official production summary_model still null. No raw DB write,
no override of revoked Qwen key, and no claimed production activation.
