import { describe, expect, test } from "bun:test";
import type { CodexBrainEvent } from "../../runner/brain-codex";
import { hostAcpPermission, selectAcpModel, stopHostAcpGroup } from "../../runner/host-acp-runtime";

describe("ACP runtime boundaries", () => {
  const request = {
    sessionId: "s1",
    toolCall: { title: "Run mcp_agenteschat_agentes_list_tasks", kind: "other", rawInput: {} },
    options: [
      { optionId: "yes", kind: "allow_once" },
      { optionId: "no", kind: "reject_once" },
    ],
  };
  test("cancels even a matching title without authenticated tool identity", () => {
    expect(hostAcpPermission("s1", request)).toEqual({ outcome: "cancelled" });
    expect(hostAcpPermission("s2", request)).toEqual({ outcome: "cancelled" });
    expect(hostAcpPermission("s1", { ...request, toolCall: { ...request.toolCall, title: "Run shell" } })).toEqual({
      outcome: "cancelled",
    });
    expect(
      hostAcpPermission("s1", {
        ...request,
        toolCall: { ...request.toolCall, title: "Run mcp_agenteschat_agentes_../shell" },
      }),
    ).toEqual({ outcome: "cancelled" });
    expect(hostAcpPermission("s1", { ...request, options: [{ optionId: "yes", kind: "allow_always" }] })).toEqual({
      outcome: "cancelled",
    });
  });
  test("legacy model must be advertised and ACK empty setter", async () => {
    const seen: string[] = [];
    const peer = {
      request: async (method: string) => {
        seen.push(method);
        return {};
      },
    };
    const session = {
      sessionId: "s1",
      models: { currentModelId: "other", availableModels: [{ modelId: "gemini-4-argon-high" }] },
    };
    expect(await selectAcpModel(peer, session, "gemini-4-argon-high")).toBe("ack_only");
    expect(seen).toEqual(["session/set_model"]);
    await expect(selectAcpModel(peer, session, "other-model")).rejects.toThrow();
  });
  test("escalates only its own process group and cleans up only when confirmed gone", async () => {
    const signals: Array<string | number> = [];
    let probes = 0;
    const fake = { pid: 4242, exitCode: null, signalCode: null, once: () => fake, kill: () => true } as any;
    const signal = (id: number, sig: NodeJS.Signals | 0) => {
      expect(id).toBe(-4242);
      signals.push(sig);
      if (sig === 0 && ++probes === 3) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      return true;
    };
    expect(await stopHostAcpGroup(fake, signal, async () => {})).toBe(true);
    expect(signals).toEqual([0, "SIGTERM", 0, "SIGKILL", 0]);
    expect(
      await stopHostAcpGroup(
        fake,
        () => {
          throw Object.assign(new Error("denied"), { code: "EPERM" });
        },
        async () => {},
      ),
    ).toBe(false);
  });
});

