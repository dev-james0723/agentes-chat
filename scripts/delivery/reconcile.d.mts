/** Typed server entry points. The implementation validates evidence at runtime. */
export function reconcileDelivery(deliveryItem: unknown, evidenceSet: unknown, options?: { now?: number }): unknown;

export interface FounderReport {
  locale: "zh-HK";
  userVisibleOutcome: string;
  howToUse: string;
  currentAvailability: "available" | "partial" | "unavailable" | "unknown" | "stale" | "not_run";
  publicTargets: {
    label: string;
    state: "available" | "unavailable" | "unknown" | "stale" | "not_run";
    text: string;
    missingGates: string[];
  }[];
  targetsOmitted: number;
  missingGateLabels: string[];
  ownerStatus: string;
  nextStep: string;
  ownerDecisionRequired: boolean | null;
  freshness: {
    observedAt: string | null;
    result: "pass" | "fail" | "unknown" | "stale" | "not_run" | "not_applicable";
    coverage: "complete" | "incomplete";
  };
  isAuthorizationGrant: false;
}

export function renderFounderReport(projection: unknown, options?: { now?: number }): FounderReport;
