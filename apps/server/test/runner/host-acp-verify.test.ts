import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { verifyLocalHostAcp } from "../../runner/host-acp-verify";

test("verifies a no-tools session using the selected advertised model, with no real CLI or account", async () => {
  const home = mkdtempSync(path.join(path.resolve(import.meta.dir, "../../../../.."), "host-acp-verify-test-"));
  const root = path.join(home, "runner");
  mkdirSync(root, { mode: 0o700 });
  const fake = path.join(home, "fake-acp");
  writeFileSync(
    fake,
    `#!${process.execPath}\nconst rl = require('node:readline').createInterface({input:process.stdin});\nrl.on('line', s => { const m=JSON.parse(s); let result; if(m.method==='initialize') result={protocolVersion:1}; else if(m.method==='session/new') result={sessionId:'s1', models:{availableModels:[{modelId:'gemini-4-argon-high'}]}}; else if(m.method==='session/set_model') result={}; else if(m.method==='session/prompt'){ process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'s1',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'READY'}}}})+'\\n'); result={stopReason:'end_turn'}; } else return; process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n'); });\n`,
  );
  chmodSync(fake, 0o700);
  try {
    expect(await verifyLocalHostAcp(root, fake)).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
