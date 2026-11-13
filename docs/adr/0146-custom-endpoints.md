# 0146. A workspace's own model endpoint ("Outro provedor")

- Status: Accepted (built)
- Date: 2026-11-04
- Extends: ADR 0007 (provider keys sealed per org), 0012 (budget reservations), 0087 (OpenRouter's Chat Completions adapter)
- Code: providers `custom.ts` (`createCustomProvider`, `listEndpointModels`, `parseEndpointModels`), `catalog.ts` (`custom` in `PROVIDERS`, `customModelId`, `parseCustomModel`, `setCustomModels`, `customModelOf`, `ModelInfo.unpriced` and `endpoint`), `openrouter.ts` (`compatible`), `types.ts` (`StreamOptions.endpoint`); engine `endpoints.ts` (`endpointAddress`, `cleanEndpointModels`, `loadEndpointModels`, `listEndpoint`, `checkEndpoint`, `updateEndpointModels`, `allowsPrivateEndpoints`, `endpointOrgsOf`, `pickerEndpoint`), `credentials.ts` (`createCredential` with `endpoint`, `modelInfoFor` and `pickerModels` by organization), `gateway.ts` (the model's own credential, `OrgCall.tools`), `agents.ts`; db `schema/agents.ts` (`StoredEndpoint` in `provider_credentials.options`, no migration); config `MODEL_ENDPOINTS_PRIVATE`; server `routes/app/agents.ts` (`POST …/credentials` with `endpoint` and `checks`, `POST …/credentials/endpoint-models`, `PUT …/credentials/{id}/models`, endpoint models on `GET /models`), `credential-view.ts`, `management.ts`, `start.ts`; client `lib/endpoints.ts`, `lib/providers.ts` (`modelChoices` by endpoint); web `components/ai/EndpointForm.tsx`, `ConnectAiSteps.tsx` (`KeyPanel`), `ConnectAi.tsx`, `pages/SettingsPage.tsx`, `pages/agent/SettingsTab.tsx`; phone `features/ai/EndpointForm.tsx`, `ConnectAiSteps.tsx`, `features/agents/AgentProfileScreen.tsx`

## Context

A workspace uses gateways that speak OpenAI's or Anthropic's API at another address (OpenGateway, LiteLLM) and model APIs the catalog doesn't carry. Self-hosters run their own models next to the server (Ollama, vLLM, LM Studio). Each catalog provider is a code change (a `PROVIDERS` entry and prices); these are addresses an admin types.

## Decision

### 1. An endpoint is a credential of provider `custom`

"Outro provedor (compatível com OpenAI ou Claude)" under Chave de API (Connect AI and Settings › Chaves de IA) adds a `provider_credentials` row of provider `custom`. Its key is sealed like every provider key (envelope encryption, never returned, ADR 0007); a server that takes no key gets the word `none`, which the SDKs require, and the row shows no key hint. Its `options.endpoint` holds what isn't secret: the API style (`openai`: Chat Completions, `anthropic`: Messages), the base address as that API's SDK takes it (`…/v1`, `…/anthropic`; a pasted `/chat/completions` or `/v1/messages` is left out), and the chosen models, each with optional prices and its last test. Only `manage_credentials` adds, lists or changes one. The JSON column already exists, so no migration.

Extra headers were left out: the key goes as each API sends it (`Authorization: Bearer`, `x-api-key`). A header-only gateway is the case to add them for, sealed like the key.

### 2. Models: listed, chosen, tested

Before saving, `POST …/credentials/endpoint-models` reads the endpoint's list with the key, which isn't stored (`GET {base}/models`, or `{base}/v1/models` for Anthropic's; `{ data: [{ id }] }` or Ollama's `{ models }`, ten seconds, 2 MB, at most 500 ids that look like one). When there is no list the reason shows and the admin types ids. At most 30 models are kept.

Saving runs one call per model through the Model Gateway (`kind = summary`, so tokens and cost are recorded with `org_id`), asking it to call a `report_status` tool: `ok` when it calls it, `no_tools` when it only answers (agents work through tools, so the admin is told), `failed` with the server's words (masked like every provider error). `PUT …/credentials/{id}/models` changes the models and prices and tests them again; each model keeps its last result.

### 3. Model ids carry their credential

An endpoint's model is `custom:<credentialId>:<model>`. The credential in the id keeps two workspaces' models apart, and a gateway's `claude-sonnet-5-5` from the catalog's (it is never priced at the catalog's prices: the adapter answers with the full id). The gateway takes the key named in the id, whatever the agent's key setting, and decrypts it org-scoped, so another workspace's id finds nothing. The models live in memory per organization (`setCustomModels`), refreshed from the rows read like other credential rows (30 s cache, dropped on any key change), so synchronous lookups (`modelInfo`, context windows, cost) work everywhere; `modelInfoFor` and the pickers ask by organization. `GET /models` adds the models of the signed-in person's workspaces with `endpoint: { credentialId, name }`; the pickers group them under the endpoint's name and show only the current workspace's. By default they cannot be selected for routing, the judge or summaries (`structuredOutput: false`); the explicit verified opt-in below may enable schema use. They remain outside Automático's tiers.

### 4. Calls reuse the catalog's adapters

`createCustomProvider` is registered once as `custom` and each call names its endpoint (`StreamOptions.endpoint`): Anthropic's adapter in its compatible mode (text only, no top-level caching, no fallbacks, structured output as a tool), or the Chat Completions adapter OpenRouter uses in a `compatible` mode (the endpoint's address, no OpenRouter attribution, routing, reasoning or cache markers, `stream_options.include_usage`, the server's error words kept, a cost it reports ignored). No new SDK.

### 5. Prices and budgets

Prices are optional, per model, in US$ per million tokens (input and output; cache read and write default to the input's). With prices, calls are reserved and recorded like any other. Without, the model is `unpriced`: its calls cost 0 and are recorded with their tokens, so its reservation is 0 and money never limits it. Budget checks still run on known costs: an agent whose budget priced calls used up stops on an unpriced model too. The agent's budget (web and phone) says its model has no price, so the budget can't count what it spends.

### 6. Where it may connect

On agentes.chat Cloud the address must be https and every address its host resolves to public (`assertPublicHttpsUrl` when saved or listed), and every call goes through `publicHttpsFetch` (the guarded fetch, checked again at connect time, pinned to the checked address so DNS rebinding can't move it, no redirects). A self-hosted server allows private addresses and http by default, for an Ollama next to it; `MODEL_ENDPOINTS_PRIVATE` sets it either way (unset: allowed except on the Cloud and with `ALLOW_SIGNUP=true`, where strangers' workspaces would reach the server's network). The SDKs' timeouts stop at the response's headers and a server may ignore the output cap, so each exchange with an endpoint is bounded on its own (`boundedFetch`): 20 minutes and 32 MB, the streamed body included. An endpoint model removed while a call runs keeps its prices in memory for that call's cost (`modelInfo`), while only the workspace's current models may be called (`customModelOf`).

## Consequences

- A workspace with only an endpoint has no model for routing, the judge or summaries by default: those need a model that follows a JSON schema. An admin may enable the verified capability described below.
- Telemetry counts endpoint models as `other`; their names never leave the server.

## 2026-11-13 amendment: explicit, checked structured output

An admin may submit `structuredOutput: true` for an individual endpoint model through the existing credential create/update-models API. Absent means off for existing credentials; an update that omits the field preserves the previous choice. No URL, provider name, model name or successful tool check enables it automatically. `structuredOutputCheck` is server-owned and ignored on input.

For an opted-in model, the normal endpoint check adds one separate schema call through the existing gateway and compatible adapter, with 256 output tokens and a 60-second deadline. It requests a nested object with fixed literal values, validates the complete response with the existing Zod dependency, rejects extra properties and incomplete/refused responses, and persists `ok` or `failed`. Both calls retain ordinary usage recording and budget handling. A successful fixture verifies that response, not every JSON schema or the model's factual accuracy.

Only an opted-in model with a passing check is available for explicit summary/router selection. Opting out removes the check, and a failed recheck disables the capability. Summary resolution rechecks current capability so a previously selected model cannot keep reflection ready after opt-out, removal or a failed check. A slow check preserves newer model configuration and cannot undo an opt-out. The capability does not add models to Automatic's tiers or choose a summary model, and changes no reflection limits, budgets or workspace flags.

Verification is bound to an internal configuration generation and the latest check attempt. Model edits and supported credential/key rotation create a fresh configuration generation and clear schema verification. Starting a check reserves a fresh attempt under the credential row lock and clears earlier readiness. Only a result matching both current values can complete verification, so an older pass cannot supersede a newer failure even when the configuration is otherwise identical, nor survive an opt-out/re-opt-in cycle. Rotation and model-update writes use the current locked row so neither restores stale endpoint metadata. Internal generations are not included in credential API metadata; old check records without them remain unverified until checked again. These fields are additive JSON metadata and need no migration.

The existing OpenAI-compatible adapter already sends `response_format: { type: "json_schema", json_schema: { name: "output", strict: true, schema } }`; no new provider, dependency or migration is needed. The existing form preserves the choice when editing prices; this amendment exposes opt-in through the admin API, without adding a UI control.

Research on 2026-11-13: [Ollama's local OpenAI-compatible API](https://docs.ollama.com/api/openai-compatibility) supports `response_format`; its [structured-output guide](https://docs.ollama.com/capabilities/structured-outputs) distinguishes schema output from plain JSON and excludes cloud support. Compared [Ollama](https://github.com/ollama/ollama/tree/5632619189ab493c70bd3f9435214b8788cc1c80) (MIT, recent v0.40.16 release) and [llama.cpp](https://github.com/ggml-org/llama.cpp/tree/ded522f8304554317e7ff8f88698dbbbca5425aa) (MIT, recent v1.0.0 release). Reuse the installed Ollama route and existing SDK: replacing the runtime would add operational and compatibility burden without addressing the application's capability gate. No upstream source or new transitive dependencies were copied or adopted. The installed Ollama 0.40.13 and existing `qwen3-coder:30b` passed two bounded local adapter probes: the nested fixture, then the exact native reflection schema and parser on a public synthetic transcript. This is local compatibility evidence; deployed admin activation, background reflection, memory/outcome quality and end-to-end acceptance remain separate gates.
