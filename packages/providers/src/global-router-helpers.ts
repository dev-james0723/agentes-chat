import { assertSafeRouterEndpoint, type RateLimitTelemetry } from "./global-router-catalog";
import { isOpencodeFreeModel } from "./plans";

export { assertSafeRouterEndpoint, type RateLimitTelemetry };

/**
 * OpenCode Go includes select `-free` models on Go's official endpoints (`beam-free`, `crouton-alpha-free`,
 * `iceman-contributor-free`, `longcat-2.5-free`), whereas OpenCode's Zen free tier (`opencode/*-free`,
 * `deepseek-v4.1-flash-free`, `glm-5.3-flash-free`, `hy4-flash-free`, `mimo-v2.6-flash-free`, `nemotron-*-free`)
 * is restricted to the native OpenCode CLI and returns 403 to external clients.
 */
const GO_SUPPORTED_FREE_IDS = new Set([
  "beam-free",
  "crouton-alpha-free",
  "iceman-contributor-free",
  "longcat-2.5-free",
]);

export function isOpencodeNativeOnlyFreeId(modelId: string): boolean {
  if (modelId.startsWith("opencode/")) return true;
  if (isOpencodeFreeModel(`opencode/${modelId}`) && !GO_SUPPORTED_FREE_IDS.has(modelId)) return true;
  if (modelId.endsWith("-free") && !GO_SUPPORTED_FREE_IDS.has(modelId)) return true;
  return false;
}
