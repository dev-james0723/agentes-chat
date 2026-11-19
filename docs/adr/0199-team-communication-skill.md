# 0199. A team communication skill the product writes and a workspace installs

- Status: Proposed
- Date: 2026-11-18
- Builds on: ADR 0020 (skills), ADR 0034 and 0095 (asking and handing work between agents), ADR 0047 (routines speak through `hand_off`), ADR 0120 (agents improve skills), ADR 0137 (the right hand)
- Code: `packages/engine/src/team-communication-skill.ts` (`TEAM_COMMUNICATION_SKILL_MD`, `installTeamCommunicationSkill`), `apps/server/scripts/team-communication-skill.ts` (`bun run skills:team-communication`), test `packages/engine/test/team-communication-skill.test.ts`

## Context

A workspace owner with about a dozen agents asked for them to communicate better, with each other and with the people they work for. What goes wrong is how messages are written, not how they are delivered: ADR 0095 already tracks every hand-off and brings its result back once, and the router and mentions (ADR 0074, 0095 addendum) already reach the right agent. What is missing is a shared habit for what a message carries:

- A hand-off that says what to do but not what was already done, nor what was checked.
- Silence when an agent is blocked, or a person asked a question a teammate could have answered.
- Long status updates that retell the request and list tool calls.
- Mentions of several agents "just in case", each starting a run.
- "Done" and "fixed" with nothing behind them, a teammate's report relayed as a fact.
- A result that came back and was never told to the person who asked.

The agents' prompt ("# How you work", the `tell_agent` and `ask_agent` descriptions) already holds some of these rules, spread out and always on. A workspace can't adjust them, and they don't say what a good hand-off looks like.

## Decision

### 1. One skill, `team-communication`

The product ships one `SKILL.md` (ADR 0020 format), text only, no files, in `team-communication-skill.ts`. Six sections, each a few lines:

1. **Hand off: done, left, evidence.** The note stands alone: goal, what's done (links, paths, ids), what's left and what "done" looks like, what was checked and how, and limits (deadlines, approvals, what not to touch). The whole job to the one teammate whose role owns it; no heads-ups to teammates that only wait (the same rule as `tell_agent`).
2. **Ask for help when blocked.** Blocked means another way was already tried. Then ask at once: `ask_agent` for what a teammate holds, a person only for what only a person gives (decision, approval, key, payment) with a recommendation; keep doing what doesn't depend on the answer.
3. **Short status updates.** The state first (done, in progress, blocked, waiting on whom), then at most three points; no retelling, no tool lists; in the person's language.
4. **Mention the right teammate.** A mention starts work: one, for the teammate whose role fits, only to act now; a name without @ to only refer to someone; say whom you think owns it instead of mentioning several.
5. **Say what is not verified.** "Verified" (seen, and how) apart from "Not verified" (inferred, reported by a teammate, unreachable). Nothing is done, fixed, sent or deployed without a tool result; a teammate's report is relayed as its report.
6. **Close the loop when a hand-off comes back.** Don't chase what ADR 0095 brings back; check it against the "done" you set, hand back only the gap, tell the person the outcome with evidence and what is open; a failure is said with the next step. The agent that was handed work answers done / partly done / couldn't, then evidence, then what's left. A routine's `hand_off` is written like a hand-off.

One skill rather than six: the moments overlap (a hand-off coming back is also a status update), the whole body is about 1,000 tokens, and one line in "# Available skills" costs less on every turn than six. Its description names the moments it is for (`tell_agent`, `ask_agent`, an @mention, a status, being blocked, a hand-off coming back), since agents load a skill when the task matches its description.

The text names no workspace's people or agents (every file is public), and says nothing a tool contradicts: results come back by themselves, a thanks needs no answer, routines speak only through `hand_off`.

### 2. A workspace installs it; then it is the workspace's own

`installTeamCommunicationSkill(deps, actorId, orgId)`, for who manages agents (`manage_agents`), in one transaction:

- Creates the skill (`source` `manual`, version 1, `defaultForNewAgents` true) when the workspace has none by that name, and records `skill.installed` (`via: team_communication`). A removed one comes back with the text it had.
- Turns it on for every active agent, the right hand included (it loads skills like any agent and is the one most often handing work on), with one insert that skips any agent that already has a row: an agent someone turned it off for stays off. Records `skill.turned_on` with the agents, and tells open apps (`agents.changed`).
- Never rewrites an existing skill's text. Once installed it is an ordinary skill of the workspace: people edit it in Skills, and agents improve it with `update_skill` while "Agentes melhoram as skills sozinhos" is on (ADR 0020, 2026-11-03), with the usual history and Desfazer.

Agents made later get it through "default for new agents" (`createAgent`), like any default skill.

### 3. How a workspace gets it

`bun run skills:team-communication --org <workspace id> [--as <user id>]` (`apps/server/scripts/team-communication-skill.ts`) for the people who run the server, acting as an owner of the workspace by default. Running it twice changes nothing. A person can also write the same skill by hand in Settings › Skills and turn it on per agent.

## Consequences

- No new table, migration, scope, env var or model call. A turn reads one more line in "# Available skills"; a turn that loads it spends about 1,000 tokens through the Model Gateway like any skill.
- Existing workspaces get nothing until someone runs the install: it changes what their agents read, so it is their call. New workspaces don't get it by themselves either.
- The product's text and a workspace's copy drift apart by design: a later product version of the text doesn't reach a workspace that installed an earlier one.
- Whether it changes how agents write is not measured here: the evals (`bun run eval:behavior`, `eval:mentions`) are manual and weren't run for this. The unit test checks the skill parses, passes the limits, covers the six sections and names no one, and the install's rules.

## Alternatives considered

- **More lines in "# How you work"**: every agent of every workspace reads them on every turn, a workspace can't change them, and that block is already long. A skill loads only when it matters and belongs to the workspace.
- **Six small skills**: six lines on every turn, and a hand-off would need two or three of them loaded.
- **Installing it in every workspace by a migration**: changes what every workspace's agents read without anyone asking.
- **A button in Skills (web and phone)**: the natural next step once the text has proven itself; it needs words in every language and both apps.
- **A link to the skill in a public repository** (Import from GitHub): works today, but keeps the text outside the product's tests.
