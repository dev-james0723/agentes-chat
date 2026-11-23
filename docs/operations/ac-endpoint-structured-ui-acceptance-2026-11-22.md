# AC Custom Endpoint Structured JSON Output UI — native acceptance

## Isolated implementation
The existing AC server and model gateway support per-endpoint-model
structuredOutput and structuredOutputCheck, but the existing web
EndpointForm offered no admin control to opt in and did not display
the structured-schema verification result. The client model mapper
already preserved structuredOutput when supplied.

This change adds a per-model Structured JSON Output checkbox, default
OFF, backed by the exact official addCredential payload, and displays
the independently returned schema check. Only actual check=ok displays
verified; check=failed shows a sanitized failure; no schema result
displays not verified. Layout and 14 languages are included.

A React native integration test first failed due to missing checkbox,
then passed on the new code. Another test deliberately returned an
endpoint-tool check ok but structured-output check failed and asserts
the UI does not claim verification. Existing keyboard/disabled-state
form tests continue to run. More exact receipts live on M3 Max at
Documents/Agentes-Handoffs/ac-agent-skill-exchange-20261122.

## Operational scope and limits
The Mac Ollama gemma3:4b model already passed local and Docker-to-host
JSON-schema preflights via OpenAI-compatible endpoint at
http://host.docker.internal:11434/v1. This is not official AC model
credential registration or gateway verification.
The November 22 explicit revoked Qwen credential remains untouched.
Actual new endpoint creation, validation and organization Summary Model
selection require an authenticated manager via the official AC
settings flow after the UI release.
Existing low-trust/private Charlie how-to data cannot automatically be
made high-trust by selecting a Summary Model. The production auto
promotion and global sharing gates remain unresolved until a protected
PR78 -> PR82 -> this UI branch integration, independent review, exact
local CI, migrations 0282/0283 and real authorized, high-trust evidence.
No production DB writes, credential changes, deployment, broad access
grant or GitHub branch bypass were performed by this UI change.
