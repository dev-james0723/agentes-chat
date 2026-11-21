# AC Passkey Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Add email-free Passkey login and account credential management to the existing self-hosted server and Mac browser handoff.
**Architecture:** Better Auth remains the session authority; a patched official Passkey plugin performs WebAuthn. Existing desktop verifier/code exchange opens the canonical browser origin; no native binary change.
**Tech Stack:** Bun 1.4.4, Better Auth/@better-auth/passkey 1.7.27, Hono, Drizzle/PostgreSQL/PGlite, React/Vite.
**Spec:** docs/specs/ac-passkey-login/ENGINEERING-SPEC.md

## Global Constraints
- Parent revision: 4963195313ce5d4797b4531bbaef578a3fe2003c.
- residentKey='required'; userVerification='required'; exact canonical origin and RP ID.
- Keep password fallback, current session/account blocking hooks, LOCAL_HTTP_LOGIN protections and all existing features.
- Append migrations after 0282_right_hand_own_brains; never rewrite committed migration files.
- Reuse the desktop verifier and explicit code confirmation. No session tokens in URLs.
- Use only isolated worktree dependencies; no writes to live/shared node_modules.
- Public source excludes personal hostnames, account data, private receipts and secrets.
- Physical biometric acceptance remains distinct from virtual-authenticator tests.

## Review Focus
1. Local HTTP app opening an HTTPS browser ceremony must redeem a session with the correct local cookie behavior.
2. A revoked cookie-cached session must not enroll or remove credentials.
3. Replayed or concurrent assertions and userHandle mismatches must not create a second unauthorized session.
4. A desktop management link must leave WKWebView and return after reauthentication without a redirect loop.
5. Missing capability, cancellation and unreachable private hostname must leave password login usable.

