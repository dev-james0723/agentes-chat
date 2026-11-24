import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { HostAcpHistory } from "@agenteschat/adapters/machine-protocol";
import type { CodexBrainEvent } from "../../runner/brain-codex";
import { hostAcpPermission, runHostAcpTurn, selectAcpModel, stopHostAcpGroup } from "../../runner/host-acp-runtime";

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
    expect(await selectAcpModel(peer, session, "gemini-4-argon-high")).toEqual({
      selectionMode: "ack_only",
      selectedModel: null,
    });
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
    const root = fs.mkdtempSync(path.join(homedir(), "host-acp-dispatch-test-"));
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
    const root = mkdtempSync(path.join(homedir(), "host-acp-runtime-test-"));
    const binary = path.join(root, "fake.py");
    const script = `#!/usr/bin/python3
import json,sys
for line in sys.stdin:
 m=json.loads(line); method=m.get('method'); ident=m.get('id')
 if method=='initialize': result={'protocolVersion':1}
 elif method=='session/new': result={'sessionId':'s1','models':{'currentModelId':'gemini-4-argon-high','availableModels':[{'modelId':'gemini-4-argon-high'}]}}
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
      const selections = events.filter((e) => e.type === "tool_call" && e.name === "host_acp_model_selection");
      expect(selections).toHaveLength(1);
      expect(JSON.parse(selections[0].executed.content)).toMatchObject({
        source: "cli_response",
        requestedModel: "gemini-4-argon-high",
        selectedModel: "gemini-4-argon-high",
        selectionMode: "session_readback",
      });
      expect(events.filter((e) => e.type !== "tool_call")).toEqual([
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
    const root = fs.mkdtempSync(path.join(homedir(), "host-acp-abort-test-"));
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
    const root = fs.mkdtempSync(path.join(homedir(), "host-acp-tool-loop-test-"));
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

describe("native final model and history contract", () => {
  test("native ACP permissions stay denied regardless of tool title", () => {
    expect(hostAcpPermission("session", { toolCall: { title: "agentes read_file" } })).toEqual({
      outcome: "cancelled",
    });
  });

  const pair = () => [
    {
      id: "model",
      category: "model",
      type: "select",
      currentValue: "gemini-4-argon",
      options: [{ value: "gemini-4-argon" }],
    },
    {
      id: "thought_level",
      category: "thought_level",
      type: "select",
      currentValue: "medium",
      options: [{ value: "low" }, { value: "medium" }, { value: "high" }],
    },
  ];

  test("actual CLI shape selects base and High in the same session with final paired readback", async () => {
    const calls: unknown[] = [];
    const selection = await selectAcpModel(
      {
        request: async (method, params) => {
          calls.push({ method, params });
          return {
            configOptions: pair().map((o) => ({ ...o, currentValue: o.id === "model" ? "gemini-4-argon" : "high" })),
          };
        },
      },
      { sessionId: "exact-acp-session", configOptions: pair() },
      "gemini-4-argon-high",
    );
    expect(selection).toEqual({
      selectionMode: "config_pair_readback",
      selectedModel: "gemini-4-argon",
      thoughtLevel: "high",
    });
    expect(calls).toEqual([
      {
        method: "session/set_config_option",
        params: { sessionId: "exact-acp-session", configId: "model", value: "gemini-4-argon" },
      },
      {
        method: "session/set_config_option",
        params: { sessionId: "exact-acp-session", configId: "thought_level", value: "high" },
      },
    ]);
  });

  test("paired readback rejects missing, wrong, duplicate and ACK-only values", async () => {
    const good = pair().map((o) => ({ ...o, currentValue: o.id === "model" ? "gemini-4-argon" : "high" }));
    for (const configOptions of [
      [],
      [good[0]],
      [good[1]],
      good.map((o) => ({ ...o, currentValue: o.id === "model" ? "other-model" : "high" })),
      good.map((o) => ({ ...o, currentValue: o.id === "model" ? "gemini-4-argon" : "medium" })),
      [...good, good[0]],
      [...good, good[1]],
    ]) {
      await expect(
        selectAcpModel(
          { request: async () => ({ configOptions }) },
          { sessionId: "s", configOptions: pair() },
          "gemini-4-argon-high",
        ),
      ).rejects.toThrow("unconfirmed");
    }
    await expect(
      selectAcpModel({ request: async () => ({}) }, { sessionId: "s", configOptions: pair() }, "gemini-4-argon-high"),
    ).rejects.toThrow("unconfirmed");
    for (const configs of [
      [...pair(), pair()[0]],
      [...pair(), pair()[1]],
      pair().map((o) => ({ ...o, options: [...o.options, ...o.options] })),
    ]) {
      const calls: unknown[] = [];
      await expect(
        selectAcpModel(
          {
            request: async (...args) => {
              calls.push(args);
              return {};
            },
          },
          { sessionId: "s", configOptions: configs },
          "gemini-4-argon-high",
        ),
      ).rejects.toThrow();
      expect(calls).toHaveLength(0);
    }
  });

  test("CLI-returned exact model readback differs from legacy setter ACK", async () => {
    const peer = { request: async () => ({ configOptions: [{ id: "model", currentValue: "gemini-4-argon-high" }] }) };
    expect(
      await selectAcpModel(
        peer,
        { sessionId: "s", configOptions: [{ id: "model", options: [{ value: "gemini-4-argon-high" }] }] },
        "gemini-4-argon-high",
      ),
    ).toEqual({ selectionMode: "config_readback", selectedModel: "gemini-4-argon-high" });
    await expect(
      selectAcpModel(
        { request: async () => ({ configOptions: [{ id: "model", currentValue: "gemini-4-argon-low" }] }) },
        { sessionId: "s", configOptions: [{ id: "model", options: [{ value: "gemini-4-argon-high" }] }] },
        "gemini-4-argon-high",
      ),
    ).rejects.toThrow("unconfirmed");
    expect(
      await selectAcpModel(
        peer,
        { models: { currentModelId: "gemini-4-argon-high", availableModels: [{ modelId: "gemini-4-argon-high" }] } },
        "gemini-4-argon-high",
      ),
    ).toEqual({ selectionMode: "session_readback", selectedModel: "gemini-4-argon-high" });
    expect(
      await selectAcpModel(
        { request: async () => ({}) },
        { models: { currentModelId: "other", availableModels: [{ modelId: "gemini-4-argon-high" }] } },
        "gemini-4-argon-high",
      ),
    ).toEqual({ selectionMode: "ack_only", selectedModel: null });
  });

  // Synthetic ACP subprocess: protocol contract only, never evidence of an actual provider run.
  test("fresh native pause/resume turns retain supplied task context and exact CLI selection traces", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    // The Mac grant is under its home; an isolated image's /app source is not.
    const relative = path.relative(homedir(), import.meta.dir);
    const base = relative.startsWith("..") || path.isAbsolute(relative) ? homedir() : import.meta.dir;
    const dir = mkdtempSync(path.join(base, ".argon-runtime-test-"));
    const bin = path.join(dir, "fake-acp"),
      log = path.join(dir, "trace.jsonl");
    writeFileSync(
      bin,
      `#!${process.execPath}
