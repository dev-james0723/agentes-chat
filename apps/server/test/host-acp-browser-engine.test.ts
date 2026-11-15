import { afterEach, expect, test } from "bun:test";
import {
  HOST_ACP_TOOL_NAMES,
  MACHINE_PROTOCOL_VERSION,
  type MachineRequest,
  type ServerFrame,
} from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import {
  claimHandoff,
  createAgent,
  createBrowserHandoffToolSource,
  createBrowserProfile,
  createBrowserToolSource,
  createSelfProfileToolSource,
  finishHandoff,
  grantScopes,
  handleMissionMcpCall,
  issueRunToolToken,
  type MachineCaller,
  type MachineStatus,
  postPersonMessage,
  requirePageRead,
  type ToolSource,
} from "@agenteschat/engine";
import { type Fixture, setup } from "../../../packages/engine/test/fixtures";
import { pairMachine } from "../../../packages/engine/test/machine-fixtures";
import { missionRunner } from "../../../packages/engine/test/mission-helpers";
import { HOST_ACP_TOOLS, runStructuredToolLoop } from "../runner/host-acp-intent";
import { handleMcpMessage } from "../runner/mcp";

let f: Fixture;
afterEach(async () => {
  await f?.machineHub?.stop();
  await f?.close();
  f = undefined as never;
});
const intent = (name: string, args: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "tool_call", name, arguments: args });
const final = JSON.stringify({ type: "final", text: "Observed the synthetic native DOM." });
type StructuredMcp = Parameters<typeof runStructuredToolLoop>[0]["mcp"];

