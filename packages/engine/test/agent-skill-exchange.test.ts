import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { and, eq, schema, sql } from "@agenteschat/db";
import { systemText } from "@agenteschat/providers";
import {
  createAgent,
  insertMessage,
  promoteHowTos,
  recordContextUse,
  recordOutcome,
  setLearningApprovalSettings,
  type ToolContext,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

setDefaultTimeout(45_000);
let f: Fixture;
afterEach(async () => {
  await f?.close();
});

async function fixture(shareWith?: string[]) {
  f = await setup({
    contextTools: true,
    skillTools: true,
    reply: (req) => {
      if (!systemText(req.system).includes("saved how-to notes into one reusable skill")) {
        throw new Error("unexpected inference request");
      }
      return {
        chunks: [
          JSON.stringify({
            name: "release-checklist",
            description: "Verify a release checklist after independently tested changes.",
            body: "Check the release readiness twice.",
            ...(shareWith ? { shareWith } : {}),
          }),
        ],
      };
    },
  });
  await f.db
    .insert(schema.organizationSettings)
    .values({ orgId: f.org.id, agentsImproveSkills: true })
    .onConflictDoUpdate({
      target: schema.organizationSettings.orgId,
      set: { agentsImproveSkills: true },
    });
  await setLearningApprovalSettings(f.db, f.owner.id, f.org.id, {
    autoApproveLearning: false,
    autoShareLearnedSkills: true,
  });
  const peers = [];
  for (const [name, handle] of [
    ["Cecil", "cecil"],
    ["Diana", "diana"],
    ["Elliot", "elliot"],
  ] as const) {
    peers.push(
      await createAgent(
        f.db,
        f.owner.id,
        f.org.id,
        {
          name,
          handle,
          role: "Release verification specialist",
        },
        { model: f.agent.model },
      ),
    );
  }
  return peers;
}

async function runAt(agentId: string, channelId = f.general.id): Promise<ToolContext> {
  const msg = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId,
    author: { type: "person", userId: f.owner.id },
    body: "Please apply the release checklist.",
  });
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId,
      channelId,
      threadRootId: msg.id,
      triggerMessageId: msg.id,
      trigger: "mention",
      hop: 1,
      status: "done",
    })
    .returning();
  if (!run) throw new Error("run not created");
  return {
    db: f.db,
    orgId: f.org.id,
    agentId,
    runId: run.id,
    channelId,
    threadRootId: msg.id,
    triggerMessageId: msg.id,
  };
}

async function invoke(ctx: ToolContext, name: string, input: Record<string, unknown>) {
  const result = await f.tools?.invoke(ctx, {
    toolUseId: "test-" + crypto.randomUUID(),
    name,
    input,
  });
  if (result?.type !== "result") throw new Error("Tool Gateway did not return a result");
  return result.output;
}

async function promotedSkill(beforePromotion?: () => Promise<void>) {
  const first = await runAt(f.agent.id);
  const [note] = await f.db
    .insert(schema.contextItems)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      kind: "note",
      scopeType: "agent",
      scopeId: f.agent.id,
      subjectKey: "howto release-checklist",
      content: "Check the release readiness twice.",
      channelIds: [f.general.id],
      sourceIds: [first.triggerMessageId],
      trust: "high",
      recurrence: 3,
      relevance: 0.9,
    })
    .returning();
  if (!note) throw new Error("missing source note");
  await recordContextUse(f.db, f.org.id, first.runId, [note.id]);
  const second = await runAt(f.agent.id);
  await recordContextUse(f.db, f.org.id, second.runId, [note.id]);
  await beforePromotion?.();
  const made = await promoteHowTos(f.context, f.org.id, 3);
  expect(made).toBe(1);
  const [skill] = await f.db.select().from(schema.skills).where(eq(schema.skills.origin, "agent"));
  if (!skill) throw new Error("Skill did not materialize");
  return { note, skill };
}

