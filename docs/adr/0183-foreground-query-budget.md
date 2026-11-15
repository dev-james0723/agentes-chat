# 0183: Preserve the foreground query budget around project routine execution

Status: Accepted

## Context

Project routines resolve their persisted routine, mapping, receipt and workspace authority before a brain turn. Wrapping every foreground brain in that resolver also added one routine join to ordinary conversation turns. The existing before-model and tool-turn query tests regressed from their limits of 18 and 24 statements to 19 and 25.

The executor already has the claimed persisted run and its trigger message. Server-created routine firings set `background: true` and carry routine markers on that message. The routine and workspace authority checks must still run for admitted project work after compatibility is disabled, and for malformed or incomplete routine metadata.

## Decision

Skip the project brain wrapper only for a running foreground run with no work ID, a matching trigger message ID and organization, object metadata, and none of the raw `routineBrief`, `routine`, `viaRoutine` or `background` keys. Presence of a key is enough to retain the wrapper, including null, false or malformed values. A missing or mismatched trigger also retains the wrapper.

This is a conservative classification of a known ordinary origin using already loaded persisted data. It does not cache or grant project authority, select a workspace from message metadata, or consult the compatibility flag to bypass validation. Background work and all uncertain origins retain the existing per-turn resolver, current-route and revocation checks, fresh-session requirements and no-replay behavior. The server routine-creation invariants remain required; arbitrary corruption of both persisted run origin and trigger markers is outside this classification.

## Verification and limits

An executor fixture counts the actual project join and proves that ordinary foreground execution reaches its fake provider with zero project joins. Background and raw-marker fixtures retain the join. Persisted project links with compatibility disabled, a missing receipt, or a forged foreground flag plus a routine marker fail before any agent request. Existing query-budget tests retain their original thresholds; project-runtime tests cover changed mappings, model drift, canceled tasks, revoked bindings and native route checks.

The change adds no dependency, schema, migration, cache or configuration. Reverting it restores the unconditional wrapper and its extra query without changing stored data. All checks use isolated synthetic fixtures; they do not establish installed-runner, live-model or production acceptance.
