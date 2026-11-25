/** Google-hosted Colab MCP, distinct from the local browser bridge. */
export const COLAB_MCP_URL = "https://colaboratory.googleapis.com/mcp";
export const COLAB_SCOPE = "https://www.googleapis.com/auth/colaboratory";

/** Only the official endpoint: no query credentials, alternate port or lookalike host. */
export function isColabMcpEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash && url.href.replace(/\/$/, "") === COLAB_MCP_URL;
  } catch {
    return false;
  }
}

/** Colab ends a long RPC at 600 s. Let its answer arrive before the SDK sends cancellation. */
export function colabCallTimeoutMs(serverUrl: string | undefined, tool: string): number | undefined {
  return serverUrl && isColabMcpEndpoint(serverUrl) && (tool === "create_runtime" || tool === "execute_code")
    ? 660_000
    : undefined;
}

/** Goes before the vendor description so its execution guidance survives the tool-description limit. */
export function colabToolGuidance(tool: string): string {
  switch (tool) {
    case "create_runtime":
      return "Reuse a suitable runtime from list_runtimes first. Select an eligible list_runtime_specs entry and a new UUIDv4 requestId. After DEADLINE_EXCEEDED, repeat the identical request to wait for that creation; do not create another runtime.";
    case "execute_code":
      return "Use a separate session per task and a new UUID executionId per new execution. Keep the exact session, executionId and code. After DEADLINE_EXCEEDED or UNAVAILABLE, code may still be running: repeat only that identical request to reattach. Once a result returned, repeating the ID runs code again. Do not automatically retry effects with a new ID. Save checkpoints and results outside the runtime.";
    case "get_subscription":
      return "This returns the subscription tier, not remaining compute units, spending or guaranteed GPU availability.";
    case "delete_session":
      return "Close only a session this task opened. This aborts its code and discards kernel state; runtime files remain.";
    case "delete_runtime":
      return "Permanently deletes all runtime files and sessions. Use only when requested, or to free a runtime you created if capacity prevents another creation. Save results elsewhere first.";
    case "get_runtime":
    case "list_runtimes":
      return "Reuse suitable existing runtimes. Transfer files by the returned HTTP connectionInfo, not by embedding file bytes in tool calls. Keep runtime proxy tokens out of messages and artifacts.";
    default:
      return "";
  }
}
