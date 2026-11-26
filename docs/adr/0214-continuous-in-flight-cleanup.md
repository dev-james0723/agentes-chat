# Continuous in-flight cleanup: lifecycle, leases, deterministic decisions and review

Status: Accepted. Builds on ADR 0197 (agents register their files) and ADR 0201 (capture budgets and approved cleanup).

## Context

ADR 0201 removes scratch only after a task ends and a person approves the exact files. On computers where many agents build, test and capture at once, scratch piles up during the work, long before any task ends, and a person approving every file does not scale. What was missing:

- No way for an agent to say a file is complete, that another agent or a later stage still needs it, or that it is done with it.
- No owner for "may this be removed now": a lease, a version, a reservation, a journal.
- No place for the files nobody can decide on safely, and no switch to stop it all at once.

The rule that deletion never rests on a model's or a file's own word stays.

## Decision

1. **Lifecycle.** A registered file (`run_files`) has a `state` (`created`, `writing`, `sealed`, `released`, `reserved`, `deleted`, `review`, `protected`, `kept`, `archived`, `relocated`, `failed`, `unknown`) and a `version`. Every change names the version it saw and is journaled in `artifact_transitions` (unique per file and version): two writers never both win.
2. **Leases.** `artifact_leases` hold who writes (`write`), reads (`read`) or will need a file in a later stage (`future`), with a heartbeat and an expiry (15 minutes; a day for `future`, since a later stage is usually a later run). A read or write lease of a run that ended is released (the run can no longer read it); a `future` lease is not. A file is one path on one computer however many runs registered it: leases, pins and protections on any of its registrations count for all of them, and another registration still being written, pinned, decided or under review keeps it. A role change bumps the version, so a collector holding the old decision can't reserve it. A lease whose heartbeat stopped while its run is open becomes `expired`, which proves nothing: the file goes to review.
3. **Agent events.** A tool, `file_lifecycle`, beside `register_files`, offered wherever an agent has a computer (so every new agent has it): `seal` (only the maker), `read`, `future` (with its stage), `release`, `heartbeat`, `pin` (any agent; only a person undoes it). Each event is a few rows and asks for a collector cycle on that computer, coalesced over five seconds. Agents never wait on cleanup.
4. **Decisions.** `decide` (`storage-decision.ts`) is a pure function of registry facts, in a fixed order; the first rule that applies wins. Outcomes: `KEEP`, `PROTECT`, `RELEASE`, `DELETE`, `DEFER`, `REVIEW`, `ARCHIVE`, `RELOCATE` (the last two are only suggested or asked by a person; the collector never moves files). Protection comes first: a protected path (keys, settings, Git, caches, build state, simulators, databases, disk images, source code by extension), a deliverable, evidence, a person's protection or a pending review. Storage pressure never changes a protection. No model takes part.
5. **What may go without a person.** Only `scratch` or `derived`, sealed by its maker at least 60 seconds ago, with no open lease and no expired one, not called a keeper by any other registration of the same file, on a known macOS or Linux computer, inside a folder a person authorized (`storage_scopes`), with the collector switched on.
6. **Authorized folders.** A person with `configure` authorizes a relative folder on one computer. It starts in `shadow`: the collector records what it would remove (`file_cleanups.shadow`) and sends nothing to the computer. `enforce` removes. A protected folder can't be authorized. Overlapping folders take the cautious mode.
7. **Removal.** The collector reserves each file in one statement (version, state, no open or expired lease on any registration of the path, no blocking registration checked together), checks the claim again right before the computer is asked (a pin, a lease or a decision since then releases it), then sends the agent's computer ADR 0201's `CLEANUP_SCRIPT`, under `nice`, with a shorter settle time (60 s) and each file's seal time as its `notAfter`. The computer repeats every ADR 0201 check: no symlink on the way, same disk, one link, size and hash as registered, unchanged since sealed, not tracked or un-ignored in Git, open in no program, still the same inode when unlinked. Receipts are `file_cleanups` rows with `source` `auto` or `review`; the person who authorized the folder or approved the file is the row's approver.
8. **Budgets and modes.** Each cycle starts with the files it looked at least recently (`gc_checked_at`), so files that stay never starve newer ones. Normal: 50 files, 256 MiB, a few seconds a cycle. Elevated (disk `low`) and critical (`critical`) take more files a cycle; a person can hold cleanup back for the agents (`performance`: 10 files). Modes change effort, never protection.
9. **Review.** Uncertain files (unknown role, an expired lease, the computer refusing) become `storage_review_items`. Nothing under review is removed. A person keeps, protects, asks to archive, approves deletion (still checked again on the computer, still never a deliverable, evidence or protected path) or undoes a decision, one or many at a time; every decision is kept in the item's history. A removed file comes back only from a copy (the Drive).
10. **Recovery.** A reservation older than 15 minutes goes back to `released`; the next cycle reserves it again and the computer answers (`skipped` when it is already gone). An unclear answer leaves the file `reserved` and uncounted. Nothing is assumed removed.
11. **Receipts.** Each cycle that touched a run's files leaves one quiet notice (`cleanup_receipt`) in that run's conversation: it wakes nothing and is never news. Figures on the Storage page are kept apart: files unlinked, their registered (logical) size, the blocks the computer measured, and the disk's free-space change counted once per round.
12. **ADR 0201's approvals respect it.** An approved cleanup refuses a file that was since pinned, kept, put under review or claimed, or that an agent holds a lease on.
13. **Kill switch.** `storage_gc_settings.enabled` false stops every removal at the next cycle.

Migration 0287 runs in the migrator's single transaction, so its `ALTER TABLE`s, the CHECK validation and the index on `run_files` hold `run_files` and `file_cleanups` locked until it commits. Both tables are young (ADR 0197, 0201) and small; the deploy rehearsal on a copy of production measures the window before the real migration runs.

A reader that takes a lease withdraws a collector's pending claim on the file. The only window left is between the final check and the computer receiving the command; the computer's own open-file check covers a reader that is actually reading. A file still settling gets its own later cycle.

## Consequences

- Scratch is cleaned while the work goes on, but only where a person authorized it, and first in shadow.
- An agent that never seals or releases its files gets ADR 0201's behaviour: nothing is removed until a person approves.
- The collector runs commands as the agent on its computer while the agent works; it is low priority and bounded, and it waits for an offline computer.
- Archive and relocation are recorded as requests; moving bytes elsewhere is left to a later decision.
- Windows computers are not cleaned, as before.