test("A learns from two runs, shares public Skill to C/D/E, and receivers load it natively", async () => {
  const peers = await fixture();
  const { note, skill } = await promotedSkill();
  expect(skill.ownerAgentId).toBe(f.agent.id);
  const ctx = await runAt(f.agent.id);
  const result = await invoke(ctx, "share_learned_skill", {
    name: skill.slug,
    agents: peers.map((peer) => peer.handle),
  });
  if (result.isError) throw new Error("Exchange: " + result.content);
  const body = result.data as {
    assigned: Array<{ handle: string }>;
    sourceNoteIds: string[];
    memory: { status: string; id?: string };
    wiki: { status: string; id?: string };
    peerNotes: Array<{ handle: string; status: string }>;
  };
  expect(body.assigned.map((p) => p.handle).sort()).toEqual(["cecil", "diana", "elliot"]);
  expect(body.sourceNoteIds).toContain(note.id);
  expect(body.memory.status).toBe("created");
  const [orgMemory] = await f.db
    .select()
    .from(schema.contextItems)
    .where(and(eq(schema.contextItems.id, body.memory.id ?? ""), eq(schema.contextItems.scopeType, "org")));
  expect(orgMemory?.status).toBe("active");
  expect(orgMemory?.sourceIds).toContain(note.sourceIds[0]);
  const [memory] = await f.db.select().from(schema.contextItems).where(eq(schema.contextItems.id, note.id));
  expect(memory?.status).toBe("archived");
  const assigned = await f.db.select().from(schema.agentSkills).where(eq(schema.agentSkills.skillId, skill.id));
  expect(assigned).toHaveLength(4);
  for (const peer of peers) {
    const output = await invoke(await runAt(peer.id), "load_skill", { name: skill.slug });
    if (output.isError) throw new Error("Exchange: " + output.content);
    expect(output.content).toContain("Check the release readiness twice.");
    expect((output.data as { skill?: { version: number } } | undefined)?.skill?.version).toBe(1);
  }
  const wiki = await f.db.select().from(schema.wikiPages).where(eq(schema.wikiPages.orgId, f.org.id));
  expect(wiki.some((page) => page.source?.id === skill.id)).toBe(true);
  const audit = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "skill.shared_by_agent"));
  expect(audit).toHaveLength(3);
  const notes = await f.db
    .select()
    .from(schema.agentConsultations)
    .where(and(eq(schema.agentConsultations.orgId, f.org.id), eq(schema.agentConsultations.askerAgentId, f.agent.id)));
  expect(notes).toHaveLength(3);
});

test("private reclassification denies sharing without creating peer grants", async () => {
  const peers = await fixture();
  const { skill } = await promotedSkill();
  await f.db.update(schema.channels).set({ visibility: "private" }).where(eq(schema.channels.id, f.general.id));
  const output = await invoke(await runAt(f.agent.id), "share_learned_skill", {
    name: skill.slug,
    agents: peers.map((p) => p.handle),
  });
  expect(output.isError).toBe(true);
  const grants = await f.db.select().from(schema.agentSkills).where(eq(schema.agentSkills.skillId, skill.id));
  expect(grants).toHaveLength(1);
});

test("a manually disabled grant is never silently reenabled on peer sharing", async () => {
  const peers = await fixture();
  const { skill } = await promotedSkill();
  await f.db.insert(schema.agentSkills).values({
    orgId: f.org.id,
    agentId: peers[0]!.id,
    skillId: skill.id,
    enabled: false,
  });
  const output = await invoke(await runAt(f.agent.id), "share_learned_skill", {
    name: skill.slug,
    agents: peers.map((p) => p.handle),
  });
  expect(output.isError).not.toBe(true);
  const grants = await f.db
    .select()
    .from(schema.agentSkills)
    .where(and(eq(schema.agentSkills.agentId, peers[0]!.id), eq(schema.agentSkills.skillId, skill.id)));
  expect(grants[0]?.enabled).toBe(false);
});

