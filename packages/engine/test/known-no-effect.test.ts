import { afterEach, describe, expect, test } from "bun:test";
import { count, eq, schema } from "@agenteschat/db";
import {
  createAgent,
  createArtifactToolSource,
  createAskUserToolSource,
  createChatToolSource,
  createContextToolSource,
  createFollowUpToolSource,
  createHandOffToolSource,
  createIssueToolSource,
  createScheduleToolSource,
  createToolGateway,
  createWikiToolSource,
  grantScopes,
  knownBridgeResult,
  NotFoundError,
  openAgentDm,
  postPersonMessage,
  type ToolContext,
  type ToolDefinition,
  type ToolOutput,
  type ToolSource,
} from "../src";
import { type Fixture, setup } from "./fixtures";
import { runContext } from "./mail-fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

const inputSchema = { type: "object" as const, properties: {}, additionalProperties: true };
const tool = (name: string, scope: string, run: () => Promise<ToolOutput>, more: Partial<ToolDefinition> = {}) =>
  ({ name, description: name, scope, inputSchema, execute: run, ...more }) as ToolDefinition;
const lost = async (): Promise<ToolOutput> => {
  throw new Error("the database did not answer");
};
const said = async (): Promise<ToolOutput> => ({ content: "Not found.", isError: true });

/** Calls one tool through the Tool Gateway and says whether a cut turn would know its outcome. */
async function known(def: ToolDefinition) {
  const gateway = createToolGateway({ sources: [{ name: "probe", tools: async () => [def] }] });
  if (def.scope)
    await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: def.connectionId ?? null, scope: def.scope }]);
  const msg = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "go",
  });
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: msg.id,
      triggerMessageId: msg.id,
      trigger: "mention",
      hop: 1,
      status: "running",
      startedAt: new Date(),
    })
    .returning();
  if (!run) throw new Error("no run");
  const ctx: ToolContext = {
    db: f.db,
    orgId: f.org.id,
    agentId: f.agent.id,
    runId: run.id,
    channelId: f.general.id,
    threadRootId: msg.id,
    triggerMessageId: msg.id,
  };
  const out = await gateway.invoke(ctx, { toolUseId: "t1", name: def.name, input: {} });
  if (out.type !== "result") throw new Error(`expected a result, got ${out.type}`);
  expect(out.output.isError).toBe(true);
  return knownBridgeResult(out.output);
}

describe("errors of our own tools that cannot have had an effect are known outcomes", () => {
  test("our own read-only tools: any error, returned or thrown", async () => {
    f = await setup();
    expect(await known(tool("probe_read", "context:read", said, { readOnly: true }))).toBe(true);
    expect(await known(tool("probe_read", "context:read", lost, { readOnly: true }))).toBe(true);
    expect(await known(tool("list_routines", "schedule:manage", lost, { readOnly: true }))).toBe(true);
    expect(await known(tool("probe_status", "", lost, { readOnly: true }))).toBe(true);
  });

  test("a typed error thrown by a write tool is not proof by itself: the tool may have written first", async () => {
    f = await setup();
    const refused = async (): Promise<ToolOutput> => {
      throw new NotFoundError("No such memory");
    };
    expect(await known(tool("probe_write", "memory:write", refused))).toBe(false);
  });

  test("update_memory and forget: a memory this run may not change is refused before any write", async () => {
    f = await setup();
    const ctx: ToolContext = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: crypto.randomUUID(),
      channelId: f.general.id,
      threadRootId: crypto.randomUUID(),
      triggerMessageId: crypto.randomUUID(),
    };
    const tools = await createContextToolSource(f.context).tools(ctx);
    for (const name of ["update_memory", "forget"])
      for (const id of ["nope", crypto.randomUUID()]) {
        const out = await tools.find((t) => t.name === name)?.execute({ item_id: id, content: "new text" }, ctx);
        expect(out).toMatchObject({ content: "Not found.", isError: true });
        if (!out) throw new Error(name);
        expect(knownBridgeResult(out)).toBe(true);
      }
  });

  test("everything else keeps today's behaviour: unknown", async () => {
    f = await setup();
    // A write tool's unexplained failure, thrown or returned as text.
    expect(await known(tool("probe_write", "memory:write", lost))).toBe(false);
    expect(await known(tool("probe_write", "memory:write", said))).toBe(false);
    // A browser action, and a connected app's read (its server's error could hide anything).
    expect(await known(tool("browser_fill", "browser:use", lost))).toBe(false);
    expect(
      await known(tool("probe_read", "probe:read", lost, { readOnly: true, connectionId: crypto.randomUUID() })),
    ).toBe(false);
    expect(await known(tool("probe_read", "context:read", lost, { readOnly: true, external: true }))).toBe(false);
    // A read scope alone is not the mark: a tool reached through the computer may share it (`bridge.test.ts`).
    expect(await known(tool("probe_read", "context:read", lost))).toBe(false);
  });

  test("our read tools carry the mark; the tools that write next to them don't", async () => {
    f = await setup();
    const ctx: ToolContext = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: crypto.randomUUID(),
      channelId: f.general.id,
      threadRootId: crypto.randomUUID(),
      triggerMessageId: crypto.randomUUID(),
    };
    const sources = [
      createContextToolSource(f.context),
      createIssueToolSource(f.artifactDeps),
      createWikiToolSource({ pubsub: f.pubsub, search: f.context }),
      createScheduleToolSource({ pubsub: f.pubsub, context: f.context }),
      createArtifactToolSource(f.artifactDeps),
    ];
    const all = (await Promise.all(sources.map((s) => s.tools(ctx)))).flat();
    const marked = (name: string) => {
      const def = all.find((t) => t.name === name);
      if (!def) throw new Error(`no ${name}`);
      return def.readOnly === true;
    };
    for (const name of [
      "read_conversation",
      "expand",
      "search_context",
      "get_summary",
      "list_issues",
      "search_wiki",
      "read_wiki_page",
      "list_routines",
      "list_reminders",
      "list_artifacts",
      "read_artifact",
    ])
      expect([name, marked(name)]).toEqual([name, true]);
    for (const name of ["remember", "update_memory", "create_issue", "comment_issue", "update_issue"])
      expect([name, marked(name)]).toEqual([name, false]);
  });
});

