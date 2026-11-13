import type { Config } from "@agenteschat/config";

// The local HTTP alias is safe only on a loopback-only listener whose public
// proxy always adds one of these headers. A Host header alone is not proof of
// a local peer. Do not use these untrusted values to select an origin.
const FORWARDED = ["forwarded", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-for", "x-forwarded-port"];

export function rejectForwardedLocal(config: Config, request: Request): Response | null {
  if (!config.LOCAL_HTTP_LOGIN) return null;
  const host = (request.headers.get("host") ?? new URL(request.url).host).toLowerCase();
  if (host !== `localhost:${config.PORT}` || !FORWARDED.some((header) => request.headers.has(header))) return null;
  return new Response("Local address is unavailable through a proxy.\n", { status: 421 });
}
