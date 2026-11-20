# Model Inspector PRD

Date: 2026-11-20

## Outcome

An enabled organization has a visible Model Inspector agent backed by a deterministic minute-by-minute service. It monitors every nonarchived agent and the accounts used by active runs, missions and routines. It prepares or performs a task-appropriate move to an authenticated available model before a subscription is exhausted, without losing work or calling a language model merely to poll usage.

## Requirements and acceptance

| ID | Requirement | Acceptance |
| --- | --- | --- |
| MI-01 | Inspect the whole enabled organization, including idle agents, routines, own computer sign-ins and named accounts. | A sweep reports every eligible agent and deduplicates account refreshes. |
| MI-02 | Use 95% as the proactive migration threshold; represent unknown, stale, near-limit and exhausted separately. | 80% is usable; 95% is near-limit; missing/expired readings never become 0% or exhausted. Model-specific Claude windows affect only their applicable models. |
| MI-03 | Ask the existing JEV judge to choose among qualified routes based on role, task, tools, mission/routine context, capability tier and effort. | Only authenticated and normally admissible candidate routes can be selected. Invalid/time-out advice uses a documented deterministic fallback and cannot enable paid usage. |
| MI-04 | Move running work only at a completed turn boundary. | Run/task IDs, working directory and completed tool receipts survive; an unresolved tool effect prevents migration. A foreign provider's native session is never reused. |
| MI-05 | Support active missions, and retain their replacement route on later turns and after restart. | Mission ownership and source session are checked transactionally; subsequent resolution uses the committed new route. |
| MI-06 | Prepare idle agents and scheduled routines for the next run. | Changes preserve instructions, skills, access, audience, explicit effort and billing settings; concurrent human changes invalidate the inspected snapshot. |
| MI-07 | Integrate Grok through the existing authenticated CLI account and real brain adapter. | Account visibility and quota uncertainty remain distinct; a Grok model must pass the existing resolver and a bounded real smoke before live usability is claimed. |
| MI-08 | Keep monitoring independent from any model's quota. | Worker polling continues if JEV or the inspector agent's model is unavailable. Switching has cooldown, per-sweep limits, account-aware selection and durable audit records. |
| MI-09 | Make results inspectable. | The inspector has a status tool/API, the service records decision reasons and timestamps, and the visible agent explains changes in plain language. |

## Scope

Reuse the existing native quota telemetry, JEV judge, model gateway, brain resolver, validated agent settings and portable run handoff. Enable this only for the requested engineering organization. Existing routines remain assigned to their existing agents. No automatic purchase, unconfigured API billing route, model download, credential extraction or provider-permission changes are introduced.

Monitoring is a deterministic server routine every 60 seconds. The visible agent responds on demand; it does not spend tokens every minute just to check a number. Idle migration is staggered and active work independently rechecks capacity at its next safe boundary. If no suitable alternative is available, retain the original route and report the reason; near-limit is not itself an exhaustion error.

## User flows

1. A shared Claude pool reaches 95%. The next sweep refreshes usage and identifies all affected agents. Idle agents receive a qualified next-run route; active work is marked as awaiting a completed boundary in the report and checks the same policy there.
2. JEV compares qualified Codex/Grok/Claude options with the task. It cannot select a route outside that list. The chosen target is revalidated before mutation.
3. An active mission completes a turn. Its checkpoint and new native session are committed together; the mission continues from the existing files and receipts.
4. James asks Model Inspector for status. It reports observation time, source, percentage or unknown, next-run route and any blocked migration, with no raw credentials or private conversations.

## Failure states

Stale/offline data requests a refresh and stays unknown. Authentication failure, rate throttling, model removal and budget exhaustion remain separate. Unknown Grok allowance is lower-confidence capacity and must never be presented as confirmed remaining allowance. On a JEV timeout the deterministic inspector remains operational. On a changed account, owner, source model or session the old decision is discarded. Failed verification does not become a success receipt.

## Evidence used

Inspected live runtime and source on 2026-11-20. Existing APIs: runner plan usage, machine account refresh, `resolveBrain`, `setAgentBrain`, quota continuation, native workers. Primary provider references: https://code.claude.com/docs/en/statusline ; https://learn.chatgpt.com/docs/app-server ; https://docs.x.ai/build/cli/reference ; https://docs.x.ai/build/cli/headless-scripting . Exact available models and account capacity must come from runtime evidence, not this document.
