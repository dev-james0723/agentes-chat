import type { Evidence } from "./items";

/**
 * Whether an item holds beyond the task at hand. A request made for one task (its steps, limits, deadline, acceptance
 * criteria, a stop or a go-ahead) is not how someone wants things done in general: such a preference or lesson is
 * dropped (`one_off`), however sure the model is.
 */
export const LASTING_RULE =
  "lasting: true only for what holds beyond this one task (a standing practice, a stable fact); false for a one-off request or what applies to this task only: its steps, limits, deadline, acceptance criteria, a stop, a go-ahead or a status. A one-off request is never a preference or a lesson.";

/** Kinds that tell agents how to act: a learning job never makes one standing from a one-off request (`one_off`). */
export const STANDING_KINDS: ReadonlySet<string> = new Set(["preference", "lesson"]);

/** Who did something, as an issue's outcome records it (`by`, `checkedBy`). */
const isPerson = (who: unknown) => (who as { type?: unknown } | null)?.type === "person";

/**
 * An outcome a person stands behind: a person's decision on an approval, a merge or a revert (gated, or seen by the
 * forge or CI through a webhook), work a person took back, or a task whose every criterion a person checked. How a run
 * ended (`run`: a provider outage fails a run too) and what an agent ticked or reported through its own tools never is.
 */
export function personBehindOutcome(o: { kind: string; source: string; details?: Record<string, unknown> | null }) {
  const details = o.details ?? {};
  switch (o.source) {
    case "approval":
    case "webhook":
      return true;
    case "tool":
      return o.kind === "pr_merged" || o.kind === "pr_reverted";
    case "issue": {
      const checked = details.checkedBy;
      if (o.kind === "criteria_met") return Array.isArray(checked) && checked.length > 0 && checked.every(isPerson);
      return isPerson(details.by);
    }
    default:
      return false;
  }
}

/**
 * Whether what a learning job derived may start at high trust: a person's own words (or their reaction) among its
 * sources, or, for anything but a preference, an outcome a person stands behind (`personBehindOutcome`; `outcomes`
 * holds the refs of those). A preference is how a person wants things done: only they can say it. Anything else a job
 * derives (an agent's word, its own tool calls, its own ticks, how a run ended) starts low and unverified, and stays
 * with its channel or agent: it is never shared team-wide or promoted on its own (ADR 0120).
 */
export const jobBacked = (kind: string, evidence: Evidence[], outcomes: ReadonlySet<string> = new Set()) =>
  evidence.some((e) => e.type === "human" || (kind !== "preference" && e.type === "outcome" && outcomes.has(e.ref)));