test("replayed exchange assigns no further peers or duplicate native consultations", async () => {
  const peers = await fixture();
  const { skill } = await promotedSkill();
  const ctx = await runAt(f.agent.id);
  const args = { name: skill.slug, agents: peers.map((p) => p.handle) };
  expect((await invoke(ctx, "share_learned_skill", args)).isError).not.toBe(true);
  const second = await invoke(ctx, "share_learned_skill", args);
  expect(second.isError).not.toBe(true);
  expect((second.data as { assigned: unknown[] }).assigned).toHaveLength(0);
  const notes = await f.db
    .select()
    .from(schema.agentConsultations)
    .where(eq(schema.agentConsultations.askerAgentId, f.agent.id));
  expect(notes).toHaveLength(3);
});

test("A promotes a verified lesson and automatically recommends/dispatches the Skill to three role-matched peers", async () => {
  const peers = await fixture(["cecil", "diana", "elliot"]);
  const { note, skill } = await promotedSkill();
  const grants = await f.db.select().from(schema.agentSkills).where(eq(schema.agentSkills.skillId, skill.id));
  expect(grants).toHaveLength(4);
  for (const peer of peers) {
    const output = await invoke(await runAt(peer.id), "load_skill", { name: skill.slug });
    expect(output.isError).not.toBe(true);
    expect(output.content).toContain("Check the release readiness twice.");
  }
  const peerNotes = await f.db
    .select()
    .from(schema.agentConsultations)
    .where(eq(schema.agentConsultations.askerAgentId, f.agent.id));
  expect(peerNotes).toHaveLength(3);
  const pages = await f.db.select().from(schema.wikiPages).where(eq(schema.wikiPages.orgId, f.org.id));
  expect(pages.some((page) => page.source?.id === skill.id)).toBe(true);
  const memory = await f.db.select().from(schema.contextItems).where(eq(schema.contextItems.id, note.id));
  expect(memory[0]?.status).toBe("archived");
  const organizationMemory = await f.db
    .select()
    .from(schema.contextItems)
    .where(
      and(
        eq(schema.contextItems.orgId, f.org.id),
        eq(schema.contextItems.scopeType, "org"),
        eq(schema.contextItems.kind, "note"),
      ),
    );
  expect(organizationMemory).toHaveLength(1);
  expect(organizationMemory[0]?.content).toContain(skill.slug);
  const failures = await f.db
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.action, "skill.exchange_unverified"));
  expect(failures).toHaveLength(0);
});

test("owner policy default OFF blocks autonomous peer grants even when self-improvement is on", async () => {
  const peers = await fixture(["cecil", "diana", "elliot"]);
  await setLearningApprovalSettings(f.db, f.owner.id, f.org.id, {
    autoApproveLearning: false,
    autoShareLearnedSkills: false,
  });
  const { skill } = await promotedSkill();
  const grants = await f.db.select().from(schema.agentSkills).where(eq(schema.agentSkills.skillId, skill.id));
  expect(grants).toHaveLength(1);
  const attempt = await invoke(await runAt(f.agent.id), "share_learned_skill", {
    name: skill.slug,
    agents: peers.map((p) => p.handle),
  });
  expect(attempt.isError).toBe(true);
});

test("recipient belonging to a different human owner is never automatically assigned", async () => {
  await fixture();
  const other = await addMember(f.db, f.org.id, "member", "other-owner");
  const outside = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    {
      name: "Outside",
      handle: "outside",
      ownerUserId: other.id,
    },
    { model: f.agent.model },
  );
  const { skill } = await promotedSkill();
  const result = await invoke(await runAt(f.agent.id), "share_learned_skill", {
    name: skill.slug,
    agents: [outside.handle],
  });
  expect(result.isError).toBe(true);
  const grants = await f.db.select().from(schema.agentSkills).where(eq(schema.agentSkills.agentId, outside.id));
  expect(grants).toHaveLength(0);
});

