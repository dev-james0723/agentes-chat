/**
 * Chinese, Japanese and Korean have no spaces between words, and Postgres's `simple` parser keeps a whole run of them
 * as one word: "電郵登記網頁" is found only by exactly "電郵登記網頁". Like Lucene's `cjk_bigram` filter, a run becomes
 * its overlapping pairs ("電郵 郵登 登記 記網 網頁") and a lone character stays itself, on the documents' side and the
 * query's, so a request worded differently still shares most of a memory's pairs. No Postgres extension needed.
 */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
export const WORD = /[\p{L}\p{N}]+/gu;

/** Whether a word holds a Chinese, Japanese or Korean character. */
export const isCjk = (word: string) => CJK.test(word);

/** A CJK run's pairs, or the character itself when it stands alone. */
export function cjkGrams(run: string): string[] {
  const chars = [...run];
  if (chars.length < 2) return chars;
  return chars.slice(1).map((c, i) => `${chars[i]}${c}`);
}

/** A word's parts in script order: CJK runs as their pairs, the Latin or digits glued to them on their own. */
export function splitWord(word: string): { cjk: boolean; parts: string[] }[] {
  const out: { cjk: boolean; parts: string[] }[] = [];
  let last = 0;
  for (const m of word.matchAll(CJK_RUN)) {
    if (m.index > last) out.push({ cjk: false, parts: [word.slice(last, m.index).toLowerCase()] });
    out.push({ cjk: true, parts: cjkGrams(m[0]) });
    last = m.index + m[0].length;
  }
  if (last < word.length) out.push({ cjk: false, parts: [word.slice(last).toLowerCase()] });
  return out;
}

/**
 * What a text adds to its index for CJK (empty when it has none): every word holding CJK split by script, its runs as
 * pairs. Plain Latin words add nothing, the parser has them already.
 */
export function cjkIndexTerms(text: string): string {
  const terms: string[] = [];
  for (const [word] of text.matchAll(WORD)) {
    if (CJK.test(word)) for (const piece of splitWord(word)) terms.push(...piece.parts);
  }
  return terms.join(" ");
}

/** Text for `websearch_to_tsquery`: each word holding CJK replaced by its parts, everything else as written. */
export function cjkQueryText(text: string): string {
  return text.replace(WORD, (word) =>
    CJK.test(word)
      ? splitWord(word)
          .flatMap((p) => p.parts)
          .join(" ")
      : word,
  );
}
