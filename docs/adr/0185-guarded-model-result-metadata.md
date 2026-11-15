# 0185: Keep full model results through execution guards

Status: Proposed

## Context

The built-in model brain keeps its completed gateway result in `ModelBrain.last`. The executor reads that result for its stop reason, complete content, usage record, cost, answering model, thinking and media flags. Neutral brain events carry only part of it.

The project routine guard returns a plain brain object. A native background routine that uses the API model must pass that guard even when it has no project mapping. Testing the wrapper itself with `instanceof ModelBrain` loses access to the full result. A refusal became a successful end, truncation became `end_turn`, and persisted activity omitted attribution and provider metadata. The ordinary foreground fast path avoids this wrapper, but uncertain origins and background work retain it.

## Decision

Keep a private weak association in the executor from each created guard wrapper to its original brain. Both initial creation and a later API fallback use the same creation function. After the guarded event stream completes successfully, the result reader looks up the original brain and uses its completed `last` result if it is a `ModelBrain`. Other brains keep their existing event-based result reconstruction.

The association is for reading results only. The wrapper remains the sole execution path. No original brain is executed through this lookup, and no authority result is cached. A guard rejection still throws before result extraction, so it cannot surface a previous successful result. Weak keys follow the wrapper's lifetime without a tombstone or cleanup job. There is no new SQL, public brain interface, prototype change, proxy, schema or dependency.

## Local patterns and verification

This focused repair reuses two established local patterns: `ModelBrain.last` is already the executor's full gateway result source, and `tools/directory.ts` uses a private `WeakMap` to associate wrapper objects with metadata. No external implementation or new dependency is needed.

Executor fixtures use native routine Run Now, persisted background runs, the real model gateway and fake providers. They reproduce refusal and metadata loss before the repair. Further cases cover a guarded API fallback, uncertain foreground truncation/media flags, and fresh attribution across successive guarded turns. Existing tests retain the original foreground query budgets, background/no-fallback behavior, provider retry behavior, malformed-origin lookup, project API rejection, feature-off refusal, pinned routes, revocation and no-replay fences.

The change does not broaden project permissions or change exception/retry classification. Synthetic source tests do not establish real provider, installed runner, PostgreSQL concurrency or production acceptance. Reverting this source-only association requires no data migration and restores the prior metadata-loss behavior.
