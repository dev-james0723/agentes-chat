import { describe, expect, test } from "bun:test";
import {
  HostAcpPeer,
  hostAcpLaunch,
  hostAcpNewSession,
  hostAcpPermissionReply,
  runHostAcpSession,
} from "../../runner/host-acp-candidate";

describe("host ACP candidate (not wired into the runner)", () => {
  const base = {
    optIn: true,
    os: "darwin" as const,
    runnerMode: "single" as const,
    phones: false as const,
    sameOwner: true,
    isolationVerified: true,
    binary: "/usr/local/bin/agy",
    home: "/tmp",
    scratch: "/tmp/agentes-acp-test",
  };

  test("requires explicit consent, one owner, phone-off, macOS and verified isolation", () => {
    for (const input of [
      { ...base, optIn: false },
      { ...base, sameOwner: false },
      { ...base, phones: true },
      { ...base, runnerMode: "system" },
      { ...base, os: "linux" },
      { ...base, isolationVerified: false },
    ])
      expect(() => hostAcpLaunch(input)).toThrow();
  });

  test("forces sandbox and explicit isolated customization paths, never modifies the host HOME", () => {
    const r = hostAcpLaunch(base);
    expect(r.command).toBe(base.binary);
    expect(r.args).toEqual([
      "acp",
      "--sandbox",
      "--process-per-session",
      "--gemini-dir",
      "agentes-acp-test/gemini",
      "--app-data-dir",
      "antigravity-cli",
      "--include-default-customizations=false",
    ]);
    expect(r.args.join(" ")).not.toContain("dangerously");
    expect(JSON.stringify(r)).not.toContain("HOME");
    expect(() => hostAcpLaunch({ ...base, scratch: "/outside" })).toThrow();
  });

  test("creates only the per-session approved app MCP and rejects unknown permissions", () => {
    const r = hostAcpNewSession("/tmp/project", "/usr/local/bin/agentes-runner", "run-12345678");
    expect(r).toEqual({
      cwd: "/tmp/project",
      mcpServers: [
        {
          name: "agenteschat_agentes",
          command: "/usr/local/bin/agentes-runner",
          args: ["mcp", "--run", "run-12345678"],
          env: [],
        },
      ],
    });
    expect(hostAcpPermissionReply(3)).toEqual({ jsonrpc: "2.0", id: 3, result: { outcome: { outcome: "cancelled" } } });
    expect(() => hostAcpNewSession("relative", "/usr/local/bin/agentes-runner", "run-12345678")).toThrow();
    expect(() => hostAcpNewSession("/tmp/project", "/usr/local/bin/agentes-runner", "bad;touch")).toThrow();
  });

  test("creates a session and confirms the exact advertised model before prompting", async () => {
    const calls: Array<{ method: string; params: any }> = [];
    const options = [
      { id: "model", category: "model", currentValue: "other", options: [{ value: "gemini-4-argon-high" }] },
    ];
    const peer = {
      async request(method: string, params: unknown) {
        calls.push({ method, params });
        if (method === "initialize") return { protocolVersion: 1 };
        if (method === "session/new") return { sessionId: "s1", configOptions: options };
        if (method === "session/set_config_option")
          return { configOptions: [{ ...options[0], currentValue: "gemini-4-argon-high" }] };
        if (method === "session/prompt") return { stopReason: "end_turn" };
        throw new Error("unexpected method");
      },
    };
    const r = await runHostAcpSession(peer, {
      cwd: "/tmp/project",
      command: "/usr/local/bin/agentes-runner",
      runId: "run-12345678",
      model: "gemini-4-argon-high",
      prompt: "hello",
    });
    expect(r.stopReason).toBe("end_turn");
    expect(calls.map((x) => x.method)).toEqual([
      "initialize",
      "session/new",
      "session/set_config_option",
      "session/prompt",
    ]);
    expect(calls[1]!.params.mcpServers).toHaveLength(1);
    expect(calls[3]!.params.prompt).toEqual([{ type: "text", text: "hello" }]);
  });

  test("never prompts or silently substitutes an unadvertised model", async () => {
    const calls: string[] = [];
    const peer = {
      async request(method: string) {
        calls.push(method);
        return method === "initialize" ? { protocolVersion: 1 } : { sessionId: "s1", configOptions: [] };
      },
    };
    await expect(
      runHostAcpSession(peer, {
        cwd: "/tmp/project",
        command: "/usr/local/bin/agentes-runner",
        runId: "run-12345678",
        model: "gemini-4-argon-high",
        prompt: "hello",
      }),
    ).rejects.toThrow();
    expect(calls).toEqual(["initialize", "session/new"]);
  });

  test("protocol peer resolves responses, cancels permission, and rejects unexpected requests", async () => {
    const sent: any[] = [];
    const peer = new HostAcpPeer((s: string) => sent.push(JSON.parse(s)));
    const pending = peer.request("initialize", { protocolVersion: 1 });
    expect(sent[0]).toMatchObject({ jsonrpc: "2.0", id: 1, method: "initialize" });
    peer.feed('{"jsonrpc":"2.0","id":99,"method":"session/request_permission","params":{}}\n');
    peer.feed('{"jsonrpc":"2.0","id":98,"method":"fs/read_text_file","params":{}}\n');
    expect(sent[1]).toEqual(hostAcpPermissionReply(99));
    expect(sent[2]).toMatchObject({ id: 98, error: { code: -32601 } });
    peer.feed('{"jsonrpc":"2.0","id":1,');
    peer.feed('"result":{"protocolVersion":1}}\n');
    expect(await pending).toEqual({ protocolVersion: 1 });
    peer.close();
  });

  test("peer closes pending work on malformed protocol and hides provider error text", async () => {
    const peer = new HostAcpPeer(() => {});
    const p = peer.request("initialize", {});
    peer.feed("{bad json}\n");
    await expect(p).rejects.toThrow("ACP protocol failure");
    await expect(peer.request("x", {})).rejects.toThrow();
    const peer2 = new HostAcpPeer(() => {});
    const p2 = peer2.request("initialize", {});
    peer2.feed('{"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"private"}}\n');
    await expect(p2).rejects.toThrow("ACP request failed");
    peer2.close();
  });

  test("peer stops on an unexpected tool notification instead of concealing it", async () => {
    const sent: any[] = [];
    const peer = new HostAcpPeer((s) => sent.push(JSON.parse(s)));
    const p = peer.request("session/prompt", {});
    peer.feed(
      '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"tool_call"}}}\n',
    );
    await expect(p).rejects.toThrow("ACP unexpected tool");
    expect(sent[1]).toEqual({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "s1" } });
  });
  test("uses an explicitly advertised legacy model and treats empty setter result as acknowledgement", async () => {
    const calls: string[] = [];
    const peer = {
      async request(method: string) {
        calls.push(method);
        if (method === "initialize") return { protocolVersion: 1 };
        if (method === "session/new")
          return {
            sessionId: "s1",
            models: { availableModels: [{ modelId: "gemini-4-argon-high" }], currentModelId: "other" },
          };
        if (method === "session/set_model") return {};
        if (method === "session/prompt") return { stopReason: "end_turn" };
        throw new Error("unexpected");
      },
    };
    const result = await runHostAcpSession(peer, {
      cwd: "/tmp/project",
      command: "/usr/local/bin/agentes-runner",
      runId: "run-12345678",
      model: "gemini-4-argon-high",
      prompt: "hello",
    });
    expect(result.modelConfirmation).toBe("ack_only");
    expect(calls).toEqual(["initialize", "session/new", "session/set_model", "session/prompt"]);
  });

  test("delivers only bounded same-session text updates to a runner callback", async () => {
    const updates: string[] = [];
    const peer = new HostAcpPeer(() => {}, 1000, { sessionId: "s1", onText: (text) => updates.push(text) });
    peer.feed(
      '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hello"}}}}\n',
    );
    expect(updates).toEqual(["hello"]);
    peer.feed(
      '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s2","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"leak"}}}}\n',
    );
    expect(updates).toEqual(["hello"]);
    peer.close();
  });
});
