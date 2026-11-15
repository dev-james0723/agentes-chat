import { afterEach, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import { createAgentRuns, insertMessage, openAgentDm, type ToolContext } from "../src";
import { createSelfProfileToolSource, SELF_PROFILE_TOOL } from "../src/self-profile-tools";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

async function start(userId = f.owner.id): Promise<ToolContext> {
  const message = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "person", userId },
    body: "What tools and skills can you use now?",
  });
  const [run] = await f.db.transaction((tx) => createAgentRuns(tx, message, [f.agent.id], "mention"));
  if (!run) throw new Error("missing run");
  return {
    db: f.db,
    orgId: f.org.id,
    agentId: f.agent.id,
    runId: run.id,
    channelId: f.general.id,
    threadRootId: run.threadRootId,
    triggerMessageId: run.triggerMessageId,
  };
}
async function call(ctx: ToolContext, input: Record<string, unknown> = {}) {
  const result = await f.tools?.invoke(ctx, { toolUseId: crypto.randomUUID(), name: SELF_PROFILE_TOOL, input });
  if (result?.type !== "result") throw new Error("missing result");
  return result.output;
}

test("a current self-only snapshot has expiry and an observational fingerprint, never another target", async () => {
  f = await setup({ toolSources: [createSelfProfileToolSource()] });
  const ctx = await start();
  const output = await call(ctx);
  expect(output.isError).toBeFalsy();
  const snapshot = JSON.parse(output.content);
  expect(snapshot.agent_id).toBe(f.agent.id);
  expect(snapshot.source).toBe("native_agent_runtime");
  expect(Date.parse(snapshot.expires_at)).toBeGreaterThan(Date.parse(snapshot.captured_at));
  expect(snapshot.context_version).toMatch(/^[a-f0-9]{64}$/);
  expect(snapshot.authority).toBe(false);
  const target = await call(ctx, { agent_id: crypto.randomUUID() });
  expect(target.isError).toBe(true);
});

test("an initiating member does not borrow the agent owner's profile access through consultation reach", async () => {
  f = await setup({ toolSources: [createSelfProfileToolSource()] });
  const outsider = await addMember(f.db, f.org.id, "member", "Bia");
  await f.db
    .update(schema.agents)
    .set({ ownerUserId: f.owner.id, audienceMode: "owner", consultable: true })
    .where(eq(schema.agents.id, f.agent.id));
  const ctx = await start(outsider.id);
  expect((await call(ctx)).isError).toBe(true);
  const membership = and(
    eq(schema.organizationMembers.orgId, f.org.id),
    eq(schema.organizationMembers.userId, outsider.id),
  );
  await f.db.delete(schema.organizationMembers).where(membership);
  expect((await call(ctx)).isError).toBe(true);
});

test("a revoked initiating membership and archived agent fail closed on a fresh call", async () => {
  f = await setup({ toolSources: [createSelfProfileToolSource()] });
  const ctx = await start();
  expect((await call(ctx)).isError).toBeFalsy();
  await f.db.update(schema.users).set({ blockedAt: new Date() }).where(eq(schema.users.id, f.owner.id));
  expect((await call(ctx)).isError).toBe(true);
  await f.db.update(schema.users).set({ blockedAt: null }).where(eq(schema.users.id, f.owner.id));
  await f.db.update(schema.agents).set({ archivedAt: new Date() }).where(eq(schema.agents.id, f.agent.id));
  expect((await call(ctx)).isError).toBe(true);
});

test("grants and assigned skill versions are fresh, changed snapshots are explicit and timestamp-only changes are stable", async () => {
  f = await setup({ toolSources: [createSelfProfileToolSource()] });
  const ctx = await start();
  const first = JSON.parse((await call(ctx)).content);
  const same = JSON.parse((await call(ctx, { previous_context_version: first.context_version })).content);
  expect(same.context_version).toBe(first.context_version);
  expect(same.changed).toBe(false);
  const [skill] = await f.db
    .insert(schema.skills)
    .values({
      orgId: f.org.id,
      slug: "test-review",
      name: "Test review",
      description: "Review",
      body: "Review",
      source: "manual",
      version: 1,
    })
    .returning();
  if (!skill) throw new Error("missing skill");
  await f.db
    .insert(schema.agentSkills)
    .values({ orgId: f.org.id, agentId: f.agent.id, skillId: skill.id, enabled: true });
  const enabled = JSON.parse(
    (await call(ctx, { section: "skills", previous_context_version: first.context_version })).content,
  );
  expect(enabled.changed).toBe(true);
  expect(enabled.items).toEqual([{ id: skill.id, name: "Test review", version: 1 }]);
  await f.db.update(schema.skills).set({ version: 2 }).where(eq(schema.skills.id, skill.id));
  const updated = JSON.parse((await call(ctx, { section: "skills" })).content);
  expect(updated.items[0].version).toBe(2);
  await f.db.update(schema.agentSkills).set({ enabled: false }).where(eq(schema.agentSkills.skillId, skill.id));
  await f.db.delete(schema.agentScopes).where(eq(schema.agentScopes.agentId, f.agent.id));
  const revoked = JSON.parse(
    (await call(ctx, { section: "skills", previous_context_version: updated.context_version })).content,
  );
  expect(revoked.changed).toBe(true);
  expect(revoked.items).toEqual([]);
});

