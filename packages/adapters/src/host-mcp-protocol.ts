/** Owner-configured stdio MCP over the existing authenticated machine channel. Never carries commands or env values. */
export const HOST_MCP_PROTOCOL = 67;
export const HOST_MCP_LIMITS = { tools: 1000, argsChars: 1024 * 1024, resultBytes: 6 * 1024 * 1024 };
export type HostMcpAccess = "read" | "approval" | "off";
export interface HostMcpIdentity {
  orgId: string;
  machineId: string;
}
export interface HostMcpBinding extends HostMcpIdentity {
  agentId: string;
  profileId: string;
  revision: string;
}
export interface HostMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  access: HostMcpAccess;
}
export interface HostMcpProfile {
  id: string;
  label: string;
  revision: string;
  enabled: boolean;
  kind: "general" | "phone";
}
export interface HostMcpImage {
  mediaType: string;
  data: string;
}
export interface HostMcpOutput {
  content: string;
  isError: boolean;
  images?: HostMcpImage[];
}
export type HostMcpRequest =
  | (HostMcpIdentity & { action: "profiles"; actorId: string })
  | (HostMcpBinding & { action: "catalog" })
  | (HostMcpBinding & { action: "close" })
  | (HostMcpBinding & {
      action: "call";
      runId: string;
      callId: string;
      tool: string;
      args: Record<string, unknown>;
      approved?: boolean;
    })
  | (HostMcpBinding & {
      action: "reconcile";
      actorId: string;
      runId: string;
      callId: string;
      decision: "observed_completed" | "observed_not_executed";
    });
export interface HostMcpReply extends Partial<HostMcpOutput> {
  profiles?: HostMcpProfile[];
  tools?: HostMcpTool[];
  closed?: boolean;
  reconciled?: boolean;
}
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export const isHostMcpToolName = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(v);
const id = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(v);
/** Strict shape: commands, auth material and a model-selected target can never hide in extension fields. */
export function isHostMcpRequest(v: unknown): v is HostMcpRequest {
  if (!obj(v) || !id(v.orgId) || !id(v.machineId)) return false;
  const common = ["action", "orgId", "machineId"];
  let keys: string[];
  if (v.action === "profiles") keys = [...common, "actorId"];
  else {
    if (!id(v.agentId) || !id(v.profileId) || typeof v.revision !== "string" || !/^[a-f0-9]{64}$/.test(v.revision))
      return false;
    keys = [...common, "agentId", "profileId", "revision"];
    if (v.action === "call") {
      keys.push("runId", "callId", "tool", "args", "approved");
      if (
        !id(v.runId) ||
        !id(v.callId) ||
        !isHostMcpToolName(v.tool) ||
        !obj(v.args) ||
        JSON.stringify(v.args).length > HOST_MCP_LIMITS.argsChars
      )
        return false;
      if (v.approved !== undefined && typeof v.approved !== "boolean") return false;
    } else if (v.action === "reconcile") {
      keys.push("actorId", "runId", "callId", "decision");
      if (
        !id(v.runId) ||
        !id(v.callId) ||
        !["observed_completed", "observed_not_executed"].includes(String(v.decision))
      )
        return false;
    } else if (v.action !== "catalog" && v.action !== "close") return false;
  }
  if ((v.action === "profiles" || v.action === "reconcile") && !id(v.actorId)) return false;
  return Object.keys(v).every((k) => keys.includes(k));
}
function mediaHead(data: unknown, maxBytes = HOST_MCP_LIMITS.resultBytes): string | null {
  if (
    typeof data !== "string" ||
    data.length === 0 ||
    data.length > maxBytes ||
    data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
  )
    return null;
  try {
    // Checking the final quartet also rejects non-canonical padding bits without decoding a large body.
    if (btoa(atob(data.slice(-4))) !== data.slice(-4)) return null;
    return atob(data.slice(0, 16));
  } catch {
    return null;
  }
}
function validImage(mediaType: unknown, data: unknown, maxBytes = HOST_MCP_LIMITS.resultBytes): data is string {
  const head = mediaHead(data, maxBytes);
  if (head === null) return false;
  return mediaType === "image/png"
    ? head.startsWith("\x89PNG\r\n\x1a\n")
    : mediaType === "image/jpeg"
      ? head.startsWith("\xff\xd8\xff")
      : mediaType === "image/gif"
        ? head.startsWith("GIF87a") || head.startsWith("GIF89a")
        : mediaType === "image/webp" && head.startsWith("RIFF") && head.slice(8, 12) === "WEBP";
}
/** Native tool results also support PDFs as resources; host image blocks never accept a PDF MIME type. */
export function isMcpResultMedia(v: unknown, maxBytes = HOST_MCP_LIMITS.resultBytes): boolean {
  return (
    Array.isArray(v) &&
    v.length <= 20 &&
    v.every(
      (b) =>
        obj(b) &&
        Object.keys(b).every((k) => ["mediaType", "data", "name"].includes(k)) &&
        (b.name === undefined || (typeof b.name === "string" && b.name.length <= 255 && !/\p{Cc}/u.test(b.name))) &&
        (b.mediaType === "application/pdf"
          ? mediaHead(b.data, maxBytes)?.startsWith("%PDF-") === true
          : validImage(b.mediaType, b.data, maxBytes)),
    ) &&
    new TextEncoder().encode(JSON.stringify(v)).byteLength <= maxBytes
  );
}
/** Exact bytes, no placeholder blocks. Unsupported/oversized output is a completed-but-rejected output. */
export function hostMcpOutput(value: unknown): HostMcpOutput {
  if (!obj(value) || !Array.isArray(value.content)) throw new Error("MCP completed-output-rejected: invalid content");
  const text: string[] = [];
  const images: HostMcpImage[] = [];
  for (const block of value.content) {
    if (!obj(block)) throw new Error("MCP completed-output-rejected: invalid block");
    if (block.type === "text" && typeof block.text === "string") text.push(block.text);
    else if (block.type === "image" && typeof block.mimeType === "string" && validImage(block.mimeType, block.data))
      images.push({ mediaType: block.mimeType, data: block.data });
    else if (block.type === "resource" && obj(block.resource) && typeof block.resource.text === "string")
      text.push(block.resource.text);
    else throw new Error("MCP completed-output-rejected: unsupported media");
  }
  if (text.length === 0 && images.length === 0 && value.structuredContent !== undefined)
    text.push(JSON.stringify(value.structuredContent));
  const out: HostMcpOutput = {
    content: text.join("\n"),
    isError: value.isError === true,
    ...(images.length ? { images } : {}),
  };
  if (images.length > 20 || new TextEncoder().encode(JSON.stringify(out)).byteLength > HOST_MCP_LIMITS.resultBytes)
    throw new Error("MCP completed-output-rejected: size limit");
  return out;
}
/** Native bridge image payloads are transient and bounded by one machine frame. */
export function isHostMcpImages(v: unknown): v is HostMcpImage[] {
  return (
    Array.isArray(v) &&
    v.length <= 20 &&
    v.every(
      (b) =>
        obj(b) && Object.keys(b).every((k) => ["mediaType", "data"].includes(k)) && validImage(b.mediaType, b.data),
    ) &&
    new TextEncoder().encode(JSON.stringify(v)).byteLength <= HOST_MCP_LIMITS.resultBytes
  );
}