/** All authority, gateway, MCP and structured intent layers are real; only machine page replies are fake. */
async function connected(extra: ToolSource[] = []) {
  const state = {
    machineId: "",
    orgId: "",
    status: {} as Partial<MachineStatus>,
    snapshot: '- heading "Public fixture"\n- textbox "Name" [ref=e1]\n- button "Save" [ref=e2]',
    fail: false,
  };
  const calls: MachineRequest[] = [];
  const pages = new Map<string, { url: string; value: string }>();
  const hub: MachineCaller = {
    async status(id) {
      if (id !== state.machineId) return null;
      return {
        id,
        orgId: state.orgId,
        name: "Synthetic Mac",
        os: "darwin",
        online: true,
        execAllowed: false,
        protocol: MACHINE_PROTOCOL_VERSION,
        executors: { browser: { available: true, version: "0.39.1" } },
        access: { folders: [], tools: { browser: true, claude: false, codex: false, commands: false } },
        ...state.status,
      };
    },
    async call(_machine, request) {
      const req = request as MachineRequest;
      calls.push(req);
      if (state.fail) throw new Error("Synthetic connection lost after delivery");
      if (!("agent" in req) || !req.agent) throw new Error("Missing bound agent");
      const key = "profile" in req && req.profile ? `profile:${req.profile.id}` : req.agent.id;
      const page = pages.get(key) ?? { url: "https://public.example/", value: "" };
      pages.set(key, page);
      const answer = (command: string, args: string[]) => {
        if (command === "open") page.url = args[0] ?? "";
        if (command === "fill") page.value = args[1] ?? "";
        return {
          success: true,
          data:
            command === "snapshot"
              ? { snapshot: `${state.snapshot}\n- paragraph "Own marker: ${page.value}"`, url: page.url, refs: {} }
              : { url: page.url },
        };
      };
      if (req.op === "browser.act") return answer(req.command, req.args) as never;
      if (req.op === "browser.batch") return { answers: req.commands.map((c) => answer(c.command, c.args)) } as never;
      return {} as never;
    },
  };
  const browser = createBrowserToolSource({
    machines: { hub },
    publicUrl: "https://workspace.example",
    profileWaitMs: 1,
    profilePollMs: 1,
  });
  const handoff = createBrowserHandoffToolSource({ machines: { hub } });
  f = await setup({
    machines: true,
    artifactTools: true,
    toolSources: [browser, handoff, createSelfProfileToolSource(), ...extra],
  });
  state.orgId = f.org.id;
  const paired = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { name: "Synthetic Mac" });
  state.machineId = paired.machineId;
  await f.db.update(schema.agents).set({ machineId: paired.machineId }).where(eq(schema.agents.id, f.agent.id));
  await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: null, scope: "browser:use" }]);
  const machineHub = f.machineHub;
  if (!machineHub) throw new Error("Missing fixture machine hub");
  const runner = missionRunner(machineHub);
  await runner.hello(paired.token);
  let sequence = 0;
  const wait = async <T extends ServerFrame>(callId: string, kind: T["type"]) => {
    for (let i = 0; i < 400; i++) {
      const found = runner.sent.find((x) => x.type === kind && "callId" in x && x.callId === callId);
      if (found) return found as T;
      await Bun.sleep(5);
    }
    throw new Error("No synthetic native MCP reply");
  };
  async function run(agentId = f.agent.id) {
    const message = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "Inspect only the public fixture.",
    });
    const [row] = await f.db
      .insert(schema.agentRuns)
      .values({
        orgId: f.org.id,
        agentId,
        channelId: f.general.id,
        triggerMessageId: message.id,
        threadRootId: message.id,
        trigger: "mention",
        hop: 1,
        status: "running",
      })
      .returning();
    if (!row) throw new Error("Missing fixture run");
    const token = await issueRunToolToken(f.db, {
      orgId: f.org.id,
      agentId,
      runId: row.id,
      machineId: paired.machineId,
    });
    const rawCall = async (name: string, args: Record<string, unknown> = {}, requireComplete = false) => {
      const callId = `dom-call-${++sequence}`;
      await runner.frame({
        type: "mcp.call",
        callId,
        taskId: "run",
        token,
        tool: name,
        args,
        ...(requireComplete ? { requireComplete: true } : {}),
      });
      return wait<Extract<ServerFrame, { type: "mcp.result" }>>(callId, "mcp.result");
    };
    const list = async () => {
      const callId = `dom-list-${++sequence}`;
      await runner.frame({ type: "mcp.list", callId, taskId: "run", token });
      const result = await wait<Extract<ServerFrame, { type: "mcp.tools" }>>(callId, "mcp.tools");
      if (!result.ok) throw new Error(result.error.message);
      expect(result.runStateVersion).toBe(3);
      return result.tools;
    };
    const rpc = async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
      const response = await handleMcpMessage(
        { jsonrpc: "2.0", id: ++sequence, method, params },
        async (name, args) => {
          const r = await rawCall(name, args);
          return r.ok ? { ...r, ok: true } : { ...r, ok: false, error: r.error.message, code: r.error.code };
        },
        undefined,
        list,
        "work",
        {},
        () => 3,
      );
      if (!response || !("result" in response)) throw new Error("Missing native MCP result");
      return response.result as T;
    };
    const mcp: StructuredMcp = {
      listTools: () => rpc<Awaited<ReturnType<StructuredMcp["listTools"]>>>("tools/list"),
      callTool: (params) => rpc("tools/call", params),
    };
    const prompts: string[] = [];
    const loop = async (intents: string[]) =>
      runStructuredToolLoop({
        prompt: "Use only the native public DOM fixture.",
        allowed: HOST_ACP_TOOLS,
        signal: new AbortController().signal,
        isAuthorized: () => true,
        ask: async (p) => {
          prompts.push(p);
          return intents.shift() ?? final;
        },
        mcp,
      });
    return { row, token, rawCall, list, loop, prompts };
  }
  return { state, calls, pages, run, paired, browser, hub, machineHub };
}

test("real native browser schemas and bound calls reach the structured model loop with honest partial readouts", async () => {
  const c = await connected(),
    r = await c.run();
  expect(
    await r.loop([
      intent("browser_open", { url: "https://public.example/" }),
      intent("browser_read"),
      intent("browser_fill", { target: "e1", text: "NATIVE_MARKER" }),
      intent("browser_click", { target: "e2" }),
      intent("browser_read"),
      final,
    ]),
  ).toContain("synthetic native DOM");
  expect(r.prompts.some((p) => p.includes("NATIVE_MARKER"))).toBe(true);
  expect(r.prompts.slice(1).every((p) => p.includes("PARTIAL result"))).toBe(true);
  expect(c.calls.every((c) => "agent" in c && c.agent?.id === f.agent.id)).toBe(true);
  const steps = await f.db.select().from(schema.agentRunSteps).where(eq(schema.agentRunSteps.runId, r.row.id));
  expect(steps.filter((s) => s.kind === "tool_call").map((s) => s.data.name)).toEqual([
    "browser_open",
    "browser_read",
    "browser_fill",
    "browser_click",
    "browser_read",
  ]);
  expect(r.row.triggerMessageId).toBeTruthy();
});

