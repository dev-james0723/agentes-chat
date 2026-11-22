# ADR 0209 — Passkey login on a server's canonical origin

Date: 2026-11-21

Status: Accepted.

## Context

People want to sign in without entering an email address and password on every device. Better Auth already owns accounts and sessions. The desktop app loads the server's web UI, sometimes through a local HTTP alias, and already has a verifier-bound browser sign-in exchange (ADR 0036). A server may use a private HTTPS hostname.

## Decision

Use the official Better Auth Passkey plugin at the same patched, pinned version as Better Auth and its Expo companion. The plugin owns cryptographic verification and atomic, expiring, single-use challenges. Passkey sign-in creates ordinary sessions through the existing account-blocking and audit hooks.

The relying-party ID is the hostname of PUBLIC_URL; the accepted origin is its exact origin including the port. Request headers never select either value. Insecure or IP-literal configurations do not advertise this feature; explicit localhost is supported outside production. Existing local HTTP login protections remain unchanged.

Require discoverable credentials and user verification for registration and authentication. Authentication always sends an empty allowCredentials list, including reauthentication; WebAuthn then requires a user handle. An allow-list would permit a valid authenticator to omit it. User verification may be Touch ID, Face ID, a device passcode or another authenticator-approved method. The server stores the credential's public key and metadata, never fingerprints, face data or private keys.

The plugin does not persist and validate its generated user handle. Use an opaque stable SHA-256 digest of a versioned namespace and the server-generated random account ID; check that handle against the credential owner before session creation. Do not use an email address or a session-secret-dependent handle, and preserve the namespace for existing credentials.

The account-wide passkeys table is independent of organizations. Credential IDs are unique; deleting a user cascades credentials. The counter supports the complete unsigned WebAuthn 32-bit range.

Listing credentials reads a live authoritative session. Adding, renaming and deleting additionally require authentication within ten minutes. A registration must not create a new session to refresh the authentication age. Ownership, blocked accounts, expiry and revocation remain server-enforced.

The sign-in page offers Passkey before requesting an email. Account settings lists, names and removes credentials, with explicit removal confirmation and recovery to fresh sign-in. Password login remains available. Older servers without the optional capability render their existing login experience.

## Desktop and phone behavior

A desktop Passkey ceremony opens the configured HTTPS origin in the system browser through the existing external /desktop/sign-in route. It retains the random verifier, expiring request, explicit matching-code confirmation and one-time session redemption. The verifier does not enter the browser URL. Passkey management is a separate validated mode on that route and cannot accidentally initiate a handoff.

A validated reauthenticate=1 login mode allows fresh authentication without signing out other sessions, then returns to credential management. The exact canonical origin is used consistently for credential registration and login.

Phone support in this server/web change is through a supported browser such as Safari. A native mobile app integration needs its own platform configuration and signed release; this change does not claim that capability. The installed desktop binary and runner remain unchanged.

## Deployment and verification

Append one additive migration and leave existing migration files frozen. Test real cryptographic proofs, invalid signatures/origins/RP/UV/handles, expiry, replay/concurrency, ownership, revoked sessions/keys, account blocks and password fallback. Browser acceptance uses a disposable account and a virtual authenticator; it does not prove physical biometric acceptance.

The migration guard rejects a database newer than a build's known journal. Therefore an exact previous image cannot be the automatic rollback target after migration. Prepare and rehearse a compatibility fallback containing the previous app, dependencies, web assets and runner plus only the new additive migration metadata. Keep the guard intact. Record both original and fallback identities honestly, restore-test a database backup, and use the tested fallback without deleting migration history or rolling production data backward.

## Consequences

A credential is tied to the configured hostname. Changing that hostname requires a planned re-enrollment path. Existing sessions may continue opening the workspace without a new ceremony. First enrollment and physical Touch ID or Face ID verification require the person at their device.
