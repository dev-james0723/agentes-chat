# Shared judgment integrity

The existing `Judge`, `callJev`, router, usage gateway and delegation tool remain the only execution path. No model, key store, dependency, registry or scheduler is added.

The provider boundary checks every required answer before policy consumes it. Missing answers, mismatched types, nonfinite/out-of-range numbers, invalid boxes, foreign choices and foreign probability keys are unknown evidence. They raise `InvalidJudgeAnswerError` instead of becoming zero. Genuine numeric zero remains valid. Probabilities and confidence are checked when supplied; this does not establish calibration.

Malformed responses do not start a paid fallback. The shared fallback wrapper propagates that error; the router ends its model chain and leaves its existing deterministic policy to handle the unavailable judgment. Calibrated-only requests still prohibit the LLM fallback for all failures. Existing noncalibrated transport-error fallback behavior is retained; this change does not certify its privacy or spending policy for new decision classes.

The memory permission-text guards propagate malformed-answer errors instead of turning them into false. Their existing transport-outage behavior is retained and must be separately reviewed; this patch does not claim that every caller treats every kind of uncertainty uniformly.

One call deadline covers receiving the response body as well as headers. There are no new retries. Existing key state, rate-limit backoff and circuit-breaking remain in use, including observed Retry-After when a body stalls.

External usage records use the existing `requested_model` and `partial` columns. The requested alias and response-resolved model are distinct. Absent or invalid counters/model mark the row partial. Required numeric storage still uses zero placeholders for absent counters; they must not be interpreted as observed zero usage. Existing historical rows cannot be repaired from the resolved model alone. Aggregate cost screens are not retroactively made complete by this change.

`judgmentReceiptOf(answers)` exposes non-enumerable local metadata: input/question digests, decision kind, requested/resolved model, usage row reference, telemetry completeness and elapsed time. Raw state and credentials are excluded. `chooseDelegate` includes this evidence in its existing structured tool result, including invalid-output evidence when available. It records candidate IDs and explicitly states that approval was not evaluated, capacity was not reserved and dispatch was not requested. Current MCP text formatting is unchanged; structured evidence is not proof that every model-facing surface displays the receipt.

Receipts are observations, never permission grants, capability proofs, cache validity, resource reservations or verified product outcomes. Model aliases, ACL/capability/skill versions, privacy, cache invalidation and execution-time checks still require a separately reviewed adapter. No new persistent judgment cache is introduced before those versions are available.

Rollout: review the exact source patch and its tests, preserve existing overlays, then obtain the normal shared-runtime deployment approval. There is no deployment or routine activation in this source change. Rollback is a source revert and a separately approved image replacement. Reverting must not overwrite sibling source or runtime changes.

Focused checks cover malformed outputs, genuine zero, alias accounting, accounting failure, calibrated-only and malformed-output fallback, stalled response bodies, delegation receipts and native revocation. Existing candidate-level tests cover audience/readiness filtering, duplicate routine delivery and keyed execution isolation. They do not qualify a live scheduler, provider slot limits, semantic quality or cost savings. Semantic evaluation, shadow recommendations and a live canary remain separate gates.