## Task 1: Dependency, server and storage integration
**Files:** apps/server/package.json; apps/web/package.json; apps/mobile/package.json where an existing companion version must align; bun.lock; apps/server/src/auth.ts; new apps/server/src/passkeys.ts if focused guards need it; packages/db/src/schema/auth.ts; packages/db/migrations/* new entry only; packages/db/test/schema.test.ts; apps/server/src/routes/app/account.ts; packages/client/src/api/types.ts; apps/server/test/passkeys.test.ts; existing auth tests.
**Interfaces:** Produces optional AuthConfig.passkeys: { enabled: boolean; origin: string | null } and official /api/auth/passkey endpoints. Uses existing account/session hooks and FRESH_SIGN_IN_MS.
- [x] Run untouched auth/desktop/schema baseline tests; record exit result.
- [x] Add integration tests that fail because capability/endpoints are absent. Required assertions: options expose residentKey required and UV required; unauthenticated registration refused; wrong origin refused; fresh signed-in user can register a valid proof.
- [x] Add aligned 1.7.27 dependencies and frozen resolved lock, preserving unrelated package versions.
- [x] Implement schema/plugin mapping, canonical configuration, live/fresh-session management guard and rate limits.
- [x] Generate exactly one additive migration and inspect SQL/metadata.
- [x] Run valid registration/login plus invalid signature, absent UV, replay, wrong userHandle, revoked key/session and accountBlock tests. Expected: all pass without real credentials/network.
- [x] Run existing auth, desktop, phone and schema regression tests. Expected: all pass.
- [x] Commit only this task's reviewed source/tests/dependency/migration files.

## Task 2: Browser and desktop experience
**Files:** apps/web/src/auth/client.ts; apps/web/src/auth/better-auth.ts; new apps/web/src/auth/passkeys.ts; apps/web/src/lib/desktop.ts; apps/web/src/pages/AuthPage.tsx; apps/web/src/pages/DesktopSignInPage.tsx; apps/web/src/routes/desktop.sign-in.tsx; apps/web/src/routes/login.tsx for strictly validated reauthenticate=1; apps/web/src/components/AccountSettings.tsx; new apps/web/src/components/PasskeySettings.tsx; relevant auth CSS/locales; apps/web/test/fake-auth.ts; auth-pages, desktop-sign-in and new passkey-settings tests.
**Interfaces:** Consumes Task 1 AuthConfig.passkeys. Produces the five AuthClient methods and PasskeySummary exactly as specified. DesktopSignInMethod extends the web-only method without modifying social SignInProvider.
- [x] Add failing UI tests for passkey action before email, cancellation/retry, fallback and hidden capability.
- [x] Implement typed client adapters and update test fakes.
- [x] Implement canonical browser login and desktop handoff, preserving verifier and matching-code confirmation.
- [x] Add tested mode=passkeys on the external desktop route, standalone authenticated management, and AccountSettings entry.
- [x] Verify account metadata display, rename/delete, fresh-auth recovery and accessible pending/error states.
- [x] Run relevant web tests and typecheck; build web assets using the established Node/Vite command. Expected: all pass.
- [x] Commit only task-owned source, locales and tests.

## Task 3: Independent review and isolated acceptance
**Files:** task-private evidence, any targeted fixes, ADR in docs/adr/ with next verified available number.
**Interfaces:** Consumes Tasks 1 and 2; produces a candidate source digest, test evidence, screenshot evidence and readiness verdict.
- [x] Review exact combined diff against the spec and Review Focus; fix material findings with focused regression tests.
- [ ] Run required local typecheck/lint/boundaries/licenses and project CI after migration commit. Record baseline failures distinctly.
- [x] Run registration/login/revoke with a virtual WebAuthn authenticator and a disposable account on an isolated server.
- [ ] Exercise desktop-mode handoff without modifying the actual owner session; inspect 1440x900, 390x844, 430x932 layouts, keyboard/errors and console/network.
- [ ] Rehearse migration and old-app compatibility on an isolated database; build candidate image from the pinned parent with new dependency payload.
- [ ] Verify source digest, all changed served assets and unchanged runner bytes in candidate.
- [ ] Commit verified fixes and ADR; push a feature branch only with no private operational material.

## Task 4: Existing-target activation and owner enrollment
**Files:** scoped deploy build/activation files following the existing reviewed workflow; untracked private evidence/state.
**Interfaces:** Consumes candidate acceptance and current runtime; produces a verified live release or an explicit safe blocker.
- [ ] Acquire existing host deployment lock and revalidate image/source plus idle work. Never interrupt other agents.
- [ ] Create/verify database backup and preserve exact prior image; mutate only the image selector via compare-and-swap.
- [ ] Gracefully activate only the app service and verify source/image, migration, health, assets and runner reconnection.
- [ ] Inspect live signed-out UI and fallback without signing out the owner's active session.
- [ ] Open the actual owner's Passkey settings ready for enrollment; leave the physical OS verification to the owner.
- [ ] Record implemented/deployed/protocol-verified/hardware-verified states separately. Completion must not overstate an unobserved fingerprint/face ceremony.

## Execution decisions
The current instruction explicitly requests autonomous implementation. Use separate backend and frontend owners with these fixed interfaces; root serializes dependency installs, commits and deployment. This avoids repeating approval questions and prevents conflicting writers. Existing source/deployment identity was verified before creating the feature worktree.

Verification update: server cryptographic suite35/35 passed after a reviewed discoverable-reauthentication fix. One additional real-crypto canonical-HTTPS-to-local-desktop handoff test passed33 assertions with actual origin/CSRF enforcement. Web165 regressions passed, followed by12/12 management tests for the reviewer cache fix; final web typechecks/build passed. A real Chromium virtual authenticator passed registration, naming, email-free login, signed-in reauthentication, explicit desktop confirmation/redemption, revocation and password fallback; six viewport captures had no horizontal overflow, no page errors and no server5xx. Physical biometric enrollment is still unobserved.

Release execution uses a separate clean worktree of the committed source with independently installed frozen dependencies. Development lifecycle metadata and private evidence remain outside the release source.