const fs=require('node:fs'),rl=require('node:readline').createInterface({input:process.stdin});
const log=${JSON.stringify(log)}; const sessionId='synthetic-'+process.pid;
const mode=()=>{try{return fs.readFileSync(require('node:path').join(__dirname,'mode'),'utf8')}catch{return 'pair'}};
const configs=()=>[{id:'model',category:'model',type:'select',currentValue:'gemini-4-argon',options:[{value:'gemini-4-argon'}]},{id:'thought_level',category:'thought_level',type:'select',currentValue:'medium',options:[{value:'low'},{value:'medium'},{value:'high'}]}];
rl.on('line',line=>{const m=JSON.parse(line);if(!('id' in m))return;
let result;
if(m.method==='initialize')result={protocolVersion:1};
else if(m.method==='session/new')result=mode()==='ack-only'?{sessionId,models:{currentModelId:'other',availableModels:[{modelId:'gemini-4-argon-high'}]}}:{sessionId,configOptions:configs()};
else if(m.method==='session/set_config_option'){
let c=configs().map(o=>({...o,currentValue:o.id==='model'?(mode()==='wrong-base'?'other':'gemini-4-argon'):(mode()==='wrong-high'?'medium':'high')}));
if(mode()==='missing')c=c.slice(0,1);if(mode()==='duplicate')c.push(c[1]);result=mode()==='pair-ack'?{}:{configOptions:c};
}
else if(m.method==='session/prompt'){
const text=m.params.prompt[0].text;fs.appendFileSync(log,JSON.stringify({sessionId,text,tokenInEnv:!!process.env.AGENTES_MCP_TOKEN})+'\\n');
const response=text.includes('ANSWERED_MARKER')?{type:'final',text:'Original task and ANSWERED_MARKER retained'}:{type:'tool_call',name:'ask_user',arguments:{}};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify(response)}}}})+'\\n');result={stopReason:'end_turn'};
}else result={};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`,
    );
    chmodSync(bin, 0o700);
    const events: CodexBrainEvent[] = [];
    let connections = 0;
    let unknownResult = false;
    try {
      Object.defineProperty(process, "platform", { ...descriptor, value: "darwin" });
      const run = (runId: string, prompt: string, hostAcpHistory?: HostAcpHistory) =>
        runHostAcpTurn({
          cwd: dir,
          runnerHome: dir,
          runId,
          hostAcpHistory,
          sessionId: "native-session-1234",
          model: "gemini-4-argon-high",
          prompt,
          profile: "work",
          bin,
          mcp: { token: "synthetic-scoped-token", socketPath: path.join(dir, "socket"), command: [process.execPath] },
          signal: new AbortController().signal,
          isAuthorized: () => true,
          emit: (e) => events.push(e),
          connectMcp: async () => {
            connections++;
            return {
              listTools: async () => ({
                tools: [
                  {
                    name: "ask_user",
                    inputSchema: { type: "object", properties: {} },
                    _meta: { "agenteschat/runStateEnforced": true },
                  },
                ],
                _meta: { "agenteschat/runStateVersion": 3 },
              }),
              callTool: async () =>
                unknownResult
                  ? {
                      isError: true,
                      content: [],
                      _meta: {
                        "agenteschat/errorCode": "bridge.cut_off",
                        "agenteschat/callId": "effect-before-cutoff",
                      },
                    }
                  : {
                      content: [],
                      _meta: { "agenteschat/runState": "suspended", "agenteschat/imageOmitted": false },
                    },
              close: async () => {},
            } as any;
          },
        });
      await run("original-run-1234", "Original task context");
      expect(events.at(-1)).toMatchObject({ type: "done", text: "" });
      await run("resumed-run-12345", "Original task context; ANSWERED_MARKER", {
        runId: "resumed-run-12345",
        observations: [
          {
            seq: 1,
            callId: "completed-effect-1",
            name: "create_issue",
            input: {},
            content: "persisted-native-receipt",
            isError: false,
            state: "completed",
            partial: true,
          },
        ],
      });
      expect(events.at(-1)).toMatchObject({ type: "done", text: "Original task and ANSWERED_MARKER retained" });
      const traces = events
        .filter((e) => e.type === "tool_call" && e.name === "host_acp_model_selection")
        .map((e: any) => JSON.parse(e.executed.content));
      expect(traces).toHaveLength(2);
      expect(traces.map((t) => t.runId)).toEqual(["original-run-1234", "resumed-run-12345"]);
      expect(
        traces.every(
          (t) =>
            t.requestedModel === "gemini-4-argon-high" &&
            t.selectedModel === "gemini-4-argon" &&
            t.thoughtLevel === "high" &&
            t.selectionMode === "config_pair_readback" &&
            t.source === "cli_response" &&
            t.nativeSessionId === "native-session-1234",
        ),
      ).toBe(true);
      expect(traces[0].acpSessionId).not.toBe(traces[1].acpSessionId);
      const prompts = readFileSync(log, "utf8");
      expect(prompts).toContain("persisted-native-receipt");
      expect(prompts).not.toContain('"tokenInEnv":true');
      expect(events.find((e) => e.type === "error")).toBeUndefined();
      unknownResult = true;
      await run("cutoff-native-run", "recorded side effect followed by cutoff");
      expect(events.at(-1)).toMatchObject({
        type: "error",
        code: "antigravity_delivery_unknown",
        message: expect.stringContaining("bridge.cut_off; effect unknown; receipt effect-before-cutoff"),
      });
      const beforeFailures = connections;
      for (const mode of ["ack-only", "pair-ack", "missing", "wrong-base", "wrong-high", "duplicate"]) {
        writeFileSync(path.join(dir, "mode"), mode);
        await run("unverified-run-123", "must never reach first prompt");
        expect(events.at(-1)).toMatchObject({ type: "error" });
        expect(connections).toBe(beforeFailures);
      }
      expect(readFileSync(log, "utf8")).not.toContain("must never reach first prompt");
    } finally {
      Object.defineProperty(process, "platform", descriptor);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 35_000);
});
