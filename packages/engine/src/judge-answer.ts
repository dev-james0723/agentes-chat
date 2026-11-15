import type { JudgeAnswer, JudgeQuestion } from "./judge";

/** A provider contract failure is unknown evidence, not permission to spend on another model. */
export class InvalidJudgeAnswerError extends Error {}

/** Unknown is not false. Check the provider boundary before any caller applies its policy. */
export function validateJudgeAnswers(
  questions: Record<string, JudgeQuestion>,
  value: unknown,
): Record<string, JudgeAnswer> {
  const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
  const unit = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
  const answers = object(value) ? value : {};
  for (const [id, q] of Object.entries(questions)) {
    const a = Object.hasOwn(answers, id) && object(answers[id]) ? answers[id] : null;
    const invalid = () => {
      throw new InvalidJudgeAnswerError(`judge: invalid answer (${q.type}: ${id})`);
    };
    if (!a || (a.type !== undefined && a.type !== q.type)) invalid();
    if (!a) continue;
    if (a.confidence !== undefined && !unit(a.confidence)) invalid();
    if (q.type === "noul" && !unit(a.noul)) invalid();
    if (q.type === "choice" && (typeof a.choice !== "string" || !Object.hasOwn(q.criteria, a.choice))) invalid();
    if (
      q.type === "score" &&
      (typeof a.score !== "number" || !Number.isFinite(a.score) || a.score < 0 || a.score > q.criteria.length - 1)
    )
      invalid();
    if (q.type === "box") {
      const b = a.box;
      if (
        !object(b) ||
        !unit(b.top) ||
        !unit(b.bottom) ||
        !unit(b.left) ||
        !unit(b.right) ||
        b.top > b.bottom ||
        b.left > b.right
      )
        invalid();
    }
    if (a.probabilities !== undefined) {
      if (!object(a.probabilities)) invalid();
      const allowed =
        q.type === "choice" ? Object.keys(q.criteria) : q.type === "score" ? q.criteria.map((_, i) => String(i)) : [];
      for (const [key, probability] of Object.entries(a.probabilities as Record<string, unknown>)) {
        if (!allowed.includes(key) || !unit(probability)) invalid();
      }
    }
  }
  return Object.fromEntries(Object.keys(questions).map((id) => [id, answers[id]])) as Record<string, JudgeAnswer>;
}
