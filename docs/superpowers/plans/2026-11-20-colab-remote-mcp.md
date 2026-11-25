# Google Colab Remote MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the existing workspace's agents run bounded Colab jobs through authenticated remote MCP and reuse a task playbook.

**Architecture:** Reuse fixed OAuth, encrypted token storage, the MCP client and tool gateway. Overlay the reviewed changes onto the immutable current live image, preserving deployed code and web assets. Install guidance through the existing skill service without resetting permissions.

**Tech Stack:** Existing Bun, TypeScript, Hono, Drizzle/PostgreSQL, MCP SDK and Docker; Google Colab remote MCP; no new dependency.

**Spec:** [docs/colab-remote-mcp-spec.md](../../colab-remote-mcp-spec.md), [PRD](../../colab-remote-mcp-prd.md), [ADR 0200](../../adr/0200-colab-remote-mcp.md).

## Global Constraints

- Use only https://colaboratory.googleapis.com/mcp for the built-in Colab connector.
- Request only https://www.googleapis.com/auth/colaboratory for this connector.
- Store CONNECTOR_COLAB_CLIENT_ID and CONNECTOR_COLAB_CLIENT_SECRET only in protected server configuration.
- Preserve existing models, credentials, grants, approvals, enabled skills and non-Colab connectors.
- Add no package dependency, database migration, scheduler or automatic purchase.
- Use 660000 ms only for create_runtime and execute_code on the exact official Colab endpoint.
- Dispatch each MCP call once; do not automatically replay an uncertain execution.
- Do not claim authenticated operation before a real tool call and token-refresh check succeed.

## Review Focus

- Public initialization/discovery must not create a signed-in connection: run the pasted-URL and missing-client tests in Task 1.
- Runtime reads expose write-capable tokens: run the get_runtime/list_runtimes read-grant exclusion test in Task 1.
- The UI must describe OAuth-only and unconfigured states correctly: run focused component tests and inspect those states in Tasks 1 and 3.
- Long requests and restart ambiguity must not cancel early or replay effects: run the 70-second smoke check and inspect persisted execution IDs in Tasks 2–4.
- Live overlays and existing settings must survive: compare source/image differences and agent access/skills before and after Tasks 2 and 4.

---

## Baseline and ownership

Core connector source predates this consolidation plan in commit 4001d41374c0ca612a91e7ab5d7d35ddebae637b. Checked items mean reviewed source or written documentation, not completed Google sign-in or deployment.

The implementation worker owns code, focused tests, credential-import helper and derived image. The reviewer owns these documents and read-only verification. The coordinating worker owns account handoff, protected configuration, live deployment and application setup. Work remains in the isolated candidate worktree.

## File structure

- Existing implementation and helper interfaces: engineering specification's file table.
- Create docs/colab-remote-mcp-prd.md: outcome and acceptance.
- Create docs/colab-remote-mcp-spec.md: interfaces and release checks.
- Create docs/colab-job-playbook.md: reusable task guidance.
- Create docs/superpowers/plans/2026-11-20-colab-remote-mcp.md: tracked execution plan.
- Modify docs/colab-remote-mcp.md: related links and verified setup details.
- Narrow UI change: apps/web/src/components/ConnectorCatalog.tsx, required locale entries and focused existing component tests.
- Credential helper: scripts/colab/import-google-oauth.mjs and its focused fixture tests, owned by the implementation worker.
- Private deployment receipts/configuration stay outside tracked source.

### Task 1: Verify connector, UI and credential import

**Files:**
- Review packages/config/src/{schema,connectors}.ts.
- Review packages/engine/src/connectors/{colab,catalog,connections,custom,mcp}.ts.
- Test packages/config/src/colab.test.ts and packages/engine/test/colab-mcp.test.ts.
- Modify/test the narrow ConnectorCatalog UI files.
- Create/test scripts/colab/import-google-oauth.mjs.

**Interfaces:**
- Consumes existing ConnectorDefinition, ConnectorDeps, McpSession and OAuth state/refresh store.
- Produces isColabMcpEndpoint(value: string): boolean; colabCallTimeoutMs(serverUrl: string | undefined, tool: string): number | undefined; colabToolGuidance(tool: string): string.
- Produces catalog ID colab and scopes colab:read, colab:run, colab:delete.
- Import helper consumes a downloaded Google Web-client JSON and protected environment path; it validates the callback against PUBLIC_URL and changes only the Colab client pair.

- [x] **Step 1: Review the core connector against the specification.** Check exact endpoint/scope, offline consent, encrypted refresh, public URL routing and one-dispatch behavior.

- [x] **Step 2: Review credential-bearing runtime reads.** Confirm get_runtime/list_runtimes require colab:run and delete_runtime is sensitive. The fixture's read grant must expose only get_subscription/list_runtime_specs.

