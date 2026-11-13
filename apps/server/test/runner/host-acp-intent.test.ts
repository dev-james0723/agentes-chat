import { describe, expect, test } from "bun:test";
import { runStructuredToolLoop, ToolSuspended } from "../../runner/host-acp-intent";

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
  test.each([true, undefined, "false"])(
    "never sends omitted or unconfirmed image data to the model (%s)",
    async (omitted) => {
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
    },
  );
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
