# Passkey 登入 — Product Requirements

Revision: 1 | Target: agentes.chat self-hosted server and existing desktop client | Status: implementation authorized

## User outcome and problem
使用者希望開啟 AC 後，用 Touch ID、Face ID 或裝置提供的驗證方式登入，毋須每次輸入電郵和密碼。第一次建立通行密鑰需由帳戶持有人親自確認；服務端不收集指紋或面容資料。

## Verified current behavior
- Live-compatible baseline: commit 4963195313ce5d4797b4531bbaef578a3fe2003c. Server/source digest was independently matched before this work.
- Bun/Hono/Drizzle/PostgreSQL, Better Auth 1.7.10; React/Vite; existing Tauri desktop browser handoff.
- The existing deployment supports canonical HTTPS and explicitly constrained local HTTP login. Retain both.
- Current schema journal ends with 0282_right_hand_own_brains. Existing migrations are immutable.
- Desktop browser handoff already binds a verifier, expires in ten minutes, requires matching-code confirmation, and creates an ordinary account session.
- WebAuthn in Apple's embedded webview requires associated domains; the existing external browser route avoids a new native binary for this release.

## Chosen scope
Add standards-based Passkey authentication to existing accounts and sessions. Use the maintained Better Auth Passkey plugin on a patched stable version. Keep ordinary password/recovery login available.
Required clients: existing Mac desktop app via its browser handoff; ordinary desktop browsers; iPhone Safari on the same configured HTTPS origin.
Native Expo app changes and App Store releases are outside this server/web release. No claim about native phone Passkeys will be made from Safari tests.
A local biometric screen lock alone would not authenticate a user to the server, so it does not satisfy this scope.

## Requirements
| ID | Priority | User-visible requirement | Acceptance |
| --- | --- | --- | --- |
| REQ-001 | Required | Login offers “Sign in with a passkey” before entering an email. | AC-001 |
| REQ-002 | Required | Signed-in account holders can add, list, rename and remove their Passkeys. Enrollment and mutations require a live, recent sign-in. | AC-002 |
| REQ-003 | Required | Server requires user verification and discoverable credentials; fingerprints/faces stay with the authenticator. | AC-003 |
| REQ-004 | Required | Desktop opens the system browser and returns through its existing verified handoff. Account management opens outside the embedded webview. | AC-004 |
| REQ-005 | Required | Credentials use the configured canonical origin; local and HTTPS aliases never silently create incompatible credential sets. | AC-005 |
| REQ-006 | Required | Cancellation, unavailable capability, offline/network failure and expired authentication return a usable screen with password fallback. | AC-006 |
| REQ-007 | Required | Existing accounts, organizations, permissions, sessions, agent runners, local login and custom features continue working. | AC-007 |
| REQ-008 | Required | Additive database change, isolated validation, pinned release and rollback, then live smoke verification. | AC-008 |

## Main flows
1. Enrollment: Account settings → Passkeys → Add a passkey → authenticate again if the existing sign-in is older than ten minutes → operating-system confirmation → credential appears in list. Rename is a separate cosmetic action after enrollment.
2. Browser login: Open the canonical server → Sign in with a passkey → device verification/account choice → existing destination/workspace.
3. Desktop login: Open AC → Passkey → browser confirmation → compare existing handoff code → return to the authenticated app.
4. iPhone: Open the same canonical HTTPS server in Safari → Passkey → Face ID or the device-approved verification fallback → workspace.
5. Recovery: Cancel or choose password login. Removing a Passkey does not remove the account or other login methods.

## Acceptance
| ID | Preconditions/action | Expected result |
| --- | --- | --- |
| AC-001 | Signed out with a discoverable credential | Login succeeds without an email field being submitted. |
| AC-002 | Current, expired, revoked, or another account's session | Only the current owner with a fresh live session can add/rename/remove; other-account access is refused. |
| AC-003 | Valid assertion and tampered/replayed/wrong-origin/wrong-RP/UV-missing assertions | Valid assertion creates a normal session; invalid proofs do not. |
| AC-004 | Desktop passkey login and management | Ceremony is outside WKWebView; verifier and explicit code confirmation remain required. |
| AC-005 | Canonical HTTPS, local alias, untrusted host, insecure non-local origin | Only the configured credential origin performs ceremonies; safe navigation/handoff is offered for aliases. |
| AC-006 | Cancel, unsupported, offline, expired request | Action can be retried; password login remains reachable; errors are accessible. |
| AC-007 | Existing regression paths | Ordinary login, account blocking, org permissions and desktop exchange remain correct. |
| AC-008 | Candidate and live deployment | Migration rehearsed; health/source/asset identities match; hardware-only acceptance is labelled separately. |

## Sources and decisions
Accessed 2026-11-21:
- https://better-auth.com/docs/plugins/passkey — existing-stack plugin and credential-management APIs.
- https://better-auth.com/changelog — 1.7.16 repaired required user verification and origin validation; use stable 1.7.27 with aligned companion packages.
- https://developer.apple.com/documentation/authenticationservices/supporting-passkeys.md — associated-domain requirement for WKWebView.
- https://www.w3.org/TR/webauthn-3/ — origins, RP IDs, challenges and authenticator verification.
- https://agentes.chat/docs/install-on-a-server — existing private HTTPS deployment model.
Physical Touch ID / Face ID enrollment cannot be performed by an automated reviewer. Virtual-authenticator evidence must not be described as a real biometric test.
