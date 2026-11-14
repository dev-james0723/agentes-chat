import { afterEach, expect, test } from "bun:test";
import { countQueries, eq, inArray, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import { systemText } from "@agenteschat/providers";
import {
  addChannelMember,
  agentScopeNames,
  createAgent,
  createCredential,
  createFindAgentToolSource,
  drainOutbox,
  enableCaches,
  insertMessage,
  type MachineStatus,
  NO_PERSON,
  postPersonMessage,
  rosterScopeNames,
  summarizeScopes,
  teamPrompt,
  updateOrgSettings,
} from "../src";
import type { JudgeRequest } from "../src/judge";
import { type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

let f: Fixture;
afterEach(() => f?.close());

const post = (body: string) =>
  postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body });

const addAgent = (name: string, handle: string, role: string, instructions = "") =>
  createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name, handle, role, instructions, credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );

test("a big team is only a count with a pointer to find_agent", () => {
  const team = Array.from({ length: 20 }, (_, i) => ({
    id: `a${i}`,
    name: `A${i}`,
    handle: `a${i}`,
    role: "",
    instructions: "",
    ownerUserId: null,
    audienceMode: "everyone" as const,
    audienceUserIds: [],
    audienceRoleIds: [],
    consultable: true,
    brain: "model",
    autonomyBrakes: {},
    reportsToAgentId: null,
  }));
  const text = teamPrompt(team, "a0", null, new Set(), NO_PERSON);
  expect(text).toContain("19 other agents work in this organization.");
  expect(text).not.toContain("@a1");
  // Who to ask and who to hand work to, and that what comes of either comes back by itself (ADR 0095).
  expect(text).toContain(
    "When you need another agent's answer for the task, ask it with `ask_agent`; to hand one work, use `tell_agent`, giving the whole job to the agent that owns it with everything it needs. Do this instead of saying you can't or sending the person to it. Either way the call returns at once and what comes of it reaches you here by itself.",
  );
});

test("an agent knows the org's other agents it can work with, even outside its channels", async () => {
  const requests: ModelRequest[] = [];
  f = await setup({
    askAgent: true,
    reply: (req) => {
      requests.push(req);
      return { chunks: ["ok"] };
    },
  });
  await addAgent("Infra", "infra", "Infrastructure");
  const qa = await addAgent("QA", "qa", "Testes");
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: qa.id });
  // Nobody can talk to this one: it never shows up.
  const hidden = await addAgent("Secret", "secret", "Finance");
  await f.db
    .update(schema.agents)
    .set({ audienceMode: "owner", ownerUserId: null, consultable: false })
    .where(eq(schema.agents.id, hidden.id));

  await post("@dev oi");
  await drainOutbox(f.db, f.handlers);

  const prompt = systemText(requests[0]?.system ?? []);
  expect(prompt).toContain("# Your team\nOther agents in this organization: @infra (Infrastructure).");
  expect(prompt).toContain("`find_agent`");
  expect(prompt).not.toContain("@secret");
  // QA is a channel member: described in "Where you are", not repeated in the team.
  expect(prompt).not.toMatch(/Other agents in this organization:[^\n]*@qa/);
});

test("an agent reads how its teammates are now, not what older messages say: no AI yet, busy, or ready when called", async () => {
  const requests: ModelRequest[] = [];
  f = await setup({
    askAgent: true,
    reply: (req) => {
      requests.push(req);
      return { chunks: ["ok"] };
    },
  });
  const rui = await addAgent("Rui", "rui", "Backend");
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: rui.id });
  // Her card from before she had an AI is still in the channel.
  await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "agent", agentId: rui.id, runId: null, hop: 0, stretchId: null },
    body: "I can't answer yet: I have no AI connected.",
    meta: { bodyCode: "no_ai" },
  });
  // On heavy work now: a run going for five minutes.
  await f.db.insert(schema.agentRuns).values({
    orgId: f.org.id,
    agentId: rui.id,
    channelId: f.general.id,
    threadRootId: crypto.randomUUID(),
    triggerMessageId: crypto.randomUUID(),
    trigger: "mention",
    hop: 0,
    status: "running",
    startedAt: new Date(Date.now() - 5 * 60_000),
    heartbeatAt: new Date(),
  });
  // Otto's own key was revoked: he has no AI.
  const key = await createCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, {
    provider: "anthropic",
    label: "otto",
    apiKey: "sk-ant-test-key-otto-5678",
  });
  await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Otto", handle: "otto", role: "Front", instructions: "", credentialId: key.id },
    { model: "claude-sonnet-5-5" },
  );
  await f.db
    .update(schema.providerCredentials)
    .set({ revokedAt: new Date() })
    .where(eq(schema.providerCredentials.id, key.id));
  // Lia has an AI and hasn't worked for a while: idle, which for an agent means a mention wakes her at once.
  await addAgent("Lia", "lia", "Revisora de código");

  await post("@dev o Rui e o Otto já têm IA?");
  await drainOutbox(f.db, f.handlers);

  const prompt = systemText(requests[0]?.system ?? []);
  expect(prompt).toContain("# Your teammates now\n");
  expect(prompt).toContain("@rui: busy, on heavy work");
  expect(prompt).toContain("@otto: no AI connected yet");
  expect(prompt).toContain("- @lia: has an AI, answers when called\n");
  expect(prompt).not.toMatch(/@[a-z]+: away/);
  expect(prompt).toContain("This is how they are now: it outweighs what older messages here say about them");
});

