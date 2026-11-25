# Te Geometry Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Complete the full Geometry coverage gate reliably without accepting partial layout results.

**Architecture:** Reuse the isolated browser lifecycle and synchronous font-load implementation from 9be07fabc (geometry-only files), with host-side bounded readiness and CDP deadlines. A worker owns one disposable pair of tabs and restarts only after a recoverable transport failure, committing each capture's findings atomically once every required width, text size and CSS order succeeds. A finite independent watchdog bounds the entire stage.

**Tech Stack:** Bun, TypeScript, Node.js process supervisor, Chromium CDP.

**Spec:** Exact prior CI receipt te-mcp-223cc86b5.xdFl80: 20/21 steps passed; 8595 captured states, 1699 selected, transport timeout after 100 completed. Prior full test results and baseline are preserved.

## Global constraints

- No reduced capture coverage, altered baseline, skipped rules, skipped failed tests, or fabricated release checks.
- No paid model or external inference; only disposable locally owned Chromium profiles.
- Three attempts per capture, fresh owned browser after a recoverable error, close/reap before reuse.
- Abort or deterministic rule error fails the stage; exhausted retries fail closed, never publish a partial PASS.
- Whole-stage deadline 90 minutes (maximum 120 minutes); request deadline 30 seconds by default.
- Guarded local CI only. New exact-head receipts; independent review and OAuth remain required for production.

## Review focus

- Timeout rejects all pending requests, stale results cannot enter a new browser attempt.
- Failed startup and teardown cannot leak a profile or cause a second browser to run in parallel for the same worker.
- Mid-screen failure discards partial hits and retries the same capture, then counts it once.
- Deterministic JavaScript/layout errors, cancellation, repeated timeouts, and missing coverage are failures.
- Background tab font readiness and text-size state are reset and checked for each screen.
- Hard watchdog exits nonzero after bounded owned-process shutdown; no unrelated Chrome termination.

### Task 1: Browser transport and font readiness

Files: scripts/geometry/browser.ts, check.ts, rules.js, run-bounded.mjs, check.test.ts, package.json.
- [ ] Port geometry-only lifecycle, endpoint discovery, bounded shutdown, synchronous load/font polling, and watchdog from 9be07fabc.
- [ ] Use typed recoverable transport errors, preserve deterministic errors, and make stage limit support the full measured workload.
- [ ] Run all browser anti-stall tests including local socket timeout, disconnect, startup cleanup, cancellation and watchdog.
- [ ] Commit coherent transport changes.

### Task 2: Per-screen recovery

Files: scripts/geometry/recovery.ts, check.ts, check.test.ts.
- [ ] Add a recoverable worker that uses an injected create/close/measure interface. Test retry, exhaustion, cancellation, deterministic errors and cleanup failure.
- [ ] Run measurements per capture, reset text-size state, collect findings locally, and publish them only after all widths succeed. Track completed distinct capture IDs, wait for all workers to finish cleanup, and require exact coverage.
- [ ] Run fault-injected and real-browser focused tests; no baseline edits.
- [ ] Commit changes, verify clean tree and push exact HEAD.

### Task 3: Full local acceptance

- [ ] Retain the capture directory when Geometry fails (including source SHA in receipt) to permit diagnosis without losing artifacts.
- [ ] Run full guarded local CI, retain final exit code and all logs. Verify complete coverage count, no new geometry findings and all stages green.
- [ ] Obtain legitimate independent review, protected merge and production authorization. Reconnect management OAuth, sign in to verified free OpenCode, create only Te and verify real zero-paid inference and full capture pipeline.