- [ ] **Step 3: Run the isolated connector tests.**

```bash
bun test packages/config/src/colab.test.ts packages/engine/test/colab-mcp.test.ts
```

Expected: selected tests pass, including missing client, missing refresh, wrong scope, refresh reuse, public routing, read exclusion and the 660000-ms single-dispatch assertion. No live account/database is contacted.

- [ ] **Step 4: Add focused UI regressions before the UI change.** An OAuth-only connector must never be labelled API key or OAuth-or-key. An unconfigured fixed OAuth app must say configuration is required rather than Coming soon. Preserve the genuine future-service Coming soon state. Run the exact focused component test and confirm the new assertions fail before applying the fix.

- [ ] **Step 5: Apply the smallest UI fix and rerun the component tests.** Use existing design components and locale patterns. Expected: all new assertions pass and existing mixed/API-key connector cases remain correct.

- [ ] **Step 6: Validate the import helper using fixtures only.** Confirm invalid client type/callback is refused before environment mutation; a valid Web client updates only the two Colab values; secret values never appear in output; unrelated values remain byte-equivalent where intended. Record exact command and result.

- [ ] **Step 7: Record required static checks.** Run relevant project lint, typecheck and boundary checks in the isolated environment. Record exact command/exit status and distinguish pre-existing failures. Fix concrete regressions with focused tests; avoid unrelated refactoring.

### Task 2: Prepare and release a preserved live image

**Files:**
- Read current deployment configuration and immutable image identity.
- Read apps/server/src/start.ts and packages/engine/src/{cancel,recovery}.ts.
- Create private backup, image manifest and release receipt outside tracked source.

**Interfaces:**
- Consumes Task 1's verified delta and current live image.
- Produces candidate image ID, prior image/configuration reference, changed-file manifest, health result and concrete rollback procedure.

- [ ] **Step 1: Capture current image/configuration and make a normal backup.** Do not print credentials. Retain the immutable prior image.

- [ ] **Step 2: Compare every changed file against the live image.** Apply only the reviewed Colab delta, reconciling existing live overlays. Rebuild frontend assets from actual live web source plus the UI delta, preserving newer live behavior.

- [ ] **Step 3: Build and validate the derived image in isolation.** No production database, credentials or volumes. Expected: modified modules import, selected tests pass and startup health is valid.

- [ ] **Step 4: Prepare the Google app handoff.** Use the intended Colab account, choose Personal audience only for the single-creator use case, select AI-agent usage when offered, enable Colab API, and register ${PUBLIC_URL}/api/app/connectors/oauth/callback. The concrete URL stays in the private handoff.

- [ ] **Step 5: Import the user's downloaded OAuth client through the reviewed helper.** Run node scripts/colab/import-google-oauth.mjs --oauth-json /absolute/path/client.json --env-file /absolute/path/runtime/.env --public-url "${PUBLIC_URL}" --check first, then omit --check to apply. Expected: protected server configuration contains both client values; output reports only validation/status. User performs required sign-in; no cookies or fabricated sessions.

- [ ] **Step 6: Recheck live work immediately before switching.** Inspect active agent runs, live machine tasks and processing jobs. If a tool is mid-effect, wait for a safe boundary. Do not delete pending jobs.

- [ ] **Step 7: Deploy through the normal graceful path with the existing 40-second stop timeout.** Expected: healthy new image, retained old image, preserved overlays/configuration.

- [ ] **Step 8: Account for restart recovery.** Verify any previously active work resumed or reached an explicit state. Inspect uncertain tool effects before any replay.

### Task 3: Complete real sign-in and compute checks

**Files:**
- Read docs/colab-remote-mcp.md.
- Record a secret-free private validation receipt.

**Interfaces:**
- Consumes deployed image, protected Web OAuth app and legitimate signed-in application UI.
- Produces active connection ID, authenticated provider results, smoke artifact and refresh result.

- [ ] **Step 1: Inspect the catalog/detail UI.** Confirm correct OAuth-only labels in configured state and actionable configuration copy in unconfigured state. Record visual verification as pending if no supported browser/app view works.

- [ ] **Step 2: Start consent from the normal connector screen.** Or use POST /api/app/organizations/{orgId}/connectors/colab/oauth/start through the signed-in app. User completes required Google login. Return to the connector screen and inspect the connection view.

- [ ] **Step 3: Handle OAuth return state correctly.** If its ten-minute, single-use state expired or was already used, start a fresh flow. Never replay a used callback.

- [ ] **Step 4: Call authenticated get_subscription and list_runtime_specs.** Expected: account data instead of HTTP 401. Public tools/list is not an authentication check.