test("find_agent searches by what agents do and shows what they can do", async () => {
  const results: string[] = [];
  f = await setup({
    askAgent: true,
    reply: (req) => {
      const last = JSON.stringify(req.messages.at(-1)?.content);
      if (last.includes("tool_result")) {
        results.push(last);
        return { chunks: ["done"] };
      }
      return { chunks: [], toolUses: [{ name: "find_agent", input: { query: "deploy de staging" } }] };
    },
  });
  await addAgent("Infra", "infra", "Infrastructure", "Cuida dos servidores e do deploy no Railway.");
  await addAgent("Design", "design", "Designer", "Faz telas e protótipos.");

  await post("@dev quem faz deploy?");
  await drainOutbox(f.db, f.handlers);

  const out = results[0] ?? "";
  expect(out).toContain("@infra: Infra, Infrastructure");
  expect(out).toContain("Files (Drive)");
  expect(out).toContain("Responsible person:");
  expect(out).not.toContain("@design");
  expect(out).not.toContain("@dev:");
});

test("find_agent scoped task mode asks Jev with only accessible, unpaused, AI-ready candidates", async () => {
  let reviewDepartmentId = "";
  const decisions: JudgeRequest[] = [];
  const results: string[] = [];
  f = await setup({
    askAgent: true,
    judge: (kind, _id, _state, _question, request) => {
      if (kind !== "agent_delegation") return undefined;
      decisions.push(request);
      const candidates = request.state.candidates as { id: string }[];
      return { choice: candidates[0]?.id, confidence: 0.95 };
    },
    reply: (req) => {
      const last = JSON.stringify(req.messages.at(-1)?.content);
      if (last.includes("tool_result")) {
        results.push(last);
        return { chunks: ["done"] };
      }
      return {
        chunks: [],
        toolUses: [
          {
            name: "find_agent",
            input: {
              task: "Independent review of a synthetic change",
              purpose: "independent_reviewer",
              departmentId: reviewDepartmentId,
            },
          },
        ],
      };
    },
  });
  const qa = await addAgent("QA", "qa", "Independent reviewer", "Private instructions must not be sent to Jev");
  const paused = await addAgent("Paused", "paused", "Reviewer");
  await f.db.update(schema.agents).set({ operatorHoldAt: new Date() }).where(eq(schema.agents.id, paused.id));
  const hidden = await addAgent("Secret", "secret", "Reviewer");
  await f.db
    .update(schema.agents)
    .set({ audienceMode: "owner", ownerUserId: null, consultable: false })
    .where(eq(schema.agents.id, hidden.id));
  const noAi = await addAgent("No AI", "no-ai", "Reviewer");
  await f.db
    .update(schema.agents)
    .set({ brain: "claude_code", machineId: null, brainFallback: false })
    .where(eq(schema.agents.id, noAi.id));
  const notCallable = await addAgent("Not callable", "not-callable", "Reviewer");
  const [reviewDepartment] = await f.db
    .insert(schema.agentGroups)
    .values({ orgId: f.org.id, name: "Review fixture" })
    .returning();
  if (!reviewDepartment) throw Error("fixture department missing");
  reviewDepartmentId = reviewDepartment.id;
  await f.db
    .update(schema.agents)
    .set({ groupId: reviewDepartmentId })
    .where(inArray(schema.agents.id, [qa.id, paused.id, hidden.id, noAi.id, notCallable.id]));
  await f.db
    .update(schema.agents)
    .set({ autonomyBrakes: { callAgents: "some", callAgentIds: [qa.id, paused.id, noAi.id] } })
    .where(eq(schema.agents.id, f.agent.id));
  await post("@dev perform only the synthetic delegation lookup; do not start any work");
  await drainOutbox(f.db, f.handlers);
  expect(decisions).toHaveLength(1);
  expect(decisions[0]?.calibrated).toBe(true);
  expect(decisions[0]?.runId).toBeTruthy();
  expect(((decisions[0]?.state.candidates ?? []) as { id: string }[]).map((x) => x.id)).toEqual([qa.id]);
  expect(JSON.stringify(decisions[0]?.state)).not.toContain("Private instructions");
  expect(results[0]).toContain("Jev suggests @qa");
  expect(results[0]).toContain("This starts no work");
});

