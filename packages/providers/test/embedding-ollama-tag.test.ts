import { expect, test } from "bun:test";
import { createOpenAIEmbeddings, EMBEDDING_CATALOG, embeddingCostNanoUsd } from "../src";

test("Ollama's tag for Qwen3-Embedding-0.6B gets Qwen's query prompt, documents none; it costs nothing", async () => {
  const sent: { input: string[] }[] = [];
  const fetcher = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { input: string[] };
    sent.push(body);
    return Response.json({ data: body.input.map((_, index) => ({ index, embedding: [1] })) });
  }) as unknown as typeof fetch;
  const ollama = createOpenAIEmbeddings({
    url: "http://localhost:11434/v1",
    model: "qwen3-embedding:0.6b",
    fetch: fetcher,
  });
  await ollama.embed(["電郵登記"], { apiKey: "", inputType: "query" });
  await ollama.embed(["電郵登記"], { apiKey: "", inputType: "document" });
  expect(sent[0]?.input[0]).toBe(`${EMBEDDING_CATALOG["Qwen/Qwen3-Embedding-0.6B"]?.queryPrefix}電郵登記`);
  expect(sent[1]?.input).toEqual(["電郵登記"]);
  expect(EMBEDDING_CATALOG["qwen3-embedding:0.6b"]?.dimensions).toBe(1024);
  expect(embeddingCostNanoUsd("qwen3-embedding:0.6b", 1_000_000)).toBe(0);
});
