# Passkey 登入 — Engineering Specification

Revision: 1 | Authority: PRD.md revision 1 | Scope: server/web with existing Mac browser handoff

## Baseline and protected behavior
Parent 4963195313ce5d4797b4531bbaef578a3fe2003c was matched to the live source digest before isolation. Preserve LOCAL_HTTP_LOGIN host validation, rejectForwardedLocal, change-email support, all existing migrations, runner bytes, and unrelated custom features. Changes remain in the dedicated feature worktree. Operational receipts and host-specific paths stay untracked.

## Architecture and interfaces
Use @better-auth/passkey at 1.7.27 with better-auth and @better-auth/expo aligned to 1.7.27. Install only in this worktree, never shared/live node_modules. Compare plugin with direct @simplewebauthn/server: the plugin preserves AC's session/hooks and reduces custom authentication code; direct verifier is retained as a research alternative.

### Server
- Add passkeys to packages/db/src/schema/auth.ts, following the plugin model exactly: id, name, publicKey, userId, credentialID, counter, deviceType, backedUp, transports, createdAt, aaguid.
- credentialID is unique; userId references users with delete cascade; index userId. This is a global account table, explicitly exempted by the existing tenant-schema test.
- Append a migration after the verified current journal. Never overwrite committed migration SQL or snapshots.
- Configure the plugin with rpID from new URL(config.PUBLIC_URL).hostname and origin from .origin, residentKey='required', userVerification='required'. Enable only valid HTTPS domain origins or explicit localhost development.
- The configured origin is the only credential origin. Do not trust arbitrary Origin/Host/forwarded headers to choose a relying party.
- Enrollment and rename/revoke require a live session checked against the store and authentication less than FRESH_SIGN_IN_MS (ten minutes). Do not use only the signed cookie cache. Preserve ownership checks. The normal session-create hooks retain accountBlock and session auditing.
- Use ordinary plugin endpoints under /api/auth/passkey/*. Bound unauthenticated options/verification requests with the existing rate limiter.
- /api/app/auth-config adds passkeys: { enabled: boolean, origin: string | null }. Shared AuthConfig declares the field optional for older-server compatibility.
- Errors do not disclose account existence or raw authenticator assertions; no tokens in URLs/logs.

### Web client
apps/web/src/auth/client.ts gains:
- PasskeySummary: { id: string; name: string | null; createdAt: string | null; deviceType: string; backedUp: boolean }.
- signInPasskey(): Promise<AuthResult>.
- addPasskey(): Promise<AuthResult>.
- listPasskeys(): Promise<{ ok: true; passkeys: PasskeySummary[] } | Extract<AuthResult, { ok: false }>>.
- renamePasskey(id: string, name: string): Promise<AuthResult>.
- deletePasskey(id: string): Promise<AuthResult>.
Implement through passkeyClient in auth/better-auth.ts and the existing error adapter; update fake-auth.
Do not send a display nickname as the initial WebAuthn account name. Register with account identity, then rename separately.

AuthPage offers the Passkey action on its initial sign-in screen. Native platform/user verification prompts start from a deliberate click. On success reuse existing enter()/redirect handling. Keep password and social flows.

Introduce DesktopSignInMethod = SignInProvider | 'passkey' in apps/web/src/lib/desktop.ts; shared SignInProvider remains social-only.
- Reuse the existing request/verifier/code/expiry exchange.
- browserSignInUrl accepts a canonical origin override from auth-config.
- The desktop.sign-in route validates passkey as a method, without weakening request ID/code validation.
- DesktopSignInPage shows an explicit Passkey button and, after successful authentication, the existing matching-code confirmation.
- /desktop/sign-in?mode=passkeys is a strictly validated, separate credential-management entry. It uses the already-external native route and does not require or create a handoff request.
- AccountSettings provides a Passkeys row. Normal canonical browsers show PasskeySettings; desktop/local aliases open the canonical external management entry. If not signed in, it routes through normal login and returns to management.
- Fresh-auth failures offer sign-in again using a strictly validated reauthenticate=1 search flag on the existing login route, which may show AuthPage despite an existing session. Authenticate normally and return to management; do not silently sign out another window or mint an artificial fresh session.
- Cancellation is recoverable; unsupported authenticators and network errors show appropriate accessible text. Text describes Touch ID/Face ID or the device's approved verification fallback.

### UI and compatibility
Reuse AC controls, dialogs and i18n patterns. Keep keyboard focus, labels, errors and touch targets usable at 1440x900, 390x844 and 430x932. No new animation is necessary. Older servers omit capability and retain current login.
Mac binary/signing/permissions are unchanged. iPhone support in this release means Safari, not native Expo.

## Requirement traceability
REQ-001/004/005 → AuthPage, DesktopSignInPage, desktop routing and auth-config → browser/desktop tests.
REQ-002/003 → plugin, session guards, schema/migration → cryptographic registration/authentication and ownership tests.
REQ-006 → client adapters/components → cancel/error/fallback UI tests.
REQ-007 → preserved hooks, aliases and runner → existing auth/desktop/account regression plus served runner hash.
REQ-008 → source identity, isolated migration/boot, guarded release → recorded candidate/live receipts.

## Verification
First run the existing auth/desktop/schema tests on the untouched baseline. Then write feature tests and observe the intended failure before production changes.
Server tests use the repository's PGlite harness and real cryptographic proofs where possible: valid registration/sign-in, replay, expiry, wrong challenge/origin/RP, absent UV, revoked credential, wrong user, stale/revoked session, blocked account.
Web tests cover capability visibility, email-free login, browser handoff, canonical origin, explicit confirmation, settings ownership/errors/cancel.
Run relevant existing tests, typecheck, lint, boundaries, licenses, frontend build and required local CI. Commit migration metadata before scripts/ci-local.sh, whose drift check resets dirty migration files.
Use an isolated virtual WebAuthn authenticator for the actual end-to-end ceremony; it never enrolls a credential for a real owner account. Capture changed states and inspect relevant console/network errors. Hardware ceremony requires owner presence.

## Release and rollback
Build on the exact current immutable image, preserving the runner and unrelated contents. Include changed dependencies, reviewed source/migration files and newly built complete web assets. Verify runtime identity and assets in an isolated container.
Before live activation: acquire the existing exclusive .host-deployment.lock; compare current image/source to the reviewed parent; take and verify a database backup; rehearse the additive migration on an isolated database; verify no executing agent runs or machine work; change only the selected image using compare-and-swap; gracefully update only the app service.
Retain previous image and database backup. The additive table must remain compatible with the old app for rollback. Never stop agents or delete data merely to obtain a release window.
After activation confirm health, source digest, image ID, migration, auth-config and served assets; exercise password fallback and Passkey protocol on a safe test path. Real account enrollment is the remaining owner-only step if not observed.

## Authorization and evidence
The current request authorizes research, implementation, testing and completion on the existing self-host target. It does not authorize publishing private operational receipts, unrelated app releases, resetting account credentials or bypassing device security.
Sources and user outcomes are in PRD.md. Task plan: ../../superpowers/plans/2026-11-21-ac-passkey-login.md.
