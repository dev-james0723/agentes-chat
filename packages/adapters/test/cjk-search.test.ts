import { describe, expect, test } from "bun:test";
import { cjkIndexTerms, cjkQueryText } from "../src/cjk";
import { contentWords } from "../src/stopwords";

describe("CJK bigrams (Lucene cjk_bigram style)", () => {
  test("a run of Han characters becomes its overlapping pairs; a lone character stays itself", () => {
    expect(cjkIndexTerms("電郵登記")).toBe("電郵 郵登 登記");
    expect(cjkIndexTerms("係 PR")).toBe("係");
  });

  test("Latin words glued to CJK are split off; plain Latin text adds nothing", () => {
    expect(cjkIndexTerms("teamkit交付")).toBe("teamkit 交付");
    expect(cjkIndexTerms("the deploy pipeline broke")).toBe("");
  });

  test("kana and hangul are paired too; punctuation splits runs", () => {
    expect(cjkIndexTerms("テスト，한국어")).toBe("テス スト 한국 국어");
  });

  test("a query for every word keeps Latin words and pairs the CJK ones", () => {
    expect(contentWords("電郵登記網頁嗰個 PR teamkit交付")).toEqual(
      expect.arrayContaining(["電郵", "登記", "網頁", "teamkit", "交付"]),
    );
    // Latin stays as before: 3+ letters, without stopwords.
    expect(contentWords("the deploy pipeline")).toEqual(["deploy", "pipeline"]);
  });

  test("a long Chinese message's pairs don't crowd out its other words and numbers under the cap", () => {
    const long = `${"電郵登記網頁任務板跟進審查負責人拉取請求監視器標題提交合併檢查狀態".repeat(2)} teamkit #160`;
    const words = contentWords(long);
    expect(words).toHaveLength(30);
    expect(words.slice(0, 2)).toEqual(["teamkit", "160"]);
  });

  test("websearch text: a CJK run is replaced by its pairs, the rest left as written", () => {
    expect(cjkQueryText('"電郵登記" -spam')).toBe('"電郵 郵登 登記" -spam');
    expect(cjkQueryText("deploy staging")).toBe("deploy staging");
  });
});
