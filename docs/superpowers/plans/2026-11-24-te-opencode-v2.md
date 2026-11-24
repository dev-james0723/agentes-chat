# Te OpenCode v2 Compatibility Plan

**Goal:** Run the native AC OpenCode brain with installed v2.2 while preserving v1 behavior, tool permissions, provider isolation and free-model selection.

**Evidence:** Installed v2.2.5 uses `debug agents --standalone` (array of agents), omits `--pure`, and defaults to a shared background server. An isolated free-only catalog lists the requested DeepSeek model; the actual free inference reaches a provider quota error, not an authentication error. The existing global user config enables only Ollama.

## Global constraints

- No paid inference, fallback, account changes, global provider changes or relaxed tool permissions.
- Preserve v1 behavior; detect CLI major from a bounded actual version probe, failing closed on unsupported/unverifiable versions. Do not trust a model-provided version.
- Every v2 probe/turn must use a private standalone server so per-turn config and native MCP permissions apply.
- Chat turns continue to deny every non-AC tool. Do not remove or bypass the permission probe; malformed/duplicate/missing build agent, loose allow rules, timeout or nonzero exit fails closed.
- Free catalog discovery is read-only, isolated and without paid credentials; never invent available models from the static catalog or use a paid fallback.
- Keep actual provider usage and success unverified until the native inference succeeds. Respect the observed quota reset; no repeated inference before it.
- One source writer, no GitHub Actions, no production changes during this task.

### Task 1: Runtime, permission guard and catalog compatibility

Files: apps/server/runner/brain-opencode.ts, apps/server/runner/executors.ts, apps/server/test/runner/brain-opencode.test.ts; a small shared runner helper/test fixture may be added if required to avoid circular imports or duplicate isolation logic.
- [x] Read existing runtime/config/parser and executor discovery code before editing.
- [x] Add bounded, cancelable actual CLI major detection for turns; retain v1 argv and add v2 standalone argv without unsupported pure flag.
- [x] For v2 chat probe select exactly one build agent from `debug agents --standalone`. Validate normalized permission rules `{action,resource,effect}` with a global deny and only AC MCP allows; preserve post-probe runtime foreign-tool detection.
- [x] Independently probe the actual free-only OpenCode catalog with isolated config, no sign-ins or inherited provider keys, then safely union verified free IDs with existing user inventory. Do not modify global config or falsely label unlisted models available. Ensure an explicitly selected free model can run on an owner-paired computer whose global provider whitelist excludes OpenCode.
- [x] Test v1/v2 argv; invalid/unknown versions; cancellation/nonzero probes; valid and adversarial v2 permission arrays; external tools remain blocked; isolated catalog with Ollama-only user config; paid credentials stripped; exact model used for title/auxiliary work; source config preserved.
- [x] Inspect v2 event output from no-inference debug and the recorded provider error fixture. Verify mapper error semantics; do not claim a successful text/tool/inference canary until actually observed.
- [x] Run focused runner tests, relevant executor/mission-runner tests, Biome and typecheck. Do not run full CI; root owns final exact-head run.
- [x] Commit only scoped source/test/plan files. No push, merge or deploy. Write detailed report including actual command and evidence, then stop.

## Release acceptance

OpenRouter reviews the final full branch. Root then obtains full local CI and isolated image boot. Live source overlays and existing skills must survive production integration. Management OAuth and free-model runtime acceptance remain distinct gates.