describe("ACP isolated process smoke", () => {
  test("the actual runner dispatches an opted-in host to ACP, without accessing a managed account", async () => {
    if (process.platform !== "darwin") return;
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { handleAntigravityBrainTurn } = await import("../../runner/brain-antigravity");
    const root = fs.mkdtempSync(path.join(import.meta.dir, "host-acp-dispatch-test-"));
    const binary = path.join(root, "fake.py");
    const mcpBinary = path.join(root, "mcp-fake.py");
    fs.writeFileSync(
      mcpBinary,
      `#!/usr/bin/python3
import json,sys
for line in sys.stdin:
 m=json.loads(line); method=m.get('method'); ident=m.get('id')
 if ident is None: continue
 if method=='initialize': result={'protocolVersion':'2024-11-05','capabilities':{'tools':{}},'serverInfo':{'name':'fake','version':'1'}}
 elif method=='tools/list': result={'tools':[],'_meta':{'agenteschat/runStateVersion':3}}
 else: continue
 print(json.dumps({'jsonrpc':'2.0','id':ident,'result':result}),flush=True)
`,
      { mode: 0o700 },
    );
    fs.writeFileSync(
      binary,
      `#!/usr/bin/python3
import json,sys
for line in sys.stdin:
 m=json.loads(line); method=m.get('method'); ident=m.get('id')
 if method=='initialize': result={'protocolVersion':1}
 elif method=='session/new': result={'sessionId':'s1','models':{'currentModelId':'gemini-4-argon-high','availableModels':[{'modelId':'gemini-4-argon-high'}]}}
 elif method=='session/prompt':
  text=json.dumps({'type':'final','text':'HOST_READY'})
  print(json.dumps({'jsonrpc':'2.0','method':'session/update','params':{'sessionId':'s1','update':{'sessionUpdate':'agent_message_chunk','content':{'type':'text','text':text}}}}),flush=True)
  result={'stopReason':'end_turn'}
 else: continue
 print(json.dumps({'jsonrpc':'2.0','id':ident,'result':result}),flush=True)
`,
      { mode: 0o700 },
    );
    const events: CodexBrainEvent[] = [];
    try {
      await handleAntigravityBrainTurn(
        {
          folder: root,
          exec: true,
          runnerHome: root,
          bin: binary,
          hostAccountStatus: () => ({ id: "0193eeee-0000-7000-8000-000000000002", loggedIn: true }),
          accounts: {
            accountDir: () => {
              throw new Error("Managed account must not be used");
            },
          },
          mcp: { socketPath: "/tmp/mcp-test.sock", command: [mcpBinary] },
        },
        {
          kind: "antigravity",
          runId: "run-12345678",
          session: { id: "session-12345678", resume: false },
          model: "gemini-4-argon-high",
          system: "test",
          prompt: "reply",
          mcp: { token: "fixture" },
          account: "0193eeee-0000-7000-8000-000000000002",
          agent: { id: "0193aaaa-0000-7000-8000-000000000001", handle: "dev", name: "Dev" },
        },
        { signal: new AbortController().signal, emit: (event) => events.push(event) },
      );
      expect(events).toContainEqual({ type: "done", text: "HOST_READY", session: { id: "session-12345678" } });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);
  test("runs a fake ACP peer, cancels permission and redacts across streamed chunks", async () => {
    if (process.platform !== "darwin") return;
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const path = await import("node:path");
    const { runHostAcpTurn } = await import("../../runner/host-acp-runtime");
    const root = mkdtempSync(path.join(import.meta.dir, "host-acp-runtime-test-"));
    const binary = path.join(root, "fake.py");
    const script = `#!/usr/bin/python3
import json,sys
for line in sys.stdin:
 m=json.loads(line); method=m.get('method'); ident=m.get('id')
 if method=='initialize': result={'protocolVersion':1}
 elif method=='session/new': result={'sessionId':'s1','models':{'currentModelId':'x','availableModels':[{'modelId':'gemini-4-argon-high'}]}}
 elif method=='session/set_model': result={}
 elif method=='session/prompt':
  print(json.dumps({'jsonrpc':'2.0','id':90,'method':'session/request_permission','params':{'sessionId':'s1','toolCall':{'title':'Run mcp_agenteschat_agentes_test','kind':'other','rawInput':{}},'options':[{'optionId':'yes','kind':'allow_once'}]}}),flush=True)
  permission=json.loads(sys.stdin.readline())
  if permission.get('result',{}).get('outcome',{}).get('outcome')!='cancelled': sys.exit(8)
  for text in ['{"type":"final","text":"before secret-', 'run-token after"}']:
   print(json.dumps({'jsonrpc':'2.0','method':'session/update','params':{'sessionId':'s1','update':{'sessionUpdate':'agent_message_chunk','content':{'type':'text','text':text}}}}),flush=True)
  result={'stopReason':'end_turn'}
 else: continue
 print(json.dumps({'jsonrpc':'2.0','id':ident,'result':result}),flush=True)
`;
    writeFileSync(binary, script, { mode: 0o700 });
    const events: any[] = [];
    try {
      await runHostAcpTurn({
        cwd: root,
        runnerHome: root,
        runId: "run-12345678",
        sessionId: "session-12345678",
        model: "gemini-4-argon-high",
        prompt: "test",
        profile: "plan",
        connectMcp: async () =>
          ({
            listTools: async () => ({ tools: [], _meta: { "agenteschat/runStateVersion": 3 } }),
            callTool: async () => {
              throw new Error("unexpected");
            },
            close: async () => {},
          }) as any,
        bin: binary,
        mcp: { token: "secret-run-token", socketPath: "/tmp/mcp-test.sock", command: ["/bin/echo"] },
        signal: new AbortController().signal,
        isAuthorized: () => true,
        emit: (e) => events.push(e),
      });
      expect(events).toEqual([
        { type: "text_delta", text: "before [redacted] after" },
        { type: "done", text: "before [redacted] after", session: { id: "session-12345678" } },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);
  test("an abort during spawn prevents the session prompt", async () => {
    if (process.platform !== "darwin") return;
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { spawn } = await import("node:child_process");
    const { runHostAcpTurn } = await import("../../runner/host-acp-runtime");
    const root = fs.mkdtempSync(path.join(import.meta.dir, "host-acp-abort-test-"));
    const binary = path.join(root, "fake.py");
    fs.writeFileSync(binary, "#!/usr/bin/python3\nimport time\ntime.sleep(30)\n", { mode: 0o700 });
    const controller = new AbortController();
    const events: any[] = [];
    try {
      const start: any = (file: string, args: readonly string[], options: any) => {
        const child = spawn(file, args, options);
        controller.abort();
        return child;
      };
      await runHostAcpTurn({
        cwd: root,
        runnerHome: root,
        runId: "run-12345678",
        sessionId: "session-12345678",
        model: "gemini-4-argon-high",
        prompt: "test",
        profile: "plan",
        bin: binary,
        mcp: { token: "secret-run-token", socketPath: "/tmp/mcp-test.sock", command: ["/bin/echo"] },
        signal: controller.signal,
        isAuthorized: () => true,
        spawn: start,
        emit: (e) => events.push(e),
      });
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("error");
      expect(events[0].code).toBe("antigravity_failed");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);
  test("executes one listed MCP tool and returns its answer without exposing token to ACP", async () => {
    if (process.platform !== "darwin") return;
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { runHostAcpTurn } = await import("../../runner/host-acp-runtime");
    const root = fs.mkdtempSync(path.join(import.meta.dir, "host-acp-tool-loop-test-"));
    const binary = path.join(root, "fake.py"),
      trace = path.join(root, "trace.json");
    const script = `#!/usr/bin/python3
import json,sys,os
count=0
for line in sys.stdin:
 m=json.loads(line); method=m.get('method'); ident=m.get('id')
 if method=='initialize': result={'protocolVersion':1}
 elif method=='session/new':
  open(${JSON.stringify(trace)},'w').write(json.dumps({'mcp':m['params']['mcpServers'],'hasToken':bool(os.getenv('AGENTES_MCP_TOKEN'))}))
  result={'sessionId':'s1','models':{'currentModelId':'gemini-4-argon-high','availableModels':[{'modelId':'gemini-4-argon-high'}]}}
 elif method=='session/prompt':
  count+=1
  text=json.dumps({'type':'tool_call','name':'list_issues','arguments':{}} if count==1 else {'type':'final','text':'Found 3 issues.'})
  print(json.dumps({'jsonrpc':'2.0','method':'session/update','params':{'sessionId':'s1','update':{'sessionUpdate':'agent_message_chunk','content':{'type':'text','text':text}}}}),flush=True)
  result={'stopReason':'end_turn'}
 else: continue
 print(json.dumps({'jsonrpc':'2.0','id':ident,'result':result}),flush=True)
`;
    fs.writeFileSync(binary, script, { mode: 0o700 });
    const calls: any[] = [],
      events: any[] = [];
    const tool = {
      name: "list_issues",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      _meta: { "agenteschat/runStateEnforced": true },
    };
    try {
      await runHostAcpTurn({
        cwd: root,
        runnerHome: root,
        runId: "run-12345678",
        sessionId: "session-12345678",
        model: "gemini-4-argon-high",
        prompt: "List issues",
        profile: "work",
        bin: binary,
        mcp: { token: "secret-run-token", socketPath: "/tmp/mcp-test.sock", command: ["/bin/echo"] },
        signal: new AbortController().signal,
        isAuthorized: () => true,
        emit: (e) => events.push(e),
        connectMcp: async () =>
          ({
            listTools: async () => ({ tools: [tool], _meta: { "agenteschat/runStateVersion": 3 } }),
            callTool: async (call: unknown) => {
              calls.push(call);
              return {
                content: [{ type: "text", text: "3 issues" }],
                _meta: {
                  "agenteschat/runState": "completed",
                  "agenteschat/imageOmitted": false,
                  "agenteschat/complete": true,
                },
              };
            },
            close: async () => {},
          }) as any,
      });
      expect(calls).toEqual([{ name: "list_issues", arguments: {} }]);
      expect(events.at(-1)).toMatchObject({ type: "done", text: "Found 3 issues." });
      expect(JSON.parse(fs.readFileSync(trace, "utf8"))).toEqual({ mcp: [], hasToken: false });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);
});