- [ ] **Step 5: Reuse a suitable runtime or create one eligible CPU runtime with a new UUIDv4 requestId.** Open a task-owned session and persist identifiers. Leave other users' sessions untouched.

- [ ] **Step 6: Execute print(1 + 1) with a fresh executionId.** Expected: 2 without an execution error.

- [ ] **Step 7: Execute a bounded call beyond the old timeout with another fresh executionId.**

```python
import time
time.sleep(70)
print("colab-long-call-ok")
```

Expected: marker returns after more than 60 seconds without SDK cancellation. This consumes bounded real Colab resources.

- [ ] **Step 8: Retrieve a small result artifact.** Write a task-owned JSON file with the known result/marker, download through the runtime HTTP file API and verify parsed contents outside Colab. Never print the proxy token.

- [ ] **Step 9: Verify a provider call after refresh.** Use the normal lifecycle or a narrowly controlled refresh check without exposing tokens or changing unrelated state. If unverified, keep this item pending.

- [ ] **Step 10: Close the smoke session and account for its runtime.** Deletion follows task authorization and the existing sensitive-action policy. Record any retained compute.

### Task 4: Enable reusable guidance while preserving access

**Files:**
- Create docs/colab-job-playbook.md.
- Read packages/engine/src/{access,skills}.ts.
- Read apps/server/src/routes/app/{access,skills}.ts.

**Interfaces:**
- Consumes current workspace agent/access/skill views and the playbook.
- Produces skill colab-job-playbook, its ID, enabled assignment results and preservation comparison.

- [x] **Step 1: Write the playbook.** Include execution selection, owned sessions, exact-ID recovery, checkpoints, output verification and three workload recipes.

- [ ] **Step 2: Read current effective access and enabled skills.** Existing All tools already covers Colab; preserve it. Make no grant write when none is needed.

- [ ] **Step 3: Install via legitimate signed-in UI, authenticated skill API, or the bounded owner-authorized maintenance script described in the specification.** Use name colab-job-playbook, reviewed description/body and defaultForNewAgents false. Create only when absent; reuse an identical body. Treat a different same-name body as a conflict and leave it unchanged.

- [ ] **Step 4: Enable only this skill for intended current agents.** PUT /api/app/organizations/{orgId}/agents/{agentId}/skills with { skills: [{ skillId, enabled: true }] } upserts specified rows and preserves all other assignments. Use the UI equivalent when preferred.

- [ ] **Step 5: Verify preservation.** Compare grants, approval levels, models, instructions and enabled skills. Only the intended new connection/playbook should differ. Inspect effective Colab tools and deletion's sensitive marker.

- [ ] **Step 6: Review the recipes against acceptance.** Each needs authorized inputs, a small sample, durable outputs and cleanup. Uncertain recovery must retain identical session/executionId/code. Do not launch user batches or recurring jobs just to install guidance.

- [ ] **Step 7: Report installed recipes separately from completed workloads.** No actual GPU/audio/document batch is claimed without evidence.

### Task 5: Documentation and final review

**Files:**
- Create/review PRD, specification, playbook and this plan.
- Modify docs/colab-remote-mcp.md.

**Interfaces:**
- Consumes Task 1–4 evidence.
- Produces coherent documentation and implemented/verified/pending release report.

- [x] **Step 1: Cross-link related documents.** Keep private instance URLs, org/agent IDs, credentials and deployment paths out of tracked files.

- [ ] **Step 2: Map every acceptance criterion to evidence.** A source test, public endpoint response or healthy container alone does not prove authenticated compute.

- [x] **Step 3: Check documentation integrity.**

```bash
git diff --check
```

Expected: no whitespace errors; every relative Markdown link resolves.

- [ ] **Step 4: Commit only owned documentation after coordinating staging.**

```bash
git add docs/colab-remote-mcp-prd.md docs/colab-remote-mcp-spec.md docs/colab-job-playbook.md docs/colab-remote-mcp.md docs/superpowers/plans/2026-11-20-colab-remote-mcp.md
git commit -m "docs: define Colab rollout and reusable job playbook"
```

- [ ] **Step 5: Report source/image identity, real checks, enabled agents/skill, preserved settings, rollback reference and remaining limits.** Do not invent CU usage or continuous availability.

## Self-review

- Coverage: R1–R6 map to Tasks 1–3; R7 to Task 4; R8 to Tasks 3–4; R9 to Task 2; R10 to Task 5.
- Interfaces match server routes. Access assignment replaces; skill assignment upserts.
- Review focus has explicit source/component tests or release checks.
- Code remains authoritative; the plan describes decisions and evidence rather than duplicate implementations.
- The user has authorized implementation/deployment. Continue the assigned execution method; required account login remains a human handoff.
