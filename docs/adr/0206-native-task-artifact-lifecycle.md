# 0206. Native task artifact lifecycle

**Source candidate, disabled by default.**

## Context

The machine task protocol starts native work and reports progress and completion through the runner journal. Those events carry no evidence about an individual intermediate. A task can finish a disposable intermediate while it is still running, and another agent can still be reading that intermediate. Drive artifacts, file paths in task output, and runner logs have different retention contracts.

## Candidate

`TaskManager` accepts an optional `ClosedArtifactBroker` at construction. With that dependency supplied, trusted runner code can obtain a lifecycle binding for a freshly started local work task by presenting its authenticated `AgentScope` and task ID. The runner supplies the task and agent IDs from its journal and a fresh execution ID from its watch. Cancel, task exit and runner shutdown close the binding. Reattached tasks, hosted tasks, plan tasks and local session-flag retries have no binding. During a reattach the runner watches the existing process as usual.

The port sends metadata for explicitly disposable, broker-managed intermediates. Each event names an opaque broker-allocated artifact ID and its generation and carries a stable event ID.

| Event | Required broker evidence |
| --- | --- |
| `artifact_created` | The broker reserved or created the disposable object for this admitted task and generation. A registration opens the writer lifecycle. |
| `write_closed` | The broker has evidence that the writer for this generation durably closed. |
| `consumer_acquired` | A task with a sharing grant claims the object before reading. The broker acknowledges a generation-bound reader or lease claim. |
| `consumer_released` | The same consumer releases its claim after its last use. |
| `checkpoint_verified` | An independently verified, broker-recognized checkpoint receipt covers this artifact generation. |
| `artifact_sealed_disposable` | The admitted producer seals the closed and verified generation. Active claims still protect it. |

A reader waits for an acknowledged acquire before opening broker-managed bytes. The broker checks that the claim is still live at read time and before acknowledging a duplicate acquire. It retains claim identifiers for the generation and deduplicates events durably by execution and event ID. It checks both fences before returning a replayed receipt, rejects altered payloads with the same key, and serializes claims and collection against the same object. The transport must preserve a durable hold when delivery or a committed effect is ambiguous, including when the runner disappears before receiving an acknowledgment. The owner must reconcile such a hold before collection. An event receipt confirms recording only.

The runner validates the event shape, including both opaque IDs, rejects undeclared fields, and validates receipt correlation. It returns `KEEP` for refusals, missing proof and failed or uncertain effects. An ambiguous response closes that execution's binding without replaying events or restarting the task. Calls use an asynchronous port with a 1.5-second deadline and a 16-call limit per execution. An opted-in producer may await its own event receipt. Task dispatch, task watching and unrelated executions continue independently. No server route, machine frame, agent tool, filesystem path, credential, policy update or unlink operation is added.

## Activation gates

The APS source examined has a closed producer surface for broker-owned writes, references, leases, releases and sealing. Its seal operation does not accept an independently verified checkpoint receipt or this native execution identity. The native runner ships with the constructor dependency unset. Live use requires a reviewed mapping or broker extension that authenticates the native execution, enforces both fences, verifies proof and preserves holds for uncertain outcomes. Provisioning and owner credentials belong on the broker side. Physical unlink requires the separate owner policy and a fresh, fenced storage identity and reference check.

Local Bun tests use an in-memory broker to exercise cross-agent claims, event replay and fencing. A runner test drives a detached shell task with a fake broker and checks that lifecycle recording leaves its workspace, journal and task files untouched and that reattachment neither replays the event nor restarts the task. Real APS integration, collector safety, representative high-concurrency performance and agent fleet coverage require separate verification.