test("a Skill without its real promotion receipt may not be shared by an agent", async () => {
  const peers = await fixture();
  const { skill } = await promotedSkill();
  await f.db
    .delete(schema.agentActions)
    .where(and(eq(schema.agentActions.kind, "skill.created"), eq(schema.agentActions.targetId, skill.id)));
  const result = await invoke(await runAt(f.agent.id), "share_learned_skill", {
    name: skill.slug,
    agents: [peers[0]!.handle],
  });
  expect(result.isError).toBe(true);
  const grants = await f.db.select().from(schema.agentSkills).where(eq(schema.agentSkills.skillId, skill.id));
  expect(grants).toHaveLength(1);
});

test("executable Skill edits and later versions require the existing human sharing review", async () => {
  const peers = await fixture();
  const { skill } = await promotedSkill();
  await f.db
    .update(schema.skills)
    .set({
      body: "sudo rm -rf ./projects",
    })
    .where(eq(schema.skills.id, skill.id));
  const first = await invoke(await runAt(f.agent.id), "share_learned_skill", {
    name: skill.slug,
    agents: [peers[0]!.handle],
  });
  expect(first.isError).toBe(true);
  await f.db
    .update(schema.skills)
    .set({
      body: "Check the release readiness twice.",
      version: 2,
    })
    .where(eq(schema.skills.id, skill.id));
  const second = await invoke(await runAt(f.agent.id), "share_learned_skill", {
    name: skill.slug,
    agents: [peers[0]!.handle],
  });
  expect(second.isError).toBe(true);
});

test("auto share refuses interpreter commands, multiline fences, URLs and dangerous descriptions", async () => {
  const peers = await fixture();
  const { skill } = await promotedSkill();
  const ctx = await runAt(f.agent.id);
  const risky = [
    "Explain the repair; python3 -c 'print(3)'",
    "Use sh -c 'rm -rf /tmp/canary'",
    "powershell -Command Get-Process",
    "osascript -e 'tell application Finder'",
    "Verify first; sudo rm -rf files",
    "Do not run: npm exec vite",
    "~~~bash\\nrm -rf /tmp/canary\\n~~~",
    "Run node -e console.log(1)",
    "Shell substitution: $(whoami)",
    "Open a file://private/var/tmp/path",
    "Use py\\u200bthon3 -c as an obfuscated command",
  ];
  for (const body of risky) {
    await f.db
      .update(schema.skills)
      .set({ body, description: "Verified release checklist." })
      .where(eq(schema.skills.id, skill.id));
    const result = await invoke(ctx, "share_learned_skill", { name: skill.slug, agents: [peers[0]!.handle] });
    expect(result.isError).toBe(true);
  }
  await f.db
    .update(schema.skills)
    .set({ body: "Check the release readiness twice." })
    .where(eq(schema.skills.id, skill.id));
  for (const description of risky) {
    await f.db.update(schema.skills).set({ description }).where(eq(schema.skills.id, skill.id));
    const result = await invoke(ctx, "share_learned_skill", { name: skill.slug, agents: [peers[0]!.handle] });
    expect(result.isError).toBe(true);
  }
  const grants = await f.db.select().from(schema.agentSkills).where(eq(schema.agentSkills.skillId, skill.id));
  expect(grants).toHaveLength(1);
});

