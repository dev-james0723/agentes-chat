# Te release CI: synchronize the live thread test

## Spec
James authorized fixing all blockers and completing reviewed release work. Exact 71743322 full CI failed the live-thread UI integration case at its unchanged 5,000 ms deadline. Repair the test's synchronization while preserving its real server/socket behavior, assertion and deadline. This task does not authorize a false-green receipt, deployment or product behavior change.

## Global Constraints
- Work only in /Volumes/James 4TB SSD/James-M3Max/AgentStorage/Workspaces/ac-mcp-free-agent-model-20261124 on feat/ac-mcp-free-agent-model-20261124. Base 71743322d5258a5e5f436d833688ba073abceb41. Existing source worktree was clean before this initially untracked plan.
- Allowed tracked changes: apps/web/test/live-real-server.test.tsx and this plan. No product code, dependency/lock, test timeout, CI command, skip, snapshot/geometry baseline or host-admission changes.
- Keep real HTTP server, real WebSocket, two distinct posting sessions, the root and reply, and the same visible reply-count requirement. No local cache/DOM fabrication or mocked delivery.
- Preserve effective Bun per-test deadline 5000 ms. No test retries or repeated-until-green execution. A targeted result never substitutes for canonical full22.
- No GitHub Actions. Commit [skip ci], do not push. Root handles later independent review/push/full CI. The already running immutable CI worktree at the base SHA must remain untouched.
- Read applicable AGENTS. One writer; no subagents. No live production, native agent/provider, OAuth, real user data or browser actions. No Docker/build/full AC suite while current full22 is active. Small focused test and source checks only.

### Task 1: Observe the subscription and rendered thread result

Read first the preserved diagnosis /Users/jamesau0723/.local/state/agentes-chat/ci-receipts/te-final-71743322-20261125-a/web-timeout-diagnosis.md (SHA256 f2b1167b698f2494c9a5e4b4e8688938848ba8cfbfde41ff153bb51d23f3f735). The canonical failed web log is immutable and remains a failed release gate.

The target is `other things that appear after my socket connected > a thread someone starts under my message in the open channel` in apps/web/test/live-real-server.test.tsx. Its successful path currently consumes 400+400+900+2300 ms in fixed waits within a 5000 ms deadline. The 2300 ms burst helper covers a different unread batching behavior. The thread count has an immediate message.created -> refreshRepliedThread -> active thread-list invalidation path. The diagnosis does not establish a product regression or which individual operation crossed the deadline.

Implement the smallest single-case synchronization change:
1. Use the existing test socket frame observer to capture the actual `{type:"subscribed", channelId}` acknowledgement. Capture before workspace rendering can emit it; add only the optional channelId typing needed by this test. Wait for #general's actual acknowledgement, not merely the organization ready frame or a socket OPEN bit.
2. The fixture already opens #general. Remove the redundant same-channel click in this case. Keep the initial shared workspace wait unchanged in this scoped task.
3. Keep the two existing distinct real posting sessions and actual root/reply POSTs. Verify each response, root identity and threadId relationship. Observe the visible root before creating the reply, then wait for the corresponding visible one-reply indicator under that root using the suite's existing Testing Library waitFor pattern/default observation bound. A broad unrelated reply elsewhere must not satisfy the assertion.
4. Remove this case's unnecessary live()/burst() sleeps. Do not change shared helpers or other tests merely to improve runtime. Keep socket/app cleanup and frame observer reset intact. Do not weaken the test into checking only API success or a mocked event.

Verification:
- Preserve actual canonical failed receipt/log as red evidence. No artificial long timer or assertion that mirrors the implementation.
- Run one meaningful focused target check using canonical capture preload, CI=true, current candidate SHA, fresh private GEOMETRY_OUT, and verified effective 5000 ms deadline. packages/db/test/preload.ts sets 30 seconds for only the first test file, so a naive one-file command is not equivalent. Use an existing first-file anchor before the target, verify output order/selection, and do not alter the repository preload or test deadline. If the requested equivalent execution cannot be established, report the gap instead of presenting a 30-second pass as equivalent.
- Use narrow lint/type/whitespace checks needed for changed TSX. Avoid another full suite in parallel; root will run canonical full22 after this source task is independently reviewed and current run completes.
- Report exact commands, environment choices that affect timing (no secret values), results and the remaining canonical full-CI obligation. Any test failure is recorded before diagnosis; no automatic retry.

Commit the source change and plan with [skip ci]. Write .superpowers/sdd/2026-11-25-te-live-thread-ci-sync/task-1-report.md with status, commit, file scope, source mechanism, exact tests/logs and limitations. Return concise DONE/commit/tests/concerns. No push, release or provider acceptance claim.
