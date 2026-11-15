/** The app's existing run-scoped MCP bridge, kept outside the model's process. */

import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export async function connectHostMcp(input: {
  command: string[];
  runId: string;
  token: string;
  socketPath: string;
  runnerHome: string;
  cwd: string;
  profile: "plan" | "work";
  signal: AbortSignal;
}) {
  const [command, ...prefix] = input.command;
  if (
    !command ||
    !path.isAbsolute(command) ||
    !/^[A-Za-z0-9-]{8,64}$/.test(input.runId) ||
    !input.token ||
    !path.isAbsolute(input.socketPath) ||
    !path.isAbsolute(input.runnerHome) ||
    !path.isAbsolute(input.cwd)
  ) {
    throw new Error("Invalid MCP run context");
  }
  const env: Record<string, string> = {};
  for (const key of ["HOME", "PATH", "USER", "LOGNAME", "TMPDIR", "LANG"])
    if (process.env[key]) env[key] = process.env[key]!;
  env.AGENTES_MCP_TOKEN = input.token;
  env.AGENTES_MCP_SOCKET = input.socketPath;
  env.AGENTES_RUNNER_HOME = input.runnerHome;
  env.AGENTES_MCP_CWD = input.cwd;
  if (input.profile === "plan") env.AGENTES_MCP_PROFILE = "plan";
  const transport = new StdioClientTransport({
    command,
    args: [...prefix, "mcp", "--run", input.runId],
    env,
    cwd: input.cwd,
    stderr: "ignore",
    maxBufferSize: 2_000_000,
  });
  const client = new Client({ name: "agenteschat-host-acp", version: "1" });
  try {
    if (input.signal.aborted) throw new Error("MCP run cancelled");
    const abortConnect = () => {
      void client.close().catch(() => undefined);
    };
    input.signal.addEventListener("abort", abortConnect, { once: true });
    try {
      await client.connect(transport);
    } finally {
      input.signal.removeEventListener("abort", abortConnect);
    }
    if (input.signal.aborted) throw new Error("MCP run cancelled");
    return {
      listTools: async (params?: { cursor?: string }) =>
        client.listTools(params, { signal: input.signal, timeout: 60_000 }),
      callTool: async (params: { name: string; arguments: Record<string, unknown> }) =>
        // Foreground commands are bounded to 240s, below the daemon's 360s deadline.
        client.callTool(params, undefined, { signal: input.signal, timeout: 330_000 }),
      close: async () => {
        await client.close();
      },
    };
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}
