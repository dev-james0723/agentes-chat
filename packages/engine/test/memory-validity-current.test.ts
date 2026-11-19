import { afterEach, expect, test } from "bun:test";
import { indexSource, insertContextItem, type NewContextItem, retrieveForRun } from "../src";
import { type Fixture, setup } from "./fixtures";

/** A14: a claim whose validity has ended, or not begun, is never given to a run as current. */
let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

async function remember(content: string, patch: Partial<NewContextItem> = {}) {
  const item = await insertContextItem(f.db, {
    orgId: f.org.id,
    kind: "fact",
    scopeType: "agent",
    scopeId: f.agent.id,
    agentId: f.agent.id,
    channelIds: [f.general.id],
    content,
    trust: "high",
    evidence: [{ type: "human", ref: f.owner.id, at: new Date().toISOString() }],
    createdByKind: "person",
    createdById: f.owner.id,
    ...patch,
  });
  await indexSource(f.context, { orgId: f.org.id, kind: "context_item", sourceId: item.id });
  return item;
}

test("an expired or not-yet-valid fact stays out of a run; a current one comes in", async () => {
  f = await setup();
  const day = 86_400_000;
  const expired = await remember("The Orion on-call phone is 5550-1111.", {
    subject: "orion on-call old",
    validTo: new Date(Date.now() - day),
  });
  const future = await remember("The Orion on-call phone will be 5550-3333.", {
    subject: "orion on-call next",
    validFrom: new Date(Date.now() + day),
  });
  const current = await remember("The Orion on-call phone is 5550-2222.", {
    subject: "orion on-call",
    validFrom: new Date(Date.now() - day),
  });
  const run = await retrieveForRun(f.context, {
    orgId: f.org.id,
    agentId: f.agent.id,
    channelId: f.general.id,
    text: "What is the Orion on-call phone?",
    personIds: [f.owner.id],
  });
  expect(run.itemIds).toContain(current.id);
  expect(run.itemIds).not.toContain(expired.id);
  expect(run.itemIds).not.toContain(future.id);
  expect(run.text).not.toContain("5550-1111");
  expect(run.text).not.toContain("5550-3333");
});
