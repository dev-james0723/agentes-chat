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

/**
 * Whether what a learning job derived may start at high trust: a person's own words (or their reaction) among its
 * sources, or, for anything but a preference, a recorded outcome. A preference is how a person wants things done: only
 * they can say it. Anything else a job derives (an agent's word, its own tool calls, its own reading) starts low and
 * unverified, and stays with its channel or agent: it is never shared team-wide or promoted on its own (ADR 0120).
 */
export const jobBacked = (kind: string, evidence: Evidence[]) =>
  evidence.some((e) => e.type === "human" || (kind !== "preference" && e.type === "outcome"));