test("all sections omit freeform account/connector labels, emails, endpoint paths and other agents; auto is not actual model", async () => {
  let listed: import("../src").ToolDefinition[] = [];
  f = await setup({ toolSources: [createSelfProfileToolSource({ listTools: async () => listed })] });
  const ctx = await start();
  await f.db
    .update(schema.agents)
    .set({ role: "private alice@example.test /Users/private/project", model: "auto", brain: "codex", brainModel: null })
    .where(eq(schema.agents.id, f.agent.id));
  const connection = crypto.randomUUID();
  listed = [
    {
      name: "list_records",
      scope: "",
      description: "SECRET_CONNECTOR alice@example.test /Users/private/project",
      connectorLabel: "SECRET_CONNECTOR",
      connectionId: connection,
      inputSchema: { type: "object", properties: {} },
      execute: async () => ({ content: "unused" }),
    },
  ];
  await f.db
    .insert(schema.agentScopes)
    .values({ orgId: f.org.id, agentId: f.agent.id, connectionId: connection, scope: "connector:*" });
  await f.db.insert(schema.agents).values({
    orgId: f.org.id,
    name: "OTHER_PRIVATE",
    handle: "private",
    role: "OTHER_PRIVATE",
    model: "claude-sonnet-5-5",
  });
  for (const section of ["summary", "skills", "capabilities", "route", "relationships", "usage"]) {
    const out = await call(ctx, { section });
    expect(out.isError).toBeFalsy();
    expect(out.content).not.toMatch(/alice@|SECRET_CONNECTOR|OTHER_PRIVATE|\/Users\/|sk-ant-test-key/);
  }
  const route = JSON.parse((await call(ctx, { section: "route" })).content).items[0];
  expect(route.configured_api_model).toBe("auto");
  expect(route.last_observed_run_model).toBeNull();
  expect(route.pricing).toBe("unknown");
  expect(route.available_models).toBeNull();
});

test("fresh denials filter stale tool listings and reordered grant sets keep the fingerprint", async () => {
  const tool: import("../src").ToolDefinition = {
    name: "read_records",
    scope: "data:read",
    description: "Records",
    inputSchema: { type: "object", properties: {} },
    execute: async () => ({ content: "unused" }),
  };
  f = await setup({ toolSources: [createSelfProfileToolSource({ listTools: async () => [tool] })] });
  const ctx = await start();
  const scope = (value: string) => ({ orgId: f.org.id, agentId: f.agent.id, connectionId: null, scope: value });
  await f.db.delete(schema.agentScopes).where(eq(schema.agentScopes.agentId, f.agent.id));
  await f.db.insert(schema.agentScopes).values([scope("data:read"), scope("wiki:read")]);
  const a = JSON.parse((await call(ctx, { section: "capabilities" })).content);
  expect(a.items.some((i: { name?: string }) => i.name === "read_records")).toBe(true);
  await f.db.delete(schema.agentScopes).where(eq(schema.agentScopes.agentId, f.agent.id));
  await f.db.insert(schema.agentScopes).values([scope("wiki:read"), scope("data:read")]);
  expect(JSON.parse((await call(ctx)).content).context_version).toBe(a.context_version);
  await f.db.insert(schema.agentScopes).values(scope("deny:read_records"));
  const denied = JSON.parse(
    (await call(ctx, { section: "capabilities", previous_context_version: a.context_version })).content,
  );
  expect(denied.changed).toBe(true);
  expect(denied.items.some((i: { name?: string }) => i.name === "read_records")).toBe(false);
});

