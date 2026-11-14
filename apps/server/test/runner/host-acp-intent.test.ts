import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { HOST_ACP_TOOLS, runStructuredToolLoop, ToolStopped, ToolSuspended } from "../../runner/host-acp-intent";
import { handleMcpMessage, type IpcReply, MCP_CUT_OFF, McpBridge } from "../../runner/mcp";

const issueTool = {
  _meta: { "agenteschat/runStateEnforced": true },
  name: "list_issues",
  description: "List issues",
  inputSchema: {
    type: "object",
    properties: { limit: { type: "integer", minimum: 1, maximum: 10 } },
    required: ["limit"],
    additionalProperties: false,
  },
};
type ListedTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  _meta?: Record<string, unknown>;
};
function harness(
  outputs: string[],
  pages: Array<{ tools: ListedTool[]; _meta?: Record<string, unknown> }> = [
    { tools: [issueTool], _meta: { "agenteschat/runStateVersion": 3 } },
  ],
) {
  const calls: unknown[] = [];
  const prompts: string[] = [];
  const mcp = {
    async listTools() {
      return pages.shift() ?? { tools: [issueTool], _meta: { "agenteschat/runStateVersion": 3 } };
    },
    async callTool(input: unknown) {
      calls.push(input);
      return {
        content: [{ type: "text", text: "3 issues" }],
        _meta: { "agenteschat/runState": "completed", "agenteschat/imageOmitted": false, "agenteschat/complete": true },
      };
    },
  };
  const ask = async (text: string) => {
    prompts.push(text);
    return outputs.shift() ?? "";
  };
  return { calls, prompts, mcp, ask };
}
const valid = '{"type":"tool_call","name":"list_issues","arguments":{"limit":3}}';