test("a whole-connection grant is named after its connector, not 'Connector'", async () => {
  f = await setup();
  const [conn] = await f.db
    .insert(schema.connectorConnections)
    .values({
      orgId: f.org.id,
      connector: "sentry",
      label: "Sentry",
      toolPrefix: "sentry",
      serverUrl: "https://mcp.sentry.dev",
      authType: "none",
    })
    .returning();
  await f.db
    .insert(schema.agentScopes)
    .values({ orgId: f.org.id, agentId: f.agent.id, connectionId: conn?.id ?? null, scope: "connector:*" });
  const names = await agentScopeNames(f.db, f.org.id, [f.agent.id]);
  expect(names.map((n) => n.scope)).toContain("sentry:*");
  expect(names.map((n) => n.scope)).not.toContain("connector:*");
});

test("another agent's computer, browser and desktop are stated only where its computer serves them", async () => {
  f = await setup();
  // Granted to every new agent.
  const qa = await addAgent("QA", "qa", "Testes");
  const roster = async (machines?: { status(id: string): Promise<MachineStatus | null> }) =>
    summarizeScopes((await rosterScopeNames(f.db, machines, f.org.id, [qa.id])).map((s) => s.scope));
  const none = await roster();
  expect(none).toContain("Files (Drive)");
  expect(none).not.toMatch(/Code|Browser|Desktop/);

  // A computer whose browser is on and ready, and no desktop use: Code and Browser.
  const { machineId } = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { name: "MacBook" });
  await f.db.update(schema.agents).set({ machineId }).where(eq(schema.agents.id, qa.id));
  const served = await roster({
    status: async (id) =>
      id === machineId
        ? {
            id,
            orgId: f.org.id,
            name: "MacBook",
            online: false,
            execAllowed: true,
            os: "darwin",
            protocol: 12,
            executors: { browser: { available: true, version: "0.39.1" } },
            paused: null,
            access: { folders: [], tools: { claude: true, codex: true, commands: true, browser: true } },
          }
        : null,
  });
  expect(served).toContain("Code");
  expect(served).toContain("Browser");
  expect(served).not.toContain("Desktop");
});

test("the roster reads a computer once, however many agents share it", async () => {
  f = await setup({ machines: true });
  const ids = (await Promise.all(["qa", "ops", "web"].map((h) => addAgent(h.toUpperCase(), h, "")))).map((a) => a.id);
  const { machineId } = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { name: "MacBook" });
  await f.db.update(schema.agents).set({ machineId }).where(inArray(schema.agents.id, ids));
  enableCaches();
  try {
    // A running server has the agents cached.
    await rosterScopeNames(f.db, f.machineHub, f.org.id, ids);
    const { queries } = await countQueries(() => rosterScopeNames(f.db, f.machineHub, f.org.id, ids));
    // Their scopes, the code environment's switch and the computer.
    expect(queries).toBeLessThanOrEqual(3);
  } finally {
    enableCaches(false);
  }
});

