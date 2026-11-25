import { catalogModelOf, MODEL_TIERS, type ModelTier, modelInfo } from "@agenteschat/providers";
import { CLAUDE_CODE_MODELS } from "./brain-settings";

export type CreditEffort = "low" | "medium" | "high";
export interface CreditRequirements {
  minimumTier: ModelTier;
  effort: CreditEffort;
}
const EFFORTS: readonly CreditEffort[] = ["low", "medium", "high"];

export const isCreditMinimumTier = (value: unknown): value is ModelTier =>
  typeof value === "string" && MODEL_TIERS.includes(value as ModelTier);
export const isCreditEffort = (value: unknown): value is CreditEffort =>
  typeof value === "string" && EFFORTS.includes(value as CreditEffort);

/** Only explicit catalog ranks authorize quality. Price and a nearest-tier fallback are not capability evidence. */
export function creditModelMeetsRequirement(model: string, minimumTier: unknown, effort: unknown): boolean {
  if (!isCreditMinimumTier(minimumTier) || !isCreditEffort(effort)) return false;
  const info = modelInfo(model);
  return (
    !!info &&
    isCreditMinimumTier(info.tier) &&
    MODEL_TIERS.indexOf(info.tier) >= MODEL_TIERS.indexOf(minimumTier) &&
    (!info.efforts || info.efforts.includes(effort))
  );
}

/** Reuse the resolved source and existing durable task decisions; this never asks another judge or creates a route. */
export function deriveCreditRequirements(input: {
  sourceKind: string;
  sourceModel?: string | null;
  taskTiers?: readonly unknown[];
  efforts?: readonly unknown[];
  tools: boolean;
}): CreditRequirements | null {
  if (!["codex", "claude_code"].includes(input.sourceKind) || !input.sourceModel) return null;
  const source =
    input.sourceKind === "claude_code"
      ? (CLAUDE_CODE_MODELS.find((m) => m.value === input.sourceModel?.toLowerCase() || m.modelId === input.sourceModel)
          ?.modelId ?? input.sourceModel)
      : input.sourceModel;
  const canonical = catalogModelOf(source);
  const info = canonical ? modelInfo(canonical) : undefined;
  if (
    !info ||
    info.provider !== (input.sourceKind === "codex" ? "openai" : "anthropic") ||
    !isCreditMinimumTier(info.tier)
  )
    return null;
  let minimumTier = info.tier;
  for (const tier of input.taskTiers ?? []) {
    if (tier === undefined || tier === null) continue;
    if (!isCreditMinimumTier(tier)) return null;
    if (MODEL_TIERS.indexOf(tier) > MODEL_TIERS.indexOf(minimumTier)) minimumTier = tier;
  }
  if (input.tools && minimumTier === "small") minimumTier = "medium";
  let effort: CreditEffort | undefined;
  for (const value of input.efforts ?? []) {
    if (value === undefined || value === null || value === "auto") continue;
    // Codex already normalizes these settings. Claude Code preserves levels the API cannot express.
    if (input.sourceKind === "claude_code" && (value === "xhigh" || value === "max")) return null;
    const normalized = value === "xhigh" || value === "max" ? "high" : value;
    if (!isCreditEffort(normalized)) return null;
    if (!effort || EFFORTS.indexOf(normalized) > EFFORTS.indexOf(effort)) effort = normalized;
  }
  return { minimumTier, effort: effort ?? "high" };
}