test("automatic promotion audits partially delivered shares after a Wiki failure", async () => {
  const peers = await fixture(["cecil"]);
  const { skill } = await promotedSkill(async () => {
    // Isolated PGlite fault injection: disable only Wiki persistence for the
    // next operation; native grants and consultations can still commit.
    await f.db.execute(sql.raw("ALTER TABLE wiki_pages RENAME TO wiki_pages_offline_for_qa"));
  });
  const assigned = await f.db.select().from(schema.agentSkills).where(eq(schema.agentSkills.skillId, skill.id));
  expect(assigned.some((row) => row.agentId === peers[0]!.id && row.enabled)).toBe(true);
  const partials = await f.db
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.action, "skill.exchange_unverified"));
  expect(partials).toHaveLength(1);
  expect(partials[0]?.details.reason).toBe("partial_delivery");
  expect(partials[0]?.details.wikiStatus).toBe("failed");
  expect(partials[0]?.targetId).toBe(skill.id);
});

test("a replay recovers a missing Wiki page without duplicating any peer notice or grant", async () => {
  const peers = await fixture();
  const { skill } = await promotedSkill();
  const ctx = await runAt(f.agent.id);
  const args = { name: skill.slug, agents: peers.map((p) => p.handle) };
  const first = await invoke(ctx, "share_learned_skill", args);
  if (first.isError) throw new Error(first.content);
  const firstReceipt = first.data as { wiki?: { id?: string }; memory?: { id?: string } };
  const originalWiki = firstReceipt.wiki?.id;
  if (!originalWiki) throw new Error("first wiki page missing");
  await f.db.delete(schema.wikiPages).where(eq(schema.wikiPages.id, originalWiki));
  const second = await invoke(ctx, "share_learned_skill", args);
  if (second.isError) throw new Error(second.content);
  const restored = second.data as {
    assigned: unknown[];
    wiki: { status: string; id?: string };
    memory: { status: string; id?: string };
    peerNotes: Array<{ status: string }>;
  };
  expect(restored.assigned).toHaveLength(0);
  expect(restored.wiki.status).toBe("created");
  expect(restored.wiki.id).not.toBe(originalWiki);
  expect(restored.peerNotes).toHaveLength(3);
  expect(restored.peerNotes.every((note) => note.status === "already_sent")).toBe(true);
  const notes = await f.db
    .select()
    .from(schema.agentConsultations)
    .where(eq(schema.agentConsultations.askerAgentId, f.agent.id));
  expect(notes).toHaveLength(3);
  const currentMemory = await f.db
    .select()
    .from(schema.contextItems)
    .where(
      and(
        eq(schema.contextItems.orgId, f.org.id),
        eq(schema.contextItems.scopeType, "org"),
        eq(schema.contextItems.kind, "note"),
      ),
    );
  expect(currentMemory).toHaveLength(1);
  expect(currentMemory[0]?.id).toBe(firstReceipt.memory?.id);
});

test("a failed run blocks promotion of its method; a corrected method reused in two new runs can become a shared Skill", async () => {
  const peers = await fixture(["cecil"]);
  const badRun = await runAt(f.agent.id);
  const [bad] = await f.db
    .insert(schema.contextItems)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      kind: "note",
      scopeType: "agent",
      scopeId: f.agent.id,
      subjectKey: "howto unverified release",
      content: "Declare the release ready before its checks.",
      sourceIds: [badRun.triggerMessageId],
      channelIds: [f.general.id],
      recurrence: 3,
      relevance: 0.9,
      trust: "high",
    })
    .returning();
  if (!bad) throw new Error("missing error-prone method");
  await recordContextUse(f.db, f.org.id, badRun.runId, [bad.id]);
  await recordOutcome(f.db, {
    orgId: f.org.id,
    agentId: f.agent.id,
    runId: badRun.runId,
    kind: "tests_failed",
    source: "tool",
    summary: "Readiness checklist failed.",
  });
  const earlier = await runAt(f.agent.id);
  await recordContextUse(f.db, f.org.id, earlier.runId, [bad.id]);
  expect(await promoteHowTos(f.context, f.org.id, 3)).toBe(0);
  const [unsafe] = await f.db.select().from(schema.contextItems).where(eq(schema.contextItems.id, bad.id));
  expect(unsafe?.disputed).toBe(true);
  const { skill } = await promotedSkill();
  const granted = await f.db.select().from(schema.agentSkills).where(eq(schema.agentSkills.skillId, skill.id));
  expect(granted).toHaveLength(2);
  const output = await invoke(await runAt(peers[0]!.id), "load_skill", { name: skill.slug });
  expect(output.isError).not.toBe(true);
  expect(output.content).toContain("Check the release readiness twice.");
  const [stillUnsafe] = await f.db.select().from(schema.contextItems).where(eq(schema.contextItems.id, bad.id));
  expect(stillUnsafe?.disputed).toBe(true);
});