test("a long native page stays explicitly partial before and after bridge capping", async () => {
  const c = await connected(),
    r = await c.run();
  c.state.snapshot = "large-page ".repeat(7000);
  const read = await r.rawCall("browser_read");
  expect(read.ok).toBe(true);
  expect(read).toMatchObject({ runState: "completed", resultTruncated: true });
  if (read.ok) expect(read.text).toContain("The page is longer");
});

test("a complete-only client never gets a full-read claim for an already partial native page", async () => {
  const c = await connected(),
    r = await c.run();
  const read = await r.rawCall("browser_read", {}, true);
  expect(read.ok).toBe(false);
  expect(read).toMatchObject({ runState: "completed", resultTruncated: true });
  expect("complete" in read).toBe(false);
});

test("two native agent contexts keep independent page identities and can progress concurrently", async () => {
  const c = await connected();
  const other = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Other", handle: "other", role: "Engineering", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  await f.db.update(schema.agents).set({ machineId: c.paired.machineId }).where(eq(schema.agents.id, other.id));
  await grantScopes(f.db, f.org.id, other.id, [{ connectionId: null, scope: "browser:use" }]);
  const a = await c.run(),
    b = await c.run(other.id);
  await Promise.all([
    a.loop([intent("browser_fill", { target: "e1", text: "MARKER_A" }), intent("browser_read"), final]),
    b.loop([intent("browser_fill", { target: "e1", text: "MARKER_B" }), intent("browser_read"), final]),
  ]);
  expect(c.pages.get(f.agent.id)?.value).toBe("MARKER_A");
  expect(c.pages.get(other.id)?.value).toBe("MARKER_B");
  expect(a.prompts.at(-1)).not.toContain("MARKER_B");
  expect(b.prompts.at(-1)).not.toContain("MARKER_A");
});

test.each(["scope", "machine-off", "not-installed", "wrong-org"])("native %s refuses browser dispatch", async (why) => {
  const c = await connected(),
    r = await c.run();
  if (why === "scope")
    await f.db
      .delete(schema.agentScopes)
      .where(and(eq(schema.agentScopes.agentId, f.agent.id), eq(schema.agentScopes.scope, "browser:use")));
  if (why === "machine-off")
    c.state.status = {
      access: { folders: [], tools: { browser: false, claude: false, codex: false, commands: false } },
    };
  if (why === "not-installed")
    c.state.status = { executors: { browser: { available: false, reason: "No fixture browser" } } };
  if (why === "wrong-org") c.state.status = { orgId: crypto.randomUUID() };
  await expect(r.loop([intent("browser_open", { url: "https://public.example/" })])).rejects.toThrow();
  expect(c.calls).toHaveLength(0);
});

test("foreign machine token and ended native run never dispatch browser calls", async () => {
  const c = await connected(),
    r = await c.run();
  const foreign = await handleMissionMcpCall({ db: f.db, hub: c.machineHub, tools: f.tools }, crypto.randomUUID(), {
    type: "mcp.call",
    callId: "foreign",
    taskId: "run",
    token: r.token,
    tool: "browser_read",
    args: {},
  });
  expect(foreign.ok).toBe(false);
  await f.db.update(schema.agentRuns).set({ status: "canceled" }).where(eq(schema.agentRuns.id, r.row.id));
  expect((await r.rawCall("browser_read")).ok).toBe(false);
  expect(c.calls).toHaveLength(0);
});

test("own profile and native Drive artifact creation use the same bound gateway and audience", async () => {
  const c = await connected(),
    r = await c.run();
  await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: null, scope: "drive:write" }]);
  await r.loop([
    intent("get_my_profile"),
    intent("create_artifact", { title: "DOM probe", kind: "document", markdown: "Only synthetic DOM evidence." }),
    final,
  ]);
  expect(r.prompts[1]).toContain(f.agent.id);
  const artifacts = await f.db.select().from(schema.artifacts).where(eq(schema.artifacts.orgId, f.org.id));
  expect(artifacts).toHaveLength(1);
  expect(artifacts[0]).toMatchObject({
    channelId: f.general.id,
    threadId: null,
    share: "conversation",
    shareUserIds: [],
    shareRoleIds: [],
    currentVersion: 1,
    createdById: f.agent.id,
  });
  expect(HOST_ACP_TOOL_NAMES).toContain("create_artifact");
});

