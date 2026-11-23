# AC OpenRouter global fallback — implementation checkpoint
Date: 2026-11-23
Base: subscription credit continuity release candidate 88d62c68b.
Status: provider and pure routing-decision components implemented and locally tested; not an end-to-end rollout.

## Product requirements and decisions
- OR1: All authorized agents and routine executions inherit an organization-level opt-in, with an agent-level opt-out and existing personal, mission and lent-account restrictions preserved.
- OR2: Exhaust compatible subscription routes first, including the verified available Grok/Codex/Claude/Gemini routes. Unknown telemetry does not constitute exhaustion. General tasks use openrouter/auto, engineering tasks use openrouter/auto-code.
- OR3: Use a dedicated, encrypted, pinned OpenRouter credential. Require a positive owner-selected monthly spending cap, upstream monthly key limit including BYOK, explicit concrete model allowlist, per-token ceilings, and AC transactional cross-agent reservations. Do not silently spend first-party API grants or use Qwen/Ollama.
- OR4: Resume only from a proven safe portable turn checkpoint with no pending or uncertain tool effects. Maintain existing permissions, durable work receipts and cancellation. Return to a fresh qualified subscription session at a safe boundary after recovery, not the stale original session.
- OR5: Record requested router, actual model, usage and actual cost separately. Missing receipts retain unresolved spend holds; no automatic retry after an ambiguous dispatch. User-visible settings show enabled/disabled/blocked, credential status, cap, costs, and last fallback reason. No credentials in logs or UI responses.
- OR6: Default disabled. No paid test, setting activation or release until all relevant authority and verification gates are satisfied.

## Implemented in this candidate
- packages/providers/src/openrouter-auto.ts: bounded request policy, supported stable router IDs, concrete allowlist, privacy/price restrictions, upstream key limit verification.
- packages/providers/src/openrouter.ts: validated Auto/Auto Code request path, read-only key preflight, fail closed before inference, no SDK retries for routed requests, existing concrete response-model and cost parsing.
- packages/engine/src/openrouter-fallback-policy.ts: deterministic eligibility decision, rejecting unknown or available subscription routes, unsafe checkpoints, unauthorized scope and missing key or routing policy. This function selects a candidate only and does not authorize a charge.
- Tests: all provider tests and new decision tests passed (256 total, 0 failed); both provider and engine typechecks passed; touched-file Biome and git diff checks passed. All network responses in new tests are synthetic.
- No model-catalog change yet: the original dynamic alias exclusion remains a deliberate fail-closed boundary.

## Remaining implementation and acceptance plan
1. Reconcile the candidate with the authoritative current AC release and existing PR/CI owners; never merge or edit active unrelated worktrees. Integrate a versioned org fallback policy in organization settings, explicit owner authorization, encrypted credential binding and budget cap. Add API/UI configuration to the existing Model Inspector/Keys screens. No secret in URLs/logs. Owner can disable instantly.
2. Implement organization-wide transactional reservations, credential fingerprint/version binding, monthly rollover, exact allowed candidate/pricing evidence, cap enforcement on every turn, ambiguous-cost retention, cancellation, concurrent-run and multi-replica tests. Use upstream GET /key limit as additional defense. Existing shared-budget transport has no production-qualified OpenRouter adapter and requires exact returned model identity; do not weaken ordinary exact-model contracts. Dynamic result must be validated against the approved concrete candidate set and settled against actual charge. Do not treat dynamic aliases as free or put per-org prices into global model catalog.
3. Wire the existing executor's post-subscription qualification boundary (packages/engine/src/executor.ts, subscriptionsConsidered and safe handoff path) to the decision module and new dedicated gateway admission. Preserve separate first-party grant continuity and existing personal/mission authority. Persist the exact route and native claim with portable context, requalify after resumption, prevent duplicate effects and return safely to subscription. Routine paths must execute through the same admission, not mutate every agent's permanent model.
4. Verify actual run and routine integration on mocks: available subscription wins; confirmed exhaustion selects correct router; unknown telemetry, unauthorized context, key and budget refusal issue zero inference; concurrent reservations cannot exceed cap; actual resolved model and cost recorded; unclear billing retains hold; no duplicated tools; restored subscription returns safely. Check actual web settings path and accessibility.
5. Run guarded local CI at exact candidate HEAD (not GitHub Actions), independent review and repair; follow protected merge/release gates. Only after owner supplies a dedicated capped key through AC and a cap, perform an authorized bounded real API canary and verify production fleet/routine receipt. No production completion claim before this.

## Sources checked 2026-11-23
- https://openrouter.ai/blog/auto-and-auto-code-routers/
- https://openrouter.ai/openrouter/auto-code
- https://openrouter.ai/openrouter/auto
- https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key
- https://openrouter.ai/docs/api/api-reference/api-keys/create-keys
- https://openrouter.ai/blog/tutorials/how-to-get-the-lowest-cost-llm-inference-on-openrouter/
- https://openrouter.ai/blog/tutorials/ai-agent-infinite-loop/
