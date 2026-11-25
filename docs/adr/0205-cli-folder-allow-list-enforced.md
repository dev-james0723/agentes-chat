# 0205. The machine's folder allow-list binds every coding CLI, when the owner turns it on

- Status: Proposed
- Date: 2026-11-19
- Builds on: ADR 0025 (connected computers), ADR 0036 §8 (folders and tools on the machine), ADR 0053 §3 (commands and the prompt tool), ADR 0058 (agent desktops and terminals)
- Changes: the runner's `readsOnlyInFolders` switch (added off by default with the per-CLI enforcement in Claude Code, Codex and Grok Build) now binds every CLI when on; it stays off unless the owner sets it to `true`
- Code: `apps/server/runner/config.ts` (`foldersEnforced`), `daemon.ts`, `folder-boundary.ts` (`outsideFolders`), `mcp.ts` (`permissionPrompt`, `claudePermissionSettings`, `AGENTES_MCP_CONFINED`), `brain.ts`, `handlers.ts`; tests `apps/server/test/runner/folder-boundary.test.ts`, `read-boundary.test.ts`, `brain-cursor.test.ts`

## Context

A person allows an agent its own folder and, on the machine, more folders (ADR 0036 §8). The runner's own file tools (`resolveForAgent`) always kept to that list. The coding CLIs that run an agent's turns did not: Claude Code's Read tool, its shell, Codex's commands, Cursor, OpenCode and Antigravity could read, and some write, any file the runner's OS user can reach, the person's whole home included. Each CLI's own enforcement was added behind `readsOnlyInFolders`, but off unless the owner edited `config.json`, so on every machine the list did not bind the CLIs at all.

What each CLI can enforce (checked 2026-11-19 against the installed versions):

| CLI | Version | Enforcement | Proven |
|---|---|---|---|
| Codex | 0.166.0 | A permission profile replaces `--sandbox`: the system reads, `/Users` and `/Volumes` (Linux: the homes and mounts) are hidden, the turn's folders are written (read in plan turns), temp is written, no network. Seatbelt applies it to every command and to Codex's file helper. `codex exec` never asks for approval. | On this Mac through `codex sandbox` with the profile the runner builds: read, write and symlink escapes outside are `Operation not permitted`, the agent's and granted folders work, a folder left out of the next turn's profile is refused. |
| Claude Code | 2.1.326 | `blockReadsOutsideWorkingDirectories` and `blockWritesOutsideWorkingDirectories` in the turn's `--settings` for its file tools; any shell command naming a path outside the working directories is asked about, and our prompt tool refuses it (below). | Settings and the prompt tool by tests; no live model turn. Its shell is not OS-sandboxed: a program the agent runs can still open a path it was not given on the command line. |
| Grok Build | 1.0.70 | `--sandbox strict`: reads the working folder, system paths and its own home; writes there, its sessions and temp. Granted folders other than the working folder stay unreadable (stricter than the list). | Arguments by tests; the profile's limits are Grok's documented ones, not exercised live. |
| Cursor, OpenCode, Antigravity | 2026.10.22, 1.19.5, 1.5.12 | None that covers reads: Cursor's sandbox reads anywhere, OpenCode has no sandbox and checks only some shell commands, Antigravity's sandbox covers its terminal only. | Refused, by test. |

## Decision

1. **Opt-in (amended 2026-11-19).** `foldersEnforced(config)` is true only when `config.json` says `"readsOnlyInFolders": true`; absent or `false`, agents work as before this decision: nothing below refuses a call, no CLI is held to its folders and nobody is asked to allow a folder. The owner's value is kept through pairing again. First this decision made the list on by default; the computer's owner chose not to have agents limited or asking for folder access, so it is the owner's switch. Everything below applies when it is on.
2. **Claude Code's shell at the runner's boundary.** With the list in force, the prompt tool's scope carries the turn's folders (`AGENTES_MCP_CONFINED`: the working folder, the agent's folder and its grants). `outsideFolders` runs before everything else the prompt tool decides, so no plain-read allowance, rule or person lets a call out: a call is refused when a path it names, as written or after its links are followed, is in people's files (the homes and volumes, and the person's home) but in none of those folders. Every word of a command is checked, bare names included (a link in the folder that leads out is refused), flag values (`--input=/path`), redirections, and, for a line that can't be read word by word, any absolute path, `~` or `$HOME` in its text. System paths and temp stay readable, as in Codex's profile.
3. **Fail closed.** With the list on, Cursor, OpenCode and Antigravity run no `plan` or `work` turn: the turn is refused (`not_allowed`) with what to do (another CLI, or the owner turns the limit off). `chat` turns, which have no file or shell tool, still run.
4. **Revocation on the next call.** Grants are read per request (`realFoldersFor`). A Claude Code process is replaced when its folders change (its signature holds them), with new `--add-dir`s and a new prompt-tool scope; Codex and Grok start per turn with that turn's folders. A folder taken back is refused on the next call. A command already running when it is taken back is not stopped.

## Consequences

- Toolchains: a fixed list of toolchain folders in the home (`CODEX_TOOLCHAINS`: `~/.bun`, `~/.cargo`, `~/.rustup`, `~/.nvm`, `~/.local/bin`; on Linux also Homebrew's `/home/linuxbrew/.linuxbrew`) is read and run from in Codex's profile, never written; on macOS Homebrew is outside the hidden roots already. Nothing else of the home is opened. A tool elsewhere in the home, or a link in `~/.local/bin` whose target is elsewhere in the home, still fails; the owner can allow that folder or turn the limit off.
- Off by default, no agent changes behaviour until an owner turns the list on. Where it is on, agents on Cursor, OpenCode or Antigravity (in use: Antigravity ran 19 times in 7 days on the live server) stop until they move to Claude Code, Codex or Grok Build or the owner turns the list off; turning it on is the owner's choice to have them stop.
- Not covered: Claude Code's shell running a program that opens an unnamed outside path; background tasks (`tasks.ts`); system mode, where each agent is its own OS user and the OS already keeps it out of others' files; Windows (no Codex profile there, and `outsideFolders` checks POSIX paths only).
- A later step can move Claude Code's shell into its own sandbox (`sandbox.enabled`, `allowUnsandboxedCommands: false`) once its network limits fit agents' work (it confines every command's network to listed domains).
