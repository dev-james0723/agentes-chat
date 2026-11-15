/** Explicit local, no-tools authentication probe. It never logs in or reads credentials. */
import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { HostAcpPeer } from "./host-acp-candidate";
import { stopHostAcpGroup } from "./host-acp-runtime";

export async function verifyLocalHostAcp(runnerHome: string, binary = "agy"): Promise<boolean> {
  const home = realpathSync(os.homedir());
  if (!process.env.HOME || realpathSync(process.env.HOME) !== home) throw new Error("Native user HOME is required");
  const root = realpathSync(runnerHome);
  const rel = path.relative(home, root);
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
    throw new Error("Runner home must be inside native HOME");
  const scratch = mkdtempSync(path.join(root, "host-acp-verify-"));
  const work = path.join(scratch, "work");
  const gemini = path.join(scratch, "gemini");
  const agent = path.join(gemini, "config", "agents", "agenteschat-acp-probe");
  const app = path.join(gemini, "antigravity-cli");
  for (const dir of [work, agent, app]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(agent, "agent.md"),
    "---\nname: agenteschat-acp-probe\ndescription: Isolated connectivity probe.\ntools: []\nmainAgent: true\nsubagent: false\ncommandExecutionPolicy: off\n---\nReply READY. Never call a tool.\n",
    { mode: 0o600 },
  );
  writeFileSync(
    path.join(app, "settings.json"),
    JSON.stringify({
      toolPermission: "strict",
      enableTerminalSandbox: true,
      allowNonWorkspaceAccess: false,
      useG1Credits: false,
      permissions: { allow: [], deny: [] },
    }),
    { mode: 0o600 },
  );
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["HOME", "PATH", "USER", "LOGNAME", "TMPDIR", "LANG"])
    if (process.env[key]) env[key] = process.env[key];
  const child = spawn(
    binary,
    [
      "acp",
      "--sandbox",
      "--process-per-session",
      "--gemini-dir",
      path.relative(home, gemini),
      "--app-data-dir",
      "antigravity-cli",
      "--include-default-customizations=false",
      "--agent",
      "agenteschat-acp-probe",
    ],
    { cwd: work, env, stdio: ["pipe", "pipe", "ignore"], detached: true },
  );
  const peer = new HostAcpPeer((line) => {
    if (!child.stdin?.write(line)) {
      /* Node buffers until drained. */
    }
  }, 90_000);
  child.stdout?.on("data", (chunk: Buffer) => peer.feed(chunk.toString("utf8")));
  const events = child as unknown as EventEmitter;
  events.on("error", () => peer.close("ACP process failed"));
  events.on("close", () => peer.close("ACP process closed"));
  let answer = "";
  try {
    const init = await peer.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "agenteschat-auth-probe", version: "0.1" },
    });
    if (init?.protocolVersion !== 1) return false;
    const session = await peer.request("session/new", { cwd: work, mcpServers: [] });
    if (typeof session?.sessionId !== "string" || !session.sessionId) return false;
    peer.setOutput(session.sessionId, (text) => {
      answer = (answer + text).slice(0, 200);
    });
    const options = Array.isArray(session?.configOptions)
      ? session.configOptions.filter((o: any) => o?.id === "model" || o?.category === "model")
      : [];
    const option = options.length === 1 ? options[0] : null;
    const vals = Array.isArray(option?.options)
      ? option.options.flatMap((o: any) => (Array.isArray(o?.options) ? o.options : [o]))
      : [];
    const model = "gemini-4-argon-high";
    if (vals.some((o: any) => o?.value === model)) {
      const picked = await peer.request("session/set_config_option", {
        sessionId: session.sessionId,
        configId: option.id,
        value: model,
      });
      if (
        !Array.isArray(picked?.configOptions) ||
        !picked.configOptions.some((o: any) => o?.id === option.id && o?.currentValue === model)
      )
        return false;
    } else {
      const legacy = session?.models;
      if (!Array.isArray(legacy?.availableModels) || !legacy.availableModels.some((o: any) => o?.modelId === model))
        return false;
      if (legacy.currentModelId !== model) {
        const ack = await peer.request("session/set_model", { sessionId: session.sessionId, modelId: model });
        if (!ack || typeof ack !== "object" || Array.isArray(ack)) return false;
      }
    }
    const done = await peer.request("session/prompt", {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "Reply exactly READY. Do not use any tools." }],
    });
    return done?.stopReason === "end_turn" && answer.trim() === "READY";
  } finally {
    peer.close();
    const gone = await stopHostAcpGroup(child);
    if (gone) {
      try {
        rmSync(scratch, { recursive: true, force: true });
      } catch {}
    }
  }
}