test("bounded skill pages are recoverable, and a version change between pages is explicit", async () => {
  f = await setup({ toolSources: [createSelfProfileToolSource()] });
  const ctx = await start();
  const skills = await f.db
    .insert(schema.skills)
    .values(
      Array.from({ length: 23 }, (_, n) => ({
        orgId: f.org.id,
        slug: `skill-${n}`,
        name: `Skill ${n}`,
        description: "test",
        body: "test",
        source: "manual",
      })),
    )
    .returning();
  await f.db
    .insert(schema.agentSkills)
    .values(skills.map((s) => ({ orgId: f.org.id, agentId: f.agent.id, skillId: s.id, enabled: true })));
  const first = JSON.parse((await call(ctx, { section: "skills" })).content);
  expect(first.complete).toBe(false);
  expect(first.total).toBe(23);
  expect(first.items).toHaveLength(20);
  const last = JSON.parse(
    (await call(ctx, { section: "skills", offset: first.next_offset, previous_context_version: first.context_version }))
      .content,
  );
  expect(last.changed).toBe(false);
  expect(last.complete).toBe(true);
  expect(last.items).toHaveLength(3);
  expect(new Set([...first.items, ...last.items].map((x: { id: string }) => x.id)).size).toBe(23);
  await f.db
    .update(schema.skills)
    .set({ version: 2 })
    .where(eq(schema.skills.id, skills.at(0)?.id ?? "missing"));
  expect(
    JSON.parse(
      (await call(ctx, { section: "skills", offset: 20, previous_context_version: first.context_version })).content,
    ).changed,
  ).toBe(true);
});

test("the runtime tool is discoverable on demand without a new grant, and a foreign or ended run is refused", async () => {
  f = await setup({ toolSources: [createSelfProfileToolSource()] });
  const ctx = { ...(await start()), loadedGroups: [] };
  expect((await f.tools?.list(ctx))?.some((t) => t.name === SELF_PROFILE_TOOL)).toBe(false);
  const found = await f.tools?.invoke(ctx, { toolUseId: "find", name: "find_tools", input: { query: "my profile" } });
  expect(found?.type === "result" && found.output.content).toContain(SELF_PROFILE_TOOL);
  expect((await call({ ...ctx, agentId: crypto.randomUUID() })).isError).toBe(true);
  await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, ctx.runId));
  expect((await call(ctx)).isError).toBe(true);
});

test("an agent-to-agent request preserves the initiating person and never elevates to the target owner", async () => {
  f = await setup({ toolSources: [createSelfProfileToolSource()] });
  const outsider = await addMember(f.db, f.org.id, "member", "Bia");
  await f.db
    .update(schema.agents)
    .set({ ownerUserId: f.owner.id, audienceMode: "owner", consultable: true })
    .where(eq(schema.agents.id, f.agent.id));
  const [front] = await f.db
    .insert(schema.agents)
    .values({ orgId: f.org.id, name: "Front", handle: "front", role: "Front desk", model: "claude-sonnet-5-5" })
    .returning();
  if (!front) throw new Error("missing front desk");
  const root = await start(outsider.id);
  await f.db.update(schema.agentRuns).set({ agentId: front.id }).where(eq(schema.agentRuns.id, root.runId));
  const dm = await openAgentDm(f.db, f.org.id, front.id, f.agent.id);
  const trigger = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: dm.id,
    author: { type: "agent", agentId: front.id, runId: root.runId, hop: 1 },
    body: "What is your profile?",
  });
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: dm.id,
      threadRootId: trigger.id,
      triggerMessageId: trigger.id,
      trigger: "mention",
      hop: 1,
      status: "running",
    })
    .returning();
  if (!run) throw new Error("missing consultation run");
  const ctx = { ...root, runId: run.id, channelId: dm.id, threadRootId: trigger.id, triggerMessageId: trigger.id };
  expect((await call(ctx)).isError).toBe(true);
  await f.db.update(schema.agents).set({ audienceMode: "everyone" }).where(eq(schema.agents.id, f.agent.id));
  expect((await call(ctx)).isError).toBeFalsy();
  await f.db
    .delete(schema.organizationMembers)
    .where(and(eq(schema.organizationMembers.orgId, f.org.id), eq(schema.organizationMembers.userId, outsider.id)));
  expect((await call(ctx)).isError).toBe(true);
});

