/** Only affirmative, specific usage exhaustion is evidence for the plan-wait machinery. */
export function explicitPlanLimit(text: string): boolean {
  if (/\b(?:not|never|no|before|without|haven't|hasn't|isn't|wasn't)\b[\s\S]{0,80}\blimit\b/i.test(text)) return false;
  return /\bhit your (?:usage|session|weekly|opus|sonnet) limit\b|\b(?:reached|exceeded) (?:your |the )?(?:[\w-]+ )?usage limit\b|\busage limit (?:is |was |has been )?(?:reached|exceeded|exhausted)\b/i.test(
    text,
  );
}

/** These errors may be throttles, account caps, credit exhaustion or something else: don't infer a plan reset. */
export function ambiguousLimit(text: string): boolean {
  return /\b429\b|rate.?limit|throttl|too many requests|resource.?exhausted|quota|\blimit\b|out of credits|extra usage|upgrade your plan/i.test(
    text,
  );
}