describe("structured MCP intent", () => {
  test.each([undefined, "false"])("rejects an unconfirmed image-state marker (%s)", async (omitted) => {
    const h = harness([valid, '{"type":"final","text":"I saw it"}'], [
      { tools: [issueTool], _meta: { "agenteschat/runStateVersion": 3 } },
    ] as any);
    h.mcp.listTools = async () => ({ tools: [issueTool], _meta: { "agenteschat/runStateVersion": 3 } }) as any;
    h.mcp.callTool = async (input) => {
      h.calls.push(input);
      return {
        content: [{ type: "text", text: "image attached" }],
        _meta: {
          "agenteschat/runState": "completed",
          "agenteschat/complete": true,
          ...(omitted !== undefined ? { "agenteschat/imageOmitted": omitted } : {}),
        },
      } as any;
    };
    await expect(
      runStructuredToolLoop({
        ...h,
        prompt: "x",
        allowed: new Set(["list_issues"]),
        signal: new AbortController().signal,
        isAuthorized: () => true,
      }),
    ).rejects.toThrow();
    expect(h.calls).toHaveLength(1);
    expect(h.prompts).toHaveLength(1);
  });
  test("calls exactly listed and schema-valid tool and returns final response", async () => {
    const h = harness([valid, '{"type":"final","text":"Found 3 issues."}']);
    expect(
      await runStructuredToolLoop({
        ...h,
        prompt: "List issues",
        allowed: new Set(["list_issues"]),
        signal: new AbortController().signal,
        isAuthorized: () => true,
      }),
    ).toBe("Found 3 issues.");
    expect(h.calls).toEqual([{ name: "list_issues", arguments: { limit: 3 } }]);
    expect(h.prompts[1]).toContain("3 issues");
  });
  test.each([
    ["extra property", '{"type":"tool_call","name":"list_issues","arguments":{"limit":3},"extra":1}'],
    ["unknown name", '{"type":"tool_call","name":"delete_everything","arguments":{}}'],
    ["invalid args", '{"type":"tool_call","name":"list_issues","arguments":{"limit":99}}'],
    ["multiple envelopes", valid + '\n{"type":"final","text":"done"}'],
    ["markdown wrapping", "```json\n" + valid + "\n```"],
  ])("rejects %s before any call", async (_, output) => {
    const h = harness([output]);
    await expect(
      runStructuredToolLoop({
        ...h,
        prompt: "x",
        allowed: new Set(["list_issues"]),
        signal: new AbortController().signal,
        isAuthorized: () => true,
      }),
    ).rejects.toThrow();
    expect(h.calls).toHaveLength(0);
  });
  test("does not repeat a call after unknown delivery", async () => {
    const h = harness([valid]);
    h.mcp.callTool = async (input) => {
      h.calls.push(input);
      throw new Error("transport closed");
    };
    await expect(
      runStructuredToolLoop({
        ...h,
        prompt: "x",
        allowed: new Set(["list_issues"]),
        signal: new AbortController().signal,
        isAuthorized: () => true,
      }),
    ).rejects.toThrow("unknown");
    expect(h.calls).toHaveLength(1);
  });
  test("rejects unsupported non-text tool results and never claims vision", async () => {
    const h = harness([valid]);
    h.mcp.callTool = async (input) => {
      h.calls.push(input);
      return {
        content: [{ type: "image", data: "base64", mimeType: "image/png" }],
        _meta: { "agenteschat/runState": "completed", "agenteschat/imageOmitted": false, "agenteschat/complete": true },
      } as any;
    };
    await expect(
      runStructuredToolLoop({
        ...h,
        prompt: "x",
        allowed: new Set(["list_issues"]),
        signal: new AbortController().signal,
        isAuthorized: () => true,
      }),
    ).rejects.toThrow("image");
    expect(h.calls).toHaveLength(1);
  });
  test("fails closed if advertised schema changes before dispatch", async () => {
    const changed = { ...issueTool, inputSchema: { ...issueTool.inputSchema, additionalProperties: true } };
    const h = harness(
      [valid],
      [
        { tools: [issueTool], _meta: { "agenteschat/runStateVersion": 3 } },
        { tools: [changed], _meta: { "agenteschat/runStateVersion": 3 } },
      ],
    );
    await expect(
      runStructuredToolLoop({
        ...h,
        prompt: "x",
        allowed: new Set(["list_issues"]),
        signal: new AbortController().signal,
        isAuthorized: () => true,
      }),
    ).rejects.toThrow();
    expect(h.calls).toHaveLength(0);
  });
  test.each([undefined, "unknown", "suspended"])(
    "stops after non-completed run state %s without another model prompt",
    async (state) => {
      const h = harness([valid, '{"type":"final","text":"incorrect"}']);
      h.mcp.callTool = async (input) => {
        h.calls.push(input);
        return {
          content: [{ type: "text", text: "waiting" }],
          ...(state ? { _meta: { "agenteschat/runState": state } } : {}),
        } as any;
      };
      await expect(
        runStructuredToolLoop({
          ...h,
          prompt: "x",
          allowed: new Set(["list_issues"]),
          signal: new AbortController().signal,
          isAuthorized: () => true,
        }),
      ).rejects.toThrow();
      expect(h.calls).toHaveLength(1);
      expect(h.prompts).toHaveLength(1);
    },
  );

  test("rejects an old bridge before asking the model or dispatching any tool", async () => {
    const h = harness([valid], [{ tools: [issueTool] }] as any);
    await expect(
      runStructuredToolLoop({
        ...h,
        prompt: "x",
        allowed: new Set(["list_issues"]),
        signal: new AbortController().signal,
        isAuthorized: () => true,
      }),
    ).rejects.toThrow("run-state");
    expect(h.prompts).toHaveLength(0);
    expect(h.calls).toHaveLength(0);
  });

  test("rejects v1 capability before model or tool execution", async () => {
    const h = harness([valid], [{ tools: [issueTool], _meta: { "agenteschat/runStateVersion": 1 } }] as any);
    await expect(
      runStructuredToolLoop({
        ...h,
        prompt: "x",
        allowed: new Set(["list_issues"]),
        signal: new AbortController().signal,
        isAuthorized: () => true,
      }),
    ).rejects.toThrow("run-state");
    expect(h.prompts).toHaveLength(0);
    expect(h.calls).toHaveLength(0);
  });

  test("rejects v2 before prompting because it cannot acknowledge complete results", async () => {
    const h = harness([valid], [{ tools: [issueTool], _meta: { "agenteschat/runStateVersion": 2 } }] as any);
    await expect(
      runStructuredToolLoop({
        ...h,
        prompt: "x",
        allowed: new Set(["list_issues"]),
        signal: new AbortController().signal,
        isAuthorized: () => true,
      }),
    ).rejects.toThrow();
    expect(h.prompts).toHaveLength(0);
    expect(h.calls).toHaveLength(0);
  });

  test("stops when a completed result lacks the server's completeness acknowledgement", async () => {
    const h = harness([valid, '{"type":"final","text":"incorrect"}']);
    h.mcp.callTool = async (input) => {
      h.calls.push(input);
      return {
        content: [{ type: "text", text: "possibly shortened" }],
        _meta: { "agenteschat/runState": "completed", "agenteschat/imageOmitted": false },
      } as any;
    };
    await expect(
      runStructuredToolLoop({
        ...h,
        prompt: "x",
        allowed: new Set(["list_issues"]),
        signal: new AbortController().signal,
        isAuthorized: () => true,
      }),
    ).rejects.toThrow();
    expect(h.calls).toHaveLength(1);
    expect(h.prompts).toHaveLength(1);
  });

  test("suspension takes priority even when the result also omitted an image", async () => {
    const h = harness([valid]);
    h.mcp.callTool = async (input) => {
      h.calls.push(input);
      return {
        content: [{ type: "text", text: "waiting" }],
        _meta: { "agenteschat/runState": "suspended", "agenteschat/imageOmitted": true },
      } as any;
    };
    await expect(
      runStructuredToolLoop({
        ...h,
        prompt: "x",
        allowed: new Set(["list_issues"]),
        signal: new AbortController().signal,
        isAuthorized: () => true,
      }),
    ).rejects.toBeInstanceOf(ToolSuspended);
    expect(h.calls).toHaveLength(1);
    expect(h.prompts).toHaveLength(1);
  });

  test("will not call a tool lacking the gateway-enforced marker", async () => {
    const unmarked = { ...issueTool, _meta: {} };
    const h = harness([valid], [{ tools: [unmarked], _meta: { "agenteschat/runStateVersion": 3 } }]);
    await expect(
      runStructuredToolLoop({ ...h, prompt: "x", signal: new AbortController().signal, isAuthorized: () => true }),
    ).rejects.toThrow();
    expect(h.calls).toHaveLength(0);
  });
  test("rejects unsupported schema keywords rather than silently ignoring them", async () => {
    const unsafe = { ...issueTool, inputSchema: { ...issueTool.inputSchema, customCriticalRule: true } };
    const h = harness([valid], [{ tools: [unsafe], _meta: { "agenteschat/runStateVersion": 3 } }]);
    await expect(
      runStructuredToolLoop({
        ...h,
        prompt: "x",
        allowed: new Set(["list_issues"]),
        signal: new AbortController().signal,
        isAuthorized: () => true,
      }),
    ).rejects.toThrow();
    expect(h.calls).toHaveLength(0);
  });
  test("rejects external schema references without fetching them", async () => {
    const unsafe = { ...issueTool, inputSchema: { type: "object", $ref: "https://example.test/schema" } };
    const h = harness([valid], [{ tools: [unsafe], _meta: { "agenteschat/runStateVersion": 3 } }] as any);
    await expect(
      runStructuredToolLoop({
        ...h,
        prompt: "x",
        allowed: new Set(["list_issues"]),
        signal: new AbortController().signal,
        isAuthorized: () => true,
      }),
    ).rejects.toThrow();
    expect(h.calls).toHaveLength(0);
  });

  test("offers no tools unless explicitly enabled by the runner", async () => {
    const h = harness([valid]);
    await expect(
      runStructuredToolLoop({ ...h, prompt: "x", signal: new AbortController().signal, isAuthorized: () => true }),
    ).rejects.toThrow();
    expect(h.calls).toHaveLength(0);
    expect(h.prompts[0]).toContain("You can use these app tools: []");
  });
});