test("a routine checks its current creator's visibility without claiming to act as that person", async () => {
  f = await setup({ toolSources: [createSelfProfileToolSource()] });
  const trigger = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "person", userId: f.owner.id },
    body: "Check profile",
    meta: {
      background: true,
      routineBrief: {
        routineId: crypto.randomUUID(),
        routineRunId: crypto.randomUUID(),
        name: "Profile check",
        creatorUserId: f.owner.id,
        deliverTo: { channelId: f.general.id, threadId: null },
        access: "read_only",
        report: "when_new",
        trigger: "schedule",
        dueAt: new Date().toISOString(),
      },
    },
  });
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: trigger.id,
      triggerMessageId: trigger.id,
      trigger: "mention",
      hop: 1,
      status: "running",
      background: true,
    })
    .returning();
  if (!run) throw new Error("missing routine run");
  const ctx = {
    db: f.db,
    orgId: f.org.id,
    agentId: f.agent.id,
    runId: run.id,
    channelId: f.general.id,
    threadRootId: trigger.id,
    triggerMessageId: trigger.id,
  };
  const out = await call(ctx);
  expect(out.isError).toBeFalsy();
  expect(JSON.parse(out.content).acting_person).toBe(false);
  await f.db.update(schema.users).set({ blockedAt: new Date() }).where(eq(schema.users.id, f.owner.id));
  expect((await call(ctx)).isError).toBe(true);
});

test("usage counter and observation updates do not invalidate capability pages, but model changes do", async () => {
  f = await setup({ toolSources: [createSelfProfileToolSource()] });
  const { machineId } = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, {
    name: "Test machine",
    exec: true,
  });
  const accountId = crypto.randomUUID();
  const usage = (usedPercent: number, at: string) => ({
    source: "turn" as const,
    at,
    windows: [{ kind: "five_hour" as const, usedPercent, resetsAt: "2030-01-01T00:00:00Z" }],
  });
  await f.db.insert(schema.machineAccounts).values({
    id: accountId,
    orgId: f.org.id,
    machineId,
    kind: "claude_code",
    label: "private account",
    status: "active",
    createdBy: f.owner.id,
    usage: usage(10, "2026-11-13T00:00:00Z"),
  });
  await f.db
    .update(schema.agents)
    .set({ brain: "claude_code", machineId, brainAccountId: accountId })
    .where(eq(schema.agents.id, f.agent.id));
  const ctx = await start();
  const first = JSON.parse((await call(ctx, { section: "usage" })).content);
  await f.db.insert(schema.usageRecords).values({
    orgId: f.org.id,
    agentId: f.agent.id,
    kind: "agent",
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    requestedModel: "claude-sonnet-5-5",
    inputTokens: 1000,
    outputTokens: 0,
    costNanoUsd: 2000000000,
  });
  await f.db
    .update(schema.machineAccounts)
    .set({ usage: usage(45, "2026-11-13T01:00:00Z") })
    .where(eq(schema.machineAccounts.id, accountId));
  const next = JSON.parse(
    (await call(ctx, { section: "usage", previous_context_version: first.context_version })).content,
  );
  expect(next.items[0].tokens).toBeGreaterThan(first.items[0].tokens);
  expect(next.items[0].api_budget_used_percent).not.toBe(first.items[0].api_budget_used_percent);
  expect(next.items[0].plan_usage_observed_at).not.toBe(first.items[0].plan_usage_observed_at);
  expect(next.context_version).toBe(first.context_version);
  expect(next.changed).toBe(false);
  expect(next.usage_observed_version).not.toBe(first.usage_observed_version);
  await f.db
    .update(schema.machineAccounts)
    .set({
      usage: {
        ...usage(45, "2026-11-13T01:00:00Z"),
        windows: Array.from({ length: 32 }, (_, usedPercent) => ({
          kind: "five_hour",
          usedPercent,
          resetsAt: "2030-01-01T00:00:00Z",
        })),
      },
    })
    .where(eq(schema.machineAccounts.id, accountId));
  const page = JSON.parse((await call(ctx, { section: "usage" })).content);
  expect(page.items).toHaveLength(20);
  expect(page.total).toBe(33);
  expect(page.complete).toBe(false);
  const rest = JSON.parse((await call(ctx, { section: "usage", offset: page.next_offset })).content);
  expect(rest.items).toHaveLength(13);
  expect(rest.usage_observed_version).toBe(page.usage_observed_version);
  expect(rest.context_version).toBe(first.context_version);
  await f.db.update(schema.agents).set({ brainModel: "claude-opus-5-5" }).where(eq(schema.agents.id, f.agent.id));
  expect(JSON.parse((await call(ctx, { previous_context_version: first.context_version })).content).changed).toBe(true);
});