test("a peer without the native Skill-read grant is never reported as a successful recipient", async () => {
  const peers = await fixture();
  const { skill } = await promotedSkill();
  const excluded = peers[0];
  if (!excluded) throw new Error("peer fixture missing");
  await f.db
    .delete(schema.agentScopes)
    .where(
      and(
        eq(schema.agentScopes.orgId, f.org.id),
        eq(schema.agentScopes.agentId, excluded.id),
        eq(schema.agentScopes.scope, "skills:read"),
      ),
    );
  const answer = await invoke(await runAt(f.agent.id), "share_learned_skill", {
    name: skill.slug,
    agents: [excluded.handle],
  });
  expect(answer.isError).toBe(true);
  const grants = await f.db
    .select()
    .from(schema.agentSkills)
    .where(and(eq(schema.agentSkills.orgId, f.org.id), eq(schema.agentSkills.skillId, skill.id)));
  expect(grants).toHaveLength(1);
});

test("a recipient granted the native all-tools wildcard can receive a Skill and load it", async () => {
  const peers = await fixture();
  const { skill } = await promotedSkill();
  const peer = peers[0];
  if (!peer) throw new Error("missing peer");
  await f.db
    .delete(schema.agentScopes)
    .where(
      and(
        eq(schema.agentScopes.orgId, f.org.id),
        eq(schema.agentScopes.agentId, peer.id),
        eq(schema.agentScopes.scope, "skills:read"),
      ),
    );
  await f.db.insert(schema.agentScopes).values({ orgId: f.org.id, agentId: peer.id, scope: "*", connectionId: null });
  const result = await invoke(await runAt(f.agent.id), "share_learned_skill", {
    name: skill.slug,
    agents: [peer.handle],
  });
  if (result.isError) throw new Error("legitimate wildcard grant denied: " + result.content);
  const loaded = await invoke(await runAt(peer.id), "load_skill", { name: skill.slug });
  expect(loaded.isError).not.toBe(true);
  expect(loaded.content).toContain("Check the release readiness twice.");
});

test("a peer's explicit load_skill denial defeats the all-tools wildcard for Skill sharing", async () => {
  const peers = await fixture();
  const { skill } = await promotedSkill();
  const peer = peers[0];
  if (!peer) throw new Error("missing peer");
  await f.db.insert(schema.agentScopes).values([
    { orgId: f.org.id, agentId: peer.id, scope: "*", connectionId: null },
    { orgId: f.org.id, agentId: peer.id, scope: "deny:load_skill", connectionId: null },
  ]);
  const result = await invoke(await runAt(f.agent.id), "share_learned_skill", {
    name: skill.slug,
    agents: [peer.handle],
  });
  expect(result.isError).toBe(true);
  const grants = await f.db
    .select()
    .from(schema.agentSkills)
    .where(
      and(
        eq(schema.agentSkills.orgId, f.org.id),
        eq(schema.agentSkills.skillId, skill.id),
        eq(schema.agentSkills.agentId, peer.id),
      ),
    );
  expect(grants).toHaveLength(0);
});

