/** Admission is only a rollout scope; every caller must still use native access checks. */
export type CommunicationFeature = "founderUpdates" | "handoffs" | "verifiedLearning" | "economics";

export interface CommunicationPolicy {
  enabled: boolean;
  orgIds: readonly string[];
  taskIds: readonly string[];
  features: readonly CommunicationFeature[];
}

interface CommunicationConfig {
  COMMUNICATION_ENABLED?: boolean;
  COMMUNICATION_ORG_IDS?: readonly string[];
  COMMUNICATION_TASK_IDS?: readonly string[];
  COMMUNICATION_FEATURES?: readonly CommunicationFeature[];
}

/** Older configuration objects default off; no environment is read outside @agenteschat/config. */
export function communicationPolicyFromConfig(config: CommunicationConfig): CommunicationPolicy {
  return {
    enabled: config.COMMUNICATION_ENABLED === true,
    orgIds: [...(config.COMMUNICATION_ORG_IDS ?? [])],
    taskIds: [...(config.COMMUNICATION_TASK_IDS ?? [])],
    features: [...(config.COMMUNICATION_FEATURES ?? [])],
  };
}

/** Both allowlists are exact. Null task scope and wildcard strings never enable org-wide behavior. */
export function communicationFeatureEnabled(
  policy: CommunicationPolicy,
  feature: CommunicationFeature,
  scope: { orgId: string; taskId: string | null },
): boolean {
  return (
    policy.enabled &&
    scope.taskId !== null &&
    policy.orgIds.includes(scope.orgId) &&
    policy.taskIds.includes(scope.taskId) &&
    policy.features.includes(feature)
  );
}
