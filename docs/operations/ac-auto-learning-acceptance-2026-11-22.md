# AC guarded autonomous learning approval — local acceptance receipt

Date: 2026-11-22
Device: James M3 Max
Initial implementation worktree: `~/Agentes-Worktrees/ac-autonomous-learning-approval-20261122`
Security-review repair worktree: `~/Agentes-Worktrees/ac-auto-learning-review-fix-20261122`
Initial feature branch: `feat/ac-autonomous-learning-approval-20261122`
Release pull request: https://github.com/dev-james0723/agentes-chat/pull/78

## Implemented and verified

- A low-risk, opt-in self-learning approval policy for agent-local, high-trust, verified, repeated lessons. Actual owner-authored matching evidence or linked same-subject independent CI/test evidence can qualify; agent assertions and unlinked or unrelated outcomes cannot. All other proposals still wait for normal reviewer decisions.
- Both semantic permissions and external/data-effect safety checks, source verification and explicit deny rules; unavailable judge fails closed.
- Guard against stale instructions, concurrency and policy-off races in a database transaction; audit uses a system actor and never impersonates an owner.
- New schema, generated migration 0282, server GET/PUT policy routes protected by `manage_agents`, typed API, React settings toggle, and all 14 application languages including English.
- Default `autoApproveLearning = false` for every existing/new organization. No existing tool approval policy was relaxed.

## Actual local test and build results

| Check | Result |
| --- | --- |
| New learning auto-approval tests | 18 passed; 0 failed |
| Existing Memory & Proposal regression tests | 59 passed; 0 failed |
| Skills web/UI tests | 21 passed; 0 failed |
| Localization tests | 22 passed; 0 failed |
| Engine / Client / i18n / Server / Web TypeScript checks | 5 passed |
| Module-boundary check | Passed |
| Drizzle migration consistency check | Passed |
| Targeted Biome formatting & lint check | Passed |
| Full web + server production build | Passed |

Commands executed in the **isolated** worktree using local Bun, without GitHub Actions:
```sh
bun test packages/engine/test/learning-auto-approval.test.ts
bun test packages/engine/test/memory.test.ts
bun test apps/web/test/skills.test.tsx
bun test packages/i18n/test/locales.test.ts
bunx tsc -p packages/engine/tsconfig.json --noEmit
bunx tsc -p packages/client/tsconfig.json --noEmit
bunx tsc -p packages/i18n/tsconfig.json --noEmit
bunx tsc -p apps/server/tsconfig.json --noEmit
bunx tsc -p apps/web/tsconfig.json --noEmit
bun run check:boundaries
bun run check:migrations
bun run build
```

## Exclusions and remaining release gates

- **Not deployed, enabled in a running organization or merged**. An earlier candidate was pushed to Draft PR #78, but a new security-repaired candidate must be committed, pushed and independently validated before production.
- This receipt is not a claim that the **entire** local CI suite passed: targeted regression tests and a production build were run, without taking control of other CI writers.
- A human manager may activate **Settings → Skills → Auto-accept verified learning improvements** only after the change is integrated and the migration applied. Activation needs one owner action; eligible individual improvements then auto-approve.
- All non-qualifying or dangerous changes still go through original approvals. Owners can disable the switch; previously accepted instruction bullets must be removed through the existing instructions editor (a dedicated one-click Undo is out of scope).
- Existing branch protection, local integration tests against the final target branch, protected merge and production rollout are separate gates.

Rollback if activated: disable the switch first, then use the agent instructions editor to remove unwanted accepted lessons, following the accepted proposal's diff and system audit entry.

## Independent security review repair (2026-11-22)

Grok reviewed the clean-main candidate and identified material P1 weaknesses around unverified human-evidence labels, unrelated CI proof, stale pre-vetted learning objects and sensitive-data instructions, plus P2 atomicity/kill-switch concerns. The security-repair worktree addresses these with actual source resolution, event subject binding, read-and-proof checks under transaction locks, an external-data-effect judge, conservative word filtering and atomic settings/audit transaction. Targeted tests passed: 18 engine security + 59 Memory/Proposal + 21 Skills UI + 22 localization = **120 pass, 0 fail** on the repair worktree. This is not a final full CI nor independent sign-off of the repaired HEAD. No protected merge or production deployment is claimed.

## Later security tightening

The full feature branch is now intentionally more conservative than the original receipt: generic positive CI outcomes cannot auto-approve instructions without a separately authenticated, exact-lesson attestation. Exact owner-authored, active public message evidence can still qualify. This local receipt is a historical checkpoint only and must not be used as proof of the current PR head or production release.
