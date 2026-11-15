/** Owner-bound macOS ACP turn. This runs only after the runner's local opt-in check. */
import { type ChildProcess, spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { type HostAcpHistory, isHostAcpHistory } from "@agenteschat/adapters/machine-protocol";
import type { CodexBrainEvent } from "./brain-codex";
import {
  HOST_ACP_TOOLS,
  HostAcpFailure,
  hostAcpDiagnostic,
  runStructuredToolLoop,
  ToolStopped,
  ToolSuspended,
} from "./host-acp-intent";
import { connectHostMcp } from "./host-acp-mcp";
import type { Spawn } from "./scope-gate";

const RUN_ID = /^[a-zA-Z0-9-]{8,64}$/;

type AcpPeer = { request(method: string, params: unknown): Promise<any> };
/** ACP title is display text, not an authenticated server/tool identity. */
export function hostAcpPermission(_sessionId: string, _params: unknown) {
  return { outcome: "cancelled" as const };
}

export async function selectAcpModel(peer: AcpPeer, session: any, model: string) {
  const configs = (values: any, key: string): any[] =>
    (Array.isArray(values) ? values : []).filter((x: any) => x?.category === key || x?.id === key);
  const options = (entry: any): any[] =>
    Array.isArray(entry?.options)
      ? entry.options.flatMap((x: any) => (Array.isArray(x?.options) ? x.options : [x]))
      : [];
  const list = configs(session?.configOptions, "model");
  const entry = list.length === 1 ? list[0] : null;
  const opts = options(entry);
  if (model === "gemini-4-argon-high" && (list.length > 1 || opts.filter((x: any) => x?.value === model).length > 1))
    throw new HostAcpFailure("model_unconfirmed");
  if (opts.some((x: any) => x?.value === model)) {
    const changed = await peer.request("session/set_config_option", {
      sessionId: session.sessionId,
      configId: entry.id,
      value: model,
    });
    const selected = configs(changed?.configOptions, "model");
    if (selected.length !== 1 || selected[0]?.id !== entry.id || selected[0]?.currentValue !== model)
      throw new HostAcpFailure("model_unconfirmed");
    return { selectionMode: "config_readback" as const, selectedModel: model };
  }
  // The installed CLI exposes Argon High as a base model plus a separate thinking setting.
  // Both must be observed in ONE final response from setters bound to this ACP session.
  if (model === "gemini-4-argon-high" && opts.some((x: any) => x?.value === "gemini-4-argon")) {
    const thoughts = configs(session?.configOptions, "thought_level");
    const thought = thoughts.length === 1 ? thoughts[0] : null;
    if (
      list.length !== 1 ||
      thoughts.length !== 1 ||
      entry.type !== "select" ||
      thought.type !== "select" ||
      typeof entry.id !== "string" ||
      typeof thought.id !== "string" ||
      !entry.id ||
      !thought.id ||
      entry.id === thought.id ||
      opts.filter((x: any) => x?.value === "gemini-4-argon").length !== 1 ||
      options(thought).filter((x: any) => x?.value === "high").length !== 1
    )
      throw new HostAcpFailure("model_unconfirmed");
    await peer.request("session/set_config_option", {
      sessionId: session.sessionId,
      configId: entry.id,
      value: "gemini-4-argon",
    });
    const changed = await peer.request("session/set_config_option", {
      sessionId: session.sessionId,
      configId: thought.id,
      value: "high",
    });
    const base = configs(changed?.configOptions, "model");
    const high = configs(changed?.configOptions, "thought_level");
    if (
      base.length !== 1 ||
      high.length !== 1 ||
      base[0]?.id !== entry.id ||
      high[0]?.id !== thought.id ||
      base[0]?.currentValue !== "gemini-4-argon" ||
      high[0]?.currentValue !== "high"
    )
      throw new HostAcpFailure("model_unconfirmed");
    return { selectionMode: "config_pair_readback" as const, selectedModel: "gemini-4-argon", thoughtLevel: "high" };
  }
  const legacy = session?.models;
  if (!Array.isArray(legacy?.availableModels) || !legacy.availableModels.some((x: any) => x?.modelId === model))
    throw new HostAcpFailure("model_unavailable");
  if (model === "gemini-4-argon-high" && legacy.availableModels.filter((x: any) => x?.modelId === model).length !== 1)
    throw new HostAcpFailure("model_unconfirmed");
  if (legacy.currentModelId === model) return { selectionMode: "session_readback" as const, selectedModel: model };
  const result = await peer.request("session/set_model", { sessionId: session.sessionId, modelId: model });
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new HostAcpFailure("model_unconfirmed");
  return { selectionMode: "ack_only" as const, selectedModel: null };
}

class Peer {
  private seq = 0;
  private buffer = "";
  private decoder = new StringDecoder("utf8");
  private pending = new Map<
    number,
    { resolve(v: any): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }
  >();
  private closed = false;
  sessionId = "";
  text = "";
  constructor(private child: ChildProcess) {}
  send(v: unknown) {
    if (!this.child.stdin?.writable) throw new HostAcpFailure("transport_closed");
    this.child.stdin.write(JSON.stringify(v) + "\n");
  }
  request(method: string, params: unknown): Promise<any> {
    if (this.closed) return Promise.reject(new HostAcpFailure("transport_closed"));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          reject(new HostAcpFailure("transport_timeout"));
        },
        method === "session/prompt" ? 900_000 : 90_000,
      );
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new HostAcpFailure("transport_send_failed"));
      }
    });
  }
  data(chunk: Buffer) {
    if (this.closed) return;
    this.buffer += this.decoder.write(chunk);
    if (this.buffer.length > 2_000_000) return this.close();
    for (;;) {
      const n = this.buffer.indexOf("\n");
      if (n < 0) return;
      const line = this.buffer.slice(0, n);
      this.buffer = this.buffer.slice(n + 1);
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        return this.close();
      }
      if (!msg || msg.jsonrpc !== "2.0") return this.close();
      if (typeof msg.method === "string" && (typeof msg.id === "number" || typeof msg.id === "string")) {
        try {
          if (msg.method === "session/request_permission")
            this.send({
              jsonrpc: "2.0",
              id: msg.id,
              result: { outcome: hostAcpPermission(this.sessionId, msg.params) },
            });
          else this.send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Unsupported" } });
        } catch {
          return this.close();
        }
      } else if (msg.method === "session/update") {
        if (!this.sessionId || msg.params?.sessionId !== this.sessionId) continue;
        const update = msg.params.update;
        if (
          update?.sessionUpdate === "agent_message_chunk" &&
          update.content?.type === "text" &&
          typeof update.content.text === "string"
        ) {
          const text = update.content.text;
          if (text.length > 100_000 || this.text.length + text.length > 1_000_000) return this.close();
          // Buffer until a complete response so secrets split across chunks cannot escape redaction.
          this.text += text;
        }
      } else if (typeof msg.id === "number") {
        const p = this.pending.get(msg.id);
        if (!p) return this.close();
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        if (msg.error || !msg.result || typeof msg.result !== "object")
          p.reject(new HostAcpFailure("transport_request_failed"));
        else p.resolve(msg.result);
      }
    }
  }
  cancel() {
    if (this.sessionId && !this.closed) {
      try {
        this.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.sessionId } });
      } catch {}
    }
    this.close();
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new HostAcpFailure("transport_closed"));
    }
    this.pending.clear();
  }
}

