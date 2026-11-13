import { expect, test } from "bun:test";
import { createSkillToolSource } from "../src/skill-tools";
import { saveSkill, setAgentSkills } from "../src/skills";
import type { ToolContext } from "../src/tools/types";
import { setup } from "./fixtures";

test("a subsequent native load refuses a revoked skill with no model call", async () => {
  const f = await setup();
  try {
    const deps = { db: f.db, blobs: f.artifactDeps.blobs };
    const skill = await saveSkill(deps, f.owner.id, f.org.id, {
      name: "scoped-proof",
      description: "Synthetic permission proof",
      body: "fixture-only-body",
      metadata: {},
      source: "manual",
    });
    await setAgentSkills(f.db, f.owner.id, f.org.id, f.agent.id, [{ skillId: skill.id, enabled: true }]);
    const ctx: ToolContext = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: crypto.randomUUID(),
      channelId: f.general.id,
      threadRootId: crypto.randomUUID(),
      triggerMessageId: crypto.randomUUID(),
    };
    const tools = await createSkillToolSource(deps).tools(ctx);
    const load = tools.find((t) => t.name === "load_skill");
    if (!load) throw new Error("native load missing");
    expect((await load.execute({ name: "scoped-proof" }, ctx)).content).toContain("fixture-only-body");
    await setAgentSkills(f.db, f.owner.id, f.org.id, f.agent.id, [{ skillId: skill.id, enabled: false }]);
    const revoked = await load.execute({ name: "scoped-proof" }, ctx);
    expect(revoked.isError).toBe(true);
    expect(revoked.content).not.toContain("fixture-only-body");
    expect(f.provider.calls).toHaveLength(0);
  } finally {
    await f.close();
  }
});
