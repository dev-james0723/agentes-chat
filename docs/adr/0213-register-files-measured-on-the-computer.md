# Registered files are measured on the computer

Status: Accepted. Builds on ADR 0197 (agents register their files) and ADR 0201 (capture budgets, evidence snapshots and approved cleanup).

## Context

A live run on 2026-11-25 showed that agents rarely pass `size` or `sha256` to `register_files`. Without a hash the report can't mark two identical screenshots as the same file, and a cleanup can only check the size before removing a file. A value an agent types is also only a claim.

## Decision

1. When an agent registers files on a known macOS or Linux computer, `register_files` first runs one read-only command there, in the agent's folder (`MEASURE_SCRIPT`, Python with `-I`, the paths as one base64 argument). It runs under the computer's command policy like any other command and is never approved on the agent's behalf.
2. For each path the script opens the folders one by one without following a link and keeps regular files only. It hashes up to 2 GB per file and 4 GB per call. Above that, a file gets its size only. A hidden file, or one under a hidden folder, gets its size only, because the hash of a short secret could give it away.
3. What the computer read replaces what the agent typed. Whatever it couldn't read stays as given. If the command can't run (no `python3`, the policy held it, the computer is offline, Windows), the files are registered as before.
4. The answer to the agent says how many files were measured.

## Consequences

- Reports now mark true duplicates (`sameAs`), and a cleanup checks the SHA-256 it was registered with before removing a file.
- Registering costs one extra command on the computer, bounded at 60 seconds.
- Files over the limits, hidden files and files on Windows computers still have no hash. A cleanup then checks size and identity only, as before.
