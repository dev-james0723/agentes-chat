# Global Model Router operations

## Overview

The Global Model Router (`GLOBAL_MODEL_ROUTER_ENABLED=true` on the server, disabled by default) extends the workspace subscription-first routing contract across native agents, background routines, and the Model Gateway without weakening existing subscription priority or credit continuity boundaries.

## Priority cascade

1. Primary subscriptions (`Claude`, `Codex`, `Grok`, `Gemini` / `Antigravity`). A `95%` window observation is a warning, never exhaustion. Unknown or stale telemetry blocks paid fallback.
2. Included OpenCode Go allowance (`opencode_go`, `Extra Usage` disabled, `$0` incremental spend, official `agentes.chat/<version>` User-Agent and `x-opencode-session` header). Native-only OpenCode free chat models are never called over external HTTP.
3. Qualified Free API pool (`free_api`, `$0` incremental spend): OpenRouter `:free` concrete models (`20 RPM`, `50 RPD`, `allow_fallbacks: false`), GroqCloud Free (`RPM/RPD/TPM/TPD` headers), and Cloudflare Workers AI Free (`10,000 Neurons/day`, `@cf/openai/gpt-oss-*` via non-streaming `/responses`).
4. Low-cost concrete paid models (`paid_low_cost`) under the shared OpenRouter `US$50/month` (`50,000,000,000` nanoUSD) workspace ceiling, enforced atomically across both `openrouter_fallback_months` and `global_router_windows`.
5. Owner-approved Direct APIs (`direct_api`) with dedicated keys and explicit monthly USD caps (`DeepSeek`, `Tencent Hunyuan`, `MiniMax`, `Z.ai GLM`, `Moonshot Kimi`, `Xiaomi MiMo`, `NVIDIA NIM`).
6. Bounded dynamic OpenRouter escalation (`openrouter/auto`, `openrouter/auto-code`) restricted to owner-approved concrete allowlists and upstream `/api/v1/key` limit verification.

## Hard safety invariants

- Qwen, Ollama, `openrouter/free`, and metered Gemini API fallback routes are quarantined and denied at catalog ingestion, policy configuration, ledger reservation, and receipt settlement.
- Every dispatch goes through row-locked `FOR UPDATE` Budget Guardian reservation before outbound HTTP and Quality Guardian output/tool/schema verification before completion.
- Ambiguous mid-stream drops retain their hold (`state = "unknown"`) and pause the lane across monthly rollover (`reconciliation_required`) until a workspace owner reconciles the attempt via `POST /api/app/organizations/{orgId}/global-model-router/reconcile`.
- Returning to a recovered primary subscription starts a fresh session (`resume: false`) from portable completed-turn context so tool side effects are never replayed.
