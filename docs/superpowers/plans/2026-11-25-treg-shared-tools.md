# TREG Shared Tools Implementation Plan

> **For agentic workers:** Use native implementation with independent review. Steps use checkbox syntax.

**Goal:** Connect TREG to the existing shared MCP path with scoped access, bounded calls and verifiable receipts.
**Architecture:** Reuse the connector source, encrypted credentials and Tool Gateway. Keep vendor policy in one focused module; all routine and interactive runs use the same code.
**Tech Stack:** Bun, TypeScript, existing MCP SDK, Hono/Drizzle; fake MCP and PGlite tests.
**Spec:** docs/superpowers/specs/2026-11-25-treg-shared-tools.md

## Global Constraints

- Local CI only; no GitHub Actions or new production dependencies.
- Keep credentials server-side and preserve existing organizations, scopes and model routing.
- One integration writer; independent read-only reviewer.
- Native task binding and live account access remain separately verified gates.
- Default TREG charge ceiling is zero; upstream BYOK costs remain separate.

## Review Focus

- Mixed-case duplicate headers must not replace backend cost/auth/attribution controls.
- Changing endpoint, team, agent or native tool-call identity must not reuse an unrelated idempotency key.
- A routine with broad tool scopes must not manufacture an approved paid call.
- Missing, negative, nonnumeric or reserved cost metadata must not be described as settled zero cost.
- Failed or timed-out dynamic calls must not be automatically redispatched.

---

### Task 1: Vendor policy and preset

**Files:** Create packages/engine/src/connectors/treg.ts and packages/engine/test/treg-mcp.test.ts; modify connectors/presets.ts using the existing generic connector glyph.
**Consumes:** ToolContext orgId/agentId/runId/toolUseId/approved and the existing MCP connection URL.
**Produces:** isTregMcpEndpoint, tregReadTool, tregExecutor, prepareTregCall, tregReceipt.

- [x] Add failing tests for exact URL matching, preset discovery, attribution and bounded invocation.
- [x] Implement the focused policy and preset with the generic connector glyph.
- [x] Run bun test packages/engine/test/treg-mcp.test.ts and inspect actual executed-test count.

### Task 2: Shared runtime wiring

**Files:** Modify packages/engine/src/connectors/mcp.ts and custom.ts; add treg-media.ts and treg-connector.test.ts; extend treg-mcp.test.ts.
**Consumes:** Vendor policy from Task 1, existing connectionHeaders and classifiedTools.
**Produces:** TREG-aware ToolDefinitions and metadata-bearing ToolOutputs for every native run family.

- [x] Add fake-MCP tests covering scopes, routine parity, dispatch arguments, metadata and unknown outcomes.
- [x] Apply authoritative tool classification; inject backend headers without bypassing connection auth refresh.
- [x] Preserve structured MCP results and record only normalized receipt metadata in native run evidence.
- [x] Run focused TREG, custom MCP, preset and MCP-result regressions; typecheck/lint changed paths.
- [x] Obtain independent review; repair concrete failures and rerun affected checks.

### Task 3: Rollout and acceptance

**Files:** Add docs/operations/treg-shared-tools.md and the feature ADR; keep private runtime receipts outside tracked public files.
**Consumes:** Current verified source and actual authenticated native AC/TREG access.
**Produces:** Source delivery and an evidence-backed per-workspace activation result.

- [ ] Reconcile existing native task/account/connection inventory; never create duplicate queues.
- [ ] Use supported native admin APIs/UI to connect each intended workspace and add scoped agent access.
- [ ] Verify existing agents, future-agent defaults and routine contexts independently.
- [ ] Run authenticated catalog reads and one explicitly authorized real tool call.
- [ ] Commit/push reviewed source through the existing local CI/release contract.
- [ ] Verify deployed commit and the live user path, or record the precise unresolved gate.

Owner has requested implementation now; proceed within the authorized task without a separate plan approval round.

## Source validation observed

- Focused TREG suite: 19 tests passed, 118 expectations, including actual native approval and media retention.
- Existing connector regression: 69 of 70 passed initially; the one 5-second timeout passed when run alone. No behavioral assertion failed.
- Engine typecheck and diff whitespace check passed. Full local CI remains a separate release gate.
- Independent read-only review identified two defects (lost audio and failure status); both were repaired and re-reviewed with no remaining must-fix findings.
- Actual account activation and current/future-agent grants remain unverified; source delivery is not all-agent rollout.
