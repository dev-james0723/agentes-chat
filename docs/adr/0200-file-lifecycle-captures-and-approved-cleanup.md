# Agents' file lifecycle: capture budgets, evidence snapshots and approved cleanup

Status: Accepted. Builds on ADR 0197 (agents register their files, ended tasks get a dry-run report).

## Context

ADR 0197 gave agents a way to say what each file they made is for, and gave every ended task a report of what could be cleaned. Three things were still missing:

- Nothing stopped an agent from taking a screenshot on every step or recording on a disk that was nearly full. A full disk stops every agent on that computer.
- The report listed files but could not say which evidence could actually be brought back. A list of names is not a backup.
- Nothing ever acted on the report. Temporary files stayed until someone cleaned the computer by hand, by folder name, which loses deliverables and evidence.

The deletions must never rest on what a model or a file says on its own. Measurements on these computers also showed that a file's size is no measure of what removing it frees: only the disk's free space before and after is.

## Decision

1. **Disk levels.** A computer's free space, as its runner reports every five minutes (`machines.load`), reads as `ok`, `low` (under 30 GB or 95% used), `critical` (under 15 GB or 98% used) or `unknown` (never measured, or over a day old): `storage-pressure.ts`. On `critical`, `browser_screenshot`, `desktop_screenshot` and `phone_record` are refused before they write anything. On `low` their answer says space is short. Nothing is deleted to make room.
2. **Capture budgets.** A run may take 60 screenshots. Every screenshot or recording a tool saves is registered for the run on its own (`recordCapture`, role `unknown`, `run_files.captured_by` naming the tool), with its size and, when the bytes pass through the server (a desktop screenshot), its SHA-256. Role `unknown` keeps it until the agent says what it is for. The agent registering the file again keeps the mark, so the budget can't be reset.
3. **Evidence snapshot.** The report now carries a snapshot of the task's deliverables and evidence. A Drive file is `restorable`: its bytes are kept with their SHA-256, and `import_file` brings them back checked. A file only on the computer is `manifestOnly`: listed, not backed up. Files with the same SHA-256 are marked `sameAs` the first one. Looking alike is never the same, and a duplicate is never a reason on its own to delete.
4. **Approved cleanup.** A person with `configure` approves cleaning a report's candidates, all of them or by path, in Settings › Storage › Clean workspace (`POST …/clean-workspace/{reportId}/approve`). Only `scratch` and `derived` files the report lists as candidates, registered on a known computer, can be approved. The computer is the one the run's tools used: `register_files` takes the same `computer` as the other computer tools, and captures record the computer they ran on (`run_files.machine_id`). A file another run of the same work registered as a deliverable, evidence or unknown is kept in the report itself. Each approval is a `file_cleanups` row for one registration: its run and path. The `files.cleanup` job then:
   - claims its rows first (`running`), so two jobs never send the same file; a claim a stopped server left behind is checked again after 15 minutes;
   - refuses every row when the task or mission was reopened; any row whose own registration is no longer scratch or rebuildable on that computer; any row whose file another piece of work by the agent calls a deliverable, evidence or unknown; and any row whose file was registered again after the report was written;
   - sends nothing to a computer that is not macOS or Linux (a Windows runner runs `cmd.exe`, where POSIX quoting means nothing);
   - waits while the agent has a run in progress or its computer is offline;
   - sends the computer one `exec` as that agent, in its folder, approved by the person's approval (`CLEANUP_SCRIPT`, Python with `-I`, the files as one base64 argument, so the shell sees nothing an agent chose). On the computer, every file must be a plain relative path; outside `.git`, `node_modules` and folders of keys and settings (`.ssh`, `.aws`, `.config`…); not a hidden file, nor a database, disk image, key, backup or secret by its name; reached folder by folder without following a link or crossing to another disk; a regular file with a single link; unchanged for ten minutes and since the report was written; with the size and hash it was registered with; not tracked, and not un-ignored, in a Git work tree; open in no program, checked under the name the folder really holds, so another case or Unicode spelling can't slip past (`lsof`, else Linux's `/proc`, else nothing is removed); and still the same device, inode, size and mtime at the moment it is removed by that name in the folder it was opened from;
   - removes at most 200 files per job, and 2 GB measured on the computer (one larger file may go alone); the rest wait for the next job;
   - records each outcome with its reason (`done`, `skipped` when already gone, `blocked`, `unknown` when the answer was unclear) and the disk's free bytes before and after the round, once writes settle. A row is written only while its job holds it, so a `done` is never overwritten. An `unknown` row is checked again by the next job, never assumed.
5. **One line for agents.** `FILES_GUIDANCE` now also states the screenshot budget, that evidence meant to last goes to the Drive, and that only scratch is ever cleaned, by a person's approval.
6. **No new notification.** The disk alert stays `computer_disk_full`. The page is where cleanups are approved and their receipts read.

## Consequences

- Nothing is ever cleaned without a person approving the exact files, and nothing an agent did not register as scratch or rebuildable can be approved.
- A computer without `python3` cannot clean: its rows end `unknown` with that reason. Windows computers are not cleaned.
- Free bytes before and after belong to the round, not to one file: every row of a round carries the same pair.
- An untracked file inside a Git work tree is kept unless Git ignores it: it may be someone's only copy.
- The free-space figures are the disk's, with every other process on it. They are what a cleanup can honestly claim, and they can move for other reasons.
- Files from before this decision have no computer recorded and are never cleaned.
- Mission tasks' executors still have no run of their own and cannot register files (ADR 0197).