/** Native connected routing contract: disposable data, real gateway/ACL/readiness, fixed Judge (no provider). */
async function routingFixture() {
  const requests: JudgeRequest[] = [];
  let choice = "";
  const source: import("../src/tools/types").ToolSource = {
    name: "routing-contract",
    tools: (ctx) =>
      createFindAgentToolSource({
        ai: { gateway: f.gateway },
        judge: {
          name: "offline",
          ask: async (request) => {
            requests.push(request);
            return { delegate: { choice, confidence: 0.88 } };
          },
        },
      }).tools(ctx),
  };
  f = await setup({ toolSources: [source] });
  const manager = await addAgent("Delivery owner", "deliveryowner", "Engineering manager");
  const alpha = await addAgent("UX alpha", "uxalpha", "Design specialist");
  const beta = await addAgent("UX beta", "uxbeta", "Design coordinator");
  const [department] = await f.db
    .insert(schema.agentGroups)
    .values({ orgId: f.org.id, name: "Synthetic design" })
    .returning();
  if (!department || !f.tools) throw Error("Fixture department/gateway missing");
  await f.db
    .update(schema.agents)
    .set({ groupId: department.id })
    .where(inArray(schema.agents.id, [alpha.id, beta.id]));
  const trigger = await post("@dev native contract fixture");
  const [run] = await f.db
    .update(schema.agentRuns)
    .set({ status: "running" })
    .where(eq(schema.agentRuns.triggerMessageId, trigger.id))
    .returning();
  if (!run) throw Error("Fixture run missing");
  const ctx = {
    db: f.db,
    orgId: f.org.id,
    agentId: f.agent.id,
    runId: run.id,
    channelId: run.channelId,
    threadRootId: run.threadRootId,
    triggerMessageId: run.triggerMessageId,
  };
  choice = manager.id;
  return {
    manager,
    alpha,
    beta,
    department,
    requests,
    ctx,
    choose: (id: string) => {
      choice = id;
    },
    invoke: async (input: Record<string, unknown>) => {
      if (!f.tools) throw Error("Fixture gateway missing");
      const result = await f.tools.invoke(ctx, { name: "find_agent", input, toolUseId: crypto.randomUUID() });
      if (result.type !== "result") throw Error("Unexpected approval");
      return result.output;
    },
  };
}

test("legacy task-only ambiguity returns machine clarification without Judge or candidate expansion", async () => {
  const r = await routingFixture();
  const out = await r.invoke({ task: "Choose the accountable department coordinator for Save/keyboard focus" });
  expect(out.data?.delegation).toMatchObject({
    status: "insufficient_scope",
    by: "rules",
    reason: "selection_purpose_required",
  });
  expect(r.requests).toHaveLength(0);
});

test("exact handle plus typed purpose remains explicit through the real gateway with zero Judge", async () => {
  const r = await routingFixture();
  const out = await r.invoke({
    query: "@uxalpha",
    task: "Implement the bounded design change",
    purpose: "implementer",
  });
  expect(out.data?.delegation).toMatchObject({
    status: "recommended",
    by: "rules",
    agentId: r.alpha.id,
    taskFit: "unverified",
  });
  expect(out.content).toContain("Explicit target");
  expect(r.requests).toHaveLength(0);
});

test("native department scope excludes manager and rejects its attempted Judge substitution", async () => {
  const r = await routingFixture();
  const out = await r.invoke({
    task: "Coordinate this department",
    purpose: "department_coordinator",
    departmentId: r.department.id,
  });
  expect(r.requests).toHaveLength(1);
  expect(((r.requests[0]?.state.candidates ?? []) as { id: string }[]).map((c) => c.id).sort()).toEqual(
    [r.alpha.id, r.beta.id].sort(),
  );
  expect(out.data?.delegation).toMatchObject({ status: "invalid", by: "jev" });
});

test("explicit delivery owner stays a rules mapping, not a design-title remap", async () => {
  const r = await routingFixture();
  expect(
    (
      await r.invoke({
        task: "Accountable delivery owner",
        purpose: "accountable_delivery_owner",
        targetAgentId: r.manager.id,
      })
    ).data?.delegation,
  ).toMatchObject({ status: "recommended", by: "rules", agentId: r.manager.id });
  expect(r.requests).toHaveLength(0);
});

test("a scoped coordinator request without a department is clarified, not sent to the whole roster", async () => {
  const r = await routingFixture();
  expect(
    (await r.invoke({ task: "Coordinate department", purpose: "department_coordinator" })).data?.delegation,
  ).toMatchObject({ status: "insufficient_scope", reason: "department_or_target_required" });
  expect(r.requests).toHaveLength(0);
});