/** Reap only the detached group this runner created; false means scratch must be retained. */
export async function stopHostAcpGroup(
  child: Pick<ChildProcess, "pid" | "exitCode" | "signalCode" | "kill">,
  signalGroup: (pid: number, signal: NodeJS.Signals | 0) => boolean = process.kill,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<boolean> {
  if (!child.pid) {
    try {
      child.kill("SIGTERM");
    } catch {}
    return false;
  }
  const id = -child.pid;
  const gone = () => {
    try {
      signalGroup(id, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  };
  if (gone()) return true;
  try {
    signalGroup(id, "SIGTERM");
  } catch {}
  await wait(2000);
  if (gone()) return true;
  try {
    signalGroup(id, "SIGKILL");
  } catch {}
  await wait(1000);
  return gone();
}

export interface HostAcpTurn {
  hostAcpHistory?: HostAcpHistory;
  cwd: string;
  runnerHome: string;
  runId: string;
  sessionId: string;
  model: string;
  prompt: string;
  profile: "plan" | "work";
  /** Test seam; normal runs use the local stdio MCP client. */
  connectMcp?: typeof connectHostMcp;
  mcp: { token: string; socketPath: string; command: string[] };
  signal: AbortSignal;
  emit: (event: CodexBrainEvent) => void;
  redact?: (text: string) => string;
  bin: string;
  spawn?: Spawn;
  /** Re-checks the actual local opt-in; never accepts a remote host flag. */
  isAuthorized: () => boolean;
}

/** Caller has already validated the bound local host account and normal agent permissions. */
export async function runHostAcpTurn(input: HostAcpTurn): Promise<void> {
  let child: ChildProcess | undefined;
  let scratch: string | undefined;
  let peer: Peer | undefined;
  let resultText: string | undefined;
  let groupGone = false;
  let failReason = "The host Antigravity ACP turn could not complete.";
  let deliveryUnknown = false;
  let mcpClient: Awaited<ReturnType<typeof connectHostMcp>> | undefined;
  const mcpAbort = new AbortController();
  try {
    if (
      process.platform !== "darwin" ||
      !RUN_ID.test(input.runId) ||
      !RUN_ID.test(input.sessionId) ||
      !input.mcp.token ||
      !path.isAbsolute(input.bin) ||
      !path.isAbsolute(input.cwd) ||
      !path.isAbsolute(input.mcp.socketPath) ||
      !input.mcp.command.length ||
      !path.isAbsolute(input.mcp.command[0]!) ||
      !input.model ||
      (input.hostAcpHistory !== undefined && !isHostAcpHistory(input.hostAcpHistory, input.runId)) ||
      input.prompt.length > 1_000_000 ||
      input.signal.aborted ||
      !input.isAuthorized()
    )
      throw new HostAcpFailure("admission_failed");
    const uncertain = input.hostAcpHistory?.observations.find((o) => o.state === "unknown");
    if (uncertain) throw new ToolStopped("bridge.history_unknown", "unknown", uncertain.callId);
    const hostHome = realpathSync(os.homedir());
    const root = realpathSync(input.runnerHome);
    const under = path.relative(hostHome, root);
    if (!under || under === ".." || under.startsWith(`..${path.sep}`) || path.isAbsolute(under))
      throw new HostAcpFailure("runner_home_invalid");
    scratch = mkdtempSync(path.join(root, "host-acp-"));
    const gemini = path.join(scratch, "gemini");
    const settingsDir = path.join(gemini, "antigravity-cli");
    const agentDir = path.join(gemini, "config", "agents", "agenteschat-acp");
    mkdirSync(settingsDir, { recursive: true, mode: 0o700 });
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      path.join(settingsDir, "settings.json"),
      JSON.stringify({
        toolPermission: "strict",
        enableTerminalSandbox: true,
        allowNonWorkspaceAccess: false,
        useG1Credits: false,
        permissions: { allow: [], deny: [] },
      }),
      { mode: 0o600 },
    );
    writeFileSync(
      path.join(agentDir, "agent.md"),
      "---\nname: agenteschat-acp\ndescription: Answers through the agentes tools.\ntools: []\nmainAgent: true\nsubagent: false\ncommandExecutionPolicy: off\n---\nUse only the agentes MCP tools.\n",
      { mode: 0o600 },
    );
    const relativeGemini = path.relative(hostHome, gemini);
    const args = [
      "acp",
      "--sandbox",
      "--process-per-session",
      "--gemini-dir",
      relativeGemini,
      "--app-data-dir",
      "antigravity-cli",
      "--include-default-customizations=false",
      "--agent",
      "agenteschat-acp",
      "--log-file",
      path.join(scratch, "acp.log"),
    ];
    // No alternate API identities, tokens, or agent secret env are inherited. The MCP run token is scoped by the bridge.
    const env: NodeJS.ProcessEnv = {};
    for (const k of ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG"]) if (process.env[k]) env[k] = process.env[k];
    env.HOME = hostHome;
    child = (input.spawn ?? spawn)(input.bin, args, {
      cwd: input.cwd,
      env,
      stdio: ["pipe", "pipe", "ignore"],
      detached: true,
    });
    const secret = input.mcp.token;
    const clean = (text: string) => (input.redact ? input.redact(text) : text).split(secret).join("[redacted]");
    peer = new Peer(child);
    child.stdout?.on("data", (chunk: Buffer) => peer?.data(chunk));
    const events = child as unknown as EventEmitter;
    events.on("error", () => peer?.close());
    events.on("exit", () => peer?.close());
    const cancel = () => {
      mcpAbort.abort();
      peer?.cancel();
    };
    input.signal.addEventListener("abort", cancel, { once: true });
    // The signal may have fired during setup, before the listener was installed.
    if (input.signal.aborted) cancel();
    // Best effort in-flight revocation: no additional tool access is granted while this check races.
    const authorizationPoll = setInterval(() => {
      if (!input.isAuthorized()) cancel();
    }, 500);
    try {
      const init = await peer.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "agenteschat", version: "0.1" },
      });
      if (init.protocolVersion !== 1) throw new HostAcpFailure("protocol_unsupported");
      const session = await peer.request("session/new", { cwd: input.cwd, mcpServers: [] });
      if (typeof session.sessionId !== "string" || !session.sessionId) throw new HostAcpFailure("session_missing");
      peer.sessionId = session.sessionId;
      const selection = await selectAcpModel(peer, session, input.model);
      if (input.model === "gemini-4-argon-high" && selection.selectionMode === "ack_only")
        throw new HostAcpFailure("model_high_unconfirmed");
      // A diagnostic readback, not a model-authored claim or an app tool dispatch.
      // The engine validates this envelope and durably records a context step before work accounting.
      if (selection.selectionMode !== "ack_only")
        input.emit({
          type: "tool_call",
          id: `${input.runId}:model-selection`,
          name: "host_acp_model_selection",
          input: {},
          executed: {
            content: JSON.stringify({
              source: "cli_response",
              runId: input.runId,
              nativeSessionId: input.sessionId,
              acpSessionId: session.sessionId,
              requestedModel: input.model,
              ...selection,
            }),
          },
        });
      if (!input.isAuthorized()) throw new HostAcpFailure("authorization_ended");
      mcpClient = await (input.connectMcp ?? connectHostMcp)({
        ...input.mcp,
        runnerHome: root,
        cwd: input.cwd,
        runId: input.runId,
        profile: input.profile,
        signal: mcpAbort.signal,
      });
      const turnPeer = peer;
      try {
        const answer = await runStructuredToolLoop({
          mcp: mcpClient,
          prompt: input.prompt,
          signal: mcpAbort.signal,
          isAuthorized: input.isAuthorized,
          allowed: HOST_ACP_TOOLS,
          history: input.hostAcpHistory,
          runId: input.runId,
          ask: async (text) => {
            turnPeer.text = "";
            const result = await turnPeer.request("session/prompt", {
              sessionId: turnPeer.sessionId,
              prompt: [{ type: "text", text }],
            });
            if (result.stopReason !== "end_turn" || input.signal.aborted) throw new HostAcpFailure("prompt_incomplete");
            return turnPeer.text;
          },
        });
        resultText = clean(answer);
      } catch (error) {
        if (error instanceof ToolSuspended) resultText = "";
        else throw error;
      }
    } finally {
      clearInterval(authorizationPoll);
      input.signal.removeEventListener("abort", cancel);
    }
  } catch (error) {
    resultText = undefined;
    if (error instanceof ToolStopped) {
      failReason = error.message;
      deliveryUnknown = error.effect === "unknown";
    } else if (error instanceof HostAcpFailure) failReason = hostAcpDiagnostic(error);
    else if (error instanceof Error && /delivery unknown/.test(error.message))
      failReason = "A tool call's delivery is unknown. It was not retried; check its result before trying again.";
    else if (error instanceof Error && /image or non-text/.test(error.message))
      failReason = "This tool returned an image or other content the agent cannot read yet.";
    else if (error instanceof Error && /run-state capability unavailable/.test(error.message))
      failReason = "This computer's app bridge is too old to safely run tools.";
    else failReason = hostAcpDiagnostic(error);
  } finally {
    mcpAbort.abort();
    await mcpClient?.close().catch(() => undefined);
    peer?.close();
    groupGone = child ? await stopHostAcpGroup(child) : true;
    // If the group could not be confirmed gone, retain private scratch for reconciliation.
    if (scratch && groupGone) {
      try {
        rmSync(scratch, { recursive: true, force: true });
      } catch {}
    }
  }
  if (!groupGone) {
    input.emit({
      type: "error",
      code: deliveryUnknown ? "antigravity_delivery_unknown" : "antigravity_cleanup_unconfirmed",
      message: `${deliveryUnknown ? `${failReason} ` : ""}The ACP process group could not be confirmed stopped; its private scratch was retained.`,
      retryable: false,
    });
  } else if (resultText === undefined || input.signal.aborted || !input.isAuthorized()) {
    // Cancellation can arrive during cleanup after a result; never describe the whole turn as effect-free.
    if (failReason === "The host Antigravity ACP turn could not complete.")
      failReason = hostAcpDiagnostic(
        input.signal.aborted
          ? new HostAcpFailure("canceled")
          : !input.isAuthorized()
            ? new HostAcpFailure("authorization_ended")
            : undefined,
      );
    input.emit({
      type: "error",
      code: deliveryUnknown ? "antigravity_delivery_unknown" : "antigravity_failed",
      message: failReason,
      retryable: false,
    });
  } else {
    if (resultText) input.emit({ type: "text_delta", text: resultText });
    input.emit({ type: "done", text: resultText, session: { id: input.sessionId } });
  }
}
