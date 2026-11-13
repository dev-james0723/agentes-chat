import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { connectHostMcp } from "../../runner/host-acp-mcp";

test("connects a local MCP subprocess with only the scoped run environment", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "host-mcp-test-"));
  const fake = path.join(dir, "mcp-fake");
  const marker = path.join(dir, "env.json");
  writeFileSync(
    fake,
    `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({token:process.env.AGENTES_MCP_TOKEN==='test-token',profile:process.env.AGENTES_MCP_PROFILE,complete:process.env.AGENTES_MCP_REQUIRE_COMPLETE==='1',secret:!!process.env.UNRELATED_SECRET,args:process.argv.slice(2)}));const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',s=>{let m=JSON.parse(s),r;if(!('id'in m))return;if(m.method==='initialize')r={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fake',version:'1'}};else if(m.method==='tools/list')r={tools:[{name:'list_issues',inputSchema:{type:'object',properties:{}},_meta:{'agenteschat/runStateEnforced':true}}],_meta:{'agenteschat/runStateVersion':3}};else if(m.method==='tools/call')r={content:[{type:'text',text:'ok'}],_meta:{'agenteschat/runState':'completed','agenteschat/imageOmitted':false,'agenteschat/complete':true}};else return;process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:r})+'\\n')});\n`,
  );
  chmodSync(fake, 0o700);
  process.env.UNRELATED_SECRET = "must-not-pass";
  try {
    const client = await connectHostMcp({
      command: [fake],
      runId: "run-12345678",
      token: "test-token",
      socketPath: path.join(dir, "socket"),
      runnerHome: dir,
      cwd: dir,
      profile: "plan",
      signal: new AbortController().signal,
    });
    try {
      const listed = await client.listTools();
      expect(listed.tools[0]?.name).toBe("list_issues");
      expect(listed._meta?.["agenteschat/runStateVersion"]).toBe(3);
      expect(listed.tools[0]?._meta?.["agenteschat/runStateEnforced"]).toBe(true);
      const called = await client.callTool({ name: "list_issues", arguments: {} });
      expect(called.content).toEqual([{ type: "text", text: "ok" }]);
      expect(called._meta?.["agenteschat/runState"]).toBe("completed");
      expect(called._meta?.["agenteschat/imageOmitted"]).toBe(false);
      expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual({
        token: true,
        profile: "plan",
        complete: true,
        secret: false,
        args: ["mcp", "--run", "run-12345678"],
      });
    } finally {
      await client.close();
    }
  } finally {
    delete process.env.UNRELATED_SECRET;
    rmSync(dir, { recursive: true, force: true });
  }
});