test("hard tool needs without an authoritative candidate inventory remain unknown, never invented", async () => {
  const r = await routingFixture();
  expect(
    (
      await r.invoke({
        task: "Use browser",
        purpose: "implementer",
        targetAgentId: r.alpha.id,
        requiredTools: ["browser"],
      })
    ).data?.delegation,
  ).toMatchObject({ status: "insufficient_scope", reason: "tool_availability_unverified" });
  expect(r.requests).toHaveLength(0);
});

test("native autonomy denial still excludes an explicit target", async () => {
  const r = await routingFixture();
  await f.db
    .update(schema.agents)
    .set({ autonomyBrakes: { callAgents: "none" } })
    .where(eq(schema.agents.id, f.agent.id));
  expect(
    (await r.invoke({ task: "Implement", purpose: "implementer", targetAgentId: r.alpha.id })).data?.delegation,
  ).toMatchObject({ status: "no_candidates", by: "rules" });
  expect(r.requests).toHaveLength(0);
});

test("native inLine reach remains permission, without expanding semantic department fit", async () => {
  const r = await routingFixture();
  await f.db
    .update(schema.agents)
    .set({ autonomyBrakes: { callAgents: "none" }, reportsToAgentId: r.manager.id })
    .where(eq(schema.agents.id, f.agent.id));
  expect(
    (await r.invoke({ task: "Delivery owner", purpose: "accountable_delivery_owner", targetAgentId: r.manager.id }))
      .data?.delegation,
  ).toMatchObject({ status: "recommended", by: "rules", agentId: r.manager.id });
  expect(
    (await r.invoke({ task: "Design coordinator", purpose: "department_coordinator", departmentId: r.department.id }))
      .data?.delegation,
  ).toMatchObject({ status: "no_candidates" });
  expect(r.requests).toHaveLength(0);
});

test("hidden and unready explicit candidates cannot be substituted with the available manager", async () => {
  const r = await routingFixture();
  await f.db
    .update(schema.agents)
    .set({ audienceMode: "owner", ownerUserId: null, consultable: false })
    .where(eq(schema.agents.id, r.alpha.id));
  expect(
    (await r.invoke({ task: "Implement", purpose: "implementer", targetAgentId: r.alpha.id })).data?.delegation,
  ).toMatchObject({ status: "no_candidates" });
  await f.db
    .update(schema.agents)
    .set({ brain: "claude_code", machineId: null, brainFallback: false })
    .where(eq(schema.agents.id, r.beta.id));
  expect(
    (await r.invoke({ task: "Implement", purpose: "implementer", targetAgentId: r.beta.id })).data?.delegation,
  ).toMatchObject({ status: "no_candidates" });
  expect(r.requests).toHaveLength(0);
});

test("two legal native candidates with different workload remain advisory choices, not prestige winners", async () => {
  const r = await routingFixture();
  await f.db.insert(schema.agentRuns).values({
    orgId: f.org.id,
    agentId: r.alpha.id,
    channelId: f.general.id,
    threadRootId: crypto.randomUUID(),
    triggerMessageId: r.ctx.triggerMessageId,
    trigger: "mention",
    hop: 0,
    status: "running",
    startedAt: new Date(),
    heartbeatAt: new Date(),
  });
  for (const id of [r.alpha.id, r.beta.id]) {
    r.choose(id);
    expect(
      (await r.invoke({ task: "Coordinate design", purpose: "department_coordinator", departmentId: r.department.id }))
        .data?.delegation,
    ).toMatchObject({ status: "recommended", by: "jev", agentId: id, taskFit: "unverified" });
  }
  expect(r.requests).toHaveLength(2);
  expect(((r.requests[0]?.state.candidates ?? []) as { id: string }[]).map((c) => c.id)).toContain(r.alpha.id);
});

test("an exact target in another department does not silently switch to a matching peer", async () => {
  const r = await routingFixture();
  expect(
    (
      await r.invoke({
        task: "Coordinate design",
        purpose: "department_coordinator",
        departmentId: r.department.id,
        targetAgentId: r.manager.id,
      })
    ).data?.delegation,
  ).toMatchObject({ status: "no_candidates" });
  expect(r.requests).toHaveLength(0);
});

test("fuzzy query plus task asks the agent to supply an exact target or department, not a first lexical winner", async () => {
  const r = await routingFixture();
  expect(
    (await r.invoke({ query: "design specialist please", task: "Implement", purpose: "implementer" })).data?.delegation,
  ).toMatchObject({ status: "insufficient_scope", reason: "exact_target_required" });
  expect(r.requests).toHaveLength(0);
});

