# Canonical source tasks for connected apps

This adapter preserves one native issue and task conversation per workspace, owner and normalized saved source. It is task identity metadata; it does not create a Share event, authorize installation, assign an agent or send a message.

## Native contract

- `ensure_source_task` requires the existing app's `write` scope and the person's current posting permission. Inputs are `source_url`, a bounded `idempotency_key`, and optional `expected_issue_id` as a precondition.
- `read_source_task` requires `read` scope and current visibility. It returns `unbound` or the actual issue ID, issue number, task channel ID, top-level thread root, source key, binding ID, workspace and owner. Reading never creates a conversation.
- The source lock is scoped to workspace + owner + normalized source, independent of event IDs, keys, tokens and app grants. A separate grant + key lock rejects changed requests. Neither lookup has a TTL.
- The native issue, its owner-private audience, native task conversation, immutable `apps.source_task.bound` audit row and request receipt commit in one transaction. A failed native or audit write leaves no orphan issue or conversation. Existing native issue publication uses its existing outbox.
- Every read and replay checks current issue visibility and actual channel/root linkage. Multiple bindings, missing/deleted tasks, wrong roots and changed expected IDs require reconciliation. A deleted task's binding is a tombstone; the adapter does not replace it.
- Source normalization collapses ordinary HTTPS X/Twitter status aliases to `x:<post-id>`; nondefault X ports and embedded credentials are rejected. Other HTTPS URLs use their normalized URL hash. No URL is fetched by these tools.

## Identity and authority

`issue_id` is the canonical task. `channel_id` plus `thread_id` identify its native task conversation. Each `send_to_agent` still returns a distinct execution `task_id` (the sent message ID); `thread_id` is now also returned on sends and waits. Cross-agent phases supply the same task channel/root explicitly. Reply message IDs and run IDs remain distinct evidence.

A Bookmark can create the source task for context research. An authenticated deliberate Share upgrades the separate adoption obligation while reusing that source task; duplicate Share uses the existing action and binding. The binding itself is never installation authority or completion evidence.

A task title, pasted URL or user/agent message body does not attest a pre-existing external-source binding. `expected_issue_id` cannot attach an arbitrary existing issue. Legacy messages remain unchanged and retain their original provenance; unproven migration remains pending reconciliation. An existing umbrella repair issue is not silently reassigned as a post's source task. An owner-authorized manual source task may be created without pretending a phone Share occurred.

## Candidate verification

The tests exercise concurrent same-source requests and app grants, changed-key payload refusal, lost-response replay, token rotation, no TTL, read-only scope, owner/workspace isolation, arbitrary legacy-issue refusal, deleted-task tombstones, conflicting bindings, root deletion, rollback on forced audit failure, and cross-agent sends/waits with the canonical root and original direct-reply proof. They use the repository's isolated test server and fake agent provider. They do not call a production workspace or assert that an installed phone has delivered a Share.
