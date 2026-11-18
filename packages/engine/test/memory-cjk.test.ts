import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { EMBEDDING_DIMENSIONS, type EmbeddingProvider } from "@agenteschat/providers";
import { indexSource, insertContextItem, retrieveForRun, searchVisible } from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

async function remember(content: string, title?: string) {
  const item = await insertContextItem(f.db, {
    orgId: f.org.id,
    kind: "fact",
    scopeType: "agent",
    scopeId: f.agent.id,
    agentId: f.agent.id,
    channelIds: [f.general.id],
    title,
    content,
    evidence: [{ type: "self", ref: f.agent.id, agentId: f.agent.id, at: new Date().toISOString() }],
    createdByKind: "agent",
    createdById: f.agent.id,
  });
  await indexSource(f.context, { orgId: f.org.id, kind: "context_item", sourceId: item.id });
  return item;
}

const retrieve = async (text: string) =>
  (
    await retrieveForRun(f.context, {
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      text,
      personIds: [f.owner.id],
    })
  ).matchedIds;

describe("memory in Chinese, found by words (CJK pairs)", () => {
  test("a request worded differently finds the memory by its character pairs; one shared pair alone does not", async () => {
    f = await setup();
    const fact = await remember(
      "監視器把電郵登記網頁拉取請求叫做第 159 號，用標題「電郵登記」找到第 160 號，審查中，負責人是 Max。",
      "電郵登記那張單在任務板是第 160 號",
    );
    const other = await remember("每月嘅發票喺第一個工作日寄出。");
    // Shares 電郵, 登記, 網頁, 任務 with the memory but no whole run of characters.
    expect(await retrieve("電郵登記網頁嗰個 PR，任務板上面邊一張單先係跟進緊嘅？")).toEqual([fact.id]);
    // Shares only 任務 (in the title): not about it.
    expect(await retrieve("teamkit 交付嗰張任務單而家係咩狀態？")).not.toContain(fact.id);
    expect(await retrieve("每月發票幾時寄出？")).toEqual([other.id]);
    // A request of one two-character word has one pair: that one is enough.
    expect(await retrieve("發票")).toEqual([other.id]);
  });

  test("a document indexed before pairs is still found by its whole run of characters", async () => {
    f = await setup();
    const fact = await remember("電郵登記 用標題找");
    // The title as it was stored before pairs: no lines of CJK pairs after it.
    await f.db
      .update(schema.searchDocuments)
      .set({ title: "fact" })
      .where(eq(schema.searchDocuments.sourceId, fact.id));
    const deps = { db: f.db, search: f.search, gateway: f.gateway };
    const hits = await searchVisible(deps, { orgId: f.org.id, text: "電郵登記", visibleChannelIds: [f.general.id] });
    expect(hits.map((h) => h.sourceId)).toEqual([fact.id]);
    expect(hits[0]?.title).toBe("fact");
  });

  test("the pairs are never shown: a hit's title is the item's own", async () => {
    f = await setup();
    const fact = await remember("負責人是 Max", "電郵登記那張單");
    const [doc] = await f.db.select().from(schema.searchDocuments).where(eq(schema.searchDocuments.sourceId, fact.id));
    expect(doc?.title.split("\n")[0]).toBe("fact: 電郵登記那張單");
    const deps = { db: f.db, search: f.search, gateway: f.gateway };
    const [hit] = await searchVisible(deps, { orgId: f.org.id, text: "登記", visibleChannelIds: [f.general.id] });
    expect(hit?.title).toBe("fact: 電郵登記那張單");
  });
});

/** Vectors at a set cosine distance from the request's: a memory says its distance as `[d=0.30]`. */
function atDistance(): EmbeddingProvider {
  return {
    id: "fake",
    model: "fake-distance",
    async embed(texts) {
      const vectors = texts.map((text) => {
        const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
        const d = Number(/\[d=([\d.]+)\]/.exec(text)?.[1] ?? 0);
        v[0] = 1 - d;
        v[1] = Math.sqrt(1 - (1 - d) ** 2);
        return v;
      });
      return { vectors, tokens: 1, model: "fake-distance" };
    },
  };
}

describe("a run's memory by vectors keeps only near neighbours", () => {
  test("cut at 0.55, and at 0.1 past the nearest; a person's search keeps the wider default", async () => {
    f = await setup({ embeddings: { provider: atDistance(), kinds: ["context_item"] } });
    const near = await remember("alpha [d=0.30]");
    const close = await remember("bravo [d=0.38]");
    const loose = await remember("charlie [d=0.45]");
    const far = await remember("delta [d=0.60]");
    const found = await retrieve("unrelated words");
    expect(found).toEqual([near.id, close.id]);
    expect(found).not.toContain(loose.id);
    const deps = { db: f.db, search: f.search, gateway: f.gateway };
    const all = await searchVisible(deps, {
      orgId: f.org.id,
      text: "unrelated words",
      visibleChannelIds: [f.general.id],
    });
    expect(all.map((h) => h.sourceId)).toEqual([near.id, close.id, loose.id, far.id]);
  });

  test("when nothing is near, nothing comes in by vector", async () => {
    f = await setup({ embeddings: { provider: atDistance(), kinds: ["context_item"] } });
    await remember("echo [d=0.58]");
    await remember("foxtrot [d=0.70]");
    expect(await retrieve("unrelated words")).toEqual([]);
  });
});