test("query-only native search remains metadata-only and zero Judge", async () => {
  const r = await routingFixture();
  const out = await r.invoke({ query: "uxalpha" });
  expect(out.content).toContain("@uxalpha");
  expect(out.data?.delegation).toBeUndefined();
  expect(r.requests).toHaveLength(0);
});

test("independent-review intent is explicit and caller self is never in the scoped shortlist", async () => {
  const r = await routingFixture();
  r.choose(r.alpha.id);
  const out = await r.invoke({
    task: "Review independently",
    purpose: "independent_reviewer",
    departmentId: r.department.id,
  });
  expect(out.data?.delegation).toMatchObject({
    status: "recommended",
    purpose: "independent_reviewer",
    taskFit: "unverified",
    independence: "not_evaluated",
  });
  expect(((r.requests[0]?.state.candidates ?? []) as { id: string }[]).map((c) => c.id)).not.toContain(f.agent.id);
});

test("personal-mode tool description requests typed intent before task routing", async () => {
  const r = await routingFixture();
  await updateOrgSettings(f.db, f.owner.id, f.org.id, { mode: "personal" });
  if (!f.tools) throw Error("fixture gateway missing");
  const tool = (await f.tools.list(r.ctx)).find((t) => t.name === "find_agent");
  expect(tool?.description).toContain("purpose");
  expect(tool?.description).toContain("targetAgentId");
});

test("revoked requester membership during native readiness cannot select a target", async () => {
  const r = await routingFixture();
  const old = f.gateway.hasModelCredential.bind(f.gateway);
  f.gateway.hasModelCredential = async (agent) => {
    const ready = await old(agent);
    await f.db.delete(schema.organizationMembers).where(eq(schema.organizationMembers.userId, f.owner.id));
    return ready;
  };
  expect(
    (await r.invoke({ task: "Implement", purpose: "implementer", targetAgentId: r.alpha.id })).data?.delegation,
  ).toMatchObject({ status: "insufficient_scope", reason: "requester_unavailable" });
  expect(r.requests).toHaveLength(0);
});

test("missing-intent native handler does no roster/readiness SQL and no Judge work", async () => {
  const r = await routingFixture();
  const [tool] = await createFindAgentToolSource({ ai: { gateway: f.gateway } }).tools(r.ctx);
  if (!tool) throw Error("fixture tool missing");
  const { queries } = await countQueries(() => tool.execute({ task: "Coordinate unknown department" }, r.ctx));
  expect(queries).toBe(0);
  expect(r.requests).toHaveLength(0);
});

test("explicit native identity does not require a configured Judge and UUID case is canonical", async () => {
  const r = await routingFixture();
  const [tool] = await createFindAgentToolSource({ ai: { gateway: f.gateway } }).tools(r.ctx);
  if (!tool) throw Error("fixture tool missing");
  const out = await tool.execute(
    { task: "Implement", purpose: "implementer", targetAgentId: r.alpha.id.toUpperCase() },
    r.ctx,
  );
  expect(out.data?.delegation).toMatchObject({
    status: "recommended",
    by: "rules",
    agentId: r.alpha.id,
    decisionCalls: 0,
  });
  expect(r.requests).toHaveLength(0);
});

test("explicit lookup overhead is measured separately from the unchanged normal-turn budget", async () => {
  const r = await routingFixture();
  const exact = await countQueries(() =>
    r.invoke({ task: "Implement", purpose: "implementer", targetAgentId: r.alpha.id }),
  );
  expect(exact.result.data?.delegation).toMatchObject({ by: "rules", decisionCalls: 0 });
  expect(r.requests).toHaveLength(0);
  expect(exact.queries).toBeGreaterThan(0);
  r.choose(r.alpha.id);
  const advisory = await countQueries(() =>
    r.invoke({ task: "Coordinate", purpose: "department_coordinator", departmentId: r.department.id }),
  );
  expect(advisory.result.data?.delegation).toMatchObject({ by: "jev", decisionCalls: 1, taskFit: "unverified" });
  console.log(
    `ROUTING_EXPLICIT_NATIVE_STATEMENTS rules=${exact.queries} advisory=${advisory.queries}; fixture gateway audit included, not normal-turn cost or paid usage`,
  );
});
