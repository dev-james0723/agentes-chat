import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, eq, isNull, schema } from "@agenteschat/db";
import { recordAudit } from "./audit";
import { publishAgentsChanged } from "./events";
import { requirePermission } from "./organizations";
import { parseSkillMarkdown, validateSkill } from "./skills";

/** The skill's name (ADR 0199). */
export const TEAM_COMMUNICATION_SKILL = "team-communication";

/**
 * How agents talk with their teammates and the people they work for (ADR 0199), as an ordinary `SKILL.md` (ADR 0020):
 * the product writes it, a workspace installs it, and from then on it is the workspace's own skill, which people and
 * agents (ADR 0120) may change. Its words follow the tools agents really have: `tell_agent` and `ask_agent` (ADR 0034,
 * 0095), mentions (ADR 0095 addendum), "# Work you handed off here", and `hand_off` for routines (ADR 0047).
 */
export const TEAM_COMMUNICATION_SKILL_MD = `---
name: ${TEAM_COMMUNICATION_SKILL}
description: >
  How to talk with teammates and the people you work for. Load it before you hand work to a teammate (tell_agent,
  or an @mention of an agent), ask a teammate or a person for help (ask_agent, a question), post a status update
  or a result, when you are blocked, and when work you handed off comes back. Covers what a hand-off must carry
  (done, left, evidence), whom to mention, keeping updates short, saying what is not verified and closing the loop.
---
# Team communication

Write every message so its reader can act on it without asking you a question back. Six habits:

## 1. Hand off: done, left, evidence

A teammate you hand work to (\`tell_agent\`, or an @mention in a channel) does not see this conversation. The note
must stand alone:

- **Goal**: what the person wants and why, in one line.
- **Done**: what you already did, with links, file paths, ids and numbers.
- **Left**: exactly what the teammate should do, and what "done" looks like.
- **Evidence**: what you checked and how (a test run, a query, a page), and what you did not check.
- **Limits**: deadlines, approvals still needed, what not to touch.

Give the whole job to the one teammate whose role owns it, with everything it needs, and let it bring in others.
Don't send heads-ups to teammates that only have to wait.

## 2. Ask for help when blocked

You are blocked when you already tried another way (another tool, source or wording) and still can't move. Then ask
at once; don't go quiet or end with "I'll keep trying".

- A teammate holds the access, the knowledge or the role: \`ask_agent\` with one question that stands alone, what you
  tried and the exact error.
- A person, only for what only a person can give (a decision, an approval, a key, a payment): one message with the
  choice, your recommendation and what happens meanwhile.
- Keep doing the parts that don't depend on the answer, and say which those are.

## 3. Short status updates

- First line: the state. Done, in progress, blocked, or waiting on someone (name them).
- Then at most three points: what changed, what comes next, what you need and from whom.
- No restating the request, no list of the tools you called, no filler. Numbers, ids and links instead of adjectives.
- Write in the language the person writes to you.

## 4. Mention the right teammate

- An @mention of an agent starts its work. Mention one only when you want it to act now, and only the teammate
  whose role fits (check the team and its roles). Mention a person only when they must decide or act.
- One mention per request. To only refer to someone, write the name without the @.
- When you aren't sure who owns it, say whom you think and why instead of mentioning several.

## 5. Say what is not verified

Keep what you checked apart from what you assume:

- **Verified**: what you saw yourself, and how (ran the test, read the page, queried the data).
- **Not verified**: what you inferred, what a teammate reported and you did not check, what you couldn't reach.

Never call something done, fixed, sent or deployed unless a tool result shows it. A teammate's report is evidence of
what it said, not of the result: relay it as its report.

## 6. Close the loop when a hand-off comes back

What you handed off comes back to you by itself (it is listed under "Work you handed off here"): don't chase it or send
it again. When it comes back:

- Check the result against the "done" you set. If something is missing, hand back only the gap, once, saying what is
  missing.
- Tell the person who asked in one short message: the outcome, its evidence, and what is still open or not verified.
- If it failed or can't be done, say so with the next step. Never let it go quiet.
- When you are the one who was handed work, your answer is what goes back: start with done, partly done or couldn't,
  then the evidence, then what is left.
- A routine reaches people only through \`hand_off\`: write that message the same way as section 1.
`;

/**
 * Installs the team communication skill (ADR 0199), for who manages agents: once, marked "default for new agents" and
 * turned on for every active agent of the workspace, the right hand included. Running it again never rewrites the
 * skill (people and agents may have changed it) and turns it on only for agents that never had it: an agent someone
 * turned it off for stays off.
 */
export async function installTeamCommunicationSkill(
  deps: { db: Database; pubsub?: PubSub },
  actorId: string,
  orgId: string,
): Promise<{ skillId: string; installed: boolean; enabledFor: string[] }> {
  await requirePermission(deps.db, actorId, orgId, "manage_agents");
  const parsed = parseSkillMarkdown(TEAM_COMMUNICATION_SKILL_MD);
  validateSkill(parsed);
  const { agentSkills, agents, skills } = schema;
  const out = await deps.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    const [existing] = await db
      .select({ id: skills.id, deletedAt: skills.deletedAt })
      .from(skills)
      .where(and(eq(skills.orgId, orgId), eq(skills.slug, TEAM_COMMUNICATION_SKILL)));
    let skillId = existing?.id;
    const installed = !existing || existing.deletedAt !== null;
    if (!existing) {
      const [row] = await db
        .insert(skills)
        .values({
          orgId,
          slug: parsed.name,
          name: parsed.name,
          description: parsed.description,
          body: parsed.body,
          metadata: parsed.metadata,
          source: "manual",
          defaultForNewAgents: true,
          createdByUserId: actorId,
        })
        .returning({ id: skills.id });
      if (!row) throw new Error("skill insert returned nothing");
      skillId = row.id;
    } else if (existing.deletedAt) {
      // Removed before: it comes back with the text it had and its agents' choices.
      await db
        .update(skills)
        .set({ deletedAt: null, defaultForNewAgents: true, updatedAt: new Date() })
        .where(eq(skills.id, existing.id));
    }
    const id = skillId as string;
    if (installed) {
      await recordAudit(db, {
        orgId,
        actor: { type: "person", id: actorId },
        action: "skill.installed",
        target: { type: "skill", id },
        details: { name: parsed.name, via: "team_communication" },
      });
    }
    const active = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.orgId, orgId), isNull(agents.archivedAt)));
    const added =
      active.length === 0
        ? []
        : await db
            .insert(agentSkills)
            .values(active.map((a) => ({ orgId, agentId: a.id, skillId: id, enabled: true })))
            .onConflictDoNothing({ target: [agentSkills.agentId, agentSkills.skillId] })
            .returning({ agentId: agentSkills.agentId });
    const enabledFor = added.map((a) => a.agentId);
    if (enabledFor.length > 0) {
      await recordAudit(db, {
        orgId,
        actor: { type: "person", id: actorId },
        action: "skill.turned_on",
        target: { type: "skill", id },
        details: { name: parsed.name, agentIds: enabledFor },
      });
    }
    return { skillId: id, installed, enabledFor };
  });
  // An open agent page saves its whole list: it reads the new one first.
  if (out.enabledFor.length > 0) await publishAgentsChanged(deps.pubsub, orgId);
  return out;
}
