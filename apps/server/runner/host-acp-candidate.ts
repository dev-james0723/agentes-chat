/**
 * ACP helpers used by local verification; turn transport lives in host-acp-runtime.ts.
 * The `isolationVerified` assertion is a prerequisite for a future host-side
 * admission check, not evidence that agy's directory flags provide isolation.
 */
import path from "node:path";

type Candidate = {
  optIn: boolean;
  os: string;
  runnerMode: string;
  phones: boolean;
  sameOwner: boolean;
  isolationVerified: boolean;
  binary: string;
  home: string;
  scratch: string;
};

export function hostAcpLaunch(input: Candidate) {
  if (
    !input.optIn ||
    input.os !== "darwin" ||
    input.runnerMode !== "single" ||
    input.phones ||
    !input.sameOwner ||
    !input.isolationVerified
  )
    throw new Error("host ACP admission refused");
  if (
    !path.isAbsolute(input.binary) ||
    !path.isAbsolute(input.home) ||
    !path.isAbsolute(input.scratch) ||
    path.resolve(input.scratch) === "/"
  ) {
    throw new Error("absolute binary and private scratch paths required");
  }
  const relative = path.relative(path.resolve(input.home), path.resolve(input.scratch));
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("scratch must be inside the host home");
  }
  return {
    command: input.binary,
    args: [
      "acp",
      "--sandbox",
      "--process-per-session",
      "--gemini-dir",
      path.join(relative, "gemini"),
      "--app-data-dir",
      "antigravity-cli",
      "--include-default-customizations=false",
    ],
  };
}

export function hostAcpNewSession(cwd: string, command: string, runId: string) {
  if (!path.isAbsolute(cwd) || !path.isAbsolute(command) || !/^[a-zA-Z0-9-]{8,64}$/.test(runId)) {
    throw new Error("invalid session context");
  }
  return { cwd, mcpServers: [{ name: "agenteschat_agentes", command, args: ["mcp", "--run", runId], env: [] }] };
}

/** Deny until a future integration can safely route a request to a person. */
export function hostAcpPermissionReply(id: number | string) {
  return { jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } };
}

/** Bounded JSON-lines peer. It has no process-spawning or credential access. */
export class HostAcpPeer {
  private buffer = "";
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(
    private readonly send: (line: string) => void,
    private readonly timeoutMs = 30_000,
    private output?: { sessionId: string; onText: (text: string) => void },
  ) {}

  setOutput(sessionId: string, onText: (text: string) => void) {
    if (!sessionId) throw new Error("ACP session is required");
    this.output = { sessionId, onText };
  }

  request(method: string, params: unknown): Promise<any> {
    if (this.closed) return Promise.reject(new Error("ACP peer closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("ACP request timed out"));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error("ACP transport failed"));
      }
    });
  }

  feed(chunk: string) {
    if (this.closed) return;
    this.buffer += chunk;
    if (this.buffer.length > 2_000_000) return this.close("ACP protocol failure");
    for (;;) {
      const n = this.buffer.indexOf("\n");
      if (n < 0) break;
      const line = this.buffer.slice(0, n);
      this.buffer = this.buffer.slice(n + 1);
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        return this.close("ACP protocol failure");
      }
      if (!msg || msg.jsonrpc !== "2.0") return this.close("ACP protocol failure");
      if (typeof msg.method === "string" && (typeof msg.id === "number" || typeof msg.id === "string")) {
        const reply =
          msg.method === "session/request_permission"
            ? hostAcpPermissionReply(msg.id)
            : { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Unsupported" } };
        try {
          this.send(JSON.stringify(reply) + "\n");
        } catch {
          return this.close("ACP transport failed");
        }
      } else if (
        msg.method === "session/update" &&
        ["tool_call", "tool_call_update"].includes(msg.params?.update?.sessionUpdate)
      ) {
        const sessionId = msg.params?.sessionId;
        if (typeof sessionId === "string") {
          try {
            this.send(JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } }) + "\n");
          } catch {}
        }
        return this.close("ACP unexpected tool");
      } else if (
        msg.method === "session/update" &&
        this.output &&
        msg.params?.sessionId === this.output.sessionId &&
        msg.params?.update?.sessionUpdate === "agent_message_chunk" &&
        msg.params.update.content?.type === "text" &&
        typeof msg.params.update.content.text === "string"
      ) {
        this.output.onText(msg.params.update.content.text.slice(0, 100_000));
      } else if (typeof msg.id === "number") {
        const wait = this.pending.get(msg.id);
        if (!wait) return this.close("ACP protocol failure");
        clearTimeout(wait.timer);
        this.pending.delete(msg.id);
        if (msg.error) wait.reject(new Error("ACP request failed"));
        else if ("result" in msg) wait.resolve(msg.result);
        else wait.reject(new Error("ACP protocol failure"));
      }
      // Notifications deliberately remain unprocessed until the runner has a
      // reviewed event mapping and a policy for late/uncertain tool effects.
    }
  }

  close(reason = "ACP peer closed") {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
    this.buffer = "";
  }
}

type Peer = { request(method: string, params: unknown): Promise<any> };
type SessionInput = { cwd: string; command: string; runId: string; model: string; prompt: string };

/** A mockable ACP sequence; the caller owns transport, permission denial and cancellation. */
export async function runHostAcpSession(peer: Peer, input: SessionInput) {
  const init = await peer.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: "agenteschat-host-acp-candidate", version: "0.1" },
  });
  if (init?.protocolVersion !== 1) throw new Error("ACP protocol unsupported");
  const created = await peer.request("session/new", hostAcpNewSession(input.cwd, input.command, input.runId));
  if (typeof created?.sessionId !== "string" || !created.sessionId) throw new Error("ACP session not created");
  const models = (Array.isArray(created.configOptions) ? created.configOptions : []).filter(
    (o: any) => o?.category === "model" || o?.id === "model",
  );
  const option = models.length === 1 ? models[0] : null;
  const options = Array.isArray(option?.options)
    ? option.options.flatMap((o: any) => (Array.isArray(o?.options) ? o.options : [o]))
    : [];
  let modelConfirmation: "config_readback" | "session_readback" | "ack_only";
  if (options.some((o: any) => o?.value === input.model)) {
    const changed = await peer.request("session/set_config_option", {
      sessionId: created.sessionId,
      configId: option.id,
      value: input.model,
    });
    if (
      !(
        Array.isArray(changed?.configOptions) &&
        changed.configOptions.some((o: any) => o?.id === option.id && o?.currentValue === input.model)
      )
    )
      throw new Error("ACP model selection unconfirmed");
    modelConfirmation = "config_readback";
  } else {
    const legacy = created?.models;
    if (!Array.isArray(legacy?.availableModels) || !legacy.availableModels.some((o: any) => o?.modelId === input.model))
      throw new Error("ACP model unavailable");
    if (legacy.currentModelId === input.model) modelConfirmation = "session_readback";
    else {
      const changed = await peer.request("session/set_model", { sessionId: created.sessionId, modelId: input.model });
      if (!changed || typeof changed !== "object" || Array.isArray(changed))
        throw new Error("ACP model selection unconfirmed");
      modelConfirmation = "ack_only";
    }
  }
  const result = await peer.request("session/prompt", {
    sessionId: created.sessionId,
    prompt: [{ type: "text", text: input.prompt }],
  });
  if (!result || typeof result.stopReason !== "string") throw new Error("ACP prompt did not finish");
  return { stopReason: result.stopReason, modelConfirmation };
}
