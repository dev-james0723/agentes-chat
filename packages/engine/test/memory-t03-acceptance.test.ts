import { afterEach, describe, expect, test } from "bun:test";
import { addChannelMember, createChannel, indexSource, insertContextItem, retrieveForRun } from "../src";
import { ADDITIVE_MEMORY_BUDGET, estimateMemoryTokens } from "../src/context/context-pack";
import { type Fixture, setup } from "./fixtures";

/** Acceptance A20–A22 and A25 of the long-term memory plan (T03), on the native retrieval a run makes. */
let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

async function remember(content: string, channelId = f.general.id, title?: string) {
  const item = await insertContextItem(f.db, {
    orgId: f.org.id,
    kind: "fact",
    scopeType: "agent",
    scopeId: f.agent.id,
    agentId: f.agent.id,
    channelIds: [channelId],
    title,
    content,
    trust: "high",
    evidence: [{ type: "human", ref: f.owner.id, at: new Date().toISOString() }],
    createdByKind: "person",
    createdById: f.owner.id,
  });
  await indexSource(f.context, { orgId: f.org.id, kind: "context_item", sourceId: item.id });
  return item;
}

const run = (text: string, channelId = f.general.id) =>
  retrieveForRun(f.context, { orgId: f.org.id, agentId: f.agent.id, channelId, text, personIds: [f.owner.id] });

describe("A20: exact identifiers in Cantonese, Chinese and English requests", () => {
  test("a task number, a file path and a code symbol each find their memory", async () => {
    f = await setup();
    const task = await remember("JAM-154 is the live acceptance guard; Mason owns it until the release review.");
    const path = await remember("packages/engine/src/context/items.ts holds supersede and the event receipts.");
    const symbol = await remember("memoryViewAt() leaves out superseded rows whose supersession time is unknown.");
    const unrelated = await remember("The monthly invoices go out on the first working day.");

    const byTask = await run("JAM-154 而家邊個負責？");
    expect(byTask.matchedIds).toContain(task.id);
    expect(byTask.matchedIds).not.toContain(unrelated.id);

    const byPath = await run("packages/engine/src/context/items.ts 入面有啲咩？");
    expect(byPath.matchedIds).toContain(path.id);

    const bySymbol = await run("memoryViewAt 點樣處理被取代嘅記錄？");
    expect(bySymbol.matchedIds).toContain(symbol.id);
  });
});

describe("A21: no eligible evidence means nothing is invented", () => {
  test("an unanswerable request brings in no memory", async () => {
    f = await setup();
    await remember("Orion ships from the Frankfurt region.");
    const none = await run("What colour is the CEO's car?");
    expect(none.matchedIds).toEqual([]);
    // Unmatched memory may only be named as a pointer to open, never given as the answer.
    const answers = none.text.split("\n").filter((line) => line.includes("Frankfurt"));
    expect(answers.every((line) => line.startsWith("- Also in your memory, open with expand:"))).toBe(true);
  });
});

describe("A22: the same name in two projects stays with its project", () => {
  test("a run in one project's channel does not receive the other project's claim about the same name", async () => {
    f = await setup();
    const rafii = await createChannel(f.db, f.owner.id, f.org.id, { name: "rafii", visibility: "private" });
    const festival = await createChannel(f.db, f.owner.id, f.org.id, { name: "d-festival", visibility: "private" });
    for (const c of [rafii, festival])
      await addChannelMember(f.db, f.owner.id, f.org.id, c.id, { agentId: f.agent.id });
    const inRafii = await remember("deploy.sh in Rafii pushes to the Vercel preview first.", rafii.id);
    const inFestival = await remember("deploy.sh in D Festival copies the build to the Hostinger folder.", festival.id);

    const fromRafii = await run("What does deploy.sh do?", rafii.id);
    expect(fromRafii.matchedIds).toContain(inRafii.id);
    expect(fromRafii.matchedIds).not.toContain(inFestival.id);
    expect(fromRafii.text).not.toContain("Hostinger");

    const fromFestival = await run("What does deploy.sh do?", festival.id);
    expect(fromFestival.matchedIds).toContain(inFestival.id);
    expect(fromFestival.matchedIds).not.toContain(inRafii.id);
  });
});

describe("A25: the additive memory pack stays within its budget, as a labelled estimate", () => {
  test("many matching items never push the pack past 3000 estimated tokens", async () => {
    f = await setup();
    for (let i = 0; i < 40; i++)
      await remember(
        `Orion release note ${i}: ${"the Frankfurt rollout keeps its canary at five percent. ".repeat(8)}`,
      );
    const pack = await run("Orion release notes for the Frankfurt rollout");
    expect(pack.pack).toBeDefined();
    expect(pack.pack?.countKind).toBe("estimated");
    expect(pack.pack?.limit).toBeLessThanOrEqual(ADDITIVE_MEMORY_BUDGET);
    expect(pack.pack?.tokenCount ?? 0).toBeLessThanOrEqual(ADDITIVE_MEMORY_BUDGET);
    expect(estimateMemoryTokens(pack.text)).toBeLessThanOrEqual(ADDITIVE_MEMORY_BUDGET);
  });
});
