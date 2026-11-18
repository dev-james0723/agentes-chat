import { timingSafeEqual } from "node:crypto";

export type FoundryRpcMethod = (input: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
const NAME = /^[a-z][a-zA-Z]{0,48}$/;
const TOKEN = /^[a-f0-9]{64}$/;
const DEFAULT_LIMIT = 20 * 1024 * 1024;
class PayloadLimit extends Error {}
/** The runtime's admission gate refused before handing the request to any runner: nothing started. */
export class FoundryRuntimeBusyError extends Error {
  readonly code = "RUNTIME_BUSY";
  constructor() {
    super("Runtime capacity unavailable");
    this.name = "FoundryRuntimeBusyError";
  }
}
async function readBounded(body: ReadableStream<Uint8Array> | null, maximum: number): Promise<unknown> {
  if (!body) throw new Error("Missing control data");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const r = await reader.read();
      if (r.done) break;
      bytes += r.value.byteLength;
      if (bytes > maximum) {
        await reader.cancel();
        throw new PayloadLimit();
      }
      chunks.push(r.value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
}
function bound(value = DEFAULT_LIMIT) {
  if (!Number.isSafeInteger(value) || value < 128 || value > DEFAULT_LIMIT) throw new Error("Invalid control bound");
  return value;
}

/** A private control interface, not a general proxy, MCP source or shell. */
export function createFoundryRpcHandler(options: {
  token: string;
  methods: Record<string, FoundryRpcMethod>;
  maxBytes?: number;
}) {
  if (!TOKEN.test(options.token)) throw new Error("A separate 256-bit control credential is required");
  const secret = Buffer.from(`Bearer ${options.token}`);
  const maximum = bound(options.maxBytes);
  const methods = new Map(Object.entries(options.methods));
  return async (request: Request): Promise<Response> => {
    const answer = (status: number, code: string) =>
      Response.json({ code }, { status, headers: { "cache-control": "no-store" } });
    const got = Buffer.from(request.headers.get("authorization") ?? "");
    if (got.byteLength !== secret.byteLength || !timingSafeEqual(got, secret)) return answer(401, "UNAUTHORIZED");
    if (request.headers.has("origin") || request.headers.has("sec-fetch-mode")) return answer(403, "CONTROL_ONLY");
    if (request.method !== "POST") return answer(405, "METHOD_NOT_ALLOWED");
    if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json")
      return answer(415, "JSON_REQUIRED");
    const url = new URL(request.url);
    const name = url.pathname.split("/").at(-1)!;
    if (url.search || !NAME.test(name) || !methods.has(name)) return answer(404, "UNAVAILABLE");
    const declared = request.headers.get("content-length");
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximum)) return answer(413, "TOO_LARGE");
    let input: unknown;
    try {
      input = await readBounded(request.body, maximum);
    } catch (error) {
      return answer(error instanceof PayloadLimit ? 413 : 400, "INVALID_CONTROL_DATA");
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) return answer(400, "INVALID_CONTROL_DATA");
    try {
      const result = await methods.get(name)!(input as Record<string, unknown>, request.signal);
      const text = JSON.stringify(result ?? null);
      if (Buffer.byteLength(text) > maximum) return answer(503, "CONTROL_UNAVAILABLE");
      return new Response(text, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
    } catch (error) {
      return error instanceof FoundryRuntimeBusyError
        ? answer(429, "RUNTIME_BUSY")
        : answer(503, "CONTROL_UNAVAILABLE");
    }
  };
}

/** Only operator-configured HTTPS or explicit loopback/VM-host transport.
 * No model argument ever selects a URL, credential, method or redirect. */
export function createFoundryRpcClient(options: {
  url: string;
  token: string;
  fetch?: typeof fetch;
  maxBytes?: number;
}) {
  const url = new URL(options.url);
  if (
    !TOKEN.test(options.token) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]", "host.lima.internal", "host.docker.internal"].includes(url.hostname))
    )
  )
    throw new Error("Invalid private runtime endpoint");
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  const base = url.href;
  const token = options.token;
  const http = options.fetch ?? fetch;
  const maximum = bound(options.maxBytes);
  return async (method: string, input: unknown, timeoutMs = 5000, signal?: AbortSignal): Promise<unknown> => {
    if (!NAME.test(method) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
      throw new Error("Invalid control request");
    const body = JSON.stringify(input);
    if (Buffer.byteLength(body) > maximum) throw new PayloadLimit();
    const abort = AbortSignal.timeout(timeoutMs);
    const response = await http(new URL(method, base), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      redirect: "error",
      credentials: "omit",
      body,
      signal: signal ? AbortSignal.any([signal, abort]) : abort,
    });
    if (response.status === 429 && !response.redirected) {
      await response.body?.cancel();
      throw new FoundryRuntimeBusyError();
    }
    if (!response.ok || response.redirected) throw new Error("Private Foundry control unavailable");
    return readBounded(response.body, maximum);
  };
}
