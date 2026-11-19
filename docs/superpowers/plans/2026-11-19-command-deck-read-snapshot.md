# Command Deck Read Snapshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Give an authorized personal-token client a complete workspace directory and a paged copy of its own notification inbox without changing conversations or read state.

**Architecture:** Add one read-only MCP tool, `get_command_deck_snapshot`, behind the existing authenticated `AppPrincipal`. Reuse the engine reads used by the team screen, channels, direct conversations and inbox; reduce directory data to display/navigation metadata. The caller cannot choose another organization or person.

**Tech Stack:** TypeScript, Zod, MCP server, existing Hono test harness with in-memory PGlite.

**Spec:** `docs/adr/0119-mcp-server.md`, Read-only control surfaces addendum.

## Global Constraints

- Existing read scope, principal refusal and membership checks remain authoritative.
- No cookies, keys, model credentials, agent instructions, capability scopes or private configuration in output.
- No send, approval, DM creation, read/done mutation, or model invocation.
- Inputs: optional `notification_cursor` string up to 400 characters and `limit` integer 1–100 (default 100); unknown fields rejected.
- Only the token's organization; directory complete only after all underlying reads succeed.
- Counts describe the whole visible inbox; `nextCursor` is the source keyset cursor.
- `observedAt` is the completed read time, not an atomic database snapshot or a durable event cursor.

## Review Focus

- Another person's DMs/notifications and another organization's data are absent.
- A snapshot neither creates DMs nor advances notification/channel read watermarks.
- Multiple notification pages retain authoritative counts, unique IDs and completion metadata.
- Empty directories and null last messages are valid; service errors are not fabricated zero counts.
- Revoked grants and removed membership refuse calls at the existing authentication boundary.

## Task 1: Add the authorized snapshot read

**Files:**

- Create `packages/engine/src/apps/command-deck.ts`.
- Modify `packages/engine/src/apps/tools.ts`.
- Create `apps/server/test/mcp-command-deck.test.ts`.
- Update `docs/adr/0119-mcp-server.md`.

**Interfaces:** `registerCommandDeckTool(deps, principal, tool): void` uses `getTeam`, `listAgentGroups`, `listChannels`, `listDms` and `listNotifications`. Output keys are `schemaVersion`, `viewerId`, `observedAt`, `workspace`, `agents`, `teams`, `channels`, `dms`, `notifications` and `coverage`. Notifications preserve source `items`, `counts` and `nextCursor`; directory fields are a documented display/navigation subset.

- [x] Write integration tests for scope/tenant boundaries, pagination, metadata and non-mutation.
- [x] Run the focused tests and observe failure because the tool is absent.
- [x] Implement the minimal tool and document the contract.
- [ ] Run focused and existing MCP tests, lint, typecheck, boundaries and the project test command.
- [ ] Review the scoped diff and commit only feature files; no push, release or restart.

## Baseline

Branch `feat/command-deck-snapshot-20261119` starts at `97dae0412`. Before implementation, `bun test apps/server/test/mcp.test.ts` passed 26 tests with 324 assertions. Bun 1.4.4 installed the frozen dependency lockfile without lifecycle scripts. Local TokenPilot lifecycle setup is excluded from the feature commit.

## Engineering handoff

The implemented contract is documented in ADR 0119. `viewerId` identifies the authenticated person so display clients can isolate persisted notification delivery state by public origin, workspace and person. The snapshot's entire text representation is fenced as untrusted content while structured field names remain intact.

Validation before the scoped commit: 33 MCP integration tests passed (429 assertions), including seven snapshot tests; all workspace typechecks and the boundary check passed; web and server production builds passed. The three changed TypeScript files pass Biome. Running repository lint in the implementation worktree also scans locally installed TokenPilot assets and fails there; this is not a clean-candidate lint receipt. Full release checks run separately in a fresh exact-commit worktree with no local lifecycle files copied.

Release ownership remains with the coordinating task. No push, runtime restart or deployment is performed by this implementation task. The release gate in `scripts/delivery/LOCAL-CI-OPERATIONS.md` requires the complete 22-step evidence on the same candidate, including isolated container boot, plus independent review and the existing deployment lease/backup/rollback checks. The local full runner additionally requires the remote candidate branch to name the same SHA; a local commit alone does not satisfy that provenance condition.
