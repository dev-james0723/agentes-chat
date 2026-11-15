import { describe, expect, test } from "bun:test";
import { HOST_ACP_TOOL_NAMES, isHostAcpHistory } from "@agenteschat/adapters/machine-protocol";
import { HOST_ACP_TOOLS, runStructuredToolLoop } from "../../runner/host-acp-intent";
import { handleMcpMessage } from "../../runner/mcp";

const browserNames = [
  "browser_open",
  "browser_back",
  "browser_tabs",
  "browser_read",
  "browser_click",
  "browser_fill",
  "browser_select",
  "browser_check",
  "browser_press",
  "browser_scroll",
  "browser_wait",
  "browser_ask_person",
  "browser_close",
  "browser_profile",
];
const call = (name: string, arguments_: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "tool_call", name, arguments: arguments_ });
const final = JSON.stringify({ type: "final", text: "Only the observed DOM fact." });
type StructuredMcp = Parameters<typeof runStructuredToolLoop>[0]["mcp"];

/** Real runner JSON-RPC/result/schema loop; only the native server transport is synthetic here. */
function harness(
  intents: string[],
  name: string,
  inputSchema: Record<string, unknown> = {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
) {
  let id = 0;
  const calls: unknown[] = [],
    prompts: string[] = [];
  const list = async () => [{ name, description: "Native DOM observation", inputSchema }];
  const rpc = async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    const response = await handleMcpMessage(
      { jsonrpc: "2.0", id: ++id, method, params },
      async (tool, args) => {
        calls.push({ name: tool, arguments: args });
        return { ok: true, text: "Observed DOM", runState: "completed", imageOmitted: false, resultTruncated: true };
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
  return {
    calls,
    prompts,
    options: {
      prompt: "Read the public page through native tools.",
      allowed: HOST_ACP_TOOLS,
      signal: new AbortController().signal,
      isAuthorized: () => true,
      ask: async (prompt: string) => {
        prompts.push(prompt);
        return intents.shift() ?? final;
      },
      mcp,
    },
  };
}

describe("qualified native DOM transport", () => {
  test("has exactly the original tools plus explicit DOM and core workflow names", () => {
    const original = [
      "list_issues",
      "load_skill",
      "read_skill_file",
      "search_wiki",
      "read_wiki_page",
      "find_agent",
      "ask_agent",
      "tell_agent",
      "ask_user",
      "comment_issue",
      "update_issue",
      "create_issue",
      "list_files",
      "read_file",
      "write_file",
      "run_code",
      "run_skill_script",
    ];
    expect([...HOST_ACP_TOOL_NAMES].sort() as string[]).toEqual(
      [...original, ...browserNames, "get_my_profile", "create_artifact"].sort(),
    );
    expect(HOST_ACP_TOOLS.size).toBe(33);
    for (const name of [
      "browser_do",
      "browser_upload",
      "browser_type_secret",
      "browser_make_password",
      "browser_screenshot",
      "phone_tap",
    ])
      expect(HOST_ACP_TOOLS.has(name)).toBe(false);
  });

  test.each(["browser_read", "get_my_profile"])(
    "repeated %s remains an observation through actual MCP handling",
    async (name) => {
      const h = harness([call(name), call(name), final], name);
      expect(await runStructuredToolLoop(h.options)).toBe("Only the observed DOM fact.");
      expect(h.calls).toHaveLength(2);
      expect(h.prompts[1]).toContain("PARTIAL result");
    },
  );

  test("only tabs-list can repeat; opening or switching tabs remains an effect", async () => {
    const schema = {
      type: "object",
      properties: { action: { enum: ["list", "open", "switch", "close"] } },
      required: ["action"],
      additionalProperties: false,
    };
    const reads = harness(
      [call("browser_tabs", { action: "list" }), call("browser_tabs", { action: "list" }), final],
      "browser_tabs",
      schema,
    );
    await runStructuredToolLoop(reads.options);
    expect(reads.calls).toHaveLength(2);
    for (const action of ["open", "switch", "close"]) {
      const effects = harness(
        [call("browser_tabs", { action }), call("browser_tabs", { action })],
        "browser_tabs",
        schema,
      );
      await expect(runStructuredToolLoop(effects.options)).rejects.toThrow("duplicate_intent");
      expect(effects.calls).toHaveLength(1);
    }
  });

  test.each(["browser_click", "browser_open", "browser_scroll", "browser_wait", "browser_profile", "create_artifact"])(
    "identical %s remains fenced including authenticated continuation history",
    async (name) => {
      const h = harness([call(name), call(name)], name);
      await expect(runStructuredToolLoop(h.options)).rejects.toThrow("duplicate_intent");
      expect(h.calls).toHaveLength(1);
      const resumed = harness([call(name)], name);
      const history = {
        runId: "native-run",
        observations: [
          {
            seq: 1,
            callId: "prior-call",
            name,
            input: {},
            content: "Observed prior result",
            isError: false,
            state: "completed" as const,
            partial: true,
          },
        ],
      };
      expect(isHostAcpHistory(history, history.runId)).toBe(true);
      await expect(runStructuredToolLoop({ ...resumed.options, runId: history.runId, history })).rejects.toThrow(
        "duplicate_intent",
      );
      expect(resumed.calls).toHaveLength(0);
    },
  );

  test.each([
    "browser_do",
    "browser_upload",
    "browser_type_secret",
    "browser_make_password",
    "browser_screenshot",
    "phone_tap",
  ])("does not dispatch unqualified %s despite listing it", async (name) => {
    const h = harness([call(name)], name);
    await expect(runStructuredToolLoop(h.options)).rejects.toThrow("not offered");
    expect(h.calls).toHaveLength(0);
  });
});