describe("native typed result and receipt contract", () => {
  const meta = {
    "agenteschat/runState": "completed",
    "agenteschat/imageOmitted": false,
    "agenteschat/resultTruncated": false,
  };
  const tool = (
    name = "list_issues",
    inputSchema = { type: "object", properties: {}, additionalProperties: false },
  ) => ({
    name,
    description: name,
    inputSchema,
    _meta: { "agenteschat/runStateEnforced": true },
  });
  const call = (name = "list_issues", args = {}) => JSON.stringify({ type: "tool_call", name, arguments: args });
  const final = (text = "done") => JSON.stringify({ type: "final", text });
  function harness(outputs: string[], tools = [tool()]) {
    const calls: any[] = [],
      prompts: string[] = [];
    const h = {
      calls,
      prompts,
      allowed: HOST_ACP_TOOLS,
      prompt: "task marker",
      signal: new AbortController().signal,
      isAuthorized: () => true,
      ask: async (text: string) => {
        prompts.push(text);
        return outputs.shift() ?? final();
      },
      mcp: {
        listTools: async (): Promise<any> => ({ tools, _meta: { "agenteschat/runStateVersion": 3 } }),
        callTool: async (input: any): Promise<any> => {
          calls.push(input);
          return { content: [{ type: "text", text: "ok" }], _meta: meta };
        },
      },
    };
    return h;
  }

  test("explicit qualified allowlist and native per-run intersection", async () => {
    expect([...HOST_ACP_TOOLS].sort()).toEqual(
      [
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
      ].sort(),
    );
    for (const name of HOST_ACP_TOOLS) {
      const schema: any = {
        type: "object",
        properties: { timeout_seconds: { type: "integer" } },
        additionalProperties: false,
      };
      const h = harness([call(name), final()], [tool(name, schema)]);
      expect(await runStructuredToolLoop(h)).toBe("done");
      expect(h.calls[0].name).toBe(name);
    }
    const h = harness([call("delete_everything")], [tool("delete_everything")]);
    await expect(runStructuredToolLoop(h)).rejects.toThrow("not offered");
    expect(h.calls).toHaveLength(0);
  });

  test.each([
    "not JSON",
    "[]",
    "{}",
    call() + final(),
    "```json\n" + call() + "\n```",
    '{"type":"final","text":"x","extra":1}',
    '{"type":"tool_call","name":"list_issues","arguments":[]}',
  ])("malformed intent rejected before dispatch: %s", async (raw) => {
    const h = harness([raw]);
    await expect(runStructuredToolLoop(h)).rejects.toThrow();
    expect(h.calls).toHaveLength(0);
  });

  test.each([undefined, 1, "2"])("missing/old list metadata fails before model: %s", async (version) => {
    const h = harness([call()]);
    h.mcp.listTools = async () => ({ tools: [tool()], _meta: { "agenteschat/runStateVersion": version } });
    await expect(runStructuredToolLoop(h)).rejects.toThrow("run-state");
    expect(h.prompts).toHaveLength(0);
  });

  test("unmarked tools, changed schemas and revocation fail before dispatch", async () => {
    const h = harness([call()]);
    h.mcp.listTools = async () => ({ tools: [{ ...tool(), _meta: {} }], _meta: { "agenteschat/runStateVersion": 3 } });
    await expect(runStructuredToolLoop(h)).rejects.toThrow();
    expect(h.calls).toHaveLength(0);
    const revoked = harness([call()]);
    revoked.ask = async () => {
      revoked.isAuthorized = () => false;
      return call();
    };
    await expect(runStructuredToolLoop(revoked)).rejects.toThrow("authorization");
    expect(revoked.calls).toHaveLength(0);
    const changed = harness([call()]);
    let n = 0;
    changed.mcp.listTools = async () => ({
      tools: [++n === 1 ? tool() : tool("list_issues", { type: "object", properties: {}, additionalProperties: true })],
      _meta: { "agenteschat/runStateVersion": 3 },
    });
    await expect(runStructuredToolLoop(changed)).rejects.toThrow("schema changed");
    expect(changed.calls).toHaveLength(0);
  });

  test.each([undefined, "unknown"])("missing run outcome stops without another ask: %s", async (state) => {
    const h = harness([call(), final("false success")]);
    h.mcp.callTool = async (input) => {
      h.calls.push(input);
      return { content: [], _meta: { ...meta, "agenteschat/runState": state } };
    };
    await expect(runStructuredToolLoop(h)).rejects.toBeInstanceOf(ToolStopped);
    expect(h.calls).toHaveLength(1);
    expect(h.prompts).toHaveLength(1);
  });

  test("native ask_user suspension stops before another prompt; new phase receives context", async () => {
    const h = harness([call("ask_user"), final("false success")], [tool("ask_user")]);
    h.mcp.callTool = async (input) => {
      h.calls.push(input);
      return { content: [], _meta: { ...meta, "agenteschat/runState": "suspended" } };
    };
    await expect(runStructuredToolLoop(h)).rejects.toBeInstanceOf(ToolSuspended);
    expect(h.prompts).toHaveLength(1);
    const next = harness([final("marker answer received")]);
    next.prompt = "original task marker; ask_user answered: harmless marker";
    expect(await runStructuredToolLoop(next)).toBe("marker answer received");
    expect(next.prompts[0]).toContain("original task marker");
  });

  test("returned cutoff AFTER a recorded side effect preserves code and never replays", async () => {
    const h = harness([call("write_file"), call("write_file")], [tool("write_file")]);
    let effects = 0;
    h.mcp.callTool = async (input) => {
      h.calls.push(input);
      effects++;
      const rpc: any = await handleMcpMessage(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "write_file" } },
        async () => ({ ok: false, error: MCP_CUT_OFF, code: "bridge.cut_off", callId: "effect-1" }),
        undefined,
        async () => [tool("write_file")],
      );
      return rpc.result;
    };
    await expect(runStructuredToolLoop(h)).rejects.toThrow("bridge.cut_off; effect unknown; receipt effect-1");
    expect(effects).toBe(1);
    expect(h.prompts).toHaveLength(1);
  });

  test("thrown transport error after dispatch never replays", async () => {
    const h = harness([call(), call()]);
    let effects = 0;
    h.mcp.callTool = async () => {
      effects++;
      throw new Error("socket closed");
    };
    await expect(runStructuredToolLoop(h)).rejects.toThrow("delivery_unknown");
    expect(effects).toBe(1);
    expect(h.prompts).toHaveLength(1);
  });

  test("real isolated red -> fix -> green feeds completed failing exit/output back", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "argon-contract-"));
    try {
      const file = path.join(dir, "value.json");
      writeFileSync(file, "0");
      const schema: any = {
        type: "object",
        properties: { timeout_seconds: { type: "integer" }, content: { type: "string" } },
        additionalProperties: false,
      };
      const h = harness(
        [call("run_code"), call("write_file", { content: "1" }), call("run_code"), final("tests green")],
        [tool("run_code", schema), tool("write_file", schema)],
      );
      const exits: number[] = [];
      h.mcp.callTool = async (input) => {
        h.calls.push(input);
        if (input.name === "write_file") {
          writeFileSync(file, input.arguments.content);
          return { content: [{ type: "text", text: "written" }], _meta: meta };
        }
        const result = Bun.spawnSync([
          process.execPath,
          "-e",
          'const fs=require("node:fs"); if(fs.readFileSync(process.argv[1],"utf8")!=="1"){console.error("expected 1, got 0");process.exit(1)} console.log("1 assertion passed")',
          file,
        ]);
        exits.push(result.exitCode);
        return {
          isError: result.exitCode !== 0,
          content: [{ type: "text", text: `exit code ${result.exitCode}\n${result.stdout}\n${result.stderr}` }],
          _meta: { ...meta, "agenteschat/errorCode": "tool.failed" },
        };
      };
      expect(await runStructuredToolLoop(h)).toBe("tests green");
      expect(exits).toEqual([1, 0]);
      expect(h.prompts[1]).toContain("expected 1, got 0");
      expect(h.prompts[1]).toContain("Known completed tool error");
      expect(h.prompts[1]).toContain("partial changes");
      expect(readFileSync(file, "utf8")).toBe("1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("same mutation intent is not dispatched twice", async () => {
    const h = harness([call("create_issue"), call("create_issue")], [tool("create_issue")]);
    await expect(runStructuredToolLoop(h)).rejects.toThrow("duplicate_intent");
    expect(h.calls).toHaveLength(1);
  });

  test.each(["run_code", "run_skill_script"])(
    "real command test -> %s fix -> identical test reaches green",
    async (fixTool) => {
      const dir = mkdtempSync(path.join(tmpdir(), "argon-command-fix-"));
      let bridge: McpBridge | undefined;
      try {
        const file = path.join(dir, "value"),
          script = path.join(dir, "fix.js");
        writeFileSync(file, "0");
        writeFileSync(script, 'require("node:fs").writeFileSync(process.argv[2],"1")');
        const verify = 'if(require("node:fs").readFileSync(process.argv[1],"utf8")!=="1")process.exit(1)';
        const fix = 'require("node:fs").writeFileSync(process.argv[1],"1")';
        const schema: any = {
          type: "object",
          properties: { code: { type: "string" }, script: { type: "string" }, timeout_seconds: { type: "integer" } },
          additionalProperties: false,
        };
        const h = harness(
          [
            call("run_code", { code: verify }),
            call(fixTool, fixTool === "run_code" ? { code: fix } : { script: "fix.js" }),
            call("run_code", { code: verify }),
            final("green"),
          ],
          [tool("run_code", schema), tool("run_skill_script", schema)],
        );
        const exits: number[] = [];
        const receipts: string[] = [];
        bridge = new McpBridge({
          socketPath: path.join(dir, "unused.sock"),
          task: (id) =>
            id === "native-command-run"
              ? { token: "local", serverToken: "server", runId: id, missionId: "", running: true }
              : null,
        });
        bridge.attach((frame) => {
          if (frame.type !== "mcp.call") return;
          receipts.push(frame.callId);
          const result = Bun.spawnSync(
            frame.tool === "run_code"
              ? [process.execPath, "-e", frame.args.code as string, file]
              : [process.execPath, script, file],
          );
          exits.push(result.exitCode);
          bridge!.result({
            type: "mcp.result",
            callId: frame.callId,
            runState: "completed",
            imageOmitted: false,
            resultTruncated: false,
            ...(result.exitCode === 0
              ? { ok: true as const, text: "exit 0" }
              : { ok: false as const, error: { code: "tool.failed", message: "exit 1" } }),
          });
        });
        h.mcp.callTool = async (input) => {
          h.calls.push(input);
          const reply = await bridge!.handle({
            taskId: "native-command-run",
            token: "local",
            tool: input.name,
            args: input.arguments,
          });
          const rpc: any = await handleMcpMessage(
            { jsonrpc: "2.0", id: 1, method: "tools/call", params: input },
            async () => reply,
            undefined,
            async () => [tool("run_code", schema), tool("run_skill_script", schema)],
          );
          return rpc.result;
        };
        expect(await runStructuredToolLoop(h)).toBe("green");
        expect(exits).toEqual([1, 0, 0]);
        expect(h.calls).toHaveLength(3);
        expect(new Set(receipts).size).toBe(3);
        expect(receipts[0]).not.toBe(receipts[2]);
        expect(readFileSync(file, "utf8")).toBe("1");
      } finally {
        await bridge?.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test("an identical successful command is blocked without an intervening workspace call", async () => {
    const schema: any = {
      type: "object",
      properties: { timeout_seconds: { type: "integer" } },
      additionalProperties: false,
    };
    const h = harness([call("run_code"), call("run_code")], [tool("run_code", schema)]);
    await expect(runStructuredToolLoop(h)).rejects.toThrow("duplicate_intent");
    expect(h.calls).toHaveLength(1);
  });

  test.each(["run_code", "run_skill_script"])(
    "an immediate identical %s after fresh resume is blocked",
    async (name) => {
      const schema: any = {
        type: "object",
        properties: { timeout_seconds: { type: "integer" } },
        additionalProperties: false,
      };
      const h = harness([call(name)], [tool(name, schema)]);
      const history = {
        runId: "original-native-run",
        observations: [
          {
            seq: 1,
            callId: "original-call-id",
            name,
            input: { timeout_seconds: 120 },
            content: "completed native command receipt",
            isError: false,
            state: "completed" as const,
            partial: true,
          },
        ],
      };
      await expect(runStructuredToolLoop({ ...h, history, runId: history.runId })).rejects.toThrow("duplicate_intent");
      expect(h.calls).toHaveLength(0);
    },
  );

  test("native receipt reconstruction preserves observations, scope and completed-effect deduplication", async () => {
    const history = {
      runId: "native-run-123456",
      observations: [
        {
          seq: 1,
          callId: "effect-123",
          name: "create_issue",
          input: {},
          content: "UNIQUE_COMPLETED_RECEIPT",
          isError: false,
          state: "completed" as const,
          partial: true,
        },
      ],
    };
    const h = harness([call("create_issue")], [tool("create_issue")]);
    await expect(runStructuredToolLoop({ ...h, runId: history.runId, history })).rejects.toThrow("duplicate_intent");
    expect(h.calls).toHaveLength(0);
    expect(h.prompts[0]).toContain("UNIQUE_COMPLETED_RECEIPT");
    expect(h.prompts[0]).toContain("NOT a full read");
    for (const invalid of [
      { ...history, runId: "other-run" },
      { ...history, observations: history.observations.map((o) => ({ ...o, state: "unknown" as const })) },
      { ...history, observations: history.observations.map((o) => ({ ...o, content: "x".repeat(8001) })) },
    ]) {
      const h = harness([final()]);
      await expect(runStructuredToolLoop({ ...h, runId: history.runId, history: invalid })).rejects.toBeInstanceOf(
        ToolStopped,
      );
      expect(h.prompts).toHaveLength(0);
      expect(h.calls).toHaveLength(0);
    }
  });

  test.each(["run_code", "run_skill_script"])(
    "an uncertain %s fix stops before any verification replay",
    async (name) => {
      const schema: any = {
        type: "object",
        properties: { timeout_seconds: { type: "integer" } },
        additionalProperties: false,
      };
      const h = harness([call(name), call(name)], [tool(name, schema)]);
      let effects = 0;
      h.mcp.callTool = async () => {
        effects++;
        return { isError: true, content: [], _meta: { ...meta, "agenteschat/errorCode": "bridge.cut_off" } };
      };
      await expect(runStructuredToolLoop(h)).rejects.toThrow("effect unknown");
      expect(effects).toBe(1);
      expect(h.prompts).toHaveLength(1);
    },
  );

  test.each([240, 241, 3600])(
    "foreground deadline bounds requested execution before dispatch (%s)",
    async (seconds) => {
      const schema: any = {
        type: "object",
        properties: { timeout_seconds: { type: "integer" } },
        additionalProperties: false,
      };
      const h = harness([call("run_code", { timeout_seconds: seconds }), final()], [tool("run_code", schema)]);
      if (seconds <= 240) {
        await runStructuredToolLoop(h);
        expect(h.calls[0].arguments.timeout_seconds).toBe(seconds);
      } else {
        await expect(runStructuredToolLoop(h)).rejects.toThrow("240s");
        expect(h.calls).toHaveLength(0);
      }
    },
  );

  test.each([100_000, 100_002])("UTF8 result byte bound (%s)", async (bytes) => {
    const h = harness([call(), final()]);
    h.mcp.callTool = async () => ({ content: [{ type: "text", text: "é".repeat(bytes / 2) }], _meta: meta });
    if (bytes === 100_000) expect(await runStructuredToolLoop(h)).toBe("done");
    else {
      await expect(runStructuredToolLoop(h)).rejects.toThrow("result_too_large");
      expect(h.prompts).toHaveLength(1);
    }
  });

  test("truncation and omitted images are explicit and pixels never enter model text", async () => {
    const h = harness([call(), final()]);
    h.mcp.callTool = async () => ({
      content: [
        { type: "text", text: "some text" },
        { type: "image", data: "SECRET_PIXELS" },
      ],
      _meta: { ...meta, "agenteschat/imageOmitted": true, "agenteschat/resultTruncated": true },
    });
    await runStructuredToolLoop(h);
    expect(h.prompts[1]).toContain("PARTIAL result");
    expect(h.prompts[1]).toContain("NOT inspected");
    expect(h.prompts[1]).not.toContain("SECRET_PIXELS");
  });

  test("completed media replay receipt is preserved, never placeholder success", async () => {
    const h = harness([call(), final()]);
    h.mcp.callTool = async () => ({
      isError: true,
      content: [],
      _meta: {
        ...meta,
        "agenteschat/imageOmitted": true,
        "agenteschat/errorCode": "bridge.completed_media_unavailable",
      },
    });
    await expect(runStructuredToolLoop(h)).rejects.toThrow("completed_media_unavailable; effect completed");
    expect(h.prompts).toHaveLength(1);
  });

  test("tool budget produces honest incomplete phase and no extra effect", async () => {
    const h = harness([call(), call(), call()]);
    const answer = await runStructuredToolLoop({ ...h, maxCalls: 2 });
    expect(answer).toStartWith("Incomplete:");
    expect(answer).toContain("new native task phase");
    expect(h.calls).toHaveLength(2);
  });

  test("runner preserves images/state and denies a different run token", async () => {
    const bridge = new McpBridge({
      socketPath: path.join(tmpdir(), "unused-argon.sock"),
      task: (id) =>
        id === "run-12345678"
          ? { token: "local", serverToken: "server", runId: id, missionId: "", running: true }
          : null,
    });
    let sent = 0;
    bridge.attach((frame) => {
      sent++;
      if (frame.type === "mcp.call")
        bridge.result({
          type: "mcp.result",
          callId: frame.callId,
          ok: true,
          text: "image",
          images: [{ mediaType: "image/png", data: "aGVsbG8=" }],
          runState: "completed",
          imageOmitted: true,
        });
    });
    try {
      const denied = await bridge.handle({ taskId: "run-12345678", token: "other", tool: "read_file", args: {} });
      expect(denied.ok).toBe(false);
      expect(sent).toBe(0);
      const reply = await bridge.handle({ taskId: "run-12345678", token: "local", tool: "read_file", args: {} });
      expect(reply).toMatchObject({
        ok: true,
        runState: "completed",
        imageOmitted: true,
        images: [{ data: "aGVsbG8=" }],
      });
      const rpc: any = await handleMcpMessage(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_file" } },
        async () => reply,
        undefined,
        async () => [tool("read_file")],
      );
      expect(rpc.result.content[1]).toMatchObject({ type: "image", data: "aGVsbG8=" });
      expect(rpc.result._meta["agenteschat/runState"]).toBe("completed");
    } finally {
      await bridge.close();
    }
  });

  test("only actual typed server lists qualify; local/delegated tools cannot self-assert", async () => {
    const list = async () => [tool()];
    const call = async (): Promise<IpcReply> => ({ ok: true, text: "ok" });
    const req = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    for (const [context, version] of [
      [{}, undefined],
      [{ local: true }, () => 2],
    ] as const) {
      const rpc: any = await handleMcpMessage(req, call, undefined, list, "work", context, version as any);
      expect(rpc.result._meta).toBeUndefined();
      expect(rpc.result.tools[0]._meta?.["agenteschat/runStateEnforced"]).toBeUndefined();
    }
    const rpc: any = await handleMcpMessage(req, call, undefined, list, "work", {}, () => 3);
    expect(rpc.result._meta["agenteschat/runStateVersion"]).toBe(3);
    expect(rpc.result.tools[0]._meta["agenteschat/runStateEnforced"]).toBe(true);
  });
});

describe("version-3 completion observations", () => {
  test("an explicit native partial flag replaces a full-read claim with a warning", async () => {
    const h = harness([valid, '{"type":"final","text":"Only the observed text."}']);
    h.mcp.callTool = async (input) => {
      h.calls.push(input);
      return {
        content: [{ type: "text", text: "partial observation" }],
        _meta: {
          "agenteschat/runState": "completed",
          "agenteschat/imageOmitted": true,
          "agenteschat/resultTruncated": true,
        },
      } as any;
    };
    expect(
      await runStructuredToolLoop({
        ...h,
        prompt: "x",
        allowed: new Set(["list_issues"]),
        signal: new AbortController().signal,
        isAuthorized: () => true,
      }),
    ).toBe("Only the observed text.");
    expect(h.prompts[1]).toContain("NOT inspected");
    expect(h.prompts[1]).toContain("PARTIAL result");
    expect(h.calls).toHaveLength(1);
  });
  test("conflicting full and partial acknowledgements stop without another prompt", async () => {
    const h = harness([valid]);
    h.mcp.callTool = async (input) => {
      h.calls.push(input);
      return {
        content: [{ type: "text", text: "x" }],
        _meta: {
          "agenteschat/runState": "completed",
          "agenteschat/imageOmitted": false,
          "agenteschat/complete": true,
          "agenteschat/resultTruncated": true,
        },
      } as any;
    };
    await expect(
      runStructuredToolLoop({
        ...h,
        prompt: "x",
        allowed: new Set(["list_issues"]),
        signal: new AbortController().signal,
        isAuthorized: () => true,
      }),
    ).rejects.toThrow("completeness_conflict");
    expect(h.calls).toHaveLength(1);
    expect(h.prompts).toHaveLength(1);
  });
});