describe("our write tools that refuse before any write say so in a typed refusal", () => {
  /** Rows a tool of these could write: memories, messages, questions and queued jobs. */
  const writes = async () =>
    Promise.all(
      [schema.contextItems, schema.messages, schema.agentQuestions, schema.outbox].map(
        async (t) => (await f.db.select({ n: count() }).from(t))[0]?.n ?? 0,
      ),
    );
  const call = async (source: ToolSource, ctx: ToolContext, name: string, input: Record<string, unknown>) => {
    const def = (await source.tools(ctx)).find((t) => t.name === name);
    if (!def) throw new Error(`no ${name}`);
    const before = await writes();
    const out = await def.execute(input, ctx);
    expect(await writes()).toEqual(before);
    expect(out.isError).toBe(true);
    return out;
  };

  test("remember: a rule nobody here gave", async () => {
    f = await setup();
    const ctx = await runContext(f);
    const out = await call(
      createContextToolSource(f.context),
      { ...ctx, triggerMessageId: crypto.randomUUID() },
      "remember",
      {
        content: "Always deploy on Fridays",
        kind: "rule",
      },
    );
    expect(out.content).toContain("Not saved: a rule is kept only");
    expect(out.data).toMatchObject({ refusedByCheck: "forbidden" });
    expect(knownBridgeResult(out)).toBe(true);
  });

  test("save_how_to: a credential is never stored", async () => {
    f = await setup();
    const ctx = await runContext(f);
    const out = await call(createContextToolSource(f.context), ctx, "save_how_to", {
      title: "Merging",
      how: "the api key is sk-ant-api03-zzzzzzzzzzzzzzzzzzzzzz",
    });
    expect(out.content).toContain("credential");
    expect(out.data).toMatchObject({ refusedByCheck: "invalid_request" });
    expect(knownBridgeResult(out)).toBe(true);
  });

  test("hand_off: a run that is not a routine's", async () => {
    f = await setup();
    const ctx = await runContext(f);
    // Listed for background work only; this run is not a routine's.
    const out = await call(createHandOffToolSource({ pubsub: f.pubsub }), { ...ctx, background: true }, "hand_off", {
      message: "Done.",
    });
    expect(out.content).toContain("Only background work");
    expect(out.data).toMatchObject({ refusedByCheck: "forbidden" });
    expect(knownBridgeResult(out)).toBe(true);
  });

  test("follow_up: nobody reads the agents' DM to come back to", async () => {
    f = await setup();
    const ctx = await runContext(f);
    const other = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Infra", handle: "infra", role: "Ops", instructions: "Answer.", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    const dm = await openAgentDm(f.db, f.org.id, f.agent.id, other.id);
    await f.db.update(schema.agentRuns).set({ channelId: dm.id }).where(eq(schema.agentRuns.id, ctx.runId));
    const out = await call(createFollowUpToolSource({ pubsub: f.pubsub }), { ...ctx, channelId: dm.id }, "follow_up", {
      minutes: 10,
      note: "check",
      about: "check",
    });
    expect(out.content).toContain("Answer the agent that asked now");
    expect(out.data).toMatchObject({ refusedByCheck: "forbidden" });
    expect(knownBridgeResult(out)).toBe(true);
  });

  test("post_message: to the conversation it is already in", async () => {
    f = await setup();
    const ctx = await runContext(f);
    const [general] = await f.db.select().from(schema.channels).where(eq(schema.channels.id, f.general.id));
    const out = await call(createChatToolSource({ pubsub: f.pubsub, artifacts: f.artifactDeps }), ctx, "post_message", {
      channel: general?.name ?? "",
      text: "hi",
    });
    expect(out.content).toContain("That is this conversation");
    expect(out.data).toMatchObject({ refusedByCheck: "invalid_request" });
    expect(knownBridgeResult(out)).toBe(true);
  });

  test("ask_user: in the agents' DM, where no person reads", async () => {
    f = await setup();
    const ctx = await runContext(f);
    const other = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Infra", handle: "infra", role: "Ops", instructions: "Answer.", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    const dm = await openAgentDm(f.db, f.org.id, f.agent.id, other.id);
    const out = await call(createAskUserToolSource(), { ...ctx, channelId: dm.id }, "ask_user", {
      question: "Which invoice?",
      why: "There are two invoices with that number.",
    });
    expect(out.content).toContain("No person reads this conversation");
    expect(out.data).toMatchObject({ refusedByCheck: "forbidden" });
    expect(knownBridgeResult(out)).toBe(true);
  });
});
