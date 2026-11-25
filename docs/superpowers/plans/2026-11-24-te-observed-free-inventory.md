# Te observed free inventory

## Spec

The user authorized finishing the native Te release with a verified free OpenCode default. The management API must distinguish a display catalog from models actually observed in the isolated signed-out profile used for free execution. A configured model is never proof of successful inference.

## Global Constraints

- Base `ced43f311b09e48b21392ea550653862ae02495b`, branch `feat/ac-mcp-free-agent-model-20261124`, existing isolated feature worktree.
- No production changes, paid inference, credentials, global OpenCode settings, GitHub Actions or branch-protection changes. Preserve existing owner/CAS/manage-scope checks, fallback=false, extraUsage=false and runtime_verified=false.
- Do not remove legitimate UI catalog defaults merely to make the management API strict. Never use personal-account inventory, a model-name suffix or a static fallback as evidence of an isolated signed-out observation.
- Missing, failed, empty or legacy/unverified discovery must fail closed for the management free-model setter. Preserve unrelated executors, owner inventory, credentials and native permissions.
- No database migration or wire-protocol bump unless the actual interface requires one; a validated optional provenance field may preserve backward compatibility. Unknown/malformed metadata is not evidence.
- Commit only task-owned files and this plan with `[skip ci]`. Root controls push, production composition, independent review and full CI. No subagents.

### Task 1: Preserve and enforce free inventory provenance end to end

1. Confirm the observed defect: `opencodeModels([])` supplies static display options; manage-tools currently uses those options for free availability and setter acceptance. `detectOpencode` also retains free markers from personal inventory if the independent probe fails or omits an ID.
2. Preserve explicit evidence of the successful isolated signed-out model probe through the minimal native runner/adapter/engine interfaces. Where legacy fields cannot distinguish provenance, use a small validated optional field and treat absence as unverified. Keep the person's own model inventory for its normal UI uses.
3. Make `get_agent_ai_settings` report only observed isolated IDs intersected with the known free catalog. No verified eligible IDs means free_opencode_available=false. Do not expose accounts, credential paths, keys, provider secrets or unrelated settings.
4. Make `set_agent_free_opencode` reject failed/empty/personal-only/static-only/legacy inventory and any model absent from the independent observation. Preserve fresh config-hash and native ownership checks. Revalidate the relevant current native state in the write path so a stale read cannot bypass the requirement.
5. Add meaningful regressions for failed/empty isolated probes, personal-only free-looking IDs, absent/invalid legacy provenance, missing requested ID, successful verified free discovery, and unchanged ordinary owner inventory. Assert rejected management calls do not mutate settings/audit success; positive calls keep paid fallback and extra usage disabled.
6. Run focused runner/parser/management tests and relevant typecheck/lint. Demonstrate at least the originally observed false-availability case fails before the repair and passes after. Do not run full CI or real inference.
7. Commit, self-review and write a report with exact base/head, contract shape, backward behavior, source/test changes, commands/results and production overlay implications. Call out any changed runtime files beyond the previous four-file runner composition.

## Acceptance

- [ ] Native configuration consumes observed isolated inventory rather than display defaults.
- [ ] Task review and updated OpenRouter review approve the exact repaired source.
- [ ] Production composition updated for the repaired native interfaces; full exact-head CI and actual Te runtime acceptance remain required.
