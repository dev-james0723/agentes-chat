# ADR0189 — Verified one-shot skill reads (WP3-B2)

Task 148 under the JEV integration. A canary-scoped `load_skill` releases a skill body only after the server has proved, at that moment, that the reader may see it, and has recorded that release exactly once. Off by default.

## Decision

The Tool Gateway accepts `nativeSkillReads.canary`, a list of exact agent and skill pairs (optionally one run). The server fills it from `SKILL_READ_CANARY` (`agentId:skillId,…`, `load_skill` only); empty leaves every read on the existing path.

For a targeted read the gateway:

1. Binds the call to its persisted `tool_call` step, the run's person authority and control epoch, before the tool runs. A read in scope that cannot be bound is refused; it never falls back to the legacy read.
2. Lets the native reader render the output once, and seals those exact bytes with their hashes.
3. Claims the read in one locked transaction (`skill_read_activations`, migration 0270). That transaction re-checks the run, the agent's hold and archive state, the assignment, the skill version, membership, authority and the Owner's executed sharing decision, then inserts and consumes the row and increments `useCount`. No content reaches outcomes, audit, `recordRead` or the model before the claim succeeds.
4. Treats a duplicate or replayed delivery of the same call as already consumed. No body is returned again and `useCount` is not incremented again.

Only an untruncated `load_skill` body with no resources, linked to a native executed Owner publication, qualifies today. Text files, folder listings and other operations in scope are refused.

## Consequences

- An issued activation never outlives its transaction, so revocation needs no event hooks: the claim reads current state.
- Real PostgreSQL tests cover duplicate delivery, independent overlap and reads racing an assignment revoke.
- One synthetic fixture measured about 90 native SQL statements per scoped read against 10 for a legacy read. That is extra verification work, not a saving. Value is unmeasured until the canary runs.
- Rollback: empty `SKILL_READ_CANARY`. The table is additive; the previous version ignores it.
