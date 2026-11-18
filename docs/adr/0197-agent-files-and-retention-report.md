# Agents' files and the retention report

Status: Accepted (first stage: records and dry-run reports only, nothing is deleted).

## Context

Agents with a computer leave files behind: deliverables, screenshots and logs that prove a check passed, scratch frames, build output. The server knows about the files that reach the Drive (each version records its run, size and SHA-256), but nothing about the rest. Cleaning a computer by folder name alone guesses at what a file is for, and a wrong guess loses evidence or a deliverable.

Two measurements shaped the rules. Removing stale build output frees real space. Removing dependency folders (`node_modules`) frees almost none, even when `du` reports gigabytes, because APFS shares their blocks between copies. A file's size is no measure of what a cleanup gives back; only free space measured before and after is.

## Decision

1. **Agents register what they made.** `register_files` (scope-free, every agent) records, per run, a workspace-relative path, a kind (`image`, `video`, `html`, `markdown`, `log`, `build`, `other`; from the extension when not given) and a role: `canonical` (the deliverable), `evidence`, `scratch`, `derived` (can be made again) or `unknown`. Rows go in `run_files` (one per run and path, updated in place). Absolute paths and `..` are refused. The run policy reads it as the agent's own bookkeeping (`self`): it changes nothing on disk or elsewhere.
2. **Agents with a computer get one short line** in their tool guidance (`FILES_GUIDANCE` in `capabilities.ts`): deliverables where the task asks, scratch apart, screenshots at a meaningful change or a check, a length and size limit before recording, and `register_files` at hand-off. The rules themselves live in code, not in every prompt.
3. **A task or a mission that ends writes a dry-run report.** When an issue's status changes to `done` or `canceled` (`updateIssue`, and the automatic `setWorkIssueState`) or a mission concludes (`concludeMission`), the outbox job `files.retention_report` writes one `retention_reports` row for it: every Drive file and registered file of its runs, each `keep` or `candidate` with a reason. Drive files, deliverables, evidence, unknown roles and dependency folders are kept; only `scratch` and `derived` files are candidates. A file nobody registered is not listed at all, so it can never become a candidate. The job is idempotent: running it again rewrites the same row.
4. **No new notification.** Computers already raise `computer_disk_full`; the report is a record people and agents read, not an alert.

## Not in this stage

Deleting anything. A later stage may delete only files an agent registered as `scratch` in its own runs, once the task is terminal, nothing references them and no other work holds them, judged by the task's state and the agent's identity on the server (never by a key file on the computer), with a receipt and free space measured before and after. That stage needs its own decision and review.

## Consequences

- One table per concern: `run_files` for what agents declared, `retention_reports` for the latest report of each task or mission. Both carry `org_id` and go with the organization.
- An agent that never registers anything costs nothing and loses nothing: its report lists its Drive files as kept.
- The report's byte count of candidates is an upper bound, not a promise of free space.