test("missing native Drive permission refuses artifact creation without broadening grants", async () => {
  const c = await connected(),
    r = await c.run();
  await f.db.delete(schema.agentScopes).where(eq(schema.agentScopes.agentId, f.agent.id));
  await expect(
    r.loop([intent("create_artifact", { title: "Should not exist", kind: "document", markdown: "Fixture" })]),
  ).rejects.toThrow("not offered");
  expect(await f.db.select().from(schema.artifacts)).toHaveLength(0);
});

test("a native shared profile keeps one holder while own profiles remain independent", async () => {
  const c = await connected();
  const other = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Other", handle: "other", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  await f.db.update(schema.agents).set({ machineId: c.paired.machineId }).where(eq(schema.agents.id, other.id));
  await grantScopes(f.db, f.org.id, other.id, [{ connectionId: null, scope: "browser:use" }]);
  const profile = await createBrowserProfile({ db: f.db, hub: c.hub }, f.owner.id, f.org.id, {
    machineId: c.paired.machineId,
    name: "Shared fixture",
    agentIds: [f.agent.id, other.id],
  });
  const a = await c.run(),
    b = await c.run(other.id);
  await a.loop([intent("browser_profile", { name: profile.name }), intent("browser_read"), final]);
  const commands = () => c.calls.filter((c) => c.op === "browser.act" || c.op === "browser.batch");
  const before = commands().length;
  await expect(b.loop([intent("browser_profile", { name: profile.name }), intent("browser_read")])).rejects.toThrow();
  expect(commands()).toHaveLength(before);
  const [held] = await f.db.select().from(schema.browserProfiles).where(eq(schema.browserProfiles.id, profile.id));
  expect(held?.heldByRunId).toBe(a.row.id);
  expect(commands().every((c) => "profile" in c && c.profile?.id === profile.id)).toBe(true);
});

test("native browser person handoff persists the original wait and enforces read after owner handback", async () => {
  const c = await connected(),
    r = await c.run();
  await expect(
    r.loop([intent("browser_ask_person", { instructions: "Inspect the harmless fixture then hand it back." })]),
  ).rejects.toThrow("suspended");
  const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, r.row.id));
  expect(run).toMatchObject({ status: "waiting_input", agentId: f.agent.id, triggerMessageId: r.row.triggerMessageId });
  const [handoff] = await f.db.select().from(schema.browserHandoffs).where(eq(schema.browserHandoffs.runId, r.row.id));
  if (!handoff) throw new Error("Missing fixture handoff");
  expect(handoff).toMatchObject({ requestedForUserId: f.owner.id, agentId: f.agent.id, status: "pending" });
  const deps = { db: f.db, pubsub: f.pubsub, hub: c.hub };
  await claimHandoff(deps, f.owner.id, f.org.id, handoff.id);
  await finishHandoff(deps, f.owner.id, f.org.id, handoff.id, { result: "done" });
  expect(await requirePageRead(f.db, { orgId: f.org.id, agentId: f.agent.id })).not.toBeNull();
  expect(c.calls.filter((c) => c.op === "browser.act" || c.op === "browser.batch")).toMatchObject([
    { op: "browser.act", command: "get", args: ["url"] },
  ]);
});

test("unknown native browser delivery stops the intent loop without another model intent or fallback", async () => {
  const c = await connected(),
    r = await c.run();
  c.state.fail = true;
  await expect(r.loop([intent("browser_read"), intent("browser_read"), final])).rejects.toThrow("effect unknown");
  expect(c.calls).toHaveLength(1);
  expect(r.prompts).toHaveLength(1);
});

test.each(["short", "gateway-cap", "known-error", "rejected-media"])(
  "native omission provenance survives %s without being reset",
  async (mode) => {
    const source: ToolSource = {
      name: "fixture-omission",
      tools: async () => [
        {
          name: "partial_fixture",
          scope: "",
          description: "Synthetic omission",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          execute: async () => ({
            content: mode === "gateway-cap" ? "x".repeat(60_000) : "Observed only part.",
            ...(mode !== "gateway-cap" ? { resultTruncated: true } : {}),
            ...(mode === "known-error" ? { isError: true, data: { code: "tool.not_allowed" } } : {}),
            ...(mode === "rejected-media" ? { images: [{ mediaType: "image/png" as const, data: "invalid" }] } : {}),
          }),
        },
      ],
    };
    const c = await connected([source]),
      r = await c.run();
    expect(await r.rawCall("partial_fixture")).toMatchObject({ runState: "completed", resultTruncated: true });
  },
);