test("real native peer consultations each create a recipient run whose own gateway can load the shared Skill", async () => {
  const peers = await fixture();
  const { skill } = await promotedSkill();
  const senderRun = await runAt(f.agent.id);
  const exchange = await invoke(senderRun, "share_learned_skill", {
    name: skill.slug,
    agents: peers.map((p) => p.handle),
  });
  if (exchange.isError) throw new Error("sharing denied: " + exchange.content);
  const consultations = await f.db
    .select()
    .from(schema.agentConsultations)
    .where(
      and(
        eq(schema.agentConsultations.orgId, f.org.id),
        eq(schema.agentConsultations.askerAgentId, f.agent.id),
        eq(schema.agentConsultations.askerRunId, senderRun.runId),
        eq(schema.agentConsultations.kind, "note"),
      ),
    );
  expect(consultations).toHaveLength(3);
  const evidence: Array<{ recipient: string; runId: string; version: number; messageId: string }> = [];
  for (const peer of peers) {
    const handoff = consultations.find((c) => c.targetAgentId === peer.id);
    if (!handoff?.targetRunId) throw new Error("native target run was not created for " + peer.handle);
    const [recipientRun] = await f.db
      .select()
      .from(schema.agentRuns)
      .where(and(eq(schema.agentRuns.orgId, f.org.id), eq(schema.agentRuns.id, handoff.targetRunId)));
    if (!recipientRun) throw new Error("recipient run missing from native store");
    expect(recipientRun.agentId).toBe(peer.id);
    expect(recipientRun.channelId).toBe(handoff.channelId);
    expect(recipientRun.triggerMessageId).toBe(handoff.messageId);
    const answer = await invoke(
      {
        db: f.db,
        orgId: f.org.id,
        agentId: peer.id,
        runId: recipientRun.id,
        channelId: recipientRun.channelId,
        threadRootId: recipientRun.threadRootId ?? handoff.messageId,
        triggerMessageId: handoff.messageId,
      },
      "load_skill",
      { name: skill.slug },
    );
    if (answer.isError) throw new Error(peer.handle + " could not load the Skill: " + answer.content);
    expect(answer.content).toContain("Check the release readiness twice.");
    const version = (answer.data as { skill?: { version: number } } | undefined)?.skill?.version;
    expect(version).toBe(skill.version);
    evidence.push({
      recipient: peer.handle,
      runId: recipientRun.id,
      version: version ?? -1,
      messageId: handoff.messageId,
    });
  }
  expect(evidence).toHaveLength(3);
  const [updatedSkill] = await f.db.select().from(schema.skills).where(eq(schema.skills.id, skill.id));
  expect(updatedSkill?.useCount).toBeGreaterThanOrEqual(3);
  expect(updatedSkill?.lastUsedAt).toBeInstanceOf(Date);
  const [wikiPage] = await f.db.select().from(schema.wikiPages).where(eq(schema.wikiPages.orgId, f.org.id));
  expect(wikiPage?.source?.id).toBe(skill.id);
  const [publicMemory] = await f.db
    .select()
    .from(schema.contextItems)
    .where(
      and(
        eq(schema.contextItems.orgId, f.org.id),
        eq(schema.contextItems.kind, "note"),
        eq(schema.contextItems.scopeType, "org"),
      ),
    );
  expect(publicMemory?.status).toBe("active");
  const audits = await f.db
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.orgId, f.org.id), eq(schema.auditLog.action, "skill.shared_by_agent")));
  expect(audits).toHaveLength(3);
  console.log(
    "ISOLATED_NATIVE_EXCHANGE_RECEIPT=" +
      JSON.stringify({
        source: "PGlite test fixture; simulated structured summary; no live production",
        skillId: skill.id,
        skillVersion: updatedSkill?.version,
        creatorAgentId: f.agent.id,
        creatorRunId: senderRun.runId,
        wikiId: wikiPage?.id,
        publicMemoryId: publicMemory?.id,
        nativeUseCount: updatedSkill?.useCount,
        auditIds: audits.map((audit) => audit.id),
        recipients: evidence,
      }),
  );
});
