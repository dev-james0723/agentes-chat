import { createHash } from "node:crypto";
import { ValidationError } from "../errors";
import type { ToolContext } from "../tools/types";

/** Team MCP, not the separately scoped catalog-only /mcp/v2 endpoint. */
export const TREG_MCP_URL = "https://treg.to/mcp/";
export const TREG_READ_TOOLS = [
  "catalog_search",
  "catalog_get",
  "resources_list",
  "balance",
  "my_tools",
  "call_result",
] as const;

export function isTregMcpEndpoint(value: string | null | undefined): boolean {
  try {
    const url = new URL(value ?? "");
    return (
      url.origin === "https://treg.to" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.pathname === "/mcp" || url.pathname === "/mcp/")
    );
  } catch {
    return false;
  }
}

export const tregReadTool = (name: string) => (TREG_READ_TOOLS as readonly string[]).includes(name);
export const tregExecutor = (name: string) => name === "call" || name === "call_media";
export const TREG_TOOL_GUIDANCE =
  "Search the catalog, then read catalog_get for current parameters and price before a call. " +
  "The TREG charge ceiling defaults to $0; a positive X-Treg-Route-Max-Cost header needs an approved call. " +
  "A team's own provider key may have separate charges. After an unknown outcome use call_result; do not blindly retry.";

type TregContext = Pick<ToolContext, "orgId" | "agentId" | "runId" | "toolUseId" | "approved" | "background"> & {
  connectionId: string;
};
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const tag = (value: string) => (/^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : "id_" + digest(value).slice(0, 32));
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const RESERVED = new Set([
  "authorization",
  "proxy-authorization",
  "x-treg-token",
  "x-treg-org",
  "x-treg-meta",
  "x-treg-authorization-method",
  "idempotency-key",
]);
const CAP_HEADER = "x-treg-route-max-cost";

export interface TregPreparedCall {
  args: Record<string, unknown>;
  headers: Record<string, string>;
  capUsd: number | null;
  idempotencyKey: string | null;
}

/**
 * Transport metadata is backend-owned. Cost ceilings must be inside the tool's
 * headers: the MCP service does not forward an outer transport cost header.
 * A zero TREG ceiling is not a claim about upstream BYOK billing.
 */
export function prepareTregCall(name: string, input: Record<string, unknown>, ctx: TregContext): TregPreparedCall {
  const headers = {
    "X-Treg-Meta": [
      "workspace=" + tag(ctx.orgId),
      "agent=" + tag(ctx.agentId),
      "run=" + tag(ctx.runId),
      ...(ctx.toolUseId ? ["call=" + tag(ctx.toolUseId)] : []),
    ].join(", "),
  };
  // Hub publishing runs user-supplied live checks without a caller budget ceiling.
  // It is outside tool consumption and needs a separate reviewed publishing path.
  if (name === "hub_create" || name === "hub_update")
    throw new ValidationError("TREG Hub publishing is unavailable here because its live checks have no bounded cost");
  if (!tregExecutor(name)) return { args: input, headers, capUsd: null, idempotencyKey: null };
  if (!ctx.toolUseId) throw new ValidationError("TREG execution requires a native tool-call identity");
  if (input.headers != null && !record(input.headers)) throw new ValidationError("TREG headers must be an object");

  const sent: Record<string, string> = {};
  const caps: string[] = [];
  for (const [key, value] of Object.entries(input.headers ?? {})) {
    const lower = key.toLowerCase();
    if (RESERVED.has(lower)) continue;
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(key) || typeof value !== "string" || /[\r\n]/.test(value))
      throw new ValidationError("TREG headers must contain valid string values");
    if (lower === CAP_HEADER) caps.push(value);
    else sent[key] = value;
  }
  if (caps.length > 1) throw new ValidationError("Use one TREG cost ceiling");
  const cap = caps[0] ?? "0";
  if (!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(cap))
    throw new ValidationError("TREG cost ceiling must be a nonnegative USD amount with at most six decimals");
  const capUsd = Number(cap);
  if (!Number.isFinite(capUsd) || !Number.isSafeInteger(Math.round(capUsd * 1_000_000)))
    throw new ValidationError("TREG cost ceiling is out of range");
  if (capUsd > 0 && ctx.approved !== true)
    throw new ValidationError("Paid TREG calls require an approved call with an explicit cost ceiling");
  sent["X-Treg-Route-Max-Cost"] = cap;
  const idempotencyKey =
    "ac_" + digest([ctx.orgId, ctx.agentId, ctx.runId, ctx.toolUseId, ctx.connectionId, name]).slice(0, 48);
  return {
    args: { ...input, headers: sent, idempotency_key: idempotencyKey },
    headers,
    capUsd,
    idempotencyKey,
  };
}

/** TREG reports upstream failures inside a successful MCP envelope. Never inspect an arbitrary provider body. */
export function tregResultFailed(result: { content: string; data?: unknown }): boolean {
  let value = result.data;
  if (!record(value)) {
    try {
      value = JSON.parse(result.content);
    } catch {
      return false;
    }
  }
  if (!record(value)) return false;
  return (
    (typeof value.status === "number" &&
      Number.isInteger(value.status) &&
      value.status >= 400 &&
      value.status <= 599) ||
    (typeof value.upstream_failed === "string" && value.upstream_failed.trim().length > 0) ||
    (typeof value.error === "string" && value.error.trim().length > 0)
  );
}

export interface TregReceipt {
  callId?: string;
  reportedCostUsd?: number;
  reportedCostMicro?: number;
  status?: number;
  replayed?: boolean;
}

/** Observed call metadata, not a settled invoice or proof of upstream zero cost. */
export function tregReceipt(result: { content: string; data?: unknown }): TregReceipt {
  let value = result.data;
  if (!record(value)) {
    try {
      value = JSON.parse(result.content);
    } catch {
      return {};
    }
  }
  if (!record(value)) return {};
  const out: TregReceipt = {};
  if (typeof value.call_id === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(value.call_id)) out.callId = value.call_id;
  if (typeof value.cost_usd === "number" && Number.isFinite(value.cost_usd) && value.cost_usd >= 0) {
    const micro = Math.round(value.cost_usd * 1_000_000);
    if (Number.isSafeInteger(micro)) {
      out.reportedCostUsd = value.cost_usd;
      out.reportedCostMicro = micro;
    }
  }
  if (typeof value.status === "number" && Number.isInteger(value.status) && value.status >= 100 && value.status <= 599)
    out.status = value.status;
  if (typeof value.replayed === "boolean") out.replayed = value.replayed;
  return out;
}
