import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseBrainEvent } from "@agenteschat/adapters/machine-protocol";
import { cliErrorWords } from "../../../../packages/engine/src/tool-detail";
import { runHostAcpTurn } from "../../runner/host-acp-runtime";

const root = mkdtempSync(path.join(import.meta.dir, ".acp-diagnostic-fixtures-"));
/** The host ACP turn runs only on a Mac (`runHostAcpTurn` refuses any other platform): its turns are tested there. */
const onMac = test.skipIf(process.platform !== "darwin");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const load = JSON.stringify({
    type: "tool_call",
    name: "load_skill",
    arguments: { name: "synthetic-workflow" },
  }),
  write = JSON.stringify({
    type: "tool_call",
    name: "write_file",
    arguments: { path: "owned-synthetic.txt", content: "synthetic" },
  }),
  final = JSON.stringify({ type: "final", text: "synthetic safe stop" });
const meta = {
  "agenteschat/runState": "completed",
  "agenteschat/imageOmitted": false,
  "agenteschat/complete": true,
  "agenteschat/callId": "synthetic-receipt-1",
};
type Mode = {
  actions: string[];
  requestError?: boolean;
  stopReason?: string;
  schemaChange?: boolean;
  deliveryUnknown?: boolean;
  revoke?: boolean;
  firstWrite?: boolean;
  completedRefusal?: boolean;
  connectFailure?: string;
};
async function fixture(mode: Mode) {
  expect(process.platform).toBe("darwin");
  const dir = mkdtempSync(path.join(root, "case-")),
    bin = path.join(dir, "fake-acp");
  writeFileSync(path.join(dir, "mode.json"), JSON.stringify(mode));
  writeFileSync(
    bin,
    `#!${process.execPath}\nconst fs=require('node:fs'),p=require('node:path'),rl=require('node:readline').createInterface({input:process.stdin});const mode=JSON.parse(fs.readFileSync(p.join(__dirname,'mode.json'),'utf8'));let turn=0;const sid='synthetic-acp-session';const configs=()=>[{id:'model',category:'model',type:'select',currentValue:'gemini-4-argon',options:[{value:'gemini-4-argon'}]},{id:'thought_level',category:'thought_level',type:'select',currentValue:'high',options:[{value:'high'}]}];rl.on('line',line=>{const m=JSON.parse(line);if(!('id'in m))return;let result;if(m.method==='initialize')result={protocolVersion:1};else if(m.method==='session/new')result={sessionId:sid,configOptions:configs()};else if(m.method==='session/set_config_option')result={configOptions:configs()};else if(m.method==='session/prompt'){const n=turn++;if(n===1&&mode.requestError){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32603,message:'SYNTHETIC_RAW_VENDOR_PRIVATE_MARKER'}})+'\\n');return;}const text=mode.actions[n]??${JSON.stringify(final)};process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:sid,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}}})+'\\n');result={stopReason:n===1?(mode.stopReason??'end_turn'):'end_turn'};}else result={};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`,
  );
  chmodSync(bin, 0o700);
  const events: any[] = [],
    calls: any[] = [];
  let lists = 0,
    closed = 0,
    authorized = true;
  try {
    await runHostAcpTurn({
      cwd: dir,
      runnerHome: dir,
      runId: "synthetic-run-1234",
      sessionId: "synthetic-native-1234",
      model: "gemini-4-argon-high",
      prompt: "Synthetic isolated fixture only",
      profile: "work",
      bin,
      mcp: {
        token: "synthetic-not-a-credential",
        socketPath: path.join(dir, "socket"),
        command: [process.execPath],
      },
      signal: new AbortController().signal,
      isAuthorized: () => authorized,
      emit: (e) => events.push(e),
      connectMcp: async () => {
        if (mode.connectFailure) throw new Error(mode.connectFailure);
        return {
          listTools: async () => {
            lists++;
            const schema = (name: string) => ({
              name,
              inputSchema: {
                type: "object",
                properties:
                  name === "load_skill"
                    ? { name: { type: "string" } }
                    : { path: { type: "string" }, content: { type: "string" } },
                additionalProperties: false,
                ...(mode.schemaChange && lists >= 3 ? { required: ["nonexistent"] } : {}),
              },
              _meta: { "agenteschat/runStateEnforced": true },
            });
            return {
              tools: [schema("load_skill"), schema("write_file")],
              _meta: { "agenteschat/runStateVersion": 3 },
            };
          },
          callTool: async (input: any) => {
            calls.push(input);
            if (mode.deliveryUnknown && calls.length === 2) throw Error("SYNTHETIC_RAW_VENDOR_PRIVATE_MARKER");
            if (mode.revoke) authorized = false;
            return {
              content: [
                {
                  type: "text",
                  text: mode.completedRefusal ? "Synthetic not assigned; no execution" : "synthetic completed result",
                },
              ],
              ...(mode.completedRefusal ? { isError: true } : {}),
              _meta: {
                ...meta,
                ...(mode.completedRefusal ? { "agenteschat/errorCode": "skill.not_assigned" } : {}),
              },
            };
          },
          close: async () => {
            closed++;
          },
        } as any;
      },
    });
    expect(closed).toBe(mode.connectFailure ? 0 : 1);
    expect(readdirSync(dir).filter((x) => x.startsWith("host-acp-"))).toEqual([]);
    return { events, calls, lists };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const collapsedCases: [string, Mode][] = [
  ["malformed_json_after_confirmed_load", { actions: [load, "SYNTHETIC_RAW_VENDOR_PRIVATE_MARKER not JSON"] }],
  ["invalid_shape_after_confirmed_load", { actions: [load, "{}"] }],
  [
    "invalid_arguments_after_confirmed_load",
    {
      actions: [
        load,
        JSON.stringify({
          type: "tool_call",
          name: "load_skill",
          arguments: { name: 1 },
        }),
      ],
    },
  ],
  [
    "unoffered_tool_after_confirmed_load",
    {
      actions: [
        load,
        JSON.stringify({
          type: "tool_call",
          name: "not_offered",
          arguments: {},
        }),
      ],
    },
  ],
  ["schema_changed_after_confirmed_load", { actions: [load, load], schemaChange: true }],
  ["prompt_response_error_after_confirmed_load", { actions: [load, final], requestError: true }],
  ["non_end_turn_after_confirmed_load", { actions: [load, final], stopReason: "max_tokens" }],
  ["authorization_ended_after_confirmed_load", { actions: [load, final], revoke: true }],
];
const expectedDiagnostics = {
  malformed_json_after_confirmed_load: ["intent", "invalid_json", "current_attempt_not_dispatched"],
  invalid_shape_after_confirmed_load: ["intent", "invalid_shape", "current_attempt_not_dispatched"],
  invalid_arguments_after_confirmed_load: ["intent", "invalid_arguments", "current_attempt_not_dispatched"],
  unoffered_tool_after_confirmed_load: ["intent", "tool_unoffered", "current_attempt_not_dispatched"],
  schema_changed_after_confirmed_load: ["registry", "schema_changed", "current_attempt_not_dispatched"],
  prompt_response_error_after_confirmed_load: ["transport", "request_failed", "current_attempt_unknown"],
  non_end_turn_after_confirmed_load: ["prompt", "incomplete", "current_attempt_unknown"],
  authorization_ended_after_confirmed_load: ["authorization", "ended", "current_attempt_unknown"],
};
for (const [name, mode] of collapsedCases)
  onMac(name + " returns a closed cause without erasing previous receipt", async () => {
    const r = await fixture(mode);
    expect(r.calls.map((x) => x.name)).toEqual(["load_skill"]);
    const [stage, cause, effect] = expectedDiagnostics[name as keyof typeof expectedDiagnostics];
    expect(r.events.at(-1)).toMatchObject({
      type: "error",
      code: "antigravity_failed",
      retryable: false,
    });
    expect(r.events.at(-1).message).toContain(`ACPdiag/v1 stage=${stage} cause=${cause} effect=${effect}.`);
    expect(r.events.at(-1).message.length).toBeLessThanOrEqual(200);
    expect(JSON.stringify(r.events)).not.toContain("SYNTHETIC_RAW_VENDOR_PRIVATE_MARKER");
    console.log(
      "COLLAPSE_PROOF",
      JSON.stringify({
        fixture: name,
        calls: r.calls.map((x) => x.name),
        error: r.events.at(-1),
      }),
    );
  });

onMac("delivery unknown remains fenced with one attempt and no automatic retry", async () => {
  const r = await fixture({ actions: [load, write], deliveryUnknown: true });
  expect(r.calls.map((x) => x.name)).toEqual(["load_skill", "write_file"]);
  expect(r.events.at(-1)).toMatchObject({
    type: "error",
    code: "antigravity_delivery_unknown",
    retryable: false,
  });
  expect(JSON.stringify(r.events)).not.toContain("SYNTHETIC_RAW_VENDOR_PRIVATE_MARKER");
});

onMac("known completed duplicate effect is refused instead of dispatched twice", async () => {
  const r = await fixture({ actions: [write, write] });
  expect(r.calls.map((x) => x.name)).toEqual(["write_file"]);
  expect(r.events.at(-1)).toMatchObject({
    type: "error",
    code: "antigravity_failed",
    message: expect.stringContaining("bridge.duplicate_intent; effect completed"),
    retryable: false,
  });
});

onMac("controlled unassigned refusal stays completed native error, no bypass or invented grant", async () => {
  const r = await fixture({ actions: [load, final], completedRefusal: true });
  expect(r.calls.map((x) => x.name)).toEqual(["load_skill"]);
  expect(r.events.at(-1)).toMatchObject({
    type: "done",
    text: "synthetic safe stop",
  });
  expect(r.events.some((x) => x.type === "error")).toBe(false);
});

test("bounded fixed enum message survives existing protocol and native public formatter; arbitrary extra field is dropped", () => {
  const message =
    "ACPdiag/v1 stage=intent cause=invalid_json effect=not_dispatched. Turn stopped; inspect native receipts; no replay.";
  const parsed = parseBrainEvent({
    type: "error",
    code: "antigravity_failed",
    message,
    retryable: false,
    diagnostic: { stage: "intent", cause: "invalid_json" },
  });
  expect(parsed).toEqual({
    type: "error",
    code: "antigravity_failed",
    message,
    retryable: false,
  });
  expect(cliErrorWords(message)).toBe(message);
  expect(message.length).toBeLessThan(200);
});

for (const message of [
  "Foreground execution SYNTHETIC_RAW_VENDOR_PRIVATE_MARKER",
  "Exact Argon High SYNTHETIC_RAW_VENDOR_PRIVATE_MARKER",
  "Unexpected SYNTHETIC_RAW_VENDOR_PRIVATE_MARKER",
])
  onMac("untrusted lookalike error never becomes diagnostic text: " + message.split(" ")[0], async () => {
    const r = await fixture({ actions: [], connectFailure: message });
    expect(r.calls).toEqual([]);
    expect(r.events.at(-1)).toMatchObject({
      type: "error",
      code: "antigravity_failed",
      retryable: false,
    });
    expect(r.events.at(-1).message).toContain(
      "ACPdiag/v1 stage=unknown cause=unexpected effect=current_attempt_unknown.",
    );
    expect(JSON.stringify(r.events)).not.toContain("SYNTHETIC_RAW_VENDOR_PRIVATE_MARKER");
  });
