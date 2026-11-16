import { UUID } from "./authority";
import { NotFoundError } from "./errors";

/**
 * An issue's number (`131`, `#131`) or id, as `getIssue` takes it. Anything else names no task, and is refused here:
 * the id column is a UUID, so other text there fails the query (its SQL shown to the agent, the outcome unknown to
 * the run) instead of finding nothing. A number past its column's range finds nothing in the lookup itself
 * (`findVisible`). A key in another tracker's style ("ABC-131") is not read as #131: that number could be any tracker's.
 */
export const issueKey = (ref: string) => {
  // Characters that can't be seen (control and format ones: a zero-width space, a byte order mark) name nothing at
  // either end, like spaces: a pasted number often brings one.
  const text = ref.replace(/^[\s\p{Cc}\p{Cf}]+|[\s\p{Cc}\p{Cf}]+$/gu, "");
  const n = /^#?(\d+)$/.exec(text);
  if (n) return { number: Number(n[1]) };
  if (UUID.test(text)) return { id: text };
  // Said back as it can be read, saying so when part of it can't, and with no example that is itself a number.
  const shown = text.replace(/[\p{Cc}\p{Cf}]/gu, "");
  const unseen = shown.length === text.length ? "" : " (shown without the characters in it that can't be seen)";
  throw new NotFoundError(
    `Issue not found: "${shown.slice(0, 64)}"${unseen} is not a task number or id. Give its number as list_issues shows it, or its id; list_issues finds a task by words (query).`,
  );
};
